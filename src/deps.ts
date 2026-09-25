import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Declared-versus-locked dependency check for the `deps-locked` gate. Offline and
 * deterministic: a dependency that never resolved from a registry (a hallucinated
 * or never-installed package) cannot appear in the lockfile, so every declared
 * name must be found there.
 */

export const NODE_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"];
export const PYTHON_LOCKFILES = ["uv.lock", "poetry.lock", "pdm.lock"];
export const SUPPORTED_MANIFESTS = ["package.json", "pyproject.toml"];

export interface DepsReport {
  manifest: string;
  lockfile?: string;
  declared: string[];
  missing: string[];
  error?: string;
}

const NODE_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** PEP 503 normalized project name. */
export function normalizePythonName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function nodeDeclared(manifest: string): string[] {
  const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
  const names = new Set<string>();
  // Peer dependencies are the consumer's to install, so they are not checked.
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const deps = pkg?.[section];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, spec] of Object.entries(deps)) {
      // Local links resolve to a path, not a registry package.
      if (typeof spec === "string" && /^(file|link|portal):/.test(spec)) continue;
      names.add(name);
    }
  }
  return [...names].sort();
}

function nodeLocked(lockfile: string, text: string): (name: string) => boolean {
  const base = path.basename(lockfile);
  if (base === "package-lock.json" || base === "npm-shrinkwrap.json") {
    const lock = JSON.parse(text);
    const packages = lock?.packages ?? {};
    const v1 = lock?.dependencies ?? {};
    return (name) => packages[`node_modules/${name}`] != null || v1[name] != null;
  }
  if (base === "pnpm-lock.yaml") {
    const lock: any = parseYaml(text) ?? {};
    const importerNames = new Set<string>();
    for (const importer of Object.values<any>(lock.importers ?? { ".": lock })) {
      for (const section of NODE_SECTIONS) {
        for (const name of Object.keys(importer?.[section] ?? {})) importerNames.add(name);
      }
    }
    return (name) => importerNames.has(name);
  }
  // yarn.lock (classic and berry) and bun.lock: entries are keyed `name@range`.
  return (name) => new RegExp(`(^|[\\s"',/])${escapeRegExp(name)}@`, "m").test(text);
}

/** Top-level `[section]` body of a TOML document (until the next table header). */
function tomlSection(text: string, header: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${header}]`);
  if (start < 0) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

/** Strings inside the `key = [ ... ]` array of a TOML section body. */
function tomlArray(body: string, key: string): string[] {
  const match = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m").exec(body);
  if (!match) return [];
  return [...match[1].matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
}

function requirementName(requirement: string): string | null {
  const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(requirement);
  return match ? normalizePythonName(match[1]) : null;
}

function pythonDeclared(manifest: string): string[] {
  const text = fs.readFileSync(manifest, "utf8");
  const names = new Set<string>();
  const project = tomlSection(text, "project");
  if (project) {
    for (const req of tomlArray(project, "dependencies")) {
      const name = requirementName(req);
      if (name) names.add(name);
    }
  }
  const optional = tomlSection(text, "project.optional-dependencies");
  if (optional) {
    for (const [, key] of optional.matchAll(/^\s*([A-Za-z0-9._-]+)\s*=\s*\[/gm)) {
      for (const req of tomlArray(optional, key)) {
        const name = requirementName(req);
        if (name) names.add(name);
      }
    }
  }
  for (const header of ["tool.poetry.dependencies", "tool.poetry.dev-dependencies", "tool.poetry.group.dev.dependencies"]) {
    const body = tomlSection(text, header);
    if (!body) continue;
    for (const [, key] of body.matchAll(/^\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*=/gm)) {
      if (key.toLowerCase() !== "python") names.add(normalizePythonName(key));
    }
  }
  return [...names].sort();
}

function pythonLocked(text: string): (name: string) => boolean {
  const locked = new Set([...text.matchAll(/^name\s*=\s*"([^"]+)"/gm)].map((m) => normalizePythonName(m[1])));
  return (name) => locked.has(name);
}

/** Check one manifest against the first lockfile found next to it. */
export function checkManifest(manifest: string): DepsReport {
  const rel = manifest;
  const dir = path.dirname(manifest);
  const kind = path.basename(manifest);
  const lockfiles = kind === "package.json" ? NODE_LOCKFILES : kind === "pyproject.toml" ? PYTHON_LOCKFILES : null;
  if (!lockfiles) return { manifest: rel, declared: [], missing: [], error: `unsupported manifest ${kind} (supported: ${SUPPORTED_MANIFESTS.join(", ")})` };
  if (!fs.existsSync(manifest)) return { manifest: rel, declared: [], missing: [], error: `manifest not found` };
  let declared: string[];
  try {
    declared = kind === "package.json" ? nodeDeclared(manifest) : pythonDeclared(manifest);
  } catch (error: any) {
    return { manifest: rel, declared: [], missing: [], error: `cannot parse manifest: ${error.message}` };
  }
  if (declared.length === 0) return { manifest: rel, declared, missing: [] };
  const lockfile = lockfiles.map((name) => path.join(dir, name)).find((file) => fs.existsSync(file));
  if (!lockfile) return { manifest: rel, declared, missing: declared, error: `no lockfile (looked for ${lockfiles.join(", ")})` };
  let has: (name: string) => boolean;
  try {
    const text = fs.readFileSync(lockfile, "utf8");
    has = kind === "package.json" ? nodeLocked(lockfile, text) : pythonLocked(text);
  } catch (error: any) {
    return { manifest: rel, lockfile, declared, missing: declared, error: `cannot parse ${path.basename(lockfile)}: ${error.message}` };
  }
  return { manifest: rel, lockfile, declared, missing: declared.filter((name) => !has(name)) };
}

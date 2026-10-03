import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { parse as parseToml } from "smol-toml";

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

const NODE_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];

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

function nodeLocked(lockfile: string, text: string, manifest: string): (name: string) => boolean {
  const base = path.basename(lockfile);
  if (base === "package-lock.json" || base === "npm-shrinkwrap.json") {
    const lock = JSON.parse(text);
    const packages = lock?.packages ?? {};
    const v1 = lock?.dependencies ?? {};
    return (name) => packages[`node_modules/${name}`] != null || v1[name] != null;
  }
  if (base === "pnpm-lock.yaml") {
    const lock = table(parseYaml(text), "pnpm lockfile");
    const identity = path.relative(path.dirname(path.resolve(lockfile)), path.dirname(path.resolve(manifest))).split(path.sep).join("/") || ".";
    const importers = lock.importers === undefined ? undefined : table(lock.importers, "pnpm importers");
    const importer = importers ? importers[identity] : identity === "." ? lock : undefined;
    if (importer == null) throw new Error(`no pnpm importer for ${identity}`);
    const project = table(importer, `pnpm importer ${identity}`);
    const importerNames = new Set<string>();
    for (const section of NODE_SECTIONS) {
      for (const name of Object.keys(table(project[section], `pnpm ${section}`))) importerNames.add(name);
    }
    return (name) => importerNames.has(name);
  }
  // yarn.lock (classic and berry) and bun.lock: entries are keyed `name@range`.
  return (name) => new RegExp(`(^|[\\s"',/])${escapeRegExp(name)}@`, "m").test(text);
}

function table(value: unknown, label: string): Record<string, any> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date) throw new Error(`${label} must be a table`);
  return value as Record<string, any>;
}

function requirementName(requirement: string): string | null {
  const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(requirement);
  return match ? normalizePythonName(match[1]) : null;
}

function pythonDeclared(manifest: string): string[] {
  const doc = parseToml(fs.readFileSync(manifest, "utf8"));
  const names = new Set<string>();
  const add = (value: unknown) => {
    const name = typeof value === "string" ? requirementName(value) : null;
    if (!name) throw new Error("dependency requirement must be a named string");
    names.add(name);
  };
  const addArray = (value: unknown, label: string) => {
    if (value === undefined) return;
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    value.forEach(add);
  };
  const project = table(doc.project, "project");
  addArray(project.dependencies, "project.dependencies");
  for (const [key, requirements] of Object.entries(table(project["optional-dependencies"], "project.optional-dependencies"))) {
    addArray(requirements, `project.optional-dependencies.${key}`);
  }

  const groups = new Map<string, unknown>();
  for (const [key, value] of Object.entries(table(doc["dependency-groups"], "dependency-groups"))) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(key)) throw new Error(`invalid dependency group name: ${key}`);
    const normalized = normalizePythonName(key);
    if (groups.has(normalized)) throw new Error(`duplicate normalized dependency group: ${key}`);
    groups.set(normalized, value);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new Error(`cyclic dependency group include: ${key}`);
    if (visited.has(key)) return;
    if (!groups.has(key)) throw new Error(`unknown included dependency group: ${key}`);
    const requirements = groups.get(key);
    if (!Array.isArray(requirements)) throw new Error(`dependency group ${key} must be an array`);
    visiting.add(key);
    for (const value of requirements) {
      if (typeof value === "string") add(value);
      else {
        const include = table(value, `dependency group ${key} item`);
        if (Object.keys(include).length !== 1 || typeof include["include-group"] !== "string") throw new Error(`invalid dependency group include: ${key}`);
        visit(normalizePythonName(include["include-group"]));
      }
    }
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of groups.keys()) visit(key);

  const poetry = table(table(doc.tool, "tool").poetry, "tool.poetry");
  const addPoetry = (value: unknown, label: string) => {
    for (const key of Object.keys(table(value, label))) if (key.toLowerCase() !== "python") names.add(normalizePythonName(key));
  };
  addPoetry(poetry.dependencies, "tool.poetry.dependencies");
  addPoetry(poetry["dev-dependencies"], "tool.poetry.dev-dependencies");
  for (const [key, group] of Object.entries(table(poetry.group, "tool.poetry.group"))) {
    addPoetry(table(group, `tool.poetry.group.${key}`).dependencies, `tool.poetry.group.${key}.dependencies`);
  }
  return [...names].sort();
}

function pythonLocked(text: string): (name: string) => boolean {
  const doc = parseToml(text);
  const packages = doc.package ?? [];
  if (!Array.isArray(packages)) throw new Error("lockfile package entries must be an array");
  const locked = new Set(packages.map(value => {
    const name = table(value, "lockfile package").name;
    if (typeof name !== "string" || !name) throw new Error("lockfile package entry must have a name");
    return normalizePythonName(name);
  }));
  return (name) => locked.has(name);
}

function workspacePnpmLock(dir: string): string | undefined {
  let current = path.resolve(dir);
  while (true) {
    const lock = path.join(current, "pnpm-lock.yaml");
    if (fs.existsSync(lock)) return lock;
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Resolve the lockfile read for a supported manifest, including shared pnpm workspaces. */
export function findDependencyLockfile(manifest: string): string | undefined {
  const kind = path.basename(manifest);
  const lockfiles = kind === "package.json" ? NODE_LOCKFILES : kind === "pyproject.toml" ? PYTHON_LOCKFILES : [];
  const dir = path.dirname(manifest);
  return lockfiles.map(name => path.join(dir, name)).find(file => fs.existsSync(file))
    ?? (kind === "package.json" ? workspacePnpmLock(dir) : undefined);
}

/** Check one manifest against its adjacent lockfile or shared pnpm workspace lock. */
export function checkManifest(manifest: string): DepsReport {
  const rel = manifest;
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
  const lockfile = findDependencyLockfile(manifest);
  if (!lockfile) return { manifest: rel, declared, missing: declared, error: `no lockfile (looked for ${lockfiles.join(", ")})` };
  let has: (name: string) => boolean;
  try {
    const text = fs.readFileSync(lockfile, "utf8");
    has = kind === "package.json" ? nodeLocked(lockfile, text, manifest) : pythonLocked(text);
  } catch (error: any) {
    return { manifest: rel, lockfile, declared, missing: declared, error: `cannot parse ${path.basename(lockfile)}: ${error.message}` };
  }
  return { manifest: rel, lockfile, declared, missing: declared.filter((name) => !has(name)) };
}

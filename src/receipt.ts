import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { RunResult } from "./core.js";
import type { Spec } from "./spec.js";
import { globSync } from "tinyglobby";
import { currentBranch, matchesGlob } from "./git.js";
import { findDependencyLockfile } from "./deps.js";

const SCAN_IGNORE = ["**/node_modules/**", "**/.git/**", "dist/**"];
const CACHE_TYPES = new Set(["file-exists", "file-contains", "evidence", "not-empty", "absent", "no-new", "no-fewer", "no-deleted", "phase"]);

/** Reuse only checks whose complete inputs can be observed in the local snapshot. */
export function cacheDisabledReason(spec: Spec): string | undefined {
  const unsafe = spec.gates.filter(gate => !CACHE_TYPES.has(gate.type));
  return unsafe.length ? `cache disabled: ${[...new Set(unsafe.map(gate => gate.type))].join(", ")} gates require fresh evaluation` : undefined;
}

/** Explicit and ignored files read by local gates still participate in the snapshot. */
function gateFiles(spec: Spec, cwd: string): string[] {
  const files = new Set<string>();
  const add = (file: string) => files.add(path.relative(cwd, path.resolve(cwd, file)).split(path.sep).join("/"));
  for (const gate of spec.gates) {
    if ("file" in gate) (Array.isArray(gate.file) ? gate.file : [gate.file]).forEach(add);
    if ("glob" in gate) globSync(gate.glob, { cwd, dot: true, ignore: [...SCAN_IGNORE, ...(gate.ignore ?? [])] }).forEach(add);
    if (gate.type === "not-empty") {
      add(gate.path);
      try { fs.readdirSync(path.resolve(cwd, gate.path)).forEach(file => add(path.join(gate.path, file))); } catch { /* existence is hashed below */ }
    }
    if (gate.type === "phase") add(gate.current ?? ".skillgate/phase");
    if (gate.type === "deps-locked") {
      const manifests = gate.manifest == null ? ["package.json", "pyproject.toml"] : Array.isArray(gate.manifest) ? gate.manifest : [gate.manifest];
      for (const file of manifests) {
        add(file);
        for (const lock of ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "uv.lock", "poetry.lock", "pdm.lock"]) add(path.join(path.dirname(file), lock));
        const selected = findDependencyLockfile(path.resolve(cwd, file));
        if (selected) add(selected);
      }
    }
  }
  return [...files];
}

export function receiptPathIsInput(spec: Spec, cwd: string, file: string): boolean {
  const rel = path.relative(cwd, file).split(path.sep).join("/");
  return gateFiles(spec, cwd).includes(rel) || spec.gates.some(gate => "glob" in gate && matchesGlob(rel, gate.glob, [...SCAN_IGNORE, ...(gate.ignore ?? [])]));
}

const EVALUATOR_VERSION = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version as string;

interface StoredReceipt {
  format: 1;
  snapshot: string;
  createdAt: string;
  source: "executed" | "cache";
  result: RunResult;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function filesForSnapshot(cwd: string): string[] {
  const listed = git(cwd, ["ls-files", "-co", "--exclude-standard", "-z"]);
  if (listed != null) return listed.split("\0").filter(Boolean).sort();
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(cwd, full).split(path.sep).join("/"));
    }
  };
  walk(cwd);
  return files.sort();
}

export function snapshotKey(spec: Spec, cwd: string, baseRef?: string, ignore: string[] = []): string {
  const hash = crypto.createHash("sha256");
  const deadline = Date.now() + (spec.timeout ?? 300_000);
  const hashFile = (file: string) => {
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    try {
      while (true) {
        if (Date.now() >= deadline) throw new Error("snapshot exceeded its time budget");
        const length = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (!length) break;
        hash.update(buffer.subarray(0, length));
      }
    } finally { fs.closeSync(fd); }
  };
  hash.update("skillgate-snapshot-v2\0");
  hash.update(EVALUATOR_VERSION);
  hash.update("\0");
  hash.update(JSON.stringify(spec));
  hash.update("\0");
  hash.update(process.platform);
  hash.update("\0");
  hash.update(process.version);
  hash.update("\0");
  if (baseRef) hash.update(git(cwd, ["rev-parse", `${baseRef}^{commit}`]) ?? baseRef);
  hash.update("\0" + (currentBranch(cwd) ?? "<unknown-branch>"));
  hash.update("\0" + (git(cwd, ["rev-parse", "HEAD"]) ?? "<no-head>"));
  const index = git(cwd, ["ls-files", "--stage", "-z"]);
  hash.update("\0" + (index == null ? "<no-index>" : index.split("\0")
    .filter(entry => entry && !ignore.includes(entry.slice(entry.indexOf("\t") + 1))).join("\0")));
  const files = [...new Set([...filesForSnapshot(cwd), ...gateFiles(spec, cwd)])].sort();
  for (const rel of files.filter((file) => !ignore.includes(file))) {
    hash.update("\0" + rel + "\0");
    const full = path.join(cwd, rel);
    try {
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        hash.update(`link:${fs.readlinkSync(full)}`);
        const target = fs.statSync(full);
        if (!target.isFile()) throw new Error(`snapshot cannot bind a symlink to a directory: ${rel}`);
        hashFile(full);
      } else if (stat.isDirectory()) {
        hash.update("dir:" + JSON.stringify(fs.readdirSync(full).sort()));
      } else if (stat.isFile()) hashFile(full);
      else throw new Error(`snapshot cannot bind a non-regular path: ${rel}`);
      hash.update(stat.mode.toString(8));
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      hash.update("<missing>");
    }
  }
  return hash.digest("hex");
}

function cacheFile(cwd: string): string {
  const gitPath = git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "skillgate-cache/check.json"]);
  if (gitPath?.trim()) return gitPath.trim();
  const id = crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), "skillgate-cache", id, "check.json");
}

function parseReceipt(file: string, spec?: Spec): StoredReceipt | null {
  try {
    if (fs.statSync(file).size > 10 * 1024 * 1024) return null;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    const result = value?.result;
    if (value?.format !== 1 || !/^[a-f0-9]{64}$/.test(value.snapshot) || value.source !== "executed"
      || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
      || result?.passed !== true || !Array.isArray(result.results) || !result.results.length
      || !Array.isArray(result.failed) || result.failed.length) return null;
    const ids = new Set<string>();
    for (const gate of result.results) {
      if (!gate || typeof gate.id !== "string" || ids.has(gate.id) || typeof gate.type !== "string"
        || gate.ok !== true || typeof gate.reason !== "string" || ![undefined, "pass", "skipped"].includes(gate.status)) return null;
      ids.add(gate.id);
    }
    if (spec && (result.results.length !== spec.gates.length || spec.gates.some((gate, i) =>
      result.results[i].id !== gate.id || result.results[i].type !== gate.type))) return null;
    return value as StoredReceipt;
  } catch {
    return null;
  }
}

export function readCachedResult(cwd: string, snapshot: string, spec?: Spec): RunResult | null {
  const receipt = parseReceipt(cacheFile(cwd), spec);
  return receipt?.snapshot === snapshot && receipt.result.passed ? receipt.result : null;
}

function atomicWrite(file: string, value: StoredReceipt): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (error: any) {
    // Windows does not replace an existing destination with rename(2).
    if (!fs.existsSync(file) || !["EEXIST", "EPERM"].includes(error?.code)) throw error;
    fs.rmSync(file);
    fs.renameSync(tmp, file);
  }
}

export function writeCachedResult(cwd: string, snapshot: string, result: RunResult): void {
  if (!result.passed) return;
  atomicWrite(cacheFile(cwd), { format: 1, snapshot, createdAt: new Date().toISOString(), source: "executed", result });
}

export function writeReceipt(file: string, snapshot: string, result: RunResult, source: "executed" | "cache"): void {
  atomicWrite(path.resolve(file), { format: 1, snapshot, createdAt: new Date().toISOString(), source, result });
}

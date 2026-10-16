import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { RunResult } from "./core.js";
import { DEFAULT_PHASE_FILE, type Spec } from "./spec.js";
import { currentBranch, inScan, scanFiles } from "./git.js";
import { findDependencyLockfile, NODE_LOCKFILES, PYTHON_LOCKFILES, SUPPORTED_MANIFESTS } from "./deps.js";

const CACHE_TYPES = new Set(["file-exists", "file-contains", "evidence", "not-empty", "absent", "no-new", "no-fewer", "no-deleted", "unchanged", "phase"]);

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
    if ("glob" in gate) scanFiles(cwd, gate.glob, gate.ignore).forEach(add);
    if (gate.type === "not-empty") {
      add(gate.path);
      try { fs.readdirSync(path.resolve(cwd, gate.path)).forEach(file => add(path.join(gate.path, file))); } catch { /* existence is hashed below */ }
    }
    if (gate.type === "phase") add(gate.current ?? DEFAULT_PHASE_FILE);
    if (gate.type === "deps-locked") {
      const manifests = gate.manifest == null ? SUPPORTED_MANIFESTS : Array.isArray(gate.manifest) ? gate.manifest : [gate.manifest];
      for (const file of manifests) {
        add(file);
        for (const lock of [...NODE_LOCKFILES, ...PYTHON_LOCKFILES]) add(path.join(path.dirname(file), lock));
        const selected = findDependencyLockfile(path.resolve(cwd, file));
        if (selected) add(selected);
      }
    }
  }
  return [...files];
}

export function receiptPathIsInput(spec: Spec, cwd: string, file: string): boolean {
  const rel = path.relative(cwd, file).split(path.sep).join("/");
  return gateFiles(spec, cwd).includes(rel) || spec.gates.some(gate => "glob" in gate && inScan(rel, gate.glob, gate.ignore));
}

/** The installed skillgate package version: binds cache snapshots, `--version` and installed hooks. */
export const EVALUATOR_VERSION = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version as string;

interface StoredReceipt {
  format: 1;
  snapshot: string;
  createdAt: string;
  source: "executed" | "cache";
  result: RunResult;
  /** Run inputs that change the snapshot: the `--timeout` and `--command` given to check. */
  inputs?: ReceiptInputs;
}

export interface ReceiptInputs {
  timeoutMs?: number;
  command?: string;
}

/**
 * The snapshot a `check` run is bound to: the policy with the run inputs that change
 * it (the judged command decides which gates apply), the files, and the base, minus
 * the receipt file itself.
 */
export function runSnapshot(spec: Spec, cwd: string, baseRef: string | undefined, inputs: ReceiptInputs, receiptFile?: string): string {
  const rel = receiptFile ? path.relative(cwd, receiptFile).split(path.sep).join("/") : "";
  const ignore = rel && !rel.startsWith("../") ? [rel] : [];
  const bound = { ...spec, timeout: inputs.timeoutMs ?? spec.timeout, ...(inputs.command != null ? { forCommand: inputs.command } : {}) } as Spec;
  return snapshotKey(bound, cwd, baseRef, ignore);
}

export interface ReceiptVerdict {
  valid: boolean;
  reason: string;
  /** Snapshot of the files in front of the verifier. */
  snapshot: string;
  /** Snapshot the receipt was written for. */
  recorded: string;
  createdAt?: string;
  source?: string;
}

/**
 * Check that a receipt written by `check --receipt` belongs to this exact policy,
 * base and set of files, and records a passing run. Inputs the receipt does not
 * record (receipts from before 0.15.0) come from `fallback`.
 */
export function verifyReceipt(file: string, spec: Spec, cwd: string, baseRef: string | undefined, fallback: ReceiptInputs = {}): ReceiptVerdict {
  const value = readStored(file);
  if (value === undefined) throw new Error(`cannot read receipt ${file}`);
  if (!isReceiptFormat(value) || typeof value.result?.passed !== "boolean" || !Array.isArray(value.result?.failed)) {
    throw new Error(`${file} is not a skillgate receipt (format 1)`);
  }
  const recordedTimeout = Number.isInteger(value.inputs?.timeoutMs) && value.inputs.timeoutMs > 0 ? value.inputs.timeoutMs : undefined;
  const recordedCommand = typeof value.inputs?.command === "string" ? value.inputs.command : undefined;
  const inputs = { timeoutMs: recordedTimeout ?? fallback.timeoutMs, command: recordedCommand ?? fallback.command };
  const snapshot = runSnapshot(spec, cwd, baseRef, inputs, path.resolve(file));
  const verdict = { snapshot, recorded: value.snapshot, createdAt: typeof value.createdAt === "string" ? value.createdAt : undefined, source: value.source };
  if (snapshot !== value.snapshot) return { ...verdict, valid: false, reason: "the files, policy or base changed since the receipt was written" };
  if (!value.result.passed) return { ...verdict, valid: false, reason: `the receipt records a failing run (${value.result.failed.length} gate(s) unmet)` };
  return { ...verdict, valid: true, reason: `the receipt matches these files and this policy, and records a passing run${verdict.createdAt ? ` (${verdict.createdAt})` : ""}` };
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

/** A stored receipt's parsed JSON (10 MiB cap), or undefined when it cannot be read. */
function readStored(file: string): any {
  try {
    if (fs.statSync(file).size > 10 * 1024 * 1024) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Format 1 with a snapshot hash: the shape every receipt and cache entry shares. */
function isReceiptFormat(value: any): boolean {
  return value?.format === 1 && /^[a-f0-9]{64}$/.test(value.snapshot);
}

function parseReceipt(file: string, spec?: Spec): StoredReceipt | null {
  try {
    const value = readStored(file);
    const result = value?.result;
    if (!isReceiptFormat(value) || value.source !== "executed"
      || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
      || result?.passed !== true || !Array.isArray(result.results) || !result.results.length
      || !Array.isArray(result.failed) || result.failed.length) return null;
    const ids = new Set<string>();
    for (const gate of result.results) {
      if (!gate || typeof gate.id !== "string" || ids.has(gate.id) || typeof gate.type !== "string"
        || gate.ok !== true || typeof gate.reason !== "string" || ![undefined, "pass", "skipped", "warn"].includes(gate.status)) return null;
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

export function writeReceipt(file: string, snapshot: string, result: RunResult, source: "executed" | "cache", inputs: ReceiptInputs = {}): void {
  const recorded = Object.fromEntries(Object.entries(inputs).filter(([, value]) => value != null));
  atomicWrite(path.resolve(file), { format: 1, snapshot, createdAt: new Date().toISOString(), source, result, ...(Object.keys(recorded).length ? { inputs: recorded } : {}) });
}

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { RunResult } from "./core.js";
import type { Spec } from "./spec.js";

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
  hash.update("skillgate-snapshot-v1\0");
  hash.update(EVALUATOR_VERSION);
  hash.update("\0");
  hash.update(JSON.stringify(spec));
  hash.update("\0");
  hash.update(process.platform);
  hash.update("\0");
  hash.update(process.version);
  hash.update("\0");
  if (baseRef) hash.update(git(cwd, ["rev-parse", `${baseRef}^{commit}`]) ?? baseRef);
  for (const rel of filesForSnapshot(cwd).filter((file) => !ignore.includes(file))) {
    hash.update("\0" + rel + "\0");
    const full = path.join(cwd, rel);
    try {
      const stat = fs.lstatSync(full);
      hash.update(stat.isSymbolicLink() ? `link:${fs.readlinkSync(full)}` : fs.readFileSync(full));
      hash.update(stat.mode.toString(8));
    } catch {
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

function parseReceipt(file: string): StoredReceipt | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value?.format !== 1 || typeof value.snapshot !== "string" || typeof value.result?.passed !== "boolean") return null;
    return value as StoredReceipt;
  } catch {
    return null;
  }
}

export function readCachedResult(cwd: string, snapshot: string): RunResult | null {
  const receipt = parseReceipt(cacheFile(cwd));
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

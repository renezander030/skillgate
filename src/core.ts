import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { globSync } from "tinyglobby";
import { type Spec, type Gate, type TrivyGate, DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_NOT_EMPTY_MIN } from "./spec.js";
import { checkDrift, DEFAULT_THRESHOLD } from "./drift.js";
import { readFileAtRef, listFilesAtRef, matchesGlob } from "./git.js";

export interface GateResult {
  id: string;
  type: string;
  ok: boolean;
  reason: string;
}

export interface RunResult {
  passed: boolean;
  results: GateResult[];
  failed: GateResult[];
}

/** Evaluation context. `baseRef` is the git ref diff-aware gates compare against. */
export interface RunOptions {
  baseRef?: string;
}

const IGNORE = ["**/node_modules/**", "**/.git/**", "dist/**"];
const DEFAULT_TRIVY_SCANNERS: NonNullable<TrivyGate["scanners"]> = ["vuln", "secret"];
const DEFAULT_TRIVY_SEVERITY: NonNullable<TrivyGate["severity"]> = ["CRITICAL"];

/** Count lines of `text` that match `re`; calls `onFirst` with the 0-based index of the first hit. */
function countMatchingLines(text: string, re: RegExp, onFirst?: (i: number) => void): number {
  const lines = text.split("\n");
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      if (n === 0 && onFirst) onFirst(i);
      n++;
    }
  }
  return n;
}

function formatTrivyCommand(bin: string, args: string[]): string {
  return [bin, ...args].join(" ");
}

function runTrivyCommand(bin: string, args: string[], cwd: string, timeout: number): { ok: true; stdout: string } | { ok: false; reason: string } {
  const result = spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });
  const command = formatTrivyCommand(bin, args);
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, reason: `${bin} not found — install Trivy or set the gate's trivy path` };
    if (code === "ETIMEDOUT") return { ok: false, reason: `command timed out after ${timeout}ms: ${command}` };
    return { ok: false, reason: `${command} failed: ${result.error.message}` };
  }
  if (result.signal === "SIGTERM") return { ok: false, reason: `command timed out after ${timeout}ms: ${command}` };
  if ((result.status ?? 1) !== 0) {
    const tail = String(result.stderr || result.stdout || "")
      .trim()
      .split("\n")
      .slice(-3)
      .join(" ");
    return { ok: false, reason: `${command} failed${tail ? `: ${tail}` : ""}` };
  }
  return { ok: true, stdout: String(result.stdout || "") };
}

function checkTrivyGate(gate: TrivyGate, cwd: string): GateResult {
  const base = { id: gate.id, type: gate.type };
  const trivy = gate.trivy ?? "trivy";
  const timeout = gate.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const target = gate.target ?? ".";
  const scanners = gate.scanners ?? DEFAULT_TRIVY_SCANNERS;
  const ran: string[] = [];

  if (scanners.includes("secret")) {
    const args = ["fs", "--scanners", "secret", "--exit-code", "1", "--no-progress", target];
    ran.push("secret");
    const res = runTrivyCommand(trivy, args, cwd, timeout);
    if (!res.ok) return { ...base, ok: false, reason: res.reason };
  }

  if (scanners.includes("vuln")) {
    const severity = gate.severity ?? DEFAULT_TRIVY_SEVERITY;
    const args = ["fs", "--scanners", "vuln", "--severity", severity.join(","), "--exit-code", "1", "--no-progress"];
    if (gate.ignoreUnfixed) args.push("--ignore-unfixed");
    args.push(target);
    ran.push(`vuln:${severity.join(",")}`);
    const res = runTrivyCommand(trivy, args, cwd, timeout);
    if (!res.ok) return { ...base, ok: false, reason: res.reason };
  }

  if (gate.sbom !== false) {
    const args = ["fs", "--format", "cyclonedx", "--no-progress", target];
    ran.push("sbom:cyclonedx");
    const res = runTrivyCommand(trivy, args, cwd, timeout);
    if (!res.ok) return { ...base, ok: false, reason: res.reason };
    if (!res.stdout.trim()) return { ...base, ok: false, reason: `${formatTrivyCommand(trivy, args)} produced an empty SBOM` };
  }

  return { ...base, ok: true, reason: `trivy passed (${ran.join(", ")}) on ${target}` };
}

function checkGate(gate: Gate, cwd: string, opts: RunOptions): GateResult {
  const base = { id: gate.id, type: gate.type };
  try {
    switch (gate.type) {
      case "file-exists": {
        const files = Array.isArray(gate.file) ? gate.file : [gate.file];
        const missing = files.filter((f) => !fs.existsSync(path.resolve(cwd, f)));
        return missing.length
          ? { ...base, ok: false, reason: `missing: ${missing.join(", ")}` }
          : { ...base, ok: true, reason: `present: ${files.join(", ")}` };
      }
      case "file-contains": {
        const full = path.resolve(cwd, gate.file);
        if (!fs.existsSync(full)) return { ...base, ok: false, reason: `file not found: ${gate.file}` };
        const re = new RegExp(gate.pattern, gate.flags ?? "");
        return re.test(fs.readFileSync(full, "utf8"))
          ? { ...base, ok: true, reason: `${gate.file} matches /${gate.pattern}/` }
          : { ...base, ok: false, reason: `${gate.file} missing /${gate.pattern}/` };
      }
      case "absent": {
        const re = new RegExp(gate.pattern, gate.flags ?? "");
        const files = globSync(gate.glob, { cwd, dot: true, ignore: [...IGNORE, ...(gate.ignore ?? [])] });
        for (const f of files) {
          let text: string;
          try {
            text = fs.readFileSync(path.resolve(cwd, f), "utf8");
          } catch {
            continue;
          }
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              return { ...base, ok: false, reason: `${f}:${i + 1} matches /${gate.pattern}/` };
            }
          }
        }
        return { ...base, ok: true, reason: `no /${gate.pattern}/ in ${gate.glob}` };
      }
      case "command": {
        const timeout = gate.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS;
        try {
          execSync(gate.run, { cwd, stdio: "pipe", encoding: "utf8", timeout });
          return { ...base, ok: true, reason: `\`${gate.run}\` exited 0` };
        } catch (e: any) {
          if (e.killed || e.code === "ETIMEDOUT") {
            return { ...base, ok: false, reason: `command timed out after ${timeout}ms` };
          }
          const tail = String(e.stderr || e.stdout || e.message || "")
            .trim()
            .split("\n")
            .slice(-2)
            .join(" ");
          return { ...base, ok: false, reason: `\`${gate.run}\` failed: ${tail}` };
        }
      }
      case "trivy":
        return checkTrivyGate(gate, cwd);
      case "evidence": {
        const full = path.resolve(cwd, gate.file);
        if (!fs.existsSync(full)) return { ...base, ok: false, reason: `evidence missing: ${gate.file}` };
        if (fs.statSync(full).size === 0) return { ...base, ok: false, reason: `evidence empty: ${gate.file}` };
        return { ...base, ok: true, reason: `evidence present: ${gate.file}` };
      }
      case "instruction-sync": {
        const threshold = gate.threshold ?? DEFAULT_THRESHOLD;
        const res = checkDrift(cwd, threshold);
        if (res.entries.length === 0) {
          return { ...base, ok: true, reason: `no agent instruction files found` };
        }
        if (res.drifted === 0) {
          return { ...base, ok: true, reason: `${res.entries.length} instruction files in sync with ${res.canonical}` };
        }
        const names = res.entries.filter((e) => e.status === "drifted").map((e) => e.tool);
        return {
          ...base,
          ok: false,
          reason: `${res.drifted} of ${res.entries.length} instruction files drifted from ${res.canonical}: ${names.join(", ")} (run \`skillgate sync\`)`,
        };
      }
      case "not-empty": {
        const full = path.resolve(cwd, gate.path);
        if (!fs.existsSync(full)) return { ...base, ok: false, reason: `directory not found: ${gate.path}` };
        const entries = fs.readdirSync(full);
        const min = gate.min ?? DEFAULT_NOT_EMPTY_MIN;
        if (entries.length < min) return { ...base, ok: false, reason: `directory has ${entries.length} entries, expected at least ${min}` };
        return { ...base, ok: true, reason: `directory has ${entries.length} entries` };
      }
      case "no-new": {
        if (!opts.baseRef) {
          return { ...base, ok: false, reason: `no git base ref to diff against — pass --base <ref> or run in a repo with an upstream (fail-closed)` };
        }
        // Fresh regex per line (drop g/y so lastIndex can't advance between .test calls).
        const flags = (gate.flags ?? "").replace(/[gy]/g, "");
        const re = () => new RegExp(gate.pattern, flags);
        const ignore = gate.ignore ?? [];
        const workFiles = globSync(gate.glob, { cwd, dot: true, ignore: [...IGNORE, ...ignore] });
        const baseFiles = listFilesAtRef(cwd, opts.baseRef).filter(
          (p) => matchesGlob(p, gate.glob, ignore) && !IGNORE.some((ig) => matchesGlob(p, ig)),
        );
        const union = new Set<string>([...workFiles, ...baseFiles]);
        let baseCount = 0;
        let workCount = 0;
        let firstNew = "";
        for (const f of union) {
          const baseText = readFileAtRef(cwd, opts.baseRef, f);
          baseCount += baseText == null ? 0 : countMatchingLines(baseText, re());
          try {
            const t = fs.readFileSync(path.resolve(cwd, f), "utf8");
            workCount += countMatchingLines(t, re(), (i) => {
              if (!firstNew) firstNew = `${f}:${i + 1}`;
            });
          } catch {
            /* file gone in working tree — contributes 0, handled by no-deleted */
          }
        }
        const short = opts.baseRef.slice(0, 12);
        return workCount > baseCount
          ? {
              ...base,
              ok: false,
              reason: `+${workCount - baseCount} new /${gate.pattern}/ vs ${short} (base ${baseCount}, now ${workCount})${firstNew ? `, e.g. ${firstNew}` : ""}`,
            }
          : { ...base, ok: true, reason: `no new /${gate.pattern}/ vs ${short} (${workCount} ≤ ${baseCount})` };
      }
      case "no-deleted": {
        if (!opts.baseRef) {
          return { ...base, ok: false, reason: `no git base ref to diff against — pass --base <ref> or run in a repo with an upstream (fail-closed)` };
        }
        const ignore = gate.ignore ?? [];
        const baseFiles = listFilesAtRef(cwd, opts.baseRef).filter((p) => matchesGlob(p, gate.glob, ignore));
        const missing = baseFiles.filter((f) => !fs.existsSync(path.resolve(cwd, f)));
        const short = opts.baseRef.slice(0, 12);
        return missing.length
          ? {
              ...base,
              ok: false,
              reason: `${missing.length} file(s) matching ${gate.glob} deleted since ${short}: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? " …" : ""}`,
            }
          : { ...base, ok: true, reason: `no ${gate.glob} files deleted vs ${short} (${baseFiles.length} present)` };
      }
      default:
        return { ...base, ok: false, reason: `unknown gate type` };
    }
  } catch (e: any) {
    return { ...base, ok: false, reason: `error: ${e.message}` };
  }
}

/** Run every gate in the spec over `cwd`. Pure: same inputs (incl. git base), same verdict. */
export function runGates(spec: Spec, cwd: string, opts: RunOptions = {}): RunResult {
  const results = (spec.gates ?? []).map((g) => checkGate(g, cwd, opts));
  const failed = results.filter((r) => !r.ok);
  return { passed: failed.length === 0, results, failed };
}

/** True when `command` crosses one of the configured finish-line patterns. */
export function isFinishLine(command: string, patterns: string[] | undefined): boolean {
  if (!patterns || !patterns.length) return false;
  return patterns.some((p) => command.includes(p));
}

export interface Decision {
  decision: "allow" | "block";
  reason: string;
  command: string;
  result?: RunResult;
}

/**
 * The harness-neutral verdict: given a command an agent is about to run, decide
 * whether to let it through. Any tool — a Claude Code hook, a Cursor/Codex
 * wrapper, a git hook, a bare shell — can call this and read the same answer, so
 * enforcement no longer depends on one harness's plugin API. A command that does
 * not cross the finish line is always allowed; one that does is blocked unless
 * every gate passes.
 */
export function decideCommand(spec: Spec, cwd: string, command: string, opts: RunOptions = {}): Decision {
  if (!isFinishLine(command, spec.finishLine)) {
    return { decision: "allow", reason: "not a finish-line command", command };
  }
  const result = runGates(spec, cwd, opts);
  return result.passed
    ? { decision: "allow", reason: `all ${result.results.length} gates passed`, command, result }
    : {
        decision: "block",
        reason: `${result.failed.length} of ${result.results.length} gates unmet: ${result.failed.map((f) => f.id).join(", ")}`,
        command,
        result,
      };
}

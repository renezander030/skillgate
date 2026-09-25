import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { globSync } from "tinyglobby";
import {
  type Spec,
  type Gate,
  type GateWhen,
  type PhaseGate,
  type TrivyGate,
  DEFAULT_PHASE_FILE,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_NOT_EMPTY_MIN,
  DEFAULT_RUN_TIMEOUT_MS,
} from "./spec.js";
import { checkDrift, DEFAULT_THRESHOLD } from "./drift.js";
import { readFileAtRef, listFilesAtRef, matchesGlob, changedFiles, currentBranch, baseLabel } from "./git.js";
import { checkManifest, SUPPORTED_MANIFESTS } from "./deps.js";
import { isStructuredCommandMatch } from "./command.js";
import { runShellCommand } from "./process.js";

export interface GateResult {
  id: string;
  type: string;
  ok: boolean;
  reason: string;
  /** Explicit execution state; `not-run` is always blocking, `skipped` never is. */
  status?: "pass" | "fail" | "not-run" | "skipped";
  durationMs?: number;
  /** Workspace-relative file (and 1-based line) a failure points at, when known. */
  location?: { file: string; line?: number };
}

export interface RunResult {
  passed: boolean;
  results: GateResult[];
  failed: GateResult[];
  durationMs?: number;
  timeoutMs?: number;
}

/** Evaluation context. `baseRef` is the git ref diff-aware gates compare against. */
export interface RunOptions {
  baseRef?: string;
  /** Override the spec's total wall-clock budget for this run. */
  timeoutMs?: number;
  /** Internal per-gate cap derived from the remaining total budget. */
  remainingMs?: number;
  /** The finish-line command being judged, for `when.command`. Unset = every gate applies. */
  command?: string;
  /** The agent tool call being judged (see `gatedTools`), for `when.tool`. */
  tool?: string;
  /** Treat a glob that matches no files as a pass (built-in audit defaults only). */
  allowEmptyGlobs?: boolean;
  /** Internal: every gate in the spec by id, for `phase` gates. */
  gates?: Map<string, Gate>;
  /** Internal: results already computed in this run, so a required gate runs once. */
  memo?: Map<string, GateResult>;
}

export interface PhaseStatus {
  /** The phase being evaluated. */
  phase: string;
  /** Required gates (cumulative through `phase`) that currently fail. */
  failed: GateResult[];
  /** Every required gate id, in phase order. */
  required: string[];
  error?: string;
}

/** Id of the active phase: the marker file's first line, or the first phase when there is none. */
export function currentPhase(gate: PhaseGate, cwd: string): string {
  const file = path.resolve(cwd, gate.current ?? DEFAULT_PHASE_FILE);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split(/\r?\n/)[0]?.trim() : "";
  return text || gate.phases[0].id;
}

/**
 * Evaluate what being in `target` requires: every gate listed by that phase and by
 * each earlier one must pass now. Stateless: nothing is read but the policy and
 * the workspace, so an agent cannot mark a phase done without doing it.
 */
export function evaluatePhase(gate: PhaseGate, target: string, cwd: string, opts: RunOptions): PhaseStatus {
  const index = gate.phases.findIndex((phase) => phase.id === target);
  if (index < 0) {
    return { phase: target, failed: [], required: [], error: `unknown phase ${target} (phases: ${gate.phases.map((p) => p.id).join(", ")})` };
  }
  const required = [...new Set(gate.phases.slice(0, index + 1).flatMap((phase) => phase.requires ?? []))];
  const failed: GateResult[] = [];
  for (const id of required) {
    const dep = opts.gates?.get(id);
    if (!dep) {
      failed.push({ id, type: "missing", ok: false, reason: `no gate with id ${id}` });
      continue;
    }
    const result = runOne(dep, cwd, opts);
    if (!result.ok) failed.push(result);
  }
  return { phase: target, failed, required };
}

/** checkGate with the per-run memo, so a gate required by a phase is evaluated once. */
function runOne(gate: Gate, cwd: string, opts: RunOptions): GateResult {
  const cached = opts.memo?.get(gate.id);
  if (cached) return cached;
  const result = checkGate(gate, cwd, opts);
  opts.memo?.set(gate.id, result);
  return result;
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

/** A pattern gate hit a read limit; the gate fails with this message. */
class ScanLimit extends Error {}

/** Reads text for pattern gates, enforcing the per-file size cap and the run deadline. */
class Scanner {
  private readonly maxBytes: number;
  private readonly deadline: number;
  scanned = 0;

  constructor(maxBytes: number | undefined, remainingMs: number | undefined) {
    this.maxBytes = maxBytes ?? DEFAULT_MAX_BYTES;
    this.deadline = Date.now() + (remainingMs ?? Number.POSITIVE_INFINITY);
  }

  private tick(total: number): void {
    if (Date.now() > this.deadline) throw new ScanLimit(`timed out after scanning ${this.scanned} of ${total} files`);
  }

  private cap(label: string, bytes: number): void {
    if (bytes > this.maxBytes) {
      throw new ScanLimit(`${label} is ${bytes} bytes, over the ${this.maxBytes}-byte scan limit — add it to ignore or raise maxBytes`);
    }
  }

  /** Working-tree text, or null when the file cannot be read (gone, a directory). */
  file(cwd: string, rel: string, total: number): string | null {
    this.tick(total);
    const full = path.resolve(cwd, rel);
    let size: number;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) return null;
      size = stat.size;
    } catch {
      return null;
    }
    this.cap(rel, size);
    this.scanned++;
    return fs.readFileSync(full, "utf8");
  }

  /** Text as of a git ref, or null when the file did not exist there. */
  atRef(cwd: string, ref: string, rel: string, total: number): string | null {
    this.tick(total);
    const text = readFileAtRef(cwd, ref, rel);
    if (text != null) this.cap(`${rel} at ${ref.slice(0, 12)}`, Buffer.byteLength(text));
    return text;
  }
}

function noOpReason(glob: string): string {
  return `glob ${glob} matches no files — the gate would pass as a no-op (fix the glob or set allowEmpty: true)`;
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

function checkTrivyGate(gate: TrivyGate, cwd: string, remainingMs?: number): GateResult {
  const base = { id: gate.id, type: gate.type };
  const trivy = gate.trivy ?? "trivy";
  const started = Date.now();
  const configuredTimeout = gate.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const nextTimeout = () => Math.max(1, Math.min(configuredTimeout, (remainingMs ?? Number.POSITIVE_INFINITY) - (Date.now() - started)));
  const target = gate.target ?? ".";
  const scanners = gate.scanners ?? DEFAULT_TRIVY_SCANNERS;
  const ran: string[] = [];

  if (scanners.includes("secret")) {
    const args = ["fs", "--scanners", "secret", "--exit-code", "1", "--no-progress", target];
    ran.push("secret");
    const res = runTrivyCommand(trivy, args, cwd, nextTimeout());
    if (!res.ok) return { ...base, ok: false, reason: res.reason };
  }

  if (scanners.includes("vuln")) {
    const severity = gate.severity ?? DEFAULT_TRIVY_SEVERITY;
    const args = ["fs", "--scanners", "vuln", "--severity", severity.join(","), "--exit-code", "1", "--no-progress"];
    if (gate.ignoreUnfixed) args.push("--ignore-unfixed");
    args.push(target);
    ran.push(`vuln:${severity.join(",")}`);
    const res = runTrivyCommand(trivy, args, cwd, nextTimeout());
    if (!res.ok) return { ...base, ok: false, reason: res.reason };
  }

  if (gate.sbom !== false) {
    const args = ["fs", "--format", "cyclonedx", "--no-progress", target];
    ran.push("sbom:cyclonedx");
    const res = runTrivyCommand(trivy, args, cwd, nextTimeout());
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
          ? { ...base, ok: false, reason: `missing: ${missing.join(", ")}`, location: { file: missing[0] } }
          : { ...base, ok: true, reason: `present: ${files.join(", ")}` };
      }
      case "file-contains": {
        const full = path.resolve(cwd, gate.file);
        if (!fs.existsSync(full)) return { ...base, ok: false, reason: `file not found: ${gate.file}`, location: { file: gate.file } };
        const re = new RegExp(gate.pattern, gate.flags ?? "");
        const text = new Scanner(gate.maxBytes, opts.remainingMs).file(cwd, gate.file, 1) ?? "";
        return re.test(text)
          ? { ...base, ok: true, reason: `${gate.file} matches /${gate.pattern}/` }
          : { ...base, ok: false, reason: `${gate.file} missing /${gate.pattern}/`, location: { file: gate.file } };
      }
      case "absent": {
        const re = new RegExp(gate.pattern, (gate.flags ?? "").replace(/[gy]/g, ""));
        const files = globSync(gate.glob, { cwd, dot: true, ignore: [...IGNORE, ...(gate.ignore ?? [])] });
        if (files.length === 0 && !gate.allowEmpty && !opts.allowEmptyGlobs) return { ...base, ok: false, reason: noOpReason(gate.glob) };
        const scan = new Scanner(gate.maxBytes, opts.remainingMs);
        for (const f of files) {
          const text = scan.file(cwd, f, files.length);
          if (text == null) continue;
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              return { ...base, ok: false, reason: `${f}:${i + 1} matches /${gate.pattern}/`, location: { file: f, line: i + 1 } };
            }
          }
        }
        return { ...base, ok: true, reason: `no /${gate.pattern}/ in ${gate.glob} (${files.length} files)` };
      }
      case "command": {
        const timeout = Math.max(1, Math.min(gate.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS, opts.remainingMs ?? Number.POSITIVE_INFINITY));
        const result = runShellCommand(gate.run, cwd, timeout);
        if (result.timedOut) return { ...base, ok: false, reason: `command timed out after ${timeout}ms` };
        if (result.error) return { ...base, ok: false, reason: `\`${gate.run}\` failed: ${result.error.message}` };
        if (result.status === 0) return { ...base, ok: true, reason: `\`${gate.run}\` exited 0` };
        const tail = String(result.stderr || result.stdout || "")
          .trim()
          .split("\n")
          .slice(-2)
          .join(" ");
        return { ...base, ok: false, reason: `\`${gate.run}\` failed${tail ? `: ${tail}` : ` with exit ${result.status ?? 1}`}` };
      }
      case "trivy":
        return checkTrivyGate(gate, cwd, opts.remainingMs);
      case "evidence": {
        const full = path.resolve(cwd, gate.file);
        if (!fs.existsSync(full)) return { ...base, ok: false, reason: `evidence missing: ${gate.file}`, location: { file: gate.file } };
        if (fs.statSync(full).size === 0) return { ...base, ok: false, reason: `evidence empty: ${gate.file}`, location: { file: gate.file } };
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
      case "no-new":
      case "no-fewer": {
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
        const union = [...new Set<string>([...workFiles, ...baseFiles])];
        if (union.length === 0 && !gate.allowEmpty && !opts.allowEmptyGlobs) return { ...base, ok: false, reason: noOpReason(gate.glob) };
        const scan = new Scanner(gate.maxBytes, opts.remainingMs);
        let baseCount = 0;
        let workCount = 0;
        let firstNew: { file: string; line: number } | undefined;
        let firstLost: string | undefined;
        for (const f of union) {
          const baseText = scan.atRef(cwd, opts.baseRef, f, union.length);
          const fileBase = baseText == null ? 0 : countMatchingLines(baseText, re());
          const text = scan.file(cwd, f, union.length);
          // A file gone from the working tree contributes 0; no-deleted covers the file itself.
          const fileWork = text == null ? 0 : countMatchingLines(text, re(), (i) => {
            if (!firstNew) firstNew = { file: f, line: i + 1 };
          });
          if (fileWork < fileBase && !firstLost) firstLost = f;
          baseCount += fileBase;
          workCount += fileWork;
        }
        const short = baseLabel(opts.baseRef);
        if (gate.type === "no-fewer") {
          return workCount < baseCount
            ? {
                ...base,
                ok: false,
                reason: `-${baseCount - workCount} /${gate.pattern}/ vs ${short} (base ${baseCount}, now ${workCount})${firstLost ? `, e.g. ${firstLost}` : ""}`,
                ...(firstLost ? { location: { file: firstLost } } : {}),
              }
            : { ...base, ok: true, reason: `no fewer /${gate.pattern}/ vs ${short} (${workCount} ≥ ${baseCount})` };
        }
        return workCount > baseCount
          ? {
              ...base,
              ok: false,
              reason: `+${workCount - baseCount} new /${gate.pattern}/ vs ${short} (base ${baseCount}, now ${workCount})${firstNew ? `, e.g. ${firstNew.file}:${firstNew.line}` : ""}`,
              ...(firstNew ? { location: firstNew } : {}),
            }
          : { ...base, ok: true, reason: `no new /${gate.pattern}/ vs ${short} (${workCount} ≤ ${baseCount})` };
      }
      case "no-deleted": {
        if (!opts.baseRef) {
          return { ...base, ok: false, reason: `no git base ref to diff against — pass --base <ref> or run in a repo with an upstream (fail-closed)` };
        }
        const ignore = gate.ignore ?? [];
        const baseFiles = listFilesAtRef(cwd, opts.baseRef).filter((p) => matchesGlob(p, gate.glob, ignore));
        if (baseFiles.length === 0 && !gate.allowEmpty && !opts.allowEmptyGlobs) {
          const workFiles = globSync(gate.glob, { cwd, dot: true, ignore: [...IGNORE, ...ignore] });
          if (workFiles.length === 0) return { ...base, ok: false, reason: noOpReason(gate.glob) };
        }
        const missing = baseFiles.filter((f) => !fs.existsSync(path.resolve(cwd, f)));
        const short = baseLabel(opts.baseRef);
        return missing.length
          ? {
              ...base,
              ok: false,
              reason: `${missing.length} file(s) matching ${gate.glob} deleted since ${short}: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? " …" : ""}`,
              location: { file: missing[0] },
            }
          : { ...base, ok: true, reason: `no ${gate.glob} files deleted vs ${short} (${baseFiles.length} present)` };
      }
      case "phase": {
        const phase = currentPhase(gate, cwd);
        const status = evaluatePhase(gate, phase, cwd, opts);
        const marker = gate.current ?? DEFAULT_PHASE_FILE;
        if (status.error) return { ...base, ok: false, reason: `${marker}: ${status.error}`, location: { file: marker } };
        if (status.failed.length) {
          return {
            ...base,
            ok: false,
            reason: `phase ${phase} requires ${status.failed.map((f) => `${f.id} (${f.reason})`).join("; ")}`,
          };
        }
        return { ...base, ok: true, reason: `in phase ${phase}; ${status.required.length} required gate(s) pass` };
      }
      case "deps-locked": {
        const manifests = gate.manifest == null
          ? SUPPORTED_MANIFESTS.filter((m) => fs.existsSync(path.resolve(cwd, m)))
          : Array.isArray(gate.manifest) ? gate.manifest : [gate.manifest];
        if (manifests.length === 0) {
          return { ...base, ok: false, reason: `no supported manifest found (${SUPPORTED_MANIFESTS.join(", ")}) — set manifest:` };
        }
        let declared = 0;
        for (const m of manifests) {
          const report = checkManifest(path.resolve(cwd, m));
          if (report.error) return { ...base, ok: false, reason: `${m}: ${report.error}`, location: { file: m } };
          if (report.missing.length) {
            const lock = path.basename(report.lockfile ?? "lockfile");
            return {
              ...base,
              ok: false,
              reason: `${m}: ${report.missing.length} declared ${report.missing.length === 1 ? "dependency is" : "dependencies are"} not in ${lock}: ${report.missing.slice(0, 5).join(", ")}${report.missing.length > 5 ? " …" : ""} — install it or remove it`,
              location: { file: m },
            };
          }
          declared += report.declared.length;
        }
        return { ...base, ok: true, reason: `${declared} declared dependencies locked (${manifests.join(", ")})` };
      }
      default:
        return { ...base, ok: false, reason: `unknown gate type` };
    }
  } catch (e: any) {
    if (e instanceof ScanLimit) return { ...base, ok: false, reason: e.message };
    return { ...base, ok: false, reason: `error: ${e.message}` };
  }
}

/**
 * Decide whether `when` excludes this gate. Returns the skip reason, or null when
 * the gate applies. A condition that cannot be decided never skips.
 */
function skipReason(when: GateWhen | undefined, cwd: string, opts: RunOptions, ctx: { changed?: string[] | null; branch?: string | null }): string | null {
  if (!when) return null;
  // A gate scoped to commands or tools applies only when the judged action is one of
  // them. A plain `check` judges no action, so every gate applies.
  if ((when.command || when.tool) && (opts.command != null || opts.tool != null)) {
    const hit = opts.tool != null
      ? !!when.tool?.some((glob) => matchesGlob(opts.tool!, glob))
      : !!when.command && isStructuredCommandMatch(opts.command!, when.command);
    if (!hit) {
      const scope = [when.command && `when.command: ${when.command.join(", ")}`, when.tool && `when.tool: ${when.tool.join(", ")}`].filter(Boolean).join("; ");
      return `skipped: not required for ${opts.tool != null ? `tool ${opts.tool}` : "this command"} (${scope})`;
    }
  }
  if (when.branch) {
    if (ctx.branch === undefined) ctx.branch = currentBranch(cwd) ?? null;
    if (ctx.branch != null && !when.branch.some((glob) => matchesGlob(ctx.branch!, glob))) {
      return `skipped: branch ${ctx.branch} not in when.branch (${when.branch.join(", ")})`;
    }
  }
  if (when.changed && opts.baseRef) {
    if (ctx.changed === undefined) ctx.changed = changedFiles(cwd, opts.baseRef);
    if (ctx.changed != null && !ctx.changed.some((file) => when.changed!.some((glob) => matchesGlob(file, glob)))) {
      return `skipped: no changed file matches when.changed (${when.changed.join(", ")}) vs ${baseLabel(opts.baseRef)}`;
    }
  }
  return null;
}

/** Run every gate in the spec over `cwd`. Pure: same inputs (incl. git base), same verdict. */
export function runGates(spec: Spec, cwd: string, opts: RunOptions = {}): RunResult {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? spec.timeout ?? DEFAULT_RUN_TIMEOUT_MS;
  const results: GateResult[] = [];
  const ctx: { changed?: string[] | null; branch?: string | null } = {};
  const gates = new Map((spec.gates ?? []).map((gate) => [gate.id, gate]));
  const memo = new Map<string, GateResult>();
  for (const gate of spec.gates ?? []) {
    const skipped = skipReason(gate.when, cwd, opts, ctx);
    if (skipped) {
      results.push({ id: gate.id, type: gate.type, ok: true, status: "skipped", durationMs: 0, reason: skipped });
      continue;
    }
    const elapsed = Date.now() - started;
    const remainingMs = timeoutMs - elapsed;
    if (remainingMs <= 0) {
      results.push({
        id: gate.id,
        type: gate.type,
        ok: false,
        status: "not-run",
        durationMs: 0,
        reason: `not run: overall timeout exhausted after ${timeoutMs}ms`,
      });
      continue;
    }
    const gateStarted = Date.now();
    const result = runOne(gate, cwd, { ...opts, remainingMs, gates, memo });
    results.push({
      ...result,
      status: result.ok ? "pass" : "fail",
      durationMs: Date.now() - gateStarted,
    });
  }
  const failed = results.filter((r) => !r.ok);
  return { passed: failed.length === 0, results, failed, durationMs: Date.now() - started, timeoutMs };
}

/** True when `tool` matches one of the spec's `gatedTools` globs. */
export function isGatedTool(tool: string, patterns: string[] | undefined): boolean {
  return !!patterns?.some((glob) => matchesGlob(tool, glob));
}

/** The verdict for an agent tool call (an MCP tool, say): gated tools are blocked until every applicable gate passes. */
export function decideTool(spec: Spec, cwd: string, tool: string, opts: RunOptions = {}): Decision {
  if (!isGatedTool(tool, spec.gatedTools)) return { decision: "allow", reason: "not a gated tool", command: tool };
  const result = runGates(spec, cwd, { ...opts, tool, command: undefined });
  const applied = result.results.filter((r) => r.status !== "skipped").length;
  return result.passed
    ? { decision: "allow", reason: `all ${applied} applicable gates passed`, command: tool, result }
    : {
        decision: "block",
        reason: `${result.failed.length} of ${applied} gates unmet: ${result.failed.map((f) => f.id).join(", ")}`,
        command: tool,
        result,
      };
}

/** True when `command` crosses one of the configured finish-line patterns. */
export function isFinishLine(command: string, patterns: string[] | undefined): boolean {
  return isStructuredCommandMatch(command, patterns);
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
  const result = runGates(spec, cwd, { ...opts, command });
  const applied = result.results.filter((r) => r.status !== "skipped").length;
  return result.passed
    ? { decision: "allow", reason: `all ${applied} applicable gates passed`, command, result }
    : {
        decision: "block",
        reason: `${result.failed.length} of ${result.results.length} gates unmet: ${result.failed.map((f) => f.id).join(", ")}`,
        command,
        result,
      };
}

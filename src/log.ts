// Opt-in decision log. Every `gate` and `check` verdict can be appended as one
// JSON line, so you can see how often the gate fired, what it blocked and why —
// and tell "ran and allowed" apart from "never ran". Logging never changes a
// verdict: a log that cannot be written is reported on stderr and skipped.
import fs from "node:fs";
import path from "node:path";
import type { GateResult } from "./core.js";

export interface LogRecord {
  /** ISO timestamp. */
  ts: string;
  /** The skillgate command that decided: gate or check. */
  via: "gate" | "check";
  /** gate: command | stop | tool. check: check. */
  event: string;
  decision: "allow" | "block";
  reason: string;
  command?: string;
  tool?: string;
  /** Workspace the policy is rooted in. */
  workspace: string;
  failed: { id: string; reason: string }[];
  durationMs?: number;
}

/** Log destination: `--log <file>` wins over `SKILLGATE_LOG`. Undefined = off. */
export function logPath(flag: string | undefined, cwd: string): string | undefined {
  const value = flag?.trim() || process.env.SKILLGATE_LOG?.trim();
  return value ? path.resolve(cwd, value) : undefined;
}

/**
 * Why `file` must not be used, or null when it may. A log inside the worktree
 * (outside `.git/`) would change the snapshot the gates judge and make a clean
 * worktree dirty, so it is refused.
 */
export function logPathProblem(file: string, workspace: string): string | null {
  const rel = path.relative(workspace, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts[0] === ".git") return null;
  return `decision log ${rel} is inside the worktree — use a path outside it or under .git/ (logging skipped)`;
}

export function toFailed(results: GateResult[]): { id: string; reason: string }[] {
  return results.map((r) => ({ id: r.id, reason: r.reason }));
}

/** Append one record. Returns an error message instead of throwing. */
export function appendLog(file: string, record: LogRecord): string | null {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + "\n");
    return null;
  } catch (error: any) {
    return `decision log not written: ${error.message}`;
  }
}

export interface LogSummary {
  records: number;
  malformed: number;
  first?: string;
  last?: string;
  allowed: number;
  blocked: number;
  byEvent: Record<string, { allowed: number; blocked: number }>;
  /** Gate ids by how often they blocked, most first. */
  blockingGates: { id: string; count: number }[];
  /** Blocked commands or tools by frequency, most first. */
  blockedActions: { action: string; count: number }[];
  /** Records that blocked on an evaluation error rather than a failed gate. */
  errors: number;
}

/** Summarize a decision log. Malformed lines are counted, never fatal. */
export function summarizeLog(text: string, top = 10): LogSummary {
  const summary: LogSummary = { records: 0, malformed: 0, allowed: 0, blocked: 0, byEvent: {}, blockingGates: [], blockedActions: [], errors: 0 };
  const gates = new Map<string, number>();
  const actions = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: LogRecord;
    try {
      record = JSON.parse(line);
      if (!record || (record.decision !== "allow" && record.decision !== "block")) throw new Error("not a decision");
    } catch {
      summary.malformed++;
      continue;
    }
    summary.records++;
    if (!summary.first || record.ts < summary.first) summary.first = record.ts;
    if (!summary.last || record.ts > summary.last) summary.last = record.ts;
    const event = (summary.byEvent[record.event] ??= { allowed: 0, blocked: 0 });
    if (record.decision === "allow") {
      summary.allowed++;
      event.allowed++;
      continue;
    }
    summary.blocked++;
    event.blocked++;
    if (!record.failed?.length && /^error: /.test(record.reason ?? "")) summary.errors++;
    for (const f of record.failed ?? []) gates.set(f.id, (gates.get(f.id) ?? 0) + 1);
    const action = record.tool ?? record.command ?? record.event;
    if (action) actions.set(action, (actions.get(action) ?? 0) + 1);
  }
  const ranked = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top);
  summary.blockingGates = ranked(gates).map(([id, count]) => ({ id, count }));
  summary.blockedActions = ranked(actions).map(([action, count]) => ({ action, count }));
  return summary;
}

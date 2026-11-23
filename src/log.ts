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

// Validate only fields consumed by the summary. Older logs may omit workspace,
// via, or failed; unknown metadata remains forward-compatible.
type SummaryRecord = Pick<LogRecord, "ts" | "event" | "decision" | "reason" | "command" | "tool"> & {
  failed?: { id: string }[] | null;
};

function isSummaryRecord(value: unknown): value is SummaryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (r.decision === "allow" || r.decision === "block")
    && typeof r.ts === "string" && typeof r.event === "string" && typeof r.reason === "string"
    && (r.command === undefined || typeof r.command === "string")
    && (r.tool === undefined || typeof r.tool === "string")
    && (r.failed == null || (Array.isArray(r.failed) && r.failed.every(
      (f: unknown) => !!f && typeof f === "object" && !Array.isArray(f) && typeof (f as { id?: unknown }).id === "string",
    )));
}

/** Shared aggregation for in-memory and streamed logs; invalid records are atomic. */
function logSummary(top: number) {
  const summary: LogSummary = { records: 0, malformed: 0, allowed: 0, blocked: 0, byEvent: {}, blockingGates: [], blockedActions: [], errors: 0 };
  const events = new Map<string, { allowed: number; blocked: number }>();
  const gates = new Map<string, number>();
  const actions = new Map<string, number>();
  return {
    add(line: string): void {
      if (!line.trim()) return;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        summary.malformed++;
        return;
      }
      if (!isSummaryRecord(record)) {
        summary.malformed++;
        return;
      }
      summary.records++;
      if (!summary.first || record.ts < summary.first) summary.first = record.ts;
      if (!summary.last || record.ts > summary.last) summary.last = record.ts;
      let event = events.get(record.event);
      if (!event) events.set(record.event, event = { allowed: 0, blocked: 0 });
      if (record.decision === "allow") {
        summary.allowed++;
        event.allowed++;
        return;
      }
      summary.blocked++;
      event.blocked++;
      if (!record.failed?.length && /^error: /.test(record.reason)) summary.errors++;
      for (const f of record.failed ?? []) gates.set(f.id, (gates.get(f.id) ?? 0) + 1);
      const action = record.tool ?? record.command ?? record.event;
      if (action) actions.set(action, (actions.get(action) ?? 0) + 1);
    },
    finish(): LogSummary {
      const ranked = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top);
      summary.byEvent = Object.fromEntries(events);
      summary.blockingGates = ranked(gates).map(([id, count]) => ({ id, count }));
      summary.blockedActions = ranked(actions).map(([action, count]) => ({ action, count }));
      return summary;
    },
  };
}

/** Summarize a decision log. Malformed lines are counted, never fatal. */
export function summarizeLog(text: string, top = 10): LogSummary {
  const summary = logSummary(top);
  for (const line of text.split(/\r?\n/)) summary.add(line);
  return summary.finish();
}

/** Read incrementally. Memory grows with the longest line and distinct groups. */
export async function summarizeLogFile(file: string, top = 10): Promise<LogSummary> {
  const summary = logSummary(top);
  const input = fs.createReadStream(file, { encoding: "utf8" });
  let pending = "";
  try {
    for await (const chunk of input) {
      pending += chunk;
      let start = 0;
      let end: number;
      while ((end = pending.indexOf("\n", start)) !== -1) {
        summary.add(pending.slice(start, end));
        start = end + 1;
      }
      pending = pending.slice(start);
    }
    summary.add(pending);
    return summary.finish();
  } finally {
    input.destroy();
  }
}

/**
 * Commands from a corpus: one per line, or decision-log JSON lines (their `command`).
 * A line that opens like a JSON object (`{"`) but does not parse is a truncated or
 * corrupt log record: it is counted in `skipped`, never replayed as a command. A
 * shell brace group such as `{ git push; }` is still a command.
 */
export function corpusCommands(text: string): { commands: string[]; skipped: number } {
  const commands: string[] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("{")) {
      try {
        const record = JSON.parse(trimmed);
        if (typeof record?.command === "string" && record.command.trim() && !record.tool) commands.push(record.command.trim());
        continue;
      } catch {
        if (/^\{\s*"/.test(trimmed)) {
          skipped++;
          continue;
        }
        /* a command that starts with "{" */
      }
    }
    commands.push(trimmed);
  }
  return { commands, skipped };
}

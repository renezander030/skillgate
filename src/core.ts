import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { globSync } from "tinyglobby";
import type { Spec, Gate } from "./spec.js";
import { checkDrift, DEFAULT_THRESHOLD } from "./drift.js";

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

const IGNORE = ["**/node_modules/**", "**/.git/**", "dist/**"];

function checkGate(gate: Gate, cwd: string): GateResult {
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
        try {
          execSync(gate.run, { cwd, stdio: "pipe", encoding: "utf8" });
          return { ...base, ok: true, reason: `\`${gate.run}\` exited 0` };
        } catch (e: any) {
          const tail = String(e.stderr || e.stdout || e.message || "")
            .trim()
            .split("\n")
            .slice(-2)
            .join(" ");
          return { ...base, ok: false, reason: `\`${gate.run}\` failed: ${tail}` };
        }
      }
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
      default:
        return { ...base, ok: false, reason: `unknown gate type` };
    }
  } catch (e: any) {
    return { ...base, ok: false, reason: `error: ${e.message}` };
  }
}

/** Run every gate in the spec over `cwd`. Pure: same inputs, same verdict. */
export function runGates(spec: Spec, cwd: string): RunResult {
  const results = (spec.gates ?? []).map((g) => checkGate(g, cwd));
  const failed = results.filter((r) => !r.ok);
  return { passed: failed.length === 0, results, failed };
}

/** True when `command` crosses one of the configured finish-line patterns. */
export function isFinishLine(command: string, patterns: string[] | undefined): boolean {
  if (!patterns || !patterns.length) return false;
  return patterns.some((p) => command.includes(p));
}

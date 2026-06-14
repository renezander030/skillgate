import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/** A gate is one deterministic, machine-checkable condition over the workspace. */
export interface BaseGate {
  id: string;
  description?: string;
}

/** Every listed path must exist. */
export interface FileExistsGate extends BaseGate {
  type: "file-exists";
  file: string | string[];
}

/** A file must contain a regex match (required section, exact phrase, ...). */
export interface FileContainsGate extends BaseGate {
  type: "file-contains";
  file: string;
  pattern: string;
  flags?: string;
}

/** A regex must NOT appear in any matched file (secret scrub, stray TODOs, ...). */
export interface AbsentGate extends BaseGate {
  type: "absent";
  glob: string;
  pattern: string;
  flags?: string;
  /** Extra globs to exclude (fixtures, examples, the spec file itself). */
  ignore?: string[];
}

/** A command must exit 0. Only as deterministic as the command itself. */
export interface CommandGate extends BaseGate {
  type: "command";
  run: string;
}

/**
 * A named evidence file must exist and be non-empty. The escape hatch for steps
 * that aren't machine-observable ("research X first"): the agent writes the file
 * as it works, the gate verifies the file is there.
 */
export interface EvidenceGate extends BaseGate {
  type: "evidence";
  file: string;
}

export type Gate =
  | FileExistsGate
  | FileContainsGate
  | AbsentGate
  | CommandGate
  | EvidenceGate;

export interface Spec {
  name?: string;
  /** Commands that count as crossing the finish line (substring match). */
  finishLine?: string[];
  gates: Gate[];
}

export const DEFAULT_SPEC_PATHS = [
  ".skillgate/done.yaml",
  ".skillgate/done.yml",
  ".skillgate.yaml",
  ".skillgate.yml",
  ".skillgate.json",
];

/** Find the first default spec file present under `dir`, or null. */
export function findSpecPath(dir: string): string | null {
  for (const p of DEFAULT_SPEC_PATHS) {
    const full = path.join(dir, p);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

export function loadSpec(specPath: string): Spec {
  const raw = fs.readFileSync(specPath, "utf8");
  const data = specPath.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
  if (!data || !Array.isArray(data.gates)) {
    throw new Error(`invalid spec ${specPath}: missing "gates" array`);
  }
  return data as Spec;
}

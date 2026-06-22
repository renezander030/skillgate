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
  /** Timeout in milliseconds. Default 30000 (30s). */
  timeout?: number;
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

/**
 * Every AI agent instruction file in the repo (CLAUDE.md, AGENTS.md,
 * .cursor/rules, copilot-instructions.md, ...) must still agree with the
 * canonical one. Drift means your agents are reading different rulebooks.
 * Ported from adrift.
 */
export interface InstructionSyncGate extends BaseGate {
  type: "instruction-sync";
  /** Similarity ratio required to count as in sync (0..1). Default 0.95. */
  threshold?: number;
}

/** A directory must contain at least `min` entries. Default 1. */
export interface NotEmptyGate extends BaseGate {
  type: "not-empty";
  path: string;
  /** Minimum number of entries. Default 1. */
  min?: number;
}

export type Gate =
  | FileExistsGate
  | FileContainsGate
  | AbsentGate
  | CommandGate
  | EvidenceGate
  | InstructionSyncGate
  | NotEmptyGate;

export interface Spec {
  /**
   * Spec format version. Optional and backward-compatible: an omitted version is
   * treated as the current format. Bump only on a breaking change to the schema;
   * skillgate warns (it does not refuse) when a spec declares a version newer than
   * it understands, so an older CLI degrades loudly rather than silently.
   */
  version?: number;
  name?: string;
  /** Commands that count as crossing the finish line (substring match). */
  finishLine?: string[];
  gates: Gate[];
}

/** The spec format version this build understands. See docs/compatibility.md. */
export const SPEC_VERSION = 1;

/** Default minimum entries for `not-empty` gate. */
export const DEFAULT_NOT_EMPTY_MIN = 1;

/** Default timeout for command gates (30 seconds). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

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
  if (data.version != null) {
    if (typeof data.version !== "number" || !Number.isInteger(data.version)) {
      throw new Error(`invalid spec ${specPath}: "version" must be an integer`);
    }
    if (data.version > SPEC_VERSION) {
      console.warn(
        `skillgate: spec ${specPath} declares version ${data.version} but this build understands up to ${SPEC_VERSION} — upgrade skillgate; some gates may be misread`,
      );
    }
  }
  return data as Spec;
}

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

/** Trivy must find no leaked secrets and no vulnerabilities at or above severity. */
export interface TrivyGate extends BaseGate {
  type: "trivy";
  /** Path to scan. Default ".". */
  target?: string;
  /** Trivy binary to execute. Default "trivy". */
  trivy?: string;
  /** Scanners to run. Default ["vuln", "secret"]. */
  scanners?: ("vuln" | "secret")[];
  /** Vulnerability severities that block. Default ["CRITICAL"]. */
  severity?: ("UNKNOWN" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL")[];
  /** Also require Trivy to generate a CycloneDX SBOM. Default true. */
  sbom?: boolean;
  /** Pass --ignore-unfixed to the vulnerability scan. Default false. */
  ignoreUnfixed?: boolean;
  /** Timeout in milliseconds per Trivy invocation. Default 30000 (30s). */
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

/**
 * The count of lines matching `pattern` across `glob` must not INCREASE versus
 * the base ref. Catches an agent that games a green gate by adding skips, `xit`,
 * `// eslint-disable`, TODOs or debug artifacts — a passing suite can still hide
 * a regression. Deterministic and diff-aware: it compares the working tree to the
 * commit the change forked from, so it needs a resolvable git base (else it fails
 * closed). See `no-deleted` for the removal side.
 */
export interface NoNewGate extends BaseGate {
  type: "no-new";
  glob: string;
  pattern: string;
  flags?: string;
  /** Extra globs to exclude (fixtures, the spec file itself). */
  ignore?: string[];
}

/**
 * Every file matching `glob` that existed at the base ref must still exist. Catches
 * an agent that makes a gate pass by deleting the tests (or docs, or migrations)
 * that were holding it. Diff-aware; fails closed without a resolvable git base.
 */
export interface NoDeletedGate extends BaseGate {
  type: "no-deleted";
  glob: string;
  /** Extra globs to exclude from the "must still exist" set. */
  ignore?: string[];
}

export type Gate =
  | FileExistsGate
  | FileContainsGate
  | AbsentGate
  | CommandGate
  | TrivyGate
  | EvidenceGate
  | InstructionSyncGate
  | NotEmptyGate
  | NoNewGate
  | NoDeletedGate;

/** Gate types that compare the working tree to a git base ref. */
export const DIFF_GATE_TYPES = new Set(["no-new", "no-deleted"]);

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

/**
 * Parse and validate spec text. Split out from {@link loadSpec} so a base-pinned
 * spec read straight from git (never touching disk) goes through the exact same
 * validation. `label` names the source in errors (a path, or `<ref>:<path>`).
 */
export function parseSpec(raw: string, label: string, isJson: boolean): Spec {
  const data = isJson ? JSON.parse(raw) : parseYaml(raw);
  if (!data || !Array.isArray(data.gates)) {
    throw new Error(`invalid spec ${label}: missing "gates" array`);
  }
  if (data.version != null) {
    if (typeof data.version !== "number" || !Number.isInteger(data.version)) {
      throw new Error(`invalid spec ${label}: "version" must be an integer`);
    }
    if (data.version > SPEC_VERSION) {
      console.warn(
        `skillgate: spec ${label} declares version ${data.version} but this build understands up to ${SPEC_VERSION} — upgrade skillgate; some gates may be misread`,
      );
    }
  }
  return data as Spec;
}

export function loadSpec(specPath: string): Spec {
  return parseSpec(fs.readFileSync(specPath, "utf8"), specPath, specPath.endsWith(".json"));
}

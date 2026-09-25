import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Conditions under which a gate applies. Every listed condition must hold; within
 * a list, any entry may match. A gate whose condition is not met is reported as
 * `skipped`. When a condition cannot be decided (no command, no git base, no
 * branch), the gate runs: an unknown never skips enforcement.
 */
export interface GateWhen {
  /** Finish-line command prefixes this gate is required for (structural match). */
  command?: string[];
  /** Globs; the gate runs only if a file matching one changed versus the base ref. */
  changed?: string[];
  /** Branch globs (`main`, `release/*`); the gate runs only on a matching branch. */
  branch?: string[];
}

/** A gate is one deterministic, machine-checkable condition over the workspace. */
export interface BaseGate {
  id: string;
  description?: string;
  when?: GateWhen;
}

/** Shared options for gates that read file contents with a regex. */
export interface ScanOptions {
  /** Largest file (bytes) a pattern gate will read. Larger files fail the gate. Default 10 MiB. */
  maxBytes?: number;
}

/** Shared option for glob-driven gates. */
export interface GlobOptions {
  /**
   * Allow the glob to match no files. Default false: a glob that matches nothing
   * fails the gate, because a typo'd glob would otherwise pass forever as a no-op.
   */
  allowEmpty?: boolean;
}

/** Every listed path must exist. */
export interface FileExistsGate extends BaseGate {
  type: "file-exists";
  file: string | string[];
}

/** A file must contain a regex match (required section, exact phrase, ...). */
export interface FileContainsGate extends BaseGate, ScanOptions {
  type: "file-contains";
  file: string;
  pattern: string;
  flags?: string;
}

/** A regex must NOT appear in any matched file (secret scrub, stray TODOs, ...). */
export interface AbsentGate extends BaseGate, ScanOptions, GlobOptions {
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
export interface NoNewGate extends BaseGate, ScanOptions, GlobOptions {
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
export interface NoDeletedGate extends BaseGate, GlobOptions {
  type: "no-deleted";
  glob: string;
  /** Extra globs to exclude from the "must still exist" set. */
  ignore?: string[];
}

/**
 * The count of lines matching `pattern` across `glob` must not DECREASE versus the
 * base ref. The removal side of `no-new`: catches an agent that makes a suite pass
 * by deleting test cases inside files that still exist (`it(`, `test(`,
 * `def test_`). Diff-aware; fails closed without a resolvable git base.
 */
export interface NoFewerGate extends BaseGate, ScanOptions, GlobOptions {
  type: "no-fewer";
  glob: string;
  pattern: string;
  flags?: string;
  ignore?: string[];
}

/**
 * Every dependency declared in a manifest must be present in its lockfile. A
 * package an agent invented (or never installed) cannot have resolved into the
 * lockfile, so this catches hallucinated dependencies offline. Supports
 * package.json (package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml,
 * yarn.lock, bun.lock) and pyproject.toml (uv.lock, poetry.lock, pdm.lock).
 */
export interface DepsLockedGate extends BaseGate {
  type: "deps-locked";
  /** Manifest path(s). Default: every supported manifest at the workspace root. */
  manifest?: string | string[];
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
  | NoDeletedGate
  | NoFewerGate
  | DepsLockedGate;

/** Gate types that compare the working tree to a git base ref. */
export const DIFF_GATE_TYPES = new Set(["no-new", "no-deleted", "no-fewer"]);

export interface Spec {
  /**
   * Spec format version. Optional and backward-compatible: an omitted version is
   * treated as the current format. Bump only on a breaking change to the schema;
   * skillgate fails closed when a spec declares a newer version, so an older CLI
   * cannot silently skip enforcement it does not understand.
   */
  version?: number;
  name?: string;
  /** Commands that count as crossing the finish line (structural shell matching). */
  finishLine?: string[];
  /** Maximum wall-clock budget for one complete gate run. */
  timeout?: number;
  gates: Gate[];
}

/** The spec format version this build understands. See docs/compatibility.md. */
export const SPEC_VERSION = 1;

/** Default minimum entries for `not-empty` gate. */
export const DEFAULT_NOT_EMPTY_MIN = 1;

/** Default timeout for command gates (30 seconds). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/** Default wall-clock budget for a complete run (5 minutes). */
export const DEFAULT_RUN_TIMEOUT_MS = 300_000;

/** Default per-file read cap for pattern gates (10 MiB). */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export const DEFAULT_SPEC_PATHS = [
  ".skillgate/done.yaml",
  ".skillgate/done.yml",
  ".skillgate.yaml",
  ".skillgate.yml",
  ".skillgate.json",
];

/** Workspace root implied by a spec path. */
export function specRoot(specPath: string): string {
  const parent = path.dirname(specPath);
  return path.basename(parent) === ".skillgate" ? path.dirname(parent) : parent;
}

/**
 * Find the nearest policy from `dir` upward. Discovery stops at the current Git
 * worktree root, so a nested checkout can never inherit policy from its parent.
 */
export function findSpecPath(dir: string): string | null {
  let current = path.resolve(dir);
  try {
    if (fs.statSync(current).isFile()) current = path.dirname(current);
  } catch {
    return null;
  }
  while (true) {
    for (const p of DEFAULT_SPEC_PATHS) {
      const full = path.join(current, p);
      if (fs.existsSync(full)) return full;
    }
    const parent = path.dirname(current);
    if (fs.existsSync(path.join(current, ".git")) || parent === current) return null;
    current = parent;
  }
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown, where: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as UnknownRecord;
}

function noUnknown(value: UnknownRecord, allowed: string[], where: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${where} has unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
}

function nonEmptyString(value: unknown, where: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where} must be a non-empty string`);
}

function stringArray(value: unknown, where: string, allowEmpty = false): asserts value is string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${where} must be ${allowEmpty ? "an" : "a non-empty"} array of strings`);
  }
}

function positiveInteger(value: unknown, where: string): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${where} must be a positive integer`);
}

function optionalString(value: unknown, where: string): void {
  if (value != null && typeof value !== "string") throw new Error(`${where} must be a string`);
}

function optionalNonEmptyString(value: unknown, where: string): void {
  if (value != null) nonEmptyString(value, where);
}

function optionalStringArray(value: unknown, where: string): void {
  if (value != null) stringArray(value, where, true);
}

function validateRegex(pattern: unknown, flags: unknown, where: string): void {
  nonEmptyString(pattern, `${where}.pattern`);
  optionalString(flags, `${where}.flags`);
  try {
    new RegExp(pattern, typeof flags === "string" ? flags : "");
  } catch (error: any) {
    throw new Error(`${where} has invalid regex: ${error.message}`);
  }
}

function validateWhen(value: unknown, where: string): void {
  if (value == null) return;
  const when = asRecord(value, where);
  noUnknown(when, ["command", "changed", "branch"], where);
  if (Object.keys(when).length === 0) throw new Error(`${where} must set at least one of command, changed, branch`);
  for (const key of ["command", "changed", "branch"]) {
    if (when[key] != null) stringArray(when[key], `${where}.${key}`);
  }
}

function validateGate(value: unknown, index: number): void {
  const where = `gates[${index}]`;
  const gate = asRecord(value, where);
  nonEmptyString(gate.id, `${where}.id`);
  nonEmptyString(gate.type, `${where}.type`);
  optionalString(gate.description, `${where}.description`);
  validateWhen(gate.when, `${where}.when`);
  const base = ["id", "type", "description", "when"];
  const allow = (...fields: string[]) => noUnknown(gate, [...base, ...fields], where);
  const timeout = () => { if (gate.timeout != null) positiveInteger(gate.timeout, `${where}.timeout`); };
  const maxBytes = () => { if (gate.maxBytes != null) positiveInteger(gate.maxBytes, `${where}.maxBytes`); };
  const allowEmpty = () => {
    if (gate.allowEmpty != null && typeof gate.allowEmpty !== "boolean") throw new Error(`${where}.allowEmpty must be a boolean`);
  };
  switch (gate.type) {
    case "file-exists":
      allow("file");
      if (typeof gate.file !== "string") stringArray(gate.file, `${where}.file`);
      else nonEmptyString(gate.file, `${where}.file`);
      break;
    case "file-contains":
      allow("file", "pattern", "flags", "maxBytes");
      nonEmptyString(gate.file, `${where}.file`);
      validateRegex(gate.pattern, gate.flags, where);
      maxBytes();
      break;
    case "absent":
    case "no-new":
    case "no-fewer":
      allow("glob", "pattern", "flags", "ignore", "maxBytes", "allowEmpty");
      nonEmptyString(gate.glob, `${where}.glob`);
      validateRegex(gate.pattern, gate.flags, where);
      optionalStringArray(gate.ignore, `${where}.ignore`);
      maxBytes();
      allowEmpty();
      break;
    case "command":
      allow("run", "timeout");
      nonEmptyString(gate.run, `${where}.run`);
      timeout();
      break;
    case "trivy": {
      allow("target", "trivy", "scanners", "severity", "sbom", "ignoreUnfixed", "timeout");
      optionalNonEmptyString(gate.target, `${where}.target`);
      optionalNonEmptyString(gate.trivy, `${where}.trivy`);
      if (gate.scanners != null) {
        stringArray(gate.scanners, `${where}.scanners`);
        if (gate.scanners.some((item) => !["vuln", "secret"].includes(item))) throw new Error(`${where}.scanners contains an unsupported scanner`);
      }
      if (gate.severity != null) {
        stringArray(gate.severity, `${where}.severity`);
        if (gate.severity.some((item) => !["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(item))) {
          throw new Error(`${where}.severity contains an unsupported severity`);
        }
      }
      for (const field of ["sbom", "ignoreUnfixed"]) {
        if (gate[field] != null && typeof gate[field] !== "boolean") throw new Error(`${where}.${field} must be a boolean`);
      }
      timeout();
      break;
    }
    case "evidence":
      allow("file");
      nonEmptyString(gate.file, `${where}.file`);
      break;
    case "instruction-sync":
      allow("threshold");
      if (gate.threshold != null && (typeof gate.threshold !== "number" || !Number.isFinite(gate.threshold) || gate.threshold < 0 || gate.threshold > 1)) {
        throw new Error(`${where}.threshold must be between 0 and 1`);
      }
      break;
    case "not-empty":
      allow("path", "min");
      nonEmptyString(gate.path, `${where}.path`);
      if (gate.min != null) positiveInteger(gate.min, `${where}.min`);
      break;
    case "no-deleted":
      allow("glob", "ignore", "allowEmpty");
      nonEmptyString(gate.glob, `${where}.glob`);
      optionalStringArray(gate.ignore, `${where}.ignore`);
      allowEmpty();
      break;
    case "deps-locked":
      allow("manifest");
      if (gate.manifest != null) {
        if (typeof gate.manifest === "string") nonEmptyString(gate.manifest, `${where}.manifest`);
        else stringArray(gate.manifest, `${where}.manifest`);
      }
      break;
    default:
      throw new Error(`${where}.type is unsupported: ${gate.type}`);
  }
}

function validateSpec(value: unknown): asserts value is Spec {
  const spec = asRecord(value, "spec");
  noUnknown(spec, ["version", "name", "finishLine", "timeout", "gates"], "spec");
  if (spec.version != null && (!Number.isInteger(spec.version) || Number(spec.version) < 1)) {
    throw new Error(`spec.version must be a positive integer`);
  }
  optionalString(spec.name, "spec.name");
  if (spec.finishLine != null) stringArray(spec.finishLine, "spec.finishLine", true);
  if (spec.timeout != null) positiveInteger(spec.timeout, "spec.timeout");
  if (!Array.isArray(spec.gates) || spec.gates.length === 0) throw new Error(`spec.gates must be a non-empty array`);
  spec.gates.forEach(validateGate);
  const ids = spec.gates.map((gate: any) => gate.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new Error(`spec.gates contains duplicate id: ${duplicate}`);
}

/**
 * Parse and validate spec text. Split out from {@link loadSpec} so a base-pinned
 * spec read straight from git (never touching disk) goes through the exact same
 * validation. `label` names the source in errors (a path, or `<ref>:<path>`).
 */
export function parseSpec(raw: string, label: string, isJson: boolean): Spec {
  let data: unknown;
  try {
    data = isJson ? JSON.parse(raw) : parseYaml(raw);
    validateSpec(data);
    if (data.version != null && data.version > SPEC_VERSION) {
      throw new Error(`spec.version ${data.version} is newer than supported version ${SPEC_VERSION}; upgrade skillgate`);
    }
  } catch (error: any) {
    throw new Error(`invalid spec ${label}: ${error.message}`);
  }
  return data;
}

export function loadSpec(specPath: string): Spec {
  return parseSpec(fs.readFileSync(specPath, "utf8"), specPath, specPath.endsWith(".json"));
}

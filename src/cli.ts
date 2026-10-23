#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findSpecPath, loadSpec, parseSpec, specRoot, workspaceRoot, DEFAULT_SPEC_PATHS, DEFAULT_PHASE_FILE, DEFAULT_RUN_TIMEOUT_MS, type Spec, type PhaseGate } from "./spec.js";
import { runGates, decideCommand, decideTool, currentPhase, evaluatePhase, gatesForCommand, type GateResult, type RunResult } from "./core.js";
import { appendLog, logPath, logPathProblem, summarizeLog, toFailed, type LogRecord } from "./log.js";
import { checkDrift, driftDiffs, DEFAULT_THRESHOLD, setCanonical } from "./drift.js";
import { runSync } from "./link.js";
import { runScaffold, templateHelp } from "./scaffold.js";
import { doctor, installIntegration, INTEGRATION_TARGETS, STOP_TARGETS, type IntegrationTarget } from "./integrations.js";
import { analyzeCommand } from "./command.js";
import { reviewSnapshot } from "./review.js";
import { EVALUATOR_VERSION, cacheDisabledReason, receiptPathIsInput, readCachedResult, runSnapshot, verifyReceipt, writeCachedResult, writeReceipt } from "./receipt.js";
import { resolveBaseRef, mergeBase, readFileAtRef, repoRelativePath, repoRoot, isClean } from "./git.js";
import {
  createPrivatePassProof,
  generateKeyFiles,
  loadPrivateKey,
  loadPublicKey,
  parsePrivatePassProof,
  policyHash,
  verifyPrivatePassProof,
} from "./zk.js";

const C = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};
const useColor = process.stdout.isTTY;
const c = (code: string, s: string) => (useColor ? code + s + C.reset : s);

const EXAMPLE = `# yaml-language-server: $schema=https://raw.githubusercontent.com/renezander030/skillgate/master/schema/done.schema.json
# skillgate — definition of done
# Docs: https://github.com/renezander030/skillgate
name: definition-of-done

# Commands that count as crossing the finish line (structural prefix match).
finishLine:
  - "git commit"
  - "git push"
  - "npm publish"

gates:
  # Every agent instruction file must stay in sync with the canonical one.
  # Run \`skillgate sync\` to sync; \`skillgate diff-instructions\` to see drift.
  - id: instruction-sync
    description: AI agent instruction files are in sync
    type: instruction-sync

  - id: tests-pass
    description: Test suite passes
    type: command
    run: "npm test --silent"

  - id: no-stray-todos
    description: No TODO or FIXME comment left in source
    type: absent
    glob: "src/**/*.{ts,js}"
    pattern: '(//|#)\\s*(TODO|FIXME)'

  - id: no-secrets
    description: No obvious secrets committed
    type: absent
    glob: "**/*.{ts,js,json,md,yaml,yml,env}"
    pattern: 'ghp_[A-Za-z0-9]{36}|sk_live_[A-Za-z0-9]{16,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'
    ignore: [".skillgate/**"]

  # Evidence gate: the agent must write an evidence file before crossing the
  # finish line. Run \`skillgate scaffold\` to generate evidence templates.
  # - id: tests-ran
  #   description: Agent saved test output before committing
  #   type: evidence
  #   file: .skillgate/evidence/test-output.txt
`;

const HELP = `skillgate — deterministic finish-line gates for AI coding agents

Usage:
  skillgate audit                    one-shot read-only audit of this repo (no config needed)
  skillgate check [spec]             run gates, exit 1 if any fail
  skillgate verify-patch             evaluate an agent's patch in a network-off clone; block apply until your DoD passes
  skillgate verify-apply             land the verified patch into the real repo (only after verify-patch passes)
  skillgate verify-receipt <file>    check a receipt matches these files and policy and records a pass
  skillgate zk-keygen                create a private BBS signing key and shareable public key
  skillgate zk-policy-id [spec]      print the stable hash a verifier should pin
  skillgate zk-prove [spec]          prove PASS while hiding private repo and gate details
  skillgate zk-verify <proof>        verify a private pass proof against pinned inputs
  skillgate fhe-metrics              add private repo counts while they stay encrypted
  skillgate gate                     allow/block one command (any harness); exit 2 = block
  skillgate gate --event stop        block an agent from ending its turn while gates fail
  skillgate phase [<id>]             show phase status, or move to <id> if its gates pass
  skillgate init [--preset <name>]   write an example .skillgate/done.yaml (presets: no-secrets, regression)
  skillgate review-snapshot          print the snapshot to bind an optional review report to
  skillgate install <target|all>     install agent hooks (claude-code, codex, copilot-cli, gemini-cli,
                                     cursor, opencode), github-actions, or pre-commit enforcement
  skillgate doctor <target|all>      verify policy discovery and one or more integrations
  skillgate explain --command <cmd>  show structural finish-line matching without running gates
  skillgate explain --commands <f>   replay a command corpus (lines or a decision log; - = stdin)
  skillgate log [file]               summarize the decision log: blocks per gate and command
  skillgate scaffold [--template]    generate .skillgate/evidence/ with stack templates
  skillgate drift                    report AI instruction-file drift, exit 1 if drifted
  skillgate diff-instructions        show line-level diff between drifted instruction files
  skillgate canonical <file>         set which file is the canonical instruction source
  skillgate sync                     make AGENTS.md canonical and link the rest
  skillgate sync --create <tools>    also create pointer files for tools without one (claude-code,...)
  skillgate <command> --help         one command's usage and flags, without running it
  skillgate --version

Flags:
  --json                   machine-readable output (check, gate, drift, verify-receipt)
  --cwd <dir>              run against another directory
  --pin                    check/gate: read the spec from the base ref, not the
                           working tree, so a change can't loosen its own gate
  --base <ref>             check/gate: ref for diff-aware gates (no-new, no-deleted) and, with
                           --pin, the pinned spec. Default: SKILLGATE_BASE or origin/HEAD
  --command "<cmd>"        gate: the command to judge (else read from stdin);
                           check: evaluate gates as required for this command (when.command)
  --format <fmt>           check: github (workflow annotations on failures and a job summary);
                           gate: text, json, cursor, gemini, or claude-stop hook protocol
  --event stop             gate: judge the agent's Stop event instead of a command
  --tool <name>            gate: judge an agent tool call (gatedTools) instead of a command
  --gate <id>              phase: which phase gate, when the spec has more than one
  --stop                   install: also register the Stop hook (claude-code, codex, copilot-cli)
  --timeout <ms>           check/gate: cap the complete gate run (overrides spec timeout)
  --cache                  check: reuse a passing result only for the exact repo snapshot
  --receipt <file>         check: write a machine-readable execution receipt
  --allow-on-error         gate: allow instead of fail-closed if evaluation errors
  --log <file>             check/gate: append each verdict as a JSON line (or SKILLGATE_LOG);
                           keep it outside the worktree or under .git/
  --threshold <0..1>       drift: similarity required to count as in sync (default 0.95)
  --dry-run                sync: show what would change without writing
  --symlink                sync: use symlinks instead of pointer files and copies
  --update-agents          scaffold: update AGENTS.md/CLAUDE.md with evidence workflow
  --private-key <file>     zk-keygen/zk-prove: BBS private key file
  --public-key <file>      zk-keygen/zk-verify: BBS public key file
  --challenge <text>       zk-prove/zk-verify: verifier-provided anti-replay challenge
  --expect-policy <hash>   zk-verify: expected policy hash from zk-policy-id
  --out <file>             zk-prove: proof bundle path

Experimental encrypted fleet totals:
  skillgate fhe-metrics help         show the private aggregation walkthrough

Templates (scaffold --template):
${templateHelp()}`;

function help(): void {
  console.log(HELP);
}

/**
 * One command's usage lines and the flags that name it, cut from the main help, so
 * \`skillgate <command> --help\` explains the command instead of running it.
 */
function commandHelp(command: string): string | null {
  const usage = helpEntries("Usage:", "  skillgate ").filter(([first]) => first === `  skillgate ${command}` || first.startsWith(`  skillgate ${command} `));
  if (!usage.length) return null;
  const names = (entry: string[]) => entry.flatMap((line) => {
    const text = line.startsWith("  --") ? line.replace(/^ {2}--\S+(?: <[^>]+>| "[^"]+"| \S+)?\s+/, "") : line.trim();
    const prefix = /^([a-z-]+(?:\/[a-z-]+)*)(?: [a-z-]+)?:/.exec(text)?.[1].split("/") ?? [];
    const listed = /\(([a-z-]+(?:, [a-z-]+)+)\)/.exec(text)?.[1].split(", ") ?? [];
    return [...prefix, ...listed];
  });
  const own = helpEntries("Flags:", "  --").filter((entry) => entry[0].startsWith("  --cwd ") || names(entry).includes(command));
  return `Usage:\n${usage.flat().join("\n")}${own.length ? `\n\nFlags:\n${own.flat().join("\n")}` : ""}`;
}

/** The entries of one help section: each line starting with `start`, with its continuation lines. */
function helpEntries(heading: string, start: string): string[][] {
  const from = HELP.indexOf(`${heading}\n`) + heading.length + 1;
  const entries: string[][] = [];
  for (const line of HELP.slice(from, HELP.indexOf("\n\n", from)).split("\n")) {
    if (line.startsWith(start)) entries.push([line]);
    else entries.at(-1)?.push(line);
  }
  return entries;
}

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === "--version" || cmd === "-v") {
  console.log(EVALUATOR_VERSION);
  process.exit(0);
}
if (!cmd || (cmd === "help" && !args[1]) || cmd === "--help" || cmd === "-h") {
  help();
  process.exit(0);
}

/** Commands that hand their arguments to another program, which answers --help itself. */
const FORWARDED = new Set(["fhe-metrics", "verify-patch", "verify-apply"]);
const helpFor = cmd === "help" ? args[1] : !FORWARDED.has(cmd) && (args.includes("--help") || args.includes("-h")) ? cmd : undefined;
if (helpFor) {
  const text = commandHelp(helpFor);
  if (!text) {
    console.error(`unknown command: ${helpFor}\n`);
    help();
    process.exit(2);
  }
  console.log(text);
  process.exit(0);
}

if (cmd === "fhe-metrics") {
  const helper = fileURLToPath(new URL("../../contrib/fhe-metrics", import.meta.url));
  const forwarded = args.slice(1);
  const cwdIndex = forwarded.indexOf("--cwd");
  let callerCwd = process.cwd();
  if (cwdIndex >= 0) {
    const requested = forwarded[cwdIndex + 1];
    if (!requested || requested.startsWith("--")) {
      console.error("skillgate: fhe-metrics --cwd requires a directory");
      process.exit(2);
    }
    callerCwd = path.resolve(requested);
    forwarded.splice(cwdIndex, 2);
  }
  let buildDir = "";
  try {
    buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-fhe-metrics-"));
    const binary = path.join(buildDir, process.platform === "win32" ? "fhe-metrics.exe" : "fhe-metrics");
    const build = spawnSync("go", ["build", "-o", binary, "."], {
      cwd: helper,
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (build.error) {
      const detail = (build.error as NodeJS.ErrnoException).code === "ENOENT"
        ? "Go 1.25+ is required for this optional encrypted-computation preview"
        : build.error.message;
      console.error(`skillgate: could not build fhe-metrics: ${detail}`);
      process.exitCode = 2;
    } else if (build.status !== 0) {
      process.exitCode = 2;
    } else {
      const child = spawnSync(binary, forwarded, {
        cwd: helper,
        env: { ...process.env, SKILLGATE_FHE_CALLER_CWD: callerCwd },
        stdio: "inherit",
      });
      if (child.error) {
        console.error(`skillgate: could not start fhe-metrics: ${child.error.message}`);
        process.exitCode = 2;
      } else {
        process.exitCode = child.status ?? 1;
      }
    }
  } catch (error: any) {
    console.error(`skillgate: could not prepare fhe-metrics: ${error.message}`);
    process.exitCode = 2;
  } finally {
    if (buildDir) fs.rmSync(buildDir, { recursive: true, force: true });
  }
  process.exit(process.exitCode ?? 1);
}

const json = args.includes("--json");
const cwdArg = option("--cwd");
const cwd = cwdArg != null ? path.resolve(cwdArg) : process.cwd();

const updateAgents = args.includes("--update-agents");

const baseArg = option("--base");
// Pinning is a deliberate opt-in and CLI/env-only — never a spec field, so a spec
// can't grant itself immunity. `--pin` reads the spec from the base ref; `--base`
// only names which ref (used for diff-aware gates too), it does not pin on its own.
const pin = args.includes("--pin");

function die(code: number, msg: string): never {
  console.error(c(C.red, `skillgate: ${msg}`));
  process.exit(code);
}

interface Resolved {
  spec: Spec;
  /** Workspace the policy is rooted in (the active worktree, not its parent checkout). */
  workspace: string;
  /** merge-base ref diff-aware gates compare against, if one could be resolved. */
  gateBase?: string;
  /** ref the spec itself was pinned to (only set in --pin mode). */
  pinnedTo?: string;
}

/**
 * Load the spec and the git base the gates judge against. Without `--pin` the spec
 * comes from the working tree (a diff base is still resolved best-effort so
 * diff-aware gates work). With `--pin` the spec is read from the base ref itself —
 * so the change under review cannot edit or delete the policy it is judged by —
 * and anything that prevents that (no base, no pinned spec) fails closed.
 */
function resolveSpecAndBase(specPath: string | null): Resolved {
  // A spec path that does not exist is no hint (with --pin it may be deleted in the change under review).
  const specPathHint = specPath && fs.existsSync(specPath) ? specPath : null;
  const workspace = workspaceRoot(specPathHint, cwd);
  const rawBase = resolveBaseRef(workspace, baseArg);
  if (!rawBase && (baseArg?.trim() || process.env.SKILLGATE_BASE?.trim())) {
    throw new Error("requested base ref cannot be resolved — refusing to use a different baseline");
  }
  const gateBase = rawBase ? mergeBase(workspace, rawBase) : undefined;

  if (!pin) {
    if (!specPathHint) throw new Error("no spec found — run `skillgate init` or pass a path");
    return { spec: loadSpec(specPathHint), workspace, gateBase };
  }

  if (!rawBase) {
    throw new Error("--pin: cannot resolve a base ref (set SKILLGATE_BASE or pass --base <ref>) — refusing to run unpinned (fail-closed)");
  }
  const root = repoRoot(workspace);
  if (!root) throw new Error("--pin: not a git repository (fail-closed)");
  const pinnedRel = specPathHint ? repoRelativePath(workspace, specPathHint) : null;
  if (specPathHint && !pinnedRel) throw new Error("--pin: spec is outside the active Git worktree (fail-closed)");
  const rels = pinnedRel ? [pinnedRel] : DEFAULT_SPEC_PATHS;
  for (const rel of rels) {
    const raw = readFileAtRef(workspace, gateBase!, rel);
    if (raw != null) {
      const label = `${gateBase!.slice(0, 12)}:${rel}`;
      return { spec: parseSpec(raw, label, rel.endsWith(".json")), workspace, gateBase, pinnedTo: gateBase };
    }
  }
  throw new Error(`--pin: no committed spec at ${gateBase!.slice(0, 12)} (looked for ${rels.join(", ")}) — commit your .skillgate/done.yaml to the base branch first (fail-closed)`);
}

/** Shell tool names across agents; their calls are judged as commands by `finishLine`. */
const SHELL_TOOLS = new Set(["Bash", "bash", "run_shell_command", "shell", "local_shell", "exec_command"]);

/** Read a hook payload from stdin: parsed JSON when it is JSON, else the raw text. */
function readStdinPayload(): { raw: string; data?: any } {
  if (process.stdin.isTTY) return { raw: "" };
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8").trim();
  } catch {
    return { raw: "" };
  }
  if (raw.startsWith("{")) {
    try {
      return { raw, data: JSON.parse(raw) };
    } catch {
      /* not JSON after all — treat as a raw command */
    }
  }
  return { raw };
}

/** The command an agent is about to run, from any supported hook payload or raw stdin. */
function commandFromPayload(payload: { raw: string; data?: any }): string {
  const o = payload.data;
  if (!o) return payload.raw;
  return String(o?.tool_input?.command ?? o?.command ?? o?.params?.command ?? o?.tool_input?.cmd ?? payload.raw);
}

/** The first argument after the command, unless it is a flag. */
function positional(): string | undefined {
  return args[1] && !args[1].startsWith("-") ? args[1] : undefined;
}

/** `positional()` resolved against `--cwd`, or null without one. */
function positionalPath(): string | null {
  const arg = positional();
  return arg ? path.resolve(cwd, arg) : null;
}

/** The value after `name`, or undefined when the flag is absent. A flag with no value (last, or followed by another `--flag`) is a usage error. */
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value == null || value.startsWith("--")) die(2, `${name} requires a value`);
  return value;
}

/** `--timeout <ms>` as the run budget override; throws unless it is a positive integer. */
function timeoutOption(): number | undefined {
  const value = option("--timeout");
  if (value == null) return undefined;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < 1) throw new Error("--timeout must be a positive integer in milliseconds");
  return ms;
}

/** `--threshold <0..1>` for drift checks; a value that is not a number is NaN, as given. */
function thresholdOption(): number {
  const value = option("--threshold");
  return value != null ? Number(value) : DEFAULT_THRESHOLD;
}

/** Add each missing line to an ignore file, keeping what is there (created when absent). */
function ensureIgnored(file: string, entries: string[]): void {
  const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const missing = entries.filter((entry) => !old.split(/\r?\n/).includes(entry));
  if (missing.length) fs.appendFileSync(file, (old && !old.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
}

const DEFAULT_ZK_PRIVATE_KEY = path.join(cwd, ".skillgate", "zk-private-key.json");

function zkSpecPath(): string | null {
  return positionalPath() ?? findSpecPath(cwd);
}

function resolvedZKSpec(): Resolved {
  const specPath = zkSpecPath();
  if (!pin && (!specPath || !fs.existsSync(specPath))) {
    die(2, "no spec found — run `skillgate init` or pass a path immediately after the command");
  }
  return resolveSpecAndBase(specPath);
}

/** Append a verdict to the opt-in decision log; never changes the verdict. */
function recordDecision(workspace: string, record: Omit<LogRecord, "ts" | "workspace">): void {
  const file = logPath(option("--log"), cwd);
  if (!file) return;
  const problem = logPathProblem(file, workspace) ?? appendLog(file, { ts: new Date().toISOString(), workspace, ...record });
  if (problem) console.error(c(C.dim, `skillgate: ${problem}`));
}

function printResults(results: GateResult[]): void {
  for (const r of results) {
    const mark = r.status === "skipped" ? c(C.dim, "−") : r.status === "warn" ? c(C.yellow, "!") : r.ok ? c(C.green, "✓") : c(C.red, "✗");
    console.log(`  ${mark} ${r.id}  ${c(C.dim, r.reason)}`);
  }
}

function applied(result: RunResult): number {
  return result.results.filter((r) => r.status !== "skipped").length;
}

/** How `check` counts a failing run: unmet gates out of every gate in the policy. */
function unmet(result: RunResult): string {
  return `${result.failed.length} of ${result.results.length} gates unmet`;
}

/** Escape a GitHub workflow-command value (`property` also escapes `:` and `,`). */
function ghEscape(value: string, property = false): string {
  let out = value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  if (property) out = out.replace(/:/g, "%3A").replace(/,/g, "%2C");
  return out;
}

/** A gate verdict as a GitHub job summary: one table row per gate, failures first. */
function githubSummary(result: RunResult): string {
  const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const mark = (r: GateResult) => r.status === "skipped" ? "skipped" : r.status === "warn" ? "warning" : r.ok ? "pass" : "fail";
  const rows = [...result.failed, ...result.results.filter((r) => r.ok)].map((r) => `| ${mark(r)} | \`${cell(r.id)}\` | ${cell(r.reason)} |`);
  const verdict = result.passed ? `all ${applied(result)} gates passed` : unmet(result);
  return `### skillgate: ${verdict}\n\n| result | gate | reason |\n|---|---|---|\n${rows.join("\n")}\n`;
}

/** One `::error` annotation per failed gate, anchored to the file it names when known. */
function githubAnnotations(result: RunResult, workspace: string): string[] {
  return result.failed.map((f) => {
    const props = [`title=${ghEscape(`skillgate: ${f.id}`, true)}`];
    if (f.location) {
      const file = repoRelativePath(workspace, path.resolve(workspace, f.location.file)) ?? f.location.file;
      props.unshift(`file=${ghEscape(file, true)}`, ...(f.location.line ? [`line=${f.location.line}`] : []));
    }
    return `::error ${props.join(",")}::${ghEscape(f.reason)}`;
  });
}

if (cmd === "zk-keygen") {
  const privateFile = path.resolve(cwd, option("--private-key") ?? DEFAULT_ZK_PRIVATE_KEY);
  const publicFile = path.resolve(cwd, option("--public-key") ?? path.join(cwd, ".skillgate", "zk-public-key.json"));
  try {
    const publicKey = await generateKeyFiles(privateFile, publicFile);
    if (privateFile === DEFAULT_ZK_PRIVATE_KEY) ensureIgnored(path.join(cwd, ".skillgate", ".gitignore"), [path.basename(DEFAULT_ZK_PRIVATE_KEY)]);
    console.log(c(C.green, "✓ generated private-pass key pair"));
    console.log(`  key ID:  ${publicKey.key_id}`);
    console.log(`  private: ${privateFile} (keep secret; mode 0600)`);
    console.log(`  public:  ${publicFile} (share with verifiers)`);
    process.exit(0);
  } catch (error: any) {
    die(1, error.message);
  }
}

if (cmd === "zk-policy-id") {
  try {
    const resolved = resolvedZKSpec();
    console.log(policyHash(resolved.spec));
    process.exit(0);
  } catch (error: any) {
    die(2, error.message);
  }
}

if (cmd === "zk-prove") {
  const challenge = option("--challenge") ?? "";
  const privateFile = path.resolve(cwd, option("--private-key") ?? DEFAULT_ZK_PRIVATE_KEY);
  const outputFile = path.resolve(cwd, option("--out") ?? "skillgate-pass.proof.json");
  if (!challenge) die(2, "zk-prove requires a verifier-provided --challenge");
  try {
    const resolved = resolvedZKSpec();
    const result = runGates(resolved.spec, resolved.workspace, { baseRef: resolved.gateBase });
    if (!result.passed) {
      console.error(c(C.red, `✗ no proof: ${result.failed.length} of ${result.results.length} gates failed`));
      for (const failure of result.failed) console.error(c(C.dim, `    · ${failure.id}: ${failure.reason}`));
      process.exit(1);
    }
    const key = loadPrivateKey(privateFile);
    const proof = await createPrivatePassProof(resolved.spec, result, resolved.workspace, key, challenge);
    fs.writeFileSync(outputFile, JSON.stringify(proof, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    console.log(c(C.green, `✓ private pass proof created: ${outputFile}`));
    console.log(`  ${proof.proof_bytes} bytes in ${proof.prover_ms} ms; repo snapshot, gate details, reasons, and counts stayed private`);
    process.exit(0);
  } catch (error: any) {
    die(1, error.message);
  }
}

if (cmd === "zk-verify") {
  const proofArg = positional() ?? "";
  const publicArg = option("--public-key");
  const expectedPolicy = option("--expect-policy") ?? "";
  const challenge = option("--challenge") ?? "";
  if (!proofArg || !publicArg || !expectedPolicy || !challenge) {
    die(2, "usage: skillgate zk-verify <proof> --public-key <file> --expect-policy <hash> --challenge <text>");
  }
  try {
    const proof = parsePrivatePassProof(fs.readFileSync(path.resolve(cwd, proofArg), "utf8"));
    const publicKey = loadPublicKey(path.resolve(cwd, publicArg));
    await verifyPrivatePassProof(proof, publicKey, expectedPolicy, challenge);
    console.log(c(C.green, "✓ VALID: the pinned Skillgate signer attested PASS under the expected policy"));
    console.log("  private repo snapshot, gate details, reasons, and counts were not disclosed");
    process.exit(0);
  } catch (error: any) {
    die(1, `INVALID: ${error.message}`);
  }
}

/** Test files across JavaScript, TypeScript and Python layouts, for the regression preset. */
const TEST_FILES = "**/{*.test,*.spec,test_*,*_test}.{ts,tsx,js,jsx,mjs,cjs,py}";

/**
 * The regression preset: the gates an agent games most often to make a check pass.
 * Every glob may match nothing (a repository without tests or CI is not a failure),
 * and every diff gate needs a base ref (origin/HEAD or SKILLGATE_BASE).
 */
const REGRESSION_SPEC = `# yaml-language-server: $schema=https://raw.githubusercontent.com/renezander030/skillgate/master/schema/done.schema.json
name: regression
finishLine: ["git commit", "git push", "npm publish"]
gates:
  # No test case may disappear from a file that still exists.
  - id: tests-kept
    type: no-fewer
    glob: "${TEST_FILES}"
    pattern: '^\\s*(it|test)(\\.each\\b.*)?\\s*\\(|^\\s*(async\\s+)?def test_'
    allowEmpty: true
  # No test file may be deleted.
  - id: test-files-kept
    type: no-deleted
    glob: "${TEST_FILES}"
    allowEmpty: true
  # No new skipped, focused or disabled tests.
  - id: no-new-skips
    type: no-new
    glob: "${TEST_FILES}"
    pattern: '\\.(skip|only|todo)\\s*\\(|\\bx(it|test|describe)\\s*\\(|@pytest\\.mark\\.(skip|xfail)|@unittest\\.skip'
    allowEmpty: true
  # CI workflows and agent instruction files change only in a separate, reviewed commit.
  - id: ci-unchanged
    type: unchanged
    glob: ".github/workflows/**"
    allowEmpty: true
  - id: instructions-unchanged
    type: unchanged
    glob: "{AGENTS.md,CLAUDE.md,GEMINI.md,.github/copilot-instructions.md,.cursor/rules/**}"
    allowEmpty: true
`;

interface Preset {
  spec: string;
  /** What to tell the owner after writing the policy. */
  note: string;
  /** Files the policy needs beside it, written before it. */
  prepare?: (dir: string) => void;
}

/** `init --preset <name>`: ready-made policies. */
const PRESETS: Record<string, Preset> = {
  "no-secrets": {
    spec: `name: no-secrets
finishLine: ["git commit", "git push", "npm publish"]
gates:
  - id: no-secrets
    type: trufflehog
    timeout: 10000
    namesFile: .skillgate/forbidden-names.json
`,
    note: "Set local forbidden-names.json to a non-empty JSON array of server/domain/tenant names, or remove namesFile for credentials only.",
    prepare: (dir) => {
      const names = path.join(dir, "forbidden-names.json");
      if (!fs.existsSync(names)) fs.writeFileSync(names, "[]\n", { mode: 0o600 });
      ensureIgnored(path.join(cwd, ".gitignore"), ["/.skillgate/forbidden-names.json", "/.skillgate/scan-cache/"]);
    },
  },
  regression: {
    spec: REGRESSION_SPEC,
    note: "The diff gates compare against the base ref (origin/HEAD or SKILLGATE_BASE); without one they fail closed.",
  },
};

if (cmd === "init") {
  const name = option("--preset");
  const preset = name != null && Object.hasOwn(PRESETS, name) ? PRESETS[name] : undefined;
  if (name != null && !preset) die(2, `unknown preset; available: ${Object.keys(PRESETS).join(", ")}`);
  const dir = path.join(cwd, ".skillgate");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "done.yaml");
  if (fs.existsSync(target)) {
    console.error(`${path.relative(cwd, target)} already exists`);
    process.exit(1);
  }
  preset?.prepare?.(dir);
  fs.writeFileSync(target, preset?.spec ?? EXAMPLE);
  console.log(`wrote ${path.relative(cwd, target)} — edit it, then \`skillgate check\``);
  if (preset) console.log(preset.note);
  process.exit(0);
}

if (cmd === "review-snapshot") {
  try {
    const resolved = resolveSpecAndBase(findSpecPath(cwd));
    console.log(reviewSnapshot(resolved.spec, resolved.workspace, resolved.gateBase));
    process.exit(0);
  } catch {
    die(2, "cannot read policy or repository snapshot for review");
  }
}

function integrationTargets(value: string | undefined): IntegrationTarget[] {
  if (!value) die(2, `integration target required (${INTEGRATION_TARGETS.join(", ")}, or all)`);
  if (value === "all") return [...INTEGRATION_TARGETS];
  if (!(INTEGRATION_TARGETS as readonly string[]).includes(value)) {
    die(2, `unknown integration target: ${value} (${INTEGRATION_TARGETS.join(", ")}, or all)`);
  }
  return [value as IntegrationTarget];
}

if (cmd === "install") {
  const targets = integrationTargets(args[1]);
  const stop = args.includes("--stop");
  if (stop && !targets.some((target) => STOP_TARGETS.includes(target))) die(2, `--stop applies to the ${STOP_TARGETS.join(", ")} targets`);
  try {
    for (const target of targets) {
      const result = installIntegration(target, cwd, { stop });
      console.log(`${result.changed ? c(C.green, "✓") : c(C.dim, "·")} ${target}  ${result.detail} (${path.relative(cwd, result.file)})`);
    }
    process.exit(0);
  } catch (error: any) {
    die(2, error.message);
  }
}

if (cmd === "doctor") {
  const targets = integrationTargets(args[1]);
  const checks = doctor(cwd, targets);
  for (const check of checks) console.log(`${check.ok ? c(C.green, "✓") : c(C.red, "✗")} ${check.id}  ${c(C.dim, check.detail)}`);
  process.exit(checks.every((check) => check.ok) ? 0 : 1);
}

/** Commands from a corpus: one per line, or decision-log JSON lines (their `command`). */
function readCorpus(source: string): string[] {
  const text = source === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.resolve(cwd, source), "utf8");
  const commands: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("{")) {
      try {
        const record = JSON.parse(trimmed);
        if (typeof record?.command === "string" && record.command.trim() && !record.tool) commands.push(record.command.trim());
        continue;
      } catch {
        /* a command that starts with "{" */
      }
    }
    commands.push(trimmed);
  }
  return commands;
}

if (cmd === "explain") {
  const command = option("--command") ?? "";
  const corpus = option("--commands");
  if (!command && !corpus) die(2, "explain requires --command <cmd> or --commands <file|->");
  const specPath = findSpecPath(cwd);
  if (!specPath) die(2, "no spec found — run `skillgate init`");
  try {
    const spec = loadSpec(specPath);
    if (corpus) {
      const commands = readCorpus(corpus);
      const rows = commands.map((cmdText) => {
        const analysis = analyzeCommand(cmdText, spec.finishLine ?? []);
        return { command: cmdText, matched: analysis.matched, patterns: analysis.patterns, gates: analysis.matched ? gatesForCommand(spec, cmdText) : [] };
      });
      const gated = rows.filter((row) => row.matched);
      const byPattern = new Map<string, number>();
      for (const row of gated) for (const p of row.patterns) byPattern.set(p, (byPattern.get(p) ?? 0) + 1);
      if (json) {
        console.log(JSON.stringify({ finishLine: spec.finishLine ?? [], total: rows.length, gated: gated.length, byPattern: Object.fromEntries(byPattern), commands: rows }, null, 2));
      } else {
        for (const row of rows) {
          console.log(`${row.matched ? c(C.red, "MATCH   ") : c(C.dim, "no match")}  ${row.command}${row.matched ? c(C.dim, `  → ${row.gates.join(", ") || "no gates"}`) : ""}`);
        }
        console.log("");
        console.log(`${gated.length} of ${rows.length} commands cross the finish line` + (byPattern.size ? c(C.dim, ` (${[...byPattern].map(([p, n]) => `${p}: ${n}`).join(", ")})`) : ""));
      }
      process.exit(0);
    }
    const analysis = analyzeCommand(command, spec.finishLine ?? []);
    const gates = analysis.matched ? gatesForCommand(spec, command) : [];
    if (json) {
      console.log(JSON.stringify({ command, finishLine: spec.finishLine ?? [], ...analysis, gates }, null, 2));
    } else {
      console.log(`${analysis.matched ? c(C.red, "MATCH") : c(C.green, "NO MATCH")} · ${command}`);
      console.log(`  policy: ${path.relative(cwd, specPath)}`);
      console.log(`  matched: ${analysis.patterns.length ? analysis.patterns.join(", ") : "none"}`);
      if (analysis.matched) console.log(`  gates: ${gates.length ? gates.join(", ") : "none"}`);
      for (const segment of analysis.segments) console.log(`  segment: ${segment.normalized.join(" ") || "(empty)"}`);
    }
    process.exit(0);
  } catch (error: any) {
    die(2, error.message);
  }
}

if (cmd === "log") {
  const file = positionalPath() ?? logPath(undefined, cwd);
  if (!file) die(2, "usage: skillgate log <file> (or set SKILLGATE_LOG)");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error: any) {
    die(2, `cannot read ${file}: ${error.message}`);
  }
  const summary = summarizeLog(text);
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }
  console.log(`${c(C.bold, "skillgate log")} ${c(C.dim, `· ${summary.records} decisions${summary.first ? ` · ${summary.first} → ${summary.last}` : ""}${summary.malformed ? ` · ${summary.malformed} malformed lines skipped` : ""}`)}`);
  console.log(`  allowed ${summary.allowed} · blocked ${summary.blocked}${summary.errors ? ` (${summary.errors} on evaluation errors)` : ""}`);
  for (const [event, n] of Object.entries(summary.byEvent)) console.log(c(C.dim, `  ${event}: ${n.allowed} allowed, ${n.blocked} blocked`));
  if (summary.blockingGates.length) {
    console.log("\n  gates that blocked most:");
    for (const g of summary.blockingGates) console.log(`    ${String(g.count).padStart(4)}  ${g.id}`);
  }
  if (summary.blockedActions.length) {
    console.log("\n  blocked commands and tools:");
    for (const a of summary.blockedActions) console.log(`    ${String(a.count).padStart(4)}  ${a.action}`);
  }
  process.exit(0);
}

if (cmd === "audit") {
  // Zero-config, read-only: see what your agent could cut in this repo right now.
  // If there's no spec we evaluate against the built-in defaults WITHOUT writing
  // anything to the repo — an audit must not change the thing it audits.
  let specPath = findSpecPath(cwd);
  let usingDefaults = false;
  if (!specPath || !fs.existsSync(specPath)) {
    const tmp = path.join(os.tmpdir(), `skillgate-audit-${process.pid}.yaml`);
    fs.writeFileSync(tmp, EXAMPLE);
    specPath = tmp;
    usingDefaults = true;
  }

  let result;
  try {
    // Built-in defaults guess at globs; a default that matches nothing here is not a finding.
    result = runGates(loadSpec(specPath), usingDefaults ? cwd : specRoot(specPath), { allowEmptyGlobs: usingDefaults });
  } catch (e: any) {
    die(2, e.message);
  } finally {
    if (usingDefaults) {
      try { fs.unlinkSync(specPath); } catch { /* best effort */ }
    }
  }

  if (json) {
    console.log(JSON.stringify({ ...result, usingDefaults }, null, 2));
    process.exit(result.passed ? 0 : 1);
  }

  console.log(`${c(C.bold, "skillgate audit")} ${c(C.dim, "· " + (path.basename(cwd) || cwd))}`);
  console.log(
    c(C.dim, usingDefaults
      ? "  no .skillgate/done.yaml — auditing against built-in defaults"
      : `  using ${path.relative(cwd, specPath) || specPath}`),
  );
  console.log("");
  printResults(result.results);
  console.log("");
  if (result.passed) {
    console.log(c(C.green, `✓ all ${applied(result)} checks pass — nothing for your agent to cut here.`));
    process.exit(0);
  }
  console.log(
    c(C.red, `✗ ${result.failed.length} of ${result.results.length} checks would let your agent reach "done" unfinished: `) +
      result.failed.map((f) => f.id).join(", "),
  );
  console.log(c(C.dim, "→ Lock it in: `skillgate init`, then wire it into your agent — https://github.com/renezander030/skillgate#install"));
  process.exit(1);
}

if (cmd === "check") {
  const explicit = positionalPath();
  const specPath = explicit ?? findSpecPath(cwd);
  // Without --pin the working-tree spec must exist; with --pin it may have been
  // deleted in the change under review — resolveSpecAndBase reads it from the base.
  if (!pin && (!specPath || !fs.existsSync(specPath))) {
    console.error(c(C.red, "skillgate: no spec found") + " — run `skillgate init` or pass a path");
    process.exit(2);
  }

  const format = option("--format");
  if (format != null && format !== "github") die(2, `check --format supports: github`);
  const forCommand = option("--command");
  let result;
  let pinnedTo: string | undefined;
  let cacheHit = false;
  let cacheReason: string | undefined;
  let snapshot: string | undefined;
  let workspace = cwd;
  try {
    const r = resolveSpecAndBase(specPath);
    pinnedTo = r.pinnedTo;
    workspace = r.workspace;
    const timeoutMs = timeoutOption();
    cacheReason = args.includes("--cache") ? cacheDisabledReason(r.spec) : undefined;
    const cache = args.includes("--cache") && !cacheReason;
    const receipt = option("--receipt");
    const receiptFile = receipt ? path.resolve(cwd, receipt) : undefined;
    if (receiptFile && receiptPathIsInput(r.spec, r.workspace, receiptFile)) throw new Error("--receipt must not overwrite or exclude a gate input; choose an output outside the gates' paths/globs");
    const inputs = { timeoutMs, command: forCommand };
    if (cache || receipt) snapshot = runSnapshot(r.spec, r.workspace, r.gateBase, inputs, receiptFile);
    const cached = cache && snapshot ? readCachedResult(r.workspace, snapshot, r.spec) : null;
    if (cached) {
      result = cached;
      cacheHit = true;
    } else {
      result = runGates(r.spec, r.workspace, { baseRef: r.gateBase, timeoutMs, command: forCommand });
      if (snapshot && runSnapshot(r.spec, r.workspace, r.gateBase, inputs, receiptFile) !== snapshot) {
        const changed: GateResult = { id: "skillgate:snapshot", type: "snapshot", ok: false, status: "fail", reason: "workspace changed during evaluation; rerun checks against the final files" };
        result = { ...result, passed: false, results: [...result.results, changed], failed: [...result.failed, changed] };
      }
      if (cache && snapshot) writeCachedResult(r.workspace, snapshot, result);
    }
    if (receiptFile && snapshot) writeReceipt(receiptFile, snapshot, result, cacheHit ? "cache" : "executed", inputs);
    recordDecision(r.workspace, {
      via: "check",
      event: "check",
      decision: result.passed ? "allow" : "block",
      reason: result.passed ? `all ${applied(result)} applicable gates passed` : unmet(result),
      ...(forCommand != null ? { command: forCommand } : {}),
      failed: toFailed(result.failed),
      durationMs: result.durationMs,
    });
  } catch (e: any) {
    die(2, e.message);
  }

  if (json) {
    console.log(JSON.stringify({ ...result, pinnedTo, cacheHit, cacheDisabledReason: cacheReason, snapshot }, null, 2));
    process.exit(result.passed ? 0 : 1);
  }

  if (pinnedTo) {
    console.log(c(C.dim, `  policy pinned to ${pinnedTo.slice(0, 12)} (base ref) — this change cannot loosen it`));
  }
  if (cacheHit) console.log(c(C.dim, "  exact snapshot cache hit — reused prior passing receipt"));
  if (cacheReason) console.log(c(C.dim, `  ${cacheReason}`));
  printResults(result.results);
  console.log("");
  if (format === "github") {
    for (const line of githubAnnotations(result, workspace)) console.log(line);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
      try {
        fs.appendFileSync(summary, githubSummary(result));
      } catch (error: any) {
        console.error(c(C.dim, `skillgate: cannot write the job summary: ${error.message}`));
      }
    }
  }
  if (result.passed) {
    const skipped = result.results.length - applied(result);
    const warned = result.results.filter((r) => r.status === "warn").length;
    console.log(c(C.green, `✓ all ${applied(result)} gates passed`) + (skipped ? c(C.dim, ` (${skipped} skipped by when)`) : "") + (warned ? c(C.yellow, ` (${warned} warning${warned === 1 ? "" : "s"})`) : ""));
    process.exit(0);
  }
  console.log(
    c(C.red, `✗ ${unmet(result)}: `) +
      result.failed.map((f) => f.id).join(", "),
  );
  process.exit(1);
}

if (cmd === "verify-receipt") {
  const file = positionalPath();
  if (!file) die(2, "usage: skillgate verify-receipt <receipt> [--command <cmd>] [--timeout <ms>]");
  let verdict;
  try {
    const r = resolveSpecAndBase(findSpecPath(cwd));
    verdict = verifyReceipt(file, r.spec, r.workspace, r.gateBase, { timeoutMs: timeoutOption(), command: option("--command") });
  } catch (e: any) {
    die(2, e.message);
  }
  if (json) {
    console.log(JSON.stringify(verdict, null, 2));
  } else if (verdict.valid) {
    console.log(c(C.green, "✓ VALID") + ` · ${verdict.reason}`);
  } else {
    console.error(c(C.red, "✗ INVALID") + ` · ${verdict.reason}`);
  }
  process.exit(verdict.valid ? 0 : 1);
}

if (cmd === "drift") {
  const res = checkDrift(cwd, thresholdOption());

  if (json) {
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.drifted > 0 ? 1 : 0);
  }

  if (res.entries.length === 0) {
    console.log("no agent instruction files found");
    process.exit(0);
  }
  console.log(`canonical: ${c(C.bold, res.canonical)}\n`);
  for (const e of res.entries) {
    const mark = e.status === "drifted" ? c(C.red, "✗") : c(C.green, "✓");
    const pct = `${Math.round(e.similarity * 100)}%`;
    console.log(`  ${mark} ${e.tool.padEnd(16)} ${e.status.padEnd(10)} ${pct.padStart(4)}  ${c(C.dim, e.files.join(", "))}`);
  }
  console.log("");
  if (res.drifted === 0) {
    console.log(c(C.green, `✓ all ${res.entries.length} instruction files in sync`));
    process.exit(0);
  }
  console.log(c(C.red, `✗ ${res.drifted} of ${res.entries.length} instruction files drifted`) + ` — run \`skillgate sync\``);
  process.exit(1);
}

if (cmd === "sync") {
  const createAt = args.indexOf("--create");
  if (createAt >= 0 && (!args[createAt + 1] || args[createAt + 1].startsWith("--"))) die(2, "sync --create requires tool ids, e.g. claude-code,gemini-cli");
  const create = option("--create");
  const { lines } = runSync(cwd, {
    dryRun: args.includes("--dry-run"),
    symlink: args.includes("--symlink"),
    create: create?.split(",").map((id) => id.trim()).filter(Boolean),
  });
  for (const l of lines) console.log(l);
  process.exit(0);
}

if (cmd === "scaffold") {
  const template = option("--template") ?? "generic";
  try {
    const { lines } = runScaffold({ cwd, template, updateAgents });
    for (const l of lines) console.log(l);
    process.exit(0);
  } catch (e: any) {
    die(2, e.message);
  }
}

if (cmd === "diff-instructions") {
  const { result: res, diffs } = driftDiffs(cwd, thresholdOption());

  if (res.entries.length === 0) {
    console.log("no agent instruction files found");
    process.exit(0);
  }

  if (res.drifted === 0) {
    console.log(c(C.green, `✓ all ${res.entries.length} instruction files in sync with ${res.canonical}`));
    process.exit(0);
  }

  for (const { entry: e, diff } of diffs) {
    const pct = `${Math.round(e.similarity * 100)}%`;
    console.log(`\n${c(C.bold, e.tool)} — ${pct} similarity with ${c(C.bold, res.canonical)}`);
    console.log(c(C.dim, e.files.join(", ")));
    console.log(c(C.dim, "─".repeat(50)));
    console.log(diff);
  }
  process.exit(1);
}

if (cmd === "canonical") {
  const fileArg = args[1];
  if (!fileArg || fileArg.startsWith("-")) {
    console.error(c(C.red, "usage: skillgate canonical <file>"));
    process.exit(2);
  }
  const canonPath = path.resolve(cwd, fileArg);
  if (!fs.existsSync(canonPath)) {
    console.error(c(C.red, `file not found: ${fileArg}`));
    process.exit(2);
  }
  // drift, diff-instructions and instruction-sync compare every other file against it.
  setCanonical(cwd, canonPath);
  console.log(c(C.green, `✓ canonical instruction source set to ${path.relative(cwd, canonPath)}`));
  process.exit(0);
}

if (cmd === "verify-patch" || cmd === "verify-apply") {
  // Isolated patch evaluation: run skillgate's DoD gates inside a network-off clone
  // (pi-gate engine vendored under isolate/, driven by isolate/verify.mjs).
  const sub = cmd === "verify-patch" ? "run" : "apply";
  const engine = fileURLToPath(new URL("../../isolate/verify.mjs", import.meta.url));
  const child = spawnSync(process.execPath, [engine, sub, ...args.slice(1)], { stdio: "inherit" });
  process.exit(child.status ?? 1);
}

if (cmd === "phase") {
  // Stateless phases: the marker only names where the agent is. Moving to a phase
  // (and every gated action while in it) re-checks that phase's requirements live.
  const target = positional();
  const specPath = findSpecPath(cwd);
  if (!pin && !specPath) die(2, "no spec found — run `skillgate init`");
  let r: Resolved;
  try {
    r = resolveSpecAndBase(specPath);
  } catch (e: any) {
    die(2, e.message);
  }
  const phaseGates = r.spec.gates.filter((g): g is PhaseGate => g.type === "phase");
  const wanted = option("--gate");
  const gate = wanted ? phaseGates.find((g) => g.id === wanted) : phaseGates.length === 1 ? phaseGates[0] : undefined;
  if (!gate) {
    die(2, wanted
      ? `no phase gate with id ${wanted}`
      : phaseGates.length ? `spec has ${phaseGates.length} phase gates — pass --gate <id>` : "spec has no phase gate");
  }
  const opts = { baseRef: r.gateBase, spec: r.spec, deadline: Date.now() + (r.spec.timeout ?? DEFAULT_RUN_TIMEOUT_MS), gates: new Map(r.spec.gates.map((g) => [g.id, g])), memo: new Map<string, GateResult>() };
  const marker = path.resolve(r.workspace, gate.current ?? DEFAULT_PHASE_FILE);
  const current = currentPhase(gate, r.workspace);

  if (!target) {
    const phases = gate.phases.map((p) => {
      const status = evaluatePhase(gate, p.id, r.workspace, opts);
      return { id: p.id, current: p.id === current, ok: status.failed.length === 0, failed: status.failed };
    });
    if (json) {
      console.log(JSON.stringify({ gate: gate.id, current, phases }, null, 2));
    } else {
      for (const p of phases) {
        const mark = p.ok ? c(C.green, "✓") : c(C.red, "✗");
        const detail = p.ok ? "requirements pass" : p.failed.map((f) => `${f.id}: ${f.reason}`).join("; ");
        console.log(`  ${mark} ${p.current ? c(C.bold, `${p.id} (current)`) : p.id}  ${c(C.dim, detail)}`);
      }
    }
    process.exit(phases.find((p) => p.current)?.ok === false ? 1 : 0);
  }

  const status = evaluatePhase(gate, target, r.workspace, opts);
  if (status.error) die(2, status.error);
  if (status.failed.length) {
    if (json) console.log(JSON.stringify({ gate: gate.id, from: current, to: target, moved: false, failed: status.failed }, null, 2));
    console.error(c(C.red, `✗ cannot enter ${target}: `) + status.failed.map((f) => f.id).join(", "));
    for (const f of status.failed) console.error(c(C.dim, `    · ${f.id}: ${f.reason}`));
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, target + "\n");
  if (json) console.log(JSON.stringify({ gate: gate.id, from: current, to: target, moved: true, failed: [] }, null, 2));
  else console.log(c(C.green, `✓ ${current} → ${target}`) + c(C.dim, ` · ${status.required.length} required gate(s) pass`));
  process.exit(0);
}

if (cmd === "gate") {
  // Harness-neutral entrypoint: pipe in (or pass) the command an agent is about to
  // run; get back allow/block. Works from Claude Code, Codex, Gemini CLI and Cursor
  // hooks, a git wrapper, or a bare shell. Exit 0 = allow, 2 = block (the cursor and
  // gemini formats answer in JSON on stdout instead). Fails closed on error unless
  // --allow-on-error. `--event stop` judges the agent ending its turn instead.
  const format = json ? "json" : (option("--format") ?? "text");
  if (!["text", "json", "cursor", "gemini", "claude-stop"].includes(format)) die(2, `gate --format must be text, json, cursor, gemini, or claude-stop`);
  const event = option("--event") ?? "command";
  if (!["command", "stop"].includes(event)) die(2, `gate --event must be command or stop`);
  if (format === "claude-stop" && event !== "stop") die(2, "--format claude-stop requires --event stop");
  const allowOnError = args.includes("--allow-on-error");
  const payload = readStdinPayload();
  // A non-shell tool call (an MCP tool, say) is judged by `gatedTools`, not `finishLine`.
  const payloadTool = typeof payload.data?.tool_name === "string" ? payload.data.tool_name : undefined;
  const tool = event === "stop" || option("--command") != null
    ? undefined
    : option("--tool") ?? (payloadTool && !SHELL_TOOLS.has(payloadTool) ? payloadTool : undefined);
  const command = event === "stop" ? "" : tool ?? ((option("--command") ?? commandFromPayload(payload)) ?? "").trim();
  const specPath = findSpecPath(cwd);
  let logWorkspace = workspaceRoot(specPath, cwd);
  const started = Date.now();

  /** Answer in the host's protocol and exit. */
  const answer = (decision: "allow" | "block", reason: string, failed: GateResult[] = [], extra: Record<string, unknown> = {}): never => {
    recordDecision(logWorkspace, {
      via: "gate",
      event: event === "stop" ? "stop" : tool ? "tool" : "command",
      decision,
      reason,
      ...(tool ? { tool } : event === "stop" ? {} : { command }),
      failed: toFailed(failed),
      durationMs: Date.now() - started,
    });
    const details = failed.map((f) => `  · ${f.id}: ${f.reason}`).join("\n");
    const guidance = event === "stop"
      ? `skillgate: the work is not done — ${reason}.\n${details}\nFix these before you finish. Do not weaken or bypass the gates.`
      : `skillgate blocked ${tool ? `tool ${tool}` : `"${command}"`}: ${reason}.\n${details}\nComplete the unmet gates, then retry.`;
    if (format === "claude-stop") {
      console.log(JSON.stringify(decision === "allow" ? {} : { decision: "block", reason: guidance }));
      process.exit(0);
    } else if (format === "json") {
      console.log(JSON.stringify({ decision, reason, command, event, ...extra }, null, 2));
    } else if (format === "cursor") {
      console.log(JSON.stringify(decision === "allow"
        ? { permission: "allow" }
        : { permission: "deny", user_message: `skillgate: ${reason}`, agent_message: guidance }));
      process.exit(0);
    } else if (format === "gemini") {
      console.log(JSON.stringify(decision === "allow" ? { decision: "allow" } : { decision: "deny", reason: guidance }));
      process.exit(0);
    } else if (decision === "block") {
      console.error(c(C.red, event === "stop" ? "✗ not done: " : "✗ blocked: ") + reason);
      console.error(failed.length ? guidance.split("\n").slice(1).join("\n") : guidance);
    } else {
      console.log(c(C.green, "✓ allow") + c(C.dim, ` · ${reason}`));
    }
    process.exit(decision === "block" ? 2 : 0);
  };

  if (!pin && !specPath) answer("allow", "no skillgate spec — nothing to enforce");

  try {
    const r = resolveSpecAndBase(specPath);
    logWorkspace = r.workspace;
    const timeoutMs = timeoutOption();
    if (event === "stop") {
      if (isClean(r.workspace) === true) answer("allow", "no changes in the worktree — nothing to verify", [], { pinnedTo: r.pinnedTo });
      const result = runGates(r.spec, r.workspace, { baseRef: r.gateBase, timeoutMs });
      if (result.passed) answer("allow", `all ${applied(result)} applicable gates passed`, [], { pinnedTo: r.pinnedTo, result });
      answer("block", `${result.failed.length} of ${applied(result)} gates unmet: ${result.failed.map((f) => f.id).join(", ")}`, result.failed, { pinnedTo: r.pinnedTo, result });
    }
    const decision = tool
      ? decideTool(r.spec, r.workspace, tool, { baseRef: r.gateBase, timeoutMs })
      : decideCommand(r.spec, r.workspace, command, { baseRef: r.gateBase, timeoutMs });
    answer(decision.decision, decision.reason, decision.result?.failed ?? [], { pinnedTo: r.pinnedTo, ...(decision.result ? { result: decision.result } : {}) });
  } catch (e: any) {
    answer(allowOnError ? "allow" : "block", `error: ${e.message}`);
  }
}

console.error(`unknown command: ${cmd}\n`);
help();
process.exit(2);

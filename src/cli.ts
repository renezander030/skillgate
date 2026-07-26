#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findSpecPath, loadSpec, parseSpec, DEFAULT_SPEC_PATHS, type Spec } from "./spec.js";
import { runGates, decideCommand } from "./core.js";
import { checkDrift, formatDiff, DEFAULT_THRESHOLD, discover, pickCanonical } from "./drift.js";
import { runSync } from "./link.js";
import { runScaffold, listTemplates } from "./scaffold.js";
import { resolveBaseRef, mergeBase, readFileAtRef, repoRoot } from "./git.js";

const C = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
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

# Commands that count as crossing the finish line (substring match).
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

function help(): void {
  console.log(`skillgate — deterministic finish-line gates for AI coding agents

Usage:
  skillgate audit                    one-shot read-only audit of this repo (no config needed)
  skillgate check [spec]             run gates, exit 1 if any fail
  skillgate verify-patch             evaluate an agent's patch in a network-off clone; block apply until your DoD passes
  skillgate verify-apply             land the verified patch into the real repo (only after verify-patch passes)
  skillgate gate                     allow/block one command (any harness); exit 2 = block
  skillgate init                     write an example .skillgate/done.yaml
  skillgate scaffold [--template]    generate .skillgate/evidence/ with stack templates
  skillgate drift                    report AI instruction-file drift, exit 1 if drifted
  skillgate diff-instructions        show line-level diff between drifted instruction files
  skillgate canonical <file>         set which file is the canonical instruction source
  skillgate sync                     make AGENTS.md canonical and link the rest
  skillgate --version

Flags:
  --json                   machine-readable output (check, gate, drift)
  --cwd <dir>              run against another directory
  --pin                    check/gate: read the spec from the base ref, not the
                           working tree, so a change can't loosen its own gate
  --base <ref>             ref for diff-aware gates (no-new, no-deleted) and, with
                           --pin, the pinned spec. Default: SKILLGATE_BASE or origin/HEAD
  --command "<cmd>"        gate: the command to judge (else read from stdin)
  --allow-on-error         gate: allow instead of fail-closed if evaluation errors
  --threshold <0..1>       drift: similarity required to count as in sync (default 0.95)
  --dry-run                sync: show what would change without writing
  --symlink                sync: use symlinks instead of pointer files and copies
  --update-agents          scaffold: update AGENTS.md/CLAUDE.md with evidence workflow

Templates (scaffold --template):
  generic    General-purpose evidence workflow
  ts-lib     TypeScript library — typecheck, test, lint, coverage
  react      React / Next.js application
  python     Python application`);
}

function version(): void {
  const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  console.log(pkg.version);
}

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === "--version" || cmd === "-v") {
  version();
  process.exit(0);
}
if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  help();
  process.exit(0);
}

const json = args.includes("--json");
const cwdIdx = args.indexOf("--cwd");
const cwd = cwdIdx >= 0 ? path.resolve(args[cwdIdx + 1]) : process.cwd();

const updateAgents = args.includes("--update-agents");

const baseIdx = args.indexOf("--base");
const baseArg = baseIdx >= 0 ? args[baseIdx + 1] : undefined;
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
function resolveSpecAndBase(specPathHint: string | null): Resolved {
  const rawBase = resolveBaseRef(cwd, baseArg);
  const gateBase = rawBase ? mergeBase(cwd, rawBase) : undefined;

  if (!pin) {
    if (!specPathHint) die(2, "no spec found — run `skillgate init` or pass a path");
    return { spec: loadSpec(specPathHint), gateBase };
  }

  if (!rawBase) {
    die(2, "--pin: cannot resolve a base ref (set SKILLGATE_BASE or pass --base <ref>) — refusing to run unpinned (fail-closed)");
  }
  const root = repoRoot(cwd);
  if (!root) die(2, "--pin: not a git repository (fail-closed)");
  const rels = specPathHint
    ? [path.relative(root, specPathHint).split(path.sep).join("/")]
    : DEFAULT_SPEC_PATHS;
  for (const rel of rels) {
    const raw = readFileAtRef(cwd, gateBase!, rel);
    if (raw != null) {
      const label = `${gateBase!.slice(0, 12)}:${rel}`;
      return { spec: parseSpec(raw, label, rel.endsWith(".json")), gateBase, pinnedTo: gateBase };
    }
  }
  return die(2, `--pin: no committed spec at ${gateBase!.slice(0, 12)} (looked for ${rels.join(", ")}) — commit your .skillgate/done.yaml to the base branch first (fail-closed)`);
}

/** Read the command an agent is about to run from stdin — raw, or from a hook JSON payload. */
function readStdinCommand(): string {
  if (process.stdin.isTTY) return "";
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
  if (!raw) return "";
  if (raw.startsWith("{")) {
    try {
      const o: any = JSON.parse(raw);
      return String(o?.tool_input?.command ?? o?.command ?? o?.params?.command ?? o?.tool_input?.cmd ?? raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

if (cmd === "init") {
  const dir = path.join(cwd, ".skillgate");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "done.yaml");
  if (fs.existsSync(target)) {
    console.error(`${path.relative(cwd, target)} already exists`);
    process.exit(1);
  }
  fs.writeFileSync(target, EXAMPLE);
  console.log(`wrote ${path.relative(cwd, target)} — edit it, then \`skillgate check\``);
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
    result = runGates(loadSpec(specPath), cwd);
  } catch (e: any) {
    console.error(c(C.red, `skillgate: ${e.message}`));
    process.exit(2);
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
  for (const r of result.results) {
    const mark = r.ok ? c(C.green, "✓") : c(C.red, "✗");
    console.log(`  ${mark} ${r.id}  ${c(C.dim, r.reason)}`);
  }
  console.log("");
  if (result.passed) {
    console.log(c(C.green, `✓ all ${result.results.length} checks pass — nothing for your agent to cut here.`));
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
  const explicit = args[1] && !args[1].startsWith("-") ? path.resolve(cwd, args[1]) : null;
  const specPath = explicit ?? findSpecPath(cwd);
  // Without --pin the working-tree spec must exist; with --pin it may have been
  // deleted in the change under review — resolveSpecAndBase reads it from the base.
  if (!pin && (!specPath || !fs.existsSync(specPath))) {
    console.error(c(C.red, "skillgate: no spec found") + " — run `skillgate init` or pass a path");
    process.exit(2);
  }

  let result;
  let pinnedTo: string | undefined;
  try {
    const r = resolveSpecAndBase(specPath && fs.existsSync(specPath) ? specPath : null);
    pinnedTo = r.pinnedTo;
    result = runGates(r.spec, cwd, { baseRef: r.gateBase });
  } catch (e: any) {
    console.error(c(C.red, `skillgate: ${e.message}`));
    process.exit(2);
  }

  if (json) {
    console.log(JSON.stringify({ ...result, pinnedTo }, null, 2));
    process.exit(result.passed ? 0 : 1);
  }

  if (pinnedTo) {
    console.log(c(C.dim, `  policy pinned to ${pinnedTo.slice(0, 12)} (base ref) — this change cannot loosen it`));
  }
  for (const r of result.results) {
    const mark = r.ok ? c(C.green, "✓") : c(C.red, "✗");
    console.log(`  ${mark} ${r.id}  ${c(C.dim, r.reason)}`);
  }
  console.log("");
  if (result.passed) {
    console.log(c(C.green, `✓ all ${result.results.length} gates passed`));
    process.exit(0);
  }
  console.log(
    c(C.red, `✗ ${result.failed.length} of ${result.results.length} gates unmet: `) +
      result.failed.map((f) => f.id).join(", "),
  );
  process.exit(1);
}

if (cmd === "drift") {
  const tIdx = args.indexOf("--threshold");
  const threshold = tIdx >= 0 ? Number(args[tIdx + 1]) : DEFAULT_THRESHOLD;
  const res = checkDrift(cwd, threshold);

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
  const { lines } = runSync(cwd, {
    dryRun: args.includes("--dry-run"),
    symlink: args.includes("--symlink"),
  });
  for (const l of lines) console.log(l);
  process.exit(0);
}

if (cmd === "scaffold") {
  const tIdx = args.indexOf("--template");
  const template = tIdx >= 0 ? args[tIdx + 1] : "generic";
  try {
    const { lines } = runScaffold({ cwd, template, updateAgents });
    for (const l of lines) console.log(l);
    process.exit(0);
  } catch (e: any) {
    console.error(c(C.red, `skillgate: ${e.message}`));
    process.exit(2);
  }
}

if (cmd === "diff-instructions") {
  const tIdx = args.indexOf("--threshold");
  const threshold = tIdx >= 0 ? Number(args[tIdx + 1]) : DEFAULT_THRESHOLD;
  const res = checkDrift(cwd, threshold);

  if (res.entries.length === 0) {
    console.log("no agent instruction files found");
    process.exit(0);
  }

  if (res.drifted === 0) {
    console.log(c(C.green, `✓ all ${res.entries.length} instruction files in sync with ${res.canonical}`));
    process.exit(0);
  }

  const sources = discover(cwd);
  const canon = pickCanonical(sources);
  const canonLabel = canon.files.join(", ");

  for (const e of res.entries) {
    if (e.status !== "drifted") continue;
    const src = sources.find((s) => s.tool === e.tool);
    if (!src) continue;
    const pct = `${Math.round(e.similarity * 100)}%`;
    console.log(`\n${c(C.bold, e.tool)} — ${pct} similarity with ${c(C.bold, canonLabel)}`);
    console.log(c(C.dim, e.files.join(", ")));
    console.log(c(C.dim, "─".repeat(50)));
    console.log(formatDiff(canon.lines, src.lines));
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
  // Write a .skillgate/canonical marker file pointing to the canonical source
  const markerDir = path.join(cwd, ".skillgate");
  fs.mkdirSync(markerDir, { recursive: true });
  const markerPath = path.join(markerDir, "canonical-instructions.txt");
  const relPath = path.relative(cwd, canonPath);
  fs.writeFileSync(markerPath, relPath + "\n");
  console.log(c(C.green, `✓ canonical instruction source set to ${relPath}`));
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

if (cmd === "gate") {
  // Harness-neutral entrypoint: pipe in (or pass) the command an agent is about to
  // run; get back allow/block. Works from a Claude Code PreToolUse hook, a Cursor/
  // Codex/git wrapper, or a bare shell — enforcement no longer needs one harness's
  // plugin API. Exit 0 = allow, 2 = block. Fails closed on error (unless --allow-on-error).
  const cIdx = args.indexOf("--command");
  const command = ((cIdx >= 0 ? args[cIdx + 1] : readStdinCommand()) ?? "").trim();
  const allowOnError = args.includes("--allow-on-error");
  const specPath = findSpecPath(cwd);

  if (!pin && !specPath) {
    // No definition of done configured: nothing to enforce, let it through.
    const d = { decision: "allow", reason: "no skillgate spec — nothing to enforce", command };
    console.log(json ? JSON.stringify(d, null, 2) : c(C.dim, `allow · ${d.reason}`));
    process.exit(0);
  }

  try {
    const r = resolveSpecAndBase(specPath && fs.existsSync(specPath) ? specPath : null);
    const decision = decideCommand(r.spec, cwd, command, { baseRef: r.gateBase });
    if (json) {
      console.log(JSON.stringify({ ...decision, pinnedTo: r.pinnedTo }, null, 2));
    } else if (decision.decision === "block") {
      console.error(c(C.red, `✗ blocked: `) + decision.reason);
      for (const f of decision.result?.failed ?? []) console.error(c(C.dim, `    · ${f.id}: ${f.reason}`));
    } else {
      console.log(c(C.green, `✓ allow`) + c(C.dim, ` · ${decision.reason}`));
    }
    process.exit(decision.decision === "block" ? 2 : 0);
  } catch (e: any) {
    const decision = allowOnError ? "allow" : "block";
    const payload = { decision, reason: `error: ${e.message}`, command };
    if (json) console.log(JSON.stringify(payload, null, 2));
    else console.error(c(allowOnError ? C.dim : C.red, `${decision}: ${payload.reason}`));
    process.exit(allowOnError ? 0 : 2);
  }
}

console.error(`unknown command: ${cmd}\n`);
help();
process.exit(2);

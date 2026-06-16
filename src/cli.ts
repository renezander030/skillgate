#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { findSpecPath, loadSpec } from "./spec.js";
import { runGates } from "./core.js";
import { checkDrift, DEFAULT_THRESHOLD } from "./drift.js";
import { runSync } from "./link.js";

const C = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};
const useColor = process.stdout.isTTY;
const c = (code: string, s: string) => (useColor ? code + s + C.reset : s);

const EXAMPLE = `# skillgate — definition of done
# Docs: https://github.com/renezander030/skillgate
name: definition-of-done

# Commands that count as crossing the finish line (substring match).
finishLine:
  - "git commit"
  - "git push"
  - "npm publish"

gates:
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
`;

function help(): void {
  console.log(`skillgate — deterministic finish-line gates for AI coding agents

Usage:
  skillgate audit          one-shot read-only audit of this repo (no config needed)
  skillgate check [spec]   run gates, exit 1 if any fail
  skillgate init           write an example .skillgate/done.yaml
  skillgate drift          report AI instruction-file drift, exit 1 if drifted
  skillgate sync           make AGENTS.md canonical and link the rest
  skillgate --version

Flags:
  --json                   machine-readable output (check, drift)
  --cwd <dir>              run against another directory
  --threshold <0..1>       drift: similarity required to count as in sync (default 0.95)
  --dry-run                sync: show what would change without writing
  --symlink                sync: use symlinks instead of pointer files and copies`);
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
  if (!specPath || !fs.existsSync(specPath)) {
    console.error(c(C.red, "skillgate: no spec found") + " — run `skillgate init` or pass a path");
    process.exit(2);
  }

  let result;
  try {
    result = runGates(loadSpec(specPath), cwd);
  } catch (e: any) {
    console.error(c(C.red, `skillgate: ${e.message}`));
    process.exit(2);
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.passed ? 0 : 1);
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

console.error(`unknown command: ${cmd}\n`);
help();
process.exit(2);

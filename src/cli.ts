#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { findSpecPath, loadSpec } from "./spec.js";
import { runGates } from "./core.js";

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
  skillgate check [spec]   run gates, exit 1 if any fail
  skillgate init           write an example .skillgate/done.yaml
  skillgate --version

Flags:
  --json                   machine-readable output
  --cwd <dir>              run against another directory`);
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

console.error(`unknown command: ${cmd}\n`);
help();
process.exit(2);

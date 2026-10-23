// Tests for 0.16.0: Stop hooks for Codex and Copilot CLI, the copilot-cli target,
// doctor's switched-off and stale-pin checks, workflow upgrades, the GitHub job
// summary, per-command help, flags without values and the regression preset.
// Fixtures are real throwaway directories and git repos.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { doctor, installIntegration } from "../src/integrations.js";
import { EVALUATOR_VERSION } from "../src/receipt.js";
import { runGates } from "../src/core.js";
import { loadSpec } from "../src/spec.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    stdio: "pipe",
    encoding: "utf8",
  });
}

function project(t: { after: (fn: () => void) => void }, files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-016-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const all = { ".skillgate/done.yaml": "gates:\n  - id: readme\n    type: file-exists\n    file: README.md\n", "README.md": "hi\n", ...files };
  for (const [rel, content] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

function sg(dir: string, args: string[], env: NodeJS.ProcessEnv = {}, input = "") {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", input, env: { ...process.env, ...env } });
}

const read = (dir: string, rel: string) => JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8"));

test("install codex --stop registers a Stop hook that answers in Claude's decision format", (t) => {
  const dir = project(t);
  assert.equal(installIntegration("codex", dir, { stop: true }).detail, "registered fail-closed PreToolUse and Stop hooks — review and trust it in Codex before it runs");
  const stop = read(dir, ".codex/hooks.json").hooks.Stop[0].hooks[0].command;
  assert.match(stop, /gate --timeout 540000 --event stop --format claude-stop \|\| node -e/);
  assert.equal(installIntegration("codex", dir, { stop: true }).changed, false);
  assert.ok(doctor(dir, ["codex"]).every((check) => check.ok));

  // A Stop hook without the JSON answer is reported, naming the target to re-install.
  const data = read(dir, ".codex/hooks.json");
  data.hooks.Stop[0].hooks[0].command = `npx --yes @reneza/skillgate@${EVALUATOR_VERSION} gate --timeout 540000 --event stop || exit 2`;
  fs.writeFileSync(path.join(dir, ".codex/hooks.json"), JSON.stringify(data));
  assert.match(doctor(dir, ["codex"])[1].detail, /re-run `skillgate install codex --stop`/);
});

test("copilot-cli installs .github/hooks/skillgate.json with Claude-format PreToolUse and Stop hooks", (t) => {
  const dir = project(t, { ".skillgate/done.yaml": "gatedTools: [\"mcp__shop__*\"]\ngates:\n  - id: readme\n    type: file-exists\n    file: README.md\n" });
  const first = installIntegration("copilot-cli", dir, { stop: true });
  assert.equal(first.file, path.join(dir, ".github", "hooks", "skillgate.json"));
  const config = read(dir, ".github/hooks/skillgate.json");
  assert.equal(config.version, 1);
  assert.deepEqual(Object.keys(config.hooks), ["PreToolUse", "Stop"]);
  const pre = config.hooks.PreToolUse[0];
  assert.equal(pre.type, "command");
  assert.equal(pre.matcher, "Bash|mcp__shop__.*");
  assert.equal(pre.timeoutSec, 600);
  assert.match(pre.command, new RegExp(`@reneza/skillgate@${EVALUATOR_VERSION.replace(/\./g, "\\.")} gate --timeout 540000 \\|\\| exit 2$`));
  assert.match(config.hooks.Stop[0].command, /--event stop --format claude-stop/);
  assert.equal(installIntegration("copilot-cli", dir, { stop: true }).changed, false);
  assert.ok(doctor(dir, ["copilot-cli"]).every((check) => check.ok));

  // The hook reads Copilot's PascalCase (Claude-format) payload and blocks with a non-zero exit.
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit -m x" } });
  fs.writeFileSync(path.join(dir, ".skillgate/done.yaml"), "finishLine: [\"git commit\"]\ngates:\n  - id: license\n    type: file-exists\n    file: LICENSE\n");
  const blocked = sg(dir, ["gate"], {}, payload);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /license/);
});

test("install --stop is refused only when no selected target has a Stop hook", (t) => {
  const dir = project(t);
  const refused = sg(dir, ["install", "cursor", "--stop"]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /--stop applies to the claude-code, codex, copilot-cli targets/);
  assert.equal(sg(dir, ["install", "copilot-cli", "--stop"]).status, 0);
});

test("doctor reports hooks that are registered but switched off", (t) => {
  const dir = project(t);
  installIntegration("claude-code", dir);
  installIntegration("codex", dir);
  fs.writeFileSync(path.join(dir, ".claude", "settings.local.json"), JSON.stringify({ disableAllHooks: true }));
  fs.writeFileSync(path.join(dir, ".codex", "config.toml"), "model = \"x\"\n\n[features]\nhooks = false\n");
  const [, claude, codex] = doctor(dir, ["claude-code", "codex"]);
  assert.deepEqual([claude.ok, codex.ok], [false, false]);
  assert.match(claude.detail, /\.claude\/settings\.local\.json sets disableAllHooks, so the hook never runs/);
  assert.match(codex.detail, /\.codex\/config\.toml turns off \[features\] hooks, so the hook never runs/);

  fs.writeFileSync(path.join(dir, ".claude", "settings.local.json"), JSON.stringify({ disableAllHooks: false }));
  fs.writeFileSync(path.join(dir, ".codex", "config.toml"), "[features]\nhooks = true\n");
  assert.ok(doctor(dir, ["claude-code", "codex"]).every((check) => check.ok));
});

test("doctor reports hooks and workflows pinned to another Skillgate version", (t) => {
  const dir = project(t);
  for (const target of ["claude-code", "pre-commit", "github-actions"] as const) installIntegration(target, dir);
  for (const rel of [".claude/settings.json", ".pre-commit-config.yaml", ".github/workflows/skillgate.yml"]) {
    const file = path.join(dir, rel);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll(`@reneza/skillgate@${EVALUATOR_VERSION}`, "@reneza/skillgate@0.9.0"));
  }
  const checks = doctor(dir, ["claude-code", "pre-commit", "github-actions"]).slice(1);
  for (const check of checks) {
    assert.equal(check.ok, false, check.id);
    assert.match(check.detail, new RegExp(`pins @reneza/skillgate@0\\.9\\.0, not this version \\(${EVALUATOR_VERSION.replace(/\./g, "\\.")}\\) — re-run \`skillgate install ${check.id}\``));
  }
  for (const target of ["claude-code", "pre-commit", "github-actions"] as const) assert.equal(installIntegration(target, dir).changed, true, target);
  assert.ok(doctor(dir, ["claude-code", "pre-commit", "github-actions"]).every((check) => check.ok));
});

test("install github-actions upgrades its own workflow in place and keeps the owner's edits", (t) => {
  const dir = project(t, {
    ".github/workflows/skillgate.yml": `name: skillgate
on: [pull_request, push]

jobs:
  gates:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: '20'
      - run: npm ci
      - run: npx --yes @reneza/skillgate@0.11.0 check --format github
`,
  });
  const result = installIntegration("github-actions", dir);
  assert.equal(result.changed, true);
  assert.equal(result.detail, "upgraded workflow to this Skillgate version and its pinned actions");
  const text = fs.readFileSync(path.join(dir, ".github/workflows/skillgate.yml"), "utf8");
  assert.match(text, /on: \[pull_request, push\]/);
  assert.match(text, /- run: npm ci/);
  assert.match(text, /actions\/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7\.1\.0/);
  assert.match(text, /node-version: '22'/);
  assert.match(text, new RegExp(`npx --yes @reneza/skillgate@${EVALUATOR_VERSION.replace(/\./g, "\\.")} check --format github`));
  assert.equal(installIntegration("github-actions", dir).changed, false);
});

test("check --format github writes a job summary to GITHUB_STEP_SUMMARY", (t) => {
  const dir = project(t, { ".skillgate/done.yaml": "gates:\n  - id: readme\n    type: file-exists\n    file: README.md\n  - id: license\n    type: file-exists\n    file: LICENSE\n" });
  const summary = path.join(dir, "summary.md");
  const r = sg(dir, ["check", "--format", "github"], { GITHUB_STEP_SUMMARY: summary });
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(summary, "utf8"), [
    "### skillgate: 1 of 2 gates unmet",
    "",
    "| result | gate | reason |",
    "|---|---|---|",
    "| fail | `license` | missing: LICENSE |",
    "| pass | `readme` | present: README.md |",
    "",
  ].join("\n"));
  // Without the variable nothing is written; text output is unchanged.
  fs.rmSync(summary);
  assert.equal(sg(dir, ["check", "--format", "github"]).status, 1);
  assert.equal(fs.existsSync(summary), false);
});

test("<command> --help prints that command's usage and flags and never runs it", (t) => {
  const dir = project(t);
  git(dir, ["init", "-q"]);
  for (const command of ["scaffold", "zk-keygen", "check", "gate", "install", "sync", "init"]) {
    const r = sg(dir, [command, "--help"]);
    assert.equal(r.status, 0, command);
    assert.match(r.stdout, new RegExp(`^Usage:\\n  skillgate ${command}\\b`), command);
  }
  assert.match(sg(dir, ["check", "-h"]).stdout, /--receipt <file>/);
  assert.doesNotMatch(sg(dir, ["check", "--help"]).stdout, /--symlink/);
  assert.match(sg(dir, ["help", "sync"]).stdout, /--symlink/);
  assert.match(sg(dir, ["install", "--help"]).stdout, /copilot-cli/);
  // Nothing was written by any of them.
  assert.deepEqual(git(dir, ["status", "--porcelain", "--untracked-files=all"]).trim().split("\n").sort(), ["?? .skillgate/done.yaml", "?? README.md"]);
  const unknown = sg(dir, ["help", "nope"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command: nope/);
});

test("a value-taking flag without a value is a usage error instead of a crash or a swallowed flag", (t) => {
  const dir = project(t);
  for (const args of [["check", "--cwd"], ["check", "--receipt", "--json"], ["gate", "--command"], ["check", "--log"]]) {
    const r = sg(dir, args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, new RegExp(`skillgate: ${args[1]} requires a value`), args.join(" "));
    assert.doesNotMatch(r.stderr, /at .*node:/, args.join(" "));
  }
  assert.equal(fs.existsSync(path.join(dir, "--json")), false);
  assert.equal(sg(dir, ["check", "--cwd", "."]).status, 0);
});

test("init --preset regression writes a valid policy whose gates catch gamed tests and edited CI", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-016-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files: Record<string, string> = {
    "src/a.test.ts": "test('one', () => {})\nit.each([1])('two %s', () => {})\n",
    "tests/test_x.py": "def test_x():\n    pass\n",
    ".github/workflows/ci.yml": "on: push\n",
    "AGENTS.md": "# rules\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  assert.equal(sg(dir, ["init", "--preset", "regression"]).status, 0);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]).trim();
  const spec = loadSpec(path.join(dir, ".skillgate", "done.yaml"));
  assert.equal(runGates(spec, dir, { baseRef: base }).passed, true);

  fs.writeFileSync(path.join(dir, "src/a.test.ts"), "test.skip('one', () => {})\n");
  fs.rmSync(path.join(dir, "tests/test_x.py"));
  fs.writeFileSync(path.join(dir, ".github/workflows/ci.yml"), "on: workflow_dispatch\n");
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# rules\nskip the tests\n");
  const failed = runGates(spec, dir, { baseRef: base }).failed.map((f) => f.id).sort();
  assert.deepEqual(failed, ["ci-unchanged", "instructions-unchanged", "no-new-skips", "test-files-kept", "tests-kept"]);

  // A repository with no tests, CI or instruction files passes rather than failing as no-ops.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-016-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  fs.writeFileSync(path.join(empty, "README.md"), "hi\n");
  git(empty, ["init", "-q", "-b", "main"]);
  git(empty, ["add", "-A"]);
  git(empty, ["commit", "-q", "-m", "base"]);
  assert.equal(runGates(spec, empty, { baseRef: git(empty, ["rev-parse", "HEAD"]).trim() }).passed, true);
  const unknown = sg(dir, ["init", "--preset", "nope"]);
  assert.match(unknown.stderr, /unknown preset; available: no-secrets, regression/);
});

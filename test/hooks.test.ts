// CLI tests for agent hook protocols: gate --format cursor|gemini, gate --event
// stop, check --format github / --command, and fail-closed hook installs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { doctor, installIntegration, gateCommand } from "../src/integrations.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function sg(args: string[], cwd: string, input?: string): Run {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf8",
      input,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e: any) {
    return { status: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
}

function git(dir: string, args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@t.dev", "-c", "user.name=t", ...args], { cwd: dir, stdio: "pipe" });
}

function project(files: Record<string, string>, commit = false): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-hooks-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  if (commit) {
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "base"]);
  }
  return dir;
}

const SPEC = "finishLine: ['git commit']\ngates:\n  - id: notes\n    type: file-exists\n    file: NOTES.md\n";

test("gate --format cursor answers in Cursor's permission JSON and exits 0", (t) => {
  const dir = project({ ".skillgate/done.yaml": SPEC });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payload = JSON.stringify({ command: "git commit -m x", cwd: dir });
  const blocked = sg(["gate", "--format", "cursor"], dir, payload);
  assert.equal(blocked.status, 0);
  const deny = JSON.parse(blocked.stdout);
  assert.equal(deny.permission, "deny");
  assert.match(deny.agent_message, /notes: missing: NOTES\.md/);

  const allowed = sg(["gate", "--format", "cursor"], dir, JSON.stringify({ command: "ls -la" }));
  assert.deepEqual(JSON.parse(allowed.stdout), { permission: "allow" });
});

test("gate --format gemini answers with a decision object and nothing else on stdout", (t) => {
  const dir = project({ ".skillgate/done.yaml": SPEC });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payload = JSON.stringify({ tool_name: "run_shell_command", tool_input: { command: "git commit -m x" } });
  const r = sg(["gate", "--format", "gemini"], dir, payload);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /NOTES\.md/);
  assert.deepEqual(JSON.parse(sg(["gate", "--format", "gemini"], project({}), payload).stdout), { decision: "allow" });
});

test("gate --format cursor fails closed with a deny when the policy is invalid", (t) => {
  const dir = project({ ".skillgate/done.yaml": "gates: nope\n" });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = sg(["gate", "--format", "cursor"], dir, JSON.stringify({ command: "git commit" }));
  assert.equal(JSON.parse(r.stdout).permission, "deny");
});

test("gate --event stop blocks ending the turn while gates fail, with guidance on stderr", (t) => {
  const dir = project({ ".skillgate/done.yaml": SPEC, "a.txt": "x" }, true);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payload = JSON.stringify({ session_id: "s1", stop_hook_active: false, cwd: dir });

  // Clean worktree: the agent changed nothing, so there is nothing to verify.
  assert.equal(sg(["gate", "--event", "stop"], dir, payload).status, 0);

  fs.writeFileSync(path.join(dir, "a.txt"), "changed");
  const blocked = sg(["gate", "--event", "stop"], dir, payload);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /not done/);
  assert.match(blocked.stderr, /notes: missing: NOTES\.md/);
  assert.match(blocked.stderr, /Do not weaken/);

  fs.writeFileSync(path.join(dir, "NOTES.md"), "done");
  assert.equal(sg(["gate", "--event", "stop"], dir, payload).status, 0);
});

test("check --format github prints ::error annotations anchored to the failing file", (t) => {
  const dir = project({
    ".skillgate/done.yaml": "gates:\n  - id: todo\n    type: absent\n    glob: 'src/*.ts'\n    pattern: TODO\n",
    "src/a.ts": "ok\n// TODO, later: fix\n",
  }, true);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = sg(["check", "--format", "github"], dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^::error file=src\/a\.ts,line=2,title=skillgate%3A todo::src\/a\.ts:2 matches \/TODO\/$/m);
  assert.equal(sg(["check", "--format", "sarif"], dir).status, 2);
});

test("check --command evaluates when.command gates for that finish line", (t) => {
  const dir = project({
    ".skillgate/done.yaml": "gates:\n  - id: push-only\n    type: file-exists\n    file: NOTES.md\n    when: { command: ['git push'] }\n",
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const commit = sg(["check", "--command", "git commit -m x"], dir);
  assert.equal(commit.status, 0);
  assert.match(commit.stdout, /1 skipped by when/);
  assert.equal(sg(["check", "--command", "git push"], dir).status, 1);
  assert.equal(sg(["check"], dir).status, 1);
});

test("agent hooks are installed fail-closed with a timeout, for every agent", (t) => {
  const dir = project({ ".skillgate/done.yaml": SPEC });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const target of ["claude-code", "codex", "gemini-cli", "cursor"] as const) {
    assert.equal(installIntegration(target, dir).changed, true);
    assert.equal(installIntegration(target, dir).changed, false);
  }
  const claude = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
  assert.equal(claude.hooks.PreToolUse[0].hooks[0].command, gateCommand());
  assert.match(gateCommand(), /gate \|\| exit 2$/);
  assert.equal(claude.hooks.PreToolUse[0].hooks[0].timeout, 600);
  assert.equal(claude.hooks.Stop, undefined);

  const codex = JSON.parse(fs.readFileSync(path.join(dir, ".codex", "hooks.json"), "utf8"));
  assert.equal(codex.hooks.PreToolUse[0].matcher, "Bash");
  const gemini = JSON.parse(fs.readFileSync(path.join(dir, ".gemini", "settings.json"), "utf8"));
  assert.equal(gemini.hooks.BeforeTool[0].matcher, "run_shell_command");
  assert.match(gemini.hooks.BeforeTool[0].hooks[0].command, /--format gemini \|\| exit 2$/);
  assert.equal(gemini.hooks.BeforeTool[0].hooks[0].timeout, 600_000);
  const cursor = JSON.parse(fs.readFileSync(path.join(dir, ".cursor", "hooks.json"), "utf8"));
  assert.equal(cursor.version, 1);
  assert.equal(cursor.hooks.beforeShellExecution[0].failClosed, true);
  assert.match(cursor.hooks.beforeShellExecution[0].command, /--format cursor/);

  assert.ok(doctor(dir, ["claude-code", "codex", "gemini-cli", "cursor"]).every((c) => c.ok));
});

test("install claude-code --stop adds the Stop hook; an old fail-open hook is upgraded in place", (t) => {
  const dir = project({ ".skillgate/done.yaml": SPEC });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = path.join(dir, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({
    hooks: { PreToolUse: [
      { matcher: "Read", hooks: [{ type: "command", command: "other-tool" }] },
      { matcher: "Bash", hooks: [{ type: "command", command: "npx --yes @reneza/skillgate@0.9.0 gate" }] },
    ] },
  }));
  const before = doctor(dir, ["claude-code"]);
  assert.equal(before[1].ok, false);
  assert.match(before[1].detail, /fails open/);

  const r = installIntegration("claude-code", dir, { stop: true });
  assert.equal(r.changed, true);
  assert.match(r.detail, /updated/);
  const data = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(data.hooks.PreToolUse.length, 2);
  assert.equal(data.hooks.PreToolUse[0].hooks[0].command, "other-tool");
  assert.equal(data.hooks.PreToolUse[1].hooks[0].command, gateCommand());
  assert.match(data.hooks.Stop[0].hooks[0].command, /gate --event stop \|\| exit 2$/);
  assert.ok(doctor(dir, ["claude-code"]).every((c) => c.ok));

  assert.equal(sg(["install", "cursor", "--stop"], dir).status, 2);
});

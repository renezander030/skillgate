// End-to-end tests for the anti-bypass CLI surface: `check --base` diff-aware
// gates, `check --pin` (policy read from the base ref, immune to the change under
// review), and the `gate` neutral entrypoint. Fixtures are real git repos.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CLI = new URL("../src/cli.js", import.meta.url).pathname;

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

function gitCmd(dir: string, args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@t.dev", "-c", "user.name=t", ...args], { cwd: dir, stdio: "pipe" });
}

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/** Throwaway git repo on `main` with `files` committed as the base. */
function gitProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-e2e-ab-"));
  gitCmd(dir, ["init", "-q", "-b", "main"]);
  write(dir, files);
  gitCmd(dir, ["add", "-A"]);
  gitCmd(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}

test("check --base: no-new gate fails when the working tree adds a skip", () => {
  const dir = gitProject({
    "a.test.ts": "test('x', () => {})\n",
    ".skillgate/done.yaml":
      "gates:\n  - id: no-new-skips\n    type: no-new\n    glob: '**/*.test.ts'\n    pattern: '\\.skip\\('\n",
  });
  write(dir, { "a.test.ts": "test.skip('x', () => {})\n" });
  const r = sg(["check", "--base", "HEAD", "--json"], dir);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.passed, false);
  assert.equal(out.failed[0].id, "no-new-skips");
});

test("check --base: no-new gate passes when nothing regressed", () => {
  const dir = gitProject({
    "a.test.ts": "test('x', () => {})\n",
    ".skillgate/done.yaml":
      "gates:\n  - id: no-new-skips\n    type: no-new\n    glob: '**/*.test.ts'\n    pattern: '\\.skip\\('\n",
  });
  const r = sg(["check", "--base", "HEAD"], dir);
  assert.equal(r.status, 0);
});

test("check --pin: a change cannot loosen the gate it is judged by", () => {
  const dir = gitProject({
    "README.md": "hi\n",
    ".skillgate/done.yaml": "gates:\n  - id: needs-license\n    type: file-exists\n    file: LICENSE\n",
  });
  // Agent edits the working-tree spec to delete the failing gate.
  write(dir, { ".skillgate/done.yaml": "gates:\n  - id: trivial\n    type: file-exists\n    file: README.md\n" });

  // Unpinned: the loosened working-tree spec wins → passes.
  assert.equal(sg(["check"], dir).status, 0);
  // Pinned to the base ref: the original strict spec is enforced → still fails.
  const pinned = sg(["check", "--pin", "--base", "HEAD"], dir);
  assert.equal(pinned.status, 1);
  assert.match(pinned.stdout, /needs-license/);
});

test("check --pin: still enforces even if the spec is deleted in the working tree", () => {
  const dir = gitProject({
    "README.md": "hi\n",
    ".skillgate/done.yaml": "gates:\n  - id: needs-license\n    type: file-exists\n    file: LICENSE\n",
  });
  fs.rmSync(path.join(dir, ".skillgate/done.yaml")); // agent deletes the policy
  const pinned = sg(["check", "--pin", "--base", "HEAD"], dir);
  assert.equal(pinned.status, 1);
  assert.match(pinned.stdout, /needs-license/);
});

test("check --pin: fails closed when no base ref can be resolved", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-nogit-"));
  write(dir, { ".skillgate/done.yaml": "gates:\n  - id: t\n    type: file-exists\n    file: README.md\n" });
  const r = sg(["check", "--pin"], dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /fail-closed/);
});

test("gate: allows a command that is not a finish line", () => {
  const dir = gitProject({
    "a.txt": "1\n",
    ".skillgate/done.yaml":
      "finishLine:\n  - 'git commit'\ngates:\n  - id: needs-license\n    type: file-exists\n    file: LICENSE\n",
  });
  const r = sg(["gate", "--command", "ls -la", "--json"], dir);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).decision, "allow");
});

test("gate: blocks a finish-line command when a gate fails (exit 2)", () => {
  const dir = gitProject({
    "a.txt": "1\n",
    ".skillgate/done.yaml":
      "finishLine:\n  - 'git commit'\ngates:\n  - id: needs-license\n    type: file-exists\n    file: LICENSE\n",
  });
  const r = sg(["gate", "--command", "git commit -m wip", "--json"], dir);
  assert.equal(r.status, 2);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /needs-license/);
});

test("gate: reads a Claude Code hook JSON payload from stdin", () => {
  const dir = gitProject({
    "a.txt": "1\n",
    ".skillgate/done.yaml":
      "finishLine:\n  - 'git commit'\ngates:\n  - id: needs-license\n    type: file-exists\n    file: LICENSE\n",
  });
  const payload = JSON.stringify({ tool_input: { command: "git commit -m x" } });
  const r = sg(["gate", "--json"], dir, payload);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).decision, "block");
});

test("gate: no spec means nothing to enforce (allow)", () => {
  const dir = gitProject({ "a.txt": "1\n" });
  const r = sg(["gate", "--command", "git commit -m x", "--json"], dir);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).decision, "allow");
});

test("gate: human output blocks with a reason on stderr", () => {
  const dir = gitProject({
    "a.txt": "1\n",
    ".skillgate/done.yaml":
      "finishLine:\n  - 'git commit'\ngates:\n  - id: needs-license\n    type: file-exists\n    file: LICENSE\n",
  });
  const r = sg(["gate", "--command", "git commit"], dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /blocked/);
});

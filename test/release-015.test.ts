// Tests for the 0.15.0 gates and commands: pushed, commit-messages, evidence
// newerThan, warn-level gates, verify-receipt, npm script references in
// instruction files and the canonical-instructions marker. Fixtures are real
// throwaway directories and git repos.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runGates, gatesForCommand } from "../src/core.js";
import { findImports, packageName } from "../src/imports.js";
import { extractRefs } from "../src/refs.js";
import { summarizeLog, logPathProblem } from "../src/log.js";
import { runSync } from "../src/link.js";
import { parseSpec, type Spec } from "../src/spec.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t.dev", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    stdio: "pipe",
    encoding: "utf8",
  });
}

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-015-"));
  write(dir, files);
  return dir;
}

/** A throwaway git repo on `main` with `files` committed; returns [dir, base sha]. */
function gitProject(files: Record<string, string>): [string, string] {
  const dir = tmpProject(files);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return [dir, git(dir, ["rev-parse", "HEAD"]).trim()];
}

function sg(args: string[], cwd: string, env?: NodeJS.ProcessEnv, input?: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, SKILLGATE_LOG: "", ...env },
      encoding: "utf8",
      input,
      stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e: any) {
    return { status: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
}

// ---- pushed -----------------------------------------------------------------

/** A clone of a bare remote with one pushed commit; returns the clone dir. */
function clonedProject(): string {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-015-remote-"));
  git(remote, ["init", "-q", "--bare", "-b", "main"]);
  const [dir] = gitProject({ "a.txt": "1\n" });
  git(dir, ["remote", "add", "origin", remote]);
  git(dir, ["push", "-q", "-u", "origin", "main"]);
  return dir;
}

test("pushed: passes when every commit is on the upstream, blocks local commits", () => {
  const dir = clonedProject();
  const spec: Spec = { gates: [{ id: "pushed", type: "pushed" }] };
  const clean = runGates(spec, dir);
  assert.equal(clean.passed, true);
  assert.match(clean.results[0].reason, /every commit is on origin\/main/);
  write(dir, { "a.txt": "2\n" });
  git(dir, ["commit", "-qam", "local only"]);
  const r = runGates(spec, dir);
  assert.equal(r.passed, false);
  assert.match(r.results[0].reason, /1 commit\(s\) not on origin\/main: [0-9a-f]{12} "local only" — push them/);
  git(dir, ["push", "-q"]);
  assert.equal(runGates(spec, dir).passed, true);
  assert.equal(runGates({ gates: [{ id: "pushed", type: "pushed", ref: "origin/main" }] }, dir).passed, true);
});

test("pushed: fails closed without an upstream or with an unknown ref", () => {
  const [dir] = gitProject({ "a.txt": "1\n" });
  const r = runGates({ gates: [{ id: "pushed", type: "pushed" }] }, dir);
  assert.equal(r.passed, false);
  assert.match(r.results[0].reason, /no upstream/);
  assert.match(runGates({ gates: [{ id: "pushed", type: "pushed", ref: "origin/nope" }] }, dir).results[0].reason, /cannot resolve origin\/nope/);
});

// ---- commit-messages --------------------------------------------------------

test("commit-messages: every non-merge subject since the base must match", () => {
  const [dir, base] = gitProject({ "a.txt": "1\n" });
  const spec: Spec = { gates: [{ id: "conventional", type: "commit-messages", pattern: "^(feat|fix|docs|chore)(\\(.+\\))?: " }] };
  assert.match(runGates(spec, dir, { baseRef: base }).results[0].reason, /no commits since/);
  write(dir, { "a.txt": "2\n" });
  git(dir, ["commit", "-qam", "feat: add a"]);
  assert.equal(runGates(spec, dir, { baseRef: base }).passed, true);
  write(dir, { "a.txt": "3\n" });
  git(dir, ["commit", "-qam", "wip"]);
  const r = runGates(spec, dir, { baseRef: base });
  assert.equal(r.passed, false);
  assert.match(r.results[0].reason, /1 of 2 commit message\(s\) since .* do not match .*: [0-9a-f]{12} "wip"/);
  assert.match(runGates(spec, dir).results[0].reason, /fail-closed/);
  assert.throws(() => parseSpec(JSON.stringify({ gates: [{ id: "c", type: "commit-messages", pattern: "(" }] }), "t", true), /invalid regex/);
});

// ---- evidence newerThan -----------------------------------------------------

test("evidence newerThan: evidence written before the last source change is stale", () => {
  const dir = tmpProject({ "src/a.ts": "x\n", "src/b.ts": "y\n", ".skillgate/evidence/test.txt": "ok\n" });
  const evidence = path.join(dir, ".skillgate/evidence/test.txt");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dir, "src/a.ts"), old, old);
  fs.utimesSync(path.join(dir, "src/b.ts"), old, old);
  const spec: Spec = { gates: [{ id: "tests-ran", type: "evidence", file: ".skillgate/evidence/test.txt", newerThan: "src/**" }] };
  assert.match(runGates(spec, dir).results[0].reason, /evidence present and newer than src\/\*\*/);
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(dir, "src/b.ts"), later, later);
  const r = runGates(spec, dir);
  assert.equal(r.passed, false);
  assert.match(r.results[0].reason, /evidence is stale: 1 file\(s\) matching src\/\*\* changed after .*test\.txt was written: src\/b\.ts/);
  const ignored = runGates({ gates: [{ ...spec.gates[0], ignore: ["src/b.ts"] } as any] }, dir);
  assert.equal(ignored.passed, true);
  fs.utimesSync(evidence, new Date(Date.now() + 120_000), new Date(Date.now() + 120_000));
  assert.equal(runGates(spec, dir).passed, true);
});

// ---- level: warn --------------------------------------------------------------

test("level warn: a failing gate is reported but never fails the run or blocks", () => {
  const dir = tmpProject({ "a.txt": "1\n", ".skillgate/done.yaml": "finishLine: [\"git push\"]\ngates:\n  - id: readme\n    type: file-exists\n    file: README.md\n    level: warn\n" });
  const r = runGates({ gates: [{ id: "readme", type: "file-exists", file: "README.md", level: "warn" }] }, dir);
  assert.equal(r.passed, true);
  assert.equal(r.failed.length, 0);
  assert.equal(r.results[0].status, "warn");
  assert.match(r.results[0].reason, /^warning: /);
  const check = sg(["check"], dir);
  assert.equal(check.status, 0);
  assert.match(check.stdout, /! readme/);
  assert.match(check.stdout, /\(1 warning\)/);
  assert.equal(sg(["gate", "--command", "git push", "--json"], dir).status, 0);
  assert.throws(() => parseSpec(JSON.stringify({ gates: [{ id: "x", type: "file-exists", file: "a", level: "soft" }] }), "t", true), /level must be block or warn/);
});

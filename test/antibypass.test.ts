// Unit tests for the anti-bypass / diff-aware layer: git plumbing, the no-new and
// no-deleted gates (which compare the working tree to a git base ref), and the
// harness-neutral decideCommand verdict. Fixtures are real throwaway git repos.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runGates, decideCommand } from "../src/core.js";
import {
  globToRegExp,
  matchesGlob,
  resolveBaseRef,
  mergeBase,
  readFileAtRef,
  listFilesAtRef,
  gitAvailable,
  repoRoot,
} from "../src/git.js";
import type { Spec } from "../src/spec.js";

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t.dev", "-c", "user.name=t", ...args], {
    cwd: dir,
    stdio: "pipe",
    encoding: "utf8",
  });
}

/** A throwaway git repo on branch `main` with `files` committed as the base. */
function gitProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-git-"));
  git(dir, ["init", "-q", "-b", "main"]);
  write(dir, files);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

// ---- globToRegExp / matchesGlob ---------------------------------------------

test("globToRegExp: **, *, ?, and {a,b} alternation", () => {
  assert.ok(globToRegExp("**/*.test.ts").test("test/deep/a.test.ts"));
  assert.ok(globToRegExp("**/*.ts").test("a.ts")); // ** collapses at root
  assert.ok(globToRegExp("src/*.ts").test("src/a.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/deep/a.ts")); // * stops at /
  assert.ok(globToRegExp("src/**/*.{ts,js}").test("src/x/y.js"));
  assert.ok(!globToRegExp("src/**/*.{ts,js}").test("src/x/y.py"));
  assert.ok(globToRegExp("a?c.ts").test("abc.ts"));
  assert.ok(!globToRegExp("a?c.ts").test("a/c.ts"));
});

test("matchesGlob: honours ignore globs", () => {
  assert.ok(matchesGlob("test/a.test.ts", "test/**/*.test.ts"));
  assert.ok(!matchesGlob("test/a.test.ts", "test/**/*.test.ts", ["**/a.test.ts"]));
});

// ---- git plumbing ------------------------------------------------------------

test("git plumbing: availability, root, read + list at a ref", () => {
  const dir = gitProject({ "src/a.ts": "export const a = 1\n", "README.md": "hi\n" });
  assert.equal(gitAvailable(dir), true);
  assert.equal(repoRoot(dir), fs.realpathSync(dir));
  assert.equal(readFileAtRef(dir, "HEAD", "src/a.ts"), "export const a = 1\n");
  assert.equal(readFileAtRef(dir, "HEAD", "does/not/exist.ts"), null);
  const files = listFilesAtRef(dir, "HEAD");
  assert.ok(files.includes("src/a.ts") && files.includes("README.md"));
});

test("git plumbing: non-repo dir is safely empty, never throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-nogit-"));
  assert.equal(gitAvailable(dir), false);
  assert.equal(repoRoot(dir), null);
  assert.equal(resolveBaseRef(dir), null);
  assert.equal(readFileAtRef(dir, "HEAD", "x"), null);
  assert.deepEqual(listFilesAtRef(dir, "HEAD"), []);
});

test("resolveBaseRef: explicit request wins; mergeBase finds the fork point", () => {
  const dir = gitProject({ "a.txt": "1\n" });
  assert.equal(resolveBaseRef(dir, "HEAD"), "HEAD");
  // branch off, advance main, then merge-base(main, HEAD) == the fork commit.
  const fork = git(dir, ["rev-parse", "HEAD"]).trim();
  git(dir, ["checkout", "-q", "-b", "feature"]);
  write(dir, { "b.txt": "2\n" });
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "feature work"]);
  assert.equal(mergeBase(dir, "main"), fork);
});

test("resolveBaseRef: SKILLGATE_BASE env is honoured", () => {
  const dir = gitProject({ "a.txt": "1\n" });
  const prev = process.env.SKILLGATE_BASE;
  process.env.SKILLGATE_BASE = "main";
  try {
    assert.equal(resolveBaseRef(dir), "main");
  } finally {
    if (prev === undefined) delete process.env.SKILLGATE_BASE;
    else process.env.SKILLGATE_BASE = prev;
  }
});

// ---- no-new gate -------------------------------------------------------------

const skipSpec: Spec = {
  gates: [{ id: "no-new-skips", type: "no-new", glob: "**/*.test.ts", pattern: "\\.(skip|only)\\(" }],
};

test("no-new: passes when a skip count does not increase", () => {
  const dir = gitProject({ "a.test.ts": "test('x', () => {})\n" });
  const r = runGates(skipSpec, dir, { baseRef: "HEAD" });
  assert.equal(r.passed, true, r.failed[0]?.reason);
});

test("no-new: fails when the working tree adds a skip (modified file)", () => {
  const dir = gitProject({ "a.test.ts": "test('x', () => {})\n" });
  write(dir, { "a.test.ts": "test.skip('x', () => {})\n" });
  const r = runGates(skipSpec, dir, { baseRef: "HEAD" });
  assert.equal(r.passed, false);
  assert.match(r.failed[0].reason, /\+1 new/);
  assert.match(r.failed[0].reason, /a\.test\.ts:1/);
});

test("no-new: fails when a brand-new untracked file introduces a skip", () => {
  const dir = gitProject({ "a.test.ts": "test('x', () => {})\n" });
  write(dir, { "b.test.ts": "test.skip('y', () => {})\n" }); // untracked, not in base
  const r = runGates(skipSpec, dir, { baseRef: "HEAD" });
  assert.equal(r.passed, false);
  assert.match(r.failed[0].reason, /b\.test\.ts/);
});

test("no-new: removing a skip keeps it passing (count decreased)", () => {
  const dir = gitProject({ "a.test.ts": "test.skip('x', () => {})\n" });
  write(dir, { "a.test.ts": "test('x', () => {})\n" });
  assert.equal(runGates(skipSpec, dir, { baseRef: "HEAD" }).passed, true);
});

test("no-new: fails closed with no base ref", () => {
  const dir = gitProject({ "a.test.ts": "test('x', () => {})\n" });
  const r = runGates(skipSpec, dir, {});
  assert.equal(r.passed, false);
  assert.match(r.failed[0].reason, /fail-closed/);
});

// ---- no-deleted gate ---------------------------------------------------------

const noDeletedSpec: Spec = {
  gates: [{ id: "keep-tests", type: "no-deleted", glob: "test/**/*.test.ts" }],
};

test("no-deleted: fails when a base test file is removed", () => {
  const dir = gitProject({ "test/a.test.ts": "1\n", "test/b.test.ts": "2\n" });
  fs.rmSync(path.join(dir, "test/a.test.ts"));
  const r = runGates(noDeletedSpec, dir, { baseRef: "HEAD" });
  assert.equal(r.passed, false);
  assert.match(r.failed[0].reason, /a\.test\.ts/);
});

test("no-deleted: passes when nothing matching was removed", () => {
  const dir = gitProject({ "test/a.test.ts": "1\n", "src/x.ts": "2\n" });
  fs.rmSync(path.join(dir, "src/x.ts")); // not in the glob
  assert.equal(runGates(noDeletedSpec, dir, { baseRef: "HEAD" }).passed, true);
});

test("no-deleted: fails closed with no base ref", () => {
  const dir = gitProject({ "test/a.test.ts": "1\n" });
  const r = runGates(noDeletedSpec, dir, {});
  assert.equal(r.passed, false);
  assert.match(r.failed[0].reason, /fail-closed/);
});

// ---- decideCommand (harness-neutral entrypoint) ------------------------------

const finishSpec: Spec = {
  finishLine: ["git commit"],
  gates: [{ id: "no-new-skips", type: "no-new", glob: "**/*.test.ts", pattern: "\\.skip\\(" }],
};

test("decideCommand: allows a command that is not a finish line", () => {
  const dir = gitProject({ "a.test.ts": "test.skip('x', () => {})\n" });
  const d = decideCommand(finishSpec, dir, "ls -la", { baseRef: "HEAD" });
  assert.equal(d.decision, "allow");
  assert.match(d.reason, /not a finish-line/);
});

test("decideCommand: blocks a finish-line command when a gate fails", () => {
  const dir = gitProject({ "a.test.ts": "test('x', () => {})\n" });
  write(dir, { "a.test.ts": "test.skip('x', () => {})\n" });
  const d = decideCommand(finishSpec, dir, "git commit -m wip", { baseRef: "HEAD" });
  assert.equal(d.decision, "block");
  assert.match(d.reason, /no-new-skips/);
});

test("decideCommand: allows a finish-line command when every gate passes", () => {
  const dir = gitProject({ "a.test.ts": "test('x', () => {})\n" });
  const d = decideCommand(finishSpec, dir, "git commit -m ok", { baseRef: "HEAD" });
  assert.equal(d.decision, "allow");
  assert.match(d.reason, /gates passed/);
});

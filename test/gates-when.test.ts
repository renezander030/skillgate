// Engine tests for no-fewer, no-op glob detection, deps-locked, conditional
// (`when`) gates and pattern-gate scan limits. Diff-aware cases use real git repos.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runGates, decideCommand } from "../src/core.js";
import { parseSpec, type Spec } from "../src/spec.js";
import { resolveBaseRef, EMPTY_TREE } from "../src/git.js";

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-when-"));
  write(dir, files);
  return dir;
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t.dev", "-c", "user.name=t", ...args], { cwd: dir, encoding: "utf8", stdio: "pipe" });
}

function gitProject(files: Record<string, string>): { dir: string; base: string } {
  const dir = tmpProject(files);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return { dir, base: git(dir, ["rev-parse", "HEAD"]).trim() };
}

test("no-fewer: fails when a test case is deleted from a file that still exists", (t) => {
  const { dir, base } = gitProject({ "a.test.ts": "test('one', () => {})\ntest('two', () => {})\n" });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spec: Spec = { gates: [{ id: "tests-kept", type: "no-fewer", glob: "**/*.test.ts", pattern: "^\\s*test\\(" }] };
  assert.equal(runGates(spec, dir, { baseRef: base }).passed, true);

  write(dir, { "a.test.ts": "test('one', () => {})\n" });
  const r = runGates(spec, dir, { baseRef: base });
  assert.equal(r.passed, false);
  assert.match(r.failed[0].reason, /-1 .*base 2, now 1.*a\.test\.ts/);
  assert.deepEqual(r.failed[0].location, { file: "a.test.ts" });

  write(dir, { "a.test.ts": "test('one', () => {})\ntest('two', () => {})\ntest('three', () => {})\n" });
  assert.equal(runGates(spec, dir, { baseRef: base }).passed, true);
});

test("no-fewer: fails closed without a base ref", () => {
  const dir = tmpProject({ "a.test.ts": "test('x', () => {})\n" });
  const r = runGates({ gates: [{ id: "k", type: "no-fewer", glob: "*.test.ts", pattern: "test\\(" }] }, dir);
  assert.equal(r.passed, false);
  assert.match(r.failed[0].reason, /fail-closed/);
});

test("glob gates fail as no-ops when the glob matches nothing, unless allowEmpty", () => {
  const dir = tmpProject({ "src/a.ts": "ok\n" });
  const typo: Spec = { gates: [{ id: "no-todo", type: "absent", glob: "scr/**/*.ts", pattern: "TODO" }] };
  const r = runGates(typo, dir);
  assert.equal(r.passed, false);
  assert.match(r.failed[0].reason, /matches no files.*no-op/);

  const allowed: Spec = { gates: [{ id: "no-todo", type: "absent", glob: "scr/**/*.ts", pattern: "TODO", allowEmpty: true }] };
  assert.equal(runGates(allowed, dir).passed, true);
  assert.equal(runGates(typo, dir, { allowEmptyGlobs: true }).passed, true);
  assert.match(runGates({ gates: [{ id: "n", type: "absent", glob: "src/**/*.ts", pattern: "TODO" }] }, dir).results[0].reason, /1 files/);
});

test("no-deleted and no-new report a no-op glob against the base and the working tree", (t) => {
  const { dir, base } = gitProject({ "tests/a.test.ts": "test('x')\n" });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = runGates({
    gates: [
      { id: "kept", type: "no-deleted", glob: "test/**/*.ts" },
      { id: "skips", type: "no-new", glob: "test/**/*.ts", pattern: "\\.skip" },
      { id: "ok", type: "no-deleted", glob: "tests/**/*.ts" },
    ],
  }, dir, { baseRef: base });
  assert.deepEqual(r.failed.map((f) => f.id), ["kept", "skips"]);
});

test("deps-locked: package.json dependencies must be in package-lock.json", () => {
  const dir = tmpProject({
    "package.json": JSON.stringify({ dependencies: { yaml: "^2" }, devDependencies: { "@types/node": "^20", "left-padz": "1.0.0", local: "file:../local" } }),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/yaml": {}, "node_modules/@types/node": {} } }),
  });
  const spec: Spec = { gates: [{ id: "deps", type: "deps-locked" }] };
  const r = runGates(spec, dir);
  assert.equal(r.passed, false);
  assert.match(r.failed[0].reason, /1 declared dependency is not in package-lock\.json: left-padz/);
  assert.deepEqual(r.failed[0].location, { file: "package.json" });

  write(dir, { "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/yaml": {}, "node_modules/@types/node": {}, "node_modules/left-padz": {} } }) });
  assert.equal(runGates(spec, dir).passed, true);
});

test("deps-locked: yarn, pnpm and bun lockfiles", () => {
  const pkg = JSON.stringify({ dependencies: { "@scope/pkg": "^1", lodash: "^4" } });
  const yarn = tmpProject({ "package.json": pkg, "yarn.lock": '"@scope/pkg@^1":\n  version "1.0.0"\n\nlodash@^4:\n  version "4.17.21"\n' });
  assert.equal(runGates({ gates: [{ id: "d", type: "deps-locked" }] }, yarn).passed, true);

  const pnpm = tmpProject({ "package.json": pkg, "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      lodash:\n        specifier: ^4\n        version: 4.17.21\n" });
  const r = runGates({ gates: [{ id: "d", type: "deps-locked" }] }, pnpm);
  assert.equal(r.passed, false);
  assert.match(r.failed[0].reason, /@scope\/pkg/);

  const bun = tmpProject({ "package.json": pkg, "bun.lock": '{ "packages": { "lodash": ["lodash@4.17.21"], "@scope/pkg": ["@scope/pkg@1.0.0"] } }' });
  assert.equal(runGates({ gates: [{ id: "d", type: "deps-locked" }] }, bun).passed, true);
});

test("deps-locked: pyproject.toml against uv.lock and poetry.lock with normalized names", () => {
  const pyproject = [
    "[project]",
    'name = "demo"',
    "dependencies = [",
    '  "Requests>=2",',
    '  "typing_extensions; python_version < \'3.11\'",',
    "]",
    "",
    "[project.optional-dependencies]",
    'dev = ["pytest>=8"]',
    "",
  ].join("\n");
  const dir = tmpProject({
    "pyproject.toml": pyproject,
    "uv.lock": '[[package]]\nname = "requests"\n\n[[package]]\nname = "typing-extensions"\n',
  });
  const r = runGates({ gates: [{ id: "d", type: "deps-locked" }] }, dir);
  assert.equal(r.passed, false);
  assert.match(r.failed[0].reason, /pytest/);

  const poetry = tmpProject({
    "pyproject.toml": '[tool.poetry.dependencies]\npython = "^3.11"\nhttpx = "^0.27"\n',
    "poetry.lock": '[[package]]\nname = "httpx"\n',
  });
  assert.equal(runGates({ gates: [{ id: "d", type: "deps-locked" }] }, poetry).passed, true);
});

test("deps-locked: fails closed with no manifest or no lockfile", () => {
  assert.match(runGates({ gates: [{ id: "d", type: "deps-locked" }] }, tmpProject({ "a.txt": "" })).failed[0].reason, /no supported manifest/);
  const dir = tmpProject({ "package.json": JSON.stringify({ dependencies: { yaml: "^2" } }) });
  assert.match(runGates({ gates: [{ id: "d", type: "deps-locked" }] }, dir).failed[0].reason, /no lockfile/);
});

test("when.command: a push-only gate is skipped for commit and required for push", () => {
  const dir = tmpProject({ "a.txt": "x" });
  const spec: Spec = {
    finishLine: ["git commit", "git push"],
    gates: [
      { id: "fast", type: "file-exists", file: "a.txt" },
      { id: "slow", type: "file-exists", file: "release-notes.md", when: { command: ["git push"] } },
    ],
  };
  const commit = decideCommand(spec, dir, "git commit -m x");
  assert.equal(commit.decision, "allow");
  assert.equal(commit.result?.results.find((r) => r.id === "slow")?.status, "skipped");
  assert.equal(decideCommand(spec, dir, "git push origin main").decision, "block");
  // No command (plain `check`) = every gate applies.
  assert.equal(runGates(spec, dir).passed, false);
});

test("when.branch: gate runs only on matching branches; unknown branch runs it", (t) => {
  const { dir } = gitProject({ "a.txt": "x" });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spec: Spec = { gates: [{ id: "release-only", type: "file-exists", file: "CHANGELOG.md", when: { branch: ["release/*"] } }] };
  assert.equal(runGates(spec, dir).results[0].status, "skipped");
  git(dir, ["checkout", "-q", "-b", "release/1.0"]);
  assert.equal(runGates(spec, dir).passed, false);
  const outside = tmpProject({ "a.txt": "x" });
  const saved = { ...process.env };
  delete process.env.GITHUB_HEAD_REF;
  delete process.env.GITHUB_REF_NAME;
  delete process.env.SKILLGATE_BRANCH;
  try {
    assert.equal(runGates(spec, outside).passed, false);
  } finally {
    Object.assign(process.env, saved);
  }
});

test("when.changed: gate runs only when a matching file changed vs base; no base runs it", (t) => {
  const { dir, base } = gitProject({ "src/a.py": "x = 1\n", "docs/a.md": "hi\n" });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spec: Spec = { gates: [{ id: "py", type: "file-exists", file: "missing.txt", when: { changed: ["**/*.py"] } }] };
  write(dir, { "docs/a.md": "changed\n" });
  assert.equal(runGates(spec, dir, { baseRef: base }).results[0].status, "skipped");
  write(dir, { "src/b.py": "new\n" });
  assert.equal(runGates(spec, dir, { baseRef: base }).passed, false);
  assert.equal(runGates(spec, dir).passed, false);
});

test("when is validated: unknown keys and empty blocks are rejected", () => {
  assert.throws(() => parseSpec("gates:\n  - id: a\n    type: evidence\n    file: x\n    when: { comand: [git push] }\n", "t", false), /unknown field/);
  assert.throws(() => parseSpec("gates:\n  - id: a\n    type: evidence\n    file: x\n    when: {}\n", "t", false), /at least one/);
  assert.doesNotThrow(() => parseSpec("gates:\n  - id: a\n    type: no-fewer\n    glob: '*.ts'\n    pattern: x\n    maxBytes: 10\n    allowEmpty: true\n    when: { branch: [main] }\n", "t", false));
  assert.throws(() => parseSpec("gates:\n  - id: a\n    type: file-exists\n    file: x\n    maxBytes: 10\n", "t", false), /unknown field/);
});

test("scan limit: an oversized file fails the pattern gate instead of being read", () => {
  const dir = tmpProject({ "big.txt": "x".repeat(2048), "small.txt": "ok\n" });
  const r = runGates({ gates: [{ id: "a", type: "absent", glob: "*.txt", pattern: "SECRET", maxBytes: 1024 }] }, dir);
  assert.equal(r.passed, false);
  assert.match(r.failed[0].reason, /big\.txt is 2048 bytes, over the 1024-byte scan limit/);
  const fc = runGates({ gates: [{ id: "f", type: "file-contains", file: "big.txt", pattern: "x", maxBytes: 1024 }] }, dir);
  assert.match(fc.failed[0].reason, /scan limit/);
});

test("absent reports a file:line location for annotations", () => {
  const dir = tmpProject({ "src/a.ts": "ok\n// TODO fix\n" });
  const r = runGates({ gates: [{ id: "t", type: "absent", glob: "src/*.ts", pattern: "TODO" }] }, dir);
  assert.deepEqual(r.failed[0].location, { file: "src/a.ts", line: 2 });
});

test("a repository with no commits judges diff gates against the empty tree", (t) => {
  const dir = tmpProject({ "test/a.test.ts": "test('x', () => {})\n", "src/a.ts": "ok\n" });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "main"]);
  const saved = process.env.SKILLGATE_BASE;
  delete process.env.SKILLGATE_BASE;
  try {
    const base = resolveBaseRef(dir);
    assert.equal(base, EMPTY_TREE);
    const r = runGates({
      gates: [
        { id: "kept", type: "no-deleted", glob: "test/**" },
        { id: "not-fewer", type: "no-fewer", glob: "test/**", pattern: "test\\(" },
        { id: "no-skips", type: "no-new", glob: "test/**", pattern: "\\.skip\\(" },
        { id: "src-only", type: "file-exists", file: "src/a.ts", when: { changed: ["src/**"] } },
      ],
    }, dir, { baseRef: base! });
    assert.equal(r.passed, true, JSON.stringify(r.failed));
    assert.match(r.results[0].reason, /empty tree/);
    assert.equal(r.results[3].status, "pass");
    // An explicit base that does not resolve still fails closed.
    assert.equal(resolveBaseRef(dir, "origin/nope"), null);
  } finally {
    if (saved != null) process.env.SKILLGATE_BASE = saved;
  }
});

test("a repository with history never falls back to the empty tree", (t) => {
  const { dir } = gitProject({ "a.txt": "x" });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ["checkout", "-q", "--orphan", "fresh"]);
  assert.equal(resolveBaseRef(dir), "main");
});

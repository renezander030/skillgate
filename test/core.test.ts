import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGates, isFinishLine } from "../src/core.js";
import type { Spec } from "../src/spec.js";

function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test("file-exists: passes when present, fails when missing", () => {
  const dir = tmpProject({ "README.md": "hi" });
  const spec: Spec = {
    gates: [
      { id: "have-readme", type: "file-exists", file: "README.md" },
      { id: "have-license", type: "file-exists", file: "LICENSE" },
    ],
  };
  const r = runGates(spec, dir);
  assert.equal(r.passed, false);
  assert.equal(r.results.find((x) => x.id === "have-readme")?.ok, true);
  assert.equal(r.results.find((x) => x.id === "have-license")?.ok, false);
});

test("file-contains: regex with flags", () => {
  const dir = tmpProject({ "CHANGELOG.md": "## Unreleased\n- thing" });
  const spec: Spec = {
    gates: [{ id: "changelog", type: "file-contains", file: "CHANGELOG.md", pattern: "unreleased", flags: "i" }],
  };
  assert.equal(runGates(spec, dir).passed, true);
});

test("absent: catches a secret and reports file:line", () => {
  const dir = tmpProject({ "src/a.ts": "const ok = 1\n", "src/b.ts": "const k = 'sk_live_abc'\n" });
  const spec: Spec = {
    gates: [{ id: "no-secrets", type: "absent", glob: "src/**/*.ts", pattern: "sk_live_" }],
  };
  const r = runGates(spec, dir);
  assert.equal(r.passed, false);
  assert.match(r.failed[0].reason, /b\.ts:1/);
});

test("absent: passes when clean", () => {
  const dir = tmpProject({ "src/a.ts": "const ok = 1\n" });
  const spec: Spec = {
    gates: [{ id: "no-todo", type: "absent", glob: "src/**/*.ts", pattern: "TODO" }],
  };
  assert.equal(runGates(spec, dir).passed, true);
});

test("command: pass on exit 0, fail on nonzero", () => {
  const dir = tmpProject({});
  assert.equal(runGates({ gates: [{ id: "ok", type: "command", run: "true" }] }, dir).passed, true);
  assert.equal(runGates({ gates: [{ id: "bad", type: "command", run: "false" }] }, dir).passed, false);
});

test("evidence: requires a non-empty file", () => {
  const dir = tmpProject({ "notes.md": "found it" });
  assert.equal(runGates({ gates: [{ id: "e", type: "evidence", file: "notes.md" }] }, dir).passed, true);
  assert.equal(runGates({ gates: [{ id: "e", type: "evidence", file: "missing.md" }] }, dir).passed, false);
});

test("isFinishLine: substring match against patterns", () => {
  assert.equal(isFinishLine("git commit -m x", ["git commit", "git push"]), true);
  assert.equal(isFinishLine("ls -la", ["git commit"]), false);
  assert.equal(isFinishLine("anything", undefined), false);
});

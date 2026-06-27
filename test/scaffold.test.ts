import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runScaffold } from "../src/scaffold.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-scaffold-"));
}

test("scaffold: creates evidence directory and files for generic template", () => {
  const dir = tmpDir();
  try {
    const result = runScaffold({ cwd: dir, template: "generic" });
    assert.ok(result.created > 0);
    assert.ok(fs.existsSync(path.join(dir, ".skillgate", "evidence", "test-output.txt")));
    assert.ok(fs.existsSync(path.join(dir, ".skillgate", "evidence", "lint-report.txt")));
    assert.ok(fs.existsSync(path.join(dir, ".skillgate", "evidence", "diff-review.md")));
    assert.ok(fs.existsSync(path.join(dir, ".skillgate", "evidence", "README.md")));
    assert.match(result.lines[0], /\+ .skillgate\/evidence\//);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scaffold: template react creates react-specific files", () => {
  const dir = tmpDir();
  try {
    const result = runScaffold({ cwd: dir, template: "react" });
    assert.ok(result.created >= 4);
    assert.ok(fs.existsSync(path.join(dir, ".skillgate", "evidence", "typecheck-output.txt")));
    assert.ok(fs.existsSync(path.join(dir, ".skillgate", "evidence", "lint-report.txt")));
    assert.ok(fs.existsSync(path.join(dir, ".skillgate", "evidence", "test-output.txt")));
    assert.ok(fs.existsSync(path.join(dir, ".skillgate", "evidence", "diff-review.md")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scaffold: template ts-lib creates ts-lib-specific files", () => {
  const dir = tmpDir();
  try {
    const result = runScaffold({ cwd: dir, template: "ts-lib" });
    assert.ok(result.created >= 5);
    assert.ok(fs.existsSync(path.join(dir, ".skillgate", "evidence", "coverage-summary.txt")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scaffold: template python creates python-specific files", () => {
  const dir = tmpDir();
  try {
    const result = runScaffold({ cwd: dir, template: "python" });
    assert.ok(result.created >= 4);
    assert.ok(fs.existsSync(path.join(dir, ".skillgate", "evidence", "typecheck-output.txt")));
    assert.ok(fs.existsSync(path.join(dir, ".skillgate", "evidence", "test-output.txt")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scaffold: unknown template throws", () => {
  const dir = tmpDir();
  try {
    assert.throws(() => runScaffold({ cwd: dir, template: "nonexistent" }), /unknown template/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scaffold: idempotent — second run creates nothing new", () => {
  const dir = tmpDir();
  try {
    const first = runScaffold({ cwd: dir, template: "generic" });
    assert.ok(first.created > 0);
    const second = runScaffold({ cwd: dir, template: "generic" });
    assert.equal(second.created, 0);
    assert.match(second.lines.join(" "), /nothing to create/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scaffold: --update-agents updates existing AGENTS.md", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Existing instructions\n");
    const result = runScaffold({ cwd: dir, template: "generic", updateAgents: true });
    const content = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    assert.ok(content.includes("skillgate evidence workflow"));
    assert.ok(content.includes("# Existing instructions"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scaffold: --update-agents creates AGENTS.md if absent", () => {
  const dir = tmpDir();
  try {
    const result = runScaffold({ cwd: dir, template: "generic", updateAgents: true });
    assert.ok(fs.existsSync(path.join(dir, "AGENTS.md")));
    const content = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    assert.ok(content.includes("skillgate evidence workflow"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scaffold: --update-agents is idempotent on AGENTS.md", () => {
  const dir = tmpDir();
  try {
    runScaffold({ cwd: dir, template: "generic", updateAgents: true });
    const firstCount = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8").split("\n").length;
    runScaffold({ cwd: dir, template: "generic", updateAgents: true });
    const secondCount = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8").split("\n").length;
    assert.equal(firstCount, secondCount, "must not append a second time");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scaffold: warns when done.yaml lacks evidence gates", () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, ".skillgate"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".skillgate", "done.yaml"), "gates:\n  - id: tests\n    type: command\n    run: 'true'\n");
    const result = runScaffold({ cwd: dir, template: "generic" });
    assert.match(result.lines.join(" "), /needs evidence gates/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
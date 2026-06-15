import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkDrift, similarity, normalize } from "../src/drift.js";
import { runSync } from "../src/link.js";
import { runGates } from "../src/core.js";

function tmpRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-drift-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test("identical files are in sync", () => {
  const body = "# Rules\n\nAlways write tests.\nNo secrets in code.\n";
  const dir = tmpRepo({ "AGENTS.md": body, "CLAUDE.md": body });
  const res = checkDrift(dir);
  assert.equal(res.drifted, 0);
  assert.equal(res.canonical, "AGENTS.md");
  const claude = res.entries.find((e) => e.tool === "Claude Code");
  assert.equal(claude?.status, "in sync");
});

test("a divergent file is reported as drifted", () => {
  const dir = tmpRepo({
    "AGENTS.md": "# Rules\nAlways write tests.\nNo secrets.\nUse TypeScript.\n",
    ".github/copilot-instructions.md": "# Totally different\nShip fast.\nSkip the tests.\n",
  });
  const res = checkDrift(dir);
  assert.equal(res.drifted, 1);
  const copilot = res.entries.find((e) => e.tool === "GitHub Copilot");
  assert.equal(copilot?.status, "drifted");
});

test("@AGENTS.md pointer counts as linked, not drifted", () => {
  const dir = tmpRepo({
    "AGENTS.md": "# Rules\nLots of guidance here.\nMany lines.\nMore lines.\n",
    "CLAUDE.md": "@AGENTS.md\n",
  });
  const res = checkDrift(dir);
  assert.equal(res.drifted, 0);
  const claude = res.entries.find((e) => e.tool === "Claude Code");
  assert.equal(claude?.status, "linked");
});

test("Cursor .mdc frontmatter is ignored in comparison", () => {
  const body = "Always write tests.\nNo secrets in code.\n";
  const dir = tmpRepo({
    "AGENTS.md": body,
    ".cursor/rules/main.mdc": "---\nalwaysApply: true\n---\n" + body,
  });
  const res = checkDrift(dir);
  const cursor = res.entries.find((e) => e.tool === "Cursor");
  assert.equal(cursor?.status, "in sync");
});

test("instruction-sync gate fails on drift and passes after sync", () => {
  const dir = tmpRepo({
    "AGENTS.md": "# Rules\nAlways write tests.\nNo secrets.\nUse TypeScript.\n",
    ".github/copilot-instructions.md": "# Different\nShip fast.\nSkip tests.\n",
  });
  const spec = { gates: [{ id: "agents-in-sync", type: "instruction-sync" as const }] };

  const before = runGates(spec, dir);
  assert.equal(before.passed, false);
  assert.match(before.failed[0].reason, /drifted/);

  runSync(dir, {});
  const after = runGates(spec, dir);
  assert.equal(after.passed, true, after.failed.map((f) => f.reason).join("; "));
});

test("similarity and normalize behave at the edges", () => {
  assert.equal(similarity([], []), 1);
  assert.equal(similarity(["a"], []), 0);
  assert.deepEqual(normalize("---\nx: 1\n---\n\n  hello  \n\n"), ["hello"]);
});

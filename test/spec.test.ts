import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSpec, SPEC_VERSION } from "../src/spec.js";

function tmpSpec(content: string, name = "done.yaml"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-spec-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

test("loadSpec: accepts a spec with no version (backward compatible)", () => {
  const p = tmpSpec("gates:\n  - id: r\n    type: file-exists\n    file: README.md\n");
  const spec = loadSpec(p);
  assert.equal(spec.version, undefined);
  assert.equal(spec.gates.length, 1);
});

test("loadSpec: accepts the current spec version", () => {
  const p = tmpSpec(`version: ${SPEC_VERSION}\ngates:\n  - id: r\n    type: file-exists\n    file: README.md\n`);
  assert.equal(loadSpec(p).version, SPEC_VERSION);
});

test("loadSpec: rejects a non-integer version", () => {
  const p = tmpSpec("version: 1.5\ngates: []\n");
  assert.throws(() => loadSpec(p), /version.*must be an integer/);
});

test("loadSpec: throws when gates array is missing", () => {
  const p = tmpSpec("name: broken\n");
  assert.throws(() => loadSpec(p), /missing "gates" array/);
});

test("loadSpec: parses a .json spec", () => {
  const p = tmpSpec(JSON.stringify({ gates: [{ id: "r", type: "file-exists", file: "README.md" }] }), "done.json");
  assert.equal(loadSpec(p).gates[0].id, "r");
});

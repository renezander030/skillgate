import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findSpecPath, loadSpec, parseSpec, specRoot, SPEC_VERSION } from "../src/spec.js";

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
  const p = tmpSpec("version: 1.5\ngates:\n  - id: r\n    type: file-exists\n    file: README.md\n");
  assert.throws(() => loadSpec(p), /version.*must be a positive integer/);
});

test("loadSpec: fails closed on a newer spec version", () => {
  const p = tmpSpec(`version: ${SPEC_VERSION + 1}\ngates:\n  - id: r\n    type: file-exists\n    file: README.md\n`);
  assert.throws(() => loadSpec(p), /newer than supported.*upgrade skillgate/);
});

test("loadSpec: throws when gates array is missing", () => {
  const p = tmpSpec("name: broken\n");
  assert.throws(() => loadSpec(p), /gates.*non-empty array/);
});

test("loadSpec: parses a .json spec", () => {
  const p = tmpSpec(JSON.stringify({ gates: [{ id: "r", type: "file-exists", file: "README.md" }] }), "done.json");
  assert.equal(loadSpec(p).gates[0].id, "r");
});

test("parseSpec rejects unknown fields, duplicate ids, unsupported types, and invalid regexes", () => {
  const cases = [
    ["gates:\n  - id: x\n    type: file-exists\n    file: x\nunknown: true\n", /unknown field.*unknown/],
    ["gates:\n  - id: x\n    type: file-exists\n    file: x\n    typo: true\n", /gates\[0\].*typo/],
    ["gates:\n  - id: x\n    type: file-exists\n    file: x\n  - id: x\n    type: evidence\n    file: y\n", /duplicate id: x/],
    ["gates:\n  - id: x\n    type: mystery\n", /unsupported: mystery/],
    ["gates:\n  - id: x\n    type: absent\n    glob: '**/*'\n    pattern: '['\n", /invalid regex/],
  ] as const;
  for (const [raw, expected] of cases) assert.throws(() => parseSpec(raw, "fixture", false), expected);
});

test("parseSpec validates every supported gate shape and top-level timeout", () => {
  const value = {
    timeout: 5000,
    finishLine: ["git push"],
    gates: [
      { id: "a", type: "file-exists", file: ["a", "b"] },
      { id: "b", type: "file-contains", file: "a", pattern: "x", flags: "i" },
      { id: "c", type: "absent", glob: "**/*", pattern: "x", ignore: [] },
      { id: "d", type: "command", run: "true", timeout: 10 },
      { id: "e", type: "trivy", scanners: ["secret"], severity: ["HIGH"], sbom: false, ignoreUnfixed: true },
      { id: "f", type: "evidence", file: "evidence.txt" },
      { id: "g", type: "instruction-sync", threshold: 0.9 },
      { id: "h", type: "not-empty", path: "docs", min: 2 },
      { id: "i", type: "no-new", glob: "**/*", pattern: "skip", ignore: [] },
      { id: "j", type: "no-deleted", glob: "test/**", ignore: [] },
    ],
  };
  assert.equal(parseSpec(JSON.stringify(value), "fixture.json", true).gates.length, 10);
});

test("findSpecPath walks to the active worktree root but never beyond a nested checkout", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-worktree-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, ".skillgate"));
  fs.writeFileSync(path.join(root, ".skillgate", "done.yaml"), "gates:\n  - id: x\n    type: file-exists\n    file: x\n");
  const nested = path.join(root, "packages", "app", "src");
  fs.mkdirSync(nested, { recursive: true });
  const found = findSpecPath(nested)!;
  assert.equal(found, path.join(root, ".skillgate", "done.yaml"));
  assert.equal(specRoot(found), root);

  const child = path.join(root, "vendor", "child", "src");
  fs.mkdirSync(path.join(root, "vendor", "child", ".git"), { recursive: true });
  fs.mkdirSync(child, { recursive: true });
  assert.equal(findSpecPath(child), null);
});

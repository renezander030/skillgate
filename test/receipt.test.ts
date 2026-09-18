import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunResult } from "../src/core.js";
import { readCachedResult, snapshotKey, writeCachedResult, writeReceipt } from "../src/receipt.js";

const spec = { gates: [{ id: "readme", type: "file-exists" as const, file: "README.md" }] };
const pass: RunResult = { passed: true, results: [{ id: "readme", type: "file-exists", ok: true, reason: "present" }], failed: [] };

test("snapshotKey changes with workspace content and cache only reuses an exact passing snapshot", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-receipt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "README.md"), "one\n");
  const first = snapshotKey(spec, dir);
  writeCachedResult(dir, first, pass);
  assert.deepEqual(readCachedResult(dir, first), pass);

  fs.writeFileSync(path.join(dir, "README.md"), "two\n");
  const second = snapshotKey(spec, dir);
  assert.notEqual(second, first);
  assert.equal(readCachedResult(dir, second), null);
  writeCachedResult(dir, second, { passed: false, results: [], failed: [] });
  assert.equal(readCachedResult(dir, second), null);
});

test("writeReceipt produces an auditable machine-readable result", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-receipt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "reports", "check.json");
  writeReceipt(file, "abc123", pass, "cache");
  const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(receipt.format, 1);
  assert.equal(receipt.snapshot, "abc123");
  assert.equal(receipt.source, "cache");
  assert.equal(receipt.result.passed, true);

  writeReceipt(file, "replacement", pass, "executed");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).snapshot, "replacement");
});

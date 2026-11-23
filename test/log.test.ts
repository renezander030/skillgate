import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { summarizeLog, summarizeLogFile } from "../src/log.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const record = { ts: "2026-01-01", event: "command", decision: "block", reason: "failed", failed: [{ id: "c1" }], command: "git push" };
const json = (value: unknown) => JSON.stringify(value);

test("log: invalid shapes count once and preserve valid neighboring decisions", () => {
  const invalid = [null, [], 1, "text", {}, { ...record, decision: "maybe" },
    { ...record, ts: 1 }, { ...record, event: {} }, { ...record, reason: [] },
    { ...record, command: {} }, { ...record, tool: 1 }, { ...record, failed: {} },
    { ...record, failed: [null] }, { ...record, failed: [{ id: 1 }] },
    { ...record, failed: [[], { id: "c1" }] }];
  const s = summarizeLog([json(record), ...invalid.map(json), "broken", json({ ...record, decision: "allow" })].join("\n"));
  assert.equal(s.records, 2);
  assert.equal(s.malformed, invalid.length + 1);
  assert.equal(s.blocked, 1);
  assert.equal(s.allowed, 1);
  assert.deepEqual(s.blockingGates, [{ id: "c1", count: 1 }]);
  assert.deepEqual(s.byEvent, { command: { allowed: 1, blocked: 1 } });
});

test("log: legacy optional metadata and unknown fields remain readable", () => {
  const { failed, ...older } = record;
  const s = summarizeLog([older, { ...older, failed: null }, { ...older, failed: [], reason: "error: unavailable", future: {} }].map(json).join("\n"));
  assert.equal(s.records, 3);
  assert.equal(s.malformed, 0);
  assert.equal(s.errors, 1);
});

test("log: reserved event names survive JSON output without inherited counters", () => {
  const names = ["__proto__", "constructor", "toString"];
  const s = JSON.parse(json(summarizeLog(names.flatMap((event) => [
    { ...record, event }, { ...record, event, decision: "allow" },
  ]).map(json).join("\n"))));
  assert.deepEqual(Object.keys(s.byEvent), names);
  for (const event of names) assert.deepEqual(s.byEvent[event], { blocked: 1, allowed: 1 });
  assert.equal(Object.hasOwn(Object.prototype, "blocked"), false);
});

test("log: stream matches text aggregation across CRLF, UTF-8 and final unterminated line", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "decisions.jsonl");
  const text = [" ", json({ ...record, command: "ä".repeat(40000) }), json({ ...record, ts: "2026-01-03", tool: "publish" }),
    "broken", json({ ...record, ts: "2025-12-30", failed: [{ id: "c2" }], command: "git commit" })].join("\r\n");
  fs.writeFileSync(file, text);
  const s = await summarizeLogFile(file, 1);
  assert.deepEqual(s, summarizeLog(text, 1));
  assert.equal(s.first, "2025-12-30");
  assert.equal(s.last, "2026-01-03");
  assert.deepEqual(s.blockingGates, [{ id: "c1", count: 2 }]);
  assert.equal(s.blockedActions.length, 1);
  const bareCr = [json(record), json(record)].join("\r");
  fs.writeFileSync(file, bareCr);
  assert.deepEqual(await summarizeLogFile(file), summarizeLog(bareCr));
  fs.writeFileSync(file, "");
  assert.deepEqual(await summarizeLogFile(file), summarizeLog(""));
});

test("log: unavailable files reject and CLI reports a read error with exit 2", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "missing.jsonl");
  await assert.rejects(summarizeLogFile(file), { code: "ENOENT" });
  const out = spawnSync(process.execPath, [cli, "log", file, "--json"], { encoding: "utf8" });
  assert.equal(out.status, 2, out.stderr);
  assert.match(out.stderr, /cannot read/);
  assert.equal(out.stdout, "");
});

test("log: CLI summarizes a file larger than its heap budget", { timeout: 30000 }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "large.jsonl");
  const line = json({ ...record, metadata: "x".repeat(4096) }) + "\n";
  const fd = fs.openSync(file, "w");
  try {
    const chunk = line.repeat(100);
    for (let i = 0; i < 200; i++) fs.writeSync(fd, chunk);
    fs.writeSync(fd, "not json\n");
  } finally { fs.closeSync(fd); }
  assert.ok(fs.statSync(file).size > 64 * 1024 * 1024);
  const out = spawnSync(process.execPath, ["--max-old-space-size=64", cli, "log", file, "--json"], { encoding: "utf8", timeout: 25000 });
  assert.equal(out.status, 0, out.stderr);
  const s = JSON.parse(out.stdout);
  assert.equal(s.records, 20000);
  assert.equal(s.malformed, 1);
  assert.deepEqual(s.blockingGates, [{ id: "c1", count: 20000 }]);
});

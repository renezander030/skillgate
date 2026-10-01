import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { runGates } from "../src/core.js";
import { parseSpec, type Spec } from "../src/spec.js";
import { reviewSnapshot } from "../src/review.js";
import { SkillGate } from "../src/plugin.js";

function fixture(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-external-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "source.txt"), "safe baseline\n");
  execFileSync("git", ["add", "source.txt"], { cwd: dir });
  return dir;
}

test("trufflehog fails closed on findings, missing binaries, malformed output, and timeout without exposing credentials", { skip: process.platform === "win32" }, t => {
  const dir = fixture(t);
  const bin = path.join(dir, "scanner");
  const spec: Spec = { gates: [{ id: "secrets", type: "trufflehog", trufflehog: bin, timeout: 150 }] };
  for (const body of ["echo private-credential-value; exit 183", "echo private-credential-value; exit 0", "sleep 2"]) {
    fs.writeFileSync(bin, "#!/bin/sh\n" + body + "\n", { mode: 0o700 });
    const result = runGates(spec, dir);
    assert.equal(result.passed, false);
    assert.equal(JSON.stringify(result).includes("private-credential-value"), false);
  }
  fs.rmSync(bin);
  assert.equal(runGates(spec, dir).passed, false);
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.equal(runGates(spec, dir).passed, true);
});

test("infrastructure names are blocked in working and staged files and never echoed", { skip: process.platform === "win32" }, t => {
  const dir = fixture(t);
  const bin = path.join(dir, "scanner");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.writeFileSync(path.join(dir, "names.json"), JSON.stringify(["internal-example.invalid", "TenantExample"]));
  const spec: Spec = { gates: [{ id: "secrets", type: "trufflehog", trufflehog: bin, namesFile: "names.json" }] };
  fs.writeFileSync(path.join(dir, "source.txt"), "tenant=TENANTEXAMPLE\n");
  assert.equal(runGates(spec, dir).passed, false);
  execFileSync("git", ["add", "source.txt"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "source.txt"), "scrubbed workspace\n");
  const result = runGates(spec, dir);
  assert.equal(result.passed, false);
  assert.equal(JSON.stringify(result).toLowerCase().includes("tenantexample"), false);
  execFileSync("git", ["add", "source.txt"], { cwd: dir });
  assert.equal(runGates(spec, dir).passed, true);
  fs.writeFileSync(path.join(dir, "names.json"), "[]");
  assert.equal(runGates(spec, dir).passed, false);
});

test("review reports require completion, no findings, and the exact working and staged snapshot", t => {
  const dir = fixture(t);
  const spec: Spec = { gates: [{ id: "review", type: "review", file: "review.json" }] };
  const report = { format: 1, snapshot: reviewSnapshot(spec, dir), review: {
    status: "success", summary: { files_reviewed: 1, comments: 0 }, comments: [] as unknown[], warnings: [],
  } };
  const write = () => fs.writeFileSync(path.join(dir, "review.json"), JSON.stringify(report));
  write();
  assert.equal(runGates(spec, dir).passed, true);
  report.review.comments = [{ content: "a defect" }];
  report.review.summary.comments = 1;
  write();
  assert.equal(runGates(spec, dir).passed, false);
  report.review.comments = [];
  report.review.summary.comments = 0;
  report.review.status = "skipped";
  write();
  assert.equal(runGates(spec, dir).passed, false);
  report.review.status = "success";
  write();
  fs.writeFileSync(path.join(dir, "source.txt"), "changed\n");
  assert.equal(runGates(spec, dir).passed, false);
  execFileSync("git", ["add", "source.txt"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "source.txt"), "safe baseline\n");
  assert.equal(runGates(spec, dir).passed, false);
});

test("an invalid opencode policy blocks publish tools while keeping built-in repair tools available", async t => {
  const dir = fixture(t);
  fs.mkdirSync(path.join(dir, ".skillgate"));
  fs.writeFileSync(path.join(dir, ".skillgate/done.yaml"), "gates: invalid\n");
  const hooks = await SkillGate({ directory: dir });
  await assert.rejects(() => hooks["tool.execute.before"]({ tool: "mcp__release__publish" }, { args: {} }), /policy is invalid/);
  await hooks["tool.execute.before"]({ tool: "edit" }, { args: {} });
});

test("named preset initializes private local configuration and refuses existing policy or unknown presets", t => {
  const dir = fixture(t);
  const cli = path.resolve("dist/src/cli.js");
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args, "--cwd", dir], { encoding: "utf8" });
  assert.equal(run("init", "--preset", "unknown").status, 2);
  assert.equal(run("init", "--preset", "no-secrets").status, 0);
  const spec = parseSpec(fs.readFileSync(path.join(dir, ".skillgate/done.yaml"), "utf8"), "preset", false);
  assert.equal(spec.gates[0].type, "trufflehog");
  assert.match(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), /forbidden-names.json/);
  assert.equal(run("init", "--preset", "no-secrets").status, 1);
  assert.equal(run("review-snapshot").status, 0);
});

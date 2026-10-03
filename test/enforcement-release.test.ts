import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { globSync } from "tinyglobby";
import { runGates } from "../src/core.js";
import { resolveBaseRef, matchesGlob, mergeBase } from "../src/git.js";
import { installIntegration, doctor, GATE_TIMEOUT_MS } from "../src/integrations.js";
import { snapshotKey, readCachedResult, writeCachedResult } from "../src/receipt.js";
import { runShellCommand } from "../src/process.js";
import { withInstallLock, writeTextAtomic } from "../src/files.js";
import type { Spec } from "../src/spec.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
function project(t: any, files: Record<string, string> = {}, withGit = false): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-enforcement-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  write(dir, files);
  if (withGit) {
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["add", "."]);
    git(dir, ["commit", "-qm", "fixture", "--allow-empty"]);
  }
  return dir;
}
function write(dir: string, files: Record<string, string>): void {
  for (const [file, value] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), value);
  }
}
function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args], { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim();
}
function sg(dir: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
}

test("explicit missing baselines never fall back, and unreadable trees never pass empty diff gates", t => {
  const dir = project(t, { ".skillgate.json": JSON.stringify({ gates: [{ id: "scan", type: "no-new", glob: "*.ts", pattern: "skip", allowEmpty: true }] }) }, true);
  assert.equal(resolveBaseRef(dir, "does-not-exist"), null);
  assert.equal(sg(dir, ["check", "--base", "does-not-exist"]).status, 2);
  assert.equal(sg(dir, ["check", "--pin", "--base", "does-not-exist"]).status, 2);
  assert.equal(sg(dir, ["check"], { SKILLGATE_BASE: "does-not-exist" }).status, 2);
  for (const type of ["no-new", "no-fewer", "no-deleted"] as const) {
    const gate = { id: "scan", type, glob: "*.ts", pattern: "skip", allowEmpty: true };
    assert.equal(runGates({ gates: [gate] }, dir, { baseRef: "does-not-exist" }).passed, false);
  }
  git(dir, ["checkout", "--orphan", "unrelated"]);
  git(dir, ["commit", "-qm", "unrelated root", "--allow-empty"]);
  assert.throws(() => mergeBase(dir, "main"), /common ancestor/);
});

test("historical glob matching agrees with disk matching for classes, extglobs, braces, and root files", t => {
  const dir = project(t, { "src/a1.ts": "x", "src/b2.js": "x", "src/deep/c3.ts": "x", "root.ts": "x", ".hidden.ts": "x" }, true);
  const files = ["src/a1.ts", "src/b2.js", "src/deep/c3.ts", "root.ts", ".hidden.ts"];
  for (const pattern of ["src/[ab][0-9].{ts,js}", "src/**/+(a1|c3).ts", "**/*.ts", "src/**/!(*.js)"]) {
    assert.deepEqual(files.filter(file => matchesGlob(file, pattern)).sort(), globSync(pattern, { cwd: dir, dot: true }).sort());
  }
  fs.unlinkSync(path.join(dir, "src/a1.ts"));
  const result = runGates({ gates: [{ id: "keep", type: "no-deleted", glob: "src/[ab][0-9].{ts,js}" }] }, dir, { baseRef: "main" });
  assert.equal(result.passed, false);
  assert.equal(result.failed[0].location?.file, "src/a1.ts");
});

test("nested policies read the same historical files and preserve newline-containing names", t => {
  const dir = project(t, { "pkg/tests/a.ts": "test('one')\ntest('two')\n", "pkg/tests/space \n name.ts": "test('three')\n", "tests/a.ts": "unrelated\n" }, true);
  write(dir, { "pkg/tests/a.ts": "test('one')\n" });
  const spec: Spec = { gates: [{ id: "keep", type: "no-fewer", glob: "tests/**", pattern: "^test" }] };
  const result = runGates(spec, path.join(dir, "pkg"), { baseRef: "main" });
  assert.equal(result.passed, false);
  assert.match(result.failed[0].reason, /base 3, now 2/);
});

test("evidence and file-contains reject directories even when the pattern matches empty text", t => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, "report.md"));
  const result = runGates({ gates: [
    { id: "report", type: "evidence", file: "report.md" },
    { id: "contents", type: "file-contains", file: "report.md", pattern: "^$" },
  ] }, dir);
  assert.equal(result.failed.length, 2);
  assert.ok(result.failed.every(gate => /regular file/.test(gate.reason)));
});

test("phase requirements share one deadline and completed requirements remain memoized", t => {
  const dir = project(t);
  const slow = `"${process.execPath}" -e "setTimeout(() => {}, 150)"`;
  const spec: Spec = { timeout: 260, gates: [
    { id: "phases", type: "phase", phases: [{ id: "done", requires: ["one", "two"] }] },
    { id: "one", type: "command", run: slow, timeout: 1000 },
    { id: "two", type: "command", run: slow, timeout: 1000 },
    { id: "after", type: "file-exists", file: "missing" },
  ] };
  const result = runGates(spec, dir);
  assert.equal(result.passed, false);
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[3].status, "not-run");
  assert.ok(result.durationMs! < 1200);
});

test("command supervision caps output before losing its process tree", t => {
  const dir = project(t);
  const result = runShellCommand(`"${process.execPath}" -e "process.stdout.write('x'.repeat(9 * 1024 * 1024))"`, dir, 5000);
  assert.equal(result.outputLimited, true);
  assert.ok(result.stdout.length <= 8 * 1024 * 1024);
});

test("completed Unix shells cannot leave background descendants writing after a pass", { skip: process.platform === "win32" }, t => {
  const dir = project(t, { "worker.cjs": "setTimeout(() => require('fs').writeFileSync('late.txt', 'late'), 350)" });
  const result = runShellCommand(`"${process.execPath}" worker.cjs &`, dir, 2000);
  assert.equal(result.status, 0);
  execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 500)"]);
  assert.equal(fs.existsSync(path.join(dir, "late.txt")), false);
});

test("pre-commit installation upgrades deletion-only coverage and preserves unrelated hooks", t => {
  const dir = project(t, { ".skillgate.json": JSON.stringify({ gates: [{ id: "docs", type: "file-exists", file: "README.md" }] }),
    ".pre-commit-config.yaml": "repos:\n  - repo: local\n    hooks:\n      - id: other\n        entry: echo other\n      - id: skillgate\n        entry: npx @reneza/skillgate@0.9.0 check\n        custom: preserved\n" });
  assert.equal(doctor(dir, ["pre-commit"]).at(-1)?.ok, false);
  assert.equal(installIntegration("pre-commit", dir).changed, true);
  const data: any = parseYaml(fs.readFileSync(path.join(dir, ".pre-commit-config.yaml"), "utf8"));
  const hooks = data.repos[0].hooks;
  assert.equal(hooks.length, 2);
  assert.equal(hooks[0].entry, "echo other");
  assert.equal(hooks[1].always_run, true);
  assert.equal(hooks[1].pass_filenames, false);
  assert.equal(hooks[1].custom, "preserved");
  assert.equal(doctor(dir, ["pre-commit"]).at(-1)?.ok, true);
  assert.equal(installIntegration("pre-commit", dir).changed, false);
});

test("Claude Stop output blocks on stdout JSON, including errors and missing-file diagnostics", t => {
  const dir = project(t, { ".skillgate.json": JSON.stringify({ gates: [{ id: "tests", type: "command", run: `"${process.execPath}" -e "console.error('No such file'); process.exit(1)"` }] }) });
  const args = ["gate", "--event", "stop", "--format", "claude-stop"];
  const blocked = sg(dir, args);
  assert.equal(blocked.status, 0);
  assert.equal(JSON.parse(blocked.stdout).decision, "block");
  assert.match(JSON.parse(blocked.stdout).reason, /No such file/);
  write(dir, { ".skillgate.json": "{}" });
  assert.equal(JSON.parse(sg(dir, args).stdout).decision, "block");
  assert.equal(JSON.parse(sg(dir, [...args, "--pin", "--base", "missing-ref"]).stdout).decision, "block");
  write(dir, { ".skillgate.json": JSON.stringify({ gates: [{ id: "docs", type: "file-exists", file: ".skillgate.json" }] }) });
  assert.deepEqual(JSON.parse(sg(dir, args).stdout), {});
  installIntegration("claude-code", dir, { stop: true });
  const config = JSON.parse(fs.readFileSync(path.join(dir, ".claude/settings.json"), "utf8"));
  assert.match(config.hooks.Stop[0].hooks[0].command, /--format claude-stop/);
  assert.match(config.hooks.PreToolUse[0].hooks[0].command, new RegExp(`--timeout ${GATE_TIMEOUT_MS}`));
});

test("the installed Claude Stop fallback blocks if npx cannot launch the gate", { skip: process.platform === "win32" }, t => {
  const dir = project(t, { "bin/npx": "#!/bin/sh\necho 'No such file' >&2\nexit 127\n" });
  fs.chmodSync(path.join(dir, "bin/npx"), 0o755);
  installIntegration("claude-code", dir, { stop: true });
  const data = JSON.parse(fs.readFileSync(path.join(dir, ".claude/settings.json"), "utf8"));
  const result = spawnSync("sh", ["-c", data.hooks.Stop[0].hooks[0].command], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: [path.join(dir, "bin"), path.dirname(process.execPath), process.env.PATH].join(path.delimiter) } });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).decision, "block");
});

test("gate timeout stays inside the host hook timeout even with a longer policy", t => {
  const dir = project(t, { ".skillgate.json": JSON.stringify({ timeout: 900000, finishLine: ["git commit"], gates: [{ id: "hang", type: "command", timeout: 800000, run: `"${process.execPath}" -e "setTimeout(() => {}, 5000)"` }] }) });
  const result = sg(dir, ["gate", "--command", "git commit", "--timeout", "100", "--json"]);
  assert.equal(result.status, 2);
  assert.match(JSON.parse(result.stdout).result.failed[0].reason, /timed out/);
});

test("command and scanner cache requests always re-evaluate external state", t => {
  const dir = project(t, { ".skillgate.json": JSON.stringify({ gates: [{ id: "env", type: "command", run: `"${process.execPath}" -e "process.exit(process.env.SKILLGATE_FIXTURE_OK === 'yes' ? 0 : 1)"` }] }) });
  assert.equal(sg(dir, ["check", "--cache", "--json"], { SKILLGATE_FIXTURE_OK: "yes" }).status, 0);
  const result = sg(dir, ["check", "--cache", "--json"], { SKILLGATE_FIXTURE_OK: "no" });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).cacheHit, false);
  assert.match(JSON.parse(result.stdout).cacheDisabledReason, /command/);
});

test("ignored files, branch changes, and symlink target changes invalidate cached passes", { skip: process.platform === "win32" }, t => {
  const dir = project(t, { ".gitignore": "ignored.txt\n", "ignored.txt": "approved", "target.txt": "approved" }, true);
  fs.symlinkSync("target.txt", path.join(dir, "link.txt"));
  const spec: Spec = { gates: [{ id: "input", type: "file-contains", file: "ignored.txt", pattern: "approved" }] };
  const first = snapshotKey(spec, dir);
  write(dir, { "ignored.txt": "changed" });
  assert.notEqual(snapshotKey(spec, dir), first);
  const linked: Spec = { gates: [{ id: "link", type: "file-contains", file: "link.txt", pattern: "approved" }] };
  const linkKey = snapshotKey(linked, dir);
  write(dir, { "target.txt": "changed" });
  assert.notEqual(snapshotKey(linked, dir), linkKey);
  const branchKey = snapshotKey(spec, dir);
  git(dir, ["checkout", "-qb", "release/test"]);
  assert.notEqual(snapshotKey(spec, dir), branchKey);
});

test("malformed or incomplete cache receipts fall back to real checks", t => {
  const dir = project(t, { "README.md": "ok" }, true);
  const spec: Spec = { gates: [{ id: "docs", type: "file-exists", file: "README.md" }] };
  const snapshot = snapshotKey(spec, dir);
  writeCachedResult(dir, snapshot, runGates(spec, dir));
  const file = git(dir, ["rev-parse", "--path-format=absolute", "--git-path", "skillgate-cache/check.json"]);
  const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const invalid of [{ passed: true }, { passed: true, results: [], failed: [] }, { passed: true, results: [{ id: "wrong", type: "file-exists", ok: true, reason: "claimed" }], failed: [] }]) {
    fs.writeFileSync(file, JSON.stringify({ ...receipt, result: invalid }));
    assert.equal(readCachedResult(dir, snapshot, spec), null);
  }
});

test("excluded review reports do not change their snapshot when staged", t => {
  const dir = project(t, { "README.md": "ok", "review.json": "draft" }, true);
  const spec: Spec = { gates: [{ id: "docs", type: "file-exists", file: "README.md" }] };
  const snapshot = snapshotKey(spec, dir, undefined, ["review.json"]);
  write(dir, { "review.json": "approved" });
  git(dir, ["add", "review.json"]);
  assert.equal(snapshotKey(spec, dir, undefined, ["review.json"]), snapshot);
  git(dir, ["update-index", "--chmod=+x", "README.md"]);
  assert.notEqual(snapshotKey(spec, dir, undefined, ["review.json"]), snapshot);
});

test("receipts cannot overwrite inputs or attest a workspace changed during evaluation", t => {
  const dir = project(t, { "README.md": "approved", ".skillgate.json": JSON.stringify({ gates: [
    { id: "docs", type: "file-contains", file: "README.md", pattern: "approved" },
    { id: "mutate", type: "command", run: `"${process.execPath}" -e "require('fs').writeFileSync('README.md','changed')"` },
  ] }) });
  assert.equal(sg(dir, ["check", "--receipt", "README.md"]).status, 2);
  assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), "approved");
  const result = sg(dir, ["check", "--receipt", "result.json", "--json"]);
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).failed.at(-1).reason, /workspace changed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")).result.passed, false);
});

test("an active installer cannot overwrite another installation and failures release the lock", t => {
  const dir = project(t, { ".skillgate.json": JSON.stringify({ gates: [{ id: "docs", type: "file-exists", file: "README.md" }] }) });
  withInstallLock(dir, () => {
    assert.throws(() => installIntegration("claude-code", dir), /another Skillgate installation/);
    assert.equal(fs.existsSync(path.join(dir, ".claude/settings.json")), false);
  });
  assert.throws(() => withInstallLock(dir, () => { throw new Error("interrupted"); }), /interrupted/);
  assert.equal(installIntegration("claude-code", dir).changed, true);
  assert.equal(installIntegration("claude-code", dir).changed, false);
});

test("atomic configuration writes preserve existing permissions and refuse symlink replacement", { skip: process.platform === "win32" }, t => {
  const dir = project(t, { "config.json": "old", "target.json": "private" });
  const config = path.join(dir, "config.json");
  fs.chmodSync(config, 0o640);
  const originalUmask = process.umask(0o077);
  try { writeTextAtomic(config, "new"); }
  finally { process.umask(originalUmask); }
  assert.equal(fs.readFileSync(config, "utf8"), "new");
  assert.equal(fs.statSync(config).mode & 0o777, 0o640);
  const link = path.join(dir, "link.json");
  fs.symlinkSync("target.json", link);
  assert.throws(() => writeTextAtomic(link, "replacement"), /non-regular/);
  assert.equal(fs.readFileSync(path.join(dir, "target.json"), "utf8"), "private");
  assert.equal(fs.readdirSync(dir).some(file => file.endsWith(".tmp")), false);
});

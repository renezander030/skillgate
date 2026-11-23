// Tests for 0.16.1: symlinked agent configs, bounded regex matching, the devin target
// and doctor's last-decision check. Fixtures are real throwaway directories.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installIntegration } from "../src/integrations.js";
import { writeTextAtomic } from "../src/files.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function project(t: { after: (fn: () => void) => void }, files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-0161-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const all = { ".skillgate/done.yaml": "finishLine: [\"git push\"]\ngates:\n  - id: readme\n    type: file-exists\n    file: README.md\n", "README.md": "hi\n", ...files };
  for (const [rel, content] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

function sg(dir: string, args: string[], input = "") {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", input });
}

const posixOnly = { skip: process.platform === "win32" };

test("install --follow-symlinks writes through a symlinked settings file and keeps the link", posixOnly, t => {
  const dir = project(t, { "dotfiles/settings.json": "{\"model\":\"x\"}\n" });
  fs.mkdirSync(path.join(dir, ".claude"));
  const link = path.join(dir, ".claude", "settings.json");
  fs.symlinkSync(path.join("..", "dotfiles", "settings.json"), link);
  fs.chmodSync(path.join(dir, "dotfiles", "settings.json"), 0o640);

  const refused = sg(dir, ["install", "claude-code"]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /symbolic link \(pass --follow-symlinks/);

  const out = sg(dir, ["install", "claude-code", "--follow-symlinks"]);
  assert.equal(out.status, 0, out.stderr);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), "the link is kept");
  const data = JSON.parse(fs.readFileSync(path.join(dir, "dotfiles", "settings.json"), "utf8"));
  assert.equal(data.model, "x");
  assert.match(JSON.stringify(data.hooks.PreToolUse), /@reneza\/skillgate@/);
  assert.equal(fs.statSync(path.join(dir, "dotfiles", "settings.json")).mode & 0o777, 0o640);
  assert.equal(installIntegration("claude-code", dir, { followSymlinks: true }).changed, false);
  assert.equal(fs.readdirSync(path.join(dir, "dotfiles")).some(f => f.endsWith(".tmp")), false);
});

test("--follow-symlinks still refuses a dangling link or a link to a directory", posixOnly, t => {
  const dir = project(t);
  const dangling = path.join(dir, "dangling.json");
  fs.symlinkSync("missing.json", dangling);
  assert.throws(() => writeTextAtomic(dangling, "{}", { followSymlink: true }), /dangling symbolic link/);
  assert.equal(fs.existsSync(path.join(dir, "missing.json")), false);
  fs.mkdirSync(path.join(dir, "d"));
  const toDir = path.join(dir, "dir.json");
  fs.symlinkSync("d", toDir);
  assert.throws(() => writeTextAtomic(toDir, "{}", { followSymlink: true }), /non-regular file/);
});

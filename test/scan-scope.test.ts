import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runGates } from "../src/core.js";

function repo(t: { after(fn: () => void): void }, files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-scan-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  git("add", "-A");
  git("commit", "-qm", "base");
  return dir;
}

test("glob gates never scan node_modules, .git or dist, in the working tree or at the base", (t) => {
  const dir = repo(t, { "src/a.ts": "ok\n", "dist/b.ts": "// TODO base\n", "node_modules/m/c.ts": "// TODO\n" });
  fs.writeFileSync(path.join(dir, "dist/b.ts"), "// TODO one\n// TODO two\n");
  const pattern = "TODO";
  const result = runGates({
    gates: [
      { id: "absent", type: "absent", glob: "**/*.ts", pattern },
      { id: "no-new", type: "no-new", glob: "**/*.ts", pattern },
      { id: "no-fewer", type: "no-fewer", glob: "**/*.ts", pattern },
    ],
  }, dir, { baseRef: "HEAD" });
  assert.deepEqual(result.results.map((r) => [r.id, r.ok]), [["absent", true], ["no-new", true], ["no-fewer", true]]);
  assert.match(result.results[0].reason, /\(1 files\)/);
});

test("no-deleted protects every base file matching its glob, including built-in scan exclusions", (t) => {
  const dir = repo(t, { "src/a.ts": "ok\n", "dist/b.ts": "x\n" });
  fs.rmSync(path.join(dir, "dist/b.ts"));
  const result = runGates({ gates: [{ id: "keep", type: "no-deleted", glob: "**/*.ts" }] }, dir, { baseRef: "HEAD" });
  assert.equal(result.passed, false);
  assert.match(result.failed[0].reason, /dist\/b\.ts/);
});

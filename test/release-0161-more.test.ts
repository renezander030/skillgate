// Tests for 0.16.1: the pull request's target branch as the diff base, heredoc bodies
// as data, dry runs that are not finish lines, and shallow-clone base errors.
// Fixtures are real throwaway Git repositories.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isStructuredCommandMatch } from "../src/command.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const CI_VARS = ["GITHUB_BASE_REF", "CI_MERGE_REQUEST_TARGET_BRANCH_NAME", "BITBUCKET_PR_DESTINATION_BRANCH", "SKILLGATE_BASE"];

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of CI_VARS) delete env[name];
  return { ...env, ...extra };
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", env: cleanEnv() }).trim();
}

function sg(dir: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", env: cleanEnv(env) });
}

function tmp(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-0161b-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const POLICY = "finishLine: [\"git push\"]\ngates:\n  - id: tests-kept\n    type: no-fewer\n    glob: \"test/**\"\n    pattern: \"it\\\\(\"\n";

/** main has one test case, develop three; the feature branch, stacked on develop, drops one. */
function stacked(t: { after: (fn: () => void) => void }): string {
  const dir = tmp(t);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  fs.mkdirSync(path.join(dir, ".skillgate"));
  fs.mkdirSync(path.join(dir, "test"));
  fs.writeFileSync(path.join(dir, ".skillgate", "done.yaml"), POLICY);
  fs.writeFileSync(path.join(dir, "test", "a.js"), "it(1)\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "m1");
  git(dir, "checkout", "-qb", "develop");
  fs.writeFileSync(path.join(dir, "test", "a.js"), "it(1)\nit(2)\nit(3)\n");
  git(dir, "commit", "-qam", "d1");
  git(dir, "checkout", "-qb", "feature");
  fs.writeFileSync(path.join(dir, "test", "a.js"), "it(1)\nit(2)\n");
  git(dir, "commit", "-qam", "drop a test");
  return dir;
}

test("check judges a pull request against the branch it targets, not the default branch", t => {
  const dir = stacked(t);
  const github = sg(dir, ["check"], { GITHUB_BASE_REF: "develop" });
  assert.equal(github.status, 1, github.stdout + github.stderr);
  assert.match(github.stdout, /tests-kept.*base 3, now 2/);
  const gitlab = sg(dir, ["check"], { CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "develop" });
  assert.equal(gitlab.status, 1, gitlab.stdout + gitlab.stderr);
  // A push event leaves GITHUB_BASE_REF empty: the default branch stays the base.
  const push = sg(dir, ["check"], { GITHUB_BASE_REF: "" });
  assert.equal(push.status, 0, push.stdout + push.stderr);
});

test("check refuses a pull request whose target branch is not in the checkout", t => {
  const dir = stacked(t);
  const out = sg(dir, ["check"], { GITHUB_BASE_REF: "release-9" });
  assert.equal(out.status, 2);
  assert.match(out.stderr, /target branch release-9 is not in this checkout/);
  // An explicit base still wins over the CI target.
  const explicit = sg(dir, ["check", "--base", "main"], { GITHUB_BASE_REF: "release-9" });
  assert.equal(explicit.status, 0, explicit.stdout + explicit.stderr);
});

test("a here-document body is data unless a shell reads it", () => {
  const push = ["git push"];
  // Data: a commit message or a note that mentions the finish line.
  assert.equal(isStructuredCommandMatch("git commit -F- <<'EOF'\nfix: retry\ngit push follows after review\nEOF", push), false);
  assert.equal(isStructuredCommandMatch("cat > notes.md <<EOF\ngit push origin main\nEOF", push), false);
  assert.equal(isStructuredCommandMatch("cat <<'EOF' > n.md\nsee $(git push)\nEOF", push), false);
  assert.equal(isStructuredCommandMatch("cat <<EOF\nunterminated\ngit push", push), false);
  // Runs: a substitution in an unquoted body, a body a shell reads, the line after the body.
  assert.equal(isStructuredCommandMatch("cat <<EOF > n.md\nsee $(git push)\nEOF", push), true);
  assert.equal(isStructuredCommandMatch("bash <<EOF\ngit push\nEOF", push), true);
  assert.equal(isStructuredCommandMatch("cat <<'EOF' | sh\ngit push\nEOF", push), true);
  assert.equal(isStructuredCommandMatch("ssh build-host <<EOF\ngit push\nEOF", push), true);
  assert.equal(isStructuredCommandMatch("cat <<-EOF > n\n\tgit push\n\tEOF\ngit push", push), true);
  assert.equal(isStructuredCommandMatch("git push <<< y", push), true);
});

test("a shallow clone without the fork point names the fetch that fixes it", t => {
  const src = stacked(t);
  git(src, "checkout", "-q", "main");
  fs.writeFileSync(path.join(src, "x"), "x\n");
  git(src, "add", "x");
  git(src, "commit", "-qm", "m2");
  const dir = path.join(tmp(t), "clone");
  execFileSync("git", ["clone", "-q", "--depth", "1", "--branch", "feature", "--no-single-branch", `file://${src}`, dir], { env: cleanEnv() });
  const out = sg(dir, ["check"]);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /this clone is shallow.*fetch-depth: 0/);
  // A full clone is judged as before.
  const full = path.join(tmp(t), "full");
  execFileSync("git", ["clone", "-q", "--branch", "feature", src, full], { env: cleanEnv() });
  assert.equal(sg(full, ["check"]).status, 0);
});

test("a dry run does not reach the finish line", () => {
  const line = ["git push", "git commit", "npm publish", "cargo publish", "npm run release"];
  for (const command of ["git push --dry-run", "git push -n origin main", "git commit --dry-run -m x", "npm publish --dry-run", "cargo publish --dry-run"]) {
    assert.equal(isStructuredCommandMatch(command, line), false, command);
  }
  // Real finish lines stay gated, dry run or not elsewhere on the line.
  for (const command of ["git push", "git commit -n -m x", "git push --dry-run && git push", "npm run release -- --dry-run", "npm publish --tag next"]) {
    assert.equal(isStructuredCommandMatch(command, line), true, command);
  }
});

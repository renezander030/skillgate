import test from "node:test";
import assert from "node:assert/strict";
import { analyzeCommand, isStructuredCommandMatch, splitCommand, tokenizeCommand } from "../src/command.js";

test("splitCommand separates unquoted control operators only", () => {
  assert.deepEqual(splitCommand(`echo "a;b" && git push | tee out`), [`echo "a;b"`, "git push", "tee out"]);
});

test("tokenizeCommand preserves quoted values and Windows paths", () => {
  assert.deepEqual(tokenizeCommand(`"C:\\Program Files\\Git\\cmd\\git.exe" commit -m "hello world"`), [
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "commit",
    "-m",
    "hello world",
  ]);
});

test("structural matching sees wrappers, options, nested shells, and Windows launchers", () => {
  const patterns = ["git commit", "git push", "npm publish"];
  assert.equal(isStructuredCommandMatch("env CI=1 git -C repo commit -m done", patterns), true);
  assert.equal(isStructuredCommandMatch("CI=1 command -p git push origin main", patterns), true);
  assert.equal(isStructuredCommandMatch(`bash -c "npm --silent publish"`, patterns), true);
  assert.equal(isStructuredCommandMatch(`bash -lc "git push origin main"`, patterns), true);
  assert.equal(isStructuredCommandMatch(`powershell -Command "git push origin main"`, patterns), true);
  assert.equal(isStructuredCommandMatch(`pwsh -Command "& git push origin main"`, patterns), true);
  assert.equal(isStructuredCommandMatch(`"C:\\Program Files\\Git\\cmd\\git.exe" push`, patterns), true);
  assert.equal(isStructuredCommandMatch(`(git push origin main)`, patterns), true);
  assert.equal(isStructuredCommandMatch(`echo $(git push origin main)`, patterns), true);
  assert.equal(isStructuredCommandMatch(`eval "git commit -m done"`, patterns), true);
});

test("structural matching ignores quoted prose and unrelated subcommands", () => {
  const patterns = ["git commit", "npm publish"];
  assert.equal(isStructuredCommandMatch(`echo "please run git commit"`, patterns), false);
  assert.equal(isStructuredCommandMatch(`echo '$(git commit -m nope)'`, patterns), false);
  assert.equal(isStructuredCommandMatch("git status", patterns), false);
  assert.equal(isStructuredCommandMatch("npm run publish", patterns), false);
  assert.equal(isStructuredCommandMatch("anything", undefined), false);
});

test("analyzeCommand reports the exact pattern and normalized segment", () => {
  const analysis = analyzeCommand("sudo git push origin main", ["git commit", "git push"]);
  assert.equal(analysis.matched, true);
  assert.deepEqual(analysis.patterns, ["git push"]);
  assert.deepEqual(analysis.segments[0].normalized.slice(0, 2), ["git", "push"]);
});

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

test("structural matching sees process wrappers and find -exec", () => {
  const patterns = ["git push", "npm publish"];
  for (const command of [
    "timeout 5 git push",
    "timeout -s KILL 5m git push",
    "nice -n 5 git push",
    "ionice -c 3 git push",
    "stdbuf -oL git push",
    "xargs git push",
    "xargs -I {} git push origin {}",
    "watch -n 5 npm publish",
    "find . -name x -exec git push \;",
    "find . -execdir npm publish +",
  ]) assert.equal(isStructuredCommandMatch(command, patterns), true, command);
  assert.equal(isStructuredCommandMatch("timeout 5 npm test", patterns), false);
  assert.equal(isStructuredCommandMatch("find . -exec grep -l push {} \;", patterns), false);
});

test("a program or subcommand the shell decides at run time fails closed", () => {
  const patterns = ["git push", "git commit"];
  assert.deepEqual(analyzeCommand("g=git; $g push", patterns).patterns, ["git push"]);
  assert.deepEqual(analyzeCommand(`GIT=git; "\${GIT}" push origin`, patterns).patterns, ["git push"]);
  assert.deepEqual(analyzeCommand(`"$(which git)" push`, patterns).patterns, ["git push"]);
  assert.deepEqual(analyzeCommand("`command -v git` commit -m x", patterns).patterns, ["git commit"]);
  assert.deepEqual(analyzeCommand("git $(echo push)", patterns).patterns, ["git push", "git commit"]);
  assert.deepEqual(analyzeCommand(`git "$SUB" origin`, patterns).patterns, ["git push", "git commit"]);
  assert.equal(isStructuredCommandMatch(`"$GIT" status`, patterns), false);
  assert.equal(isStructuredCommandMatch("$EDITOR notes.txt", patterns), false);
  assert.equal(isStructuredCommandMatch(`echo "$HOME" && ls $(pwd)`, patterns), false);
});

test("assignment-only segments are analyzed, not a crash", () => {
  assert.equal(isStructuredCommandMatch("FOO=1; ls", ["git push"]), false);
  assert.equal(isStructuredCommandMatch("FOO=1", ["git push"]), false);
  assert.deepEqual(analyzeCommand("A=1 B=2", ["git push"]).segments[0].normalized, []);
});

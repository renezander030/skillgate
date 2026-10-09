// Tests for the 0.14.0 gates and commands: unchanged, deps-declared,
// instruction-refs, instruction-sync `require`, signed-commits, changed files
// for command gates, the trivy severity summary, the decision log, and
// `explain --commands`. Fixtures are real throwaway directories and git repos.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runGates, gatesForCommand } from "../src/core.js";
import { findImports, packageName } from "../src/imports.js";
import { extractRefs } from "../src/refs.js";
import { summarizeLog, logPathProblem } from "../src/log.js";
import { runSync } from "../src/link.js";
import { parseSpec, type Spec } from "../src/spec.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t.dev", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    stdio: "pipe",
    encoding: "utf8",
  });
}

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-014-"));
  write(dir, files);
  return dir;
}

/** A throwaway git repo on `main` with `files` committed; returns [dir, base sha]. */
function gitProject(files: Record<string, string>): [string, string] {
  const dir = tmpProject(files);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return [dir, git(dir, ["rev-parse", "HEAD"]).trim()];
}

function sg(args: string[], cwd: string, env?: NodeJS.ProcessEnv, input?: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, SKILLGATE_LOG: "", ...env },
      encoding: "utf8",
      input,
      stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e: any) {
    return { status: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
}

// ---- unchanged --------------------------------------------------------------

test("unchanged: passes when protected files are untouched and new files are added", () => {
  const [dir, base] = gitProject({ "migrations/001.sql": "create table a;\n", "src/a.ts": "x\n" });
  write(dir, { "migrations/002.sql": "create table b;\n", "src/a.ts": "y\n" });
  const r = runGates({ gates: [{ id: "migrations", type: "unchanged", glob: "migrations/**" }] }, dir, { baseRef: base });
  assert.equal(r.passed, true, r.results[0].reason);
  assert.match(r.results[0].reason, /1 migrations\/\*\* file\(s\) unchanged/);
});

test("unchanged: blocks an edited or deleted protected file", () => {
  const [dir, base] = gitProject({ "__snapshots__/a.snap": "old\n", "__snapshots__/b.snap": "keep\n", "ci.yml": "x\n" });
  write(dir, { "__snapshots__/a.snap": "new\n" });
  fs.rmSync(path.join(dir, "ci.yml"));
  const spec: Spec = {
    gates: [
      { id: "snapshots", type: "unchanged", glob: "**/*.snap" },
      { id: "ci", type: "unchanged", glob: "ci.yml" },
    ],
  };
  const r = runGates(spec, dir, { baseRef: base });
  assert.equal(r.passed, false);
  assert.match(r.results[0].reason, /1 protected file\(s\) matching \*\*\/\*\.snap changed/);
  assert.match(r.results[0].reason, /__snapshots__\/a\.snap/);
  assert.deepEqual(r.results[0].location, { file: "__snapshots__/a.snap" });
  assert.match(r.results[1].reason, /ci\.yml \(deleted\)/);
});

test("unchanged: ignores line-ending-only churn that git would normalize", () => {
  const [dir, base] = gitProject({ ".gitattributes": "*.txt text eol=lf\n", "golden/out.txt": "a\nb\n" });
  write(dir, { "golden/out.txt": "a\r\nb\r\n" });
  const r = runGates({ gates: [{ id: "golden", type: "unchanged", glob: "golden/**" }] }, dir, { baseRef: base });
  assert.equal(r.passed, true, r.results[0].reason);
});

test("unchanged: compares a symlink by its target, not the file it points at", { skip: process.platform === "win32" }, () => {
  const dir = tmpProject({ "a.txt": "a\n", "b.txt": "b\n" });
  fs.symlinkSync("a.txt", path.join(dir, "link.txt"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]).trim();
  const spec: Spec = { gates: [{ id: "link", type: "unchanged", glob: "link.txt" }] };
  write(dir, { "a.txt": "edited\n" });
  assert.equal(runGates(spec, dir, { baseRef: base }).passed, true);
  fs.rmSync(path.join(dir, "link.txt"));
  fs.symlinkSync("b.txt", path.join(dir, "link.txt"));
  const r = runGates(spec, dir, { baseRef: base });
  assert.equal(r.passed, false);
  assert.match(r.results[0].reason, /link\.txt/);
});

test("unchanged: fails closed without a base and on a glob that matches nothing", () => {
  const [dir, base] = gitProject({ "a.txt": "x\n" });
  assert.match(runGates({ gates: [{ id: "u", type: "unchanged", glob: "a.txt" }] }, dir).results[0].reason, /fail-closed/);
  const r = runGates({ gates: [{ id: "u", type: "unchanged", glob: "nope/**" }] }, dir, { baseRef: base });
  assert.equal(r.passed, false);
  assert.match(r.results[0].reason, /matches no files/);
  const ok = runGates({ gates: [{ id: "u", type: "unchanged", glob: "nope/**", allowEmpty: true }] }, dir, { baseRef: base });
  assert.equal(ok.passed, true);
});

// ---- deps-declared ----------------------------------------------------------

test("deps-declared: parses import forms and package names", () => {
  const refs = findImports(`import a from "alpha";
import { b } from '@scope/beta/sub';
import type { T } from "gamma";
export * from "delta";
import "side-effect";
const e = require("epsilon/x");
const f = await import("zeta");
// import nope from "commented";
/* require("blocked") */
import rel from "./local";
import fs from "node:fs";
import path from "path";
const kind: "import" | "link" = "import";
obj.import("not-a-module");`);
  assert.deepEqual(refs.map((r) => r.specifier), ["alpha", "@scope/beta/sub", "gamma", "delta", "side-effect", "epsilon/x", "zeta", "./local", "node:fs", "path"]);
  assert.equal(refs.find((r) => r.specifier === "gamma")?.typeOnly, true);
  assert.equal(packageName("@scope/beta/sub"), "@scope/beta");
  assert.equal(packageName("epsilon/x"), "epsilon");
  assert.equal(packageName("./local"), null);
  assert.equal(packageName("node:fs"), null);
  assert.equal(packageName("path"), null);
  assert.equal(packageName("fs/promises"), null);
  assert.equal(packageName("#internal"), null);
  assert.equal(packageName("@/components/x"), null);
});

test("deps-declared: blocks an import missing from the nearest package.json", () => {
  const dir = tmpProject({
    "package.json": JSON.stringify({ name: "app", dependencies: { yaml: "^2" }, devDependencies: { "@types/picomatch": "^4" } }),
    "src/a.ts": 'import { parse } from "yaml";\nimport type { Options } from "picomatch";\nimport self from "app/x";\n',
    "src/b.ts": 'import { format } from "date-fns";\n',
  });
  const r = runGates({ gates: [{ id: "deps", type: "deps-declared", glob: "src/**/*.ts" }] }, dir);
  assert.equal(r.passed, false);
  assert.match(r.results[0].reason, /1 imported package is not declared in package\.json: date-fns \(src\/b\.ts:1\)/);
  assert.deepEqual(r.results[0].location, { file: "src/b.ts", line: 1 });

  const allowed = runGates({ gates: [{ id: "deps", type: "deps-declared", glob: "src/**/*.ts", allow: ["date-*"] }] }, dir);
  assert.equal(allowed.passed, true, allowed.results[0].reason);
});

test("deps-declared: workspace packages answer to their own manifest", () => {
  const dir = tmpProject({
    "package.json": JSON.stringify({ name: "root", devDependencies: { typescript: "^5" } }),
    "packages/web/package.json": JSON.stringify({ name: "web", dependencies: { react: "^19" } }),
    "packages/web/src/app.tsx": 'import React from "react";\nimport ts from "typescript";\n',
  });
  const r = runGates({ gates: [{ id: "deps", type: "deps-declared", glob: "packages/**/*.tsx" }] }, dir);
  assert.equal(r.passed, false);
  assert.match(r.results[0].reason, /typescript/);
  assert.match(r.results[0].reason, /packages\/web\/package\.json/);
});

test("deps-declared: spec validation rejects unknown fields", () => {
  assert.throws(() => parseSpec("gates:\n  - id: d\n    type: deps-declared\n    glob: src/**\n    manifest: x\n", "t", false), /unknown field/);
});

// ---- instruction-refs ---------------------------------------------------------

test("instruction-refs: extracts imports, links and path-like code spans, skipping fences", () => {
  const refs = extractRefs(`@docs/rules.md
See [the guide](docs/guide.md#setup) and https://example.com.
Run \`npm test\`, edit \`src/cli.ts:12\`, read \`package.json\`, not \`process.env\`.
Branch \`origin/main\`, package @reneza/skillgate, mail me@example.com.
\`\`\`
cat src/fenced.ts
\`\`\`
`, "AGENTS.md");
  assert.deepEqual(refs.map((r) => `${r.kind}:${r.ref}`), ["import:docs/rules.md", "link:docs/guide.md", "code:src/cli.ts", "code:origin/main"]);
});

test("instruction-refs: fails on a stale path with its line, passes once fixed or ignored", () => {
  const dir = tmpProject({
    "AGENTS.md": "# Rules\n\nTests live in `test/`.\nThe entry point is `src/old-cli.ts`.\nSee [docs](docs/x.md). Use `origin/main` as base.\n",
    "test/a.test.ts": "",
    "docs/x.md": "",
    "src/cli.ts": "",
  });
  const r = runGates({ gates: [{ id: "refs", type: "instruction-refs" }] }, dir);
  assert.equal(r.passed, false);
  assert.match(r.results[0].reason, /1 stale reference in instruction files: AGENTS\.md:4 → src\/old-cli\.ts/);
  assert.deepEqual(r.results[0].location, { file: "AGENTS.md", line: 4 });
  const ignored = runGates({ gates: [{ id: "refs", type: "instruction-refs", ignore: ["src/old-*"] }] }, dir);
  assert.equal(ignored.passed, true, ignored.results[0].reason);
  assert.match(ignored.results[0].reason, /path references in 1 instruction files resolve/);
});

test("instruction-refs: a broken @import in CLAUDE.md fails", () => {
  const dir = tmpProject({ "CLAUDE.md": "@AGENTS.md\n" });
  const r = runGates({ gates: [{ id: "refs", type: "instruction-refs" }] }, dir);
  assert.equal(r.passed, false);
  assert.match(r.results[0].reason, /CLAUDE\.md:1 → AGENTS\.md/);
});

// ---- instruction-sync require + sync --create -----------------------------------

test("instruction-sync require: AGENTS.md alone does not cover Claude Code", () => {
  const dir = tmpProject({ "AGENTS.md": "# Rules\nrun tests\n", "CLAUDE.local.md": "my notes\n" });
  const spec: Spec = { gates: [{ id: "sync", type: "instruction-sync", require: ["claude-code"] }] };
  const r = runGates(spec, dir);
  assert.equal(r.passed, false);
  assert.match(r.results[0].reason, /no instruction file for Claude Code \(CLAUDE\.md\)/);
  assert.match(r.results[0].reason, /CLAUDE\.local\.md/);
  assert.match(r.results[0].reason, /skillgate sync --create claude-code/);

  const { lines } = runSync(dir, { create: ["claude-code", "Gemini CLI"] });
  assert.ok(lines.some((l) => /CLAUDE\.md\s+created as an @AGENTS\.md pointer/.test(l)), lines.join("\n"));
  assert.equal(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  assert.equal(fs.readFileSync(path.join(dir, "GEMINI.md"), "utf8"), "@AGENTS.md\n");
  assert.equal(runGates(spec, dir).passed, true);
});

test("instruction-sync require: unknown tool names are rejected at load", () => {
  assert.throws(() => parseSpec("gates:\n  - id: s\n    type: instruction-sync\n    require: [claude]\n", "t", false), /unknown tool: claude/);
  assert.doesNotThrow(() => parseSpec("gates:\n  - id: s\n    type: instruction-sync\n    require: [Claude Code, gemini-cli]\n", "t", false));
});

// ---- signed-commits ---------------------------------------------------------------

test("signed-commits: blocks unsigned commits since the base, passes with none", () => {
  const [dir, base] = gitProject({ "a.txt": "1\n" });
  assert.match(runGates({ gates: [{ id: "signed", type: "signed-commits" }] }, dir, { baseRef: base }).results[0].reason, /no commits since/);
  write(dir, { "a.txt": "2\n" });
  git(dir, ["commit", "-qam", "unsigned change"]);
  const r = runGates({ gates: [{ id: "signed", type: "signed-commits" }] }, dir, { baseRef: base });
  assert.equal(r.passed, false);
  assert.match(r.results[0].reason, /1 of 1 commit\(s\) since .* not signed: [0-9a-f]{12} unsigned "unsigned change"/);
  assert.match(runGates({ gates: [{ id: "signed", type: "signed-commits" }] }, dir).results[0].reason, /fail-closed/);
});

test("signed-commits: accepts an SSH-signed commit", { skip: process.platform === "win32" }, (t) => {
  const [dir, base] = gitProject({ "a.txt": "1\n" });
  const key = path.join(dir, ".key");
  try {
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], { stdio: "ignore" });
  } catch {
    t.skip("ssh-keygen not available");
    return;
  }
  const pub = fs.readFileSync(key + ".pub", "utf8").trim();
  fs.writeFileSync(path.join(dir, ".allowed"), `t@t.dev ${pub}\n`);
  fs.writeFileSync(path.join(dir, ".git", "info", "exclude"), ".key*\n.allowed\n");
  for (const [k, v] of [["gpg.format", "ssh"], ["user.signingkey", key], ["gpg.ssh.allowedSignersFile", path.join(dir, ".allowed")]]) git(dir, ["config", k, v]);
  write(dir, { "a.txt": "2\n" });
  try {
    git(dir, ["-c", "commit.gpgsign=true", "commit", "-qam", "signed change"]);
  } catch {
    t.skip("git cannot sign with ssh here");
    return;
  }
  for (const trust of ["signed", "verified"] as const) {
    const r = runGates({ gates: [{ id: "signed", type: "signed-commits", trust }] }, dir, { baseRef: base });
    assert.equal(r.passed, true, r.results[0].reason);
  }
});

// ---- command gates receive changed files ------------------------------------------

test("command: SKILLGATE_CHANGED_FILES lists existing changed files filtered by when.changed", { skip: process.platform === "win32" }, () => {
  const [dir, base] = gitProject({ "src/a.ts": "1\n", "src/gone.ts": "1\n", "README.md": "x\n" });
  write(dir, { "src/a.ts": "2\n", "src/new.ts": "1\n", "README.md": "y\n" });
  fs.rmSync(path.join(dir, "src/gone.ts"));
  const spec: Spec = {
    gates: [
      { id: "lint", type: "command", run: 'cp "$SKILLGATE_CHANGED_FILES" seen.txt && test "$SKILLGATE_CHANGED_COUNT" = 2', when: { changed: ["src/**"] } },
    ],
  };
  const r = runGates(spec, dir, { baseRef: base });
  assert.equal(r.passed, true, r.results[0].reason);
  assert.equal(fs.readFileSync(path.join(dir, "seen.txt"), "utf8"), "src/a.ts\nsrc/new.ts\n");
});

test("command: changed-file variables are unset without a base", { skip: process.platform === "win32" }, () => {
  const dir = tmpProject({});
  const r = runGates({ gates: [{ id: "c", type: "command", run: 'test -z "$SKILLGATE_CHANGED_FILES"' }] }, dir);
  assert.equal(r.passed, true, r.results[0].reason);
});

// ---- trivy severity summary ---------------------------------------------------------

test("trivy: a passing scan reports findings below the blocking severity", { skip: process.platform === "win32" }, () => {
  const dir = tmpProject({});
  const trivy = path.join(dir, "fake-trivy.sh");
  fs.writeFileSync(
    trivy,
    `#!/bin/sh
case "$*" in
  *"--format json"*) printf '{"Results":[{"Vulnerabilities":[{"Severity":"HIGH"},{"Severity":"HIGH"},{"Severity":"LOW"}]}]}\\n' ;;
  *"--format cyclonedx"*) printf '{"bomFormat":"CycloneDX"}\\n' ;;
esac
exit 0
`,
  );
  fs.chmodSync(trivy, 0o755);
  const r = runGates({ gates: [{ id: "trivy", type: "trivy", trivy, scanners: ["vuln"] }] }, dir);
  assert.equal(r.passed, true);
  assert.match(r.results[0].reason, /vuln:CRITICAL, not blocking: 2 HIGH, 1 LOW, sbom:cyclonedx/);

  const off = runGates({ gates: [{ id: "trivy", type: "trivy", trivy, scanners: ["vuln"], summary: false }] }, dir);
  assert.doesNotMatch(off.results[0].reason, /not blocking/);
});

// ---- decision log ---------------------------------------------------------------------

test("log: gate and check verdicts are appended and summarized", () => {
  const dir = tmpProject({
    ".skillgate/done.yaml": 'finishLine: ["git push"]\ngates:\n  - id: readme\n    type: file-exists\n    file: README.md\n',
  });
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-log-"));
  const log = path.join(logDir, "decisions.jsonl");
  const env = { SKILLGATE_LOG: log };
  assert.equal(sg(["gate", "--command", "git push origin main"], dir, env).status, 2);
  assert.equal(sg(["gate", "--command", "ls -la"], dir, env).status, 0);
  assert.equal(sg(["check"], dir, env).status, 1);
  const records = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(records.length, 3);
  assert.equal(records[0].decision, "block");
  assert.equal(records[0].command, "git push origin main");
  assert.deepEqual(records[0].failed.map((f: any) => f.id), ["readme"]);
  assert.equal(records[1].decision, "allow");
  assert.equal(records[2].via, "check");

  const out = sg(["log", log, "--json"], dir);
  assert.equal(out.status, 0);
  const summary = JSON.parse(out.stdout);
  assert.equal(summary.blocked, 2);
  assert.equal(summary.allowed, 1);
  assert.deepEqual(summary.blockingGates, [{ id: "readme", count: 2 }]);
});

test("log: a log inside the worktree is refused without changing the verdict", () => {
  const dir = tmpProject({ ".skillgate/done.yaml": 'finishLine: ["git push"]\ngates:\n  - id: ok\n    type: file-exists\n    file: .skillgate/done.yaml\n' });
  const r = sg(["gate", "--command", "git push", "--log", "decisions.jsonl"], dir);
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(path.join(dir, "decisions.jsonl")), false);
  assert.equal(logPathProblem(path.join(dir, ".git", "skillgate.jsonl"), dir), null);
  assert.match(logPathProblem(path.join(dir, "x.jsonl"), dir) ?? "", /inside the worktree/);
});

test("log: summary skips malformed lines", () => {
  const s = summarizeLog('{"ts":"1","via":"gate","event":"command","decision":"block","reason":"error: boom","failed":[]}\nnot json\n{"x":1}\n');
  assert.equal(s.records, 1);
  assert.equal(s.malformed, 2);
  assert.equal(s.errors, 1);
});

// ---- explain --commands ---------------------------------------------------------------

test("explain --commands: replays a corpus and names the gates that would run", () => {
  const dir = tmpProject({
    ".skillgate/done.yaml": `finishLine: ["git commit", "git push"]
gates:
  - id: fast
    type: file-exists
    file: .skillgate/done.yaml
  - id: full
    type: file-exists
    file: .skillgate/done.yaml
    when:
      command: ["git push"]
`,
    "corpus.txt": "# replay\ngit status\ngit commit -m x\n{\"command\":\"env CI=1 git push\",\"decision\":\"allow\"}\n",
  });
  const out = sg(["explain", "--commands", "corpus.txt", "--json"], dir);
  assert.equal(out.status, 0, out.stderr);
  const report = JSON.parse(out.stdout);
  assert.equal(report.total, 3);
  assert.equal(report.gated, 2);
  assert.deepEqual(report.commands.map((c: any) => c.gates), [[], ["fast"], ["fast", "full"]]);
  assert.deepEqual(report.byPattern, { "git commit": 1, "git push": 1 });

  const stdin = sg(["explain", "--commands", "-"], dir, undefined, "git push\n");
  assert.match(stdin.stdout, /1 of 1 commands cross the finish line/);
  assert.match(sg(["explain", "--command", "git push"], dir).stdout, /gates: fast, full/);
});

test("gatesForCommand: tool-only gates do not apply to commands", () => {
  const spec: Spec = {
    gates: [
      { id: "all", type: "file-exists", file: "x" },
      { id: "tool", type: "file-exists", file: "x", when: { tool: ["mcp__*"] } },
      { id: "push", type: "file-exists", file: "x", when: { command: ["git push"] } },
    ],
  };
  assert.deepEqual(gatesForCommand(spec, "git commit -m x"), ["all"]);
  assert.deepEqual(gatesForCommand(spec, "git push"), ["all", "push"]);
});

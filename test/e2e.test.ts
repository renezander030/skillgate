// End-to-end tests: exercise the built CLI as a real process against fixture
// repos, so the user-facing contract (commands, exit codes, --json) is covered,
// not just the in-process gate logic.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CLI = new URL("../src/cli.js", import.meta.url).pathname;

// Built at runtime so the literal 16+ char token never appears in source — otherwise
// skillgate's own no-secrets gate would (correctly) flag this test file.
const FAKE_SECRET = "sk_live_" + "0".repeat(20);

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function sg(args: string[], cwd: string): Run {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e: any) {
    return { status: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
}

function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-e2e-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test("--version prints the package version", () => {
  const r = sg(["--version"], process.cwd());
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("help: bare invocation and --help both exit 0 with usage", () => {
  for (const args of [[], ["help"], ["--help"]]) {
    const r = sg(args, process.cwd());
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage:/);
  }
});

test("unknown command exits 2 and prints help", () => {
  const r = sg(["frobnicate"], process.cwd());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command/);
});

test("init writes a spec, then refuses to overwrite it", () => {
  const dir = tmpProject({});
  const first = sg(["init"], dir);
  assert.equal(first.status, 0);
  assert.ok(fs.existsSync(path.join(dir, ".skillgate", "done.yaml")));
  const second = sg(["init"], dir);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /already exists/);
});

test("check: exits 2 when no spec is present", () => {
  const dir = tmpProject({ "README.md": "hi" });
  const r = sg(["check"], dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no spec found/);
});

test("check: exits 0 when every gate passes", () => {
  const dir = tmpProject({
    "README.md": "hi",
    "LICENSE": "MIT",
    ".skillgate/done.yaml":
      "gates:\n  - id: docs\n    type: file-exists\n    file: [README.md, LICENSE]\n",
  });
  const r = sg(["check"], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /all 1 gates passed/);
});

test("check: exits 1 and names the failing gate", () => {
  const dir = tmpProject({
    "README.md": "hi",
    ".skillgate/done.yaml":
      "gates:\n  - id: docs\n    type: file-exists\n    file: [README.md, LICENSE]\n",
  });
  const r = sg(["check"], dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /docs/);
});

test("check: every gate type round-trips through the CLI", () => {
  const dir = tmpProject({
    "README.md": "# hi\n",
    "src/a.ts": "export const a = 1\n",
    "notes.md": "evidence",
    "docs/api/guide.md": "guide",
    ".skillgate/done.yaml": [
      "gates:",
      "  - id: exists",
      "    type: file-exists",
      "    file: README.md",
      "  - id: contains",
      "    type: file-contains",
      "    file: README.md",
      "    pattern: hi",
      "  - id: absent",
      "    type: absent",
      "    glob: src/**/*.ts",
      "    pattern: TODO",
      "  - id: command",
      "    type: command",
      "    run: \"true\"",
      "  - id: evidence",
      "    type: evidence",
      "    file: notes.md",
      "  - id: not-empty",
      "    type: not-empty",
      "    path: docs/api",
      "  - id: sync",
      "    type: instruction-sync",
      "",
    ].join("\n"),
  });
  const r = sg(["check", "--json"], dir);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.passed, true);
  assert.equal(out.results.length, 7);
  assert.ok(out.results.find((x: any) => x.id === "not-empty" && x.type === "not-empty" && x.ok));
});

test("check: exits 1 when a not-empty gate fails on empty directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-e2e-"));
  fs.mkdirSync(path.join(dir, "docs", "api", "empty"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".skillgate"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".skillgate", "done.yaml"),
    "gates:\n  - id: not-empty-docs\n    type: not-empty\n    path: docs/api/empty\n",
  );
  try {
    const r = sg(["check"], dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /not-empty-docs/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("check --json: failing run is machine-readable and exits 1", () => {
  const dir = tmpProject({
    "src/leak.ts": `const k = '${FAKE_SECRET}'\n`,
    ".skillgate/done.yaml":
      "gates:\n  - id: no-secrets\n    type: absent\n    glob: src/**/*.ts\n    pattern: sk_live_\n",
  });
  const r = sg(["check", "--json"], dir);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.passed, false);
  assert.equal(out.failed[0].id, "no-secrets");
});

test("audit: is read-only — never writes a spec into the audited repo", () => {
  const dir = tmpProject({ "src/a.ts": "export const a = 1\n" });
  const r = sg(["audit"], dir);
  // status may be 0 or 1 depending on the built-in defaults; the invariant is no write.
  assert.ok(r.status === 0 || r.status === 1);
  assert.ok(!fs.existsSync(path.join(dir, ".skillgate")), "audit must not write a spec");
});

test("audit: exits 1 when a built-in default would let the agent cut a corner", () => {
  const dir = tmpProject({ "src/leak.ts": `const k = '${FAKE_SECRET}'\n` });
  const r = sg(["audit", "--json"], dir);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.usingDefaults, true);
  assert.equal(out.passed, false);
});

test("drift: reports cleanly when there are no instruction files", () => {
  const dir = tmpProject({ "README.md": "hi" });
  const r = sg(["drift"], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no agent instruction files/);
});

test("--cwd: runs against another directory", () => {
  const dir = tmpProject({ "README.md": "hi" });
  const r = sg(["audit", "--cwd", dir], os.tmpdir());
  assert.equal(typeof r.status, "number");
  assert.match(r.stdout + r.stderr, /skillgate/i);
});

test("scaffold: creates evidence directory", () => {
  const dir = tmpProject({});
  const r = sg(["scaffold"], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /test-output\.txt/);
  assert.ok(fs.existsSync(path.join(dir, ".skillgate", "evidence", "test-output.txt")));
});

test("scaffold: --template react creates react evidence", () => {
  const dir = tmpProject({});
  const r = sg(["scaffold", "--template", "react"], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /typecheck-output\.txt/);
  assert.ok(fs.existsSync(path.join(dir, ".skillgate", "evidence", "typecheck-output.txt")));
});

test("scaffold: unknown template exits 2", () => {
  const dir = tmpProject({});
  const r = sg(["scaffold", "--template", "frobnitz"], dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown template/);
});

test("scaffold: --update-agents creates AGENTS.md", () => {
  const dir = tmpProject({});
  const r = sg(["scaffold", "--template", "generic", "--update-agents"], dir);
  assert.equal(r.status, 0);
  assert.ok(fs.existsSync(path.join(dir, "AGENTS.md")));
  assert.match(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /skillgate evidence workflow/);
});

test("scaffold: --update-agents appends to existing AGENTS.md", () => {
  const dir = tmpProject({ "AGENTS.md": "# Existing\n" });
  const r = sg(["scaffold", "--template", "generic", "--update-agents"], dir);
  assert.equal(r.status, 0);
  const content = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.ok(content.includes("# Existing"));
  assert.ok(content.includes("skillgate evidence workflow"));
});

test("diff-instructions: reports when no instruction files", () => {
  const dir = tmpProject({ "README.md": "hi" });
  const r = sg(["diff-instructions"], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no agent instruction files/);
});

test("diff-instructions: clean when files agree", () => {
  const dir = tmpProject({ "AGENTS.md": "# rules\nbe good\n", "CLAUDE.md": "@AGENTS.md\n" });
  const r = sg(["diff-instructions"], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /in sync/);
});

test("diff-instructions: shows diff on drift", () => {
  const dir = tmpProject({ "AGENTS.md": "# rules\nbe good\n", "CLAUDE.md": "# claude rules\ndo something else\n" });
  const r = sg(["diff-instructions"], dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Claude Code/);
  assert.match(r.stdout, /do something else/);
});

test("canonical: sets canonical marker file", () => {
  const dir = tmpProject({ "AGENTS.md": "# rules\nbe good\n" });
  const r = sg(["canonical", "AGENTS.md"], dir);
  assert.equal(r.status, 0);
  assert.ok(fs.existsSync(path.join(dir, ".skillgate", "canonical-instructions.txt")));
  const marker = fs.readFileSync(path.join(dir, ".skillgate", "canonical-instructions.txt"), "utf8").trim();
  assert.equal(marker, "AGENTS.md");
});

test("canonical: errors on missing file", () => {
  const dir = tmpProject({});
  const r = sg(["canonical", "NONEXISTENT.md"], dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /file not found/);
});

test("canonical: errors without argument", () => {
  const dir = tmpProject({});
  const r = sg(["canonical"], dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

test("init includes instruction-sync gate by default", () => {
  const dir = tmpProject({});
  const r = sg(["init"], dir);
  assert.equal(r.status, 0);
  const spec = fs.readFileSync(path.join(dir, ".skillgate", "done.yaml"), "utf8");
  assert.ok(spec.includes("instruction-sync"), "init template must include instruction-sync gate");
});

test("init includes evidence gate example", () => {
  const dir = tmpProject({});
  const r = sg(["init"], dir);
  assert.equal(r.status, 0);
  const spec = fs.readFileSync(path.join(dir, ".skillgate", "done.yaml"), "utf8");
  assert.ok(spec.includes("evidence"), "init template must include evidence gate example");
});

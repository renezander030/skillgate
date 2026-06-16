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
      "  - id: sync",
      "    type: instruction-sync",
      "",
    ].join("\n"),
  });
  const r = sg(["check", "--json"], dir);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.passed, true);
  assert.equal(out.results.length, 6);
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

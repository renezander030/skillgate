// Tests for the stateless `phase` gate, `skillgate phase`, and tool gating
// (`gatedTools`, `when.tool`) across the engine, the CLI hook, the opencode
// plugin and hook installs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runGates, decideTool, decideCommand } from "../src/core.js";
import { parseSpec, type Spec } from "../src/spec.js";
import { SkillGate } from "../src/plugin.js";
import { doctor, installIntegration } from "../src/integrations.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-phase-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function sg(args: string[], cwd: string, input?: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf8",
      input,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e: any) {
    return { status: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
}

const PHASED: Spec = {
  gates: [
    { id: "plan-written", type: "file-exists", file: "PLAN.md" },
    { id: "tests-pass", type: "file-exists", file: "TESTS_OK" },
    {
      id: "phases",
      type: "phase",
      phases: [
        { id: "plan" },
        { id: "build", requires: ["plan-written"] },
        { id: "review", requires: ["tests-pass"] },
      ],
    },
  ],
};

const PHASED_YAML = `gates:
  - id: plan-written
    type: file-exists
    file: PLAN.md
  - id: tests-pass
    type: file-exists
    file: TESTS_OK
  - id: phases
    type: phase
    phases:
      - id: plan
      - id: build
        requires: [plan-written]
      - id: review
        requires: [tests-pass]
`;

test("phase: no marker means the first phase, whose requirements are empty", () => {
  const dir = project({});
  const r = runGates(PHASED, dir);
  assert.equal(r.results.find((x) => x.id === "phases")?.ok, true);
  assert.match(r.results.find((x) => x.id === "phases")!.reason, /in phase plan; 0 required/);
});

test("phase: requirements are cumulative and checked live, whatever the marker says", () => {
  const dir = project({ ".skillgate/phase": "review\n", TESTS_OK: "" });
  // In review, build's requirement (PLAN.md) still applies.
  let phase = runGates(PHASED, dir).results.find((x) => x.id === "phases")!;
  assert.equal(phase.ok, false);
  assert.match(phase.reason, /phase review requires plan-written \(missing: PLAN\.md\)/);
  fs.writeFileSync(path.join(dir, "PLAN.md"), "plan");
  phase = runGates(PHASED, dir).results.find((x) => x.id === "phases")!;
  assert.equal(phase.ok, true);
  assert.match(phase.reason, /2 required gate/);
});

test("phase: an unknown phase in the marker fails the gate", () => {
  const dir = project({ ".skillgate/phase": "ship\n" });
  const phase = runGates(PHASED, dir).results.find((x) => x.id === "phases")!;
  assert.equal(phase.ok, false);
  assert.match(phase.reason, /unknown phase ship \(phases: plan, build, review\)/);
  assert.deepEqual(phase.location, { file: ".skillgate/phase" });
});

test("phase: a required gate runs once per run", () => {
  const dir = project({ ".skillgate/phase": "build\n" });
  const spec: Spec = {
    gates: [
      { id: "phases", type: "phase", phases: [{ id: "plan" }, { id: "build", requires: ["count"] }] },
      { id: "count", type: "command", run: `node -e "require('fs').appendFileSync('runs.txt','x')"` },
    ],
  };
  assert.equal(runGates(spec, dir).passed, true);
  assert.equal(fs.readFileSync(path.join(dir, "runs.txt"), "utf8"), "x");
});

test("phase: validation rejects unknown requirements, phase-on-phase and duplicate ids", () => {
  const head = "gates:\n  - id: a\n    type: evidence\n    file: x\n";
  assert.throws(() => parseSpec(head + "  - id: p\n    type: phase\n    phases: [{ id: one, requires: [nope] }]\n", "t", false), /requires unknown gate: nope/);
  assert.throws(() => parseSpec(head + "  - id: p\n    type: phase\n    phases: [{ id: one, requires: [q] }]\n  - id: q\n    type: phase\n    phases: [{ id: z }]\n", "t", false), /cannot require another phase gate/);
  assert.throws(() => parseSpec(head + "  - id: p\n    type: phase\n    phases: [{ id: one }, { id: one }]\n", "t", false), /duplicate id: one/);
  assert.throws(() => parseSpec(head + "  - id: p\n    type: phase\n    phases: []\n", "t", false), /non-empty array/);
  assert.doesNotThrow(() => parseSpec(head + "  - id: p\n    type: phase\n    current: .phase\n    phases: [{ id: one, requires: [a] }]\n", "t", false));
});

test("skillgate phase <id> moves only when the target's requirements pass", (t) => {
  const dir = project({ ".skillgate/done.yaml": PHASED_YAML });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, ".skillgate", "phase");

  const blocked = sg(["phase", "build"], dir);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /cannot enter build: plan-written/);
  assert.equal(fs.existsSync(marker), false);

  fs.writeFileSync(path.join(dir, "PLAN.md"), "plan");
  const moved = sg(["phase", "build"], dir);
  assert.equal(moved.status, 0);
  assert.match(moved.stdout, /plan → build/);
  assert.equal(fs.readFileSync(marker, "utf8").trim(), "build");

  const status = JSON.parse(sg(["phase", "--json"], dir).stdout);
  assert.equal(status.current, "build");
  assert.deepEqual(status.phases.map((p: any) => [p.id, p.ok]), [["plan", true], ["build", true], ["review", false]]);
  assert.equal(sg(["phase", "ship"], dir).status, 2);
});

test("skillgate phase needs exactly one phase gate unless --gate picks it", (t) => {
  const dir = project({ ".skillgate/done.yaml": "gates:\n  - id: a\n    type: evidence\n    file: x\n" });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.match(sg(["phase"], dir).stderr, /no phase gate/);
  assert.match(sg(["phase", "--gate", "nope"], dir).stderr, /no phase gate with id nope/);
});

const TOOLS: Spec = {
  gatedTools: ["mcp__course__publish_*"],
  gates: [
    { id: "always", type: "file-exists", file: "README.md" },
    { id: "publish-only", type: "file-exists", file: "REVIEWED", when: { tool: ["mcp__course__publish_*"] } },
    { id: "push-only", type: "file-exists", file: "missing", when: { command: ["git push"] } },
  ],
};

test("decideTool: gated tools run the gates that apply to them; others pass", () => {
  const dir = project({ "README.md": "hi" });
  const blocked = decideTool(TOOLS, dir, "mcp__course__publish_module");
  assert.equal(blocked.decision, "block");
  assert.deepEqual(blocked.result?.failed.map((f) => f.id), ["publish-only"]);
  assert.equal(blocked.result?.results.find((r) => r.id === "push-only")?.status, "skipped");
  assert.equal(decideTool(TOOLS, dir, "mcp__course__list").decision, "allow");
  fs.writeFileSync(path.join(dir, "REVIEWED"), "");
  assert.equal(decideTool(TOOLS, dir, "mcp__course__publish_module").decision, "allow");
});

test("when.tool gates are skipped for commands; plain check runs them", () => {
  const dir = project({ "README.md": "hi" });
  const spec: Spec = { ...TOOLS, finishLine: ["git commit"] };
  const commit = decideCommand(spec, dir, "git commit -m x");
  assert.equal(commit.result?.results.find((r) => r.id === "publish-only")?.status, "skipped");
  assert.equal(runGates(spec, dir).results.find((r) => r.id === "publish-only")?.ok, false);
});

test("skillgate gate judges a non-shell tool from the hook payload", (t) => {
  const dir = project({
    ".skillgate/done.yaml": "finishLine: ['git commit']\ngatedTools: ['mcp__course__publish_*']\ngates:\n  - id: reviewed\n    type: file-exists\n    file: REVIEWED\n",
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mcp = sg(["gate"], dir, JSON.stringify({ tool_name: "mcp__course__publish_module", tool_input: { module: 3 } }));
  assert.equal(mcp.status, 2);
  assert.match(mcp.stderr, /reviewed: missing: REVIEWED/);
  assert.equal(sg(["gate"], dir, JSON.stringify({ tool_name: "mcp__course__list", tool_input: {} })).status, 0);
  // Shell tools stay on the finishLine path.
  assert.equal(sg(["gate"], dir, JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } })).status, 0);
  assert.equal(sg(["gate"], dir, JSON.stringify({ tool_name: "Bash", tool_input: { command: "git commit -m x" } })).status, 2);
  assert.equal(sg(["gate", "--tool", "mcp__course__publish_x"], dir).status, 2);
  const gemini = JSON.parse(sg(["gate", "--format", "gemini"], dir, JSON.stringify({ tool_name: "mcp__course__publish_x" })).stdout);
  assert.equal(gemini.decision, "deny");
});

test("opencode plugin blocks a gated tool and keeps other tools usable on a broken policy", async (t) => {
  const dir = project({
    ".skillgate/done.yaml": "gatedTools: ['course_publish*']\ngates:\n  - id: reviewed\n    type: file-exists\n    file: REVIEWED\n",
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hooks = await SkillGate({ directory: dir });
  await assert.rejects(() => hooks["tool.execute.before"]({ tool: "course_publish_module" }, { args: {} }), /blocked tool course_publish_module/);
  await hooks["tool.execute.before"]({ tool: "read" }, { args: {} });

  fs.writeFileSync(path.join(dir, ".skillgate", "done.yaml"), "gates: nope\n");
  await hooks["tool.execute.before"]({ tool: "edit" }, { args: {} });
  await assert.rejects(() => hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "git commit" } }), /policy is invalid/);
});

test("installed hook matchers cover gatedTools, and doctor notices when they do not", (t) => {
  const dir = project({ ".skillgate/done.yaml": "gates:\n  - id: a\n    type: evidence\n    file: x\n" });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  installIntegration("claude-code", dir);
  installIntegration("gemini-cli", dir);
  fs.writeFileSync(path.join(dir, ".skillgate", "done.yaml"), "gatedTools: ['mcp__course__publish_*']\ngates:\n  - id: a\n    type: evidence\n    file: x\n");
  const stale = doctor(dir, ["claude-code", "gemini-cli"]);
  assert.equal(stale[1].ok, false);
  assert.match(stale[1].detail, /does not cover gatedTools mcp__course__publish_\*/);

  assert.equal(installIntegration("claude-code", dir).changed, true);
  assert.equal(installIntegration("gemini-cli", dir).changed, true);
  const claude = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
  assert.equal(claude.hooks.PreToolUse[0].matcher, "Bash|mcp__course__publish_.*");
  const gemini = JSON.parse(fs.readFileSync(path.join(dir, ".gemini", "settings.json"), "utf8"));
  assert.equal(gemini.hooks.BeforeTool[0].matcher, "run_shell_command|mcp__course__publish_.*");
  assert.ok(doctor(dir, ["claude-code", "gemini-cli"]).every((c) => c.ok));
});

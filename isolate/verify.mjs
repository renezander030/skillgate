// isolate/verify.mjs — skillgate's isolated patch verifier.
//
// Composes pi-gate's PROVEN isolation primitives (vendored verbatim under ./src)
// but runs skillgate's OWN definition-of-done gates INSIDE a network-off clone of
// the real repo. The DoD spec is taken from the real repo's committed HEAD, then
// evaluated against the agent's PATCHED tree — so a patch that weakens
// .skillgate/done.yaml cannot pass, and any change to it is flagged as sensitive.
//
// Not a public CLI: driven by `skillgate verify-patch` / `verify-apply`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git, repoRootOf } from "./src/git.js";
import { repoIdentity, stateDir } from "./src/paths.js";
import {
  computePatch,
  createEvalWorkspace,
  applyPatchTo,
  workingTreeChanges,
  applyPatchToReal,
} from "./src/workspace.js";
import { runChecks, netnsAvailable } from "./src/runner.js";
import {
  decideApply,
  saveReport,
  loadReport,
  evaluatorSensitive,
  unexpectedChanges,
} from "./src/report.js";
import * as fdn from "./vendor/foundation.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// skillgate's own compiled CLI: isolate/ -> ../dist/src/cli.js (dev + published layout match).
const SKILLGATE_CLI = path.resolve(HERE, "..", "dist", "src", "cli.js");

const SPEC_REL = ".skillgate/done.yaml";
// The definition-of-done is the evaluator's contract: a patch touching it is suspect.
const SENSITIVE = [".skillgate/**", "**/.skillgate/**"];
// Files a check may legitimately create (caches, logs) — not "unexpected" mutations.
const ALLOWLIST_CHANGED = ["**/node_modules/**", "**/.git/**", "sandbox-home/**", "**/*.log"];

function ctxRepos(flags) {
  const repo = repoRootOf(flags.repo || process.cwd());
  const staging = flags.staging ? repoRootOf(flags.staging) : repo;
  const { id: repoId, kind } = repoIdentity(repo, git);
  return { repo, staging, repoId, repoIdKind: kind };
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Build the trusted DoD check: the spec comes from real-repo HEAD (NOT the patched
// clone), so weakening done.yaml in the patch cannot relax the gates. Falls back to
// zero-config `skillgate audit` when the repo has no spec at HEAD.
function doneCheck(repo, repoId) {
  const node = process.execPath;
  let specSource = "built-in-defaults";
  let command = `${shq(node)} ${shq(SKILLGATE_CLI)} audit`;
  const content = git(["show", `HEAD:${SPEC_REL}`], { cwd: repo, allowFail: true });
  if (content && content.trim()) {
    const spec = path.join(stateDir(repoId), "trusted-done.yaml");
    fs.writeFileSync(spec, content);
    command = `${shq(node)} ${shq(SKILLGATE_CLI)} check ${shq(spec)}`;
    specSource = `HEAD:${SPEC_REL}`;
  }
  return { command, specSource };
}

function verifyRun(flags) {
  const human = flags._human;
  const { repo, staging, repoId, repoIdKind } = ctxRepos(flags);
  const sd = stateDir(repoId);

  const { patchPath, patchId, empty } = computePatch(staging, repoId);
  if (empty) {
    fdn.out({ status: "error", error: "no agent changes detected in staging tree", repoId });
    process.exit(2);
  }

  const ws = createEvalWorkspace(repo, repoId);
  const applied = applyPatchTo(ws, patchPath);
  const { command, specSource } = doneCheck(repo, repoId);
  const checks = [{ id: "skillgate-done", command, cwd: ".", timeoutMs: 300000 }];

  let before = [], results = [], after = [], unexpected = [], sensitive = [];
  if (applied.ok) {
    before = workingTreeChanges(ws);
    sensitive = evaluatorSensitive(before, SENSITIVE);
    results = runChecks(checks, ws, path.join(sd, "logs"));
    after = workingTreeChanges(ws);
    unexpected = unexpectedChanges(before, after, ALLOWLIST_CHANGED);
  }

  let { status, applyDecision } = decideApply({
    checks: results,
    applyError: applied.ok ? null : applied.error,
    unexpected,
    trusted: true, // the DoD is the user's, taken from HEAD, not agent-controlled
  });
  // The definition-of-done is the evaluator's contract. A patch that modifies it
  // never auto-applies, even when every gate passes: it takes an explicit human
  // override. This is what makes "a patch cannot weaken its own gates" hold.
  if (sensitive.length && applyDecision === "allowed") applyDecision = "override-required";

  const report = {
    schemaVersion: 1,
    tool: "skillgate",
    status,
    patchId,
    repo: { id: repoId, idKind: repoIdKind, path: repo, head: git(["rev-parse", "HEAD"], { cwd: repo }).trim() },
    dod: { specSource },
    isolation: { netns: netnsAvailable(), networkDefault: "disabled" },
    patchApplied: applied.ok,
    patchApplyError: applied.ok ? null : applied.error,
    checks: results,
    changedFilesBefore: before,
    changedFilesAfter: after,
    unexpectedChanges: unexpected,
    evaluatorSensitiveChanges: sensitive,
    applyDecision,
    generatedAt: new Date().toISOString(),
  };
  saveReport(repoId, report);

  fdn.emit(human ? summarize(report) : report, { human, table: () => render(report) });
  // Exit 0 only when the patch is safe to land unattended (gates pass AND the
  // definition-of-done was not touched); otherwise non-zero so agent loops stop.
  process.exit(applyDecision === "allowed" ? 0 : 1);
}

function summarize(r) {
  return {
    status: r.status,
    applyDecision: r.applyDecision,
    patchId: r.patchId,
    specSource: r.dod.specSource,
    checks: r.checks.map((c) => `${c.id}:${c.status}`),
    sensitive: r.evaluatorSensitiveChanges.length,
    unexpected: r.unexpectedChanges.length,
  };
}

function render(r) {
  const lines = [
    `STATUS: ${r.status.toUpperCase()}   apply: ${r.applyDecision}   patch: ${r.patchId}`,
    `definition-of-done: ${r.dod.specSource}   isolation: ${r.isolation.netns ? "netns (network off)" : "env-only (network off)"}`,
  ];
  if (!r.patchApplied) lines.push(`PATCH DID NOT APPLY: ${r.patchApplyError}`);
  lines.push(
    fdn.table(r.checks, [
      { key: "id", label: "GATE", width: 16 },
      { key: "status", label: "STATUS", width: 7 },
      { key: "exitCode", label: "EXIT", width: 5 },
      { key: "durationMs", label: "MS", width: 8 },
      { key: "isolation", label: "ISO" },
    ]),
  );
  if (r.evaluatorSensitiveChanges.length)
    lines.push(`\n⚠ patch modifies the definition-of-done itself: ${r.evaluatorSensitiveChanges.join(", ")}`);
  if (r.unexpectedChanges.length)
    lines.push(`\n✗ checks mutated the tree: ${r.unexpectedChanges.join(", ")}`);
  for (const f of r.checks.filter((c) => c.status !== "pass")) {
    if (f.outputTail) lines.push(`\n─ ${f.id} ─\n${f.outputTail.trim().split("\n").slice(-10).join("\n")}`);
  }
  return lines.join("\n");
}

function verifyApply(flags) {
  const human = flags._human;
  const { repo, staging, repoId } = ctxRepos(flags);
  const report = loadReport(repoId);
  if (!report) {
    console.error("no report; run `skillgate verify-patch` first");
    process.exit(1);
  }
  // Staleness tripwire: the report must describe the CURRENT staged patch.
  const { patchPath, patchId } = computePatch(staging, repoId);
  if (patchId !== report.patchId) {
    console.error(`stale report: staged patch ${patchId} != report ${report.patchId}; re-run verify-patch`);
    process.exit(3);
  }

  const allowed = report.applyDecision === "allowed";
  const override = typeof flags.override === "string" && flags.override.trim();
  if (!allowed && !override) {
    fdn.out({
      ok: false,
      blocked: true,
      applyDecision: report.applyDecision,
      status: report.status,
      hint: 'pass --override "<reason>" to force',
    });
    process.exit(1);
  }

  let landed = "applied";
  try {
    git(["apply", "--check", patchPath], { cwd: repo });
    applyPatchToReal(repo, patchPath);
  } catch {
    try {
      git(["apply", "--reverse", "--check", patchPath], { cwd: repo });
      landed = "already-present";
    } catch (e) {
      console.error(`cannot land patch cleanly: ${e.message}`);
      process.exit(4);
    }
  }
  const record = {
    ok: true,
    landed,
    repoId,
    patchId,
    override: override || null,
    status: report.status,
    at: new Date().toISOString(),
  };
  fs.appendFileSync(path.join(stateDir(repoId), "apply.log"), JSON.stringify(record) + "\n");
  fdn.emit(record, { human, table: () => `${landed} patch ${patchId} into ${repo}` });
}

const argv = process.argv.slice(2);
const sub = argv[0];
const { flags } = fdn.parseArgs(argv.slice(1), ["repo", "staging", "override"]);
flags._human = !argv.includes("--json"); // skillgate convention: human default, --json for machine
if (sub === "run") verifyRun(flags);
else if (sub === "apply") verifyApply(flags);
else {
  console.error("usage: verify.mjs run|apply [--repo P] [--staging P] [--override <reason>] [--json]");
  process.exit(2);
}

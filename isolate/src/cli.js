// cli.js — pi-gate command handlers. Built on cli-foundation (JSON default, -H human).
//
// Model (faithful to the scope doc):
//   --repo     the REAL repo: canonical target, kept clean until `apply`.
//   --staging  the agent's writable working tree (a clone of --repo the agent edited).
//              Defaults to --repo for the in-place case.
// The patch is computed from --staging's uncommitted work vs HEAD, evaluated in a
// fresh clone of --repo's HEAD, and only landed in --repo by the apply gate.
import fs from 'node:fs';
import path from 'node:path';
import * as fdn from '../vendor/foundation.js';
import { git, repoRootOf } from './git.js';
import { repoIdentity, stateDir } from './paths.js';
import { computePatch, patchChangedFiles, createEvalWorkspace, applyPatchTo, workingTreeChanges, applyPatchToReal } from './workspace.js';
import { resolveManifest, trustManifest } from './manifest.js';
import { netnsAvailable, runChecks } from './runner.js';
import { evaluatorSensitive, unexpectedChanges, decideApply, saveReport, loadReport } from './report.js';

function ctxRepos(flags) {
  const repo = repoRootOf(flags.repo || process.cwd());
  const staging = flags.staging ? repoRootOf(flags.staging) : repo;
  const { id: repoId, kind } = repoIdentity(repo, git);
  return { repo, staging, repoId, repoIdKind: kind };
}

const hasFileAt = (root) => (name) => fs.existsSync(path.join(root, name));

// pi-gate eval plan — show the selected manifest + commands (no execution).
function evalPlan(flags, { human }) {
  const { repo, repoId } = ctxRepos(flags);
  const res = resolveManifest(repoId, hasFileAt(repo));
  const data = {
    repoId, repo, source: res.source, trusted: res.trusted,
    profile: res.manifest.profile, netns: netnsAvailable(),
    checks: res.manifest.checks.map(c => ({
      id: c.id, command: c.command, cwd: c.cwd || '.',
      timeoutMs: c.timeoutMs || 60000, network: !!c.network,
    })),
    note: res.trusted ? 'trusted manifest' : 'DETECT-ONLY: run `pi-gate eval trust` after review before apply is allowed',
  };
  fdn.emit(data, { human, table: () =>
    `manifest: ${data.source} (${data.trusted ? 'trusted' : 'DETECT-ONLY'}) profile=${data.profile} netns=${data.netns}\n` +
    fdn.table(data.checks, [
      { key: 'id', label: 'CHECK', width: 14 }, { key: 'command', label: 'COMMAND' },
      { key: 'timeoutMs', label: 'TIMEOUT' }, { key: 'network', label: 'NET' },
    ]) + `\n\n${data.note}`,
  });
}

// pi-gate eval run — compute patch, evaluate in isolated workspace, emit report.
function evalRun(flags, { human }) {
  const { repo, staging, repoId, repoIdKind } = ctxRepos(flags);
  const sd = stateDir(repoId);

  const { patchPath, patchId, empty } = computePatch(staging, repoId);
  if (empty) { fdn.out({ status: 'error', error: 'no agent changes detected in staging tree', repoId }); process.exit(2); }

  const ws = createEvalWorkspace(repo, repoId);
  const res = resolveManifest(repoId, hasFileAt(ws));
  const applied = applyPatchTo(ws, patchPath);

  let changedFilesBefore = [], checks = [], changedFilesAfter = [], unexpected = [], sensitive = [];
  if (applied.ok) {
    changedFilesBefore = workingTreeChanges(ws);
    sensitive = evaluatorSensitive(changedFilesBefore, res.manifest.sensitivePatterns);
    const logsDir = path.join(sd, 'logs');
    checks = runChecks(res.manifest.checks, ws, logsDir);
    changedFilesAfter = workingTreeChanges(ws);
    unexpected = unexpectedChanges(changedFilesBefore, changedFilesAfter, res.manifest.allowlistChanged);
  }

  const { status, applyDecision } = decideApply({
    checks, applyError: applied.ok ? null : applied.error, unexpected, trusted: res.trusted,
  });

  const report = {
    schemaVersion: 1,
    status,
    patchId,
    repo: { id: repoId, idKind: repoIdKind, path: repo, head: git(['rev-parse', 'HEAD'], { cwd: repo }).trim() },
    manifest: { source: res.source, trusted: res.trusted, profile: res.manifest.profile },
    isolation: { netns: netnsAvailable(), networkDefault: 'disabled' },
    patchApplied: applied.ok,
    patchApplyError: applied.ok ? null : applied.error,
    checks,
    changedFilesBefore,
    changedFilesAfter,
    unexpectedChanges: unexpected,
    evaluatorSensitiveChanges: sensitive,
    applyDecision,
    generatedAt: new Date().toISOString(),
  };
  saveReport(repoId, report);
  // Keep the human view compact; full machine report is on disk + `eval report --json`.
  fdn.emit(human ? summarize(report) : report, { human, table: () => renderSummary(report) });
  process.exit(status === 'pass' ? 0 : 1);
}

function summarize(r) {
  return {
    status: r.status, applyDecision: r.applyDecision, patchId: r.patchId,
    checks: r.checks.map(c => `${c.id}:${c.status}`),
    sensitive: r.evaluatorSensitiveChanges.length, unexpected: r.unexpectedChanges.length,
  };
}
function renderSummary(r) {
  const lines = [
    `STATUS: ${r.status.toUpperCase()}   apply: ${r.applyDecision}   patch: ${r.patchId}`,
    `manifest: ${r.manifest.source} (${r.manifest.trusted ? 'trusted' : 'DETECT-ONLY'}) profile=${r.manifest.profile}`,
  ];
  if (!r.patchApplied) lines.push(`PATCH DID NOT APPLY: ${r.patchApplyError}`);
  lines.push(fdn.table(r.checks, [
    { key: 'id', label: 'CHECK', width: 14 }, { key: 'status', label: 'STATUS', width: 7 },
    { key: 'exitCode', label: 'EXIT', width: 5 }, { key: 'durationMs', label: 'MS', width: 7 },
    { key: 'isolation', label: 'ISO' },
  ]));
  if (r.evaluatorSensitiveChanges.length) lines.push(`\n⚠ evaluator-sensitive changes: ${r.evaluatorSensitiveChanges.join(', ')}`);
  if (r.unexpectedChanges.length) lines.push(`\n✗ unexpected files changed by checks: ${r.unexpectedChanges.join(', ')}`);
  return lines.join('\n');
}

// pi-gate eval report --json — print the last stable report.
function evalReport(flags) {
  const { repoId } = ctxRepos(flags);
  const r = loadReport(repoId);
  if (!r) { console.error('no report yet; run `pi-gate eval run`'); process.exit(1); }
  fdn.out(r);
}

// pi-gate eval trust — promote the detected manifest after human review.
function evalTrust(flags) {
  const { repo, repoId } = ctxRepos(flags);
  const res = resolveManifest(repoId, hasFileAt(repo));
  if (res.source === 'trusted') { fdn.out({ ok: true, alreadyTrusted: true, path: res.trustedPath }); return; }
  const p = trustManifest(repoId, res.manifest);
  fdn.out({ ok: true, trusted: p, profile: res.manifest.profile, repoId });
}

const evalSub = { plan: evalPlan, run: evalRun, report: evalReport, trust: evalTrust };

export const commands = {
  eval(args, ctx) {
    const sub = args[0];
    const { flags } = fdn.parseArgs(args.slice(1), ['repo', 'staging']);
    const fn = evalSub[sub];
    if (!fn) { console.error(`Unknown eval subcommand: ${sub || '(none)'}. Use plan|run|report|trust`); process.exit(1); }
    return fn(flags, ctx);
  },

  // pi-gate apply [--override <reason>] — land the verified patch into the real repo.
  apply(args, ctx) {
    const { flags } = fdn.parseArgs(args, ['repo', 'staging', 'override']);
    const { repo, staging, repoId } = ctxRepos(flags);
    const report = loadReport(repoId);
    if (!report) { console.error('no evaluator report; run `pi-gate eval run` first'); process.exit(1); }

    // Staleness tripwire: the report must describe the CURRENT staged patch.
    const { patchPath, patchId } = computePatch(staging, repoId);
    if (patchId !== report.patchId) {
      console.error(`stale report: staged patch ${patchId} != report patch ${report.patchId}; re-run eval`);
      process.exit(3);
    }

    const allowed = report.applyDecision === 'allowed';
    const override = typeof flags.override === 'string' && flags.override.trim();
    if (!allowed && !override) {
      fdn.out({ ok: false, blocked: true, applyDecision: report.applyDecision, status: report.status,
        hint: report.applyDecision === 'override-required' ? 'pass `--override "<reason>"` to force' : 'checks errored; fix and re-run' });
      process.exit(1);
    }

    // Land the patch. If it is already present (in-place staging===repo), bless it.
    let landed = 'applied';
    try {
      git(['apply', '--check', patchPath], { cwd: repo });
      applyPatchToReal(repo, patchPath);
    } catch {
      // Already applied? reverse-check confirms the tree already contains it.
      try { git(['apply', '--reverse', '--check', patchPath], { cwd: repo }); landed = 'already-present'; }
      catch (e) { console.error(`cannot land patch cleanly: ${e.message}`); process.exit(4); }
    }

    const record = {
      ok: true, landed, repoId, patchId,
      applyDecision: override && !allowed ? 'override-required' : 'allowed',
      override: override || null, status: report.status, at: new Date().toISOString(),
    };
    fs.appendFileSync(path.join(stateDir(repoId), 'apply.log'), JSON.stringify(record) + '\n');
    fdn.out(record);
  },

  help() {
    console.error(`pi-gate — harness-owned deterministic evaluator for Pi agent output

Usage: pi-gate <command> [--repo PATH] [--staging PATH] [--human]

  eval plan              show the selected manifest + checks (no execution)
  eval run               compute patch, evaluate in isolated workspace, write report
  eval report --json     print the last machine-readable report
  eval trust             promote the detected manifest to trusted (after review)
  apply                  land the patch into the real repo IFF report passed
  apply --override "..."  force-apply with an explicit reason when checks failed

  --repo PATH            the real (canonical) repo; default: cwd
  --staging PATH         the agent's working tree; default: --repo
  -H, --human            table output instead of JSON

Trust model: the evaluator config + runner live outside the agent's writable root,
network is disabled by default (rootless netns), and the real repo changes only on
a passing report or an explicit human override.`);
  },
};

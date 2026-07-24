// report.js — glob matching, report assembly, apply-gate decision, persistence.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './paths.js';

// Minimal, dependency-free glob -> RegExp. Supports ** (any depth), * (within a
// segment), ? (one char). Matches against POSIX-style relative paths.
export function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { // ** -> any depth (optionally /-terminated)
        re += '.*'; i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else if (c === '/') re += '/';
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

export function matchesAny(file, patterns) {
  return patterns.some(p => globToRe(p).test(file) || globToRe(p).test('./' + file));
}

// Identify which changed files are evaluator-sensitive (tests, lint/CI/pkg config,
// the manifest itself). Returns the matching subset.
export function evaluatorSensitive(files, sensitivePatterns) {
  return files.filter(f => matchesAny(f, sensitivePatterns));
}

// Files changed DURING evaluation that the patch did not introduce and that are
// not allowlisted (caches/temp). A non-empty list means a check mutated the tree.
export function unexpectedChanges(before, after, allowlist) {
  const beforeSet = new Set(before);
  return after.filter(f => !beforeSet.has(f) && !matchesAny(f, allowlist));
}

// Decide the overall status + apply decision.
export function decideApply({ checks, applyError, unexpected, trusted }) {
  const anyError = checks.some(c => c.status === 'error') || !!applyError;
  const anyFail = checks.some(c => c.status === 'fail');
  let status;
  if (applyError) status = 'error';
  else if (anyError) status = 'error';
  else if (anyFail || unexpected.length) status = 'fail';
  else status = 'pass';

  let applyDecision;
  if (status !== 'pass') applyDecision = status === 'error' ? 'blocked' : 'override-required';
  else if (!trusted) applyDecision = 'override-required'; // detect-only: needs trust or override
  else applyDecision = 'allowed';
  return { status, applyDecision };
}

export function reportPath(repoId) { return path.join(stateDir(repoId), 'report.json'); }
export function saveReport(repoId, report) {
  const p = reportPath(repoId);
  fs.writeFileSync(p, JSON.stringify(report, null, 2));
  return p;
}
export function loadReport(repoId) {
  const p = reportPath(repoId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

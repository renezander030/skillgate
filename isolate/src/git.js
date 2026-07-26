// git.js — thin synchronous git wrapper. No network ever touched here.
import { spawnSync } from 'node:child_process';

// git(args, {cwd, env, indexFile}) -> stdout string. Throws on non-zero exit.
export function git(args, { cwd = '.', env = {}, indexFile = null, allowFail = false } = {}) {
  const childEnv = { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' };
  if (indexFile) childEnv.GIT_INDEX_FILE = indexFile;
  const r = spawnSync('git', args, { cwd, env: childEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed (${r.status}): ${(r.stderr || '').trim()}`);
  }
  return r.stdout || '';
}

// Convenience bound to a fixed cwd.
export function gitIn(cwd) { return (args, opts = {}) => git(args, { ...opts, cwd }); }

export function repoRootOf(dir) {
  return git(['rev-parse', '--show-toplevel'], { cwd: dir }).trim();
}

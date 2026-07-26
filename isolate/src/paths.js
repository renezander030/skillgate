// paths.js — harness-owned locations. Deliberately OUTSIDE any agent-writable repo.
// State (patches, reports, logs, eval workspaces) and trusted manifests both live
// under the user's XDG dirs, never inside the repo under evaluation.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const HOME = os.homedir();
const XDG_STATE = process.env.XDG_STATE_HOME || path.join(HOME, '.local', 'state');
const XDG_CONFIG = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');

// Trusted manifests: harness-owned, read-only contract with the agent.
export const TRUSTED_MANIFEST_DIR = path.join(XDG_CONFIG, 'pi-gate', 'manifests');
// Per-repo runtime state (patch + last report + logs + disposable eval workspace).
const STATE_ROOT = path.join(XDG_STATE, 'pi-gate');

export function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d; }

// Stable repo identity = root commit sha (survives renames/moves); falls back to
// a hash of the absolute path for non-git or shallow repos.
export function repoIdentity(repoRoot, git) {
  try {
    const root = git(['rev-list', '--max-parents=0', 'HEAD'], { cwd: repoRoot }).trim().split('\n')[0];
    if (root) return { id: root, kind: 'root-commit' };
  } catch { /* fall through */ }
  const h = crypto.createHash('sha256').update(path.resolve(repoRoot)).digest('hex').slice(0, 16);
  return { id: `path-${h}`, kind: 'path-hash' };
}

export function stateDir(repoId) { return ensureDir(path.join(STATE_ROOT, repoId)); }
export function trustedManifestPath(repoId) {
  ensureDir(TRUSTED_MANIFEST_DIR);
  return path.join(TRUSTED_MANIFEST_DIR, `${repoId}.json`);
}

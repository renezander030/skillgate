// manifest.js — load / detect / validate / trust manifests.
//
// Resolution order:
//   1. Trusted manifest at TRUSTED_MANIFEST_DIR/<repoId>.json  -> trusted=true.
//   2. Otherwise detect a profile and use the built-in default -> trusted=false
//      (detect-only mode: eval runs, but apply requires `eval trust` or override).
import fs from 'node:fs';
import path from 'node:path';
import { PROFILES, detectProfile } from './profiles.js';
import { trustedManifestPath } from './paths.js';

const REQUIRED_CHECK_KEYS = ['id', 'command'];

export function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object') return ['manifest is not an object'];
  if (m.version !== 1) errors.push(`unsupported manifest version: ${m.version}`);
  if (!Array.isArray(m.checks) || m.checks.length === 0) errors.push('manifest has no checks');
  const seen = new Set();
  for (const [i, c] of (m.checks || []).entries()) {
    for (const k of REQUIRED_CHECK_KEYS) if (!c[k]) errors.push(`check[${i}] missing ${k}`);
    if (c.id && seen.has(c.id)) errors.push(`duplicate check id: ${c.id}`);
    if (c.id) seen.add(c.id);
    if (c.timeoutMs != null && (typeof c.timeoutMs !== 'number' || c.timeoutMs <= 0))
      errors.push(`check[${c.id || i}] invalid timeoutMs`);
    if (c.network != null && typeof c.network !== 'boolean')
      errors.push(`check[${c.id || i}] network must be boolean`);
  }
  return errors;
}

// hasFileAt(name) probes the eval workspace (clean HEAD) for a marker file.
export function resolveManifest(repoId, hasFileAt) {
  const trustedPath = trustedManifestPath(repoId);
  if (fs.existsSync(trustedPath)) {
    const m = JSON.parse(fs.readFileSync(trustedPath, 'utf8'));
    const errors = validateManifest(m);
    return { manifest: m, trusted: errors.length === 0, source: 'trusted', trustedPath, errors };
  }
  const profile = detectProfile(hasFileAt);
  const m = structuredClone(PROFILES[profile]);
  return { manifest: m, trusted: false, source: 'detected', profile, trustedPath, errors: [] };
}

// Promote a detected (or supplied) manifest to the trusted store after human review.
export function trustManifest(repoId, manifest) {
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(`refusing to trust invalid manifest: ${errors.join('; ')}`);
  const p = trustedManifestPath(repoId);
  const stamped = { ...manifest, trustedAt: new Date().toISOString() };
  fs.writeFileSync(p, JSON.stringify(stamped, null, 2));
  return p;
}

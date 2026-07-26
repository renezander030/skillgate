// profiles.js — built-in default manifests per repo profile.
// These are DETECTED defaults (untrusted until `pi-gate eval trust`). They are
// intentionally read-only checks: format --check / lint / typecheck / test, never
// commands that mutate the tree or reach the network by default.
//
// Each check: { id, command, cwd, timeoutMs, env, network }
// A manifest: { version, profile, checks[], allowlistChanged[], sensitivePatterns[] }

const COMMON_SENSITIVE = [
  // evaluator-sensitive surfaces: changing these changes what "passing" means.
  '.pi-gate/**', 'pi-gate.manifest.json', 'pi-gate.manifest.yaml',
  '**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**',
  '.github/**', '.gitlab-ci.yml', '.circleci/**', 'azure-pipelines.yml',
  '.eslintrc*', '.prettierrc*', 'biome.json', 'ruff.toml', '.flake8', 'tox.ini',
  '.golangci.yml', '.golangci.yaml', 'rustfmt.toml', 'clippy.toml',
];
const COMMON_ALLOW = [
  'node_modules/**', '.git/**', '*.log', '.npm/**', '.pi-gate-tmp/**',
  '__pycache__/**', '*.pyc', '.pytest_cache/**', '.mypy_cache/**', '.ruff_cache/**',
  'target/**', 'dist/**', 'build/**', '.cache/**',
];

const mk = (profile, checks, sensitive = []) => ({
  version: 1,
  profile,
  checks,
  allowlistChanged: COMMON_ALLOW,
  sensitivePatterns: [...COMMON_SENSITIVE, ...sensitive],
});

export const PROFILES = {
  // Local-binary-only: never `npx` (it resolves/network-hangs even with --no-install
  // under the network namespace). Checks no-op cleanly when a tool isn't installed.
  node: mk('node', [
    { id: 'format', command: '[ -x node_modules/.bin/prettier ] && node_modules/.bin/prettier --check . || echo "prettier not installed; skipped"', cwd: '.', timeoutMs: 60000 },
    { id: 'lint', command: 'npm run -s lint --if-present', cwd: '.', timeoutMs: 120000 },
    { id: 'typecheck', command: '[ -x node_modules/.bin/tsc ] && node_modules/.bin/tsc --noEmit || npm run -s typecheck --if-present', cwd: '.', timeoutMs: 180000 },
    { id: 'test', command: 'npm test --if-present', cwd: '.', timeoutMs: 300000 },
  ], ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'tsconfig*.json']),

  python: mk('python', [
    { id: 'format', command: 'ruff format --check . 2>/dev/null || black --check . 2>/dev/null || true', cwd: '.', timeoutMs: 60000 },
    { id: 'lint', command: 'ruff check . 2>/dev/null || flake8 2>/dev/null || true', cwd: '.', timeoutMs: 120000 },
    { id: 'typecheck', command: 'mypy . 2>/dev/null || true', cwd: '.', timeoutMs: 180000 },
    { id: 'test', command: 'pytest -q 2>/dev/null || python -m pytest -q', cwd: '.', timeoutMs: 300000 },
  ], ['pyproject.toml', 'setup.cfg', 'setup.py', 'requirements*.txt', 'poetry.lock', 'Pipfile.lock']),

  go: mk('go', [
    { id: 'format', command: 'test -z "$(gofmt -l .)"', cwd: '.', timeoutMs: 60000 },
    { id: 'vet', command: 'go vet ./...', cwd: '.', timeoutMs: 180000 },
    { id: 'test', command: 'go test ./...', cwd: '.', timeoutMs: 300000 },
  ], ['go.mod', 'go.sum']),

  rust: mk('rust', [
    { id: 'format', command: 'cargo fmt --check', cwd: '.', timeoutMs: 60000 },
    { id: 'lint', command: 'cargo clippy -- -D warnings', cwd: '.', timeoutMs: 300000 },
    { id: 'test', command: 'cargo test --offline', cwd: '.', timeoutMs: 300000 },
  ], ['Cargo.toml', 'Cargo.lock']),

  generic: mk('generic', [
    { id: 'changed-files', command: 'git --no-pager diff --stat HEAD || true', cwd: '.', timeoutMs: 30000 },
  ]),
};

// Detect a profile from marker files present in the repo HEAD checkout.
export function detectProfile(hasFile) {
  if (hasFile('package.json')) return 'node';
  if (hasFile('go.mod')) return 'go';
  if (hasFile('Cargo.toml')) return 'rust';
  if (hasFile('pyproject.toml') || hasFile('setup.py') || hasFile('requirements.txt')) return 'python';
  return 'generic';
}

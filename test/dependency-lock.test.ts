import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkManifest } from "../src/deps.js";
import { snapshotKey } from "../src/receipt.js";
import { runGates } from "../src/core.js";

function project(t: any, files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-dependency-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
const pythonLock = (...names: string[]) => names.map(name => `[[package]]\nname = '${name}'\n`).join("\n");

test("Python groups include optional and development requirements without treating comments as packages", t => {
  const dir = project(t, {
    "pyproject.toml": `[project]\nname = 'example'\ndependencies = [\n  'Requests[socks]>=2', # \"comment-package\"\n]\n[project.optional-dependencies]\n'web.extra' = ['Flask>=3']\n[dependency-groups]\n'Docs.Build' = ['Sphinx>=7']\ntest = ['pytest>=8', {include-group = 'docs_build'}]\n`,
    "uv.lock": pythonLock("requests", "flask", "pytest"),
  });
  const report = checkManifest(path.join(dir, "pyproject.toml"));
  assert.equal(report.error, undefined);
  assert.deepEqual(report.declared, ["flask", "pytest", "requests", "sphinx"]);
  assert.deepEqual(report.missing, ["sphinx"]);
  fs.writeFileSync(path.join(dir, "uv.lock"), pythonLock(...report.declared));
  assert.equal(runGates({ gates: [{ id: "deps", type: "deps-locked" }] }, dir).passed, true);
});

test("Poetry checks every named group, including quoted groups and legacy development dependencies", t => {
  const dir = project(t, {
    "pyproject.toml": `[tool.poetry.dependencies]\npython = '^3.11'\nhttpx = {version = '^0.28'}\n[tool.poetry.dev-dependencies]\npytest = '^8'\n[tool.poetry.group.'docs.build'.dependencies]\nSphinx = '^7'\n[tool.poetry.group.typing.dependencies]\ntyping_extensions = '^4'\n`,
    "poetry.lock": pythonLock("httpx", "pytest", "typing-extensions"),
  });
  const report = checkManifest(path.join(dir, "pyproject.toml"));
  assert.deepEqual(report.declared, ["httpx", "pytest", "sphinx", "typing-extensions"]);
  assert.deepEqual(report.missing, ["sphinx"]);
});

test("malformed Python dependency structures and includes fail instead of declaring no dependencies", t => {
  const invalid = [
    "[project\ndependencies = ['pytest']",
    "[project]\ndependencies = 'pytest'",
    "[project]\ndependencies = [42]",
    "[project]\ndependencies = ['!!!']",
    "[project]\noptional-dependencies = []",
    "dependency-groups = []",
    "[dependency-groups]\nBad_ = []",
    "[dependency-groups]\n'Docs.Build' = []\ndocs_build = []",
    "[dependency-groups]\ntest = 'pytest'",
    "[dependency-groups]\ntest = [{include-group = 'missing'}]",
    "[dependency-groups]\na = [{include-group = 'b'}]\nb = [{include-group = 'a'}]",
    "[dependency-groups]\na = [{include-group = 'a', extra = true}]",
    "[dependency-groups]\na = [42]",
    "[dependency-groups]\na = [{include-group = 42}]",
    "[tool.poetry.group]\ntest = 'invalid'",
  ];
  const dir = project(t, { "pyproject.toml": "", "uv.lock": pythonLock("pytest") });
  for (const text of invalid) {
    fs.writeFileSync(path.join(dir, "pyproject.toml"), text);
    assert.match(checkManifest(path.join(dir, "pyproject.toml")).error ?? "", /cannot parse manifest/, text);
  }
});

test("Python lockfile matching reads package entries and rejects invalid TOML", t => {
  const dir = project(t, { "pyproject.toml": "[project]\ndependencies = ['pytest']\n", "uv.lock": "" });
  for (const text of ["[[package]\nname = 'pytest'", "[package]\nname = 'pytest'", "[[package]]\nversion = '8'", "[[package]]\nname = 42"]) {
    fs.writeFileSync(path.join(dir, "uv.lock"), text);
    assert.match(checkManifest(path.join(dir, "pyproject.toml")).error ?? "", /cannot parse uv.lock/);
  }
  fs.writeFileSync(path.join(dir, "uv.lock"), "[metadata]\nname = 'pytest'\n");
  assert.deepEqual(checkManifest(path.join(dir, "pyproject.toml")).missing, ["pytest"]);
});

test("pnpm cannot satisfy a root declaration from another workspace importer", t => {
  const dir = project(t, {
    "package.json": JSON.stringify({ dependencies: { yaml: "^2" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/other:\n    dependencies:\n      yaml: {specifier: ^2, version: 2.6.0}\n",
  });
  assert.deepEqual(checkManifest(path.join(dir, "package.json")).missing, ["yaml"]);
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  packages/other: {}\n");
  assert.match(checkManifest(path.join(dir, "package.json")).error ?? "", /no pnpm importer for \./);
});

test("nested manifests select their own shared pnpm importer and receipts include the shared lockfile", t => {
  const dir = project(t, {
    "pnpm-workspace.yaml": "packages: ['packages/*']\n",
    "packages/my app/package.json": JSON.stringify({ dependencies: { yaml: "^2" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      yaml: {specifier: ^2, version: 2.6.0}\n  packages/my app: {}\n",
  });
  const workspace = path.join(dir, "packages/my app");
  const manifest = path.join(workspace, "package.json");
  assert.deepEqual(checkManifest(manifest).missing, ["yaml"]);
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/my app:\n    dependencies:\n      yaml: {specifier: ^2, version: 2.6.0}\n");
  const report = checkManifest(manifest);
  assert.equal(report.error, undefined);
  assert.deepEqual(report.missing, []);
  assert.equal(report.lockfile, path.join(dir, "pnpm-lock.yaml"));
  const spec = { gates: [{ id: "deps", type: "deps-locked" as const }] };
  const snapshot = snapshotKey(spec, workspace);
  fs.appendFileSync(path.join(dir, "pnpm-lock.yaml"), "# lock changed\n");
  assert.notEqual(snapshotKey(spec, workspace), snapshot);
});

test("legacy flat pnpm locks remain valid at the root and malformed importers fail", t => {
  const dir = project(t, {
    "package.json": JSON.stringify({ dependencies: { yaml: "^2" } }),
    "pnpm-lock.yaml": "lockfileVersion: 5.4\ndependencies:\n  yaml: 2.6.0\n",
  });
  assert.deepEqual(checkManifest(path.join(dir, "package.json")).missing, []);
  for (const text of ["importers: null\ndependencies: {yaml: 2}", "importers: []", "importers:\n  .: 42", "importers:\n  .:\n    dependencies: []", "importers:\n  .:\n    dependencies:\n      yaml: 1\n      yaml: 2"]) {
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), text);
    assert.match(checkManifest(path.join(dir, "package.json")).error ?? "", /cannot parse pnpm-lock.yaml/);
  }
});

test("pnpm lookup respects nested workspace boundaries and prefers adjacent lockfiles", t => {
  const dir = project(t, {
    "pnpm-lock.yaml": "importers:\n  nested/pkg:\n    dependencies:\n      yaml: {version: 2.6.0}\n",
    "nested/pnpm-workspace.yaml": "packages: ['pkg']\n",
    "nested/pkg/package.json": JSON.stringify({ dependencies: { yaml: "^2" } }),
  });
  const manifest = path.join(dir, "nested/pkg/package.json");
  assert.match(checkManifest(manifest).error ?? "", /no lockfile/);
  fs.writeFileSync(path.join(dir, "nested/pkg/package-lock.json"), JSON.stringify({ packages: { "node_modules/yaml": {} } }));
  assert.deepEqual(checkManifest(manifest).missing, []);
});

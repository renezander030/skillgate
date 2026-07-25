import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGates, isFinishLine } from "../src/core.js";
import type { Spec } from "../src/spec.js";

function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test("file-exists: passes when present, fails when missing", () => {
  const dir = tmpProject({ "README.md": "hi" });
  const spec: Spec = {
    gates: [
      { id: "have-readme", type: "file-exists", file: "README.md" },
      { id: "have-license", type: "file-exists", file: "LICENSE" },
    ],
  };
  const r = runGates(spec, dir);
  assert.equal(r.passed, false);
  assert.equal(r.results.find((x) => x.id === "have-readme")?.ok, true);
  assert.equal(r.results.find((x) => x.id === "have-license")?.ok, false);
});

test("file-contains: regex with flags", () => {
  const dir = tmpProject({ "CHANGELOG.md": "## Unreleased\n- thing" });
  const spec: Spec = {
    gates: [{ id: "changelog", type: "file-contains", file: "CHANGELOG.md", pattern: "unreleased", flags: "i" }],
  };
  assert.equal(runGates(spec, dir).passed, true);
});

test("absent: catches a secret and reports file:line", () => {
  const dir = tmpProject({ "src/a.ts": "const ok = 1\n", "src/b.ts": "const k = 'sk_live_abc'\n" });
  const spec: Spec = {
    gates: [{ id: "no-secrets", type: "absent", glob: "src/**/*.ts", pattern: "sk_live_" }],
  };
  const r = runGates(spec, dir);
  assert.equal(r.passed, false);
  assert.match(r.failed[0].reason, /b\.ts:1/);
});

test("absent: passes when clean", () => {
  const dir = tmpProject({ "src/a.ts": "const ok = 1\n" });
  const spec: Spec = {
    gates: [{ id: "no-todo", type: "absent", glob: "src/**/*.ts", pattern: "TODO" }],
  };
  assert.equal(runGates(spec, dir).passed, true);
});

test("command: pass on exit 0, fail on nonzero", () => {
  const dir = tmpProject({});
  assert.equal(runGates({ gates: [{ id: "ok", type: "command", run: "true" }] }, dir).passed, true);
  assert.equal(runGates({ gates: [{ id: "bad", type: "command", run: "false" }] }, dir).passed, false);
});

test("command: timeout kills a hanging command", () => {
  const dir = tmpProject({});
  const r = runGates({ gates: [{ id: "hang", type: "command", run: 'node -e "setTimeout(()=>{},10000)"', timeout: 100 }] }, dir);
  assert.equal(r.passed, false);
  const gate = r.results.find((x) => x.id === "hang")!;
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, "command timed out after 100ms");
});

test("trivy: runs secret, critical vuln, and sbom checks", () => {
  const dir = tmpProject({});
  const trivy = path.join(dir, "fake-trivy.sh");
  fs.writeFileSync(
    trivy,
    `#!/bin/sh
printf '%s\\n' "$*" >> invocations.txt
if [ "$2" = "--format" ]; then
  printf '{"bomFormat":"CycloneDX"}\\n'
fi
exit 0
`,
  );
  fs.chmodSync(trivy, 0o755);

  const r = runGates({ gates: [{ id: "trivy-clean", type: "trivy", trivy }] }, dir);
  assert.equal(r.passed, true);
  assert.match(r.results[0].reason, /secret, vuln:CRITICAL, sbom:cyclonedx/);
  const invocations = fs.readFileSync(path.join(dir, "invocations.txt"), "utf8");
  assert.match(invocations, /fs --scanners secret --exit-code 1 --no-progress \./);
  assert.match(invocations, /fs --scanners vuln --severity CRITICAL --exit-code 1 --no-progress \./);
  assert.match(invocations, /fs --format cyclonedx --no-progress \./);
});

test("trivy: blocks leaked secrets without applying CVE severity filtering", () => {
  const dir = tmpProject({});
  const trivy = path.join(dir, "fake-trivy.sh");
  fs.writeFileSync(
    trivy,
    `#!/bin/sh
if [ "$3" = "secret" ]; then
  echo "SECRET_KEY leaked" >&2
  exit 1
fi
printf '{"bomFormat":"CycloneDX"}\\n'
exit 0
`,
  );
  fs.chmodSync(trivy, 0o755);

  const r = runGates({ gates: [{ id: "trivy-clean", type: "trivy", trivy }] }, dir);
  assert.equal(r.passed, false);
  assert.equal(r.failed[0].ok, false);
  assert.match(r.failed[0].reason, /--scanners secret/);
  assert.match(r.failed[0].reason, /SECRET_KEY leaked/);
});

test("trivy: supports custom vulnerability severity and skipping sbom", () => {
  const dir = tmpProject({});
  const trivy = path.join(dir, "fake-trivy.sh");
  fs.writeFileSync(
    trivy,
    `#!/bin/sh
printf '%s\\n' "$*" >> invocations.txt
exit 0
`,
  );
  fs.chmodSync(trivy, 0o755);

  const spec: Spec = {
    gates: [
      {
        id: "trivy-high",
        type: "trivy",
        trivy,
        scanners: ["vuln"],
        severity: ["HIGH", "CRITICAL"],
        ignoreUnfixed: true,
        sbom: false,
      },
    ],
  };
  const r = runGates(spec, dir);
  assert.equal(r.passed, true);
  const invocations = fs.readFileSync(path.join(dir, "invocations.txt"), "utf8");
  assert.match(invocations, /--severity HIGH,CRITICAL --exit-code 1 --no-progress --ignore-unfixed \./);
  assert.doesNotMatch(invocations, /--format cyclonedx/);
});

test("evidence: requires a non-empty file", () => {
  const dir = tmpProject({ "notes.md": "found it" });
  assert.equal(runGates({ gates: [{ id: "e", type: "evidence", file: "notes.md" }] }, dir).passed, true);
  assert.equal(runGates({ gates: [{ id: "e", type: "evidence", file: "missing.md" }] }, dir).passed, false);
});

test("not-empty: passes when directory has entries", () => {
  const dir = tmpProject({ "docs/api/readme.md": "hello", "docs/api/guide.md": "world" });
  const r = runGates({ gates: [{ id: "ne", type: "not-empty", path: "docs/api" }] }, dir);
  assert.equal(r.passed, true);
  assert.equal(r.results[0].ok, true);
});

test("not-empty: fails on empty directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-"));
  try {
    const r = runGates({ gates: [{ id: "ne", type: "not-empty", path: "." }] }, dir);
    assert.equal(r.passed, false);
    assert.equal(r.results[0].ok, false);
    assert.match(r.results[0].reason, /expected at least 1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("not-empty: fails on missing directory", () => {
  const dir = tmpProject({});
  const r = runGates({ gates: [{ id: "ne", type: "not-empty", path: "nosuchdir" }] }, dir);
  assert.equal(r.passed, false);
  assert.equal(r.results[0].ok, false);
  assert.match(r.results[0].reason, /directory not found/);
});

test("not-empty: respects min option", () => {
  const dir = tmpProject({ "stuff/a.txt": "a", "stuff/b.txt": "b" });
  // min: 3 → fail
  const r1 = runGates({ gates: [{ id: "ne", type: "not-empty", path: "stuff", min: 3 }] }, dir);
  assert.equal(r1.passed, false);
  assert.match(r1.results[0].reason, /expected at least 3/);
  // min: 2 → pass
  const r2 = runGates({ gates: [{ id: "ne", type: "not-empty", path: "stuff", min: 2 }] }, dir);
  assert.equal(r2.passed, true);
});

test("isFinishLine: substring match against patterns", () => {
  assert.equal(isFinishLine("git commit -m x", ["git commit", "git push"]), true);
  assert.equal(isFinishLine("ls -la", ["git commit"]), false);
  assert.equal(isFinishLine("anything", undefined), false);
});

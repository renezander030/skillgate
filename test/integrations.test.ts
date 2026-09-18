import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { doctor, installIntegration, INTEGRATION_TARGETS } from "../src/integrations.js";

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-integrations-"));
  fs.mkdirSync(path.join(dir, ".skillgate"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".skillgate", "done.yaml"), "gates:\n  - id: readme\n    type: file-exists\n    file: README.md\n");
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  return dir;
}

test("installIntegration installs all adapters idempotently and doctor verifies them", (t) => {
  const dir = project();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Read"] } }));

  for (const target of INTEGRATION_TARGETS) assert.equal(installIntegration(target, dir).changed, true);
  for (const target of INTEGRATION_TARGETS) assert.equal(installIntegration(target, dir).changed, false);

  const settings = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(settings.permissions.allow, ["Read"]);
  assert.match(JSON.stringify(settings), /@reneza\/skillgate@\d+\.\d+\.\d+ gate/);
  assert.match(fs.readFileSync(path.join(dir, "opencode.json"), "utf8"), /@reneza\/skillgate/);
  const workflow = fs.readFileSync(path.join(dir, ".github", "workflows", "skillgate.yml"), "utf8");
  assert.match(workflow, /pull_request/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(fs.readFileSync(path.join(dir, ".pre-commit-config.yaml"), "utf8"), /pass_filenames: false/);

  assert.ok(doctor(dir).every((check) => check.ok));
});

test("install and doctor resolve the policy-owning workspace from a nested directory", (t) => {
  const dir = project();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "packages", "app"), { recursive: true });
  const nested = path.join(dir, "packages", "app");
  const installed = installIntegration("opencode", nested);
  assert.equal(installed.file, path.join(dir, "opencode.json"));
  assert.ok(doctor(nested, ["opencode"]).every((check) => check.ok));
});

test("doctor reports a missing policy and missing integration", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-integrations-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const checks = doctor(dir, ["opencode"]);
  assert.equal(checks[0].ok, false);
  assert.equal(checks[1].ok, false);
});

test("install refuses malformed or unrelated files instead of overwriting them", (t) => {
  const dir = project();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "opencode.json"), "{ broken");
  assert.throws(() => installIntegration("opencode", dir), /cannot update/);

  const workflow = path.join(dir, ".github", "workflows", "skillgate.yml");
  fs.mkdirSync(path.dirname(workflow), { recursive: true });
  fs.writeFileSync(workflow, "name: something-else\n");
  assert.throws(() => installIntegration("github-actions", dir), /not a Skillgate workflow/);
});

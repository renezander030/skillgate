import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { findSpecPath, loadSpec, specRoot } from "./spec.js";
import { repoRoot } from "./git.js";

export const INTEGRATION_TARGETS = ["claude-code", "opencode", "github-actions", "pre-commit"] as const;
export type IntegrationTarget = (typeof INTEGRATION_TARGETS)[number];

export interface InstallResult {
  target: IntegrationTarget;
  changed: boolean;
  file: string;
  detail: string;
}

export interface DoctorCheck {
  id: string;
  ok: boolean;
  detail: string;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function packageRef(): string {
  const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  return `@reneza/skillgate@${pkg.version}`;
}

function projectRoot(cwd: string): string {
  const spec = findSpecPath(cwd);
  return spec ? specRoot(spec) : (repoRoot(cwd) ?? cwd);
}

function readJson(file: string): any {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error: any) {
    throw new Error(`cannot update ${file}: ${error.message}`);
  }
}

function installClaude(cwd: string): InstallResult {
  const file = path.join(cwd, ".claude", "settings.json");
  const data = readJson(file);
  data.hooks ??= {};
  data.hooks.PreToolUse ??= [];
  if (!Array.isArray(data.hooks.PreToolUse)) throw new Error(`${file}: hooks.PreToolUse must be an array`);
  const marker = "@reneza/skillgate@";
  const exists = JSON.stringify(data.hooks.PreToolUse).includes(marker);
  if (!exists) {
    data.hooks.PreToolUse.push({
      matcher: "Bash",
      hooks: [{ type: "command", command: `npx --yes ${packageRef()} gate` }],
    });
    writeJson(file, data);
  }
  return { target: "claude-code", changed: !exists, file, detail: exists ? "hook already registered" : "registered fail-closed PreToolUse hook" };
}

function installOpenCode(cwd: string): InstallResult {
  const file = path.join(cwd, "opencode.json");
  const data = readJson(file);
  data.$schema ??= "https://opencode.ai/config.json";
  data.plugin ??= [];
  if (!Array.isArray(data.plugin)) throw new Error(`${file}: plugin must be an array`);
  const exists = data.plugin.includes("@reneza/skillgate");
  if (!exists) {
    data.plugin.push("@reneza/skillgate");
    writeJson(file, data);
  }
  return { target: "opencode", changed: !exists, file, detail: exists ? "plugin already registered" : "registered Skillgate plugin" };
}

function actionWorkflow(): string {
  return `name: skillgate
on: [pull_request]

permissions:
  contents: read

jobs:
  gates:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: '20'
      - run: npx --yes ${packageRef()} check --json
`;
}

function installGitHubActions(cwd: string): InstallResult {
  const file = path.join(cwd, ".github", "workflows", "skillgate.yml");
  if (fs.existsSync(file)) {
    const old = fs.readFileSync(file, "utf8");
    if (!old.includes("@reneza/skillgate")) throw new Error(`${file} already exists and is not a Skillgate workflow`);
    return { target: "github-actions", changed: false, file, detail: "workflow already installed" };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, actionWorkflow());
  return { target: "github-actions", changed: true, file, detail: "installed pull-request workflow" };
}

function installPreCommit(cwd: string): InstallResult {
  const file = path.join(cwd, ".pre-commit-config.yaml");
  const data: any = fs.existsSync(file) ? parseYaml(fs.readFileSync(file, "utf8")) : {};
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${file}: expected a YAML object`);
  data.repos ??= [];
  if (!Array.isArray(data.repos)) throw new Error(`${file}: repos must be an array`);
  const exists = JSON.stringify(data.repos).includes("@reneza/skillgate");
  if (!exists) {
    data.repos.push({
      repo: "local",
      hooks: [{
        id: "skillgate",
        name: "skillgate definition-of-done",
        entry: `npx --yes ${packageRef()} check`,
        language: "system",
        pass_filenames: false,
        stages: ["pre-commit"],
      }],
    });
    fs.writeFileSync(file, stringifyYaml(data));
  }
  return { target: "pre-commit", changed: !exists, file, detail: exists ? "hook already installed" : "installed pre-commit hook" };
}

export function installIntegration(target: IntegrationTarget, cwd: string): InstallResult {
  const root = projectRoot(cwd);
  switch (target) {
    case "claude-code": return installClaude(root);
    case "opencode": return installOpenCode(root);
    case "github-actions": return installGitHubActions(root);
    case "pre-commit": return installPreCommit(root);
  }
}

function fileContains(file: string, marker: string): boolean {
  return fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(marker);
}

export function doctor(cwd: string, targets: readonly IntegrationTarget[] = INTEGRATION_TARGETS): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const spec = findSpecPath(cwd);
  const root = spec ? specRoot(spec) : (repoRoot(cwd) ?? cwd);
  if (!spec) {
    checks.push({ id: "policy", ok: false, detail: "no Skillgate policy found" });
  } else {
    try {
      loadSpec(spec);
      checks.push({ id: "policy", ok: true, detail: `${path.relative(cwd, spec)} is valid; workspace ${specRoot(spec)}` });
    } catch (error: any) {
      checks.push({ id: "policy", ok: false, detail: error.message });
    }
  }
  const probes: Record<IntegrationTarget, [string, string]> = {
    "claude-code": [path.join(root, ".claude", "settings.json"), "@reneza/skillgate@"],
    "opencode": [path.join(root, "opencode.json"), "@reneza/skillgate"],
    "github-actions": [path.join(root, ".github", "workflows", "skillgate.yml"), "@reneza/skillgate"],
    "pre-commit": [path.join(root, ".pre-commit-config.yaml"), "@reneza/skillgate"],
  };
  for (const target of targets) {
    const [file, marker] = probes[target];
    checks.push({ id: target, ok: fileContains(file, marker), detail: fileContains(file, marker) ? `configured in ${path.relative(cwd, file)}` : `not configured (${path.relative(cwd, file)})` });
  }
  return checks;
}

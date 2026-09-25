import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { findSpecPath, loadSpec, specRoot } from "./spec.js";
import { repoRoot } from "./git.js";

export const INTEGRATION_TARGETS = ["claude-code", "codex", "gemini-cli", "cursor", "opencode", "github-actions", "pre-commit"] as const;
export type IntegrationTarget = (typeof INTEGRATION_TARGETS)[number];

export interface InstallOptions {
  /** claude-code: also gate the agent's Stop event, so it cannot end a turn with unmet gates. */
  stop?: boolean;
}

/** Hook budget in seconds. Long enough for a test suite; a hook that times out fails open in most agents. */
export const HOOK_TIMEOUT_SECONDS = 600;
const MARKER = "@reneza/skillgate@";
/** Appended to every agent hook: any failure to run the gate (npx, network) becomes a block. */
const FAIL_CLOSED = " || exit 2";

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

/** The shell command an agent hook runs. Exit 2 blocks in every supported agent. */
export function gateCommand(extra = ""): string {
  return `npx --yes ${packageRef()} gate${extra}${FAIL_CLOSED}`;
}

/** Regex source for a tool-name glob (`*` any run, `?` one character). */
export function toolGlobToRegex(glob: string): string {
  return glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
}

/** The policy's `gatedTools`, or none when there is no valid policy. */
function gatedTools(root: string): string[] {
  const spec = findSpecPath(root);
  try {
    return spec ? loadSpec(spec).gatedTools ?? [] : [];
  } catch {
    return [];
  }
}

/** Hook matcher: the agent's shell tool plus every gated tool, so the hook fires for both. */
function toolMatcher(shell: string, root: string): string {
  return [shell, ...gatedTools(root).map(toolGlobToRegex)].join("|");
}

type Upsert = "added" | "updated" | "unchanged";

/** Add or replace this package's entry in one hook event list. */
function upsertHook(hooks: Record<string, unknown>, event: string, entry: unknown, file: string): Upsert {
  hooks[event] ??= [];
  const list = hooks[event];
  if (!Array.isArray(list)) throw new Error(`${file}: hooks.${event} must be an array`);
  const index = list.findIndex((item) => JSON.stringify(item).includes(MARKER));
  if (index < 0) {
    list.push(entry);
    return "added";
  }
  if (JSON.stringify(list[index]) === JSON.stringify(entry)) return "unchanged";
  list[index] = entry;
  return "updated";
}

function hookResult(target: IntegrationTarget, file: string, outcomes: Upsert[], what: string, data: unknown): InstallResult {
  const changed = outcomes.some((o) => o !== "unchanged");
  if (changed) writeJson(file, data);
  const detail = !changed
    ? `${what} already registered`
    : outcomes.includes("updated") ? `updated ${what} to the fail-closed form` : `registered fail-closed ${what}`;
  return { target, changed, file, detail };
}

function installClaude(cwd: string, opts: InstallOptions): InstallResult {
  const file = path.join(cwd, ".claude", "settings.json");
  const data = readJson(file);
  data.hooks ??= {};
  const outcomes = [upsertHook(data.hooks, "PreToolUse", {
    matcher: toolMatcher("Bash", cwd),
    hooks: [{ type: "command", command: gateCommand(), timeout: HOOK_TIMEOUT_SECONDS }],
  }, file)];
  if (opts.stop) {
    outcomes.push(upsertHook(data.hooks, "Stop", {
      hooks: [{ type: "command", command: gateCommand(" --event stop"), timeout: HOOK_TIMEOUT_SECONDS }],
    }, file));
  }
  return hookResult("claude-code", file, outcomes, opts.stop ? "PreToolUse and Stop hooks" : "PreToolUse hook", data);
}

function installCodex(cwd: string): InstallResult {
  const file = path.join(cwd, ".codex", "hooks.json");
  const data = readJson(file);
  data.hooks ??= {};
  const outcome = upsertHook(data.hooks, "PreToolUse", {
    matcher: toolMatcher("Bash", cwd),
    hooks: [{ type: "command", command: gateCommand(), timeout: HOOK_TIMEOUT_SECONDS, statusMessage: "skillgate: checking definition of done" }],
  }, file);
  const result = hookResult("codex", file, [outcome], "PreToolUse hook", data);
  if (result.changed) result.detail += " — review and trust it in Codex before it runs";
  return result;
}

function installGemini(cwd: string): InstallResult {
  const file = path.join(cwd, ".gemini", "settings.json");
  const data = readJson(file);
  data.hooks ??= {};
  const outcome = upsertHook(data.hooks, "BeforeTool", {
    matcher: toolMatcher("run_shell_command", cwd),
    hooks: [{ name: "skillgate", type: "command", command: gateCommand(" --format gemini"), timeout: HOOK_TIMEOUT_SECONDS * 1000 }],
  }, file);
  return hookResult("gemini-cli", file, [outcome], "BeforeTool hook", data);
}

function installCursor(cwd: string): InstallResult {
  const file = path.join(cwd, ".cursor", "hooks.json");
  const data = readJson(file);
  data.version ??= 1;
  data.hooks ??= {};
  const outcome = upsertHook(data.hooks, "beforeShellExecution", {
    command: gateCommand(" --format cursor"),
    timeout: HOOK_TIMEOUT_SECONDS,
    failClosed: true,
  }, file);
  return hookResult("cursor", file, [outcome], "beforeShellExecution hook", data);
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
      - run: npx --yes ${packageRef()} check --format github
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

export function installIntegration(target: IntegrationTarget, cwd: string, opts: InstallOptions = {}): InstallResult {
  const root = projectRoot(cwd);
  switch (target) {
    case "claude-code": return installClaude(root, opts);
    case "codex": return installCodex(root);
    case "gemini-cli": return installGemini(root);
    case "cursor": return installCursor(root);
    case "opencode": return installOpenCode(root);
    case "github-actions": return installGitHubActions(root);
    case "pre-commit": return installPreCommit(root);
  }
}

function fileContains(file: string, marker: string): boolean {
  return fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(marker);
}

/** Gated tools a target's hook matcher does not include (only agents whose hooks match tool names). */
function uncovered(target: IntegrationTarget, file: string, root: string): string[] {
  if (!["claude-code", "codex", "gemini-cli"].includes(target)) return [];
  const text = fs.readFileSync(file, "utf8");
  return gatedTools(root).filter((glob) => !text.includes(JSON.stringify(toolGlobToRegex(glob)).slice(1, -1)));
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
  // [config file, marker, fail-closed marker (agent hooks only)]
  const probes: Record<IntegrationTarget, [string, string, string?]> = {
    "claude-code": [path.join(root, ".claude", "settings.json"), MARKER, FAIL_CLOSED.trim()],
    "codex": [path.join(root, ".codex", "hooks.json"), MARKER, FAIL_CLOSED.trim()],
    "gemini-cli": [path.join(root, ".gemini", "settings.json"), MARKER, FAIL_CLOSED.trim()],
    "cursor": [path.join(root, ".cursor", "hooks.json"), MARKER, '"failClosed": true'],
    "opencode": [path.join(root, "opencode.json"), "@reneza/skillgate"],
    "github-actions": [path.join(root, ".github", "workflows", "skillgate.yml"), "@reneza/skillgate"],
    "pre-commit": [path.join(root, ".pre-commit-config.yaml"), "@reneza/skillgate"],
  };
  for (const target of targets) {
    const [file, marker, failClosed] = probes[target];
    const rel = path.relative(cwd, file);
    if (!fileContains(file, marker)) {
      checks.push({ id: target, ok: false, detail: `not configured (${rel})` });
    } else if (failClosed && !fileContains(file, failClosed)) {
      checks.push({ id: target, ok: false, detail: `configured in ${rel} but fails open when the gate cannot run — re-run \`skillgate install ${target}\`` });
    } else if (uncovered(target, file, root).length) {
      checks.push({ id: target, ok: false, detail: `hook in ${rel} does not cover gatedTools ${uncovered(target, file, root).join(", ")} — re-run \`skillgate install ${target}\`` });
    } else {
      checks.push({ id: target, ok: true, detail: `configured in ${rel}` });
    }
  }
  return checks;
}

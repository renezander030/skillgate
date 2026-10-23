import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parse as parseToml } from "smol-toml";
import { findSpecPath, loadSpec, specRoot, workspaceRoot } from "./spec.js";
import { writeTextAtomic, withInstallLock } from "./files.js";
import { EVALUATOR_VERSION } from "./receipt.js";

export const INTEGRATION_TARGETS = ["claude-code", "codex", "copilot-cli", "gemini-cli", "cursor", "opencode", "github-actions", "pre-commit"] as const;
export type IntegrationTarget = (typeof INTEGRATION_TARGETS)[number];

/** Agents whose Stop hook takes Claude's `decision: "block"` answer, so `--stop` can gate the end of a turn. */
export const STOP_TARGETS: readonly IntegrationTarget[] = ["claude-code", "codex", "copilot-cli"];

export interface InstallOptions {
  /** claude-code, codex, copilot-cli: also gate the agent's Stop event, so it cannot end a turn with unmet gates. */
  stop?: boolean;
}

/** Hook budget in seconds. Long enough for a test suite; a hook that times out fails open in most agents. */
const HOOK_TIMEOUT_SECONDS = 600;
export const GATE_TIMEOUT_MS = 540_000;
/** The npm package every installed hook, plugin entry and workflow names; the doctor looks for it. */
const PACKAGE = "@reneza/skillgate";
/** A versioned reference to the package (`@reneza/skillgate@<version>`) marks this package's hook entries. */
const MARKER = `${PACKAGE}@`;
/** The hook's own gate budget, below the agent's hook timeout so the gate answers first. */
const TIMEOUT_FLAG = `--timeout ${GATE_TIMEOUT_MS}`;
/** Claude Code's Stop hook protocol, which Codex and Copilot CLI accept too. */
const STOP_FORMAT = "--format claude-stop";
/** The gate invocation a Stop hook runs. */
const STOP_GATE = ` --event stop ${STOP_FORMAT}`;
/** Command hooks block when the gate cannot run; Stop hooks use a JSON fallback. */
const FAIL_CLOSED = " || exit 2";
const STOP_FAIL_CLOSED = ` || node -e "console.log(JSON.stringify({decision:'block',reason:'Skillgate could not run; restore the gate before finishing.'}))"`;

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
  writeTextAtomic(file, JSON.stringify(value, null, 2) + "\n");
}

function packageRef(): string {
  return `${MARKER}${EVALUATOR_VERSION}`;
}

function readJson(file: string): any {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error: any) {
    throw new Error(`cannot update ${file}: ${error.message}`);
  }
}

/** The shell command an agent hook runs, with the protocol's blocking fallback. */
export function gateCommand(extra = ""): string {
  return `npx --yes ${packageRef()} gate ${TIMEOUT_FLAG}${extra}${extra.includes(STOP_FORMAT) ? STOP_FAIL_CLOSED : FAIL_CLOSED}`;
}

/** Regex source for a tool-name glob (`*` any run, `?` one character). */
function toolGlobToRegex(glob: string): string {
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

/**
 * Register the gate on an agent's PreToolUse event (its shell tool plus `gatedTools`) and,
 * with `--stop`, on its Stop event. `entry` writes one hook in the agent's own format; it
 * gets no matcher for Stop. `init` sets top-level fields the file needs before `hooks`.
 */
function installGateHooks(target: IntegrationTarget, file: string, cwd: string, opts: InstallOptions,
  entry: (command: string, matcher?: string) => unknown, init: (data: any) => void = () => {}): InstallResult {
  const data = readJson(file);
  init(data);
  data.hooks ??= {};
  const outcomes = [upsertHook(data.hooks, "PreToolUse", entry(gateCommand(), toolMatcher("Bash", cwd)), file)];
  if (opts.stop) outcomes.push(upsertHook(data.hooks, "Stop", entry(gateCommand(STOP_GATE)), file));
  return hookResult(target, file, outcomes, opts.stop ? "PreToolUse and Stop hooks" : "PreToolUse hook", data);
}

function installClaude(cwd: string, opts: InstallOptions): InstallResult {
  return installGateHooks("claude-code", path.join(cwd, ".claude", "settings.json"), cwd, opts, (command, matcher) => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }],
  }));
}

function installCodex(cwd: string, opts: InstallOptions): InstallResult {
  const result = installGateHooks("codex", path.join(cwd, ".codex", "hooks.json"), cwd, opts, (command, matcher) => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS, statusMessage: "skillgate: checking definition of done" }],
  }));
  if (result.changed) result.detail += " — review and trust it in Codex before it runs";
  return result;
}

/**
 * GitHub Copilot CLI (and its cloud agent) loads `.github/hooks/*.json`. PascalCase events get
 * Claude-format payloads and matchers, and a command hook that exits non-zero denies the tool call.
 */
function installCopilot(cwd: string, opts: InstallOptions): InstallResult {
  return installGateHooks("copilot-cli", path.join(cwd, ".github", "hooks", "skillgate.json"), cwd, opts, (command, matcher) => ({
    type: "command",
    ...(matcher ? { matcher } : {}),
    command,
    timeoutSec: HOOK_TIMEOUT_SECONDS,
  }), (data) => { data.version ??= 1; });
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
  const exists = data.plugin.includes(PACKAGE);
  if (!exists) {
    data.plugin.push(PACKAGE);
    writeJson(file, data);
  }
  return { target: "opencode", changed: !exists, file, detail: exists ? "plugin already registered" : "registered Skillgate plugin" };
}

/** A reference to this package in a command, with or without a version pin. */
const PACKAGE_PATTERN = /@reneza\/skillgate(?:@[^\s"';&|]+)?(?=\s|["';&|]|$)/;
/** Every pinned reference to this package (`@reneza/skillgate@<version>`) and its version. */
const PINNED_PATTERN = /@reneza\/skillgate@([^\s"';&|\\]+)/g;
/** The actions the generated workflow runs, pinned to a commit with the release as a comment. */
const ACTION_PINS: Record<string, string> = {
  "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  "actions/setup-node": "949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0",
};
/** The workflow's Node release line: a maintained LTS. */
const WORKFLOW_NODE = "22";

function actionWorkflow(): string {
  return `name: skillgate
on: [pull_request]

permissions:
  contents: read

jobs:
  gates:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${ACTION_PINS["actions/checkout"]}
        with:
          fetch-depth: 0
      - uses: actions/setup-node@${ACTION_PINS["actions/setup-node"]}
        with:
          node-version: '${WORKFLOW_NODE}'
      - run: npx --yes ${packageRef()} check --format github
`;
}

function installGitHubActions(cwd: string): InstallResult {
  const file = path.join(cwd, ".github", "workflows", "skillgate.yml");
  if (fs.existsSync(file)) {
    const old = fs.readFileSync(file, "utf8");
    if (!old.includes(PACKAGE)) throw new Error(`${file} already exists and is not a Skillgate workflow`);
    const upgraded = upgradeWorkflow(old);
    if (upgraded === old) return { target: "github-actions", changed: false, file, detail: "workflow already installed" };
    writeTextAtomic(file, upgraded);
    return { target: "github-actions", changed: true, file, detail: "upgraded workflow to this Skillgate version and its pinned actions" };
  }
  writeTextAtomic(file, actionWorkflow());
  return { target: "github-actions", changed: true, file, detail: "installed pull-request workflow" };
}

/**
 * An installed Skillgate workflow brought up to date in place: the package pin, the pinned
 * actions and an end-of-life Node 20 line. Everything else the owner edited stays as it is.
 */
function upgradeWorkflow(text: string): string {
  let out = text.replace(new RegExp(PACKAGE_PATTERN.source, "g"), packageRef());
  for (const [action, pin] of Object.entries(ACTION_PINS)) {
    out = out.replace(new RegExp(`(uses:\\s*${action.replace("/", "\\/")})@[0-9a-f]{40}(?:[ \\t]*#[^\\n]*)?`, "g"), `$1@${pin}`);
  }
  return out.replace(/^(\s*node-version:\s*)(['"]?)(?:18|20)\2[ \t]*$/m, `$1'${WORKFLOW_NODE}'`);
}

function installPreCommit(cwd: string): InstallResult {
  const file = path.join(cwd, ".pre-commit-config.yaml");
  const data: any = fs.existsSync(file) ? parseYaml(fs.readFileSync(file, "utf8")) : {};
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${file}: expected a YAML object`);
  data.repos ??= [];
  if (!Array.isArray(data.repos)) throw new Error(`${file}: repos must be an array`);
  const owned = data.repos.flatMap((repo: any) => repo?.repo === "local" && Array.isArray(repo.hooks) ? repo.hooks : [])
    .find((hook: any) => hook?.id === "skillgate" && typeof hook.entry === "string" && PACKAGE_PATTERN.test(hook.entry));
  const wanted = {
    id: "skillgate", name: owned?.name ?? "skillgate definition-of-done",
    entry: owned ? owned.entry.replace(PACKAGE_PATTERN, packageRef()) : `npx --yes ${packageRef()} check`,
    language: "system", pass_filenames: false, always_run: true,
    stages: [...new Set([...(Array.isArray(owned?.stages) ? owned.stages : []), "pre-commit"])],
  };
  const changed = !owned || Object.entries(wanted).some(([key, value]) => JSON.stringify(owned[key]) !== JSON.stringify(value));
  if (owned) Object.assign(owned, wanted);
  else {
    data.repos.push({
      repo: "local",
      hooks: [wanted],
    });
  }
  if (changed) {
    writeTextAtomic(file, stringifyYaml(data));
  }
  return { target: "pre-commit", changed, file, detail: changed ? "installed or upgraded always-run pre-commit hook" : "hook already installed" };
}

export function installIntegration(target: IntegrationTarget, cwd: string, opts: InstallOptions = {}): InstallResult {
  const root = workspaceRoot(findSpecPath(cwd), cwd);
  return withInstallLock(root, () => {
    switch (target) {
    case "claude-code": return installClaude(root, opts);
    case "codex": return installCodex(root, opts);
    case "copilot-cli": return installCopilot(root, opts);
    case "gemini-cli": return installGemini(root);
    case "cursor": return installCursor(root);
    case "opencode": return installOpenCode(root);
    case "github-actions": return installGitHubActions(root);
    case "pre-commit": return installPreCommit(root);
    }
  });
}

/** Gated tools a target's hook matcher does not include (only agents whose hooks match tool names). */
function uncovered(target: IntegrationTarget, text: string, root: string): string[] {
  if (!["claude-code", "codex", "copilot-cli", "gemini-cli"].includes(target)) return [];
  return gatedTools(root).filter((glob) => !text.includes(JSON.stringify(toolGlobToRegex(glob)).slice(1, -1)));
}

export function doctor(cwd: string, targets: readonly IntegrationTarget[] = INTEGRATION_TARGETS): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const spec = findSpecPath(cwd);
  const root = workspaceRoot(spec, cwd);
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
    "copilot-cli": [path.join(root, ".github", "hooks", "skillgate.json"), MARKER, FAIL_CLOSED.trim()],
    "gemini-cli": [path.join(root, ".gemini", "settings.json"), MARKER, FAIL_CLOSED.trim()],
    "cursor": [path.join(root, ".cursor", "hooks.json"), MARKER, '"failClosed": true'],
    "opencode": [path.join(root, "opencode.json"), PACKAGE],
    "github-actions": [path.join(root, ".github", "workflows", "skillgate.yml"), PACKAGE],
    "pre-commit": [path.join(root, ".pre-commit-config.yaml"), PACKAGE],
  };
  for (const target of targets) {
    const [file, marker, failClosed] = probes[target];
    const rel = path.relative(cwd, file);
    const problem = integrationProblem(target, file, marker, failClosed, rel, root);
    checks.push(problem ? { id: target, ok: false, detail: problem } : { id: target, ok: true, detail: `configured in ${rel}` });
  }
  return checks;
}

/** The first thing that keeps one integration from enforcing the policy, or null when it is healthy. */
function integrationProblem(target: IntegrationTarget, file: string, marker: string, failClosed: string | undefined, rel: string, root: string): string | null {
  const reinstall = `re-run \`skillgate install ${target}\``;
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (text == null || !text.includes(marker)) return `not configured (${rel})`;
  const off = hooksOff(target, root);
  if (off) return `configured in ${rel} but ${off}, so the hook never runs`;
  if (failClosed && !text.includes(failClosed)) return `configured in ${rel} but fails open when the gate cannot run — ${reinstall}`;
  const missing = uncovered(target, text, root);
  if (missing.length) return `hook in ${rel} does not cover gatedTools ${missing.join(", ")} — ${reinstall}`;
  if (target === "pre-commit" && !preCommitHealthy(file)) return `hook in ${rel} can skip commits — ${reinstall}`;
  if (STOP_TARGETS.includes(target) && !stopHookHealthy(file)) return `Stop hook in ${rel} needs Claude JSON output — re-run \`skillgate install ${target} --stop\``;
  if (failClosed && !text.includes(TIMEOUT_FLAG)) return `hook in ${rel} lacks an internal timeout — ${reinstall}`;
  const stale = stalePins(text);
  if (stale.length) return `${rel} pins ${PACKAGE}@${stale.join(", ")}, not this version (${EVALUATOR_VERSION}) — ${reinstall}`;
  return null;
}

function preCommitHealthy(file: string): boolean {
  try {
    const data: any = parseYaml(fs.readFileSync(file, "utf8"));
    return data.repos?.some((repo: any) => repo.repo === "local" && repo.hooks?.some((hook: any) =>
      hook.id === "skillgate" && hook.entry?.includes(PACKAGE) && hook.always_run === true && hook.pass_filenames === false));
  } catch { return false; }
}

function stopHookHealthy(file: string): boolean {
  try {
    const entries = readJson(file).hooks?.Stop ?? [];
    // Claude Code and Codex nest commands under `hooks`; Copilot CLI entries are the command itself.
    const commands: unknown[] = entries.flatMap((entry: any) => [entry?.command, ...(Array.isArray(entry?.hooks) ? entry.hooks.map((hook: any) => hook?.command) : [])]);
    return !commands.some((command) => typeof command === "string" && command.includes(MARKER)
      && (!command.includes(STOP_FORMAT) || !command.includes(TIMEOUT_FLAG) || !command.includes(STOP_FAIL_CLOSED)));
  } catch { return false; }
}

/** Versions of this package a config text pins other than the running one (an upgrade the hooks have not followed). */
function stalePins(text: string): string[] {
  const pinned = [...text.matchAll(PINNED_PATTERN)].map((match) => match[1]);
  return [...new Set(pinned)].filter((version) => version !== EVALUATOR_VERSION);
}

/**
 * Why an agent will not run the project's hooks even though they are registered, or null.
 * Claude Code skips every hook under `disableAllHooks`; Codex skips hooks.json when its
 * `hooks` feature is turned off in the project's config.
 */
function hooksOff(target: IntegrationTarget, root: string): string | null {
  if (target === "claude-code") {
    for (const name of ["settings.json", "settings.local.json"]) {
      const file = path.join(root, ".claude", name);
      try {
        if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8"))?.disableAllHooks === true) return `.claude/${name} sets disableAllHooks`;
      } catch { /* an unreadable settings file is reported by the hook probes */ }
    }
  }
  if (target === "codex") {
    const file = path.join(root, ".codex", "config.toml");
    try {
      if (fs.existsSync(file) && (parseToml(fs.readFileSync(file, "utf8")) as any)?.features?.hooks === false) return ".codex/config.toml turns off [features] hooks";
    } catch { return ".codex/config.toml cannot be parsed"; }
  }
  return null;
}

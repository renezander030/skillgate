import { findSpecPath, loadSpec, specRoot } from "./spec.js";
import { runGates, isFinishLine, isGatedTool } from "./core.js";

/**
 * opencode plugin.
 *
 * opencode has no blocking session-end hook, so enforcement lives where it can
 * actually stop the agent: `tool.execute.before`. We intercept finish-line bash
 * commands (commit / push / publish) and any tool listed in `gatedTools` (MCP
 * tools, say), and throw to deny them until the deterministic gates in
 * `.skillgate/done.yaml` pass.
 *
 * The model is irrelevant — the judge is a script, so this works with whatever
 * model you've plugged into opencode.
 *
 * For full type-safety, install `@opencode-ai/plugin` and annotate with `Plugin`.
 */
type Hooks = Record<string, (...args: any[]) => any>;

export const SkillGate = async (ctx: any): Promise<Hooks> => {
  const directory: string = ctx?.directory ?? process.cwd();
  return {
    "tool.execute.before": async (input: any, output: any) => {
      const tool: string = input?.tool ?? "";
      const command: string = tool === "bash" ? output?.args?.command ?? "" : "";
      if (tool === "bash" && !command) return;

      const specPath = findSpecPath(directory);
      if (!specPath) return;

      let spec;
      try {
        spec = loadSpec(specPath);
      } catch (e: any) {
        // Shell commands fail closed. Other tools stay usable so the policy can be repaired.
        if (tool !== "bash") return;
        throw new Error(`skillgate blocked tool execution: configured policy is invalid (${e.message})`);
      }
      // Shell commands cross the finish line by `finishLine`; any other tool by `gatedTools`.
      const gated = tool === "bash" ? isFinishLine(command, spec.finishLine) : isGatedTool(tool, spec.gatedTools);
      if (!gated) return;

      const result = runGates(spec, specRoot(specPath), tool === "bash" ? { command } : { tool });
      if (!result.passed) {
        const detail = result.failed.map((f) => `${f.id} (${f.reason})`).join("; ");
        const what = tool === "bash" ? `"${command}"` : `tool ${tool}`;
        throw new Error(
          `skillgate blocked ${what}. Unmet gates: ${detail}. Complete them, then retry.`,
        );
      }
    },
  };
};

export default SkillGate;

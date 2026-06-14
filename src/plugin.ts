import { findSpecPath, loadSpec } from "./spec.js";
import { runGates, isFinishLine } from "./core.js";

/**
 * opencode plugin.
 *
 * opencode has no blocking session-end hook, so enforcement lives where it can
 * actually stop the agent: `tool.execute.before`. We intercept finish-line bash
 * commands (commit / push / publish) and throw to deny them until the
 * deterministic gates in `.skillgate/done.yaml` pass.
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
      if (input?.tool !== "bash") return;
      const command: string = output?.args?.command ?? "";
      if (!command) return;

      const specPath = findSpecPath(directory);
      if (!specPath) return;

      let spec;
      try {
        spec = loadSpec(specPath);
      } catch {
        return; // never block on a broken spec
      }
      if (!isFinishLine(command, spec.finishLine)) return;

      const result = runGates(spec, directory);
      if (!result.passed) {
        const detail = result.failed.map((f) => `${f.id} (${f.reason})`).join("; ");
        throw new Error(
          `skillgate blocked "${command}". Unmet gates: ${detail}. Complete them, then retry.`,
        );
      }
    },
  };
};

export default SkillGate;

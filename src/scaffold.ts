// `skillgate scaffold` — generates .skillgate/evidence/ directory with expected
// files and a README explaining what evidence the agent must produce before
// crossing the finish line. `--template <name>` pre-populates evidence files
// for common stacks.
import fs from "node:fs";
import path from "node:path";

export interface ScaffoldOptions {
  /** Stack template name. */
  template?: string;
  /** Directory to scaffold into. */
  cwd: string;
  /** Whether to update AGENTS.md/CLAUDE.md with agent instructions. */
  updateAgents?: boolean;
}

export interface ScaffoldResult {
  lines: string[];
  created: number;
}

interface TemplateConfig {
  name: string;
  description: string;
  /** Evidence file specs: relative path under .skillgate/evidence/ → content. */
  evidenceFiles: Record<string, string>;
}

const TEMPLATES: Record<string, TemplateConfig> = {
  generic: {
    name: "generic",
    description: "General-purpose evidence workflow",
    evidenceFiles: {
      "test-output.txt": `# Test Output
# Save the output of your test runner here before committing.
# Example: npm test --silent > .skillgate/evidence/test-output.txt
`,
      "lint-report.txt": `# Lint Report
# Save the output of your linter here before committing.
# Example: npm run lint > .skillgate/evidence/lint-report.txt
`,
      "diff-review.md": `# Self-Review of Changes
# Write a brief review of your own changes before committing. Answer:
# 1. What did this change accomplish?
# 2. Which files did it touch and why?
# 3. Are there any side effects or regressions to consider?
# 4. What was tested and how?
`,
    },
  },
  "ts-lib": {
    name: "ts-lib",
    description: "TypeScript library — typecheck, test, lint, coverage",
    evidenceFiles: {
      "typecheck-output.txt": `# TypeScript Typecheck Output
# Save the output of tsc --noEmit here before committing.
# Example: tsc --noEmit > .skillgate/evidence/typecheck-output.txt 2>&1
`,
      "test-output.txt": `# Test Output
# Save the output of your test runner here before committing.
# Example: npm test --silent > .skillgate/evidence/test-output.txt
`,
      "lint-report.txt": `# Lint Report
# Save the output of your linter here before committing.
# Example: npm run lint > .skillgate/evidence/lint-report.txt
`,
      "coverage-summary.txt": `# Coverage Summary
# Save the coverage summary here before committing.
# Example: npm run test:coverage > .skillgate/evidence/coverage-summary.txt
`,
      "diff-review.md": `# Self-Review of Changes
# Write a brief review of your own changes before committing. Answer:
# 1. What did this change accomplish?
# 2. Which files did it touch and why?
# 3. Are there any side effects or regressions to consider?
# 4. What was tested and how?
`,
    },
  },
  react: {
    name: "react",
    description: "React / Next.js application",
    evidenceFiles: {
      "typecheck-output.txt": `# TypeScript Typecheck Output
# Save the output of tsc --noEmit here before committing.
# Example: tsc --noEmit > .skillgate/evidence/typecheck-output.txt 2>&1
`,
      "lint-report.txt": `# ESLint Output
# Save the output of eslint here before committing.
# Example: eslint . --max-warnings=0 > .skillgate/evidence/lint-report.txt 2>&1
`,
      "test-output.txt": `# Test Output
# Save the output of your test runner here before committing.
# Example: npm test --silent > .skillgate/evidence/test-output.txt
`,
      "diff-review.md": `# Self-Review of Changes
# Write a brief review of your own changes before committing. Answer:
# 1. What did this change accomplish?
# 2. Which components/files did it touch and why?
# 3. Are there any UI regressions or accessibility concerns?
# 4. What was tested and how?
`,
    },
  },
  python: {
    name: "python",
    description: "Python application",
    evidenceFiles: {
      "test-output.txt": `# Test Output
# Save the output of your test runner here before committing.
# Example: pytest . > .skillgate/evidence/test-output.txt 2>&1
`,
      "lint-report.txt": `# Lint Report
# Save the output of your linter here before committing.
# Example: ruff check . > .skillgate/evidence/lint-report.txt 2>&1
`,
      "typecheck-output.txt": `# Type Check Output
# Save the output of mypy/pyright here before committing.
# Example: mypy src/ > .skillgate/evidence/typecheck-output.txt 2>&1
`,
      "diff-review.md": `# Self-Review of Changes
# Write a brief review of your own changes before committing. Answer:
# 1. What did this change accomplish?
# 2. Which modules/files did it touch and why?
# 3. Are there any performance or side effects to consider?
# 4. What was tested and how?
`,
    },
  },
};

const EVIDENCE_README = `# Evidence Files

This directory holds the proof that the agent actually performed the steps it
claimed before crossing the finish line.

## How it works

Each file in this directory is expected to be written by the AI coding agent
*before* it commits, pushes, or publishes. The \`evidence\` gates in
\`.skillgate/done.yaml\` verify that each file exists and is non-empty.

**skillgate does not check the content quality — it checks that the step was
run.** The LLM grading its own output is structurally blind to its own
deviations (the Compliance Gap). skillgate solves this by having a deterministic
judge verify that observable evidence was produced.

## Workflow

1. Make changes
2. Run each check and save the output:
   \`\`\`
   npm test --silent > .skillgate/evidence/test-output.txt
   npm run lint > .skillgate/evidence/lint-report.txt
   \`\`\`
3. Write a self-review of the diff:
   \`\`\`
   # opens .skillgate/evidence/diff-review.md in your editor
   \`\`\`
4. Run \`npx @reneza/skillgate check\`
5. If all gates pass, commit

## The evidence gates are the audit trail

If a post-deployment incident traces back to a step that should have been
caught, the evidence files tell you whether the agent ran the check at all.
This is not about punishing the agent — it is about knowing what happened.
`;

const AGENTS_PREAMBLE = `# Agent instructions for skillgate evidence workflow

## Before any commit, push, or publish:

1. **Run all checks and save output:**
   \`\`\`
   npm test --silent > .skillgate/evidence/test-output.txt
   npm run lint > .skillgate/evidence/lint-report.txt
   \`\`\`

2. **Write a self-review of your changes:**
   Open \`.skillgate/evidence/diff-review.md\` and answer the questions there.

3. **Run the gate:**
   \`\`\`
   npx @reneza/skillgate check
   \`\`\`

4. **Do not cross the finish line if any gate fails.**
   If a gate fails, fix the issue, re-run the check, and re-save the evidence.

`;

/**
 * Generate .skillgate/evidence/ directory with template files and README.
 */
export function runScaffold(opts: ScaffoldOptions): ScaffoldResult {
  const { cwd, template: templateName = "generic", updateAgents = false } = opts;

  const template = TEMPLATES[templateName];
  if (!template) {
    const available = Object.keys(TEMPLATES).sort().join(", ");
    throw new Error(
      `unknown template "${templateName}". Available: ${available}`,
    );
  }

  const evidenceDir = path.join(cwd, ".skillgate", "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });

  const lines: string[] = [];
  let created = 0;

  for (const [relPath, content] of Object.entries(template.evidenceFiles)) {
    const filePath = path.join(evidenceDir, relPath);
    if (fs.existsSync(filePath)) {
      lines.push(`  · .skillgate/evidence/${relPath}  already exists`);
      continue;
    }
    fs.writeFileSync(filePath, content);
    lines.push(`  + .skillgate/evidence/${relPath}`);
    created++;
  }

  // Write README if not present
  const readmePath = path.join(evidenceDir, "README.md");
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, EVIDENCE_README);
    lines.push(`  + .skillgate/evidence/README.md`);
    created++;
  } else {
    lines.push(`  · .skillgate/evidence/README.md  already exists`);
  }

  if (created === 0) {
    lines.push(`\n  nothing to create — all evidence files already present`);
  } else {
    lines.push(`\n  ${created} file(s) created in .skillgate/evidence/`);
    lines.push(`  template: ${templateName} — ${template.description}`);
  }

  // Write done.yaml evidence gates if they're not already present
  const donePath = path.join(cwd, ".skillgate", "done.yaml");
  if (fs.existsSync(donePath)) {
    const existing = fs.readFileSync(donePath, "utf8");
    const hasEvidenceGates = Object.keys(template.evidenceFiles).some((f) =>
      existing.includes(f),
    );
    if (!hasEvidenceGates) {
      lines.push(`\n  ! .skillgate/done.yaml  needs evidence gates — add them manually or run \`skillgate init\``);
    }
  }

  // Update AGENTS.md / CLAUDE.md with agent instructions
  if (updateAgents) {
    const agentsPath = path.join(cwd, "AGENTS.md");
    const claudePath = path.join(cwd, "CLAUDE.md");
    const targetPath = fs.existsSync(agentsPath) ? agentsPath : claudePath;

    if (fs.existsSync(targetPath)) {
      const current = fs.readFileSync(targetPath, "utf8");
      if (!current.includes("skillgate evidence workflow")) {
        const updated = current.trimEnd() + "\n\n" + AGENTS_PREAMBLE;
        fs.writeFileSync(targetPath, updated);
        lines.push(`  + ${path.basename(targetPath)}  updated with evidence workflow instructions`);
        created++;
      } else {
        lines.push(`  · ${path.basename(targetPath)}  already has evidence workflow instructions`);
      }
    } else {
      // Write a new AGENTS.md
      fs.writeFileSync(agentsPath, AGENTS_PREAMBLE);
      lines.push(`  + AGENTS.md  created with evidence workflow instructions`);
      created++;
    }
  }

  return { lines, created };
}

/** List available scaffold templates (for CLI help). */
export function listTemplates(): string[] {
  return Object.keys(TEMPLATES).sort();
}

/** Get template description. */
export function describeTemplate(name: string): string | undefined {
  return TEMPLATES[name]?.description;
}

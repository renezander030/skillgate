// `skillgate sync` — ported from adrift's `link`. Converts every tool's
// instruction file into a pointer to, symlink of, or synced copy of AGENTS.md,
// creating AGENTS.md from the freshest source if absent. Idempotent.
import fs from "node:fs";
import path from "node:path";
import {
  discover,
  pickCanonical,
  pointsTo,
  IMPORT_CAPABLE,
  LINK_HEADER,
  TOOL_SPECS,
  type Source,
} from "./drift.js";
import { toolId } from "./spec.js";

export interface SyncOptions {
  dryRun?: boolean;
  symlink?: boolean;
  /**
   * Tool ids (`claude-code`, `gemini-cli`, ...) to give their own instruction file
   * when they have none: an `@AGENTS.md` pointer for import-capable tools, a synced
   * copy otherwise. Tools that only reach AGENTS.md through a fallback may skip it.
   */
  create?: string[];
}

export interface SyncResult {
  lines: string[];
  changed: number;
}

/** Return leading YAML frontmatter block including delimiters, or "". */
function frontmatterOf(content: string): string {
  if (!content.startsWith("---\n")) return "";
  const rest = content.slice(4);
  const idx = rest.indexOf("\n---\n");
  return idx >= 0 ? "---\n" + rest.slice(0, idx) + "\n---\n" : "";
}

/** Symlink target for AGENTS.md relative to the dir of `filePath`. */
function relTarget(root: string, filePath: string): string {
  const rel = path.relative(path.dirname(filePath), path.join(root, "AGENTS.md"));
  return rel.split(path.sep).join("/");
}

export function runSync(root: string, opts: SyncOptions = {}): SyncResult {
  const { dryRun = false, symlink = false } = opts;
  const lines: string[] = [];
  const sources = discover(root);
  if (sources.length === 0) {
    lines.push(`no agent instruction files found in ${root}`);
    return { lines, changed: 0 };
  }

  const verb = dryRun ? "would be " : "";

  let canonContent = "";
  let hasAgentsMd = false;
  for (const s of sources) {
    if (s.tool === "AGENTS.md") {
      canonContent = s.content;
      hasAgentsMd = true;
    }
  }
  if (!hasAgentsMd) {
    const freshest = pickCanonical(sources);
    canonContent = freshest.content;
    lines.push(`  + AGENTS.md  ${verb}created from ${freshest.files.join(", ")}`);
    if (!dryRun) fs.writeFileSync(path.join(root, "AGENTS.md"), canonContent);
  }
  // pointsTo needs a canonical identity even before AGENTS.md exists on disk.
  const canonRef = { files: ["AGENTS.md"] } as Source;

  let changed = 0;
  for (const src of sources) {
    if (src.tool === "AGENTS.md") continue;
    const label = src.files.join(", ");

    if (src.files.length > 1) {
      lines.push(`  ! ${label}  skipped: directory-based rules, link manually`);
      continue;
    }
    if (
      src.linkTarget.toLowerCase() === "agents.md" ||
      pointsTo(src.lines, canonRef)
    ) {
      lines.push(`  · ${label}  already linked`);
      continue;
    }

    const filePath = path.join(root, src.files[0].split("/").join(path.sep));

    if (symlink) {
      const target = relTarget(root, filePath);
      lines.push(`  ~ ${label}  ${verb}symlinked to ${target}`);
      if (!dryRun) {
        fs.rmSync(filePath);
        fs.symlinkSync(target, filePath);
      }
    } else if (IMPORT_CAPABLE.has(src.tool)) {
      lines.push(`  ~ ${label}  ${verb}replaced with @AGENTS.md pointer`);
      if (!dryRun) fs.writeFileSync(filePath, "@AGENTS.md\n");
    } else {
      const desired = frontmatterOf(src.content) + LINK_HEADER + "\n\n" + canonContent;
      if (src.content === desired) {
        lines.push(`  · ${label}  already in sync`);
        continue;
      }
      lines.push(`  ~ ${label}  ${verb}synced copy (${src.tool} has no import support)`);
      if (!dryRun) fs.writeFileSync(filePath, desired);
    }
    changed++;
  }

  for (const id of opts.create ?? []) {
    const spec = TOOL_SPECS.find((t) => toolId(t.name) === toolId(id));
    if (!spec) {
      lines.push(`  ! ${id}  unknown tool (known: ${TOOL_SPECS.map((t) => toolId(t.name)).join(", ")})`);
      continue;
    }
    if (spec.name === "AGENTS.md" || sources.some((src) => src.tool === spec.name)) continue;
    const rel = spec.patterns.find((p) => !/[*?{}[\]]/.test(p))!;
    const filePath = path.join(root, rel.split("/").join(path.sep));
    const content = IMPORT_CAPABLE.has(spec.name) ? "@AGENTS.md\n" : LINK_HEADER + "\n\n" + canonContent;
    lines.push(`  + ${rel}  ${verb}created ${IMPORT_CAPABLE.has(spec.name) ? "as an @AGENTS.md pointer" : "as a synced copy"} for ${spec.name}`);
    if (!dryRun) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
    changed++;
  }

  lines.push(`\n${changed} instruction files ${verb}linked to AGENTS.md`);
  return { lines, changed };
}

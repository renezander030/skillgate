// Instruction-file drift detection, ported from adrift (github.com/renezander030/adrift,
// folded into skillgate). Keeps AI agent instruction files — CLAUDE.md, AGENTS.md,
// .cursor/rules, .github/copilot-instructions.md and friends — from drifting apart.
// Pure: same workspace, same verdict. No model, no network.
import fs from "node:fs";
import path from "node:path";
import { globSync } from "tinyglobby";

export const LINK_HEADER =
  "<!-- skillgate: generated from AGENTS.md — edit that file instead -->";

/** Maps an AI coding tool to the instruction-file locations it reads, in priority order. */
interface ToolSpec {
  name: string;
  patterns: string[];
}

export const TOOL_SPECS: ToolSpec[] = [
  { name: "AGENTS.md", patterns: ["AGENTS.md"] },
  { name: "Claude Code", patterns: ["CLAUDE.md", ".claude/CLAUDE.md"] },
  { name: "Cursor", patterns: [".cursor/rules/*.mdc", ".cursorrules"] },
  { name: "GitHub Copilot", patterns: [".github/copilot-instructions.md"] },
  { name: "Gemini CLI", patterns: ["GEMINI.md"] },
  { name: "Cline", patterns: [".clinerules/*.md", ".clinerules"] },
  { name: "Windsurf", patterns: [".windsurf/rules/*.md", ".windsurfrules"] },
  { name: "JetBrains Junie", patterns: [".junie/guidelines.md"] },
];

/** Tools that read @-imports, so a one-line pointer to AGENTS.md is enough. */
export const IMPORT_CAPABLE = new Set(["Claude Code", "Gemini CLI"]);

export interface Source {
  tool: string;
  files: string[]; // workspace-relative, sorted, forward-slash
  content: string; // raw concatenated content
  lines: string[]; // normalized lines used for comparison
  modTimeMs: number;
  linkTarget: string; // basename of symlink target, "" if not a symlink
}

export const STATUS = {
  canonical: "canonical",
  inSync: "in sync",
  linked: "linked",
  drifted: "drifted",
} as const;

export interface DriftEntry {
  tool: string;
  files: string[];
  status: string;
  similarity: number;
}

export interface DriftResult {
  root: string;
  canonical: string;
  entries: DriftEntry[];
  missing: string[];
  drifted: number;
}

const GLOB_CHARS = /[*?{}[\]]/;

/** Expand one pattern under cwd to existing regular-file paths (absolute). */
function expandPattern(cwd: string, pattern: string): string[] {
  if (GLOB_CHARS.test(pattern)) {
    return globSync(pattern, { cwd, dot: true, onlyFiles: true })
      .map((rel) => path.resolve(cwd, rel))
      .sort();
  }
  const full = path.resolve(cwd, pattern);
  try {
    if (fs.statSync(full).isFile()) return [full];
  } catch {
    /* missing */
  }
  return [];
}

/** Scan root for every known instruction file; one Source per tool present. */
export function discover(root: string): Source[] {
  const found: Source[] = [];
  for (const spec of TOOL_SPECS) {
    let files: string[] = [];
    for (const pat of spec.patterns) {
      const matches = expandPattern(root, pat);
      files.push(...matches);
      // First matching location wins; later patterns are legacy fallbacks.
      if (files.length > 0) break;
    }
    if (files.length === 0) continue;
    files = [...new Set(files)].sort();

    const src: Source = {
      tool: spec.name,
      files: [],
      content: "",
      lines: [],
      modTimeMs: 0,
      linkTarget: "",
    };
    const parts: string[] = [];
    for (const f of files) {
      parts.push(fs.readFileSync(f, "utf8"));
      src.files.push(path.relative(root, f).split(path.sep).join("/"));
      try {
        const m = fs.statSync(f).mtimeMs;
        if (m > src.modTimeMs) src.modTimeMs = m;
      } catch {
        /* ignore */
      }
    }
    if (files.length === 1) {
      try {
        if (fs.lstatSync(files[0]).isSymbolicLink()) {
          src.linkTarget = path.basename(fs.readlinkSync(files[0]));
        }
      } catch {
        /* not a symlink */
      }
    }
    src.content = parts.join("\n");
    src.lines = normalize(src.content);
    found.push(src);
  }
  return found;
}

export function missingTools(found: Source[]): string[] {
  const present = new Set(found.map((s) => s.tool));
  return TOOL_SPECS.filter((s) => !present.has(s.name)).map((s) => s.name);
}

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Prefer AGENTS.md (the cross-tool standard); else the freshest source. */
export function pickCanonical(sources: Source[]): Source {
  for (const s of sources) if (s.tool === "AGENTS.md") return s;
  let best = sources[0];
  for (const s of sources.slice(1)) if (s.modTimeMs > best.modTimeMs) best = s;
  return best;
}

function isCanonicalName(name: string, canon: Source): boolean {
  return canon.files.some((f) => name.toLowerCase() === baseName(f).toLowerCase());
}

/** Whether content is just an import reference to canonical, e.g. "@AGENTS.md". */
export function pointsTo(lines: string[], canon: Source): boolean {
  if (lines.length === 0 || lines.length > 3) return false;
  for (const f of canon.files) {
    const ref = "@" + baseName(f);
    for (const l of lines) if (l.includes(ref)) return true;
  }
  return false;
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) return content;
  const rest = content.slice(4);
  const idx = rest.indexOf("\n---\n");
  return idx >= 0 ? rest.slice(idx + 5) : content;
}

/** Drop YAML frontmatter, trim lines, remove blanks and the generated link header. */
export function normalize(content: string): string[] {
  const lines: string[] = [];
  for (const l of stripFrontmatter(content).split("\n")) {
    const t = l.trim();
    if (t !== "" && t !== LINK_HEADER) lines.push(t);
  }
  return lines;
}

function lcsLen(a: string[], b: string[]): number {
  let prev = new Array(b.length + 1).fill(0);
  let cur = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Line-based LCS ratio: 2*LCS / (len(a)+len(b)), in [0,1]. */
export function similarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  return (2 * lcsLen(a, b)) / (a.length + b.length);
}

export const DEFAULT_THRESHOLD = 0.95;

/** Discover instruction files under root, pick canonical, score every other tool. */
export function checkDrift(root: string, threshold = DEFAULT_THRESHOLD): DriftResult {
  const sources = discover(root);
  const res: DriftResult = {
    root,
    canonical: "",
    entries: [],
    missing: missingTools(sources),
    drifted: 0,
  };
  if (sources.length === 0) return res;

  const canon = pickCanonical(sources);
  res.canonical = canon.files.join(", ");

  for (const src of sources) {
    const e: DriftEntry = { tool: src.tool, files: src.files, status: "", similarity: 0 };
    if (src === canon) {
      e.status = STATUS.canonical;
      e.similarity = 1;
    } else if (src.linkTarget !== "" && isCanonicalName(src.linkTarget, canon)) {
      e.status = STATUS.linked;
      e.similarity = 1;
    } else if (pointsTo(src.lines, canon)) {
      e.status = STATUS.linked;
      e.similarity = 1;
    } else {
      e.similarity = similarity(canon.lines, src.lines);
      if (e.similarity >= threshold) {
        e.status = STATUS.inSync;
      } else {
        e.status = STATUS.drifted;
        res.drifted++;
      }
    }
    res.entries.push(e);
  }
  // Stable order matching the registry.
  const order = new Map(TOOL_SPECS.map((s, i) => [s.name, i]));
  res.entries.sort((a, b) => (order.get(a.tool) ?? 0) - (order.get(b.tool) ?? 0));
  return res;
}

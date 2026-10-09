// Stale-reference check for AI instruction files. A rule that names a file the
// repository no longer has is a rule about a different repository: the agent
// follows it anyway. Pure: same workspace, same verdict.
import fs from "node:fs";
import path from "node:path";
import { discover } from "./drift.js";
import { matchesGlob } from "./git.js";

export interface InstructionRef {
  /** Instruction file, workspace-relative. */
  file: string;
  line: number;
  /** The path as written. */
  ref: string;
  kind: "import" | "link" | "code";
}

export interface RefsResult {
  files: string[];
  checked: number;
  missing: InstructionRef[];
}

/** Extensions that mark a reference as a file rather than a branch or package name. */
const KNOWN_EXT = /\.(md|mdc|mdx|txt|json|jsonc|ya?ml|toml|ini|lock|[cm]?[jt]sx?|py|rs|go|rb|java|kt|swift|c|h|cpp|cs|php|sh|ps1|sql|html|css|scss|svg|png)$/i;

/** True when `text` reads as a repository path rather than a command, identifier or prose. */
function looksLikePath(text: string): boolean {
  if (!text || /\s/.test(text) || /[*?{}[\]<>$|;`'"(),=@]/.test(text)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) || text.startsWith("/") || text.startsWith("~") || text.startsWith("-")) return false;
  const stripped = text.replace(/\/$/, "");
  if (!stripped || stripped.split("/").some((part) => part === "")) return false;
  // Bare file names (`tsconfig.json`, `camelCase.js`) are too often examples or files
  // in some package directory; only directory-qualified paths are judged.
  return stripped.includes("/");
}

/** References in one instruction file, skipping fenced code blocks. */
export function extractRefs(content: string, file: string): InstructionRef[] {
  const refs: InstructionRef[] = [];
  let fenced = false;
  content.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    // Claude Code / Gemini CLI imports: "@path/to/file.md" at the start or after whitespace.
    for (const m of raw.matchAll(/(?:^|\s)@((?:\.{1,2}\/)?[\w.-]+(?:\/[\w.-]+)*)/g)) {
      const ref = m[1].replace(/[.,:;]+$/, "");
      if (KNOWN_EXT.test(ref) || ref.startsWith(".")) refs.push({ file, line, ref, kind: "import" });
    }
    // Markdown links and images with a relative target.
    for (const m of raw.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      let target = m[1].split("#")[0].split("?")[0];
      try {
        target = decodeURI(target);
      } catch {
        /* keep the raw target */
      }
      if (target && !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("/") && !target.startsWith("#")) {
        refs.push({ file, line, ref: target, kind: "link" });
      }
    }
    // Inline code spans that look like repository paths: `src/cli.ts`, `docs/`.
    for (const m of raw.replace(/\[[^\]]*\]\([^)]*\)/g, "").matchAll(/`([^`\n]+)`/g)) {
      const text = m[1].trim().replace(/:\d+(?::\d+)?$/, "");
      if (looksLikePath(text)) refs.push({ file, line, ref: text, kind: "code" });
    }
  });
  return refs;
}

function exists(root: string, fromDir: string, rel: string): boolean {
  return [path.resolve(fromDir, rel), path.resolve(root, rel)].some((candidate) => fs.existsSync(candidate));
}

/**
 * A slashed code span is judged only when it is clearly a repository path: a known
 * file extension, a trailing slash, or a first segment that exists. That keeps
 * `origin/main` and `owner/repo` out while `src/gone.ts` is still caught.
 */
function isRepoPath(root: string, fromDir: string, ref: InstructionRef): boolean {
  if (ref.kind !== "code") return true;
  const text = ref.ref;
  if (KNOWN_EXT.test(text.replace(/\/$/, "")) || text.endsWith("/")) return true;
  const first = text.replace(/^\.\//, "").split("/")[0];
  return first !== ".." && exists(root, fromDir, first);
}

/** Check every reference in every discovered instruction file under `root`. */
export function checkInstructionRefs(root: string, ignore: string[] = []): RefsResult {
  const files = [...new Set(discover(root).flatMap((source) => source.files))];
  const result: RefsResult = { files, checked: 0, missing: [] };
  const seen = new Set<string>();
  for (const file of files) {
    const full = path.resolve(root, file);
    const fromDir = path.dirname(full);
    for (const ref of extractRefs(fs.readFileSync(full, "utf8"), file)) {
      const normalized = path.posix.normalize(ref.ref.replace(/^\.\//, "")).replace(/\/$/, "");
      if (ignore.some((glob) => matchesGlob(normalized, glob) || matchesGlob(ref.ref, glob))) continue;
      if (!isRepoPath(root, fromDir, ref)) continue;
      const key = `${file}\0${ref.ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.checked++;
      if (!exists(root, fromDir, ref.ref)) result.missing.push(ref);
    }
  }
  return result;
}

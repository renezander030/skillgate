import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Git plumbing for base-pinned and diff-aware gates. Every call is read-only and
 * best-effort: a git failure returns null/[]/false rather than throwing, so the
 * caller decides whether "no git" means fail-open or fail-closed. skillgate uses
 * these to compare the working tree against the base ref a change forked from —
 * so a change can neither loosen its own gate nor silently regress past one.
 */

const GIT_OPTS = { stdio: "pipe" as const, encoding: "utf8" as const, maxBuffer: 64 * 1024 * 1024 };

export function gitAvailable(cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, ...GIT_OPTS });
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of the repo root containing `cwd`, or null when not a repo. */
export function repoRoot(cwd: string): string | null {
  try {
    return path.normalize(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, ...GIT_OPTS }).trim());
  } catch {
    return null;
  }
}

/** Git-root-relative path for `file`, robust to Windows short/long path aliases. */
export function repoRelativePath(cwd: string, file: string): string | null {
  try {
    const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], { cwd, ...GIT_OPTS }).trim();
    const relative = path.relative(cwd, file).split(path.sep).join("/");
    if (relative === ".." || relative.startsWith("../")) return null;
    return path.posix.normalize(path.posix.join(prefix, relative));
  } catch {
    return null;
  }
}

function refExists(cwd: string, ref: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd, ...GIT_OPTS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the ref a change should be judged against, in trust order:
 * explicit request > `SKILLGATE_BASE` env > origin's default branch > common
 * defaults. Returns the first ref that actually resolves to a commit, or null
 * when none do (the caller then fails closed).
 */
export function resolveBaseRef(cwd: string, requested?: string): string | null {
  const originHead = (() => {
    try {
      return execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd, ...GIT_OPTS })
        .trim()
        .replace(/^refs\/remotes\//, "");
    } catch {
      return undefined;
    }
  })();
  const candidates = [requested, process.env.SKILLGATE_BASE, originHead, "origin/main", "origin/master", "main", "master"]
    .map((r) => r?.trim())
    .filter((r): r is string => !!r);
  for (const ref of candidates) {
    if (refExists(cwd, ref)) return ref;
  }
  // A repository with no commits at all has nothing a change could regress from,
  // so the first commit is judged against the empty tree. Only when no base was
  // asked for: an explicit ref that does not resolve still fails closed.
  if (!requested?.trim() && !process.env.SKILLGATE_BASE?.trim() && hasNoCommits(cwd)) return EMPTY_TREE;
  return null;
}

/** Git's well-known empty tree object. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Human label for a base ref in gate reasons. */
export function baseLabel(ref: string): string {
  return ref === EMPTY_TREE ? "the empty tree (no commits yet)" : ref.slice(0, 12);
}

/** True inside a git repository that has no commits on any ref. */
function hasNoCommits(cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd, ...GIT_OPTS });
    return execFileSync("git", ["rev-list", "-n", "1", "--all"], { cwd, ...GIT_OPTS }).trim() === "";
  } catch {
    return false;
  }
}

/**
 * The fork point of HEAD and `ref` — the commit the current change actually
 * branched from. Pinning to this (not the moving tip of `ref`) is what makes a
 * gate immune to the change under review: the same diff cannot edit the policy
 * it is judged by. Falls back to `ref` itself if no common ancestor is found.
 */
export function mergeBase(cwd: string, ref: string): string {
  if (ref === EMPTY_TREE) return ref;
  try {
    return execFileSync("git", ["merge-base", ref, "HEAD"], { cwd, ...GIT_OPTS }).trim();
  } catch {
    return ref;
  }
}

/** Contents of `relPath` (repo-root-relative, posix) at `ref`, or null if it did not exist there. */
export function readFileAtRef(cwd: string, ref: string, relPath: string): string | null {
  try {
    return execFileSync("git", ["show", `${ref}:${relPath}`], { cwd, ...GIT_OPTS });
  } catch {
    return null;
  }
}

/** Every tracked path at `ref` (repo-root-relative, posix), or [] on failure. */
export function listFilesAtRef(cwd: string, ref: string): string[] {
  try {
    return execFileSync("git", ["ls-tree", "-r", "--name-only", ref], { cwd, ...GIT_OPTS })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Compile a shell-style glob to an anchored RegExp for matching paths that only
 * exist at a git ref (so they can't be walked on disk). Supports `**`, `*`, `?`
 * and `{a,b}` alternation — the subset that appears in gate globs. Kept small and
 * dependency-free on purpose; tinyglobby handles the on-disk side.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // consume the slash after ** so **/x matches x at root
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
      } else {
        const inner = glob
          .slice(i + 1, end)
          .split(",")
          .map((s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
          .join("|");
        re += `(?:${inner})`;
        i = end;
      }
    } else if (".+^$()|[]\\".includes(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp("^" + re + "$");
}

/** True when `path` matches `glob` and none of the `ignore` globs. */
export function matchesGlob(p: string, glob: string, ignore: string[] = []): boolean {
  if (!globToRegExp(glob).test(p)) return false;
  return !ignore.some((ig) => globToRegExp(ig).test(p));
}

/**
 * Files changed in the working tree versus `ref` (committed, staged, unstaged and
 * untracked), relative to `cwd`, posix separators. Null when git cannot answer,
 * so the caller can treat "unknown" conservatively.
 */
export function changedFiles(cwd: string, ref: string): string[] | null {
  try {
    const diff = execFileSync("git", ["diff", "--name-only", "--relative", "-z", ref], { cwd, ...GIT_OPTS });
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd, ...GIT_OPTS });
    return [...new Set([...diff.split("\0"), ...untracked.split("\0")].filter(Boolean))];
  } catch {
    return null;
  }
}

/** True when the worktree has no staged, unstaged or untracked changes. Null outside git. */
export function isClean(cwd: string): boolean | null {
  try {
    return execFileSync("git", ["status", "--porcelain"], { cwd, ...GIT_OPTS }).trim() === "";
  } catch {
    return null;
  }
}

/**
 * The branch being worked on: `SKILLGATE_BRANCH`, else the checked-out branch,
 * else the CI-provided branch (a pull-request checkout is a detached merge
 * commit). Undefined when none is known.
 */
export function currentBranch(cwd: string): string | undefined {
  const fromEnv = process.env.SKILLGATE_BRANCH?.trim();
  if (fromEnv) return fromEnv;
  try {
    const name = execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, ...GIT_OPTS }).trim();
    if (name) return name;
  } catch {
    /* detached HEAD or not a repo */
  }
  return process.env.GITHUB_HEAD_REF?.trim() || process.env.GITHUB_REF_NAME?.trim() || undefined;
}

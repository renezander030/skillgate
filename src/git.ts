import { execFileSync } from "node:child_process";

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
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, ...GIT_OPTS }).trim();
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
  return null;
}

/**
 * The fork point of HEAD and `ref` — the commit the current change actually
 * branched from. Pinning to this (not the moving tip of `ref`) is what makes a
 * gate immune to the change under review: the same diff cannot edit the policy
 * it is judged by. Falls back to `ref` itself if no common ancestor is found.
 */
export function mergeBase(cwd: string, ref: string): string {
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

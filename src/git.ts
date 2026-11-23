import { execFileSync } from "node:child_process";
import path from "node:path";
import picomatch from "picomatch";
import { globSync } from "tinyglobby";

/**
 * Git plumbing for base-pinned and diff-aware gates. Every call is read-only and
 * best-effort: a git failure returns null/[]/false rather than throwing, so the
 * caller decides whether "no git" means fail-open or fail-closed. skillgate uses
 * these to compare the working tree against the base ref a change forked from —
 * so a change can neither loosen its own gate nor silently regress past one.
 */

const GIT_OPTS = { stdio: "pipe" as const, encoding: "utf8" as const, maxBuffer: 64 * 1024 * 1024 };

/** Output of a read-only git command, or null when it fails (not a repo, unknown ref, git missing). */
function gitOutput(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, ...GIT_OPTS });
  } catch {
    return null;
  }
}

/** Absolute path of the repo root containing `cwd`, or null when not a repo. */
export function repoRoot(cwd: string): string | null {
  const root = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  return root === null ? null : path.normalize(root.trim());
}

/** Git-root-relative path for `file`, robust to Windows short/long path aliases. */
export function repoRelativePath(cwd: string, file: string): string | null {
  try {
    const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], { cwd, ...GIT_OPTS }).replace(/\r?\n$/, "");
    const relative = path.relative(cwd, file).split(path.sep).join("/");
    if (relative === ".." || relative.startsWith("../")) return null;
    return path.posix.normalize(path.posix.join(prefix, relative));
  } catch {
    return null;
  }
}

function refExists(cwd: string, ref: string): boolean {
  return gitOutput(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== null;
}

/**
 * Resolve the ref a change should be judged against, in trust order:
 * explicit request > `SKILLGATE_BASE` env > origin's default branch > common
 * defaults. Returns the first ref that actually resolves to a commit, or null
 * when none do (the caller then fails closed).
 */
export function resolveBaseRef(cwd: string, requested?: string): string | null {
  const explicit = requested?.trim() || process.env.SKILLGATE_BASE?.trim();
  if (explicit) return refExists(cwd, explicit) ? explicit : null;
  // A pull or merge request is judged against the branch it targets, which is not
  // always origin's default branch (stacked changes, release branches). The target
  // must resolve: falling back to the default branch would judge the wrong diff.
  const target = ciTargetBranch();
  if (target) return [`origin/${target}`, target].find((ref) => refExists(cwd, ref)) ?? null;
  const originHead = gitOutput(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"])?.trim().replace(/^refs\/remotes\//, "");
  const candidates = [originHead, "origin/main", "origin/master", "main", "master"]
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

/** CI variables naming the branch a pull or merge request targets, in lookup order. */
const CI_TARGET_VARS = ["GITHUB_BASE_REF", "CI_MERGE_REQUEST_TARGET_BRANCH_NAME", "BITBUCKET_PR_DESTINATION_BRANCH"];

/**
 * Why no base resolved when the caller named one, or null when falling back is
 * allowed: an explicit `--base`/`SKILLGATE_BASE`, or the branch a CI pull request
 * targets, must resolve; Skillgate never judges against a different branch.
 */
export function baseRefProblem(requested?: string): string | null {
  if (requested?.trim() || process.env.SKILLGATE_BASE?.trim()) {
    return "requested base ref cannot be resolved — refusing to use a different baseline";
  }
  const target = ciTargetBranch();
  return target
    ? `the pull request's target branch ${target} is not in this checkout (fetch it, e.g. actions/checkout with fetch-depth: 0) — refusing to use a different baseline`
    : null;
}

/** The branch the CI run's pull or merge request targets, or undefined outside one (push events leave it empty). */
function ciTargetBranch(): string | undefined {
  for (const name of CI_TARGET_VARS) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Git's well-known empty tree object. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Human label for a base ref in gate reasons. */
export function baseLabel(ref: string): string {
  return ref === EMPTY_TREE ? "the empty tree (no commits yet)" : ref.slice(0, 12);
}

/** True inside a git repository that has no commits on any ref. */
function hasNoCommits(cwd: string): boolean {
  if (gitOutput(cwd, ["rev-parse", "--git-dir"]) === null) return false;
  return gitOutput(cwd, ["rev-list", "-n", "1", "--all"])?.trim() === "";
}

/**
 * The fork point of HEAD and `ref` — the commit the current change actually
 * branched from. Pinning to this (not the moving tip of `ref`) is what makes a
 * gate immune to the change under review: the same diff cannot edit the policy
 * it is judged by. Refuses baselines without a readable common ancestor.
 */
export function mergeBase(cwd: string, ref: string): string {
  if (ref === EMPTY_TREE) return ref;
  try {
    return execFileSync("git", ["merge-base", ref, "HEAD"], { cwd, ...GIT_OPTS }).trim();
  } catch {
    if (isShallow(cwd)) {
      throw new Error(`cannot determine a common ancestor with ${ref} — this clone is shallow, so the fork point is not in it; fetch the history (actions/checkout with fetch-depth: 0, GIT_DEPTH: 0 in GitLab, or git fetch --unshallow)`);
    }
    throw new Error(`cannot determine a common ancestor with ${ref} — refusing an unrelated or unreadable baseline`);
  }
}

/** True in a shallow clone, whose history may stop before the fork point. */
function isShallow(cwd: string): boolean {
  return gitOutput(cwd, ["rev-parse", "--is-shallow-repository"])?.trim() === "true";
}

/** Contents of `relPath` (repo-root-relative, posix) at `ref`, or null if it did not exist there. */
export function readFileAtRef(cwd: string, ref: string, relPath: string, strict = false): string | null {
  if (ref === EMPTY_TREE) return null;
  if (strict) {
    const tree = execFileSync("git", ["ls-tree", "-z", ref, "--", relPath], { cwd: repoRoot(cwd) ?? cwd, ...GIT_OPTS });
    if (!tree) return null;
    if (!/^100(?:644|755) blob /.test(tree)) throw new Error(`baseline path is not a regular file: ${relPath}`);
  }
  try {
    return execFileSync("git", ["show", `${ref}:${relPath}`], { cwd, ...GIT_OPTS });
  } catch (error) {
    if (strict) throw new Error(`cannot read baseline file: ${relPath}`);
    return null;
  }
}

/** Every tracked path at `ref`, relative to cwd; strict callers reject Git errors. */
export function listFilesAtRef(cwd: string, ref: string, strict = false): string[] {
  if (ref === EMPTY_TREE) return [];
  try {
    return execFileSync("git", ["ls-tree", "-rz", "--name-only", ref], { cwd, ...GIT_OPTS })
      .split("\0")
      .filter(Boolean);
  } catch (error) {
    if (strict) throw new Error(`cannot enumerate baseline tree: ${ref}`);
    return [];
  }
}

/** Compile the same path glob syntax used by the on-disk scanner. */
function globToRegExp(glob: string): RegExp {
  return picomatch.makeRe(glob, { dot: true, flags: "s" });
}

/** True when `path` matches `glob` and none of the `ignore` globs. */
export function matchesGlob(p: string, glob: string, ignore: string[] = []): boolean {
  if (!globToRegExp(glob).test(p)) return false;
  return !ignore.some((ig) => globToRegExp(ig).test(p));
}

/** Paths no glob gate ever scans, whatever its own `ignore` says. */
const SCAN_IGNORE = ["**/node_modules/**", "**/.git/**", "dist/**"];

/** Working-tree files a glob gate scans: dotfiles included, built-in and gate ignores excluded. */
export function scanFiles(cwd: string, glob: string, ignore: string[] = []): string[] {
  return globSync(glob, { cwd, dot: true, ignore: [...SCAN_IGNORE, ...ignore] });
}

/** True when repo path `p` is one `scanFiles` would return for this glob (used for baseline trees). */
export function inScan(p: string, glob: string, ignore: string[] = []): boolean {
  return matchesGlob(p, glob, [...SCAN_IGNORE, ...ignore]);
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
  const status = gitOutput(cwd, ["status", "--porcelain"]);
  return status === null ? null : status.trim() === "";
}

/**
 * The branch being worked on: `SKILLGATE_BRANCH`, else the checked-out branch,
 * else the CI-provided branch (a pull-request checkout is a detached merge
 * commit). Undefined when none is known.
 */
export function currentBranch(cwd: string): string | undefined {
  const fromEnv = process.env.SKILLGATE_BRANCH?.trim();
  if (fromEnv) return fromEnv;
  // Null on a detached HEAD or outside a repository.
  const name = gitOutput(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])?.trim();
  if (name) return name;
  return process.env.GITHUB_HEAD_REF?.trim() || process.env.GITHUB_REF_NAME?.trim() || undefined;
}

export interface BaselineEntry {
  /** Git file mode: 100644, 100755, or 120000 for a symlink. */
  mode: string;
  oid: string;
}

/**
 * Every blob (regular file or symlink) at `ref`, keyed by path relative to cwd.
 * Submodules are left out. Strict: Git errors throw.
 */
export function blobsAtRef(cwd: string, ref: string): Map<string, BaselineEntry> {
  const blobs = new Map<string, BaselineEntry>();
  if (ref === EMPTY_TREE) return blobs;
  let out: string;
  try {
    out = execFileSync("git", ["ls-tree", "-rz", ref], { cwd, ...GIT_OPTS });
  } catch {
    throw new Error(`cannot enumerate baseline tree: ${ref}`);
  }
  for (const entry of out.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, oid] = entry.slice(0, tab).split(" ");
    if (type === "blob") blobs.set(entry.slice(tab + 1), { mode, oid });
  }
  return blobs;
}

/** Object id of `content` as a blob in this repository's hash format. Strict. */
export function hashBlob(cwd: string, content: string): string {
  try {
    return execFileSync("git", ["hash-object", "--stdin"], { cwd, ...GIT_OPTS, input: content }).trim();
  } catch {
    throw new Error("cannot hash content");
  }
}

/**
 * Object ids the working-tree files would get if committed now (clean filters and
 * line-ending normalization applied), in input order. Strict: Git errors throw.
 */
export function hashWorkingFiles(cwd: string, files: string[]): string[] {
  if (files.length === 0) return [];
  try {
    return execFileSync("git", ["hash-object", "--stdin-paths"], { cwd, ...GIT_OPTS, input: files.join("\n") + "\n" })
      .split("\n")
      .filter(Boolean);
  } catch {
    throw new Error("cannot hash working-tree files");
  }
}

export interface CommitSignature {
  sha: string;
  /** git's %G? code: G good, U good/unknown validity, X/Y expired, R revoked, E unverifiable, B bad, N none. */
  status: string;
  subject: string;
}

/**
 * Commits HEAD has that `ref` lacks (all of HEAD for the empty tree), one array of
 * `fields` (git log format codes) per commit, newest first. An unborn HEAD against
 * the empty tree has none; any other failure throws.
 */
function commitsSince(cwd: string, ref: string, fields: string[], options: string[] = []): string[][] {
  const range = ref === EMPTY_TREE ? ["HEAD"] : [`${ref}..HEAD`];
  let out: string;
  try {
    out = execFileSync("git", ["log", "-z", ...options, `--format=${fields.join("%x1f")}`, ...range, "--"], { cwd, ...GIT_OPTS });
  } catch (error: any) {
    // A repository whose HEAD is unborn has no commits to judge.
    if (ref === EMPTY_TREE && /does not have any commits|unknown revision|bad default revision/.test(String(error?.stderr ?? ""))) return [];
    throw new Error(`cannot read commits since ${baseLabel(ref)}`);
  }
  return out.split("\0").filter(Boolean).map((record) => record.replace(/^\n/, "").split("\x1f"));
}

/** Subjects of the non-merge commits between `ref` and HEAD, newest first. */
export function commitSubjects(cwd: string, ref: string): { sha: string; subject: string }[] {
  return commitsSince(cwd, ref, ["%H", "%s"], ["--no-merges"]).map(([sha, subject]) => ({ sha, subject: subject ?? "" }));
}

/**
 * Commits on HEAD that `ref` (default: the branch's upstream) does not contain.
 * Throws when the ref cannot be resolved, so a missing upstream fails closed.
 */
export function unpushedCommits(cwd: string, ref?: string): { ref: string; commits: { sha: string; subject: string }[] } {
  const target = ref ?? "@{upstream}";
  let resolved: string;
  try {
    resolved = execFileSync("git", ["rev-parse", "--verify", "--quiet", "--symbolic-full-name", target], { cwd, ...GIT_OPTS }).trim()
      || execFileSync("git", ["rev-parse", "--verify", "--quiet", `${target}^{commit}`], { cwd, ...GIT_OPTS }).trim();
  } catch {
    throw new Error(ref ? `cannot resolve ${ref}` : "the current branch has no upstream — push with -u or set ref");
  }
  const name = resolved.replace(/^refs\/remotes\//, "").replace(/^refs\/heads\//, "");
  const commits = commitsSince(cwd, target, ["%H", "%s"]).map(([sha, subject]) => ({ sha, subject: subject ?? "" }));
  return { ref: name, commits };
}

/** Signature status of every commit reachable from HEAD but not from `ref`. Strict. */
export function commitSignatures(cwd: string, ref: string): CommitSignature[] {
  return commitsSince(cwd, ref, ["%H", "%G?", "%s"]).map(([sha, status, subject]) => ({ sha, status, subject: subject ?? "" }));
}

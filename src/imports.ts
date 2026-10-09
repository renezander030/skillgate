// Source imports versus declared dependencies. deps-locked proves every declared
// dependency resolved into the lockfile; this proves every package the code
// imports is declared at all. Pure: reads files, never resolves modules.
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";

const BUILTINS = new Set(builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")]));

const DECLARING_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

export interface ImportRef {
  specifier: string;
  line: number;
  typeOnly: boolean;
}

/** Blank out comments so commented-out imports are not judged; keeps line numbers. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (_m, lead) => lead);
}

// Keywords must not follow an identifier character, a dot or a quote, so `"import"`
// in a string and `obj.import(` are not statements. Specifiers never hold whitespace.
const KEYWORD = String.raw`(?<![\w$.'"\`])`;
const PATTERNS: { re: RegExp; typeOnly?: (match: RegExpExecArray) => boolean }[] = [
  // import x from "a"; import { y } from "a"; export * from "a"; import type { T } from "a"
  { re: new RegExp(String.raw`${KEYWORD}(import|export)\s+(type\s+)?[^"'\`;]*?\sfrom\s*["']([^"'\s]+)["']`, "g"), typeOnly: (m) => !!m[2] },
  // import "a"
  { re: new RegExp(String.raw`${KEYWORD}import\s*["']([^"'\s]+)["']`, "g") },
  // require("a"), import("a"), require.resolve("a")
  { re: new RegExp(String.raw`${KEYWORD}(?:require(?:\.resolve)?|import)\s*\(\s*["']([^"'\s]+)["']\s*\)`, "g") },
];

/** Static import/require specifiers in JavaScript or TypeScript source. */
export function findImports(text: string): ImportRef[] {
  const clean = stripComments(text);
  const found: ImportRef[] = [];
  for (const { re, typeOnly } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean))) {
      const specifier = m[m.length - 1];
      const line = clean.slice(0, m.index).split("\n").length;
      found.push({ specifier, line, typeOnly: typeOnly?.(m) ?? false });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/**
 * The npm package a specifier names, or null for relative paths, absolute paths,
 * subpath imports (`#x`), URLs and protocol specifiers (`node:`, `bun:`,
 * `virtual:`), Node builtins, and path aliases that cannot be package names.
 */
export function packageName(specifier: string): string | null {
  if (!specifier || /^[./#~]/.test(specifier) || specifier.includes(":") || specifier.includes("\\")) return null;
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (parts.length < 2 || parts[0] === "@" || !parts[1]) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  if (BUILTINS.has(parts[0]) || BUILTINS.has(specifier)) return null;
  return parts[0];
}

interface Manifest {
  file: string;
  name?: string;
  declared: Set<string>;
}

/** Nearest package.json from `dir` up to `root`, cached per directory. */
export function nearestManifest(dir: string, root: string, cache: Map<string, Manifest | null>): Manifest | null {
  const visited: string[] = [];
  let current = dir;
  let found: Manifest | null = null;
  while (true) {
    if (cache.has(current)) {
      found = cache.get(current)!;
      break;
    }
    visited.push(current);
    const file = path.join(current, "package.json");
    if (fs.existsSync(file)) {
      let data: any;
      try {
        data = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error: any) {
        throw new Error(`${path.relative(root, file) || "package.json"}: invalid JSON (${error.message})`);
      }
      const declared = new Set<string>();
      for (const field of DECLARING_FIELDS) {
        const deps = data?.[field];
        if (deps && typeof deps === "object") for (const name of Object.keys(deps)) declared.add(name);
      }
      found = { file, name: typeof data?.name === "string" ? data.name : undefined, declared };
      break;
    }
    const parent = path.dirname(current);
    if (current === root || parent === current || path.relative(root, current).startsWith("..")) break;
    current = parent;
  }
  for (const d of visited) cache.set(d, found);
  return found;
}

/** Whether `pkg` is satisfied by the manifest (a type-only import may use @types/<pkg>). */
export function isDeclared(pkg: string, manifest: Manifest, typeOnly: boolean): boolean {
  if (manifest.declared.has(pkg) || manifest.name === pkg) return true;
  if (!typeOnly) return false;
  const types = pkg.startsWith("@") ? `@types/${pkg.slice(1).replace("/", "__")}` : `@types/${pkg}`;
  return manifest.declared.has(types);
}

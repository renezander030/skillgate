/** Structural command matching for finish-line enforcement. */

export interface CommandSegment {
  raw: string;
  tokens: string[];
  normalized: string[];
}

export interface CommandMatch {
  matched: boolean;
  patterns: string[];
  segments: CommandSegment[];
}

const WRAPPERS = new Set(["command", "env", "exec", "nohup", "sudo", "time", "timeout", "nice", "ionice", "stdbuf", "xargs", "watch", "doas"]);
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "pwsh", "powershell", "cmd", "eval"]);
const WRAPPER_OPTIONS_WITH_VALUES = new Set(["-u", "-g", "-h", "-p", "-C", "-T", "-r", "-t", "-f", "-o", "-S"]);
/** Options that take a separate value, per wrapper whose own options differ from sudo/env. */
const WRAPPER_OPTION_VALUES: Record<string, Set<string>> = {
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"]),
  stdbuf: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
  xargs: new Set(["-a", "--arg-file", "-d", "--delimiter", "-E", "-e", "-I", "-i", "-L", "-l", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars", "--process-slot-var"]),
  watch: new Set(["-n", "--interval", "-d", "--differences", "-q", "--equexit"]),
  doas: new Set(["-u", "-C"]),
};
/** `find` actions whose arguments, up to `;` or `+`, are a command. */
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A word without the grouping a shell puts around it: `(git`, `{ npm`, `push)`. */
function ungrouped(word: string): string {
  return word.replace(/^[({]+|[)}]+$/g, "");
}

function executableName(value: string): string {
  const portable = value.replace(/\\/g, "/");
  const base = ungrouped(portable.slice(portable.lastIndexOf("/") + 1).toLowerCase());
  return base.replace(/\.(exe|cmd|bat)$/i, "");
}

/** Split only on unquoted shell control operators. */
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      const next = command[i + 1] ?? "";
      current += ch;
      if (/['"`\\;&|\s]/.test(next)) escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    const pair = command.slice(i, i + 2);
    if (pair === "&&" || pair === "||") {
      if (current.trim()) out.push(current.trim());
      current = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "\r" || ch === "|") {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Small cross-shell tokenizer. Quotes group arguments but are not retained. */
export function tokenizeCommand(segment: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  const flush = () => {
    if (current) out.push(current);
    current = "";
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      const next = segment[i + 1] ?? "";
      if (/['"`\\\s]/.test(next)) escaped = true;
      else current += ch;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return out;
}

function unwrap(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    while (i < tokens.length && ASSIGNMENT.test(tokens[i])) i++;
    if (i >= tokens.length) break;
    const name = executableName(tokens[i]);
    if (!WRAPPERS.has(name)) break;
    i++;
    if (WRAPPER_OPTION_VALUES[name]) {
      const withValues = WRAPPER_OPTION_VALUES[name];
      while (i < tokens.length && tokens[i].startsWith("-") && tokens[i] !== "--") {
        const option = tokens[i++];
        if (withValues.has(option) && i < tokens.length) i++;
      }
      if (tokens[i] === "--") i++;
      // `timeout DURATION cmd`: the duration is the first operand.
      if (name === "timeout" && i < tokens.length) i++;
    } else if (name === "env") {
      while (i < tokens.length && (tokens[i].startsWith("-") || ASSIGNMENT.test(tokens[i]))) {
        const option = tokens[i++];
        if (WRAPPER_OPTIONS_WITH_VALUES.has(option) && i < tokens.length) i++;
      }
    } else if (name === "sudo" || name === "time") {
      while (i < tokens.length && tokens[i].startsWith("-")) {
        const option = tokens[i++];
        if (WRAPPER_OPTIONS_WITH_VALUES.has(option) && i < tokens.length) i++;
      }
    } else if (name === "command") {
      while (i < tokens.length && ["--", "-p"].includes(tokens[i])) i++;
    } else if (["exec", "nohup"].includes(name) && tokens[i] === "--") {
      i++;
    }
  }
  const rest = tokens.slice(i);
  while (["&", "."].includes(rest[0])) rest.shift();
  if (rest.length) rest[0] = executableName(rest[0]);
  return rest;
}

const OPTIONS_WITH_VALUES = new Set([
  "-c", "-C", "--git-dir", "--work-tree", "--namespace",
  "--prefix", "--cache", "--registry", "--cwd", "--dir",
]);

function canonicalize(tokens: string[]): string[] {
  if (tokens.length < 2) return tokens;
  const result = [tokens[0]];
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    const option = tokens[i];
    i++;
    if (!option.includes("=") && OPTIONS_WITH_VALUES.has(option) && i < tokens.length) i++;
  }
  return [...result, ...tokens.slice(i)];
}

function orderedMatch(tokens: string[], pattern: string[]): boolean {
  if (!tokens.length || !pattern.length || pattern.length > tokens.length) return false;
  return pattern.every((wanted, index) => {
    // A value the shell decides at run time could be this word: fail closed. A dynamic
    // program only stands in for one when the rest of a multi-word pattern matches.
    if (isDynamic(tokens[index]) && (index > 0 || pattern.length > 1)) return true;
    const actual = index === 0 ? executableName(tokens[index]) : tokens[index].toLowerCase();
    const expected = index === 0 ? executableName(wanted) : wanted.toLowerCase();
    return ungrouped(actual) === ungrouped(expected);
  });
}

/** Commands `find` runs through -exec/-execdir/-ok/-okdir. */
function findExecCommands(tokens: string[]): string[] {
  if (!tokens.length || executableName(tokens[0]) !== "find") return [];
  const out: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    if (!FIND_EXEC.has(tokens[i])) continue;
    const start = i + 1;
    let end = start;
    while (end < tokens.length && ![";", "\\;", "+"].includes(tokens[end])) end++;
    if (end > start) out.push(tokens.slice(start, end).join(" "));
    i = end;
  }
  return out;
}

/** A token whose value is only known when the shell runs: a variable or a command substitution. */
function isDynamic(token: string): boolean {
  return /\$[A-Za-z_{(]|`/.test(token);
}

/** `$(which git)`, `$(command -v git)` and their backtick forms name the program they print. */
function resolveLookups(raw: string): string {
  return raw
    .replace(/\$\(\s*(?:which|command\s+-v|type\s+-p)\s+([A-Za-z0-9_.\/-]+)\s*\)/g, "$1")
    .replace(/`\s*(?:which|command\s+-v|type\s+-p)\s+([A-Za-z0-9_.\/-]+)\s*`/g, "$1");
}

/** Replace `$NAME` / `${NAME}` tokens with values assigned earlier in the same command. */
function substitute(tokens: string[], vars: Map<string, string>): string[] {
  return tokens.map((token) => {
    const ref = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(token);
    const name = ref?.[1] ?? ref?.[2];
    return name != null && vars.has(name) ? vars.get(name)! : token;
  });
}

function nestedShellCommands(tokens: string[]): string[] {
  if (!tokens.length || !SHELLS.has(executableName(tokens[0]))) return [];
  if (executableName(tokens[0]) === "eval") return tokens.length > 1 ? [tokens.slice(1).join(" ")] : [];
  const flag = tokens.findIndex((token) => {
    const value = token.toLowerCase();
    return value === "-command" || value === "/c" || /^-[a-z]*c[a-z]*$/.test(value);
  });
  return flag >= 0 && tokens[flag + 1] ? [tokens.slice(flag + 1).join(" ")] : [];
}

function commandSubstitutions(raw: string): string[] {
  const out: string[] = [];
  let quote = "";
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (ch === "'") {
      if (!quote) quote = ch;
      else if (quote === ch) quote = "";
      continue;
    }
    if (ch === '"') {
      if (!quote) quote = ch;
      else if (quote === ch) quote = "";
      continue;
    }
    if (quote === "'") continue;
    if (ch === "`") {
      const end = raw.indexOf("`", i + 1);
      if (end > i + 1) out.push(raw.slice(i + 1, end).trim());
      if (end >= 0) i = end;
      continue;
    }
    if (ch === "$" && raw[i + 1] === "(") {
      let depth = 1;
      let nestedQuote = "";
      let j = i + 2;
      for (; j < raw.length && depth > 0; j++) {
        const next = raw[j];
        if ((next === "'" || next === '"') && (!nestedQuote || nestedQuote === next)) {
          nestedQuote = nestedQuote ? "" : next;
        } else if (!nestedQuote && next === "(") depth++;
        else if (!nestedQuote && next === ")") depth--;
      }
      if (depth === 0) {
        const value = raw.slice(i + 2, j - 1).trim();
        if (value) out.push(value);
        i = j - 1;
      }
    }
  }
  return out;
}

export function analyzeCommand(command: string, patterns: string[] = []): CommandMatch {
  const segments: CommandSegment[] = [];
  const vars = new Map<string, string>();
  const pending = splitCommand(command);
  for (let i = 0; i < pending.length; i++) {
    const raw = pending[i];
    const tokens = tokenizeCommand(raw);
    if (tokens.length && tokens.every((token) => ASSIGNMENT.test(token))) {
      for (const token of tokens) {
        const at = token.indexOf("=");
        vars.set(token.slice(0, at), token.slice(at + 1));
      }
    }
    const unwrapped = unwrap(substitute(tokenizeCommand(resolveLookups(raw)), vars));
    const normalized = canonicalize(unwrapped);
    segments.push({ raw, tokens, normalized });
    pending.push(...nestedShellCommands(unwrapped), ...findExecCommands(unwrapped), ...commandSubstitutions(raw));
  }

  const matchedPatterns: string[] = [];
  for (const pattern of patterns) {
    const wanted = canonicalize(unwrap(tokenizeCommand(pattern)));
    if (segments.some((segment) => orderedMatch(segment.normalized, wanted))) matchedPatterns.push(pattern);
  }
  return { matched: matchedPatterns.length > 0, patterns: matchedPatterns, segments };
}

export function isStructuredCommandMatch(command: string, patterns: string[] | undefined): boolean {
  return !!patterns?.length && analyzeCommand(command, patterns).matched;
}

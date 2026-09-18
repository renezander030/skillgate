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

const WRAPPERS = new Set(["command", "env", "exec", "nohup", "sudo", "time"]);
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "pwsh", "powershell", "cmd", "eval"]);
const WRAPPER_OPTIONS_WITH_VALUES = new Set(["-u", "-g", "-h", "-p", "-C", "-T", "-r", "-t", "-f", "-o", "-S"]);

function executableName(value: string): string {
  const portable = value.replace(/\\/g, "/");
  const base = portable.slice(portable.lastIndexOf("/") + 1).toLowerCase().replace(/^[({]+|[)}]+$/g, "");
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
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    const name = executableName(tokens[i]);
    if (!WRAPPERS.has(name)) break;
    i++;
    if (name === "env") {
      while (i < tokens.length && (tokens[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) {
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
    const actual = index === 0 ? executableName(tokens[index]) : tokens[index].toLowerCase();
    const expected = index === 0 ? executableName(wanted) : wanted.toLowerCase();
    return actual.replace(/^[({]+|[)}]+$/g, "") === expected.replace(/^[({]+|[)}]+$/g, "");
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
  const pending = splitCommand(command);
  for (let i = 0; i < pending.length; i++) {
    const raw = pending[i];
    const tokens = tokenizeCommand(raw);
    const unwrapped = unwrap(tokens);
    const normalized = canonicalize(unwrapped);
    segments.push({ raw, tokens, normalized });
    pending.push(...nestedShellCommands(unwrapped), ...commandSubstitutions(raw));
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

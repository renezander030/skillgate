// Vendored from cli-foundation — kept in-tree so pi-gate is self-contained with
// zero runtime dependencies. Sync from upstream rather than editing here.
//
// foundation.js — shared scaffold for agent-first CLIs.
// Extracts the proven idioms from tt / rzq / ts: JSON output by default with a
// -H/--human table fallback, a subcommand router, --key val / --key=val flag
// parsing, a TTL'd JSON cache, an HTTP-JSON helper, fuzzy id/title matching,
// and a forgiving date parser. New CLIs import this instead of copy-pasting.
//
// Usage (see template/cli.template.js for a worked example):
//   import * as fdn from 'cli-foundation/foundation.js';
//   const env = fdn.loadEnv(new URL('.env', import.meta.url));
//   fdn.run({ commands, help }, process.argv.slice(2));

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';

// --- module-dir helper (proven: every CLI computes __dirname this way) ---
export function dirOf(importMetaUrl) {
  return path.dirname(fileURLToPath(importMetaUrl));
}

// --- .env loader (verbatim from tt: KEY=value, one per line) ---
export function loadEnv(envPath) {
  const p = envPath instanceof URL ? fileURLToPath(envPath) : envPath;
  const env = {};
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  return env;
}

// --- output: JSON by default, table when --human/-H present (proven tt/rzq) ---
// extractHuman returns { human, rest } — strip the flag once at the top of main.
export function extractHuman(argv) {
  let human = false;
  const rest = argv.filter(a => {
    if (a === '--human' || a === '-H') { human = true; return false; }
    return true;
  });
  return { human, rest };
}

// emit(data, { human, table }) — JSON line, or a table if human + a formatter.
// table is a fn(data) => string (build it with the `table()` helper below).
export function emit(data, { human = false, table = null, pretty = false } = {}) {
  if (human && table) { console.log(table(data)); return; }
  console.log(JSON.stringify(data, null, pretty ? 2 : 0));
}

// out(data) — terse JSON line, the tt default.
export function out(data) { console.log(JSON.stringify(data)); }

// --- flag parsing (proven tt parseArgs + rzq's --key=val support merged) ---
// parseArgs(args, ['due','project']) -> { flags:{due,project}, positional:[...] }
// Accepts `--key value`, `--key=value`, and bare `--flag` (boolean true).
export function parseArgs(args, valueFlags = []) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      if (valueFlags.includes(key) && i + 1 < args.length) { flags[key] = args[++i]; continue; }
      flags[key] = true; // bare boolean flag
      continue;
    }
    positional.push(a);
  }
  return { flags, positional };
}

// parseFilters(args, ['type','lang']) -> filters object (rzq style, --k v / --k=v).
// Leaves non-filter tokens untouched; returns { filters, rest }.
export function parseFilters(args, filterKeys) {
  const filters = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let matched = false;
    for (const key of filterKeys) {
      if (a === `--${key}`) { filters[key] = args[++i]; matched = true; break; }
      if (a.startsWith(`--${key}=`)) { filters[key] = a.slice(key.length + 3); matched = true; break; }
    }
    if (!matched) rest.push(a);
  }
  return { filters, rest };
}

// --- HTTP JSON helper (proven tt httpRequest, http+https aware) ---
// httpJson(url, { method, body, headers }) -> parsed JSON (or raw text fallback).
export function httpJson(urlStr, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        else { try { resolve(JSON.parse(data)); } catch { resolve(data); } }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// --- TTL JSON cache (proven tt readCache/syncAndCache, generalized) ---
// const cache = makeCache({ path, ttlMs, fetch: async () => data, valid });
// cache.get() returns fresh-from-disk if within ttl, else fetches + writes.
export function makeCache({ path: cachePath, ttlMs, fetch, valid }) {
  const p = cachePath instanceof URL ? fileURLToPath(cachePath) : cachePath;
  function read() {
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      const fresh = d._fetchedAt && (Date.now() - d._fetchedAt) < ttlMs;
      if (fresh && (!valid || valid(d))) return d;
    } catch {}
    return null;
  }
  function write(data) {
    const stamped = { ...data, _fetchedAt: Date.now() };
    fs.writeFileSync(p, JSON.stringify(stamped));
    return stamped;
  }
  async function get() {
    return read() || (fetch ? write(await fetch()) : null);
  }
  function clear() { try { fs.unlinkSync(p); } catch {} }
  return { read, write, get, clear, path: p };
}

// --- fuzzy match (proven tt findTask, generalized over any field) ---
// fuzzyFind(items, q, { id:'id', title:'title' }) -> item | null
// exact id > prefix-title > substring-title.
export function fuzzyFind(items, q, { id = 'id', title = 'title' } = {}) {
  if (!q) return null;
  let hit = items.find(t => t[id] === q);
  if (hit) return hit;
  const low = q.toLowerCase();
  hit = items.find(t => (t[title] || '').toLowerCase().startsWith(low));
  if (hit) return hit;
  hit = items.find(t => (t[title] || '').toLowerCase().includes(low));
  return hit || null;
}

// --- date parser (verbatim tt parseDate: today/tomorrow/YYYY-MM-DD/Nd|Nw|Nm) ---
// Returns TickTick-style ISO with +0000; pass `iso:true` for plain ISO instead.
export function parseDate(s, { iso = false } = {}) {
  if (!s) return undefined;
  const fmt = d => iso ? d.toISOString() : d.toISOString().replace('Z', '+0000');
  const low = s.toLowerCase();
  if (low === 'today') { const d = new Date(); d.setHours(12, 0, 0, 0); return fmt(d); }
  if (low === 'tomorrow') { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(12, 0, 0, 0); return fmt(d); }
  // Noon (not 23:00) so the +1/+2h Berlin offset never crosses midnight into the next calendar day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return iso ? s : s + 'T12:00:00.000+0000';
  const rel = s.match(/^(\d+)([dwm])$/);
  if (rel) {
    const n = parseInt(rel[1], 10); const d = new Date();
    if (rel[2] === 'd') d.setDate(d.getDate() + n);
    else if (rel[2] === 'w') d.setDate(d.getDate() + n * 7);
    else if (rel[2] === 'm') d.setMonth(d.getMonth() + n);
    d.setHours(12, 0, 0, 0); return fmt(d);
  }
  return s;
}

// --- table formatter for --human output (simple aligned columns) ---
// table(rows, [{key:'id', label:'ID', width:24}, {key:'title'}])
export function table(rows, columns) {
  if (!rows || rows.length === 0) return '(none)';
  const cols = columns.map(c => ({ label: c.label || c.key, width: c.width || 0, ...c }));
  const widths = cols.map(c =>
    c.width || Math.max(c.label.length, ...rows.map(r => String(r[c.key] ?? '').length)));
  const fmtRow = vals => vals.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  ').trimEnd();
  const header = fmtRow(cols.map(c => c.label));
  const sep = widths.map(w => '-'.repeat(w)).join('  ');
  const body = rows.map(r => fmtRow(cols.map(c => r[c.key]))).join('\n');
  return [header, sep, body].join('\n');
}

// --- subcommand router (proven tt commands{} + main() dispatch) ---
// run({ commands, help }, argv): dispatches argv[0] to commands[verb](rest, ctx).
// commands.help (or the help fn) handles --help / -h / no-args.
// ctx = { human } so handlers know which output mode to use.
export async function run({ commands, help }, argv) {
  const { human, rest } = extractHuman(argv);
  const cmd = rest[0];
  const showHelp = () => {
    if (typeof help === 'function') help();
    else if (commands.help) commands.help();
    else console.error('No help defined.');
  };
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { showHelp(); process.exit(0); }
  const fn = commands[cmd];
  if (!fn) { console.error(`Unknown command: ${cmd}`); showHelp(); process.exit(1); }
  try {
    await fn(rest.slice(1), { human });
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

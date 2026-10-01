import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import type { TrufflehogGate } from "./spec.js";

export function checkSecrets(gate: TrufflehogGate, cwd: string, remainingMs?: number): { ok: boolean; reason: string } {
  const deadline = Date.now() + Math.min(gate.timeout ?? 10000, remainingMs ?? Infinity);
  const budget = () => Math.max(1, deadline - Date.now());
  const maxBytes = gate.maxBytes ?? 10 * 1024 * 1024;
  const run = (bin: string, args: string[]) => spawnSync(bin, args, {
    cwd, encoding: "utf8", timeout: budget(), maxBuffer: maxBytes,
  });
  // Scanner output can contain live credentials. Never include it, or parser errors, in a receipt.
  try {
    if (gate.namesFile) {
      const namesPath = path.resolve(cwd, gate.namesFile);
      if (fs.statSync(namesPath).size > maxBytes) return { ok: false, reason: "infrastructure denylist exceeds size limit" };
      const names: unknown = JSON.parse(fs.readFileSync(namesPath, "utf8"));
      if (!Array.isArray(names) || !names.length || names.some(n => typeof n !== "string" || !n.trim())) {
        return { ok: false, reason: "infrastructure denylist must be a non-empty JSON array of literal names" };
      }
      const listed = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
      if (listed.error || listed.status !== 0) return { ok: false, reason: "cannot enumerate repository files" };
      for (const file of new Set(listed.stdout.split("\0").filter(Boolean))) {
        if (Date.now() >= deadline) return { ok: false, reason: "secrets gate timed out" };
        const full = path.resolve(cwd, file);
        if (full === namesPath) continue;
        const stat = fs.existsSync(full) ? fs.lstatSync(full) : null;
        if (stat?.isSymbolicLink()) return { ok: false, reason: "infrastructure scan refuses symlinks" };
        if (stat && stat.size > maxBytes) return { ok: false, reason: "repository file exceeds infrastructure scan size limit" };
        const staged = run("git", ["show", `:${file}`]);
        if (staged.error) return { ok: false, reason: "cannot read staged file within scan limits" };
        const texts = [stat?.isFile() ? fs.readFileSync(full, "utf8") : "", staged.status === 0 ? staged.stdout : ""];
        if (texts.some(text => names.some(name => text.toLowerCase().includes(name.toLowerCase())))) {
          return { ok: false, reason: "forbidden infrastructure name found (value redacted)" };
        }
      }
    }
    if (Date.now() >= deadline) return { ok: false, reason: "secrets gate timed out" };
    const clones = path.join(cwd, ".skillgate", "scan-cache");
    fs.mkdirSync(clones, { recursive: true });
    const result = run(gate.trufflehog ?? "trufflehog", ["git", pathToFileURL(path.resolve(cwd)).href,
      "--results=verified", "--fail", "--fail-on-scan-errors", "--no-update", "--json", "--clone-path", clones]);
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      return { ok: false, reason: code === "ENOENT" ? "TruffleHog is unavailable; install it or configure trufflehog" : "TruffleHog failed or exceeded scan limits" };
    }
    if (result.status === 183) return { ok: false, reason: "verified credential found (scanner output redacted)" };
    if (result.status !== 0) return { ok: false, reason: "TruffleHog scan failed (scanner output redacted)" };
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      if (JSON.parse(line).Verified === true) return { ok: false, reason: "verified credential found (scanner output redacted)" };
    }
    return { ok: true, reason: "no verified credentials or configured infrastructure names found" };
  } catch {
    return { ok: false, reason: "secrets scan or infrastructure denylist could not be read safely" };
  }
}

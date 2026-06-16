#!/usr/bin/env node
// Print the CHANGELOG.md section for a given version, used as GitHub Release notes.
// Usage: node changelog-section.mjs 0.4.0
import fs from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("usage: changelog-section.mjs <version>");
  process.exit(1);
}

const md = fs.readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
const lines = md.split("\n");

// Match "## 0.4.0" (optionally followed by a date/anything).
const startIdx = lines.findIndex((l) => new RegExp(`^##\\s+v?${version.replace(/\./g, "\\.")}\\b`).test(l));
if (startIdx === -1) {
  console.error(`no CHANGELOG section for ${version}`);
  process.exit(1);
}

const body = [];
for (let i = startIdx + 1; i < lines.length; i++) {
  if (/^##\s+/.test(lines[i])) break; // next version heading
  body.push(lines[i]);
}

console.log(body.join("\n").trim() || `Release ${version}`);

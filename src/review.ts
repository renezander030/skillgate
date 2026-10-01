import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Spec } from "./spec.js";
import { snapshotKey } from "./receipt.js";

export function reviewSnapshot(spec: Spec, cwd: string, baseRef?: string): string {
  const reports = spec.gates.filter(g => g.type === "review").map(g => path.relative(cwd, path.resolve(cwd, g.file)).split(path.sep).join("/"));
  const index = execFileSync("git", ["ls-files", "--stage", "-z"], { cwd, maxBuffer: 64 * 1024 * 1024 }).toString();
  const entries = index.split("\0").filter(entry => entry && !reports.includes(entry.split("\t")[1]));
  return crypto.createHash("sha256").update(snapshotKey(spec, cwd, baseRef, reports)).update(entries.join("\0")).digest("hex");
}

export function checkReview(file: string, spec: Spec, cwd: string, baseRef?: string): { ok: boolean; reason: string } {
  try {
    const full = path.resolve(cwd, file);
    if (fs.statSync(full).size > 10 * 1024 * 1024) return { ok: false, reason: "review report exceeds size limit" };
    const envelope = JSON.parse(fs.readFileSync(full, "utf8"));
    if (envelope.format !== 1 || envelope.snapshot !== reviewSnapshot(spec, cwd, baseRef)) {
      return { ok: false, reason: "review report is stale or has an unsupported format" };
    }
    const review = envelope.review;
    if (review?.status !== "success" || !Array.isArray(review.comments) || !Array.isArray(review.warnings)
      || review.summary?.budget_exceeded || !Number.isInteger(review.summary?.files_reviewed)
      || review.summary.files_reviewed < 1 || review.summary.comments !== review.comments.length) {
      return { ok: false, reason: "review report is incomplete or invalid" };
    }
    if (review.comments.length || review.warnings.length) return { ok: false, reason: "review has findings or warnings; resolve them and rerun review" };
    return { ok: true, reason: "completed review has no findings for this snapshot (reviewer attestation)" };
  } catch {
    return { ok: false, reason: "review report or repository snapshot could not be read" };
  }
}

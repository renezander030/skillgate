import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGates } from "../src/core.js";
import type { Spec } from "../src/spec.js";
import {
  createPrivatePassProof,
  generateKeyFiles,
  loadPrivateKey,
  loadPublicKey,
  policyHash,
  verifyPrivatePassProof,
} from "../src/zk.js";

function fixture(): { cwd: string; spec: Spec } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-zk-"));
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src", "private-customer-code.ts"), "export const privateValue = 42;\n");
  fs.writeFileSync(path.join(cwd, "evidence.md"), "private test evidence\n");
  return {
    cwd,
    spec: {
      gates: [
        { id: "private-tests-passed", type: "evidence", file: "evidence.md" },
        { id: "private-source-exists", type: "file-exists", file: "src/private-customer-code.ts" },
      ],
    },
  };
}

test("private pass proof verifies while repo and gate details stay hidden", async () => {
  const { cwd, spec } = fixture();
  const privateFile = path.join(cwd, "private-key.json");
  const publicFile = path.join(cwd, "public-key.json");
  await generateKeyFiles(privateFile, publicFile);
  const result = runGates(spec, cwd);
  const proof = await createPrivatePassProof(spec, result, cwd, loadPrivateKey(privateFile), "customer-audit-42");

  await verifyPrivatePassProof(proof, loadPublicKey(publicFile), policyHash(spec), "customer-audit-42");
  assert.ok(proof.proof_bytes > 0);
  const shared = JSON.stringify(proof);
  for (const hidden of ["private-customer-code", "private test evidence", "private-tests-passed", "gate_count", "snapshot_sha256"]) {
    assert.ok(!shared.includes(hidden), `proof bundle disclosed ${hidden}`);
  }
});

test("verification rejects a wrong challenge, policy, or public key", async () => {
  const { cwd, spec } = fixture();
  const privateFile = path.join(cwd, "private-key.json");
  const publicFile = path.join(cwd, "public-key.json");
  await generateKeyFiles(privateFile, publicFile);
  const proof = await createPrivatePassProof(spec, runGates(spec, cwd), cwd, loadPrivateKey(privateFile), "fresh-challenge");

  await assert.rejects(() => verifyPrivatePassProof(proof, loadPublicKey(publicFile), policyHash(spec), "replayed-challenge"), /challenge mismatch/);
  await assert.rejects(() => verifyPrivatePassProof(proof, loadPublicKey(publicFile), "0".repeat(64), "fresh-challenge"), /policy hash mismatch/);

  const otherPrivate = path.join(cwd, "other-private.json");
  const otherPublic = path.join(cwd, "other-public.json");
  await generateKeyFiles(otherPrivate, otherPublic);
  await assert.rejects(() => verifyPrivatePassProof(proof, loadPublicKey(otherPublic), policyHash(spec), "fresh-challenge"), /key ID mismatch/);

  const changed = Buffer.from(proof.proof_base64, "base64");
  changed[changed.length - 1] ^= 1;
  const tampered = { ...proof, proof_base64: changed.toString("base64") };
  await assert.rejects(() => verifyPrivatePassProof(tampered, loadPublicKey(publicFile), policyHash(spec), "fresh-challenge"), /invalid private pass proof/);
});

test("proof creation fails closed when any gate fails", async () => {
  const { cwd } = fixture();
  const spec: Spec = { gates: [{ id: "missing", type: "file-exists", file: "missing.txt" }] };
  const privateFile = path.join(cwd, "private-key.json");
  const publicFile = path.join(cwd, "public-key.json");
  await generateKeyFiles(privateFile, publicFile);
  await assert.rejects(
    () => createPrivatePassProof(spec, runGates(spec, cwd), cwd, loadPrivateKey(privateFile), "challenge"),
    /all configured gates must pass/,
  );
  const emptySpec: Spec = { gates: [] };
  await assert.rejects(
    () => createPrivatePassProof(emptySpec, runGates(emptySpec, cwd), cwd, loadPrivateKey(privateFile), "challenge"),
    /all configured gates must pass/,
  );
});

test("key generation refuses overwrite and protects the private file", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-zk-key-"));
  const privateFile = path.join(cwd, "private.json");
  const publicFile = path.join(cwd, "public.json");
  await generateKeyFiles(privateFile, publicFile);
  await assert.rejects(() => generateKeyFiles(privateFile, publicFile), /refusing to overwrite/);
  if (process.platform !== "win32") assert.equal(fs.statSync(privateFile).mode & 0o777, 0o600);
});

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { bbs } from "@mattrglobal/pairing-crypto";
import type { RunResult } from "./core.js";
import type { Spec } from "./spec.js";

export const ZK_PROOF_SCHEMA = "skillgate.private-pass-proof.v1";
export const ZK_KEY_SCHEMA = "skillgate.bbs-key.v1";
export const ZK_SUITE = "BBS_BLS12381_SHA256";

const SIGNED_HEADER = Buffer.from("skillgate:private-pass:v1", "utf8");

export interface ZKPrivateKeyFile {
  schema: typeof ZK_KEY_SCHEMA;
  suite: typeof ZK_SUITE;
  key_id: string;
  public_key_base64: string;
  secret_key_base64: string;
}

export interface ZKPublicKeyFile {
  schema: typeof ZK_KEY_SCHEMA;
  suite: typeof ZK_SUITE;
  key_id: string;
  public_key_base64: string;
}

export interface PrivatePassProof {
  schema: typeof ZK_PROOF_SCHEMA;
  suite: typeof ZK_SUITE;
  key_id: string;
  disclosed: {
    verdict: "PASS";
    policy_sha256: string;
  };
  challenge: string;
  proof_base64: string;
  proof_bytes: number;
  prover_ms: number;
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function canonical(value: unknown): string {
  if (value === undefined) throw new Error("policy contains an undefined value");
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("policy contains a non-finite number");
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error(`policy contains unsupported value type ${typeof value}`);
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}

export function policyHash(spec: Spec): string {
  return sha256(canonical(spec));
}

function keyID(publicKey: Uint8Array): string {
  return sha256(publicKey);
}

function encodeMessage(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}

function decodeBase64(value: string, expectedBytes: number, label: string): Uint8Array {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== expectedBytes || decoded.toString("base64") !== value) {
    throw new Error(`${label} must be canonical base64 encoding of ${expectedBytes} bytes`);
  }
  return decoded;
}

function readJSON(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error: any) {
    throw new Error(`read ${file}: ${error.message}`);
  }
}

function validatePublicKeyFile(value: unknown): ZKPublicKeyFile {
  const key = value as Partial<ZKPublicKeyFile> | null;
  if (!key || key.schema !== ZK_KEY_SCHEMA || key.suite !== ZK_SUITE || typeof key.key_id !== "string" || typeof key.public_key_base64 !== "string") {
    throw new Error("invalid Skillgate BBS public-key file");
  }
  const publicKey = decodeBase64(key.public_key_base64, bbs.bls12381_sha256.PUBLIC_KEY_LENGTH, "public key");
  if (keyID(publicKey) !== key.key_id) throw new Error("public-key file key ID mismatch");
  return key as ZKPublicKeyFile;
}

export function loadPublicKey(file: string): ZKPublicKeyFile {
  return validatePublicKeyFile(readJSON(file));
}

export function loadPrivateKey(file: string): ZKPrivateKeyFile {
  const key = readJSON(file) as Partial<ZKPrivateKeyFile> | null;
  const publicPart = validatePublicKeyFile(key);
  if (!key || typeof key.secret_key_base64 !== "string") throw new Error("invalid Skillgate BBS private-key file");
  decodeBase64(key.secret_key_base64, bbs.bls12381_sha256.PRIVATE_KEY_LENGTH, "secret key");
  return { ...publicPart, secret_key_base64: key.secret_key_base64 };
}

export async function generateKeyFiles(privateFile: string, publicFile: string): Promise<ZKPublicKeyFile> {
  if (path.resolve(privateFile) === path.resolve(publicFile)) throw new Error("private and public key paths must differ");
  if (fs.existsSync(privateFile) || fs.existsSync(publicFile)) throw new Error("refusing to overwrite an existing key file");

  const keyPair = await bbs.bls12381_sha256.generateKeyPair();
  const publicKey: ZKPublicKeyFile = {
    schema: ZK_KEY_SCHEMA,
    suite: ZK_SUITE,
    key_id: keyID(keyPair.publicKey),
    public_key_base64: Buffer.from(keyPair.publicKey).toString("base64"),
  };
  const privateKey: ZKPrivateKeyFile = {
    ...publicKey,
    secret_key_base64: Buffer.from(keyPair.secretKey).toString("base64"),
  };

  fs.mkdirSync(path.dirname(privateFile), { recursive: true });
  fs.mkdirSync(path.dirname(publicFile), { recursive: true });
  fs.writeFileSync(privateFile, JSON.stringify(privateKey, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    fs.writeFileSync(publicFile, JSON.stringify(publicKey, null, 2) + "\n", { encoding: "utf8", mode: 0o644, flag: "wx" });
  } catch (error) {
    try {
      fs.unlinkSync(privateFile);
    } catch {
      // Best effort rollback; the original write error remains more useful.
    }
    throw error;
  }
  return publicKey;
}

function shouldSkip(relative: string, name: string): boolean {
  if (name === ".git" || name === "node_modules") return true;
  return relative === "dist" || relative.startsWith("dist/");
}

// Bind the attestation to the current private workspace without putting this
// digest in the disclosed proof messages. This is a content snapshot, not a
// reproducible-build claim: ignored toolchains and process environment are not
// captured.
export function repositorySnapshotHash(cwd: string): string {
  const entries: string[] = [];
  const visit = (directory: string, relativeDirectory: string): void => {
    const children = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      if (shouldSkip(relative, child.name)) continue;
      const full = path.join(directory, child.name);
      if (child.isDirectory()) {
        visit(full, relative);
      } else if (child.isSymbolicLink()) {
        entries.push(`${relative.length}:${relative}|link:${fs.readlinkSync(full)}`);
      } else if (child.isFile()) {
        const bytes = fs.readFileSync(full);
        entries.push(`${relative.length}:${relative}|file:${bytes.length}:${sha256(bytes)}`);
      } else {
        entries.push(`${relative.length}:${relative}|other`);
      }
    }
  };
  visit(cwd, "");
  return sha256(entries.join("\n"));
}

function signedMessages(spec: Spec, result: RunResult, cwd: string): Uint8Array[] {
  if (!result.passed || result.results.length === 0 || result.results.some((gate) => !gate.ok)) {
    throw new Error("all configured gates must pass before a private pass proof can be created");
  }
  return [
    encodeMessage(`schema:${ZK_PROOF_SCHEMA}`),
    encodeMessage("verdict:PASS"),
    encodeMessage(`policy_sha256:${policyHash(spec)}`),
    encodeMessage(`snapshot_sha256:${repositorySnapshotHash(cwd)}`),
    encodeMessage(`gate_count:${result.results.length}`),
    encodeMessage(`results_sha256:${sha256(canonical(result.results))}`),
    encodeMessage(`evaluated_at:${new Date().toISOString()}`),
  ];
}

export async function createPrivatePassProof(
  spec: Spec,
  result: RunResult,
  cwd: string,
  privateKeyFile: ZKPrivateKeyFile,
  challenge: string,
): Promise<PrivatePassProof> {
  if (!challenge.trim()) throw new Error("a verifier-provided challenge is required");
  if (privateKeyFile.schema !== ZK_KEY_SCHEMA || privateKeyFile.suite !== ZK_SUITE) throw new Error("invalid Skillgate BBS private-key file");
  const publicKey = decodeBase64(privateKeyFile.public_key_base64, bbs.bls12381_sha256.PUBLIC_KEY_LENGTH, "public key");
  const secretKey = decodeBase64(privateKeyFile.secret_key_base64, bbs.bls12381_sha256.PRIVATE_KEY_LENGTH, "secret key");
  if (keyID(publicKey) !== privateKeyFile.key_id) throw new Error("private-key file key ID mismatch");
  const messages = signedMessages(spec, result, cwd);
  const signature = await bbs.bls12381_sha256.sign({ publicKey, secretKey, header: SIGNED_HEADER, messages });
  const started = performance.now();
  const proof = await bbs.bls12381_sha256.deriveProof({
    publicKey,
    signature,
    header: SIGNED_HEADER,
    presentationHeader: encodeMessage(challenge),
    verifySignature: true,
    messages: messages.map((value, index) => ({ value, reveal: index <= 2 })),
  });
  return {
    schema: ZK_PROOF_SCHEMA,
    suite: ZK_SUITE,
    key_id: privateKeyFile.key_id,
    disclosed: { verdict: "PASS", policy_sha256: policyHash(spec) },
    challenge,
    proof_base64: Buffer.from(proof).toString("base64"),
    proof_bytes: proof.length,
    prover_ms: Math.round(performance.now() - started),
  };
}

export async function verifyPrivatePassProof(
  proof: PrivatePassProof,
  publicKeyFile: ZKPublicKeyFile,
  expectedPolicy: string,
  expectedChallenge: string,
): Promise<void> {
  if (proof.schema !== ZK_PROOF_SCHEMA || proof.suite !== ZK_SUITE || proof.disclosed?.verdict !== "PASS") {
    throw new Error("unsupported or non-passing Skillgate proof");
  }
  if (!/^[a-f0-9]{64}$/.test(expectedPolicy) || proof.disclosed.policy_sha256 !== expectedPolicy) {
    throw new Error("policy hash mismatch");
  }
  if (!expectedChallenge || proof.challenge !== expectedChallenge) throw new Error("presentation challenge mismatch");
  if (proof.key_id !== publicKeyFile.key_id) throw new Error("gate public-key ID mismatch");

  const publicKey = decodeBase64(publicKeyFile.public_key_base64, bbs.bls12381_sha256.PUBLIC_KEY_LENGTH, "public key");
  const proofBytes = Buffer.from(proof.proof_base64, "base64");
  if (proofBytes.length === 0 || proofBytes.toString("base64") !== proof.proof_base64 || proof.proof_bytes !== proofBytes.length) {
    throw new Error("invalid proof encoding or length");
  }
  const verified = await bbs.bls12381_sha256.verifyProof({
    publicKey,
    proof: proofBytes,
    header: SIGNED_HEADER,
    presentationHeader: encodeMessage(expectedChallenge),
    messages: {
      0: encodeMessage(`schema:${ZK_PROOF_SCHEMA}`),
      1: encodeMessage("verdict:PASS"),
      2: encodeMessage(`policy_sha256:${expectedPolicy}`),
    },
  });
  if (!verified.verified) throw new Error(`invalid private pass proof${verified.error ? `: ${verified.error}` : ""}`);
}

export function parsePrivatePassProof(data: string): PrivatePassProof {
  try {
    return JSON.parse(data) as PrivatePassProof;
  } catch (error: any) {
    throw new Error(`parse private pass proof: ${error.message}`);
  }
}

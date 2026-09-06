# Private pass proofs

Skillgate can give a customer or auditor evidence that a private repository passed an agreed policy without exporting the repository or its detailed gate report.

The feature uses a BBS multi-message signature and a zero-knowledge proof of knowledge of that signature. Skillgate signs a complete receipt, then reveals only two claims from it:

- the verdict is `PASS`;
- the policy has the verifier's expected SHA-256 identifier.

The proof also answers a fresh verifier-provided challenge and verifies under a separately pinned public key.

## Use it when / skip it when

Use it when:

- a customer has approved a Skillgate policy but cannot access the private repository;
- the signer runs on an isolated gate server the coding agent cannot access;
- gate names, failure reasons, evidence, counts, and the repository snapshot are commercially sensitive;
- an attestation from that gate operator is the right trust boundary.

Skip it when:

- the verifier needs to reproduce the checks or inspect their evidence;
- the coding agent can read or use the signing key;
- the verifier has not independently reviewed the policy or pinned its hash and public key;
- you need a zkVM proof that executes the evaluator itself, an audited implementation, or a compliance certification.

## What is actually proved

The BBS proof establishes that the holder of the pinned private key signed all seven messages below in one receipt and that the revealed messages match the verifier's expected values.

| Signed receipt message | Shared with verifier? |
| --- | --- |
| Proof schema | Yes |
| `PASS` verdict | Yes |
| Canonical policy SHA-256 | Yes |
| Private workspace snapshot SHA-256 | No |
| Gate count | No |
| Complete gate-results SHA-256 | No |
| Evaluation time | No |

The hidden messages are part of the signature proof but are not included in the JSON bundle. The repository snapshot covers files, symlinks, paths, and contents while excluding `.git`, `node_modules`, and the root `dist` directory. It binds the private receipt to one workspace state, but it does not capture the complete process environment or claim reproducible builds.

This is a **signer attestation**, not a general-purpose SNARK or zkVM execution proof. The CLI runs Skillgate's normal deterministic evaluator, refuses to sign if zero gates are configured or any gate fails, and immediately derives the selective-disclosure proof. Cryptography prevents a party without the signing key from changing the signed verdict, policy, or hidden receipt. It cannot force a dishonest or compromised key holder to run the evaluator honestly.

## End-to-end walkthrough

### 1. Gate owner: create and isolate the key

For a local evaluation:

```bash
skillgate zk-keygen
```

This creates:

- `.skillgate/zk-private-key.json`, mode `0600`, automatically listed in `.skillgate/.gitignore`;
- `.skillgate/zk-public-key.json`, safe to share.

The local default is convenient for a preview, but it is not safe when the coding agent has workspace access. On an isolated gate server, put the private key outside the checkout:

```bash
skillgate zk-keygen \
  --private-key /etc/skillgate/customer-a.private.json \
  --public-key /srv/skillgate/customer-a.public.json
```

The command refuses to overwrite either file. Back up the private key in a secret manager and distribute the public key through a trusted channel. A public-key file has a SHA-256 `key_id` so both parties can confirm they pinned the same bytes.

### 2. Agree on and pin the policy

The verifier should review the definition of done first. The gate owner can then print its stable, format-independent identifier:

```bash
skillgate zk-policy-id
```

The identifier hashes the parsed policy with sorted object keys, so harmless YAML formatting changes do not change it. A semantic policy change does. The verifier stores this value independently; copying an unknown policy hash from a new proof would not establish that the policy was strong enough.

`zk-policy-id path/to/policy.yaml` uses an explicit spec. `--pin --base <ref>` uses the same fail-closed base-policy resolution as `skillgate check` and `skillgate gate`.

### 3. Verifier: send a fresh challenge

The verifier chooses a new, single-use value for every requested proof, for example:

```text
customer-audit-2026-09-06T12:00Z-7f95e2
```

An unpredictable challenge prevents an old proof from answering a new request. Treating the challenge as a reusable label still permits replay of the old proof.

### 4. Gate owner: run and prove

```bash
skillgate zk-prove \
  --private-key /etc/skillgate/customer-a.private.json \
  --challenge customer-audit-2026-09-06T12:00Z-7f95e2 \
  --out customer-a.pass.proof.json
```

The command runs every configured gate. On failure it prints the reasons locally, exits `1`, and writes no proof. On success it writes a mode-`0600` JSON proof bundle. Gate details and repository data do not appear in that bundle.

### 5. Verifier: check pinned inputs

```bash
skillgate zk-verify customer-a.pass.proof.json \
  --public-key customer-a.public.json \
  --expect-policy <approved-policy-hash> \
  --challenge customer-audit-2026-09-06T12:00Z-7f95e2
```

Verification fails on a different public key, policy hash, challenge, proof byte length, disclosed verdict, or altered proof.

The current seven-message receipt hides four messages and produces a 320-byte BBS proof. In the local validation run used for this feature, proof derivation took 22 ms and the compact JSON bundle was 767 bytes; timing is machine-dependent and excludes running the project's gates themselves.

## Security and operational limits

- Keep the private key away from the coding agent. Gitignore and mode `0600` reduce accidents but do not create an isolation boundary.
- Pin the public key and policy hash before requesting a proof. Values first seen inside the response are not trusted anchors.
- Rotate the signing key after suspected compromise. Old proofs remain tied to the old public key, so retain a dated key registry if they must remain verifiable.
- The policy hash is public. It can reveal equality with a guessed policy even though the policy text is not in the bundle.
- A private snapshot hash is signed but hidden. This first slice cannot prove that the snapshot equals a particular public Git commit without disclosing an additional commitment.
- The BBS implementation in [`@mattrglobal/pairing-crypto`](https://github.com/mattrglobal/pairing_crypto) is Apache-2.0 and has no trusted setup, but its maintainers state that the implementation has not undergone an independent implementation audit. Treat this feature as experimental until the integration and dependency receive appropriate review.

## Why BBS instead of a zkVM here?

Skillgate gates can run shell commands, scanners, and arbitrary project test suites. Claiming that a small circuit proves all of that execution would be false. Porting the evaluator, every supported command, and their environment into a zkVM is a separate, much larger product boundary.

BBS selective disclosure gives the narrow value needed now: one isolated gate signs the full receipt, while each customer receives a challenge-bound proof that reveals only the agreed pass claim. If later demand requires trustless re-execution, add a separate zkVM-backed gate type with explicit supported commands and reproducible environment inputs rather than silently widening this claim.

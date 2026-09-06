# Encrypted fleet metrics

Skillgate can answer a narrow question across private repositories: **how many required gates passed in total?** The collector adds encrypted counts without learning any repository's readable result. A separate key owner should decrypt only the intended full-group total.

This is an experimental encrypted-computation preview. It complements Skillgate's private PASS proof; it does not replace it.

## Practical example

An agency maintains five customer repositories. Each customer permits a fleet-wide service-quality figure but not a repository-level report. Each repository runs `skillgate check --json` locally, encrypts its passed and total gate counts, and sends only the encrypted metric to a collector. The collector combines all five. A different person holding the decryption key opens and publishes only the five-repository percentage.

Other bounded uses include an internal portfolio dashboard or a vendor program that releases one group compliance rate. Do not use the flow to publish individual scores or tiny-group results.

## Who can learn what

| Role | Learns | Must not receive |
| --- | --- | --- |
| Repository owner | Its normal local Skillgate report | Other repositories' reports |
| Collector | Number of contributions, opaque contributor commitments, key/context identifiers, and ciphertext sizes | Decryption key |
| Key owner | Decrypted fleet passed/total counts | Individual encrypted metric files |
| Public audience | Only the fleet result the key owner chooses to publish | Keys, metrics, aggregate file, or repository identities |

The repository still sends data: an encrypted file of roughly 176 KB. What does **not** leave in readable form is source code, gate names, evidence, reasons, or per-repository counts. Network metadata and file timing are outside the cryptographic protection.

## End-to-end walkthrough

The key owner creates a fresh campaign key. The default secret path is added to the caller's `.gitignore` automatically.

```bash
skillgate fhe-metrics keygen
```

Share `.skillgate/fhe-metrics-public.json` with every repository and the collector. Keep `.skillgate/fhe-metrics-secret.json` offline and away from both.

Each repository chooses a unique, high-entropy random token and runs:

```bash
skillgate check --json | skillgate fhe-metrics encrypt \
  --public .skillgate/fhe-metrics-public.json \
  --context 2026-Q3-policy-a \
  --repository <unique-random-token> \
  --out repository.metric.json
```

Only hashes of the context and repository token appear in the encrypted-metric envelope. A human-readable repository name is guessable from its hash, so use a random token rather than `customer-api`.

The collector pins the public key and context, then supplies all expected files:

```bash
skillgate fhe-metrics aggregate \
  --public .skillgate/fhe-metrics-public.json \
  --context 2026-Q3-policy-a \
  --out fleet.aggregate.json \
  repo-a.metric.json repo-b.metric.json repo-c.metric.json
```

The key owner verifies the exact expected contributor count before releasing the result:

```bash
skillgate fhe-metrics decrypt \
  --secret .skillgate/fhe-metrics-secret.json \
  --context 2026-Q3-policy-a \
  --expected 3 \
  --minimum-percent 90 \
  fleet.aggregate.json
```

Exit code `0` means the percentage met the target. Exit code `3` means the aggregate was structurally valid but did not meet it. Other non-zero codes are input, count-consistency, or cryptographic failures.

## What this protects—and what it does not

- The collector can add the three encrypted counters but cannot read them without the secret key.
- Each metric carries an encrypted contribution counter, so changing only the visible repository count is detected. `--expected` also catches an accidental partial group. It does not prove contributor identity: anyone with the public key can fabricate a padding metric. Authenticated submissions are required before relying on adversarial completeness.
- Encryption does not prove that a repository reported honestly. A repository that controls the local process can fabricate the JSON it encrypts. For stronger operational trust, run both `check` and `encrypt` in an isolated runner the repository cannot alter.
- The collector can drop or replace a contribution and cause failure. Availability is not secrecy.
- The secret-key owner can decrypt any individual metric it obtains. Organizational or technical separation between collector and key owner is therefore essential.
- Releasing multiple overlapping group totals can reveal an individual's value by subtraction. Use a fresh key/context per reporting campaign and release only the complete expected cohort.
- Repository and context commitments hide only unpredictable values. Low-entropy names can be guessed offline.
- This result is not a transferable proof that every contributor ran Skillgate correctly. Use `zk-prove`/`zk-verify` when a verifier needs a per-repository PASS attestation without the hidden details.

## Cryptographic scope

The helper uses Lattigo v6.2.0 BGV with a fixed 128-bit-class parameter set (`LogN=12`, `LogQ=[39,31]`, `LogP=[39]`, plaintext modulus 65537). It encrypts three integer slots—passed gates, total gates, and a contribution counter—and performs additions only. There is no bootstrapping, arbitrary-depth circuit, comparison inside ciphertext, multiparty key generation, or threshold decryption.

That narrow circuit is deliberate: the useful operation here is summation. The parameters and protocol are experimental defaults, not a production cryptographic design, and the implementation has not received an independent audit. Production deployment should add authenticated submissions, threshold decryption, campaign governance, and review by a cryptographer.

The npm CLI builds the bundled Go helper into a temporary local directory and runs it; Go 1.25+ and first-run access to download the pinned module are required. Normal Skillgate gates and private PASS proofs remain pure Node.js commands.

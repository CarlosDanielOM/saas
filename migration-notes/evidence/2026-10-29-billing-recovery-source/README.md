# Billing recovery production source capture

This evidence package preserves the committed production source and behavior-check script associated with the billing recovery fix. It is a read-only source capture, not an execution of the check or proof of the bytes inside a running image.

## Committed references

Source commit `55bd0bb79a6edc441ec9f5104c13576fca0324b3` (`fix(billing): recover past-due plans without repeat trials`) follows `9d35bd1ece3304627bdadee637e899d51cc6d7ad`. The captured files are exact `git show` bytes from that commit and match the targeted files in the `/root/saas` checkout at capture time:

- [`billing.ts`](external-source-api-ee0635765a02/dimabot/src/utils/billing.ts), SHA-256 `2bcb086c6ef1c668a392a983bfbb6107f9555c63c6b903e1aebf3f59c9e1791f`, Git blob `4c4832af2ccf34732d26cee598e1f972afe843b4`.
- [`billing-subscription-checkout.mjs`](external-source-api-ee0635765a02/ops/checks/billing-subscription-checkout.mjs), SHA-256 `cebfc0969162b8d7bc127755f462c4f065fe4b8a183a881bcf0d003cf080e472`, Git blob `1b817482646bb3957ac2bf3a86f5cf1e33032b41`.
- [`billing-recovery-commit.patch.gz`](billing-recovery-commit.patch.gz), a deterministic gzip copy of the byte-exact two-file parent-to-commit diff; uncompressed SHA-256 `9dc6a9f9fd5103682e3516be4bbee3a10917c3ed82b7efce4cdaa3725ec7e5ac`.

[`release-receipt-selected.json`](release-receipt-selected.json) contains only the allowed receipt fields for run `api-ee0635765a02`: target `api`, status `deployed`, image `sha256:22091c1adbd9a0891cefe2496bf5c2df8967aa6a10fdf0ca33945cd9cef16030`, source digest `a77f37a44ffcc8453c5f6f15808931fcb6d9bb6decfda8ebffdd3f4ec32d075e`, and deployed container ID `34b055fd16739f2f15ba97181868929a0fc3232e3327ad5340bb5b99de25bf6d`. These are release metadata; they do not prove runtime bytes were extracted from the container.

[`capture-manifest.json`](capture-manifest.json) records the source, patch and receipt excerpt hashes, Git identities, frozen baseline comparison, and capture limits. Its SHA-256 is recorded in [the source obligation note](../../billing-recovery-source-obligation-2026-10-29.md).

# TTS value adapters evidence — 2026-10-29

## Accepted source and result

The implementation is committed as `14c8d171a7542e3327ede9e0aee5146514e76392`. The frozen source tree SHA-256 is `4cc5a9dac720136211179a3835a64b5b9f7e10308d9f8a75cec0567e8cdcfc19`.

Node source-oracle run `1793239069194106370` passed source write/check and source-hash provenance checks for two reused fixtures. The actual-TypeScript expressive oracle passed 1,932 cases: 1,229 filter, 185 reinforcement, 314 normalization, and 204 voice. The expanded normalization corpus adds 301 cases, with four cases per each of 75 tags plus malformed masks, nullish and explicit-false values, primitive roots, unknown/lone keys, duplicate keys, and Kelvin-sign voice normalization.

The capped compiler run `1793239113115650059` passed in 135.859 seconds (144.161 seconds total), against the same frozen source hash. It recorded 75 ordinary test executions (56 library, seven settings normalization, one settings schema, five expressive lossless, one JavaScript-string, two credit fallback, and three TTS utilities) and four explicit fixture executions (expressive source, settings pure source, settings schema metadata, and credit fallback source). Fresh native replays covered the 1,932 expressive cases, 308 settings-pure cases, 11 schema-metadata cases, and 276 credit-fallback cases. These are separate fixture case totals, not additional test-execution counts.

The compiler run passed formatting; strict TTS-utilities all-target check and Clippy; channel-settings all-target check and Clippy; all-features all-target check and Clippy; and no-default-features all-target check. It used six CPUs, 4 GiB memory with no swap, 256 PIDs, and two Cargo jobs. Peak build cache was 7,596,826,624 bytes; minimum available memory was 10,362,929,152 bytes. No package, manifest, lockfile, feature default, or worker-profile change was made.

## Source-oracle fixtures and provenance

The three preserved gzip fixtures contain the source outputs used by the focused checks:

- [Expressive TTS reference output](expressive-tts-reference.json.gz), uncompressed SHA-256 `6049b50f99877f55358bf3b5cd49912c4153ea9efd6987136d7c3086b3075d71`.
- [Channel TTS settings reference output](channel-tts-settings-reference.json.gz), uncompressed SHA-256 `7a91d8d2769cf8e0e3daff4cad726ffd2461da364780d0af2daa50f973028b0a`.
- [TTS credit-fallback reference output](tts-credit-fallback-reference.json.gz), uncompressed SHA-256 `429154e7ce98eb6fbe426c7edd21f8a699cd694e0151c41da3b6f75ffea44a70`.

The channel-settings and credit-fallback JavaScript goldens were reused after source-hash provenance checks; they were not regenerated. The [provenance report](reused-fixture-provenance.json) verifies 12 source entries for settings and 10 for credit fallback. These are 22 verified entries across the two reports, not 22 unique files. [Before](tts-values-fixtures-before.sha256) and [after](tts-values-fixtures-after.sha256) fixture manifests match, confirming the reused/source fixtures were unchanged during compiler validation. [Compressed artifact indexes](compressed-fixtures.json) and [compressed log indexes](compressed-logs.json) record decompressed hashes and byte counts.

## Receipts, logs, and reproducibility files

- [Formatter receipt](format-1793238951378442405-receipt.json) and [compressed formatter log](format-1793238951378442405.log.gz).
- [Node source-oracle receipt](node-1793239069194106370-receipt.json) and [compressed Node log](node-1793239069194106370.log.gz).
- [Compiler receipt](compiler-1793239113115650059-receipt.json) and [compressed compiler log](compiler-1793239113115650059.log.gz).
- [Recorded formatting helper](recorded-verifier/apply_format.py), [Node verifier](recorded-verifier/tts-values-node.sh), [Rust verifier](recorded-verifier/tts-values.sh), [fixture provenance verifier](recorded-verifier/tts_values_provenance.mjs), and [isolated validation harness](recorded-verifier/validate.py).
- [Machine-readable verification summary](verification-summary.json).

## Cleanup and scope

The [cleanup receipt](cleanup.json) confirms all 19 inspected production container records were unchanged across IDs, images, start times, mounts, image configuration, entrypoints, commands, and Compose labels; fingerprint SHA-256: `7eaaaad042c277d84cf49c184f2d7cf5806a641c687772acd8ca69cfc2403c53`. No task-owned containers, networks, or volumes remain. The private build cache was retained for the ongoing migration. No deployment or push occurred.

The native settings path now uses the value adapters, while TypeScript application callers remain. Exact exported closed-tag-union / complete-record type parity still needs audit before TypeScript retirement. No Mongo transport/write-plan or HTTP/provider tests were rerun because those adapters did not change; no provider/Twitch calls or production data were used. No new benchmark was run, and no performance claim is made. Keep prior expressive benchmark regressions scoped to their original sources and workloads in the [expressive TTS evidence](../2026-10-29-expressive-tts/README.md). The [migration note](../../tts-value-adapters-2026-10-29.md) records local behavior coverage and open integration boundaries.

## Evidence inventory

Artifact hashes for the frozen evidence pack are listed in [`sha256.json`](sha256.json).

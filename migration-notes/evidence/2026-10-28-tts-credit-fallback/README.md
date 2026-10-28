# TTS credit fallback verification evidence — 2026-10-28

This evidence pack records the exact-source oracle, isolated Rust compiler matrix, archive check, and cleanup for the TTS credit fallback helper. Source SHA-256: `0a7ab31bac53f28254243d81805eeda933c856f85839f9ee9f76f1682c50b3e8`.

## Evidence index

- [verification-summary.json](verification-summary.json) — final suite totals, scenario counts, source identity, and verification status.
- [compiler-1793231264957253198-receipt.json](compiler-1793231264957253198-receipt.json) and [compiler-1793231264957253198.log.gz](compiler-1793231264957253198.log.gz) — final capped Rust quality/test matrix and resource observations.
- [node-1793231232336395230-receipt.json](node-1793231232336395230-receipt.json) and [node-1793231232336395230.log.gz](node-1793231232336395230.log.gz) — pinned Node/V8/TypeScript source oracle and exact 276-scenario replay.
- [format-1793230940944448018-receipt.json](format-1793230940944448018-receipt.json) and [format-1793230940944448018.log.gz](format-1793230940944448018.log.gz) — recorded formatting step.
- [tts-credit-fallback-reference.json.gz](tts-credit-fallback-reference.json.gz), [compressed-fixtures.json](compressed-fixtures.json), and [compressed-logs.json](compressed-logs.json) — compressed exact-source oracle output and artifact indexes.
- [tts-credit-fallback-fixtures-before.sha256](tts-credit-fallback-fixtures-before.sha256) and [tts-credit-fallback-fixtures-after.sha256](tts-credit-fallback-fixtures-after.sha256) — disposable fixture integrity before and after verification.
- [sha256.json](sha256.json) — hashes for the evidence artifacts; receipts carry frozen source-input hashes.
- [archive-check.json](archive-check.json) — exact source-to-archive hash checks and post-retirement file inventory.
- [cleanup.json](cleanup.json) — task-owned resource cleanup and production identity/configuration readback.
- [recorded-verifier/credit_validate.sh](recorded-verifier/credit_validate.sh), [recorded-verifier/node.sh](recorded-verifier/node.sh), [recorded-verifier/validate.py](recorded-verifier/validate.py), and [recorded-verifier/apply_format.py](recorded-verifier/apply_format.py) — retained verifier commands and result validation.

The final compiler run passed formatting, standalone TTS check/Clippy, all-feature check/Clippy, no-default-feature check, 53 ordinary test executions, and one separately invoked explicit credit fallback replay. The source oracle passed 276 byte-exact scenarios (270 generated plus six explicit cases), including UTF-16 preservation and unchanged-request identity. See the feature note for suite breakdown, runtime/resource qualifications, and compatibility boundaries. Warm-cache durations are run observations; no benchmark or performance claim was produced.

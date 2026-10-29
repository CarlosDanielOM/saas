# AI credit projection and receipt producer evidence

This evidence pack supports the bounded migration described in [the migration note](../../ai-credit-receipt-2026-10-29.md). It distinguishes the unchanged credit projection baseline from the later receipt-producer-only optimization. It contains 32 source bindings and 34 compressed-payload hash/length records; the overall file count may grow as documentation and the benchmark chart are added.

## Source bindings and summary

- [Verification summary](verification-summary.json): baseline and final runs, source hashes, checks, and evidence counts.
- [Baseline source binding](baseline-source-binding.json): source tree `77fc976da064a87c02ec1fce93cd0e4820dfe53a7eac9feb5fab453c482d80f7`, including the credit projection and initial receipt producer.
- [Final source binding](source-binding.json): source tree `02ab55a9d484c01af695793b55d6313280f30080c76db5ad9b5a909b440ac78f`, including the receipt-only classification-map optimization.
- [Compressed artifact checksums and lengths](compressed-artifacts.json).
- [Runtime provenance exclusions](runtime-provenance-exclusions.json): Node and TypeScript executable copies were intentionally excluded; their hashes and byte lengths are retained, with no secrets included.

## Run evidence

The successful baseline compiler run is [compiler-fixtures-1793256166045626940](runs/compiler-fixtures-1793256166045626940-receipt.json.gz), followed by [node-1793256476785298801](runs/node-1793256476785298801-receipt.json.gz). The baseline is the full credit and unchanged TTS proof; its 178 reported test executions include overlapping dependency tests and a subprocess-only no-op helper, not 178 unique tests.

The successful final producer compiler run is [compiler-fixtures-1793256739341677553](runs/compiler-fixtures-1793256739341677553-receipt.json.gz), followed by [node-1793256972582181383](runs/node-1793256972582181383-receipt.json.gz). The final source hash applies to the receipt producer; the credit implementation remains bound to its earlier source hash. The final read-only production check is [final-readback.json](artifacts/ai-credit-receipt/final-readback.json): 19 records were unchanged and no task-owned containers, networks, or volumes remained.

Three failed compiler attempts are preserved as failures: `compiler-fixtures-1793255399962290566`, `compiler-fixtures-1793255901565235359`, and `compiler-fixtures-1793256016693648238`. The first exposed test-only private `ConnectionInfo.addr` access; the next disconnect fixture retained a TCP clone that blocked EOF; the third exposed a Clippy test-seed type annotation. Follow-up harness fixes preceded the successful baseline run. These failures are not application defects.

Raw run receipts and logs are retained in [runs/](runs/); `compressed-artifacts.json` records their hashes and byte lengths. Source oracle artifacts are under [artifacts/ai-credit-receipt/](artifacts/ai-credit-receipt/) and [artifacts/ai-credit-receipt-baseline/](artifacts/ai-credit-receipt-baseline/).

## Benchmark evidence

- [Node benchmark report](artifacts/ai-credit-receipt/producer-benchmark/ai-usage-producer-node-benchmark.json)
- [Final Rust benchmark report](artifacts/ai-credit-receipt/producer-benchmark/ai-usage-producer-rust-benchmark.json)
- [Reused-input and native-hash rebinding audit](artifacts/ai-credit-receipt/benchmark-reuse-audit.json)
- [Baseline Node benchmark report](artifacts/ai-credit-receipt-baseline/producer-benchmark/ai-usage-producer-node-benchmark.json)
- [Baseline Rust benchmark report](artifacts/ai-credit-receipt-baseline/producer-benchmark/ai-usage-producer-rust-benchmark.json)

The same TypeScript timing trials were reused after explicit native-core-only rebinding. The audit reports unchanged TypeScript, harness, prepared payloads, expected wires, checksums, and seven timing trials; only the native core provenance and input hash changed. All pools use `entryKind: usage`; the optimization timing does not measure adjustment receipt performance. The [receipt benchmark](receipt-benchmark.html) was visually checked at 390 and 718 px in dark mode; [visual-verification.json](visual-verification.json) binds its HTML hash and render. Derived metrics and all raw samples are in [benchmark-comparison.json](benchmark-comparison.json).

No production mutation, deployment, caller adoption, source retirement, or push occurred.

The [artifact SHA-256 index](artifact-sha256.json) covers every retained file except the index itself; the [integrity report](integrity-report.json) records the independent source, fixture, and trial checks.

# PostHog payload performance evidence

Verified local synthetic follow-up. The full dimabot migration and caller adoption remain incomplete; no push, deployment or source retirement occurred. The original regressions remain preserved in the [initial baseline](../2026-10-29-posthog-receipt/README.md).

The [summary](verification-summary.json) identifies exact source and runs. The [comparison](artifacts/current-benchmark-comparison.json) and [chart](artifacts/current-payload-comparison.html) retain all six pools and sample ranges. All 42 TypeScript trials are retained unchanged; only four native source hashes were rebound, with byte-level reuse audits. Timing covers prepared payload builders, ordered JSON and UTF-8 checksum only. The smallest command gain has overlapping ranges. There is no significance, CPU, RSS, HTTP, queue or whole-application claim.

The [current source binding](source-binding.json) maps 1,269 frozen inputs to verified Git bytes and ten unchanged SDK reference hashes. [Earlier candidate bindings](prior-candidate-source-bindings.json) retain the exact failed formatter source and the first optimization candidate. The 35,464 raw inputs, group labels and engine String/JSON expectations are unchanged. All 53 initial failures are preserved, including the diagnostic proving the original formatter had the same differences.

All receipts and logs, including namespace/directory setup failures, the numeric parity failure, a parent-stopped overly broad follow-up compile and a cache-guarded scoped attempt, remain under runs/. The stopped all-features command script is clearly reconstructed from the recorded command rather than claimed contemporaneous. Large payloads and every log are compressed losslessly with raw hashes/lengths in the [compression manifest](compressed-artifacts.json). The regenerable diagnostic ELF is excluded with its hash; source and read-only rerun proof are retained. Public Node/package binaries referenced by earlier evidence remain private, with their existing hash manifests.

The final readback checks 19 unchanged production records and no owned containers, networks or volumes.

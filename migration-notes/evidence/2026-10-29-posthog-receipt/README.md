# Initial PostHog and receipt parser evidence

This behavior-verified baseline retains four small-payload performance regressions. It is not total dimabot migration completion or a production release.

The [verification summary](verification-summary.json) identifies the exact runs, resource limits and counts. The [source binding](source-binding.json) verifies all 1,267 frozen inputs against commit 77141415e72810cf7df5d64b97a53ae0dee1b8af and ten archive-verified SDK references. The [earlier runtime binding](runtime-baseline-source-binding.json) also preserves the four exact pre-lint native files needed for the five-timezone proof.

The receipt fixture has 1,362 cases per time zone. All five Rust replays passed before lint-only corrections; the final UTC replay passed afterward. A byte-exact oracle comparison permits only one changed test-source hash; all production parser inputs, cases, BSON projections and producer recipes are unchanged.

The [initial comparison](artifacts/initial-benchmark-comparison.json) and [interactive chart](artifacts/initial-posthog-benchmark.html) retain every measured regression and speedup. The workload is prepared event construction, ordered JSON and UTF-8 checksums; HTTP, queueing, databases, input setup and SDK metadata are excluded. The saved TypeScript timing trials are reused byte-for-byte only where all fifteen bound benchmark sources and the input remain identical. There is no CPU, RSS or whole-app claim.

Raw fixtures, checksums, recovered source and source-reuse audits are under artifacts/. Every run receipt and log, including failed cache/lint attempts, is under runs/. The [compressed manifest](compressed-artifacts.json) records raw hashes and byte lengths. Public runtime/package byte copies are excluded, with hashes and sizes recorded. Recorded verifier scripts include a clearly named reconstructed first command script; it is not a contemporaneous signed record.

The final readback found 19 unchanged production records and zero remaining task-owned containers, networks or volumes. No production mutation, caller adoption, deployment, TypeScript retirement or push occurred.

Two byte-identical repeated parser fixtures are deduplicated through artifact-aliases.json and retained-artifacts.json. The independent integrity report validates raw gzip hashes/lengths and both complete source-tree hashes.

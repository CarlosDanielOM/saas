# Moderation semantic worker evidence — 2026-10-30

Status: **partial local native mapping**. The semantic worker is not retired, not caller-adopted, and not complete as a dependency closure. No deployment, push, or performance claim is made.

The final implementation is bound to code commit `1d76b435d81aa2ede8c9023b77bc1429cf217291`. The TypeScript source oracle is bound to immutable source commit `65d600dc5b6b27ee62d4747caa80b7ea9e1d93b7`. The final frozen source-tree SHA-256 is `6c199f40fefd469346533f57182204a8ee1aedce66dde9ace6e00a9b8c7971bb` across 1,464 inputs: 1,454 Git files and ten reused SDK inputs. Five compact implementation/test paths are included under `source-snapshot/`; `source-bindings.json` contains the complete receipt hash map.

## Verification

The final Node source replay `node-1793353870017934370` and compiler-fixtures run `compiler-fixtures-1793353821109683319` both succeeded against the same frozen source tree. The later Node postcheck `node-1793354263387812460` also succeeded on that tree. The source corpus had 41 records: 39 map to concrete private Mongo/Redis/loopback fixture coverage; two remain source-only boundary cases (`paid-negative-balance` and `maintenance-ingest-throw`). The four ignored worker tests comprise three concrete private-service suites and one full-trace audit; the latter does not count as a concrete replay of all 41 cases.

The final compiler-fixtures phase passed four normal BSON regressions and one ignored BSON replay covering 54 cases, along with scoped, minimal, Mongo/Redis, all-feature/all-target strict checks. Formatting passed. It completed in 194.936 seconds (206.214 seconds total) with the recorded caps of six CPUs, 4 GiB memory/no swap, 256 PIDs, and two Cargo jobs; minimum available memory was 9,083,023,360 bytes and peak cache was 7,707,127,808 bytes. No worker benchmark was run.

## Behavior and boundaries

The worker performs one atomic claim and at most ten charge ingestions per pass, with no helper sleeps. It reuses the 750 ms provider-only credit-reader deadline and the cache-usage adapter's existing lease/wait policy. The Rust code adds no application-level Mongo mutation retries and inherits caller-owned driver policy; fault tests disabled driver retries.

The native path reuses `AiCreditProjection`, `AiCreditReader`, `PolarCacheUsage`, existing semantic/provider and spam policy helpers, plus native BSON conversion. A constructor-only setup performs no I/O. There is not yet an application bootstrap adapter, scheduled worker binary/supervisor adoption, full Polar immediate/batch ingestion, or downstream billing closure. Other documented gaps are BSON reader-stage invalid-regex/eager nested decoder behavior, automatic logger telemetry/OTel bootstrap and logging-throw parity, and malformed schema-shaped BSON beyond the tested contract.

The two source-only traces are not claimed unreachable: ordinary reader behavior does not yield an available negative balance, and telemetry/logging can throw beyond the mocked ingestion call.

## Production and resources

Readback reports all 18 production records unchanged and zero remaining task-owned resources. A proactive private debug-cache cleanup removed 31 task-owned completed debug executables and freed 1,085,304,832 bytes. No quota was increased and no guard failure occurred. Full retained run receipts/logs, compressed source payloads with raw/stored digests, the cleanup record, and reproduction helpers are indexed in this package.

The supplementary `artifact-sha256.json` is the complete machine-readable inventory, including this README and source bindings. It records stored hashes before decompression and raw hashes afterward for every payload except itself; earlier tables and indices describe the originally packaged payloads.

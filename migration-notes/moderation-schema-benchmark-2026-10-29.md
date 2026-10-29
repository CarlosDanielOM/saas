# Channel moderation schema benchmark — 2026-10-29

## Scope and source binding

This follow-up measures three selected channel moderation settings construction paths using unchanged TypeScript source, a real disconnected Mongoose 8.24.2 instance, and the native prebuilt-BSON `schema.construct` path. It is a microbenchmark for these paths, not a production traffic replay. The accepted source/build tree is commit `84f95db0`, SHA-256 `661a18bbdb26c596f586587f839e750dfd9adc9837a6ec588d7073f26634f8fe`, over 1,343 inputs. The previously accepted feature source tree had 1,341 inputs; all remain unchanged, and this benchmark adds only `dimabot/tests/channel_moderation_settings_benchmark.rs` and `dimabot/tests/fixtures/channel_moderation_settings_benchmark.cjs`. The channel-settings feature and core implementation were not changed by this benchmark.

The benchmark binary is a static x86-64 optimized ELF with SHA-256 `7d00051b9adac3d809c3a4d4cc121a88086d4bf6a36bd790fe4112a6a3a188a2`; its input SHA-256 is `3a71358904c70226586adad936e0fc2394da43868a37a36169c49a497a97d5e1`. The build provenance records opt level 3, no debug info, and disabled debug assertions and overflow checks.

## Method

Three separate, equally weighted pools each contain eight prebuilt records: defaults, four rules, and invalid input. Each sample processes 8,000 operations. Each actor/workload has three full warmups followed by seven alternating paired measurements. Both sides use fixed prebuilt ObjectId values (source ObjectId and native BSON ObjectId). The TypeScript path runs `new Model(input)`, `validateSync()`, and `toObject({ minimize: true })` for valid inputs; invalid results are preserved in source form. The native path runs `schema.construct(&prebuiltBsonDocument, now)`. Both retain results until the timer stops.

Before timing, all 24 full canonical document/error records and their per-record checksums were validated. All 60 calls and alternating actor order were checked; the aggregate checksums below matched. Input preparation, parsing, recursive canonicalization, serialization/UTF-8 wire conversion, sorted error conversion, checksumming and hashing, IPC, and result destruction are outside the measured interval. There is no database or network operation in the timed path. Consequently, the result compares two complete selected call paths; it does not isolate the costs of allocation, validation, conversion, or any other individual operation.

## Paired measurements

Values are independently recomputed medians and observed ranges in nanoseconds per operation. The paired report's raw `nodeMedianNs` and corresponding sample fields are elapsed nanoseconds per 8,000-operation sample; the table uses the independently normalized ns/op readback.

| Workload | TypeScript median (ns/op) | Native median (ns/op) | TypeScript range (ns/op) | Native range (ns/op) | Checksum |
|---|---:|---:|---:|---:|---:|
| Defaults | 145,969.82925 | 10,361.43075 | 141,038.710125–156,200.428875 | 9,615.86425–12,435.9215 | 433599429 |
| Four rules | 1,299,941.509125 | 112,769.9455 | 1,242,808.896–1,386,829.567875 | 109,806.360875–124,843.767625 | 4060612453 |
| Invalid | 323,482.888625 | 20,378.014125 | 308,468.842125–346,021.561625 | 19,874.745125–23,410.459625 | 4163112709 |

These measurements describe only the three selected model paths under the recorded harness. The pools are small and equally weighted rather than representative of production request mix. Both actors ran within the same capped environment. No claim is made about production API latency, production traffic, aggregate feature performance, CPU, RSS, or statistical production impact. The measurements do not establish a universal Rust-versus-TypeScript performance conclusion.

## Verification and readback

All four accepted receipts passed: Node preflight `1793312408188925296`, optimized compiler `1793312408192802668`, paired Node coordinator `1793312710512591234`, and strict compiler `1793312997059829717`. Strict formatting, no-feature, scoped/all-feature Clippy, no-default, and all-features/all-targets checks passed. The pinned run used 6 CPUs, 4 GiB memory, no swap, a 256-PID cap, and two compiler jobs. Minimum available memory was 7,095,283,712 bytes; build cache was 4,944,850,944 bytes. These are execution conditions, not performance results.

Before/after source hashes matched and the source and benchmark fixture remained unchanged during measurement. Final readback reports 19 unchanged production records and zero task-owned resources remaining. No deployment or push occurred. The TypeScript model and application callers remain live; no caller adoption or TypeScript retirement is claimed. The larger migration remains incomplete.

The raw benchmark inputs, static binary, paired report, independent input/timing readbacks, receipts, and final readback are indexed in [`evidence/2026-10-29-moderation-schema-benchmark/`](evidence/2026-10-29-moderation-schema-benchmark/README.md). The detailed benchmark handoff is [moderation schema benchmark handoff](moderation-schema-benchmark-handoff.md); the initial feature acceptance is preserved in [channel moderation settings](channel-moderation-settings-2026-10-29.md).

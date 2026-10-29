# Moderation schema benchmark handoff

## Accepted bounded result (2026-10-29)

The selected channel moderation settings construction paths were measured against the unchanged TypeScript/Mongoose reference and the native BSON schema constructor. The accepted benchmark source binding is commit `84f95db0`, SHA-256 `661a18bbdb26c596f586587f839e750dfd9adc9837a6ec588d7073f26634f8fe`, with 1,343 inputs. It preserves all 1,341 inputs from the accepted feature binding (`f630b11bf6ed08984f28de5cc14262c139c6541c581823561c1d53e3d93630fd`) and adds only the benchmark test and fixture. The feature/model code was unchanged.

The three equally weighted, prepared eight-record pools each ran 8,000 operations per sample. Each actor/workload had three warmups and seven alternating paired samples. Independent readback recomputed medians and ranges from the paired report:

| Workload | TypeScript median (ns/op) | Native median (ns/op) | TypeScript range (ns/op) | Native range (ns/op) | Checksum |
|---|---:|---:|---:|---:|---:|
| Defaults | 145,969.82925 | 10,361.43075 | 141,038.710125–156,200.428875 | 9,615.86425–12,435.9215 | 433599429 |
| Four rules | 1,299,941.509125 | 112,769.9455 | 1,242,808.896–1,386,829.567875 | 109,806.360875–124,843.767625 | 4060612453 |
| Invalid | 323,482.888625 | 20,378.014125 | 308,468.842125–346,021.561625 | 19,874.745125–23,410.459625 | 4163112709 |

The TypeScript timer covers constructing the actual Mongoose model from a prebuilt input, `validateSync()`, and `toObject({ minimize: true })` for valid results; invalid validation output is retained in its source form. The native timer covers `schema.construct` from a prebuilt BSON document and retains all results through the clock. Both use fixed prebuilt ObjectId inputs. Canonical document/error checking and per-record checksums were validated before timing. Input preparation, parsing, recursive canonicalization, serialization, sorted error conversion, checksum/hash work, IPC, and result destruction are outside the timer. This compares these two complete selected call paths; it does not isolate allocation or any single operation.

All 24 full canonical document/error records and checksums were prevalidated, all 60 call orders were checked, and before/after source hashes matched. The static optimized native ELF has SHA-256 `7d00051b9adac3d809c3a4d4cc121a88086d4bf6a36bd790fe4112a6a3a188a2`; the benchmark input has SHA-256 `3a71358904c70226586adad936e0fc2394da43868a37a36169c49a497a97d5e1`. Accepted preflight Node, release compiler, paired Node, and strict compiler receipts are `1793312408188925296`, `1793312408192802668`, `1793312710512591234`, and `1793312997059829717`; all passed. Formatting, no-feature, scoped/all-feature Clippy, no-default, and all-features/all-targets checks passed on the frozen candidate.

## Limits and status

The pools are small prepared workloads, equally weighted rather than representative of production traffic. The actors ran in one capped environment, and there was no Mongo/network work in the timed path. These are per-workload measurements of model construction and validation, not production API latency or an aggregate Rust-versus-TypeScript conclusion. No CPU/RSS or statistical production-impact claim is made. Run resource limits and the unchanged production readback are recorded in the [dated benchmark record](moderation-schema-benchmark-2026-10-29.md).

The TypeScript model and application callers remain live. No caller adoption, TypeScript retirement, deployment, or push is claimed; this benchmark does not complete the wider migration. The raw inputs, binary, paired report, independent readbacks, and receipts are indexed in [`evidence/2026-10-29-moderation-schema-benchmark/`](evidence/2026-10-29-moderation-schema-benchmark/README.md). The original model acceptance remains documented in [channel moderation settings](channel-moderation-settings-2026-10-29.md).

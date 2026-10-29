# Complete receipt persistence helper benchmark

Seven alternating matched pairs per workload each process 32 sequential receipts through real TypeScript and Rust helpers against the same private Mongo8/Redis resources. Every pair produced equivalent full BSON snapshots after normalizing only generated top-level document ids and object key ordering. All 28 actor samples and eight warmup outcomes are retained. Independent readback verifies pair ordering, counts, hashes and recomputed times.

Insert median time per receipt: TypeScript 5.387853ms, Rust 3.961479ms (26.47% lower). Duplicate-repair: TypeScript 5.068453ms, Rust 3.802758ms (24.97% lower). This is one isolated host run of the bounded helper; setup/producer/parsing/bootstrap/reset/readback/IPC/provider/error paths are excluded. No CPU, memory or production-latency claim. Prior reducer-only Rust regressions remain separately retained.

Source/binary provenance, prepared data, all raw trials and BSON readbacks, successful and failed compiler/source checks and reproduction tools are indexed. Public dependencies and exact static native ELF are hash-bound rather than vendored. No TypeScript retirement, caller adoption, deployment or push occurred.

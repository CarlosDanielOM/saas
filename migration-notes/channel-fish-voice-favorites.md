# Fish voice favorites: typed native baseline

**Status: native baseline accepted for typed records; retirement and allocation candidate pending.** This evidence records the current bounded Rust implementation and its verified typed-record behavior. It does not claim that the TypeScript feature has been retired, that callers have adopted Rust, or that the allocation candidate has been tested or accepted.

## Source and scope

The immutable source snapshot is Git commit `0506c5088af534c07fecd3563c9264589f3af3c0`, with 1,502 bound inputs (1,492 Git inputs and 10 reused SDK inputs) and source tree SHA-256 `9b11ced33a15768bb42fb28268bb92440e5692f21a50976544cd018da656841e`. The corresponding bound capture and source-final map are preserved in the evidence package. The native baseline is associated with commit `5cf74ba0`; the harness is bound to `0506c508`.

The checked scope covers the Fish favorite typed record/schema boundary and the normalization/alias operations used by it. The captured source oracle includes protocol 12, normalization 15, aliases 16, three real-Mongoose cases, nine constructor cases, and eight BSON cases. The native suite contains five tests. Verification used BSON `6.10.4`, Mongoose `8.24.2`, and its resolved MongoDB driver `6.20.0`.

This is typed-record parity, not general Mongoose model or JavaScript object parity. The native implementation rejects malformed stored values and projects unknown favorite fields away at the declared typed interface. It does not claim arbitrary unknown-shape or npm prototype behavior. The isolated Mongo test passed CRUD, concurrent add/rename races, capacity checks, legacy default migration, timestamps, BSON replacement, and malformed-data cases. The forced 21-conflict exhaustion proof uses a separate recording repository; the real Mongo test proves concurrent operations without guaranteeing that particular 21-conflict schedule.

## Verification record

The final Node fixture run (`1793372728187388168`) passed after correcting the captured SDK's nested MongoDB version pin. The final compiler-fixture run (`1793372737318120079`) passed all five Rust tests and the settings checks, including format, scoped Clippy, minimal-feature, and all-feature strict checks. The release benchmark build (`1793372914152563479`) and report checker (`1793373209694818208`) passed. Production readback recorded 18 production records unchanged and zero task-owned resources.

Earlier attempts are retained as historical evidence, not silently replaced: an obsolete BSON test API caused an initial compiler-fixture failure; a later fixture run completed its tests but failed Clippy on `collapsible_if`; and a Node run failed before fixture execution because it pinned nested MongoDB `6.21` instead of the captured `6.20`. The later corrected-pin and final checks passed. The formatter runs and raw logs are indexed alongside those attempts.

## Baseline microbenchmark

The benchmark input SHA-256 is `c4c38e943f0dbe3d37caebe7f3fe0c89bb284c021fae4a840a5663fdc5caf8aa`. It used five pools of 32 cases, 20 complete warmup passes, and seven measured trials per workload. The harness prepared equivalent helper calls and checked scalar checksums derived from output lengths and fixed error fields. Timed JavaScript used normal V8/CommonJS execution, with separate VM-versus-normal-realm validation before timing. Rust used the native release implementation and prevalidated every prepared result before timing. Per-trial samples, checksums, workload inputs, binary binding, and provenance are retained in the evidence package.

| Workload | Node median ns/op (range) | Rust median ns/op (range) | Rust / Node median |
|---|---:|---:|---:|
| Normalize valid | 171.706 (153.584–1,319.270) | 252.444 (242.696–440.158) | 1.47× |
| Normalize invalid | 7,830.693 (7,138.613–8,479.777) | 166.917 (140.735–222.338) | 0.02× |
| Make ASCII alias | 812.173 (724.069–1,307.415) | 850.335 (771.522–978.207) | 1.05× |
| Make Unicode alias | 845.105 (835.236–913.004) | 1,545.860 (1,418.104–1,933.031) | 1.83× |
| Make colliding aliases | 2,139.915 (2,019.740–2,632.713) | 5,913.354 (5,753.403–6,340.193) | 2.76× |

These are mixed local helper timings: Rust is slower in four of five workloads. Invalid normalization is not an apples-to-apples error-cost comparison: JavaScript throws and captures an `Error` stack, while Rust returns a result with static error fields. The timings do not establish whole-application speed, memory use, allocation counts, database throughput, or end-to-end latency. No RSS or allocation counter was collected.

## Remaining work and adoption

The allocation optimization candidate is pending separate review and measurement. This baseline must remain visible in any later comparison, including its four slower workloads. TypeScript retirement, production deployment, and caller adoption are separate follow-up decisions; this package authorizes and records none of them. Repository migration counts are unchanged by this baseline.

## Evidence package

The indexed evidence is in [`evidence/2026-10-30-fish-favorites/`](evidence/2026-10-30-fish-favorites/README.md). Its `artifact-index.json` gives each payload's immutable origin, raw SHA-256 and size, stored SHA-256 and size, and compression encoding. Gzip members decode losslessly to their recorded raw hashes. The package preserves source-final maps, source overrides from failed attempts, oracle and benchmark inputs/reports, binary and toolchain bindings, scoped cache audits, production readbacks, and run receipts/logs. It excludes mutable snapshots, compiler target trees, and toolchain binaries.

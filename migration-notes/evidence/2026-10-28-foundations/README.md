# Native foundation evidence

These are recorded outputs from isolated migration checks, not release or production performance evidence. The [migration record](../../full-dimabot-rust-2026-10-28.md) describes scope, regressions, and outstanding dependencies. File hashes are in [sha256.json](sha256.json).

The [comparison chart](comparison.html) provides group filters and includes both improvements and regressions. Its [data](comparison-data.json) is derived from the retained benchmark pairs below.

Compiler/oracle logs are losslessly compressed as `.log.gz`; [compressed-logs.json](compressed-logs.json) records their original filenames and uncompressed hashes.

Benchmark pairs use the same named workloads and matching result checksums. Seven samples are retained for AST exports, credentials, pure helpers, schemas, and keyword operations. The durable-journal pair contains one trial of 1,000 inserts and 1,000 duplicates, with `w:1,j:true`; it must not be treated as a seven-sample median. Pure-helper core and serialization-inclusive results are distinct measurements. Serialized byte counts can differ because JSON key order and binary64 number spelling differ, despite parsed-output parity.

Rust uses release optimization. The Node schema, keyword, and pure-helper measurement processes execute compiled JavaScript without loading TypeScript's compiler. AST/credential VM functions are compiled and loaded once before measurement. Their process memory is not used for a cross-runtime RSS claim. The store fixtures are disposable MongoDB and Dragonfly instances; these figures do not establish production throughput.

The final foundation quality matrix is `compiler-1793207656819371013`; the earlier combined runtime suite is `compiler-fixtures-1793206387221308123`. Receipts retain immutable image IDs, per-file source hashes, source-tree digests, resource limits, headroom, and production-identity comparison results. They identify different snapshots: the later matrix explicitly enables JWT float round-tripping in its standalone feature. No new Cargo dependency was added. The combined suite recorded 450 ordinary test executions and five additional isolated-store fixture tests, all passing. Twelve default-ignored checks were not invoked in that focused suite; this is not an all-project runtime test claim.

The [recorded-verifier](recorded-verifier/) directory preserves the exact task driver and commands used for those receipts. Its absolute state/cache paths describe that run; it is not a portable release command or an instruction to reuse live resources. Tests were subject to the [Rust host limits](../../../dimabot/RUST_AGENTS.md). The driver uses labeled private containers, a private fixture network, disposable data, one capped compiler, and cleanup in `finally`. Source oracles and tests never run inside production containers. Production inspection was read-only. No deployment or push occurred.

Reproduction requires a fresh task namespace and state directory, the recorded immutable images, an available locked Cargo cache, and the same fixture sources. Follow the repository's current resource and isolation rules before running anything; preserve the recorded JSON rather than overwriting an accepted trial.

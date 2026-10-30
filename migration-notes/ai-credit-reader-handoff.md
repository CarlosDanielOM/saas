# AI-credit reader implementation handoff — 2026-10-30

This note records the verified, opt-in concrete adapter `dimabot/src/utils/ai_credit_reader.rs` and its focused tests. It has no application caller and is not registered as a default or worker feature. It covers the bounded `getAiCredits` behavior only; it does not establish billing dependency completeness, caller adoption, or deployment.

## Source and reuse

The source oracle uses `billing.ts` captured from accepted commit `55bd0bb79a6edc441ec9f5104c13576fca0324b3` with SHA-256 `2bcb086c6ef1c668a392a983bfbb6107f9555c63c6b903e1aebf3f59c9e1791f`, and `plan_cache_fence.ts` with SHA-256 `2639f0021342fba252e7c9ef331dc42cdb9cc4eb19b5e063eda7d167ac7787ee`. These are committed-source captures, not evidence that the exact bytes were in the accepted API image.

The reader composes `AiCreditProjection`, `PlanCacheFence`, the shared pooled Redis and Mongo clients, and `PolarClient`'s pooled HTTP transport. It performs the concrete `users` owner/current-plan lookup with an optional exact customer constraint; checks event-version fencing; reads, validates, projects, and fenced-writes the credit snapshot; and follows source-compatible verified/unavailable fallback behavior. It returns a lossless credit DTO and does not create new connections in its no-I/O constructor. An injected database can be used where the default Mongo URI does not name the application database.

The semantic-worker source supplies a 750 ms provider signal; the native reader accepts an explicit provider duration. The optional overall-operation deadline is separate. A canceled or timed-out operation does not replay an uncertain write. The reader does not implement checkout/subscription methods, `recordAiCreditUsage`, Polar usage ingestion, or cache-mode semantic-worker accounting.

## Accepted verification

The final accepted source is code commit `c6ac8d0fa4a68e98bc2dd3c8466bce0d1f6540c1`, source-tree SHA-256 `d674dd63d827f4b9c6ca0e6ce8a754f1cd5b6f05b2a4c1ac87fcf57f977e4b18`, with 1,449 frozen inputs (1,439 Git-bound, ten reused SDK-bound). `node-1793347225049018031` and `compiler-fixtures-1793347225048910930` accepted that exact same tree. The final Node source oracle passed 13 actual-source DTO/wire cases. The Rust run passed three normal reader tests, two ignored private-service suites, reader strict checks, the minimal profile, the Mongo/Redis profile, and all-feature strict Clippy.

Parent review caught that fresh event-version comparison initially used JavaScript string ordering incorrectly before the Redis Lua comparison. The final native reader now applies JavaScript UTF-16 ordering at that earlier boundary. Final case 13 specifically covers an astral/BMP pair whose UTF-16 order differs from Redis Lua's UTF-8 byte order. The 12-case initial corpus and two byte-identical 13-case corpora remain in the evidence archive. Earlier compile and Clippy failures are also retained; they were corrected before the accepted run.

The capped compiler/fixtures phase took 145.477 seconds at 6 CPUs, 4 GiB memory with no swap, 256 PIDs, and two Cargo jobs; minimum available memory was 8,793,755,648 bytes, and the private Cargo cache peaked at 8,296,251,392 bytes. The final readback reports 18 production records unchanged and zero task-owned resources. Full run receipts, logs, source snapshot, reference corpora, source captures, helper scripts, and the raw/stored hash index are in [the evidence package](evidence/2026-10-30-ai-credit-reader/README.md).

## Remaining limits

- No deterministic reader-specific cached-read raw-snapshot race test is claimed. Prior fence evidence is separate; it was not rerun as reader regression evidence.
- The suites do not establish arbitrary Mongo schema-invalid values, non-UTF-8 Redis bytes, or unrestricted JavaScript string inputs. Reader channel/customer inputs are UTF-8.
- Provider header and body timeout cases do not prove EOF/reset behavior or cancellation during an uncertain Redis mutation. They do not establish credential isolation across redirects; generic Polar transport behavior remains a separate dependency.
- The optional overall deadline can interrupt an operation whose mutation outcome is unknown. The reader does not retry such a write.
- The committed billing source capture is not an immutable source binding for the accepted API image. Semantic-worker caller adoption and cache-mode usage accounting remain open.

The [migration note](ai-credit-reader.md) records matrix status and dependency boundaries. The billing source row remains partial; no benchmark, runtime-gain, caller-adoption, deployment, or full-migration claim is made.

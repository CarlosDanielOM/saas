# AI-credit reader — 2026-10-30

## Scope and status

The Rust crate now contains a verified, concrete, opt-in reader for the `getAiCredits` path in the accepted `billing.ts` source capture. This closes the bounded adapter gap identified in the [semantic-worker billing discovery](billing-native-gap-discovery-2026-10-30.md). It does not complete `billing.ts`, the semantic moderation worker, or the complete credit and usage-ingestion dependency chain. Local coverage is partial; caller adoption, TypeScript retirement, API image source equivalence, and deployment remain unproven. Total migration completion remains **null**. No benchmark or runtime-gain claim is made.

Implementation and tests are in `dimabot/src/utils/ai_credit_reader.rs`, `dimabot/tests/ai_credit_reader.rs`, `dimabot/tests/ai_credit_reader_protocol.rs`, and `dimabot/tests/fixtures/ai_credit_reader_reference.cjs`. The feature composes the existing credit projection, plan-cache fence, pooled Mongo and Redis clients, and pooled Polar HTTP client. It is not registered for application callers. The evidence package binds the tested source to code commit `c6ac8d0fa4a68e98bc2dd3c8466bce0d1f6540c1` and frozen source tree SHA-256 `d674dd63d827f4b9c6ca0e6ce8a754f1cd5b6f05b2a4c1ac87fcf57f977e4b18`.

## Reuse and remaining source dependencies

The earlier source review found reusable native projection and fence behavior but no concrete reader. That gap is now covered: the reader performs the current Twitch owner and optional exact Polar customer lookup, checks the plan event version, handles cache snapshots and exhaustion flags, performs bounded customer-state retrieval, decodes the selected active meter, and applies source fallback and verification rules. It uses existing pooled adapters rather than opening independent connections.

The source oracle binds to `billing.ts` captured from commit `55bd0bb79a6edc441ec9f5104c13576fca0324b3` (SHA-256 `2bcb086c6ef1c668a392a983bfbb6107f9555c63c6b903e1aebf3f59c9e1791f`) and `plan_cache_fence.ts` (SHA-256 `2639f0021342fba252e7c9ef331dc42cdb9cc4eb19b5e063eda7d167ac7787ee`). These committed-source captures are not proof of exact source bytes inside the accepted API image. The reader also continues to depend on the native Mongo, Redis, projection/fence, and Polar transport adapters it calls; source-equivalent complete checkout, billing, and Polar lifecycle APIs are still absent.

The neighboring semantic-worker dependency remains open: cache-mode `ingestPolarSHEvent` still needs the separate Polar-event list, legacy string-to-list migration, lock lifecycle, lossless accounting context, and orchestration with credit projection, the receipt producer, and PostHog. Its source-image binding is likewise unresolved. This work does not imply that usage ingestion or lossless context has been verified.

## Verification evidence

The final Node source-oracle run `node-1793347225049018031` and isolated compiler-fixtures run `compiler-fixtures-1793347225048910930` used the same frozen source tree. The final oracle contains 13 actual-source DTO/wire cases. The first generated corpus had 12; parent review identified an ordering mismatch in fresh plan-version comparisons, and the final 13th case exercises astral/BMP identifiers whose JavaScript UTF-16 ordering differs from the existing Redis Lua UTF-8 byte ordering. Fresh-version comparison now follows JavaScript ordering before the Lua fence comparison. All three Node corpora, including two byte-identical 13-case outputs, are retained.

The capped compiler-fixtures phase passed three normal reader tests, two ignored private-service suites, the reader feature strict checks, minimal-profile check, Mongo/Redis-profile check, and all-feature strict Clippy. The final phase took 145.477 seconds under 6 CPUs, 4 GiB memory with swap disabled, 256 PIDs, and two Cargo jobs; minimum available memory was 8,793,755,648 bytes and the private Cargo cache peaked at 8,296,251,392 bytes. The compiler receipt reports production unchanged. Earlier attempts remain preserved, including the Redis borrowed-argument compilation failure and three strict-Clippy findings fixed before the accepted source. Cache maintenance removed only eight obsolete task-owned debug test binaries (267,366,400 allocated bytes); it did not change source, dependencies, cache quota, or shared cache. Counts refer only to the actual reader scopes recorded in the receipts, not to earlier moderation schema or Mongoose replays.

The evidence package retains every task receipt and log in run interval `1793346593981991577`–`1793347225049018031`, all three oracle corpora, parent final facts, final production readback, source bindings and frozen inputs, source captures, and reproduction helpers. Its [hash index](evidence/2026-10-30-ai-credit-reader/artifact-sha256.json) reports raw and stored SHA-256/byte counts. See the [evidence README](evidence/2026-10-30-ai-credit-reader/README.md) for package scope and verification method. The final readback records 18 production records unchanged and zero remaining task-owned resources.

## Contract limits

- The semantic-worker source supplies a 750 ms provider signal; the native reader accepts an explicit provider duration. An explicitly selected overall-operation deadline is separate; no overall timeout is imposed by default.
- The reader uses UTF-8 Rust channel/customer inputs and schema-conforming Mongo values. General JavaScript UTF-16 identifiers and non-UTF-8 Redis bytes are outside its input contract.
- The source review and reader suites document unproven races/faults, including an atomic cached-read raw-snapshot race, uncertain Redis write outcomes, provider EOF/reset, and cross-origin credential behavior. Generic Polar transport tests are not a reader-specific redirect/token proof.
- The accepted reader suite does not prove cache-mode usage ingestion, full lossless accounting-context propagation, the whole semantic worker, or every `billing.ts` export/caller.
- No caller was switched, no TypeScript source was retired, no service was deployed, and no push was performed.

## Matrix status

The [`src/utils/billing.ts` matrix row](dimabot-dependency-matrix-2026-10-28.json) now includes this reader while preserving the previous projection evidence and open billing exports. It remains **partial**, with 17 complete and 21 partial source rows; total completion remains null. See the [matrix summary](dimabot-dependency-matrix-2026-10-28.md).

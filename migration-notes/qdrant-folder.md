# Qdrant utility folder port

**Status as of 2026-10-23: final source-backed library validation passed.** This is a library-first port of `dimabot/src/utils/qdrant/`. TypeScript remains the active runtime; no TypeScript caller has been adopted by Rust and no rollout is in scope. The Qdrant Cargo feature and native client remain opt-in foundations; verification does not imply runtime adoption.

## Scope and source-to-Rust coverage

The port covers the eleven source files in the folder, preserving their logical responsibilities without prescribing exact Rust API names:

| TypeScript source | Logical coverage |
| --- | --- |
| [`qdrant_point_id.ts`](../dimabot/src/utils/qdrant/qdrant_point_id.ts) | Stable MD5-derived numeric point ID and memory/channel payload ownership check. |
| [`message.qdrant.collection.ts`](../dimabot/src/utils/qdrant/collections/twitch/message.qdrant.collection.ts), [`memory.qdrant.collection.ts`](../dimabot/src/utils/qdrant/collections/twitch/memory.qdrant.collection.ts) | Chat and memory schemas, vector settings, quantization, and payload indexes. |
| [`create.collecion.ts`](../dimabot/src/utils/qdrant/functions/collections/create.collecion.ts), [`start_up.qdrant.ts`](../dimabot/src/utils/qdrant/start_up.qdrant.ts) | Collection creation, index creation, per-collection outcomes, and aggregate startup result. |
| [`store_chat_log.qdrant.ts`](../dimabot/src/utils/qdrant/functions/chat_logs/store_chat_log.qdrant.ts) | Direct single-message embedding/upsert plus the batched-queue handoff contract. The batcher itself is outside this folder. |
| [`retrieve_chat_context.qdrant.ts`](../dimabot/src/utils/qdrant/functions/chat_logs/retrieve_chat_context.qdrant.ts) | Tier limits; channel-scoped semantic search with high/fallback score passes, dedupe, score/time ordering, and metric/log events. |
| [`retrieve_chat_window.qdrant.ts`](../dimabot/src/utils/qdrant/functions/chat_logs/retrieve_chat_window.qdrant.ts) | Bounded paged scroll, payload validation, channel/time filtering, chronological ordering, and result cap. |
| [`retrieve_memory_context.qdrant.ts`](../dimabot/src/utils/qdrant/functions/memory/retrieve_memory_context.qdrant.ts) | Query embedding, confirmed-memory and subject-scope filters, explicit/passive selection, relevance filtering, and score/update-time ordering. |
| [`sync_memory.qdrant.ts`](../dimabot/src/utils/qdrant/functions/memory/sync_memory.qdrant.ts) | Ownership-checked memory upsert, optional-ID guarded point deletion, and channel-wide deletion. |
| [`functions/index.ts`](../dimabot/src/utils/qdrant/functions/index.ts) | Existing narrow barrel export for chat-log storage. |

### Reuse and boundaries

Reuse the existing `qdrant` Cargo feature and official `qdrant-client` dependency, pinned to the production server's 1.17 minor and built without crate defaults. The existing [`qdrant.rs`](../dima-rust/src/utils/qdrant.rs) connector supplies a lazy gRPC client using `QDRANT_HOST`, `QDRANT_API_KEY`, and `QDRANT_GRPC_PORT` (default 6334); it lists collections before caching a successful connection. Rust uses gRPC while the current TypeScript connector uses REST via `QDRANT_PORT` (6333). Existing connection/CRUD validation is separate from this folder's parity and behavior checks.

The utility boundary remains caller supplied: an embedding provider requests `lfm2.5-embedding-350m` with query/document kind; a language detector supplies the TypeScript language-detection behavior where needed; a chat embedding queue receives queued messages; and an optional context hook receives semantic-memory metrics and debug/error events. These are integration interfaces, not ports of the LFM embedding service, global language detector, `EmbeddingBatcher`, or bot metrics/logger. In particular, the TypeScript batcher's size 500, 350 ms cadence, and retry policy remain outside this folder's storage handoff.

The Rust implementation is organized into backend, types, collection, parity, chat, and memory modules. The backend owns native gRPC request translation; types define data and injected provider/context boundaries; collection code owns schemas and startup outcomes; chat and memory code own their respective operations. These modules do not install runtime adapters or register production callers.

## Caller map and adoption still pending

- `server/index.ts` calls Qdrant startup. The two schemas are collected by `config/qdrant/collections.ts` and the collection-options interface lives outside the folder.
- `handlers/message.handler.ts` enqueues chat messages through the batched storage function. `classes/embedding_batcher.class.ts` later embeds and writes points itself, using the folder's point-ID helper; that batching/runtime path is not brought into Rust by this port. The deprecated direct writer is also referenced by `scripts/smoke_test_lfm2_embeddings.script.ts`.
- `utils/ai/openrouter/ai.ts` calls semantic chat retrieval, tier limits, and memory-context retrieval; `utils/ai/tools/recall_memory.tool.ts` also calls memory-context retrieval.
- `utils/ai/memory/memory.service.ts` calls memory upsert/delete and point-ID generation. `utils/account_deletion.ts` calls channel-wide memory deletion.
- `utils/ai/memory/stream_summary_context.ts` has its own Qdrant chat-window scroll implementation and does not call the folder's `retrieveChannelChatWindow`; the folder function currently has no in-tree caller. Reusing it later is separate runtime-adoption work.
- The folder barrel is not the caller path used by these imports; callers import concrete modules. `scripts/test_ai_memory_context.script.ts` exercises point-ID/ownership behavior.

Runtime caller adoption is a distinct backlog from completing the library folder port. Until explicitly migrated later, all listed runtime callers remain on their existing TypeScript paths.

Qdrant memory search returns candidate records. It does not validate those candidates against authoritative Mongo memory documents, and this library has no validator wrapper. Any future runtime caller must perform that authoritative Mongo validation as part of its own adoption contract.

## Compatibility details to preserve

- The JS client's `createPayloadIndex` drops the source's top-level `tokenizer: 'multilingual'` sibling. The effective bare-text index behavior is Qdrant's default `word` tokenizer. The disposable-service checks verified the bare-text schema and nine behavior queries across the three text indexes, covering case folding, punctuation word boundaries, and prefix rejection. Preserve that effective behavior; do not claim multilingual tokenization or silently change the installed index semantics.
- An already existing collection returns an error result with status 409. Startup still returns aggregate success when an individual collection result is an error; this is not an index-repair or schema-reconciliation path. Do not imply that startup repairs indexes on existing collections.
- Memory retrieval sorts by score, then `updated_at` descending on ties. Passive retrieval uses the existing lexical distinctive-word overlap helper for weaker candidate scores (with a strong-score bypass); there is no time-decay ranking.
- Memory deletion only performs the ownership guard when the optional memory ID is supplied. Keep this TypeScript limitation for parity; the read-then-delete sequence does not provide an atomic ownership guarantee.
- With pinned `qdrant-client` 1.17, passing a plain `String` filter value containing whitespace converts it to Qdrant `Text`, which does not preserve exact keyword matching for channel IDs containing whitespace. All four channel-filter paths explicitly use `Keyword`. Four scripted tests cover space, tab, and NBSP IDs (12 combinations); the disposable service fixture included a spaced target and neighbor and verified retrieval/deletion isolation.
- Chat scroll retrieval caps fetches at 1,440 points and 12 pages of at most 120, then filters and sorts the accepted payloads. Semantic chat retrieval queries up to three times the requested limit per pass, deduplicates by exact message text, and tries the fallback threshold only when the high pass keeps no items.

## Final verification record — 2026-10-23

The final source fixture check `node dima-rust/tests/fixtures/qdrant_folder_reference.mjs --check` passed all 90 TypeScript reference cases; source hashes cover the eleven Qdrant folder files plus the external `utils/ai/memory/memory_relevance.ts` helper. Final combined Rust tests passed 22 Qdrant API executions and independent Qdrant checks added 22 more executions, alongside six Qdrant library unit executions. These are repeated executions across configurations, not distinct-test totals. The combined no-default/independent/combined feature checks, formatting, and Clippy also passed; see [policy-queue-token-utils.md](policy-queue-token-utils.md) for the consolidated final audit, frozen baseline, resource limits, and cleanup record.

The disposable Qdrant 1.17 service scenario passed. It verified two 1,024-dimensional cosine/on-disk collections, Int8 quantization, all 21 source payload indexes, startup and existing-collection 409 outcomes, direct chat write and queue handoff, scroll and semantic retrieval, memory ownership/upsert/retrieval/deletion/idempotence, and spaced-channel isolation. The service had nine text-index behavior queries covering case folding, punctuation word boundaries, and rejection of prefixes. Score tests confirmed strict service thresholds at `.69` and `.75` and successful `.70` and `.76` paths; inclusive postfilters preserve the source behavior. Exact service fixture setup and outcomes are in the prepared final handoff and `fixtures-fixtures.log`.

| Check | Required evidence | Status |
| --- | --- | --- |
| Source fixture check | `node dima-rust/tests/fixtures/qdrant_folder_reference.mjs --check`; 90 cases, hashes cover 11 Qdrant files plus `memory_relevance.ts`. | Passed; source oracle |
| Rust parity and quality | Feature checks, formatting, Clippy, API and unit tests in the capped task-owned workflow. | Passed; 28 independent Qdrant executions, with repeated API coverage also in the combined 162 executions |
| Disposable Qdrant behavior | Schemas/indexes, startup outcomes, chat and memory operations, thresholds and failures against disposable Qdrant 1.17 data. | Passed; fixture resources removed |
| Runtime adoption / rollout | Not part of this folder port. TypeScript callers remain current runtime. | Out of scope; no rollout or production caller adoption |

A later caller migration needs its own scoped adoption and runtime verification. It must preserve authoritative Mongo validation for memory search results, which remain candidates rather than validated records; mixed runtime behavior and any caller-specific batching/adapters also need review.

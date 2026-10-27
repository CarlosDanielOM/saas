# Rust Migration Completeness Audit

Source review: 2026-10-27. This audit covers the **41 reviewed TypeScript/Rust filename pairs** in scope (including five TypeScript files subsequently retired), with paths relative to `dimabot/src`. The per-file ratings describe implementation of each file's own features and its required dependency chain. They do not estimate completion of the entire dimabot migration. Ratings are source-review estimates, not a formula or runtime-verification result. The repository definition of 100% requires every feature and accepted improvement plus all required direct and transitive dependencies in Rust, with no reliance on unmigrated TypeScript. See [root migration guidance](../AGENTS.md#active-rust-migration-rules--2026-10-27) and [Rust migration completeness](../dimabot/RUST_AGENTS.md#migration-completeness).

Three GPT-6.1 Terra agents audited independent scopes covering all 41 pairs; a fourth challenged the prior 100% claims, followed by lead source review. See the [review record](../orchestrator-notes/2026-10-27-terra-migration-audit.md).

The reconciled audit assigns **5 files to 100%, 21 to 75%, 8 to 50%, and 7 to 25%**. These are coarse overall estimates, not measurements of lines of code or a percentage of the whole backend. Local feature coverage can be higher than the overall band when a required dependency is missing. A file may have complete local logic while a required dependency remains incomplete; report those separately and name the blocking dependency. A host boundary, trait, or mock is not a complete application feature without its required app-specific adapter. Required application services passed through callbacks or traits remain part of the dependency chain; an interface alone does not complete them. Native crates and standard-library replacements count; npm internals do not need porting. Deployment and caller adoption are tracked separately and are not requirements for 100% dependency completeness.

## 100% — local features and required dependencies complete

The five TypeScript files below were deleted from this migration checkout on 2026-10-27 with explicit user authorization, including permission for remaining TypeScript callers/builds to break. Their Rust implementations and frozen parity fixtures remain unchanged. The deleted source is available in local Git history at commit `0e5a102a`; source-backed Node oracle regeneration needs those historical inputs, while Rust tests consume the retained frozen fixtures. No production cutover was performed.

| File pair | Local coverage and overall basis |
|---|---|
| `utils/ast_blocks/types.ts` (retired) · [`types.rs`](../dimabot/src/utils/ast_blocks/types.rs) | Equivalent types, storage prefixes and error representation cover the accepted current version-1 wire contract; arbitrary future versions are not claimed. |
| `utils/ast_blocks/validate.ts` (retired) · [`validate.rs`](../dimabot/src/utils/ast_blocks/validate.rs) | Public `read_block_root` validates the block tree; the accepted 7,500-node limit replaces the TypeScript 4,000-node limit. |
| `utils/command_cooldown.ts` (retired) · [`command_cooldown.rs`](../dimabot/src/utils/command_cooldown.rs) | The six-line pure helper is complete. Separate [`command_cooldown_write.ts`](../dimabot/src/utils/command_cooldown_write.ts) storage integration is outside this exact pair and remains a distinct adapter concern. |
| `utils/plan_cache_fence.ts` (retired) · [`plan_cache_fence.rs`](../dimabot/src/utils/plan_cache_fence.rs) | Three Lua exports and version/key helpers have native equivalents and a concrete Redis adapter. The accepted utility documents bounds and invalid-date handling; billing producers are separate callers. |
| `utils/timer_policy.ts` (retired) · [`timer_policy.rs`](../dimabot/src/utils/timer_policy.rs) | Pure timer policy behavior and types are complete. |

## 75% — local behavior mostly present; gaps remain

| File pair | Local coverage and overall basis |
|---|---|
| [`utils/ast_blocks/from_ast.ts`](../dimabot/src/utils/ast_blocks/from_ast.ts) · [`from_ast.rs`](../dimabot/src/utils/ast_blocks/from_ast.rs) | The text-import pipeline contains conversion logic, but direct `astToBlock` for an AST and the prefix-based `idMaker` are not exposed as standalone native operations. |
| [`utils/ast_blocks/normalize.ts`](../dimabot/src/utils/ast_blocks/normalize.ts) · [`normalize.rs`](../dimabot/src/utils/ast_blocks/normalize.rs) | `normalize_root` and `normalize_value` are publicly re-exported. Approved structural equality replaces comparison internally, but the exported canonical `blockShape` string operation is absent. |
| [`utils/ast_blocks/to_source.ts`](../dimabot/src/utils/ast_blocks/to_source.ts) · [`to_source.rs`](../dimabot/src/utils/ast_blocks/to_source.rs) | The validated, normalized compile pipeline uses the writer, but standalone `rootToSource`, `topLevel`, `escapeChatText`, and `literal` operations are not publicly available. |
| [`utils/crypto.ts`](../dimabot/src/utils/crypto.ts) · [`crypto.rs`](../dimabot/src/utils/crypto.rs) | The native AES credential codec is present with explicit key construction; the TypeScript module’s `SECRET_KEY` environment lookup and initialization behavior lack a Rust facade. |
| [`utils/opentelemetry_posthog.ts`](../dimabot/src/utils/opentelemetry_posthog.ts) · [`opentelemetry_posthog.rs`](../dimabot/src/utils/opentelemetry_posthog.rs) | The native batch OTLP exporter/provider exists; the TypeScript runtime-labelled startup diagnostic and its runtime argument are absent. Starting the application is a caller responsibility. |
| [`utils/email/email-activation-token.ts`](../dimabot/src/utils/email/email-activation-token.ts) · [`email-activation-token.rs`](../dimabot/src/utils/email/email-activation-token.rs) | Signing and verification exist. Rust requires `iat` when verifying, while TypeScript accepts a valid token without it; the documented `exp` and fallback-secret differences are separate. |
| [`utils/keywords.ts`](../dimabot/src/utils/keywords.ts) · [`keywords.rs`](../dimabot/src/utils/keywords.rs) | The required working keyword path lacks a concrete Rust MongoDB/Redis/PubSub adapter. Rust contains generic ports of the loading, body-read, refresh/invalidation, change-event handling, and count-write logic from [`keyword_cache.ts`](../dimabot/src/utils/keyword_cache.ts), but `KeywordStorage` has only a `MemoryStorage` implementation under `cfg(test)` and no concrete storage or subscription adapter. The generic interface does not remove this required app-service dependency. Pure matching helpers are locally complete. |
| [`classes/twitch_streamers.class.ts`](../dimabot/src/classes/twitch_streamers.class.ts) · [`twitch_streamers.class.rs`](../dimabot/src/classes/twitch_streamers.class.rs) | Bulk credential hydration is missing from the Rust adapter path. |
| [`utils/ast_blocks/index.ts`](../dimabot/src/utils/ast_blocks/index.ts) · [`index.rs`](../dimabot/src/utils/ast_blocks/index.rs) | The full custom-syntax dependency is not yet available in Rust. |
| [`utils/ast_parser/parser.ts`](../dimabot/src/utils/ast_parser/parser.ts) · [`parser.rs`](../dimabot/src/utils/ast_parser/parser.rs) | AST printing and callback integration are incomplete. |
| [`utils/ast_parser/registry.ts`](../dimabot/src/utils/ast_parser/registry.ts) · [`registry.rs`](../dimabot/src/utils/ast_parser/registry.rs) | Application-specific custom callbacks are missing from the Rust registry. |
| [`utils/ast_parser/tokenizer.ts`](../dimabot/src/utils/ast_parser/tokenizer.ts) · [`tokenizer.rs`](../dimabot/src/utils/ast_parser/tokenizer.rs) | The complete custom-syntax dependency remains incomplete. |
| [`utils/ast_parser/types.ts`](../dimabot/src/utils/ast_parser/types.ts) · [`types.rs`](../dimabot/src/utils/ast_parser/types.rs) | Types are present, but the required custom-syntax/evaluator integration is incomplete. |
| [`utils/cron_jobs_queue.ts`](../dimabot/src/utils/cron_jobs_queue.ts) · [`cron_jobs_queue.rs`](../dimabot/src/utils/cron_jobs_queue.rs) | Queue transport exists, but its clock is a trait without the concrete application adapter and Dragonfly telemetry integration remains missing. |
| [`utils/dashboard_activity.ts`](../dimabot/src/utils/dashboard_activity.ts) · [`dashboard_activity.rs`](../dimabot/src/utils/dashboard_activity.rs) | Local activity logic is present; Mongo/Redis telemetry and schema/index initialization are incomplete. The native emote/app-token adapter exists and is not a gap. |
| [`utils/dashboard_insights.ts`](../dimabot/src/utils/dashboard_insights.ts) · [`dashboard_insights.rs`](../dimabot/src/utils/dashboard_insights.rs) | Required queue/helper integration remains incomplete. |
| [`utils/follow_defense_baseline.ts`](../dimabot/src/utils/follow_defense_baseline.ts) · [`follow_defense_baseline.rs`](../dimabot/src/utils/follow_defense_baseline.rs) | Cached reads, stale handling, and request-helper integration remain. |
| [`utils/logger.ts`](../dimabot/src/utils/logger.ts) · [`logger.rs`](../dimabot/src/utils/logger.rs) | Logging core and adapters exist, but generic metadata export still needs the application observability-inbox adapter. |
| [`utils/s3.ts`](../dimabot/src/utils/s3.ts) · [`s3.rs`](../dimabot/src/utils/s3.rs) | Upload/delete error logging is missing; no accepted removal of this behavior is documented. |
| [`utils/tokens.ts`](../dimabot/src/utils/tokens.ts) · [`tokens.rs`](../dimabot/src/utils/tokens.rs) | Bulk refresh, debugging, and logging integration remain. |
| [`utils/databases/qdrant.database.ts`](../dimabot/src/utils/databases/qdrant.database.ts) · [`qdrant.database.rs`](../dimabot/src/utils/databases/qdrant.database.rs) | Protocol/configuration parity and diagnostics remain incomplete. |

## 50% — substantial behavior or dependencies remain

| File pair | Local coverage and overall basis |
|---|---|
| [`utils/ast_parser/evaluator.ts`](../dimabot/src/utils/ast_parser/evaluator.ts) · [`evaluator.rs`](../dimabot/src/utils/ast_parser/evaluator.rs) | The evaluator core exists, but concrete host effects, cache and timer adapters needed for application execution remain incomplete. |
| [`utils/permissions/index.ts`](../dimabot/src/utils/permissions/index.ts) · [`index.rs`](../dimabot/src/utils/permissions/index.rs) | Partial permission logic exists; role cache, identity handling and error limiting remain incomplete. |
| [`utils/databases/mongodb.database.ts`](../dimabot/src/utils/databases/mongodb.database.ts) · [`mongodb.database.rs`](../dimabot/src/utils/databases/mongodb.database.rs) | A native MongoDB client exists; most TypeScript instrumentation and connection diagnostics are missing. |
| [`utils/databases/dragonfly.database.ts`](../dimabot/src/utils/databases/dragonfly.database.ts) · [`dragonfly.database.rs`](../dimabot/src/utils/databases/dragonfly.database.rs) | A native Redis client exists; most TypeScript instrumentation and connection diagnostics are missing. |
| [`utils/raid_analytics.ts`](../dimabot/src/utils/raid_analytics.ts) · [`raid_analytics.rs`](../dimabot/src/utils/raid_analytics.rs) | A native summary projector exists, but raid-event ingestion (`applyRaidAnalyticsEvent`) and producer-side queueing (`queueRaidSummary`) remain missing. |
| [`utils/email/email.service.ts`](../dimabot/src/utils/email/email.service.ts) · [`email.service.rs`](../dimabot/src/utils/email/email.service.rs) | Email rendering and templates remain incomplete. |
| [`utils/stream_activity.ts`](../dimabot/src/utils/stream_activity.ts) · [`stream_activity.rs`](../dimabot/src/utils/stream_activity.rs) | Ingestion, emote processing, and API reads remain incomplete. |
| [`utils/raid_sessions.ts`](../dimabot/src/utils/raid_sessions.ts) · [`raid_sessions.rs`](../dimabot/src/utils/raid_sessions.rs) | Session creation, raid markers, and request producer integration remain. |

## 25% — primary application behavior remains

| File pair | Local coverage and overall basis |
|---|---|
| [`workers/cron.index.ts`](../dimabot/src/workers/cron.index.ts) · [`cron.index.rs`](../dimabot/src/workers/cron.index.rs) | The Rust index supervises seven native workers; it does not replace the TypeScript 19-definition registry, PID 1 coordination or bridge chain. |
| [`server/websocket.ts`](../dimabot/src/server/websocket.ts) · [`websocket.rs`](../dimabot/src/server/websocket.rs) | Application-specific socket handlers and recovery behavior remain. |
| [`utils/ai_usage_receipts.ts`](../dimabot/src/utils/ai_usage_receipts.ts) · [`ai_usage_receipts.rs`](../dimabot/src/utils/ai_usage_receipts.rs) | A native consumer exists, but billing periods, timezone and pacing, Polar fetch/pagination and read API behavior remain mostly TypeScript. |
| [`utils/domain_events.ts`](../dimabot/src/utils/domain_events.ts) · [`domain_events.rs`](../dimabot/src/utils/domain_events.rs) | Application journal integration and wakeup behavior remain incomplete. |
| [`utils/eventsub.ts`](../dimabot/src/utils/eventsub.ts) · [`eventsub.rs`](../dimabot/src/utils/eventsub.rs) | Registry, create/list/delete operations, and migration behavior remain. |
| [`utils/polarsh.ts`](../dimabot/src/utils/polarsh.ts) · [`polarsh.rs`](../dimabot/src/utils/polarsh.rs) | Usage/grant integration and batching remain; this row does not rate webhooks. |
| [`utils/posthog_events.ts`](../dimabot/src/utils/posthog_events.ts) · [`posthog_events.rs`](../dimabot/src/utils/posthog_events.rs) | Business event capture builders remain incomplete. |

## Evidence and boundaries for the five 100% rows

- **Block types:** Retired `types.ts` defined the block model and version constant; Rust provides equivalent kinds, storage prefixes and errors in [`types.rs`](../dimabot/src/utils/ast_blocks/types.rs). Both [`storedBlocks`](../dimabot/src/utils/ast_blocks/index.ts) and [`stored_blocks`](../dimabot/src/utils/ast_blocks/index.rs) produce version 1. The [accepted block contract](ast-blocks.md) is the current version-1 model, not support for arbitrary future versions.
- **Validation:** Retired `readBlockRoot` has a public native [`read_block_root`](../dimabot/src/utils/ast_blocks/index.rs) backed by the Rust reader. The [block migration record](ast-blocks.md) documents the approved 7,500-node limit, replacing 4,000, and its existing validation evidence.
- **Cooldown:** the source’s three tier outcomes are implemented by [`minimum_command_cooldown`](../dimabot/src/utils/command_cooldown.rs); the separate write path is not a dependency of this pure calculation.
- **Plan fence:** Retired `plan_cache_fence.ts` imported no application services; Rust supplies its three Lua bodies, version and key helpers and a concrete Redis adapter. The [accepted fence record](plan-cache-fence.md) documents exact-script parity, isolated Dragonfly evidence, limits and intentional rejection of invalid dates. Billing producers call this utility and are assessed separately; their unfinished migration does not make them dependencies of its functions.
- **Timer policy:** the Rust functions implement the source’s conversion, heartbeat, parsing and plan validation using native types and JavaScript-compatible trimming. Timer storage and scheduling are callers, not dependencies of these pure rules.

A documented and accepted improvement can replace a source behavior within its stated scope; it is not blanket permission to omit other exported features. In particular, the approved AST structural comparison does not itself provide the canonical `blockShape` string, and the accepted pipeline does not expose the standalone conversion and writer operations. Similarly, the accepted crypto library explicitly takes a key but does not supply the TypeScript environment-reading facade. The [utility record](policy-queue-token-utils.md) describes that construction boundary; it does not establish that the original configuration feature was migrated.

## Activation-token counterexamples

The lead ran two isolated Node fixture checks against the actual TypeScript verifier with a fixture secret, only `jsonwebtoken` allowed as an import, and no network. Both tokens were validly signed with that secret:

| Claims | TypeScript verifier | Rust source behavior |
|---|---|---|
| `sub`, `login`, no `iat` or `exp` | Accepts | `ActivationClaims` requires both fields, so deserialization rejects it. |
| `sub`, `login`, future `exp`, no `iat` | Accepts | Required `iat` causes deserialization to reject it. |

See the [TypeScript verifier](../dimabot/src/utils/email/email-activation-token.ts) and [Rust claims and verifier](../dimabot/src/utils/email/email-activation-token.rs). The [foundation record](ts-util-foundations.md) explicitly documents the stricter `exp` requirement and absence of the fallback secret; it does not document a required `iat` as an accepted change. The Rust outcome above is a source inference, not a fresh Rust binary test.

## Scope and limitations

The audit reviews 41 exact filename pairs and their required feature dependencies, not the entire backend. Required application services remain dependencies when passed through callbacks or traits: the keyword loader, for example, still needs its concrete MongoDB/Redis/PubSub adapter. Supplying ordinary data or configuration to a pure function does not make every upstream producer a dependency. Deployment and caller adoption are separate from dependency completeness.

This is a source audit plus the two isolated Node fixture checks above. No fresh Cargo build, Rust runtime test, production inspection, deployment or caller rewiring was performed for this audit. Existing historical verification is cited as such and does not prove every input or integration path. No application feature was implemented by this audit. The earlier 11-at-100 and 18-at-100 counts are superseded by the reconciled ratings here.

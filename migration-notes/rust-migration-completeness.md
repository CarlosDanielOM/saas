# Rust Migration Completeness Audit

Source review: 2026-10-27. This audit covers the **41 exact TypeScript/Rust filename pairs** in scope, with paths relative to `dimabot/src`. The per-file ratings describe implementation of each file's own features and its required dependency chain. They do not estimate completion of the entire dimabot migration. Ratings are source-review estimates, not a formula or runtime-verification result. The repository definition of 100% requires every feature and accepted improvement plus all required direct and transitive dependencies in Rust, with no reliance on unmigrated TypeScript. See [root migration guidance](../AGENTS.md#active-rust-migration-rules--2026-10-27) and [Rust migration completeness](../dimabot/RUST_AGENTS.md#migration-completeness).

The audit found **11 files at 100%, 20 at 75%, 4 at 50%, and 6 at 25%**. A file may have complete local logic while a required dependency remains incomplete; report those separately and name the blocking dependency. A host boundary, trait, or mock is not a complete application feature without its required app-specific adapter. Required application services passed through callbacks or traits remain part of the dependency chain; an interface alone does not complete them. Native crates and standard-library replacements count; npm internals do not need porting. Deployment and caller adoption are tracked separately and are not requirements for 100% dependency completeness.

## 100% — local feature and required dependencies complete

| File pair | Audit note |
|---|---|
| [`utils/ast_blocks/from_ast.ts`](../dimabot/src/utils/ast_blocks/from_ast.ts) · [`from_ast.rs`](../dimabot/src/utils/ast_blocks/from_ast.rs) | AST-to-block conversion and required type handling are implemented. |
| [`utils/ast_blocks/normalize.ts`](../dimabot/src/utils/ast_blocks/normalize.ts) · [`normalize.rs`](../dimabot/src/utils/ast_blocks/normalize.rs) | Block normalization behavior and required types are implemented. |
| [`utils/ast_blocks/to_source.ts`](../dimabot/src/utils/ast_blocks/to_source.ts) · [`to_source.rs`](../dimabot/src/utils/ast_blocks/to_source.rs) | Source generation for the supported block model is implemented. |
| [`utils/ast_blocks/types.ts`](../dimabot/src/utils/ast_blocks/types.ts) · [`types.rs`](../dimabot/src/utils/ast_blocks/types.rs) | Equivalent Rust types cover the TypeScript type contract. |
| [`utils/ast_blocks/validate.ts`](../dimabot/src/utils/ast_blocks/validate.ts) · [`validate.rs`](../dimabot/src/utils/ast_blocks/validate.rs) | Block validation behavior and required type dependencies are implemented. |
| [`utils/command_cooldown.ts`](../dimabot/src/utils/command_cooldown.ts) · [`command_cooldown.rs`](../dimabot/src/utils/command_cooldown.rs) | The six-line pure helper is complete. Separate [`command_cooldown_write.ts`](../dimabot/src/utils/command_cooldown_write.ts) storage integration is outside this exact pair and remains a distinct adapter concern. |
| [`utils/crypto.ts`](../dimabot/src/utils/crypto.ts) · [`crypto.rs`](../dimabot/src/utils/crypto.rs) | Required cryptographic behavior is implemented using native Rust dependencies. |
| [`utils/opentelemetry_posthog.ts`](../dimabot/src/utils/opentelemetry_posthog.ts) · [`opentelemetry_posthog.rs`](../dimabot/src/utils/opentelemetry_posthog.rs) | Required telemetry/PostHog behavior is implemented with native dependencies. |
| [`utils/plan_cache_fence.ts`](../dimabot/src/utils/plan_cache_fence.ts) · [`plan_cache_fence.rs`](../dimabot/src/utils/plan_cache_fence.rs) | Cache-fencing behavior and its required dependencies are implemented. |
| [`utils/timer_policy.ts`](../dimabot/src/utils/timer_policy.ts) · [`timer_policy.rs`](../dimabot/src/utils/timer_policy.rs) | Pure timer policy behavior and types are complete. |
| [`utils/email/email-activation-token.ts`](../dimabot/src/utils/email/email-activation-token.ts) · [`email-activation-token.rs`](../dimabot/src/utils/email/email-activation-token.rs) | Token generation/validation behavior and required crypto dependency are implemented. |

## 75% — local behavior mostly present; required dependency gaps remain

| File pair | Blocking dependency or remaining gap |
|---|---|
| [`utils/keywords.ts`](../dimabot/src/utils/keywords.ts) · [`keywords.rs`](../dimabot/src/utils/keywords.rs) | The required working keyword path lacks a concrete Rust MongoDB/Redis/PubSub adapter. Rust contains generic ports of the loading, body-read, refresh/invalidation, change-event handling, and count-write logic from [`keyword_cache.ts`](../dimabot/src/utils/keyword_cache.ts), but `KeywordStorage` has only a `MemoryStorage` implementation under `cfg(test)` and no concrete storage or subscription adapter. The generic interface does not remove this required app-service dependency. Pure matching helpers are locally complete. |
| [`classes/twitch_streamers.class.ts`](../dimabot/src/classes/twitch_streamers.class.ts) · [`twitch_streamers.class.rs`](../dimabot/src/classes/twitch_streamers.class.rs) | Bulk credential hydration is missing from the Rust adapter path. |
| [`utils/ast_blocks/index.ts`](../dimabot/src/utils/ast_blocks/index.ts) · [`index.rs`](../dimabot/src/utils/ast_blocks/index.rs) | The full custom-syntax dependency is not yet available in Rust. |
| [`utils/ast_parser/evaluator.ts`](../dimabot/src/utils/ast_parser/evaluator.ts) · [`evaluator.rs`](../dimabot/src/utils/ast_parser/evaluator.rs) | Concrete effects through the host, cache, and timer adapters remain incomplete. |
| [`utils/ast_parser/parser.ts`](../dimabot/src/utils/ast_parser/parser.ts) · [`parser.rs`](../dimabot/src/utils/ast_parser/parser.rs) | AST printing and callback integration are incomplete. |
| [`utils/ast_parser/registry.ts`](../dimabot/src/utils/ast_parser/registry.ts) · [`registry.rs`](../dimabot/src/utils/ast_parser/registry.rs) | Application-specific custom callbacks are missing from the Rust registry. |
| [`utils/ast_parser/tokenizer.ts`](../dimabot/src/utils/ast_parser/tokenizer.ts) · [`tokenizer.rs`](../dimabot/src/utils/ast_parser/tokenizer.rs) | The complete custom-syntax dependency remains incomplete. |
| [`utils/ast_parser/types.ts`](../dimabot/src/utils/ast_parser/types.ts) · [`types.rs`](../dimabot/src/utils/ast_parser/types.rs) | Types are present, but the required custom-syntax/evaluator integration is incomplete. |
| [`utils/cron_jobs_queue.ts`](../dimabot/src/utils/cron_jobs_queue.ts) · [`cron_jobs_queue.rs`](../dimabot/src/utils/cron_jobs_queue.rs) | Concrete clock adapter and Dragonfly telemetry integration remain. |
| [`utils/dashboard_activity.ts`](../dimabot/src/utils/dashboard_activity.ts) · [`dashboard_activity.rs`](../dimabot/src/utils/dashboard_activity.rs) | Local activity logic is present; Mongo/Redis telemetry and schema/index initialization are incomplete. The native emote/app-token adapter exists and is not a gap. |
| [`utils/dashboard_insights.ts`](../dimabot/src/utils/dashboard_insights.ts) · [`dashboard_insights.rs`](../dimabot/src/utils/dashboard_insights.rs) | Required queue/helper integration remains incomplete. |
| [`utils/follow_defense_baseline.ts`](../dimabot/src/utils/follow_defense_baseline.ts) · [`follow_defense_baseline.rs`](../dimabot/src/utils/follow_defense_baseline.rs) | Cached reads, stale handling, and request-helper integration remain. |
| [`utils/logger.ts`](../dimabot/src/utils/logger.ts) · [`logger.rs`](../dimabot/src/utils/logger.rs) | Generic metadata still needs the application observability-inbox adapter. |
| [`utils/raid_analytics.ts`](../dimabot/src/utils/raid_analytics.ts) · [`raid_analytics.rs`](../dimabot/src/utils/raid_analytics.rs) | Summary production and eventing integration remain incomplete. |
| [`utils/s3.ts`](../dimabot/src/utils/s3.ts) · [`s3.rs`](../dimabot/src/utils/s3.rs) | Upload/delete error logging is missing; no accepted removal of this behavior is documented. |
| [`utils/tokens.ts`](../dimabot/src/utils/tokens.ts) · [`tokens.rs`](../dimabot/src/utils/tokens.rs) | Bulk refresh, debugging, and logging integration remain. |
| [`utils/databases/dragonfly.database.ts`](../dimabot/src/utils/databases/dragonfly.database.ts) · [`dragonfly.database.rs`](../dimabot/src/utils/databases/dragonfly.database.rs) | Required database telemetry and logging integration remain. |
| [`utils/databases/mongodb.database.ts`](../dimabot/src/utils/databases/mongodb.database.ts) · [`mongodb.database.rs`](../dimabot/src/utils/databases/mongodb.database.rs) | Required database telemetry and logging integration remain. |
| [`utils/databases/qdrant.database.ts`](../dimabot/src/utils/databases/qdrant.database.ts) · [`qdrant.database.rs`](../dimabot/src/utils/databases/qdrant.database.rs) | Protocol/configuration parity and diagnostics remain incomplete. |
| [`utils/permissions/index.ts`](../dimabot/src/utils/permissions/index.ts) · [`index.rs`](../dimabot/src/utils/permissions/index.rs) | Role cache, identity handling, and error limiting remain incomplete. |

## 50% — substantial behavior remains in TypeScript

| File pair | Blocking dependency or remaining gap |
|---|---|
| [`utils/email/email.service.ts`](../dimabot/src/utils/email/email.service.ts) · [`email.service.rs`](../dimabot/src/utils/email/email.service.rs) | Email rendering and templates remain incomplete. |
| [`utils/stream_activity.ts`](../dimabot/src/utils/stream_activity.ts) · [`stream_activity.rs`](../dimabot/src/utils/stream_activity.rs) | Ingestion, emote processing, and API reads remain incomplete. |
| [`utils/raid_sessions.ts`](../dimabot/src/utils/raid_sessions.ts) · [`raid_sessions.rs`](../dimabot/src/utils/raid_sessions.rs) | Session creation, raid markers, and request producer integration remain. |
| [`workers/cron.index.ts`](../dimabot/src/workers/cron.index.ts) · [`cron.index.rs`](../dimabot/src/workers/cron.index.rs) | The TypeScript registry (19 workers) and PID 1 coordination remain TypeScript responsibilities; Rust currently supervises its native worker set. |

## 25% — initial Rust implementation; primary application behavior remains

| File pair | Blocking dependency or remaining gap |
|---|---|
| [`server/websocket.ts`](../dimabot/src/server/websocket.ts) · [`websocket.rs`](../dimabot/src/server/websocket.rs) | Application-specific socket handlers and recovery behavior remain. |
| [`utils/ai_usage_receipts.ts`](../dimabot/src/utils/ai_usage_receipts.ts) · [`ai_usage_receipts.rs`](../dimabot/src/utils/ai_usage_receipts.rs) | A consumer exists, but API period handling, timezone/pacing, fetch/pagination, and cache behavior remain mostly TypeScript. |
| [`utils/domain_events.ts`](../dimabot/src/utils/domain_events.ts) · [`domain_events.rs`](../dimabot/src/utils/domain_events.rs) | Application journal integration and wakeup behavior remain incomplete. |
| [`utils/eventsub.ts`](../dimabot/src/utils/eventsub.ts) · [`eventsub.rs`](../dimabot/src/utils/eventsub.rs) | Registry, create/list/delete operations, and migration behavior remain. |
| [`utils/polarsh.ts`](../dimabot/src/utils/polarsh.ts) · [`polarsh.rs`](../dimabot/src/utils/polarsh.rs) | Usage/grant integration and batching remain; this row does not rate webhooks. |
| [`utils/posthog_events.ts`](../dimabot/src/utils/posthog_events.ts) · [`posthog_events.rs`](../dimabot/src/utils/posthog_events.rs) | Business event capture builders remain incomplete. |

## Scope and limitations

The ratings are a 2026-10-27 source audit, not fresh runtime verification. No production behavior, deployment, or caller rewiring was assessed as part of the percentage. An earlier count of 18 fully complete files is superseded by this exact-pair audit: the corrected count is 11 at 100%. This note does not change the stable Rust package/library names or imply that deployment is required to reach 100%.

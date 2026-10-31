# Team 1 lane C handoff

The requested lane implementation and authored tests are complete, subject to integration and verification. No code was compiled, formatted or tested in this authoring-only wave; no deployment or caller adoption is asserted.

## Owned files and line counts

- `dimabot/src/utils/ai/threading/mod.rs`: 7
- `dimabot/src/utils/ai/threading/thread_limits.rs`: 15
- `dimabot/src/utils/ai/threading/thread_types.rs`: 67
- `dimabot/src/utils/ai/threading/thread_store.rs`: 103
- `dimabot/src/utils/ai/threading/thread_router.rs`: 94
- `dimabot/src/schemas/channel_ai_personality.schema.rs`: 145
- `dimabot/tests/ai_threading.rs`: 57
- `dimabot/tests/channel_ai_personality_schema.rs`: 66
- `migration-notes/team1-lane-c-handoff.md`: 73

## Central snippets

```toml
ai-threading = ["redis", "dep:serde", "dep:serde_json", "dep:uuid", "dep:regex", "credit-policy", "js-strings"]
channel-ai-personality = ["application-schemas", "mongo", "js-date", "js-strings", "credit-policy"]

[[test]]
name = "ai_threading"
required-features = ["ai-threading"]

[[test]]
name = "channel_ai_personality_schema"
required-features = ["channel-ai-personality"]
```

```rust
#[cfg(feature = "ai-threading")]
#[path = "ai/threading/mod.rs"]
pub mod ai_threading;
```

```rust
#[cfg(feature = "channel-ai-personality")]
#[path = "channel_ai_personality.schema.rs"]
pub mod channel_ai_personality;
```

`definitions()` stays at 42 entries, following existing feature-gated schema precedent.

## Sources and reuse

- `thread_limits.rs` ports `thread_limits.ts` / `getThreadLimitsForTier`. `ThreadPlanTier` represents thread limits only, distinct from the billing credit tier.
- `thread_types.rs` ports the JSON interfaces in `thread_store.ts`; TS `thread_types.ts` is empty. It uses `JsString` and serde JSON raw values to retain UTF-16 seed slices, including lone surrogates.
- `thread_store.rs` ports `thread_store.ts` keyword extraction, keys, TTL, store and index methods using injected `redis::aio::ConnectionManager`, UUID, serde JSON and `credit_policy::JsDate`.
- `thread_router.rs` ports `thread_router.ts` scoring, sticky selection, fallback and assistant append, and `bot_runtime_metrics.ts` / `recordThreadRoutingMetric`, including all three key expirations.
- `channel_ai_personality.schema.rs` ports `channel_ai_personality.schema.ts`: the field definitions, profile projection, tier rules, user lookup and save adapter. It reuses `schemas::schema`, `users::schema().repository`, `ObjectId`, and `credit_policy::JsDate`. Mongoose collection: `channel_aipersonalities`.
- Child subdocuments disable generated `_id`; profile IDs are generated in the materialization pass. Explicit BSON undefined rules elements are defaulted before the framework's `ArrayElement` casting and validation. The source's zero-profile guard remains, although the preceding fallback makes it unreachable in ordinary flow.

## Routing failure, metrics and persistence

`ResolvedThread::fallback_reason` carries the original typed store error on successful fallback; if fallback fails, `ThreadRouterError` contains both errors. Metrics run in a detached task and cannot change the routing result. The emitter owns `metrics:bot:threading:*` (or the explicitly configured prefix); the observability team should reuse it. Minute, channel-minute and cumulative keys all expire after 86400 seconds.

The personality adapter materializes defaults, projects the active profile, validates, resolves the owning user and tier, reapplies save rules, and writes. As in the source, tier lookup and write are not transactional: the user's tier can change between lookup and persistence; there is no lock or tier re-read.

## Unicode and whitespace

The tokenizer uses `js_compat::is_whitespace` for both character preservation and splitting, including U+FEFF and excluding U+0085. For letters and numbers it uses the regex crate's Unicode general categories `\\p{L}` and `\\p{N}`. `re2_compat.rs` rewrites RE2 Perl classes and is not a JS Unicode-properties implementation; `js_regexp_unicode.rs` provides separately gated pinned Unicode 17 raw category tables. The regex crate's version can differ from the Node/JS tables; Rust and JS lowercasing versions can also differ. Unicode-category and case-mapping parity has not been established for version-boundary characters.

## Tests authored, not executed

Thread tests cover all tier limits, keyword and token stopwords/caps, lexical similarity including empty input, recency including future dates, score weights, sticky boundary and threshold decision, UTC bucket formatting, JSON field names, UTF-16 surrogate-boundary seed serialization/round trip, malformed meta and turn entries, and U+FEFF whitespace. Schema tests cover tier profile caps/messages and context windows, rules and known-user caps, fallback and active ID repair, voice defaults, timestamps, generated profile ID, subdocument IDs, undefined rule default, and pre-validation projection. These are pure tests; no fixture-backed tests were run.

## Remaining gaps and verification limits

- Central snippets are not applied. Run isolated compile, formatting, pure tests and disposable Redis/Mongo adapter checks under the repository's Rust resource and isolation rules before integration; no pass is claimed here.
- Regex Unicode version differences and typed treatment of valid JSON values outside the expected meta/turn shape are not established as equivalent to JavaScript. Verify if those boundary cases are required for integration.
- No runtime adoption, production validation, deployment, or claim of total migration completeness is implied by this local lane handoff.

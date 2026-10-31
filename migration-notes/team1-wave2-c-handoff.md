# Team 1 wave 2-C referral and threading handoff

The requested referral, fixture and source-comparison work is authored, subject to central execution. No compiler, formatter, test runner, network or deployment was used.

## Wave 2-C files and line counts

- `dimabot/src/schemas/referral_code.schema.rs`: 31
- `dimabot/src/utils/referral.rs`: 113
- `dimabot/src/utils/referral_ledger.rs`: 43
- `dimabot/tests/referral.rs`: 28
- `dimabot/tests/referral_ledger.rs`: 21
- `migration-notes/team1-wave2-c-handoff.md`: 148

## Revised wave 1 SHA-256

- `dimabot/src/utils/ai/threading/thread_router.rs`: `239a4a11f07736da7a7514d7d1400c7a8f9cf409026f7d24e51b73fb14174922`
- `dimabot/src/utils/ai/threading/thread_store.rs`: `36a69de7c86fb2cc53d71c8b40832fed495b0a9719da0fed43470620651dd109`
- `dimabot/tests/ai_threading.rs`: `aa5af3bdb4994d25d5142dcde28ba093cbf82e3a7ee5e1b0e2ddcc3e7b72d458`

## Public threading metrics API

Module: `crate::utils::ai_threading::thread_router`. This emitter owns `metrics:bot:threading:*` (or the explicitly selected prefix) under contract tl1-c2. It returns emission errors; the router spawns it and discards the result so metrics cannot alter routing. All three keys receive `SEMANTIC_METRICS_TTL_SECONDS`, independent of the thread-store TTL.

```rust
pub const DEFAULT_METRICS_PREFIX: &str = "metrics:bot";
pub const SEMANTIC_METRICS_TTL_SECONDS: u64 = 86_400;

pub struct ThreadRoutingMetric {
    pub channel_id: String,
    pub created: bool,
    pub reused: bool,
    pub failed: bool,
    pub candidate_count: i64,
    pub selected_score: f64,
    pub prompt_turns_used: i64,
    pub user_evictions: i64,
    pub channel_evictions: i64,
    pub latency_ms: i64,
}

pub async fn record_thread_routing_metric(
    conn: &mut redis::aio::ConnectionManager,
    prefix: &str,
    metric: &ThreadRoutingMetric,
) -> Result<(), ThreadStoreError>;
```

The struct is also `Clone` and `Debug`.

## Central snippets — not applied

```toml
ai-threading = ["redis", "dep:serde", "dep:serde_json", "dep:uuid", "credit-policy", "js-strings", "js-regexp-unicode", "js-unicode17"]
referral-service = ["application-schemas", "mongo", "billing-service", "js-date", "dep:sha2"]

[[test]]
name = "referral"
required-features = ["referral-service"]

[[test]]
name = "referral_ledger"
required-features = ["referral-service"]
```

```rust
#[cfg(feature = "referral-service")]
pub mod referral;
#[cfg(feature = "referral-service")]
pub mod referral_ledger;
```

```rust
#[cfg(feature = "referral-service")]
#[path = "referral_code.schema.rs"]
pub mod referral_code;
```

The feature-gated schema stays out of the 42-entry `definitions()` array. `billing-service` and the `utils::billing` declaration are wave-1 integration prerequisites; the central files were not modified.

## Source and reuse

- `referral_code.schema.rs` ports `referral_code.schema.ts` shape, indexes, lookup, validation and explicit lowercase save hook. Mongoose collection: `referralcodes`.
- `referral.rs` ports `referral.ts` tier tables, code lifecycle, reward processing, shared completed-reward filter and stats. `referral_ledger.rs` ports both `referral_ledger.ts` reads using that filter. The users, credit transactions and referral code schema repositories supply the Mongo adapters.
- The plan product IDs are re-exported from `utils::billing`; they were not copied. Their eventual canonical home should be `credit_policy.rs` to avoid forcing billing's Polar graph on both consumers. `free_credit_reset.ts` and `credit_packs.ts` were not re-ported; their native implementations remain in `credit_policy.rs`.
- `applyReferralCode` has no owner-plan gate in the source; none is added here.

## Fail-fast rewards and Unicode

The reward writes run in independently spawned Tokio tasks. `try_join_all` watches their handles and returns the first error; dropping the other handles detaches their still-running tasks instead of canceling the writes, as required for `Promise.all`-style behavior. The source's lookup-before-write idempotency race remains. Tokio runtime shutdown can still terminate detached work; callers must keep the runtime alive.

Thread tokenization uses `js_unicode::lowercase` on `JsString`, `js_regexp_unicode::is_letter_or_number` for pinned Unicode 17 general categories, and `js_compat::is_whitespace` for JS whitespace. This removes the earlier Rust/regex Unicode-table and lowercasing divergence. `dep:regex` is no longer used by threading and is omitted from its proposed feature.

## Tests authored, not executed

Referral tests cover limits and messages, validator/lowercase/lookup, plan IDs, reward table and shared filter. Ledger tests cover 20/21 pagination, sorts, aggregation group/sum and zero, event IDs and kinds, skip/limit and name fallback. Threading tests add targeted pinned Unicode lowercasing and category examples alongside existing token, threshold, whitespace and seed cases.

## Remaining gaps and limitations

- No authored Rust was compiled or tested in this turn. The central snippets and wave-1 billing feature/module integration remain unapplied. Run isolated compiler and appropriate tests before integrating.
- Private Redis router/store fixtures, private Mongo personality-save fixtures and Mongoose comparison oracles have since been authored; see the partial coverage and verification limits below. Referral Mongo success/failure and race behavior still require isolated verification.
- No production deployment, caller adoption or total migration-completion claim is made.

## 2026-10-31 adapter test authoring

**AUTHORED BUT NOT RUN.** Root runs the checks centrally. The released pure suites were not modified. New owned files and SHA-256:

- `dimabot/tests/ai_threading_redis.rs` (65 lines): `1ea950d10b2c7b6ccd6170e7c0bb59f27c753f666a3062e1c483f0d3d5173911`
- `dimabot/tests/channel_ai_personality_mongo.rs` (70 lines): `3ed92fbf71a29d7eb789f4a50b72bb64e53e9c8abcf4237bb0fb6595876aecf4`
- `dimabot/tests/referral_mongo.rs` (79 lines): `5cc25966e1d1ce5462eb1d8b7831ef7f9d239b39d646947eef57e21721f4ed38`
- `dimabot/tests/fixtures/channel_ai_personality_reference.cjs` (21 lines): `c4f51922f01f13cada2a112aacf715dba0ca89f4344a7c20b8ac4153f5735905`
- `dimabot/tests/fixtures/channel_ai_personality_mongo_reference.cjs` (13 lines): `ce596025ba6b61eead86a5cbeac4179f2d09743da3d25eff96890c3694d0b70d`
- `dimabot/tests/fixtures/referral_reference.cjs` (25 lines): `2eb450c5cadc79440bd685efa5fb978521bbb9d8086c94264c87f5da9f249b45`

The Redis fixture requires explicit `DIMA_TEST_REDIS_URL`, `DIMA_RUST_TEST_RESOURCE_OWNER=dimabot-migration`, and is marked `#[ignore = "requires an explicitly provided isolated Redis fixture"]`. It uses a UUID-owned channel, claim key and bounded cleanup, with no scan or flush. Mongo tests require `MONGO_TEST_EXPECT=success`, explicit `MONGO_URI`, unique fixture databases, and `#[ignore = "requires an explicitly provided isolated MongoDB fixture; set MONGO_TEST_EXPECT and MONGO_URI"]`. Mongo fixture bodies catch assertion panics, attempt to drop their own unique database, and resume the panic. A failed cleanup is reported and process abort or cancellation is not covered.

Oracle consumers are explicitly ignored in ordinary runs. When explicitly run they fail on an absent directory, missing or empty file, invalid JSON, or empty JSON object, with the relevant environment variable, file and pinned-image generation command in the diagnostic:

- `DIMA_AI_PERSONALITY_REFERENCE_DIR/channel_ai_personality_reference.json`
- `DIMA_AI_PERSONALITY_MONGO_REFERENCE_DIR/channel_ai_personality_mongo_reference.json`
- `DIMA_REFERRAL_REFERENCE_DIR/referral_reference.json`

Each oracle accepts exactly `--write DIR` and `--check DIR`; write uses exclusive `wx` creation. Pin SHA-256 values:

- personality TypeScript: `781eed0d3590ca022b843f7e46cc4d86a0b76ac7466b87799b3f31f7569a04aa`
- referral schema: `d31791bbc11483a2894f22258f1445676aa95efc79ee3a88b4692eafb97a63d5`
- referral lifecycle: `ef4cdb9f0aede45cce28b96a20d154458c207f4179b6941005f0718122f3d6c3`
- referral ledger: `c71377f6e227fc22247bb44c36738357dba05bb1f42e2d4076b488711b1f2e0a`
- package: `cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef`; lock: `abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7`
- TypeScript JS: `3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675`; TypeScript package: `822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6`
- Node executable: `569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108`; expected version `v24.22.1`.

Additional central test targets, not applied:

```toml
[[test]]
name = "ai_threading_redis"
required-features = ["ai-threading"]

[[test]]
name = "channel_ai_personality_mongo"
required-features = ["channel-ai-personality"]

[[test]]
name = "referral_mongo"
required-features = ["referral-service"]
```

**Current authoring coverage:** the personality oracle enumerates nested schema paths, function-valued defaults, child `_id` settings and array element metadata; its Rust consumer recursively compares field counts, types, validators, enum values, defaults and indexes. The referral oracle enumerates paths, defaults, enums and validators and its consumer compares paths and indexes. It captures create success by tier, apply, list, delete, stats and timeline outcomes, with an ignored Mongo replay consumer. The Redis fixture tests actual error fallback, completion signalling, no fallback eviction, and a normal free-tier path with both user and channel evictions and metric counts. The Mongo cleanup test deliberately catches an assertion failure using the same cleanup helper as the personality fixture and checks that its collection is gone. Source audit correction: the TypeScript profile has no `description` or `language` field; `description` belongs to known users and `language` is top-level. Tests and oracles are **AUTHORED BUT NOT RUN**; the pinned-source oracle and adapter fixtures still need central execution. Static quote/bracket scans of all three oracle files passed, without invoking Node. The handoff file's own final digest is reported in chat because embedding its digest within itself would change it.

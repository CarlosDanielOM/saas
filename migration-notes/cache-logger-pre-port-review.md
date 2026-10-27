# Cache protocol and shared logger pre-port review

Reviewed on 2026-10-27.

Status: source review only. This note records reusable behavior, implementation constraints, and optional opportunities for a future utility port. The recommendations here are not approved implementation scope. Earlier TwitchStreamers improvements remain separately approved in [its pre-port review](twitch-streamers-pre-port-review.md). Source review and mocked fixtures do not establish Rust parity, production behavior, performance gains, or deployment readiness.

## Plan-cache protocol

The plan fence is shared by [`plan_cache_fence.ts`](../dimabot/src/utils/plan_cache_fence.ts), [`TwitchStreamers`](../dimabot/src/classes/twitch_streamers.class.ts), [`billing.ts`](../dimabot/src/utils/billing.ts), and [`polar_billing_events.ts`](../dimabot/src/domain_events/polar_billing_events.ts). The utility has three short Lua scripts: conditional account write plus aggregate invalidation, account-list version checking/publication, and credit-cache acceptance. Billing events add `INVALIDATE_PLAN_SCRIPT` and `SYNC_CREDITS_SCRIPT`, which coordinate plan invalidation, credit synchronization, and exhaustion flags. Keep event orchestration in TypeScript; a Rust/shared protocol utility should centralize typed versions, keys, and script behavior without moving domain-event ownership.

Required protocol invariants:

- Plan version fences are persistent. Do not give them arbitrary TTLs that can reopen an old-write window.
- Plan invalidation and dependent cache invalidation stay atomic.
- Preserve equal/newer version ordering and both exhaustion-key forms (`twitch:<id>:ai:exhaust` and `<id>:ai:exhaust`).
- Credit reads compare the exact raw cached-credit value before changing exhaustion flags. Do not normalize or replace this compare with a weaker check.
- A stale account-list snapshot must fail its version check before it can be published as current.
- Do not split aggregate fence checks into chunks and publish without a final consistency check over the full snapshot.
- Plan fences establish plan freshness only. Credential and other metadata writes need their own ownership/CAS protocol; the plan fence does not establish their freshness.

No new plan-fence failure was reproduced in the lead's current source review. Existing checks were run with:

```sh
cd dimabot && node --experimental-test-module-mocks --import tsx --test src/utils/billing_plan_fence.test.ts src/utils/observability/telemetry.test.ts
```

All 17 tests passed (13 plan/cache source-contract mocks and four telemetry tests). These tests do not execute Lua against real Redis/Dragonfly and are not adapter or production-runtime evidence.

## Cache implementation opportunities

Potential follow-up work, subject to selection and validation:

- Define one shared typed API for the plan version/key protocol, retaining Lua atomicity and TypeScript domain-event orchestration.
- Load/cache prepared Lua scripts and call by SHA, with `NOSCRIPT` recovery. Fewer repeated script bodies may reduce request bandwidth; this is a hypothesis to benchmark, not an established speedup.
- Where useful, read an account hash and its plan fence atomically to reduce separate reads while preserving the current proof that the snapshot is fenced.
- Bound key enumeration and batch pipelines. The approved TwitchStreamers review already calls for explicit removal of stale account IDs and account-list reconciliation for the websocket caller, which needs IDs only. Do not turn an unbounded full key scan into one oversized command.
- The Dragonfly connection helper already shares a process-wide `connectionPromise`. Do not create a new connection pool per call.
- The helper's instrumentation wrapper currently measures a limited command list; `hMGet`, expiry, set membership, and multi-command batches are not in that list. If a later port uses these paths, include them in the instrumentation plan and metrics parity review.

Adjacent generic cache cleanup opportunities are separate from the plan-cache protocol:

- [`cache.ts`](../dimabot/src/utils/cache.ts) `clearChannelCache` deletes two fixed keys separately; a multi-key `DEL` can combine them.
- `resetSumimetro` uses `KEYS` and sequential `DEL` calls. If revisited, use bounded `SCAN` and batched deletes for the per-channel keys produced by [`sumimetro.command.ts`](../dimabot/src/commands/sumimetro.command.ts).
- `loadChannelAdminsIntoCache` delegates canonical cache rebuilding to [`populateAdminCache`](../dimabot/src/utils/permissions/roles.ts). Preserve this shared helper and its canonical key cleanup. If a future port includes admin roles, inspect and address partial rebuild behavior; the existing pure Rust permissions core is not the full Mongo/Dragonfly I/O adapter.

## Shared logger contract and source-level findings

[`logger.ts`](../dimabot/src/utils/logger.ts) currently records telemetry, writes console output, optionally writes a seven-day diagnostic record to Dragonfly, and emits through OpenTelemetry. It supports cache, console, or both destinations. Preserve the current default key/payload shape and seven-day TTL unless a separately reviewed compatibility change says otherwise. OAuth diagnostic wiring is in [`tokens.ts`](../dimabot/src/utils/tokens.ts) and [`oauth_debug_cache.ts`](../dimabot/src/utils/oauth_debug_cache.ts); preserve useful diagnostics without exposing credentials.

Four deterministic fixtures transpiled from current TypeScript source and used in-memory stubs; they did not use real Redis or OpenTelemetry and were not persisted as a harness:

1. Cache `SET` succeeds and a following `EXPIRE` fails, leaving a diagnostic entry without its intended TTL.
2. A held cache `SET` blocks the default `both` path, including console/OpenTelemetry output and logger completion, until the cache call is released.
3. An injected OpenTelemetry `emit` exception rejects the logger call after console output has already occurred.
4. A deliberately fixed `Date.now()` plus `Math.random()` collision overwrites the earlier cached record. This demonstrates collision behavior under constructed inputs; it does not establish a production collision rate.

Potential logger follow-up design, not yet approved for implementation:

- Use one `SET ... EX` operation to close the `SET`/`EXPIRE` gap and reduce the cache write from two commands to one.
- Isolate best-effort sinks so a cache delay cannot block console output. Decide explicitly whether optional sink errors affect the business operation; do not let logging accidentally become an unbounded request dependency.
- Use bounded cache/export queues with byte and item limits, drop counters, severity preference, and deadline-bounded shutdown flush. Define whether a result means queued or written to cache; do not report a completed write for queued-only records or imply durability beyond the cache's persistence guarantees.
- Apply configurable level/sampling checks before timestamp creation, serialization, and sink work. Preserve warn/error/fatal detail.
- Keep cache keys non-colliding with a stable random identifier. The current Dragonfly helper's `errorLogTracker` map has no eviction and keys include the entire error message; if that generic helper is reviewed, consider bounded eviction and stable error categories/time windows.
- Add safe bounded serialization for circular values, `BigInt`, and oversized payloads, with sink-specific metadata/redaction and useful local diagnostics.
- Timestamp formatting could reuse Rust `logger_timestamp` from [`ai_usage_receipts/queue.rs`](../dima-rust/src/workers/ai_usage_receipts/queue.rs), or a cached JS formatter, only after exact output compatibility checks and a benchmark.
- Reuse [`otel.rs`](../dima-rust/src/utils/otel.rs) for OTLP where appropriate. The bounded metadata export patterns in the supervisor/telemetry code may inform queue design, without coupling logger lifecycle to a worker supervisor.
- `ai_usage_receipts/queue.rs` already has a private global-only cache logger using `SET EX` and a two-second bound. Extract a focused shared sink if useful; do not make the generic logger depend on the worker module.
- [`oauth_debug_cache.ts`](../dimabot/src/utils/oauth_debug_cache.ts) already uses `SET EX`, but timestamp-only IDs can collide within the same millisecond. Rust Twitch diagnostic builders in [`twitch.rs`](../dima-rust/src/utils/twitch.rs) provide sanitization patterns; logger/storage wiring remains separate work.
- Do not set a globally short timeout on the shared Redis connection to isolate logger writes. Other users of that connection include blocking queues. Give the logger a dedicated bounded sink policy instead.

## Validation acceptance checklist for any future selection

- [ ] Source-contract tests cover all three plan scripts plus both Polar billing scripts, including persistent fences, equal/newer ordering, account-list race rejection, raw credit comparison, atomic flag behavior, and both exhaustion keys.
- [ ] Exercise scripts on disposable Redis/Dragonfly and verify Redis-version-compatible Lua semantics; mocked tests alone are insufficient.
- [ ] Add mixed-writer cases proving TypeScript and Rust versions/keys remain compatible during an incremental rollout.
- [ ] Benchmark script SHA loading/recovery, atomic reads, batching, and bounded enumeration with representative key counts before making latency or bandwidth claims.
- [ ] Logger tests cover each destination, blocked/failing sinks, telemetry and OTEL exceptions, TTL/key/payload compatibility, collisions, bounded queue overflow, severity policy, serialization limits/redaction, and shutdown deadlines.
- [ ] Test all migrated cache commands against disposable fixtures and preserve canonical role-cache rebuild behavior.
- [ ] Check instrumentation and telemetry parity for each newly used Redis method and batch path.
- [ ] Report source-mock, disposable-service, exact-candidate, and production evidence as separate levels; do not infer production gains from source fixtures.

## Source references

- [`plan_cache_fence.ts`](../dimabot/src/utils/plan_cache_fence.ts)
- [`polar_billing_events.ts`](../dimabot/src/domain_events/polar_billing_events.ts)
- [`billing.ts`](../dimabot/src/utils/billing.ts)
- [`billing_plan_fence.test.ts`](../dimabot/src/utils/billing_plan_fence.test.ts)
- [`logger.ts`](../dimabot/src/utils/logger.ts)
- [`telemetry.ts`](../dimabot/src/utils/observability/telemetry.ts)
- [`dragonfly.database.ts`](../dimabot/src/utils/databases/dragonfly.database.ts)
- [`oauth_debug_cache.ts`](../dimabot/src/utils/oauth_debug_cache.ts)
- [`cache.ts`](../dimabot/src/utils/cache.ts)
- [`permissions/roles.ts`](../dimabot/src/utils/permissions/roles.ts)
- [`TwitchStreamers pre-port review`](twitch-streamers-pre-port-review.md)

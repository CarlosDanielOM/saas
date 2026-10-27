# Cache protocol and shared logger pre-port review

Reviewed on 2026-10-27.

Status: source review plus accepted opt-in logger and plan-cache utilities. The plan-cache utility passed capped quality/source parity and 135 disposable Dragonfly scenarios; neither utility is caller-wired, in a worker profile, or deployed. Other cache recommendations remain unselected. Logger verification and boundaries are documented in [shared-logger.md](shared-logger.md); plan-cache API and evidence limits are in [plan-cache-fence.md](plan-cache-fence.md). Earlier TwitchStreamers improvements remain separately approved in [its pre-port review](twitch-streamers-pre-port-review.md); its Rust class port remains a separate task. No production behavior or performance claim follows from these library checks.

## Plan-cache protocol

The plan fence is shared by [`plan_cache_fence.ts`](../dimabot/src/utils/plan_cache_fence.ts), [`TwitchStreamers`](../dimabot/src/classes/twitch_streamers.class.ts), [`billing.ts`](../dimabot/src/utils/billing.ts), and [`polar_billing_events.ts`](../dimabot/src/domain_events/polar_billing_events.ts). The opt-in Rust utility ports exactly the three scripts from the first file and two billing scripts from the last; it does not move event orchestration from TypeScript. Its methods, bounds, dependency direction, and remaining credential risks are recorded in [plan-cache-fence.md](plan-cache-fence.md).

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

Remaining follow-up work, subject to selection and validation:

- Complete the plan-cache utility's source-oracle and disposable Dragonfly verification before describing it as accepted; no callers currently use it.
- Keep any later integration bounded and credential-aware. This utility does not provide credential CAS, hydrate MongoDB, or reconcile account-list membership.
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

Logger decisions implemented and verified in the opt-in Rust core/adapters (see [shared-logger.md](shared-logger.md)):

- Use one `SET ... EX` operation to close the `SET`/`EXPIRE` gap; the adapter uses a caller-owned Redis connection.
- Run selected sinks concurrently and report per-sink outcomes. The chosen policy has no background queue or batching; it uses bounded whole-call/cache admission with a warning-and-above reserve. Optional metadata and OTEL sinks can be skipped.
- Apply default keep-all sampling and configurable low-priority sampling/minimum level before payload construction through `log_lazy`.
- Use UUID cache IDs and bounded JSON serialization limits. Non-JSON JavaScript values are outside this API; context metadata uses an explicit allowlist.
- Keep cache keys non-colliding with a stable random identifier. The current Dragonfly helper's `errorLogTracker` map has no eviction and keys include the entire error message; if that generic helper is reviewed, consider bounded eviction and stable error categories/time windows.
- Timestamp formatting could reuse Rust `logger_timestamp` from [`ai_usage_receipts/queue.rs`](../dima-rust/src/workers/ai_usage_receipts/queue.rs), or a cached JS formatter, only after exact output compatibility checks and a benchmark.
- Reuse [`otel.rs`](../dima-rust/src/utils/otel.rs) for OTLP where appropriate. The logger adapter accepts an existing SDK logger and does not install an exporter or couple logger lifecycle to a worker supervisor.
- `ai_usage_receipts/queue.rs` retains its private global-only cache logger; the generic logger does not depend on that worker module.
- [`oauth_debug_cache.ts`](../dimabot/src/utils/oauth_debug_cache.ts) already uses `SET EX`, but timestamp-only IDs can collide within the same millisecond. Rust Twitch diagnostic builders in [`twitch.rs`](../dima-rust/src/utils/twitch.rs) provide sanitization patterns; logger/storage wiring remains separate work.
- Do not set a globally short timeout on the shared Redis connection to isolate logger writes. Other users of that connection include blocking queues. Give the logger a dedicated bounded sink policy instead.

## Validation acceptance checklist for future selections

- [x] Source parity for all five scripts and disposable Dragonfly behavior checks passed; see [plan-cache-fence.md](plan-cache-fence.md). The adapter's actual deadline-expiry path was not fault-injected.
- [ ] Before caller adoption, add mixed-writer cases proving TypeScript and Rust versions/keys remain compatible during an incremental rollout, plus a credential ownership/CAS review.
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

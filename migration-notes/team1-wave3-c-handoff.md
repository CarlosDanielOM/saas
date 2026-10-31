# Team 1 wave 3 C handoff — authored, uncompiled

Status: authored on disk. Not compiled, not rustfmt'd, and not executed. No Cargo, Node, container, network, or test command was run. A local JSON parse confirmed the two embedded fixtures and that the Redis script bytes sit inside both the TypeScript sources and the Rust modules. That parse is not a Rust build and is not a passing test run.

The handoff's own digest is omitted because embedding it changes the digest.

## Files

| File | Lines | SHA-256 |
|---|---:|---|
| `dimabot/src/utils/ai_usage_queue_health.rs` | 619 | `57e1526a8898ea7fd43a9a753263977cfb33ca83206ca6e658edca8ab091150c` |
| `dimabot/src/utils/ai_usage_backfill_queue.rs` | 408 | `ac6dc4a1d6bb71c36117eb33f0c6ffab10d5e9aee6d1748ce48fba4986394127` |
| `dimabot/tests/ai_usage_queue_health.rs` | 868 | `651a918f0106f4d5eb97b2c4eaf245662e27a37399f501ddb450e26b04eec469` |
| `dimabot/tests/ai_usage_backfill_queue.rs` | 625 | `d7bc0982bf0677f6f0841051d059720753ab604858bd5b6e99b1b5ddb9e14546` |

TypeScript sources these modules follow, not edited here:

| File | SHA-256 |
|---|---|
| `dimabot/src/utils/ai_usage_queue_health.ts` | `70fa5349e56115b75ef26ae761709de72f5f3fe96a68431e5bca6f2f949ee6a9` |
| `dimabot/src/utils/ai_usage_backfill_queue.ts` | `3b8a3f7a55c0b5410de2edcffc892255d25357fa972c84ec0dc8cc5424b89dde` |

Neither Rust module is declared in `src/utils/mod.rs`. They are not part of the crate until the snippet below is applied together with the feature.

## Gated central snippet

Apply both pieces together. Do not add `ai-usage-queues` to `[features] default` or to the receipts worker profile (`mongo, redis`).

`sha2` is not transitive. The health module hashes retry keys with it, and the health parity test hashes the TypeScript sources with it, so `dep:sha2` stays on the feature line. `uuid` v4 arrives through `logger`. `serde` and `serde_json` arrive through `logger`, `credit-policy`, and `lossless-json`. Do not add `dep:uuid`, `dep:serde`, or `dep:serde_json`. `js-date` is not pulled by `ai-usage-producer` and must stay explicit. `js_compat`, `json_number`, and `lossless_json` arrive through `ai-usage-producer` → `credit-policy` and `tts-utilities`.

In `dimabot/Cargo.toml`:

```toml
ai-usage-queues = ["ai-usage-producer", "js-date", "logger", "dep:sha2"]

[[test]]
name = "ai_usage_queue_health"
required-features = ["ai-usage-queues"]

[[test]]
name = "ai_usage_backfill_queue"
required-features = ["ai-usage-queues"]
```

In `dimabot/src/utils/mod.rs`, immediately after the `ai_usage_producer` module:

```rust
#[cfg(feature = "ai-usage-queues")]
pub mod ai_usage_queue_health;
#[cfg(feature = "ai-usage-queues")]
pub mod ai_usage_backfill_queue;
```

Without those `[[test]]` rows, `cargo test` still builds the always-on fixture checks (serde_json and std only). The `#[cfg(feature = "ai-usage-queues")]` modules are empty on a default build, so their parity and Redis tests are not compiled. `unexpected_cfgs` is not denied; the cfg modules still carry `#[allow(unexpected_cfgs)]` because the feature name is not in `Cargo.toml` yet. Enabling the feature without the `mod` lines makes the parity tests fail at compile time. Enabling the mods without the feature leaves them out of the build.

## tl1-c6

These symbols live only in `dimabot/src/utils/ai_usage_backfill_queue.rs`. Lane B `ai_usage_queries.rs` was not edited. It only comments that enqueue lives in the queue module. No second copy of the queue policy was added.

- `AI_USAGE_BACKFILL_QUEUE_KEY`
- `AI_USAGE_BACKFILL_PROCESSING_KEY`
- `AI_USAGE_BACKFILL_DEAD_KEY`
- `AiUsageBackfillJob`
- `desired_coverage_start` (`pub use get_ai_usage_desired_coverage_start as desired_coverage_start`)
- `parse_ai_usage_backfill_job`
- `enqueue_ai_usage_backfill`

`safe_part` is `typeof value === 'string' ? value.trim() : ''`. It trims ECMAScript whitespace and does not strip colons. `a:b` + `c` and `a` + `b:c` share one dedupe key. The port keeps that. Changing it is a compatibility decision, not a drive-by fix.

## What the modules do

Queue health reads limits when a production monitor builds them, not at import. Pure `queue_limit_from` takes `Option<&str>`. Unset, empty, and non-UTF-8 use the defaults (900 / 900 / 3). Whitespace `" "` is Number 0. `"abc"` stays NaN, so comparisons are false. `" 900 "` trims to 900. `"Infinity"` stays infinite. `Infinity > Infinity` is false. `Infinity >= Infinity` is true, so an infinite failure delta warns. An infinite age against an infinite threshold does not stall.

`assess_usage_queue` formats `checkedAt` before any write. A `now` outside TimeClip returns `QueueHealthError::InvalidTime` (`Invalid time value`) and does not write. Pending uses `Number(pendingSince) || now`, so `0`, `NaN`, and a missing field become `now`. `pendingSince` `"Infinity"` is kept and the age becomes 0 via `Math.max(0, now - Infinity)`. Failures use `Number(field || 0)`, so a present `"0"` / `"NaN"` / `"abc"` is not replaced by the missing-field fallback. `observedFailures` text is `String(current failures)` (`number_string`), including `"NaN"` and `"Infinity"`. Reasons stay in source order: `queue_age`, `processing_stalled`, `dead_letters` when `dead != 0`, then `repeated_failures`. Exactly 900 is not greater than 900.

`queuedAt` follows JavaScript truthiness. Empty string, `0`, `false`, `null`, and a missing field fall through. `"0"`, objects, arrays, `true`, and other non-zero numbers do not. Strings are ECMAScript-trimmed and then `parse_date`. Other values use `ToNumber` and TimeClip. `getTime() || 0` also treats epoch 0 as falsy, so a parsed epoch falls through to `pendingSince`. Invalid JSON or JSON `null` yields 0. The string `"0"` is accepted as a legacy year in the process timezone; the oracle asserts it is not the numeric-zero age and does not pin that instant.

Snapshot and alert JSON keep insertion order through the lossless writer. Non-finite ages and failures become `null`. The alert object starts `worker`, `message`, then the status fields. The native logger re-encodes with `serde_json`, whose map is a `BTreeMap`, so sink bytes are not required to start with `{"worker":`. Tests pin `queue_alert_json` order and compare parsed sink fields. `tokio::join` can reorder cache and console rows; the logger test matches by sink kind. Warn uses `Level::Warn` and `Destination::Both`. The alert key is set before `warn`. A log failure does not delete it.

`monitor_ai_usage_queues_in` reads `LLEN`, `LLEN`, `LLEN`, `LINDEX`, `HGETALL` one after another. TypeScript uses `Promise.all` for the same commands and keys. The interleaving can differ. Snapshot `SET` with `EX 300` happens before `HSET` of `pendingSince` and `observedFailures`, including when there are no reasons. The alert `SET NX EX 300` runs only when `reasons` is non-empty. Warn runs only when that reply is exactly `Some("OK")`, not `Some("ok")` or any other bulk string. Production `monitor_ai_usage_queues` uses `USAGE_QUEUES`, prefix `ai-usage:queue-health`, `production_queue_limits()`, and the caller-supplied `Logger`. `monitor_ai_usage_queues_with_redis` calls `get_redis_client`. Import does not connect.

`USAGE_QUEUES` has two entries. Receipts dead is `cron:ai-usage-receipts:queue:dead`. Backfills dead is `cron:ai-usage-backfills:dead` and does not contain `:queue`. Claim, complete, and fail Lua match the TypeScript templates, including the single leading space on the inner `redis.call` lines. Claim `ARGV` is the integer millisecond string. Fail uses `"1"` when `invalid` is set, otherwise `max_attempts` (`DEFAULT_MAX_ATTEMPTS` is 3). The fail script still contains the literal `604800`. `RETRY_TTL_SECONDS` documents that literal. `usage_retry_key` is `{queue}:attempts:` plus lowercase SHA-256 hex of the raw payload. Claim and fail accept an injected health prefix through `*_in`. A fail that never claimed still `INCR`s the retry key before `LREM` returns 0, and `HINCRBY` runs before that `LREM`, so an absent fail dirties the health hash.

Backfill dedupe seconds are `Math.max(300, Number(raw || 172800))` at the call, not at import. `None` and `""` use 172800. `" "` becomes 0 and then 300. `"abc"` stays NaN and the `EX` argument is `"NaN"`. `"Infinity"` stays. `"172800.9"` is not floored. An explicit `Some(seconds)` also goes through that `js_max`, so `Some(10)` becomes 300 and `Some(NaN)` stays NaN and ignores the env string. `resolve_backfill_plan` and `prepare_ai_usage_backfill_job` do not read process environment. `enqueue_ai_usage_backfill` reads `AI_USAGE_BACKFILL_DEDUPE_SECONDS` only when `input.dedupe_seconds` is `None`. `None` queue and prefix select `cron:ai-usage-backfills:queue` and `cron:ai-usage-backfills:dedupe`.

`normalize_tier` is exact `=== 'pro'` / `=== 'premium'`. `"Premium"` and every other value, including numbers, are `free`. Coverage for a missing date is UTC midnight minus `(retentionDays - 1)` days. Retention is `get_ai_usage_retention_days` (premium 60, pro 90, else 30). The enqueue path passes the normalized tier. `AI_USAGE_BACKFILL_REPORT_VERSION` is a local `3`. This module does not import a ledger store. The dedupe key is `{prefix}:v3:{channel}:{customer}`.

`prepare` checks channel and customer before any `toISOString`. Empty, whitespace, and non-string ids return `AI usage backfill requires channel and customer IDs` even when `now` is already an invalid `JsDate`. A valid identity with an invalid `now`, or with `Some(JsDate::invalid())` coverage, returns `Invalid time value`. `Some` coverage is used as given, including a valid epoch that overrides retention. `None` coverage computes retention and fails if `now` cannot produce milliseconds. Empty reason becomes `api_request`. Any other non-empty reason is stored raw and is normalized only by `parse`. `id: None` allocates `Uuid::new_v4()` lowercase hyphenated `Display`. `attempts` is `0.0`, written as `0`. Job field order is `id`, `channelID`, `customerId`, `planTier`, `coverageStart`, `requestedAt`, `reason`, `attempts`, `dedupeKey`.

`enqueue_ai_usage_backfill` `EVAL`s the source script with keys `(dedupeKey, queueKey)` and arguments `(id, number_string(seconds), payload)`. `enqueued` is `result == 1`. The job is returned either way. `enqueue_ai_usage_backfill_with_client` calls `get_redis_client`. Import does not connect.

`parse_ai_usage_backfill_job` uses `serde_json`. A non-object, a missing or blank trimmed `id` / `channelID` / `customerId` / `dedupeKey`, or an invalid coverage or requested date returns `None`. Dates are `String(value || '')`, then ECMAScript trim, then `parse_date`, then `toISOString`. Falsy values become `""`. Truthy non-strings are `String()` first: numbers go through `number_string`, not `Date(number)`, so coverage `1700000000000` is rejected. `true` becomes `"true"`. An object becomes `"[object Object]"`. An empty array is truthy, stringifies to `""`, and is rejected. Date-only ISO is UTC. Surrounding spaces on a `Z` timestamp are trimmed at this call site because `parse_date` rejects them; that is not a change to the shared parser. The ISO epoch string is accepted (`getTime() === 0` is not NaN). Attempts stay only for finite integral JSON numbers, then `Math.max(0, n)`. Strings, bools, fractions, and negatives become 0. Reason stays `daily_sweep` or `startup_sweep`; any other spelling, including `Daily_Sweep`, becomes `api_request`.

## Tests

Both test files embed their fixtures. A missing, blank, or empty `cases` array panics. There is no skip. Health has 51 cases. Backfill has 84. Always-on checks require the TypeScript pins and the Lua sources to be present in the TypeScript and, for the scripts, in the Rust file. They also reject the old health coercion (`filter(|v| *v != 0.0 && !v.is_nan())`, `s.parse::<f64>()`) and the old backfill `.max(300)` floor.

Cfg-gated parity walks every fixture case and panics on an unknown op. The health parity module also checks both TypeScript digests above. The backfill parity module checks the backfill TypeScript digest. The logger test uses a fixed clock and id, expects `Emitted` with both sinks succeeded, and compares parsed `data` to `queue_alert_json`.

Ignored Redis tests panic when `DIMA_TEST_REDIS_URL` is missing or empty, or when `DIMA_RUST_TEST_RESOURCE_OWNER` is not `dimabot-migration`. Namespaces are `dima:test:ai-usage:{label}:{pid}:{sequence}`. `Drop` deletes only after a matching owner token, with 2 second timeouts, and does not assert on cleanup failure. They do not read or delete production key names. The health Redis cases cover claim, fail-without-claim (retry key `"1"`), dead-letter on the third fail, `invalid` forcing limit 1, complete, and one monitor pass that writes the snapshot, hash fields, and a single alert, then does not warn again. The backfill Redis case uses an injected queue and prefix, floors `Some(10)` seconds to 300, asserts `SET` stores the id, `LLEN` stays 1, and `LINDEX 0` equals the first payload.

## Residual gaps

These are open. They are not silent changes to the port.

- Nothing here was compiled or run. Static JSON extraction does not show type errors, feature-graph mistakes, or Redis behavior.
- `Cargo.toml` and `src/utils/mod.rs` are not patched. The snippet above is the only central change.
- No caller is migrated. `usage_ledger_status` takes `FnOnce(JsDate) -> Fut`, not `enqueue_ai_usage_backfill` itself. `ai_credit_display` tells a later caller to pass that function as a closure. Neither file was edited.
- `src/utils/ai_usage_backfill.rs` (the `syncAiUsageBackfillJob` orchestrator) stays out of this wave. `fetch_ai_usage_transactions` now exists in lane B `ai_usage_period.rs` as `fetch_ai_usage_transactions(customer_id, window, list_events, classify_credit_sources) -> Result<Vec<AiUsageTransaction>, FetchAiUsageError<E>>`, with `list_events: Fn(PolarUsageListRequest) -> Future<Result<PolarUsageEventsPage, E>>` and `classify_credit_sources: FnOnce(&str, &[PolarUsageEvent]) -> Future<Result<Vec<(String, String)>, E>>`. This wave does not import or call it. Calling `period.rs` would cross the lane boundary. A later wave still needs ledger state, the Polar list, and the worker.
- TypeScript captures dedupe seconds and queue limits at import. Rust reads them at the production call. Tests pass explicit values so ambient env cannot flake them.
- Monitor reads are sequential. TypeScript uses `Promise.all`.
- List lengths and other integers above 2^53 are stored as `f64`, matching JavaScript numbers.
- `serde_json` rejects or replaces lone surrogates that `JSON.parse` keeps. The shared writer does not escape U+2028 or U+2029 the way ES2019 `JSON.stringify` does.
- Logger sink JSON sorts object keys. The pre-log `queue_alert_json` keeps source order.
- Date strings are trimmed at these call sites before `parse_date` because that parser rejects surrounding ISO whitespace that `Date.parse` accepts.
- `safe_part` colon collisions are preserved.
- The legacy string `"0"` is not pinned to one UTC instant.
- Redis tests are ignored and were not executed. They need an explicit disposable URL and the owner token above.
- Local feature coverage is not a dependency-complete migration. No deployment and no caller adoption.

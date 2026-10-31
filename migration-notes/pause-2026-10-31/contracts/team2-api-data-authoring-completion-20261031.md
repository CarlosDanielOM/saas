# team2-api-data — authoring completion log — 2026-10-31

**State for slices 2a and 3: `AUTHORED_NEEDS_COMPLETION`.** Both remain in the authored queue; neither is validation-ready. File ownership is retained by `team2-api-data`. No execution is authorized yet; the integration team has recovered ~8.5 GiB of disk and is leasing the first FS verification job.

This log does not mutate the immutable handoffs already published in `ready/` and `results/`. It records the state transition and the concrete outstanding gaps.

---

## Slice 2a — `team2-slice-2a-site` (site analytics collector + site route)

Immutable handoff: `ready/team2-api-data-slice-2a-site-analytics.md` / `results/team2-api-data-slice-2a-site-analytics.md`
(SHA-256 `4a1f6764bd256fb42d07dec65eeb00bb1f855dd2ed83a0b9c653c46c6cdae0db`)

### Gap A — actual-source oracle and private fixture coverage (authoring required)

No source oracle and no fixture-gated coverage exist yet. Required:

- `dimabot/tests/fixtures/site_analytics_reference.cjs` — an actual-source oracle in the repository's established convention. Template: `dimabot/tests/fixtures/temporary_roles_announcements_reference.cjs` (a Node script with `--write <empty-dir>` / `--check <dir>` modes that loads the REAL TypeScript source through the `typescript` package and executes it against in-memory/mocked seams, never contacting Twitch or a real cache). It must drive the real `src/server/routes/site.route.ts` (all five routes) and `src/utils/siteanalytics.ts`, and record the expected responses.
- `#[ignore]`-gated Rust coverage for the five routes and the collector against a private disposable MongoDB, a private disposable Redis, and a loopback HTTP recorder, with an explicit environment-variable contract (follow `dimabot/tests/follow_ledger_data.rs`).
- Ordinary success and meaningful failure cases only. No giant parity matrix.

The oracle fixture is AUTHORED in this wave and RUN by the integration team in a later leased phase with the pinned isolated Node/TypeScript toolchain. Node must not be run in this wave.

### Gap B — BSON→JS JSON projection (replace the null-degradation)

`dimabot/src/server/routes/site.route.rs` currently contains a hand-rolled `bson_json` that degrades `Binary`, `Decimal128`, `RegularExpression`, `JavaScriptCode(WithScope)`, `Undefined`, `MinKey`, `MaxKey`, `Timestamp`, `Symbol`, `DbPointer` and non-finite doubles to JSON null. That is an intentional null-degradation and must be replaced by the existing native projection:

- `crate::utils::bson_js_json::{bson_js_json, bson_js_json_string, append_bson_js_json}` in `dimabot/src/utils/bson_js_json.rs`, gated by the already-existing `bson-js-json` feature.
- `bson-js-json = ["mongo", "tts-utilities", "credit-policy", "dep:base64", "dep:sha2"]`. The `tts-utilities`/`credit-policy` coupling is already accepted in this repository — `commands-service`, `moderation-semantic-worker` and `moderation-settings-store` all enable `bson-js-json` today. Enabling it for `site-analytics-api` follows the same established pattern rather than introducing a new one.
- `bson_js_json` is a `JSON.stringify` VIEW of the default Node MongoDB BSON reader, not a storage conversion: it must be used for RESPONSE PROJECTION ONLY, never for writes.
- Its unsupported reader cases fail explicitly through `BsonJsJsonError`; map that to the route's typed error handling rather than silently degrading.

### Gap C — concrete structured failure logging

`SiteRouteService` currently holds no logger, so the source's structured failure logs are not emitted. The source logs `{ error, stack, timestamp }` for the route catch blocks and additionally `{ id, body }` for the PATCH path, with `destination: 'both'`. Required:

- `SiteRouteService` holds the native logger and emits those structured failure logs.
- Use `crate::utils::logger::{Logger, Level, LogOptions, Destination}` and mirror the established usage in `dimabot/src/server/routes/validation.route.rs` and `dimabot/src/server/routes/observability.route.rs`.
- Constructors stay I/O-free; the logger is an explicit constructor argument.
- The collector's failure paths in `dimabot/src/utils/siteanalytics.rs` need the same treatment.
- Do not log credentials or tokens. The source logs the PATCH request body, which is an event definition rather than a secret, so that matches the source.

---

## Slice 3 — `team2-slice-3-follow-ledger` (follow relationship ledger)

Immutable handoff: `ready/team2-api-data-slice-3-follow-ledger.md` / `results/team2-api-data-slice-3-follow-ledger.md`
(SHA-256 `89a06f5938d064ac32b167931080bf55698d305a3393126b9efdb23580f42f0f`)

### Gap D — the source transaction branch is REQUIRED (atomicity is not optional)

The earlier delivery omitted the source's transaction branch because "the pinned driver's session API was not statically verified". That is not a valid reason: the pinned driver source IS available locally at

`/root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/mongodb-3.9.1/`

Relevant locations already located: `src/action/session.rs:17` (`Client::start_session()` → `StartSession`), `src/action/transaction.rs:38` (`Session::start_transaction()` → `StartTransaction<&mut Self>`), and `src/client/session.rs` / `src/client/session/action.rs` for the commit/abort actions. Author the transaction branch against the real pinned API.

### Gap E — replica-set / private fixture plan plus standalone fallback coverage

Author the fixture plan for a REPLICA SET (a transaction requires one): what the integration team must provide, the exact environment contract, and the standalone fallback path for environments without a replica set. The standalone fallback must be covered by the test suite, not just described.

### Gap F — share one `TwitchTokenStorage` via `Arc`

The current delivery constructs two independent token storages because the inner type is not `Clone`. That defeats the pool and refresh coalescing. Required: hold a single `Arc<TwitchTokenStorage>` and share it. The repository already has this exact pattern — `NativeFunctionAuth` in `dimabot/src/functions/mod.rs` holds `tokens: Arc<TwitchTokenStorage>`, `directory: Arc<TwitchStreamers>`, `logger: Arc<Logger>`. `TwitchTokenStorage` itself already holds `Arc<dyn ...>` internals (`dimabot/src/utils/tokens.rs:269`).

### Gap G — OAuth debug-cache side effects are a REQUIRED ADAPTER / CONTRACT GAP

`cacheOAuthAPIFailure` was reported as a diagnostic-only difference. It is NOT a no-gap: it is a side effect of the source's OAuth failure path and needs an explicit required adapter or a named contract gap with an owner. The team3-bot-ast Helix 401-retry contract from the original handoff stands unchanged and must not be downgraded to no-gap.

---

## Lane plan under the three-worker cap

| Lane | Model | Current scope |
|---|---|---|
| 1 | Grok 4.7 @ high | slice 1 (OAuth desktop-beta API) |
| 2 | Terra @ high (codex) | slice 2a completion (gaps A, B, C) |
| 3 | DeepSeek V4.1 Flash @ high | slice 5 (command services), then slice 3 completion (gaps D, E, F, G) |

Slice 4b (the three route files) stays staged until slice 4a lands.

## Corrections to the team's own recorded notes

Two earlier lead premises were wrong and are corrected here so no later slice inherits them:

1. **Numeric BSON type.** The native framework's `js_number` helper (`dimabot/src/utils/bson_compat.rs:15`) reproduces the Node BSON rule: an integral finite number inside the Int32 range becomes `Bson::Int32`, everything else becomes `Bson::Double`. The implementer of slice 4a correctly refused to write assertions contradicting the framework. A JavaScript number is NOT always stored as a BSON Double.
2. **Version key.** `dimabot/src/schemas/stream_timeline.schema.ts` explicitly sets `{ versionKey: false }` for BOTH the participant and the marker schema (lines 10 and 29), matching the native `version_key: false`. The earlier `__v` divergence note was incorrect and is withdrawn.

---

## 2026-10-31T02:40Z — slice 3 (follow relationship ledger) → READY v2

The four mandatory gaps were closed by the implementer (DeepSeek V4.1 Flash, turn 3) and were then **independently re-verified by team2 against the TypeScript source and the pinned mongodb 3.9.1 driver** before publication. Nothing was compiled, formatted, executed or deployed.

### What was verified, not just accepted
| Gap | Claim | team2 verification |
|---|---|---|
| D — transaction branch | `session.withTransaction(...)` shape authored | `follow_ledger.rs:931-957` builds the session, calls `start_transaction`, attaches **all four** source operations to the same session (`find_one`/`update_many`/`insert_one`/`update_one` at `:976`, `:1000`, `:1024`, `:1045`), commits on success, aborts on a body error. Matches `follow_ledger.ts:377-403`. `StartTransaction::and_run2` deliberately avoided (it would erase the typed error). |
| — TS `mutual` semantics | two different meanings | `follow_ledger.ts:330` stores `mutual: Boolean(reverseActive)` (existence) while `:362` promotes on `reverseActive && !reverseActive.mutual` (the reverse's own flag). The Rust correctly separates them: stored value `reverse.is_some()` (`:1017`), promotion condition `reverse.is_some() && !reverse_mutual` (`:1029`). |
| — schema timestamps | `updated_at` on the updates | `follow_relationship_ledger.schema.ts:92` sets `timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }`, so the explicit `updated_at` in the `$set` matches Mongoose's automatic behaviour. |
| E — replica-set plan + fallback | typed path selection | `FollowStartWriteMode { Transactional, StandaloneFallback }` + `last_follow_start_mode()`; classification covers `ErrorKind::SessionsNotSupported`, `ErrorKind::Transaction` containing "not supported", and code 20 `IllegalOperation` / the source phrase. The TS checks only the server phrase (`:162`); the Rust adds the two driver-level pre-checks the TS never reaches. Retryability uses the real `Error::contains_label` accessor, matching `follow_ledger.ts:143-151` (codes `{11000,112,91,189,251}` + the two labels). |
| F — shared token storage | one `Arc<TwitchTokenStorage>` | exactly one `TwitchTokenStorage::new(...)` in `from_runtime` (`follow_ledger.rs:770`), applied `with_refresh_guard` once, then the same `Arc` reaches both the Helix `TokenSource` and the directory `StreamerCredentials`. Mirrors `NativeFunctionAuth` in `functions/mod.rs`. |
| G — OAuth debug cache | concrete adapter | `cache_oauth_api_failure` writes `SET oauth:failures:api:<ms> <json> EX 86400` — key prefix and TTL both match `oauth_debug_cache.ts:3,5,81-82` exactly. The remaining transport hook is published as a named team3 contract with the exact trait signature. |

### Defects found and fixed during this review
1. **Two central-patch hunk headers were arithmetically corrupt** for `git apply`: the `Cargo.toml` hunk claimed 6 context lines against 5, and the `schemas/mod.rs` hunk claimed 6 against 4. Corrected in the handoff (revision 3, no code change).
2. **Slices 2a and 4a insert their `Cargo.toml` feature at the same anchor** (after `api-validation-route`), so each hunk's context is broken by the other's insertion and **neither ordering applies cleanly**. Resolved by publishing one merged patch: `ready/team2-api-data-central-20261031.patch` (sha256 `af218702329fc4c1d330317f6fe3be822403a6e732f7c857aa23a8bf9559f5ab`), generated mechanically with `diff -u` from awk-applied edits, with every hunk count correct and every anchor proven unique. `git apply --check` exits 0 against current master for all four files. The validation was READ-ONLY: the patch was NOT applied and the central files are unmodified.
3. While generating that patch mechanically, the first generation inserted the `site_route` module **between** `#[cfg(feature = "domain-event-runtime")]` and its `#[path(...)]`, which would have detached the path attribute from `domain_event_runtime`. Caught and fixed before publication; the insertion is now before the `cfg` line.

### Publication
- `ready/team2-api-data-slice-3-follow-ledger.v2.md` and `results/team2-api-data-slice-3-follow-ledger.v2.md` — identical, sha256 `e982e72f192054ef939fa59b43a33d7bfb2bbfe51842ba97098a547eade2e099`.
- The v1 handoff is retained for history and is explicitly superseded.
- File hashes: `follow_ledger.rs` `103e8491…` (2292 lines), `follow_ledger_queue.rs` `0b5c05db…` (268), `follow_relationship_ledger.schema.rs` `e993214b…` (178), `tests/follow_ledger_data.rs` `92577793…` (1308).

### New work opened by the coordinator on 2026-10-31
- **tl1-c4** (`applyPaidOrderReward` concrete adapter) — assigned to the opencode DeepSeek lane; team2 owns the adapter, team1 keeps the consumer.
- **tl1-c2** — when `bot_runtime_metrics.ts` is ported, reuse team1's `record_thread_routing_metric`; team1 stays the only writer of `metrics:bot:threading:*`.
- **Slice 4a** — coordinator accepted the slice as authored but requires a lean actual-source comparison plus private Mongo/Redis adapter tests before READY-for-validation. team2 retains ownership and will deliver them.

---

## 2026-10-31T02:50Z — slice 4b source review → completion turn 9

The 4b worker (GPT-6.1 Terra, turn 8) returned its own verdict: **not ready**. The routes are authored and real, but the oracle covers only ten boundary cases and the ignored test never drives the native routers. A lead source-review against `stream_timeline.route.ts`, `stream-summary.route.ts` and `analytics.route.ts` was completed and a completion brief issued on the same lane.

### Verified correct (no rework)
Route inventory and verbs — including the deliberate `PUT markers/:key` vs `DELETE markers/:markerID` difference; the 401 → 400 → 403 gate order; the `no-store` nuance (absent on gate failures, present on handler failures and successes); `canSeeCredits` at both the middleware and the details route; the `mutual` filter mapping; the `totalPages` integer ceiling; both cursor encodings; the 64-lowercase-hex `people` cursor id (the TS regex has no `/i`) versus the 24-hex case-insensitive `objectID`; the UTF-16 `label.length > 120` and `key.length > 100` checks; and `bson_js_json` date output, which routes through `JsDate::to_iso_string` — the full ECMAScript `toISOString` algorithm — so `followed_at`/`ended_at` match the source's `.toISOString()` exactly. The `$setOnInsert` upsert derives `channelID`/`session_id`/`key` from the filter exactly as the Mongoose upsert does, and the 11000 swallow uses `capture::is_duplicate`.

Every native dependency the routes use exists and matches: `marker_schema()` (`src/schemas/stream_timeline.schema.rs:30`), `aggregate_schema()` (`src/schemas/stream_activity.schema.rs:67`), `capture::is_duplicate` (`src/utils/stream_activity/capture.rs:53`), `AdminService::{collection, has_global_channel_owner_access, get_channel_access_context, get_channel_access_decisions}` (`src/middleware/admin.middleware.rs:454/469/477/492`), `ChannelAccessContext{allowed, role}` and `ChannelAccessRole::as_str` (`src/middleware/admin_types.rs:113/124`), `TwitchStreamers::metadata_by_id` (`src/classes/twitch_streamers.class.rs:446`).

### Defects to fix
1. `put_marker` uses a bare `Json<Value>` extractor — a malformed body returns axum's plain-text rejection instead of the repository's JSON envelope. Regresses the house `Result<Json<Value>, JsonRejection>` + `INVALID_JSON_MESSAGE` pattern already used in `site.route.rs` and `observability.route.rs`. Those files must not be edited.
2. `Query<HashMap<String,String>>` can reject a query string Express accepts (repeated params → array → `Number` → NaN → the source's JSON `400 Invalid page`); the native fails with a plain-text 400 outside the source's envelope.
3. `stream_summary` `limit`/`skip` silently fall back to the default where the source yields NaN → driver error → `500 Internal server error`.
4. `analytics` `search` truncates by code points; the source's `slice(0, 64)` counts UTF-16 code units.
5. `parse_page` uses a different numeric grammar than JS `Number()` (JS accepts hex).
6. `moments` `to` default: the source's `ended_at?.getTime() || Date.now()` treats epoch-0 as falsy; the native only falls back when the field is missing.
7. Error logging discards the underlying cause; the source logs the error object.
8. The summary route's 500 log text must be route-specific.

### Main gap
The source oracle must **drive the native routers** — through axum against `protected_router()` and the per-service routers, asserting status, body and headers — with the full operation inventory (7 timeline GETs, PUT, DELETE, both summary GETs, follows GET) plus protected-router 401 and cached-bearer coverage. Ten boundary cases that never touch the native routers do not verify the adapters; this is the same standard the coordinator rejected in slice 4a.

### Integration note
The 4b per-slice `Cargo.toml` feature inserts at the **same anchor** as the 2a and 4a features, so its diff conflicts with the merged patch. The worker was told to publish the merged form or defer explicitly to `ready/team2-api-data-central-20261031.patch`.

### Sequencing
Slice 4a's completion is queued behind the first free lane and is deliberately sequenced **after** slice 4b, so it reuses the oracle harness 4b establishes instead of building a second one, and so two workers never edit the same fixture/support files concurrently.

---

## 2026-10-31T02:55Z — slice 4b turn 9: defects fixed, replay still incomplete

Turn 9 closed all eight reviewed defects and grew the oracle to 28 cases. The worker's own verdict: **still not ready** — the native replay covers only two cases (the protected timeline router's unauthenticated response and one authenticated invalid-channel case).

### Fixed and verified
- `put_marker` now takes `body: Result<Json<Value>, JsonRejection>` with `INVALID_JSON_MESSAGE` — the house pattern from `site.route.rs` / `observability.route.rs`, without editing those files.
- The rejecting `Query<HashMap<String,String>>` extractor was replaced by `RawQuery` plus a hand-rolled `parse_query` that reproduces Express's repeated-key joining.
- The summary `limit`/`skip` NaN path now surfaces as the source's 500 instead of a silent default.
- `parse_page` and the summary pagination now use `crate::utils::json_number::to_number` — the house ECMAScript `Number()` implementation (hex/octal/binary prefixes, `Infinity`, empty→0, and Rust's bogus `inf` acceptance excluded). This resolves the numeric-grammar defect properly instead of approximating it.
- `analytics` search truncation now uses `crate::utils::js_string::JsString::slice(0, 64)` — the house UTF-16-aware helper.
- The epoch-zero `ended_at` default and route-specific error log text were addressed.

### Feature line verified transitively — correct and complete
`stream-timeline-routes = ["http", "api-auth", "api-admin", "stream-timeline-data", "follow-ledger-data", "ordinary-application-schemas", "logger-redis", "bson-js-json", "axum/query", "dep:serde_json"]`
`api-auth` → `application-schemas` → `js-strings` enables `js_string`; `application-schemas` and `credit-policy` enable `json_number` and `js_compat`; `api-auth` → `http-client` gives `dep:reqwest`; `tokio`'s `net` feature is on; `axum/query` is required (axum is declared `default-features = false`) and present. No new crate.

### The `tower` blocker is resolved without a dependency
The repo already drives axum routers over a real loopback socket with no `tower`: `tests/observability_route.rs:179` (`serve` → `TcpListener::bind(("127.0.0.1", 0))` + `axum::serve`), `tests/observability_route.rs:228` (`send` → `reqwest::Client`), and `tests/observability_route.rs:781` (`replays_the_typescript_source_oracle`, the exact oracle-replay template). The fixture digest uses the dependency-free `tests/support/sha256.rs`, so `dep:sha2` is unnecessary. A real loopback request is also a stronger replay than `oneshot` because it exercises the real transport and extractor ordering.

The merged patch was not in the repo checkout — it lives in the **coordinator state directory** at `/root/.local/state/dimabot-migration-teams-20261031/ready/team2-api-data-central-20261031.patch` (sha256 `af218702329fc4c1d330317f6fe3be822403a6e732f7c857aa23a8bf9559f5ab`). The worker's decision to defer to it is correct.

### Turn 10 issued — three residual review items
1. **qs bracket-syntax divergence.** Express 4's default query parser is "extended" (qs); there is no `app.set('query parser', ...)` in `src/server/server.ts`. qs turns `?page[a]=1` into `{page: {a: '1'}}`, so `Number(req.query.page)` is `Number({})` → NaN → the source answers its JSON 400. The flat `parse_query` produces the key `"page[a]"`, which the parameter lookup never sees, so the native silently defaults and returns 200.
2. **Redaction policy divergence.** The new `safe_error` adds a "contains any digit → redact the whole message" rule that the accepted slice-2a helper (`src/server/routes/site.route.rs:77`) does not have. Two policies in one repo, and the stricter one discards nearly every Mongo diagnostic — the opposite of what the coordinator asked to retain. Align with the slice-2a shape and redact the customer id, owner id and channel id explicitly at the call site.
3. **Malformed-body ordering.** Axum's gate runs before body rejection, unlike Express's app-level `express.json()`. Keep it documented, but replay the malformed case in the AUTHENTICATED context (both sides 400) so the comparison is like-for-like, and record the unauthenticated 401-vs-400 difference explicitly.

### Coverage rule for the handoff
The claim that counts is **the number of oracle cases actually replayed against the native routers**, not the case count. The handoff must state both.

---

## 2026-10-31T03:05Z — slice 6 (tl1-c4 paid-order reward) → READY, and central patch v2

The `applyPaidOrderReward` native concrete adapter is authored and reviewed against the TypeScript source. It is the adapter team1-billing-ai's `applyPolarRewardDomainEvent` needs; team1 keeps the consumer and does not re-implement reward granting.

### Verified correct by lead review
- Step order matches `paid_order_reward.ts` exactly: order-id validation → index install → existing-reservation short-circuit → zero-amount early return → legacy guard → owner lookup → beneficiary resolution → reserve → applied short-circuit → atomic credit → finalize.
- The journaled `{w: 1, j: true}` write concern is applied **explicitly per operation** on exactly the three source writes, because neither `credit_transaction` nor `users` declares `write_concern_journaled` and `native_collection()` therefore does not journal on its own.
- `ReturnDocument::After` reproduces Mongoose's `new: true` on both find-and-modify calls.
- `setDefaultsOnInsert` is reproduced faithfully: `$setOnInsert.balanceAfter: null`, `createdAt` in `$setOnInsert` and `updatedAt` in `$set` for the credit transaction, while the users write uses the users schema's own `created_at`/`updated_at` field names (verified at `src/schemas/users.schema.rs:37` against the TS `timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }`). No `_id` and no `__v` are seeded, and `appliedAt` stays absent so the finalizing `$exists: false` filter matches.
- Duplicate-key detection is by numeric code 11000 across `Command`, `Write(WriteError)`, `BulkWrite` and `InsertMany` — never by message text.
- The `$ne` against the `applied_credit_transaction_ids` array is kept verbatim.
- `balanceAfter` is written only when the increment returned a document, so a replay never rewrites it.
- `metadata.referralCodeUsed` carries the payer's **raw** value and is `null` when unset (the lowercased value is used only for the referral-code lookup, as in the source).
- Amounts round-trip through `bson_compat::js_number`, which reproduces the Node BSON writer's rule that an integral value in Int32 range is written as Int32 — not always Double.
- The reward table, plan resolution, cadence type and all three schemas are **reused** from `utils::referral` and `schemas::*`; nothing was copied.

### The feature name was corrected by evidence, not by guesswork
The brief suggested `referral`. The implementer found team1's own wave-2C handoff (`migration-notes/team1-wave2-c-handoff.md:54`), which names it `referral-service = ["application-schemas", "mongo", "billing-service", "js-date", "dep:sha2"]`, and used that instead, flagging that team1 must confirm or rename it. The proposed line is therefore `paid-order-reward = ["application-schemas", "referral-service"]`.

### Blocking dependency (named, not hidden)
The adapter imports `crate::utils::referral`, `crate::utils::referral_ledger` and `crate::schemas::referral_code`. None of those are declared in the current central files, so **this slice cannot compile until team1's wave-2C central snippets land**. Local feature coverage is complete; total migration completion for the Polar reward path is not, and the blocker is named: team1-billing-ai's `referral-service` feature plus the three module registrations.

### Central patch v2 published
`ready/team2-api-data-central-20261031.v2.patch` — sha256 `860cc177b6b56b311644f165acd73683a7a70cb28304ad4c9b456a8e9f164d89` — now covers slices **2a, 3, 4a and 6**. Generated mechanically from awk-applied edits after asserting every anchor is unique; every hunk count is correct; `git apply --check` exits 0 for all four files; the central files remain unmodified. The header names team1's prerequisite explicitly, including the fact that team1's snippets are position-agnostic and therefore cannot conflict with the line-anchored hunks here. v1 is retained, renamed `.v1.patch`, and still applies cleanly for its 2a+3+4a subset.

### The seam team1 binds to
```rust
pub type PaidOrderRewardFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), PaidOrderRewardError>> + Send + 'a>>;

pub trait PaidOrderRewardApplier: Send + Sync {
    fn apply<'a>(&'a self, input: &'a PaidOrderRewardInput) -> PaidOrderRewardFuture<'a>;
}
```
`PaidOrderRewardService::new(Database)` implements it, and `apply_paid_order_reward<A: PaidOrderRewardApplier + ?Sized>(&A, &PaidOrderRewardInput)` accepts both `&Concrete` and `&dyn`. team1's existing `PolarRewardApplier` seam types `cadence: String`; the handoff provides a one-call bridge via `PaidOrderRewardInput::from_cadence_str`, and `parse_cadence` accepts only the TypeScript union `'monthly' | 'yearly'` so a `"Monthly"` caller errors instead of silently getting FREE-plan behaviour.

### Tests authored, not executed
17 pure tests (no Mongo/Redis/network) plus one `#[ignore]` disposable-Mongo suite gated on `PAID_ORDER_REWARD_TEST_MONGO_URI` / `PAID_ORDER_REWARD_TEST_DATABASE` (which must start with `rust_paid_order_reward_fixture_` and is asserted empty before writing). The handoff states plainly that the driver-error extraction inside `is_duplicate_key` cannot be unit-tested because `mongodb::error::Error` has private fields and no public constructor — an honest untested-by-construction boundary, with the numeric predicate it delegates to covered.

---

## 2026-10-31T03:20Z — slice 4b turn 10: items closed, replay blocked on an architectural mismatch

Turn 10 closed all three residual review items: bracketed query handling now covers object keys and simple arrays (complex `qs` merges remain a documented boundary), the redaction policy is aligned with the slice-2a site-route policy plus an explicit replacement of request-scoped channel, requester and customer identifiers before logging, and the malformed-body ordering difference is documented. The fixture reader now uses the existing dependency-free SHA-256 helper. The merged patch's static SHA-256 was confirmed to match.

The worker reported **2 of 28 oracle cases** replayed against the native router, and diagnosed the blocker correctly: the source oracle stubs a successful timeline as `{points: []}` while the concrete native data service returns a full timeline document with a dynamic `asOf`, so the two cannot be compared faithfully.

### Root cause (verified against the source and the native)
The source oracle stubs **seven** boundaries: `utils/stream_timeline.js` (the three timeline functions), `schemas/users.schema.js` (owner lookup), `schemas/stream_activity.schema.js` (the `people` aggregate read), `schemas/ai_usage_receipt.schema.js` (the `credits` read), `schemas/stream_timeline.schema.js` (`StreamMarkerSchema` — the `moments` read and the PUT/DELETE marker writes), `schemas/admin.schema.js` (the admin access decisions) and `schemas/follow_relationship_ledger.schema.js` (the analytics `follows` read).

The native route hard-wires **every one of them**: `stream_timeline.route.rs:158` (users owner lookup), `:210`/`:221`/`:281` (`stream_timeline` markers), `:252` (`stream_activity` aggregates), `:296` (`ai_usage_receipt`), plus the concrete `StreamTimelineService`, the `AdminService` access decisions, and `follow_relationship_ledger` in `analytics.route.rs`.

The source's seam set and the native's seam set did not match, so no amount of fixture work could make the comparison faithful.

### Resolution: give the native route the seam the source has
Turn 11 directs an injectable data-access seam in the native route layer covering the union of all seven stubbed boundaries, with the real implementation as the default so the production path, its filters, sorts, limits, `max_time` and journaled write concern are unchanged. `StreamTimelineRouteService::new(database, admin, logger)` must keep wiring the real implementations.

This resolves both symptoms at once: per-case isolation becomes trivial (each case gets its own double seeded from the recorded case — no per-case database to create, seed and drop), and the `asOf` mismatch disappears because the double returns exactly what the source recorded.

### Rejected alternative, and why it matters
The alternative — making the source oracle use the real TypeScript data service against a live Mongo — was explicitly rejected. It turns the fixture into a full-stack test, makes it depend on live DB state, and destroys the property that makes the oracle valuable: a static, deterministic, diffable artifact.

### Generalisable migration rule
**A route-layer oracle requires the native route to expose the same seam set the source oracle stubs.** A native that hard-wires its data access can never be compared against a stubbed source. This composes with the data-layer slice rather than competing with it: the data layer is verified against a disposable Mongo plus its own source oracle (slice 4a completion, running), while the route layer is verified against the source's stubbed data (slice 4b). Together they cover the path, and neither needs the other's Mongo.

---

## 2026-10-31T03:35Z — slice 4b turn 11: seams landed, 28/28 replay authored; one oracle defect found

Turn 11 delivered the seam architecture. The injectable `TimelineRouteData`, `SummaryRouteData` and `AnalyticsRouteData` traits cover the union of the oracle's stubbed boundaries (timeline service, owner, activity aggregate, receipt, marker, admin, follow-ledger, summary data, streamer metadata), and the default constructors still select the concrete MongoDB, admin, timeline and streamer adapters — so the production path is unchanged. Each of the 28 oracle cases receives its own double, so per-case isolation needed no Mongo. Replay coverage: **28 of 28 authored, 0 executed.**

### The remaining defect was in the ORACLE, not the native
The worker flagged an authentication-boundary difference for integration review. Lead verification against the source settled it in the opposite direction from the worker's initial framing:

- The oracle stubs `middleware/auth.middleware.js` with a **pass-through** (`tests/fixtures/stream_timeline_routes_reference.cjs:21`) that always calls `next()`.
- The **real** middleware does not: `src/middleware/auth.middleware.ts:188-196` answers `401 {error: true, message: 'No token provided', status: 401, type: 'no_token'}` for a missing or non-string `Authorization` header, and `:204-212` answers the same for a token that is empty after stripping `Bearer `.
- Therefore in the real source a request with no `Authorization` header **never reaches the route**; the route's own `if (!requesterID) fail(res, 401, 'Authentication required')` is a defensive fallback the real middleware makes unreachable.
- The **native is already faithful**: `src/middleware/auth.middleware.rs` produces exactly `{"error": true, "message": "No token provided", "status": 401, "type": "no_token"}` for a missing header and for an empty token (its own `error_bodies_match_the_source_json` at `:769-774` and `extract_bearer_token` assertions at `:751-760`), with the same field order as the source.

The worker's replay had been working around the oracle's wrongness by using the **unprotected** builder for the missing-identity case, which loses the production path and hides the divergence.

### Turn 12 instruction
Fix the oracle's auth stub to mirror the real middleware (reject a missing/empty token with the `no_token` envelope and do not call `next()`), re-record the missing-auth case with no `Authorization` header, and replay it through the native's **protected router** so the production path is compared on both sides. The route-level "Authentication required" branch is unreachable-from-source defensive code and moves to a native gate-ordering test rather than remaining a source-comparison case built on a stub artifact. The same reasoning applies to the summary and analytics routers, whose middleware 401 carries `type: 'no_token'` while their own route-level fallback does not.

### Generalisable migration rule (second oracle lesson)
**An oracle's stub for a middleware must reproduce that middleware's REJECTION behaviour, not only its happy path.** A pass-through stub silently changes the source's observable behaviour and forces the comparison onto an unrealistic path — here it made the source produce a route-level fallback envelope that the real source can never produce, and it forced the native onto an unprotected builder it never uses in production.

---

## 2026-10-31T03:50Z — slice 1 (OAuth desktop-beta API): route inventory verified complete, four gaps issued

The OAuth desktop-beta HTTP API is authored across 7 files (3,891 lines). Lead review against the TypeScript source:

### Verified correct
- **Route inventory matches the source exactly on both routers.** `oauthRoute` (`src/server/oauth/routes.ts`) registers GET `/metadata`, `/authorize`, `/requests/:request`, POST `/requests/:request/decision`, POST `/token`, POST `/revoke`, GET `/browser-session`, `/connections`, DELETE `/connections/:session`, DELETE `/grants/:grant` — identical to `public_routes()` (`routes.rs:117-133`). `oauthApiRoute` registers GET `/me`, `/me/credits`, `/me/pet`, `/me/pet/runtime`, PUT `/me/pet/playback`, POST `/me/pet/requests/:requestId/cancel`, GET+DELETE `/desktop/session` — identical to `desktop_routes()` (`:135-148`).
- **The 404 handling is more precise than the source requires.** The source ends each router with `use((_req,res) => res.status(404).json({error:'not_found'}))`. The native covers an unmatched *path* with `Router::fallback(not_found)` (`:111`) and an unmatched *method* on a matched path with `MethodRouter::fallback(not_found)` via `matched()` (`:154`).
- **Both worker uncertainties resolved against the local crate checkout.** `MethodRouter::fallback` exists at `axum-0.8.9/src/routing/method_routing.rs:654`; `ConnectInfo<T>(pub T)` at `axum-0.8.9/src/extract/connect_info.rs:151`. No change needed.
- **Both central hunks are arithmetically correct** — Cargo.toml 6 context → 7, lib.rs 3 → 7 — and the lib.rs anchor resolves at `src/lib.rs:108-110`.
- **Scope-before-adapter ordering matches the source** (`oauthApiRoute.use(...)` at `routes.ts:174` precedes the handlers, so a missing scope is 403 before any adapter call).

### Gaps issued (turn 2)
1. **`src/server/oauth/desktop-websocket.ts` is unported — and it is team2's own file** (`manifest.sourceOwners` → team2-api-data). The native metadata advertises `websocket_endpoint: ws://…/v1/desktop/ws` (`catalog.rs:543`) and nothing serves it, so a desktop client that reads the metadata connects to a dead endpoint. This is a functional defect, not merely a missing feature. Directed as a native port: the native server is axum-based (`src/server/websocket.rs:74`) and `axum/ws` already exists as a Cargo feature, so a `WebSocketUpgrade` route on the desktop router (path `/desktop/ws` inside the `/v1` nest) can reproduce the source's 426 (protocol), 403 (query/origin), 401 (auth) and 429 (too many connections per session) rejections, the 4096-byte payload cap, the heartbeat that closes with 4401, and the per-message handling.
   The `/desktop` **Socket.IO** namespace in the metadata is **team4's** — the TypeScript registers it in `src/pets/socket.ts`, not in the OAuth tree — so it is advertised but explicitly left to team4.
2. **`src/utils/oauth_debug_cache.ts` has no native sibling but is covered by reuse** — `cacheOAuthAPIFailure` via `src/utils/twitch.rs` plus slice 3's concrete `cache_oauth_api_failure`, and `cacheOAuthTokenRefreshFailure` via `utils/twitch.rs`'s `refresh_failure_message` / `classify_refresh_failure` / `refresh_failure_diagnostic`. To be recorded as *covered by reuse, not duplicated*: a missing `.rs` sibling for an owned TS row is not automatically a gap when the behaviour already exists elsewhere.
3. **No source oracle.** The slice has 583 lines of native tests and 171 lines of support but no `.cjs` comparison fixture, which is the coordinator's explicit standard for the other slices. Directed to author a lean one covering the comparisons that need no Mongo state: the exact `/metadata` document, the error envelopes, the `/token` grant-type dispatch, the scope/boundary ordering and the `not_found` fallback — and to name honestly which Mongo-backed flows are not source-comparable and why.
4. **The `503 temporarily_unavailable` envelope is an invention** — the source always calls the real implementation. Keep it, but label it an adapter-boundary convention rather than source parity, and record that with the adapters wired the endpoint returns the adapter's value.

### Central wiring
The worker's `Cargo.toml` feature inserts at the same anchor as the 2a/4a/6 features and its `lib.rs` hunk touches the same file as mine, so both must be merged into the central patch rather than applied separately. The feature line will need `axum/ws` once the websocket is ported.

---

## 2026-10-31T04:10Z — slice 4b READY: turn 12 closed the oracle auth defect; published

Turn 12 fixed the defect the lead review found in turn 11 — the defect was in the **oracle**, not the native.

### Verification performed by the lead on turn 12's output
- **The oracle's auth stub now mirrors the real middleware.** `tests/fixtures/stream_timeline_routes_reference.cjs:21-36` reproduces `src/middleware/auth.middleware.ts:188-212` exactly: a missing or non-string `Authorization` header returns `401 {error:true, message:'No token provided', status:401, type:'no_token'}` **without calling `next()`**, and the same envelope is returned for a token that is empty after stripping `Bearer `. The source comment at `:21-22` cites the exact source lines.
- **The native envelope matches, field for field.** `src/middleware/types.rs:130-153` — `ErrorResponse` serialises `{error, message, status, type}` in that order and `no_token()` carries exactly `("No token provided", 401, "no_token")`. The native's own `error_bodies_match_the_source_json` test (`src/middleware/auth.middleware.rs:769-774`) already asserts that body.
- **The replay now uses the production path.** `tests/stream_timeline_routes.rs:82,86,89` mounts every case through `protected_router(&auth)`; no case uses an unprotected builder any more. The exact 401 body is asserted at `:96`, `:117`, `:155` and `:174`.
- **Three routers are covered by the protected check**, not one: the summary and follows routers get an extra missing-token assertion at `:92-97`.

### Honest limitations the handoff records (not defects)
- The external fixture must be **re-recorded by integration**; the older recording still holds the pass-through auth response. The `.cjs` generator needs the integration toolchain (Node 24.22.1 + the project's Express/Mongoose).
- Express adds a `charset` parameter to the JSON content type while Axum's `Json` emits `application/json`; the replay compares the media type on both sides for the auth rejection instead of the raw header string.
- The unauthenticated malformed-body ordering difference is retained deliberately: Express's app-level body parser answers 400 before auth, while the native's context extractor runs before the body extractor and can answer 401 first.

### Files (all owned by team2-api-data; no central path touched)
| File | Lines | SHA-256 |
| --- | ---: | --- |
| `dimabot/src/server/routes/stream_timeline.route.rs` | 343 | `f46a1254d9ef94638fecda1d4bf556107418aa395eeccae971d902a6389e719d` |
| `dimabot/src/server/routes/stream_summary.route.rs` | 81 | `a1e9577722ba779a327d41325a6b65324de74d165d03757f071b40bd5e22bea7` |
| `dimabot/src/server/routes/analytics.route.rs` | 78 | `c5a8fd30c9fded694418d3533b1aa51137d2680fdac6968f7a738892add20385` |
| `dimabot/tests/stream_timeline_routes.rs` | 175 | `3627e87538d036d777330aa39841c0e2092804a9f13c6bd50c187cc7e2f7da03` |
| `dimabot/tests/support/stream_timeline_routes_support.rs` | 72 | `e0c3f7ee7b0aaee981da226770f9fb3c4d8f2014a1de21eb6827a57c614be770` |
| `dimabot/tests/fixtures/stream_timeline_routes_reference.cjs` | 119 | `d0e6a39849d432d4b2ba9f5358b4dd028fa3042cc38a3b2ebc95094d1735c00b` |
| `migration-notes/stream-timeline-routes-handoff.md` | 193 | `c7a919cf25fb2d5d45acc4d6be55ab40c1244f2794e06c652d4e3991dfbc0aa5` |

Handoff published to `ready/team2-api-data-slice-4b-stream-timeline-routes.md` and `results/team2-api-data-slice-4b-stream-timeline-routes.md`, both sha `c7a919cf25fb2d5d45acc4d6be55ab40c1244f2794e06c652d4e3991dfbc0aa5`.

### Central patch
Feature line `stream-timeline-routes = ["http", "api-auth", "api-admin", "stream-timeline-data", "follow-ledger-data", "ordinary-application-schemas", "logger-redis", "bson-js-json", "axum/query", "dep:serde_json"]` plus three `src/lib.rs` module registrations. Both anchors collide with the already-published slices, so they must land in the **single merged central patch v3** — not as a separate hunk.

### Coverage claim (stated separately, as required)
Oracle cases specified: **28**. Newly recorded: **0**. Native-router replay cases authored: **28 of 28**. Executed: **0**.

### Remaining gaps carried by the handoff
Concrete default adapters and all replay cases unverified; no whole-request deadline on the gate's owner lookup and admin calls; query parsing is lenient and does not reproduce every `qs` merge; cursor parsing/serialisation and marker time arithmetic need source-backed edge checks; the marker malformed-body response is JSON 400 rather than Express's HTML 400; marker update uses a raw driver upsert without Mongoose casting or schema defaults.

**NOT VERIFIED — nothing was compiled, formatted, executed or deployed.**

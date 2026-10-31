# Stream timeline data handoff (slice 4a)

**Status: authored only. NOT VERIFIED — nothing here was compiled, formatted,
executed, generated or deployed by this lane.** The integration team owns every
build, fixture generation and Mongo run. The TypeScript implementation remains
active; deployment and caller adoption are separate.

Contents

1. What changed in this pass
2. The actual-source oracle
3. Private MongoDB inventory (mapped to the four required behaviours)
4. Defects found and fixed, with source evidence
5. Redis finding
6. Remaining gaps and documented boundaries
7. Proposed central patches (not applied)
8. Route-data access need (not applied)
9. Process note

## 1. What changed in this pass

The earlier slice-4a delivery contained ten pure tests over document builders.
They never touched a database and never compared against the real source. This
pass adds:

- `tests/fixtures/stream-timeline-data-reference.cjs` — the lean
  actual-source comparison oracle.
- `tests/support/stream_timeline_data_support.rs` — the digest-checked reader,
  BSON document comparison helpers and the shared disposable MongoDB harness.
- `tests/support/stream_timeline_route_data_mongo.rs` — the concrete
  `MongoTimelineRouteData` insert/dedupe/delete and row-readback suites.
- Seven `#[ignore]`d private MongoDB suites in `tests/stream_timeline_data.rs`
  plus the oracle replay test; the ten original pure tests are unchanged except
  for the coverage-update document, which gained its timestamps field.
- Three behaviour fixes in the native data layer (section 4), and small pure
  extraction refactors so query documents can be compared without a database:
  `read::activity_filters`/`ActivityFilters` and read constants,
  `utils::stream_timeline::{timeline_filters, TimelineFilters,
  streams_page_filter, session_row_filter, redemption_marker_upsert}`, and
  `build_timeline` made public.

Functional parity only. No benchmarks, no performance work, no
micro-optimisation.

## 2. The actual-source oracle

`dimabot/tests/fixtures/stream-timeline-data-reference.cjs`

Purpose: pin the real TypeScript sources, transpile them, run them against the
pinned installed Mongoose with **only** the driver boundary doubled
(`collection.updateOne`, `collection.findOne`, `collection.find`), and record

- the exact filter, update and options document handed to the driver, as BSON
  (`BSON.serialize(value, resolveBSONOptions({}))`, `ignoreUndefined: false`),
  hexadecimal;
- the synthetic documents each stubbed read returned (also BSON hex), so the
  native side can replay the identical stored data;
- the source's own output as `JSON.stringify(result)` text, verified with
  `utils::bson_js_json` (the existing `JSON.stringify` view of BSON).

Everything else is real source: the schemas, Mongoose casting,
`setDefaultsOnInsert`, the `timestamps` pre-hooks and the output construction.
`connect`/`createConnection`/`openUri`, every socket, TLS, DNS, HTTP and `fetch`
entry point throw a recorder-visible guard, so the oracle cannot reach a live
service, credential or network.

Contract

```text
node tests/fixtures/stream-timeline-data-reference.cjs --write <absolute-empty-dir>   # exclusive create
node tests/fixtures/stream-timeline-data-reference.cjs --check <absolute-dir>        # byte-for-byte
```

The `--write` directory must be empty; `--check` asserts the directory contains
exactly `stream-timeline-data-reference.json`. Both modes reject a directory
inside the workspace.

Native consumer: `tests/support/stream_timeline_data_support.rs::fixture()`
reads `DIMA_STREAM_TIMELINE_DATA_FIXTURE_DIR` (absolute, canonical, outside the
workspace), verifies `DIMA_STREAM_TIMELINE_DATA_FIXTURE_SHA256` (lowercase hex)
with the dependency-free `tests/support/sha256.rs`, and only then parses the
JSON. This mirrors `tests/support/api_auth_support.rs` and
`stream_timeline_routes_support.rs`.

Pinned TypeScript sources (asserted by the fixture, not just recorded):

| File | SHA-256 |
|---|---|
| `src/utils/stream_activity.ts` | `8f4ee872e777eb41979052d3be838c5ad353fd8ce45af18478d4e9d699e97a09` |
| `src/utils/stream_timeline.ts` | `3ba05d66bc26438c507501706e1d7633c4cd1c8bc3b74322cf353c07632f060d` |
| `src/schemas/stream_activity.schema.ts` | `d45de640b797491417845f1918b2ef7cb3d67ddb3836e1c8685f87322a9fb287` |
| `src/schemas/stream_timeline.schema.ts` | `d677d8e525466b4e30df8341176ca40a09490adb9e315c17a71c8de1541ba347` |
| `src/schemas/stream_session.schema.ts` | `d0394d2fb7ba43b1a90758d4fa1ac4849ea15f6410c9a18e28e687f97ad81026` |
| `src/schemas/stream_viewer_snapshot.schema.ts` | `8e03cbb6c859709405f4c02d4ed57fb8f6ee81a0af3241b3a6dc3d846344f862` |
| `src/schemas/domain_event.schema.ts` | `b73e7918e8cb43dc8bff85b8bab082a875de9b61b45852f7f8acf34ace593d25` |

Also pinned: `package.json`, `package-lock.json`, `rust-toolchain.toml`,
`typescript/lib/typescript.js`, `typescript/package.json`,
`mongoose/package.json`; exact versions asserted (Node `v24.22.1`, V8
`13.6.233.17-node.58`, TypeScript `5.9.3`, Mongoose `8.24.2`, BSON `6.10.4`).
Native and test hashes are deliberately **not** recorded, so fixing native code
does not invalidate the source oracle.

39 cases: 18 capture, 6 participant, 2 moment, 4 redemption, 4 activity read,
3 timeline read, 1 stream list, 1 session lookup. Each case records `now` and
the Mongoose clock separately, so the participant case proves which clock writes
`updated_at`.

Comparison rules

- Driver documents are decoded with the real BSON codec
  (`Document::from_reader`) and compared as `Document`, so Int32 versus Double,
  dates, ObjectIds, nulls and arrays are exact.
- Object key order is canonicalised before comparison (recursively; array order
  is preserved). MongoDB update/query documents are key-order-insensitive, while
  the native schema constructor emits declaration order and Mongoose appends
  `setDefaultsOnInsert` fields. Types and values are never relaxed.
- Outputs are compared as text through `bson_js_json`, which reproduces
  `JSON.stringify` (dates as ISO, `undefined` keys dropped, numbers as
  ECMAScript `Number#toString`). No number/date encoder is reimplemented in this
  lane; `js_string`, `js_number`, `json_number` and `js_date` are used by the
  production code paths where the source coerces, and the oracle avoids
  re-creating them.

## 3. Private MongoDB inventory

Environment contract (same naming as `FOLLOW_LEDGER_TEST_*`):

```text
STREAM_TIMELINE_TEST_MONGO_URI=mongodb://127.0.0.1:27017
STREAM_TIMELINE_TEST_MONGO_DATABASE=rust_stream_timeline_fixture_<unique>
STREAM_TIMELINE_TEST_MONGO_ACK=disposable
```

Each suite appends its own suffix to `..._DATABASE`, asserts the derived name
keeps the `rust_stream_timeline_fixture_` prefix, asserts the database lists no
collections, and drops exactly that database afterwards (also on failure). No
suite runs without `..._ACK=disposable`. Every suite is `#[ignore]`d.

| Suite (`tests/stream_timeline_data.rs`) | Behaviour |
|---|---|
| `capture_dedupe_and_upsert_defaults_against_disposable_mongo` | 1 — capture dedupe and upsert defaults |
| `duplicate_key_is_swallowed_by_code_against_disposable_mongo` | 1 — the real 11000 path |
| `reader_retention_buckets_and_limits_against_disposable_mongo` | 2 — read queries, retention and cursors |
| `timeline_queries_and_marker_cursor_against_disposable_mongo` | 2 — timeline queries, cursor, paging |
| `participant_timestamp_update_against_disposable_mongo` | 3 — participant timestamp update |
| `capture_failure_leaves_no_partial_write_against_disposable_mongo` | 4 — failure, no partial write |
| `capture_cancellation_does_not_replay_into_duplicate_against_disposable_mongo` | 4 — cancellation, no replay |

Behaviour 1 — capture dedupe and defaults. Seeds a session, captures the same
event twice through `StreamActivityCapture::capture_at`, and asserts one row
whose `_id` is the source dedupe hash and whose stored document carries
`processed: false`, `dashboardProcessed: null`, `key`/`label`/`actor`/
`actorLabel: ""`, `outcome: "ok"`, `value: Int32(1)`, a fractional `offset` as
Double and `expiresAt = occurredAt + 90 days`. A second event id inserts a
second row. The duplicate suite installs a unique index the schema does not
declare so a *different* event id collides on the server; `capture_at` must
return `Ok(())` because the driver reports code 11000.

Behaviour 2 — reads, retention and cursors. Seeds a live summary, an expired
summary, a foreign-session summary, 22 rank rows including a zero count, 2001
chart rows plus a `bucket: -1` row, and processed/expired/unprocessed activity
receipts. Asserts the live totals only, the 20-row rank limit with descending
counts, the free/pro tier differences, 2000 capped points with `truncated:
true`, first/last `offsetSeconds`, and `pending`. The timeline suite seeds
snapshots inside and outside the session window, one live and one expired raid
domain event, 101 live markers (second precision) plus an expired one, a
redemption marker, and three live plus one expired participant receipt.
Asserts points, game/title change events, the raid label/value, the redemption
fields, `markerPage.hasMore`, a cursor containing `.000Z|`, `momentsPartial`,
chatter bucket counts and `retentionDays`. It then seeds 21 retained sessions,
one out-of-retention session and one other-channel session, and asserts page 1
(20 rows, `hasMore`), page 2 (remainder, no `hasMore`), newest-first order,
retention exclusion, channel scoping, the `page` echo, `get_timeline_session`
success/None-wrong-channel/`Err(Validation)`-for-a-bad-id, and a same-session
`get_timeline_session` hit.

Behaviour 3 — participant timestamp update. Seeds a session with
`created_at`/`updated_at` an hour old, records a later receipt then an earlier
one for the same user, and asserts `chat_tracking_started_at` equals the receipt
time (`$min` keeps the earliest) while `updated_at` is refreshed past the seeded
value on every call and `created_at` is untouched. Receipts for the same user
and bucket stay one row; another user adds a row; the bot account, an empty user
and a pre-start timestamp write nothing.

Behaviour 4 — failure and cancellation. A server-side `$jsonSchema` validator no
activity write can satisfy makes the upsert insert fail; `capture_at` must
return `Err(Runtime)` and leave zero documents. Cancellation runs `capture_at`
under a one-nanosecond deadline, asserts at most one (complete) row afterwards,
then retries twice and asserts exactly one row; a second event id follows the
same path and ends at two rows, one per receipt id.

`tests/support/stream_timeline_route_data_mongo.rs` adds two suites that drive
the shipped concrete adapter, not a reimplementation:

| Suite | Coverage |
|---|---|
| `route_data_marker_insert_dedupe_delete_against_disposable_mongo` | `insert_marker` upsert (`$setOnInsert` reaches `stream_markers` unchanged), dedupe (a retried write with a different label keeps the first label and occurrence time), `rows(TimelineRows::Moments)` readback, `delete_marker` scoped by `_id`+channel+session+kind (wrong kind is a no-op, repeat delete is idempotent) |
| `route_data_rows_sort_and_limit_against_disposable_mongo` | `rows(TimelineRows::People)` = `{count: -1, _id: 1}`, 51 rows; `rows(TimelineRows::Credits)` = `{occurredAt: -1, entryId: -1}`, 101 rows, including the equal-timestamp `entryId` tie-break |

This module is included only under the slice-4b feature
(`#[cfg(feature = "stream-timeline-routes")]`), so it cannot break the 4a target
before those routes are registered. It needs the accessor in section 8.

## 4. Defects found and fixed, with source evidence

**D1 — negative zero in the captured `value`.** Source
`src/utils/stream_activity.ts:39` sends `value: Math.max(0, Number(input.value
?? 1))`. `Math.max(0, -0)` is `+0`, and the Node BSON writer encodes `-0` as
`Double(-0)` while `+0` becomes `Int32(0)`
(`node_modules/bson/lib/bson.cjs:3468` `serializeNumber` branches on
`Object.is(value, -0)`). `capture::activity_value` used `n.max(0.0)`, whose
result for `-0.0` is not specified to be `+0`, so a `-0` input could have been
stored as `Double(-0)` where the source stores `Int32(0)`. Fixed with an
explicit comparison; the oracle case `capture-negative-zero-value` pins it.

**D2 — marker cursor used an RFC 3339 timestamp instead of `toISOString()`.**
Source `src/utils/stream_timeline.ts:123` builds
`` `${markers[99].occurredAt.toISOString()}|${markers[99]._id}` ``.
`Date.prototype.toISOString` always prints three fractional digits, while
`bson::DateTime::try_to_rfc3339_string` uses `time`'s RFC 3339 formatter, which
omits a zero fraction (and trims trailing zeros). A marker on a whole second
therefore produced `...:40Z` instead of `...:40.000Z`, a different cursor string.
Replaced with `utils::credit_policy::JsDate::from_millis(..).to_iso_string()`,
the existing JavaScript ISO formatter. The oracle case
`timeline-marker-cursor` and the Mongo cursor assertion both pin `.000Z`.

**D3 — session coverage update omitted the timestamps `$setOnInsert`.**
`stream_session.schema.ts` enables `timestamps`, and
`StreamSessionSchema.updateOne(..., {$min: {...}})` therefore passes through
`setupTimestamps`' `pre('updateOne')` →
`applyTimestampsToUpdate` (`node_modules/mongoose/lib/helpers/update/applyTimestampsToUpdate.js`),
which adds `$set.updated_at` *and* `$setOnInsert.created_at`.
`participant_coverage_update` produced only `$min` and `$set`. Added
`$setOnInsert: {created_at: updated_at}` (the same clock value Mongoose uses).
It is inert for a non-upsert update, but it makes the documented,
document-by-document comparison exact; the output never depended on it.

The following are **not** defects and were left alone: the shared schema
`construct` validators reject a message/command marker `kind` and an empty
marker label where the source's `updateOne` (validators off) would write them.
The only `recordTimelineMoment` caller passes follow/sub/gift/bits/raid
(`src/domain_events/stream_analytics_events.ts:45-56`), and Twitch rewards
always carry a title, so the divergence is unreachable from current callers. A
NaN `value` is likewise rejected by the number cast while the source would store
`NaN`; every caller guards with `Number.isFinite` or a non-negative check.

## 5. Redis finding

Verified by inspection: `src/utils/stream_activity.ts`,
`src/utils/stream_timeline.ts`, the three schemas, and the native
`capture.rs`/`read.rs`/`stream_timeline.rs` contain **no** `redis`, cache, lock
or queue usage. The native types hold only a `Database` and a deadline. There is
no Redis path in this slice to test, so Mongo-only coverage is complete for the
slice-4a data layer. Do not add invented Redis cases. (This is why the earlier
proposal's `stream-timeline-data = [.. "redis" ..]` is dropped in section 7.)

## 6. Remaining gaps and documented boundaries

- **Nothing was compiled or run by this lane.** Every Rust file below is
  authored, unformatted and unverified; the fixture has never been generated.
  Expect integration to fix compile-level details before the first run.
- The oracle asserts exact Mongoose internals observed at authoring time
  (`_optionsForExec` option shape, `setDefaultsOnInsert`, timestamps hooks). If
  an option key differs at generation, the fixture fails loudly rather than
  silently recording something else.
- Activity/participant/marker `$setOnInsert` field order is not compared; the
  comparison canonicalises keys. Values, types and arrays are exact.
- Documents missing schema-guaranteed fields diverge: Mongoose lean reads yield
  `undefined` (key dropped from JSON) while the native projections emit `null`
  or `0`. Every stored document in the Mongo suites is contract-complete,
  because `viewers` is required and `title`/`game_name`/`messages`/`commands`
  have schema defaults. Legacy documents written before those defaults existed
  are out of contract.
- `listTimelineStreams` page 0 is a typed native validation error, while the
  source would send a negative skip to MongoDB. Route-level input conversion is
  slice 4b's.
- Typed Rust inputs do not reproduce every JavaScript coercion
  (`bounded(String(value))`, numeric strings, `Date.now()` being read twice in
  the source's time window). These are documented typed boundaries, unchanged
  from the previous handoff.
- `channel_stream_summary.schema.rs` has no adapter in this slice (the
  stream-offline worker writes it), so it keeps only the pure schema tests.
- Route-data suites need the accessor and module registration in sections 7–8
  before they can compile.

## 7. Proposed central patches (not applied)

Every name below already exists in the current manifest. Context lines were
re-read from the tree in this pass and the hunk counts match the lines shown.

```diff
--- a/dimabot/Cargo.toml
+++ b/dimabot/Cargo.toml
@@ -94,3 +94,4 @@
 bson-js-json = ["mongo", "tts-utilities", "credit-policy", "dep:base64", "dep:sha2"]
+stream-timeline-data = ["mongo", "application-schemas", "bson-js-json", "dep:serde_json", "dep:sha2"]
 ai-usage-producer = ["ai-usage", "redis", "credit-policy", "tts-utilities"]
 ai-usage-lock = ["redis", "tts-utilities", "dep:sha2", "dep:uuid"]
```

`bson-js-json` is required: the replay test uses `utils::bson_js_json`, and the
cursor fix uses `credit_policy::JsDate`, which that feature enables. `redis` is
not needed (section 5). `application-schemas` supplies the schema framework,
`js-date` and `js-strings`; `mongo` supplies the driver, `tokio` and `sha2`.

```diff
--- a/dimabot/src/utils/mod.rs
+++ b/dimabot/src/utils/mod.rs
@@ -226,4 +226,6 @@
 #[path = "tts/usage.rs"]
 pub mod tts_usage_pricing;
+#[cfg(feature = "stream-timeline-data")]
+pub mod stream_timeline;
 #[cfg(feature = "twitch-client")]
 pub mod twitch;
```

```diff
--- a/dimabot/src/schemas/mod.rs
+++ b/dimabot/src/schemas/mod.rs
@@ -129,3 +129,6 @@
 pub mod raid_subscription_preference;
+#[cfg(feature = "stream-timeline-data")]
+#[path = "channel_stream_summary.schema.rs"]
+pub mod channel_stream_summary;
 #[path = "stream_activity.schema.rs"]
 pub mod stream_activity;
```

`src/utils/stream_activity.rs` is already registered through
`src/workers/mod.rs`; its `capture`/`read` submodules are feature-gated in that
file. `stream_session`, `stream_timeline`, `stream_viewer_snapshot`,
`domain_event`, `ai_usage_receipt` and `admin` schemas are already registered.
No `manifests`/index list change is required: `channel_stream_summary` is not
part of `schema_definitions()`.

## 8. Route-data access need (slice-4b file, not applied)

`MongoTimelineRouteData` in `src/server/routes/stream_timeline.route.rs:124` is a
private struct, constructed only inside `StreamTimelineRouteService::new`
(`:159`); `TimelineRouteData`, `TimelineRows` and `new` are already public. There
is no way to reach the concrete adapter, so the lean Mongo suite needs exactly
one accessor — no new type exposure and no behavioural change:

```diff
--- a/dimabot/src/server/routes/stream_timeline.route.rs
+++ b/dimabot/src/server/routes/stream_timeline.route.rs
@@ -160,2 +160,3 @@
     pub fn with_data(mut self, data: Arc<dyn TimelineRouteData>) -> Self { self.data = data; self }
+    pub fn data(&self) -> Arc<dyn TimelineRouteData> { self.data.clone() }
     pub fn router(&self) -> Router {
```

`tests/support/stream_timeline_route_data_mongo.rs` also needs the slice-4b
module registered (`#[path = "server/routes/stream_timeline.route.rs"] pub mod
stream_timeline_route;` under the route feature) and the route feature to imply
`api-admin` (the service constructor takes `AdminService`). Both belong to the
route lane; the suite is compiled only when that feature is enabled, so 4a is
unaffected until then.

If the route lane prefers not to add an accessor, the alternative is exposing
`MongoTimelineRouteData` itself (`pub struct` plus
`pub fn new(database, admin, timeline)`), which is a larger surface.

## 9. Process note

This lane used read-only inspection plus static file edits, and an accidental
`node -p "1"` version probe in a shell inspection. It printed `1` and did not
load, compile, format or execute any project file, fixture or test. No fixture
was generated, no database was contacted, no Cargo/Node/npm/tsc command was
run, and nothing was committed, pushed or deployed.

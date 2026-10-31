# Raid subscriptions — authoring handoff

Slice `team2-slice-8-raid-subscriptions` of `team2-api-data`.
Workspace: `/root/saas-rust` (shared checkout). Authoring only: no Cargo,
rustfmt, Node, tests, Docker, network, installs or deployment were run, and
nothing was committed or pushed. Every statement below is a static
source-reading result, not an execution result.

## 0. Claim-path caveat

`claims/team2-api-data.json` **does not exist** at that path in this checkout
(a working-tree scan and the tracked-file list found no such file), so exact
claim membership could not be verified. Only the paths named or implied by the
task brief were created; no central or shared file was edited. If the lead holds
that file elsewhere, these five paths must be checked against it before
integration:

```
dimabot/src/utils/raid_subscriptions.rs
dimabot/tests/raid_subscriptions.rs
dimabot/tests/support/raid_subscriptions_support.rs
dimabot/tests/fixtures/raid_subscriptions_reference.cjs
migration-notes/raid-subscriptions-handoff.md
```

## 1. Scope and source mapping

| Source (TypeScript) | Native (this slice) |
|---|---|
| `dimabot/src/utils/raid_subscriptions.ts` (24 lines) | `dimabot/src/utils/raid_subscriptions.rs` |
| source behavior oracle | `dimabot/tests/fixtures/raid_subscriptions_reference.cjs` |
| oracle reader + disposable Mongo harness | `dimabot/tests/support/raid_subscriptions_support.rs` |
| checks | `dimabot/tests/raid_subscriptions.rs` |

Retired sources used only as oracle inputs:

* `archives/dimabot-typescript/2026-10-28/src/utils/raid_direction.ts`
* `archives/dimabot-typescript/2026-10-28/src/schemas/eventsub.schema.ts`

The live `dimabot/src/schemas/raid_subscription_preference.schema.ts` is loaded
unchanged by the oracle.

## 2. Traced callers (all still TypeScript)

| Caller | Use |
|---|---|
| `src/bot/eventsub.twitch.ts:170-171` | dynamic import of `acceptsRaidNotification` for every `channel.raid` notification; `204` on rejection |
| `src/utils/eventsub_reconciliation.ts:15,310-311` | `isRaidDeleted` skips deleted directions; `shouldRepairRaid` gates ledger repair |
| `src/server/routes/auth.route.ts:39,161,1459` | `shouldRepairRaid` gates reserved-subscription repair on login and channel (re)subscription |
| `src/server/routes/eventsub.route.ts:24,570,637-651` | `raidPreferenceID` for the preference **write** path (create, delete, and rollback) |
| `src/bot/eventsub.twitch.test.ts:14-15` | mocks the module named export `acceptsRaidNotification` |

No native caller exists yet, so this slice adds no call-site adoption. That is
reported as a gap, not as migration completeness.

## 3. Reuse (nothing re-ported)

* **Direction** — `crate::utils::eventsub::raid_direction_value` (and
  `RaidDirection`) is the existing native port of `raid_direction.ts`; the
  adapter calls it directly. `RAID_EVENT_TYPE` and `raid_direction_value` are
  reused; no second truthiness/outgoing rule is introduced.
* **Preference schema** — `crate::schemas::raid_subscription_preference::schema()`
  already exists and is already registered unconditionally in
  `src/schemas/mod.rs` (`definitions()`), so no schema registration patch is
  needed.
* **EventSub schema** — `crate::schemas::eventsub::collection()` is the existing
  native collection helper (feature `ordinary-application-schemas`). This slice
  reads it; it does not re-declare any field or index.
* **JS number text** — `crate::utils::json_number::number_string` for
  `String(number)` in the event channel coercion. `utils::json_number` is
  already enabled by `application-schemas`.

## 4. Behavior traced against the source

| Source | Native |
|---|---|
| `raidPreferenceID = `${channelID}:${direction}`` | `raid_preference_id` |
| `Preferences.exists({_id, deleted:true})`; Mongoose 8 `exists` = `findOne(filter).select({_id:1}).lean()` | `deleted_preference_filter` + `existence_projection`; `find_one(...).projection({_id:1})` |
| `Preferences.findById(id).lean()`; `deleted !== true` is strict | `preference_id_filter`; only stored `Bson::Boolean(true)` counts as deleted |
| `raidDirection(subscription.condition)` | `raid_direction_value(subscription.condition.as_ref())` |
| `String(event.from/to_broadcaster_user_id \|\| '')` | `notification_channel_id` with ECMAScript truthiness/`String` coercion |
| deletion check before the remote read | same order; a deleted preference performs no EventSub read |
| `Eventsub.findOne({channelID, type:'channel.raid', 'condition.<dir field>': channelID}).select('enabled id').maxTimeMS(1500).lean()` | `eventsub_config_filter`, `eventsub_config_projection`, `.max_time(1500 ms)` |
| `config.enabled !== false` | only a stored boolean `false` disables; a missing or non-boolean `enabled` is enabled |
| `!subscription.id \|\| config.id === subscription.id` | an absent or empty id skips the id check; otherwise an exact `id` string match |
| no config → `direction === 'incoming' && !subscription.id` | `accepts_config` |
| errors propagate to the caller | `RaidSubscriptionError::Mongo` (typed, `Display`, `source`) |

Constructor contract: `RaidSubscriptionStore::new(&Database)` only resolves two
collection handles (`native_collection` / `collection`). It does not connect,
create a collection, install an index, read data, or start a task. The
`#[ignore]` suite asserts the database is still empty immediately after
construction and after the first reads.

## 5. Adapter differences (deliberate, recorded)

1. **Typed error.** The source rejects with the driver's raw error. The native
   adapter wraps it in `RaidSubscriptionError::Mongo` so callers can distinguish
   a storage failure from `Ok(false)`. The driver error is preserved through
   `source()`.
2. **Projection shape.** `.select('enabled id')` is a Mongoose projection
   string; the native projection is `{enabled: 1, id: 1}`. The oracle records the
   source string and the replay compares the native document separately, so
   neither side silently redefines the other.
3. **Recorded config subset.** The oracle records the projection-equivalent
   `{enabled, id}` subset of the matched row (absent fields stay absent), because
   that is the only data the source decision can observe. It is not a claim that
   the EventSub document contains only those fields.
4. **No write path.** `src/utils/raid_subscriptions.ts` has no writes;
   `eventsub.route.ts` writes preferences directly with `updateOne` upserts,
   including an `operation` fence and rollback. That write policy is **not** in
   this slice and is listed as a missing transitive dependency below.

## 6. Source oracle

`tests/fixtures/raid_subscriptions_reference.cjs` transpiles and executes the
**real** `src/utils/raid_subscriptions.ts` with the real preference model and
the preserved archived EventSub model on a disconnected Mongoose instance. It
never contacts a database, cache, Twitch endpoint or network.

Boundaries (also embedded in the fixture's `boundaries` field):

* `raid_direction.ts` is retired; the archived actual source is loaded, and the
  native side is compared through `eventsub::raid_direction_value` rather than a
  copied predicate.
* `eventsub.schema.ts` is retired; the archived actual source builds the real
  Mongoose model. The fixture replaces only `Model.findOne` with a recorder plus
  an in-memory dotted-path matcher, so the recorded `.select`, `.maxTimeMS` and
  `.lean` arguments are exactly the source's, without reimplementing Mongoose
  casting.
* The live preference schema is loaded unchanged; `exists` and `findById` are
  recorders that keep Mongoose 8's existence (`findOne(filter).select({_id:1}).lean()`)
  and `.lean()` contracts.
* No event emitter, driver, BSON encoder, number rule or date formatter is
  reimplemented. Event payloads are plain JSON.
* The fixture pins TypeScript 5.9.3, Mongoose 8.24.2, BSON 6.10.4 and records the
  Node version (the repository currently runs Node 26.8.2, so Node is recorded,
  not asserted).

Case inventory: 7 deletion probes, 7 repair gates, 26 admission cases, 4 error
cases = **44**, all natively replayable. Error cases record the source read
ordering (a preference failure performs no EventSub read; an EventSub failure is
the last call) and their messages are source-side evidence only.

Run:

```text
node tests/fixtures/raid_subscriptions_reference.cjs --write <absolute-empty-dir>
node tests/fixtures/raid_subscriptions_reference.cjs --check <absolute-dir>
```

## 7. Private checks (`tests/raid_subscriptions.rs`)

Un-gated `#[test]` (no service or environment):

* preference id and both filters, including a multi-colon channel id;
* direction-scoped EventSub filter, projection, `1500 ms` bound;
* direction truth table through the shared policy (absent/empty/`false`/`0`/
  both fields), proving no local direction rule;
* event-channel coercion: missing/null/`false`/`0`/empty → no read; numbers,
  objects and arrays use ECMAScript `String`;
* the complete `accepts_config` branch table (default incoming, remote id
  without config, enabled `false` vs absent vs non-boolean, id match/mismatch,
  missing id with a subscription id).

`#[ignore]` oracle replay:

* `source_oracle_replays_the_typescript_policy` — verifies fixture/oracle/source
  digests, the 44-name inventory, then for every case compares direction, the
  deletion filter, the remote filter/projection/maxTimeMS, the recorded call
  order, and the native decision. Error cases assert the same read ordering.

Disposable MongoDB suites (never a production resource; unique
`rust_raid_subscriptions_fixture_` prefix, empty-database assertion, per-suite
suffix, drop only that database):

* `defaults_and_deleted_settings_against_disposable_mongo` — no constructor I/O;
  default incoming accepts, default outgoing rejects, remote id without config
  rejects; deleted rows block both directions and override a valid remote;
  `deleted:false`/absent permits repair.
* `remote_id_and_query_scope_against_disposable_mongo` — exact remote-id match
  per direction, stale-id rejection, cross-direction and cross-channel rows do
  not authorize, `enabled:false` rejects, absent `enabled` accepts, a deleted
  preference still wins.
* `read_errors_are_reported_as_the_typed_adapter_error` — no server is started:
  a loopback `127.0.0.1:1` client with a 100 ms selection deadline fails
  deterministically, and all three adapter entry points return
  `RaidSubscriptionError::Mongo` whose `Display` starts with
  `raid subscription read failed`.

Environment contract: `RAID_SUBSCRIPTIONS_TEST_MONGO_ACK=disposable`,
`..._MONGO_URI`, `..._MONGO_DATABASE=rust_raid_subscriptions_fixture_<unique>`,
plus `DIMA_RAID_SUBSCRIPTIONS_FIXTURE_DIR` (absolute, outside the workspace) and
`..._FIXTURE_SHA256` for the oracle replay. No Redis, Twitch or HTTP dependency
is needed.

## 8. Missing transitive dependencies and caller adoption (separate)

**Local feature coverage:** the three read helpers and the concrete adapter are
ported; the oracle and adapter checks are authored but **not executed**.

**Not migrated / not adopted:**

1. **All four production call sites remain TypeScript.** No native bot webhook,
   auth, route or reconciliation adapter calls `RaidSubscriptionStore` yet.
2. **Preference writes are missing.** `src/server/routes/eventsub.route.ts`
   performs `RaidPreferences.updateOne` upserts on create, and writes
   `deleted:true` with an `operation` fence then rolls back to
   `prior?.deleted || false` when `unsubscribeTwitchEvent` fails. This slice
   intentionally covers the read helpers only; a native route port still needs
   that write/rollback policy.
3. **Reconciliation policy is not native.** `src/utils/eventsub_reconciliation.ts`
   is still TypeScript; the two native helpers are ready for its eventual port,
   but its repair plan, remote reconciliation and duplicate-removal behavior are
   separate work.
4. **No EventSub write adapter.** The native `eventsub` schema exists, but
   subscribing/unsubscribing and the 1500 ms/route error envelopes are other
   slices.
5. **No execution evidence.** No `cargo check`, `cargo test`, clippy, rustfmt or
   Node run was performed; the oracle JSON has not been generated. Compile,
   format and runtime correctness are unverified. The fixture also asserts the
   pinned library versions listed above; a different toolchain must update the
   fixture deliberately, not silently.
6. **Uncovered case shape.** The source type is `Record<string, unknown>`; the
   oracle covers JSON-representable values only. `undefined` fields, Symbols,
   BigInts and non-JSON values cannot arrive from the parsed webhook body.

## 9. Central patch snippets (integration only)

`dimabot/Cargo.toml` — add one feature (any stable position; no hunk anchors):

```toml
raid-subscriptions = ["ordinary-application-schemas", "eventsub"]
```

Transitive rationale: `ordinary-application-schemas` → `application-schemas` →
`mongo`, `js-date`, `js-strings`, and it enables `utils::json_number`;
`eventsub` supplies `RaidDirection`, `RAID_EVENT_TYPE`, `raid_direction_value`
and the `serde`/`serde_json` dependencies. `application-schemas` exposes both
`schemas::eventsub` and `schemas::raid_subscription_preference`; no
`schemas/mod.rs` change is needed.

`dimabot/src/utils/mod.rs` — one module gate, placed between `qdrant` and the
`re2-*` block (alphabetical):

```rust
#[cfg(feature = "raid-subscriptions")]
pub mod raid_subscriptions;
```

No `src/lib.rs` change is required (`pub mod utils;` already exists), and no
`[[test]]` entry is needed because `tests/raid_subscriptions.rs` is an
auto-discovered integration target.

## 10. Files authored

| Path | SHA-256 | Lines |
|---|---|---|
| `dimabot/src/utils/raid_subscriptions.rs` | `f9f8798adb87201dfde0472b858959fa4958b6468c3f24565f6ff915d01fd140` | 277 |
| `dimabot/tests/raid_subscriptions.rs` | `0b6022fdc4816efdeab7393b8f7843f7c9339c9f1c47aee710b35ab7c26c9148` | 637 |
| `dimabot/tests/support/raid_subscriptions_support.rs` | `f337fa3a22267624bfb82bce8ec34a17a02d1b057947d01a57039b7d0688ac14` | 248 |
| `dimabot/tests/fixtures/raid_subscriptions_reference.cjs` | `d425374aa63c7072f2fda8ae0d167928193f220e39fcac2d40be4a5e0179399c` | 536 |

`migration-notes/raid-subscriptions-handoff.md` cannot carry its own digest.

Source digests the oracle pins at generation time (current tree, re-verified by
the support reader on every run):

| Source | SHA-256 |
|---|---|
| `src/utils/raid_subscriptions.ts` | `2eb1bcbb7b1ce25d989c0159213abe42522907ddf0710a068c2eecabc35cdf75` |
| `src/schemas/raid_subscription_preference.schema.ts` | `dfbb334ed17ac9557d9c90e648dd69eebd558f89b08547098919c1030848a27f` |
| `archives/.../src/schemas/eventsub.schema.ts` | `9d641eb036d2dba0907ab5b70bfb58265bbd7174915ddfd8f87b676319d75bf3` |
| `archives/.../src/utils/raid_direction.ts` | `4dd1222da4f496fcd3f047537be318be4681bb5515849392ee2c628045d0e2c8` |

## 11. Verification performed (static only)

* `git diff --check` on the checkout: no output.
* `git diff --no-index --check /dev/null <file>` for every authored path: no
  whitespace/blank-EOF diagnostics.
* SHA-256 digests and line counts recorded above.
* Traced imports and schema registrations from the current tree:
  `schemas/mod.rs:128-129,176` already declare and register the preference
  schema; `utils/eventsub.rs:284` already owns `raid_direction_value`;
  `schemas/eventsub.schema.rs:72` already owns `collection`.
* No build, formatter, linter, Node, Docker, network or test execution was
  performed; nothing was committed, pushed or deployed.

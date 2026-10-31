# Paid-order reward native handoff (author-only)

Date: 2026-10-31
Owner: DeepSeek V4.1 Flash via OpenCode (implementation sub-agent, `tl1-c4`)
Scope: `dimabot/src/utils/paid_order_reward.ts` → `crate::utils::paid_order_reward`.
Contract: `team1-paid-order-reward-dependency.json` (`tl1-c4`). This note owns the
concrete reward adapter only; team1 owns the Polar reward consumer.

**Authored but UNVERIFIED.** Nothing in this handoff has been compiled,
formatted, run, tested, timed, or deployed by the author. No `cargo`, `rustfmt`,
Node, test runner, Docker, network, or deployment command was executed. Only
static reads, `sha256sum`, `wc`, `git diff --check`, and `git status` were used.

## Scope and changed paths (all new)

| Path | Lines | Role |
|---|---|---|
| `dimabot/src/utils/paid_order_reward.rs` | 698 | Native adapter + pure document builders + injected seam |
| `dimabot/tests/paid_order_reward.rs` | 653 | Pure parity tests + one `#[ignore]`d disposable-Mongo test |
| `migration-notes/paid-order-reward-handoff.md` | this file | Handoff |

No central file was edited: `dimabot/Cargo.toml`, `Cargo.lock`,
`rust-toolchain.toml`, `src/lib.rs`, `src/utils/mod.rs`, `src/schemas/mod.rs`,
`src/functions/mod.rs`, `src/domain_events/mod.rs`, `src/workers/mod.rs` are
unchanged. Team1's `src/utils/referral.rs`,
`src/schemas/referral_code.schema.rs`, and
`src/domain_events/polar_billing/**` were read but not modified. No TypeScript
source was touched or retired by this work.

## Public API surface (exact signatures)

```rust
pub struct PaidOrderRewardInput {
    pub owner_user_id: String,
    pub order_id: String,
    pub product_id: String,
    pub cadence: SubscriptionCadence,        // crate::utils::referral::SubscriptionCadence
}
impl PaidOrderRewardInput {
    pub fn new(
        owner_user_id: impl Into<String>,
        order_id: impl Into<String>,
        product_id: impl Into<String>,
        cadence: SubscriptionCadence,
    ) -> Self;
    pub fn from_cadence_str(
        owner_user_id: impl Into<String>,
        order_id: impl Into<String>,
        product_id: impl Into<String>,
        cadence: &str,                        // TypeScript 'monthly' | 'yearly'
    ) -> Result<Self, PaidOrderRewardError>;
}

pub type PaidOrderRewardFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), PaidOrderRewardError>> + Send + 'a>>;

/// Injected seam for team1's `applyPolarRewardDomainEvent`.
pub trait PaidOrderRewardApplier: Send + Sync {
    fn apply<'a>(&'a self, input: &'a PaidOrderRewardInput) -> PaidOrderRewardFuture<'a>;
}

#[derive(Clone, Debug)]
pub struct PaidOrderRewardService { /* Database */ }
impl PaidOrderRewardService {
    pub fn new(database: mongodb::Database) -> Self;
    pub fn database(&self) -> &mongodb::Database;
    pub async fn apply_paid_order_reward(
        &self,
        input: &PaidOrderRewardInput,
    ) -> Result<(), PaidOrderRewardError>;
}
impl PaidOrderRewardApplier for PaidOrderRewardService { /* Box::pin */ }

/// Convenience entry point; accepts `&Concrete` and `&dyn PaidOrderRewardApplier`.
pub async fn apply_paid_order_reward<A: PaidOrderRewardApplier + ?Sized>(
    applier: &A,
    input: &PaidOrderRewardInput,
) -> Result<(), PaidOrderRewardError>;

#[derive(Debug)]
pub enum PaidOrderRewardError {
    MissingOrderId, InvalidOwnerUserId, OwnerNotFound, BeneficiaryNotFound,
    ReservationNotFound, ReservedBeneficiaryNotFound,
    InvalidCadence(String), CorruptReservation(&'static str),
    Index(mongodb::error::Error), Mongo(mongodb::error::Error),
}
```

Supporting public surface (tests and team1 bridging):

```rust
pub const IDEMPOTENCY_PREFIX: &str;   // "polar:paid-order:"
pub const BOT_ACCOUNT_LOGIN: &str;    // "domdimabot"
pub const DUPLICATE_KEY_CODE: i32;    // 11000
pub struct ReservationTerms<'a> { /* builder input */ }
pub enum BeneficiaryResolution { Referrer(ObjectId), Bot }

pub fn journaled_write_concern() -> WriteConcern;               // { w: 1, j: true }
pub fn idempotency_key(order_id: &str) -> String;
pub fn validate_order_id(order_id: &str) -> Result<(), PaidOrderRewardError>;
pub fn parse_cadence(cadence: &str) -> Result<SubscriptionCadence, PaidOrderRewardError>;
pub fn reward_plan_amount(product_id: &str, cadence: SubscriptionCadence)
    -> Option<(PlanType, i64)>;                                  // None == amount <= 0
pub fn reward_description(plan: PlanType, cadence: SubscriptionCadence) -> String;
pub fn referrer_candidate(payer: &Document) -> Option<(ObjectId, &str)>;
pub fn beneficiary_resolution(payer: &Document, code_matches: bool, referrer_exists: bool)
    -> BeneficiaryResolution;
pub fn referral_code_filter(code: &str, owner: ObjectId) -> Document;
pub fn bot_account_filter() -> Document;
pub fn reservation_filter(idempotency_key: &str) -> Document;
pub fn reservation_update(terms: &ReservationTerms<'_>) -> Document;
pub fn legacy_reward_filter(order_id: &str, idempotency_key: &str) -> Document;
pub fn reservation_applied(reservation: &Document) -> bool;
pub fn applied_filter(transaction_id: ObjectId) -> Document;
pub fn applied_update(balance_after: Option<Bson>, now: DateTime) -> Document;
pub fn user_credit_filter(user_id: ObjectId, transaction_id: ObjectId) -> Document;
pub fn already_credited_filter(user_id: ObjectId, transaction_id: ObjectId) -> Document;
pub fn user_credit_update(amount: Bson, transaction_id: ObjectId, now: DateTime) -> Document;
pub fn stored_number(value: Option<&Bson>) -> Option<Bson>;      // Node read/write round trip
pub fn is_duplicate_key_code(code: i32) -> bool;
```

Reward policy, the reward table, product-id resolution, and every schema stay in
their existing owners (`crate::utils::referral`,
`crate::schemas::{credit_transaction, users, referral_code}`). This module copies
none of them.

## Central patch you must PROPOSE (not applied)

### `dimabot/Cargo.toml`

```toml
# Paid-order reward adapter for the Polar reward consumer; reuses the shared
# referral policy and application schemas. Not in `default` or a worker profile.
paid-order-reward = ["application-schemas", "referral-service"]
```

```diff
@@ -166,5 +166,8 @@
 twitch-streamers-posthog = ["twitch-streamers", "posthog"]
 # Standalone process supervision and telemetry; never widens worker profiles.
 cron-supervisor = ["dep:redis", "dep:serde", "dep:serde_json", "dep:tokio", "dep:uuid", "dep:libc", "dep:dotenvy", "tokio/process", "tokio/fs", "tokio/io-util"]
+# Paid-order reward adapter for the Polar reward consumer; reuses the shared
+# referral policy and application schemas. Not in `default` or a worker profile.
+paid-order-reward = ["application-schemas", "referral-service"]
 
 [[bin]]
```

The insertion point is cosmetic; place it wherever `referral-service` lands.
`dimabot/Cargo.toml` was 263 lines by `wc -l` at authoring time, and the hunk
above was checked against the current content (context lines 166–170: 5 old
lines become 8).

Feature-name note (important). The task brief suggested a feature named
`referral`. **Team1's own handoff already names it `referral-service`**
(`migration-notes/team1-wave2-c-handoff.md`: `referral-service =
["application-schemas", "mongo", "billing-service", "js-date", "dep:sha2"]`), so
this proposal uses `referral-service` and **team1 must confirm or rename it**.
`application-schemas` is listed explicitly so this feature still selects the
schema modules if team1's feature list changes; it implies `mongo`, `js-strings`,
and `js-date`, which supply `utils::js_compat`, `utils::bson_compat`, and
`schemas::js_string`. `dep:serde_json` from the brief's example is unnecessary:
`mongo` already enables `serde_json`, and this module has no serde usage.

### `dimabot/src/utils/mod.rs`

```diff
@@ -354,3 +354,6 @@
 
 #[cfg(feature = "api-file-routes")]
 pub mod fs;
+
+#[cfg(feature = "paid-order-reward")]
+pub mod paid_order_reward;
```

Hunk counts checked against the current file (356 lines; the quoted context is
lines 354–356; the hunk replaces 3 lines with 6).

### Cross-team prerequisites this module cannot compile without

These belong to team1 / the integration team; they are listed here because the
adapter references those modules and the current central files do **not** declare
them yet (`grep -n referral dimabot/src/utils/mod.rs` and the same grep in
`dimabot/src/schemas/mod.rs` both return nothing at authoring time):

```rust
// dimabot/src/utils/mod.rs — team1 (already proposed in their wave-2C handoff)
#[cfg(feature = "referral-service")]
pub mod referral;
#[cfg(feature = "referral-service")]
pub mod referral_ledger;
```

```rust
// dimabot/src/schemas/mod.rs — team1 (already proposed in their wave-2C handoff)
#[cfg(feature = "referral-service")]
#[path = "referral_code.schema.rs"]
pub mod referral_code;
```

Consequence: enabling `paid-order-reward` before those two declarations land
fails to compile on `crate::utils::referral` and `crate::schemas::referral_code`,
not on anything in this adapter. No `[[test]]` block is needed for
`tests/paid_order_reward.rs`; its first line is
`#![cfg(feature = "paid-order-reward")]`, matching the repository convention.

## Parity table (source step → native counterpart)

| # | `paid_order_reward.ts` | Native |
|---|---|---|
| 1 | `if (!orderId?.trim()) throw Error('Paid order reward requires an order ID')` | `validate_order_id` → `PaidOrderRewardError::MissingOrderId`; whitespace via `utils::js_compat::trim` (ECMAScript set: includes `U+00A0`/`U+FEFF`, excludes `U+0085`) |
| 2 | `await CreditTransactionSchema.init()` | `credit_transaction::schema().install_indexes(&database)`, error → `PaidOrderRewardError::Index`. Explicit call each invocation; nothing at import time |
| 3 | `idempotencyKey = \`polar:paid-order:${orderId}\``; `findOne({ idempotencyKey })` | `idempotency_key()` (raw order id, untrimmed) + `reservation_filter()` + `transactions.find_one()` |
| 4 | `getPlanTypeFromProductId` / `getBotSubscriptionRewardAmount`; `if (amount <= 0) return` | `reward_plan_amount()` → `None` when `amount <= 0`, delegated to `utils::referral` (no table copied) |
| 5 | `exists({ type: SUBSCRIPTION_REWARD, 'metadata.subscriptionId': orderId, idempotencyKey: { $ne: key } })` | `legacy_reward_filter()` + `exists()` (`find_one` with `{_id: 1}` projection). Own key excluded exactly as written |
| 6 | `Types.ObjectId.isValid(ownerUserId)` → `throw` | `ObjectId::parse_str` → `InvalidOwnerUserId` (24-char hex only; deliberate, see deviations) |
| 7 | `UsersSchema.findById` + missing check | `users::schema().repository(&db).find_one({_id})` (applies the schema's `select: false` projection) → `OwnerNotFound` |
| 8 | Referrer path: both payer fields, `code.toLowerCase()`, `owner`, `active: true`, referrer still exists. Else bot by `accounts.$elemMatch{type:'twitch',name:'domdimabot'}` or `throw` | `referrer_candidate()` → `referral_code_filter()` + `exists()` (referrer existence only when the code matched, as the source short-circuits) → `beneficiary_resolution()`. Bot lookup via `bot_account_filter()` → `BeneficiaryNotFound` |
| 9 | `findOneAndUpdate({idempotencyKey}, {$setOnInsert: {...}}, {upsert:true, new:true, writeConcern:{w:1,j:true}})` | `reservation_update()` (`$setOnInsert` + Mongoose defaults/timestamps) + `.upsert(true).return_document(ReturnDocument::After).write_concern(journaled_write_concern())` |
| 9b | `catch (error) if (error.code !== 11000) throw; findOne(...)` | `is_duplicate_key()` over `ErrorKind::Command`/`Write(WriteError)`/`BulkWrite`/`InsertMany`, comparing the numeric code with `DUPLICATE_KEY_CODE`; any other error → `Mongo` |
| 10 | `if (!reservation) throw`; `if (reservation.appliedAt) return` | `ReservationNotFound`; `reservation_applied()` (absent **or** null is “not applied”) |
| 11 | `findOneAndUpdate({_id: reservation.user, applied_credit_transaction_ids: {$ne: reservation._id}}, {$inc, $addToSet}, {new:true, writeConcern})` | `user_credit_filter()` (identical `$ne` document) + `user_credit_update()` (`$inc`, `$addToSet`, and the Mongoose `updated_at` set) + `ReturnDocument::After` + journaled |
| 11b | `if (!creditedUser && !exists({_id, applied_credit_transaction_ids: _id})) throw` | `already_credited_filter()` + `exists()` → `ReservedBeneficiaryNotFound` |
| 12 | `updateOne({_id, appliedAt: {$exists:false}}, {$set:{appliedAt:new Date(), ...(creditedUser ? {balanceAfter: creditedUser.token_balance} : {})}}, {writeConcern})` | `applied_filter()` + `applied_update()` (adds `balanceAfter` only when the user write returned a document; always journals; adds the Mongoose `updatedAt`) |

Mongoose behaviours reproduced on purpose (they are the silent-breakage traps):

* `new: true` → `ReturnDocument::After`, on both `findOneAndUpdate` calls.
* `setDefaultsOnInsert` → `$setOnInsert.balanceAfter: null`; `$setOnInsert` carries
  every `metadata` field, so no metadata default is needed, and
  `description`'s `""` default is unreachable.
* Timestamps (`setupTimestamps` pre hooks): `$setOnInsert.createdAt` + `$set.updatedAt`
  for the credit-transaction upsert, `$set.updatedAt` for its finalizing
  `updateOne`, and `$set.updated_at` for the users `findOneAndUpdate`
  (`users` schema uses `created_at`/`updated_at`).
* **No** `_id` and **no** `__v` in `$setOnInsert`: `setDefaultsOnInsert` skips the
  automatic `_id` path and `__v` is not a schema path for update documents, so
  MongoDB generates `_id`. A naive port that seeds either one diverges.
* No document validators and no `pre('save')` hooks anywhere (the source sets no
  `runValidators`).
* `metadata.referralCodeUsed` keeps the payer's raw, un-lowercased value, and is
  `null` (not `""`) when the payer has none.
* Node number encoding through `utils::bson_compat::js_number`: reward amounts,
  `$inc.token_balance`, and `balanceAfter` are BSON `Int32` for these integral
  values, exactly like the Node BSON writer.

## Deviations, justifications, residual risk

| Deviation | Justification | Residual risk |
|---|---|---|
| `install_indexes` runs on every invocation (Mongoose memoises `init()`) | The brief requires an explicit install and the schema is a pure definition; caching per database would add state to a stateless adapter | One extra idempotent `createIndexes` round-trip per call; same failure surface (lacks `createIndex` privilege → `Index` error) |
| Cadence is `SubscriptionCadence`, not a string | Type safety; matches the shared referral policy type | Team1's existing seam types `cadence: String`; bridge with `parse_cadence`/`from_cadence_str` (below). New `InvalidCadence` error is unreachable from the TS union |
| Added `PaidOrderRewardError::InvalidCadence` | Adapter boundary only; the TS union cannot express it | None for TS-parity callers; a caller passing `"Monthly"` gets an error instead of silent FREE-plan behaviour |
| Added `PaidOrderRewardError::CorruptReservation` | TS trusts schema hydration; a reservation without `_id`/`user`/numeric `amount` would build a filter with `undefined` and fail unpredictably in the driver | Stored corrupt data returns a typed error with a different message than any TS throw |
| Added `PaidOrderRewardError::Index` | `.init()` is a distinct source step whose failure the TS surfaces as a rejected promise | Message prefix differs from the raw Mongoose error |
| `payer_id` is the `_id` used by `findById` rather than re-read from the document | The lookup is by `_id`, so both are the same value; avoids an impossible missing-field branch | None |
| `ObjectId::parse_str` accepts only 24-char hex | Deliberate: Mongoose `isValid` also accepts 12-byte strings/24-char hex, and historically numbers; every stored owner id is a 24-hex ObjectId string (`owner.owner_id.to_hex()` in team1's consumer), so the extra leniency would only accept ids that cannot own a user | A caller passing a 12-character string now gets `InvalidOwnerUserId` where Mongoose might have cast one; no in-repo caller does this |
| Referral-code lowercase uses Rust `to_lowercase` | `referral_code::valid_code` restricts codes to 1–16 ASCII alphanumerics/underscores, so it equals `String.prototype.toLowerCase`; identical to team1's `referral.rs` | A stored code with non-ASCII (impossible through the save hook) could differ |
| Node number round trip covers `Int64` within ±2^53 only | Matches `bson_compat::normalize_js_numbers` (Node promotes Long → Number) | A `token_balance` or `amount` beyond 2^53 yields `CorruptReservation` (amount) or an omitted `balanceAfter` (balance); unreachable for 50–1000 rewards |
| One `DateTime::now()` per operation group | TS uses `new Date()` for `appliedAt` and Mongoose's own clock for `updatedAt`; the two can differ by a millisecond | Timestamps can be equal where TS might differ by 1 ms; not observable in behaviour |
| `PaidOrderRewardService::database()` accessor | Not in the source | None |
| Index install precedes the FREE-plan early return | Source order (`init()` before the amount check) | A FREE order still pays one `createIndexes` |
| Duplicate-key detection also inspects `BulkWrite`/`InsertMany` | Same numeric rule; harmless for single-document writes | None; the extraction wrapper itself is untested (see below) |
| No logger | The source has none | None |

Untested-by-construction surface: the driver-error *extraction* in
`is_duplicate_key` cannot be unit-tested from an integration test because
`mongodb::error::Error` has private fields and no public constructor. The numeric
predicate it delegates to (`is_duplicate_key_code`) is tested, and the existing
`bits_rules/store.rs` uses the same two match arms, so the paths are proven in
this crate.

## Test inventory (`dimabot/tests/paid_order_reward.rs`)

Pure, no MongoDB/Redis/network (17 tests):

| Test | Covers |
|---|---|
| `idempotency_key_uses_the_source_prefix_and_raw_order_id` | `polar:paid-order:{orderId}`, raw (untrimmed) id, prefix constant |
| `empty_and_whitespace_order_ids_fail_with_the_source_message` | exact `Paid order reward requires an order ID`; JS whitespace (`U+00A0`, `U+FEFF`) rejected, NEL accepted |
| `a_zero_reward_plan_never_reaches_the_reservation` | FREE plan and unknown product → no reservation (the `amount <= 0` early return) |
| `paid_plans_use_the_shared_reward_table` | premium 50/500, pro 100/1000 through the shared policy |
| `descriptions_match_the_typescript_template` | `Subscription reward for {PLAN} ({cadence})` for all six combinations |
| `legacy_guard_filter_excludes_our_own_idempotency_key` | exact guard document and that `$ne` holds our own key |
| `beneficiary_table_prefers_a_live_referrer_only` | referrer path vs bot path decision table (6 cases) |
| `beneficiary_lookups_keep_the_source_filters` | lowercased code / owner / `active: true`; bot `$elemMatch` |
| `reservation_upsert_reproduces_defaults_and_timestamps` | exact `$setOnInsert` (incl. `balanceAfter: null`, `createdAt`, Int32 `amount`, null `referralCodeUsed`), `$set.updatedAt`, and absence of `_id`/`__v`/`appliedAt` |
| `reservation_upsert_keeps_the_referrer_target_and_raw_code_case` | `rewardTargetType: "referrer"`, raw `Promo_1`, pro/yearly description |
| `user_credit_write_is_one_atomic_update` | `$ne` array filter, `$inc`, `$addToSet`, `$set.updated_at` |
| `applied_receipts_short_circuit_and_replays_never_write_balance_after` | replay rule and `balanceAfter`-only-when-credited |
| `stored_numbers_round_trip_through_the_node_writer` | Int32/Int64/Double → Node writer encoding |
| `duplicate_keys_are_detected_by_the_numeric_code_only` | `11000` vs other codes |
| `every_source_journaled_write_is_journaled` | `{ w: 1, j: true }` |
| `cadence_bridge_accepts_only_the_typescript_union` | `monthly`/`yearly` only; `from_cadence_str` equality |
| `source_error_messages_are_preserved` | all six source throw messages verbatim |

One `#[ignore]`d test (requires an explicit disposable fixture; it refuses
anything else):

* `paid_order_reward_adapter_against_a_disposable_database`
  * env contract: `PAID_ORDER_REWARD_TEST_MONGO_URI`,
    `PAID_ORDER_REWARD_TEST_DATABASE` (must start with
    `rust_paid_order_reward_fixture_`; the test also asserts the database is
    empty before it writes).
  * exercises: referrer credit + `balanceAfter`, replay idempotency (single
    transaction, unchanged balance), FREE-plan no-op, legacy guard, bot path,
    and the three source error messages (`canonical owner user ID`, `owner not
    found`, `order ID`).

Nothing in this inventory has been executed. Do not treat any of it as passing.

## Cross-team notes for team1-billing-ai

1. **Feature name.** Use `referral-service` (your wave-2C name), not the
   brief's `referral`; this handoff's feature line depends on it. Please confirm
   the final name so the `paid-order-reward` line can match.
2. **Central prerequisites.** `utils::referral`, `utils::referral_ledger`, and
   `schemas::referral_code` are not yet declared in the central module files, so
   neither your consumers nor this adapter can compile until those hunks land.
3. **Your existing seam.** `domain_events/polar_billing/mod.rs` already defines
   `PaidOrderRewardInput { cadence: String }` and
   `PolarRewardApplier::apply_paid_order_reward`. That is your file; this adapter
   deliberately does not edit or duplicate it. Bridge in one call at your
   boundary, for example:

   ```rust
   // team1-owned file; illustrative only
   impl PolarRewardApplier for PaidOrderRewardService {
       fn apply_paid_order_reward<'a>(
           &'a self,
           input: &'a super::PaidOrderRewardInput,
       ) -> BillingFuture<'a, ()> {
           Box::pin(async move {
               let typed = match paid_order_reward::PaidOrderRewardInput::from_cadence_str(
                   &input.owner_user_id,
                   &input.order_id,
                   &input.product_id,
                   &input.cadence,
               ) {
                   Ok(typed) => typed,
                   Err(error) => return Err(/* map into PolarBillingError */),
               };
               paid_order_reward::apply_paid_order_reward(self, &typed)
                   .await
                   .map_err(/* map into PolarBillingError */)
           })
       }
   }
   ```

   Alternatively keep only your own trait and call
   `PaidOrderRewardApplier::apply` — the `?Sized` free function accepts either a
   concrete service or `&dyn`.
4. **Optional cleanup on your side.** `SubscriptionCadence::as_str` in
   `src/utils/referral.rs` is private, so this module restates the
   `monthly`/`yearly` mapping in `cadence_name`. Making it `pub fn as_str` would
   remove that one restatement; the adapter needs no other change. This adapter
   does not edit your file.
5. **Observation for your review (not a change request).** In
   `referral.rs::process_bot_subscription_reward` the reward `amount` is written
   as an `i64`, which serialises as BSON `Int64`, while the Node BSON writer
   emits `Int32` for these integral values. This adapter routes its numbers
   through `utils::bson_compat::js_number` for that reason. Worth a look if
   cross-model BSON-type parity matters to you.

## NOT VERIFIED

Nothing here was compiled, formatted, linted, executed, or deployed. The author
ran no `cargo`, `rustfmt`, `node`, `npm`, `tsc`, test runner, Docker, network, or
production command, and did not modify any central or other-team file. Every
claim above is a source-reading claim, not an observed result.

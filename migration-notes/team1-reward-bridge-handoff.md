# Team1 `tl1-c4` — Polar paid-order reward bridge (author-only)

Date: 2026-10-31
Owner: DeepSeek V4.1 Flash via OpenCode (implementation sub-agent, `tl1-c4`)
Scope: close the open dependency recorded in
`ready/team1-billing-ai.central.patch` §3.4 — `applyPolarRewardDomainEvent` had
no concrete `PolarRewardApplier`.
Consumer: `dimabot/src/domain_events/polar_billing/mod.rs`.
Adapter: team2's `dimabot/src/utils/paid_order_reward.rs` (slice 6).

**Authored but UNVERIFIED.** Nothing in this handoff has been compiled,
formatted, linted, executed, tested, timed, or deployed. No `cargo`, `rustfmt`,
Node, `npm`, test runner, Docker, network, install, commit, push, or deploy
command was executed by the author. Only static reads, `grep`, `wc`,
`sha256sum`, `git diff --check`, and trailing-whitespace checks were used. Do not
treat any statement below as an observed result.

## Files

| Path | Lines | Role |
|---|---|---|
| `dimabot/src/domain_events/polar_billing/reward_bridge.rs` | 112 | New. Trait impl + cadence/error mapping + one-call composition |
| `dimabot/tests/polar_reward_bridge.rs` | 748 | New. 4 pure tests + 1 `#[ignore]`d disposable-Mongo test |
| `dimabot/src/domain_events/polar_billing/mod.rs` | 430 | **Claimed edit only**: 2-line gated module declaration and two doc sentences |
| `migration-notes/team1-reward-bridge-handoff.md` | this file | Handoff |

`mod.rs` is the only existing file touched. Its exact changes:

```rust
// in the "Concrete adapters" doc paragraph: the `paid-order-reward` sentence
// in the "Deliberately NOT here" paragraph: implementations live in
//   `utils::paid_order_reward` / the future credit-gift module
pub mod plan_projection;
#[cfg(feature = "paid-order-reward")]
pub mod reward_bridge;
pub mod webhook_signature;
```

Untouched by this task: `dimabot/Cargo.toml`, `Cargo.lock`,
`rust-toolchain.toml`, `src/lib.rs`, `src/domain_events/mod.rs`,
`src/utils/mod.rs`, `src/schemas/mod.rs`, every Team2 file (including
`src/utils/paid_order_reward.rs` and `tests/paid_order_reward.rs`), every
`src/domain_events/polar_billing/*.rs` other than `mod.rs`, and all TypeScript
sources. No TypeScript file was retired.

Hashes at authoring time:
`reward_bridge.rs` `sha256 e03448c0605f9d5fafd1bc6016d4d0cfd3572a83c1916746ebf7912a6a2b66d2`,
`polar_reward_bridge.rs` `sha256 a59f948033974a0843302f21c4a5fe0f01b7dc73b6813fb9dc8a67ada199ce48`.

## What this closes, and how

`polar_billing::PolarRewardApplier` is the seam. Its application adapter is
`src/utils/paid_order_reward.ts` → `crate::utils::paid_order_reward`
(team2, slice 6). This bridge is the only new code between them:

* the seam's `cadence: String` becomes the adapter's typed
  `SubscriptionCadence` (`monthly` / `yearly`);
* adapter failures become `PolarBillingError` without losing the source
  messages;
* the concrete adapter is constructed from a `Database` and handed to the
  canonical event branch unchanged.

No reward table, product-id resolution, filter, collection name, index,
idempotency rule, beneficiary rule, or write document is duplicated. Those stay
in `utils::paid_order_reward` and `utils::referral`.

## Public surface (exact)

```rust
// dimabot/src/domain_events/polar_billing/reward_bridge.rs
pub const REWARD_CADENCE_UNSUPPORTED: &str =
    "Polar paid order has an unsupported billing cadence";

pub fn typed_reward_input(
    input: &super::PaidOrderRewardInput,                 // seam type: cadence: String
) -> Result<crate::utils::paid_order_reward::PaidOrderRewardInput, PolarBillingError>;

pub fn map_reward_error(
    error: crate::utils::paid_order_reward::PaidOrderRewardError,
) -> PolarBillingError;

impl PolarRewardApplier for crate::utils::paid_order_reward::PaidOrderRewardService;

pub async fn dispatch_paid_order_reward_event(
    event: &DomainEventEnvelope,
    store: &dyn PolarBillingStore,
    resolver: Option<&dyn PolarOwnerResolver>,
    database: mongodb::Database,
) -> Result<(), PolarBillingError>;
```

Two equivalent compositions, both using the same mapping code:

1. Long-lived: `PaidOrderRewardService::new(database)` (team2's constructor) now
   implements `PolarRewardApplier`, so it can be passed directly to
   `apply_polar_reward_domain_event(event, store, resolver, &service)` or stored
   on an application struct.
2. One-call: `dispatch_paid_order_reward_event(event, store, resolver, database)`
   builds the service and runs the canonical branch. Construction stores a
   `Database` clone (shared client pool); it performs no IO and reads no
   environment.

The trait implementation lives on team2's type because both the trait and the
type are local to this crate. It does not edit team2's file, but it **does** own
the impl: if team2 later adds `impl PolarRewardApplier for PaidOrderRewardService`
in their module, the crate will fail with a conflicting-implementation error.
Coordinate before either side adds another impl.

## Cadence mapping

| Seam value (`PaidOrderRewardInput.cadence`) | Result |
|---|---|
| `"monthly"` | `SubscriptionCadence::Monthly` |
| `"yearly"` | `SubscriptionCadence::Yearly` |
| `""` | `PolarBillingError::Business(REWARD_CADENCE)` — **never reaches the bridge**; the canonical event branch rejects an empty cadence first |
| anything else (`"Monthly"`, `"weekly"`, `" yearly"`, …) | `PolarBillingError::Business("Polar paid order has an unsupported billing cadence: <value>")` |

The last row is bridge-local text. The TypeScript signature is the
`'monthly' | 'yearly'` union, so the source cannot express this state; at runtime
an unexpected value would index the reward table with `undefined`. The typed
adapter (team2) deliberately turns that into a typed error instead of a silent
zero reward, and this bridge reports it as a business failure rather than a
database failure.

## Error mapping

| `PaidOrderRewardError` | `PolarBillingError` | Message |
|---|---|---|
| `MissingOrderId` | `Business` | `Paid order reward requires an order ID` |
| `InvalidOwnerUserId` | `Business` | `Paid order reward requires a canonical owner user ID` |
| `OwnerNotFound` | `Business` | `Paid order reward owner not found` |
| `BeneficiaryNotFound` | `Business` | `Paid order reward beneficiary not found` |
| `ReservationNotFound` | `Business` | `Paid order reward reservation not found` |
| `ReservedBeneficiaryNotFound` | `Business` | `Paid order reward reserved beneficiary not found` |
| `CorruptReservation(reason)` | `Business` | `Paid order reward reservation is malformed: <reason>` |
| `InvalidCadence(value)` | `Business` | `Polar paid order has an unsupported billing cadence: <value>` |
| `Index(error)` | `Runtime` | `Credit transaction index install failed: <redacted driver error>` |
| `Mongo(error)` | `Runtime` | `Paid order reward database operation failed: <redacted driver error>` |

Driver failures are runtime failures because they are infrastructure errors, not
decisions about the order. The underlying `mongodb::error::Error` is not carried
in a typed `PolarBillingError` variant (the consumer error type has none); only
the driver's already-redacted rendered message is preserved.

## Central patch you must PROPOSE (not applied by the author)

### 1. `dimabot/Cargo.toml` — prerequisite, not a new dependency

Team2's merged patch (`ready/team2-api-data-central-20261031.v2.patch`) already
proposes the feature this module gates on:

```toml
paid-order-reward = ["application-schemas", "referral-service"]
```

No new crate, feature, or dependency is introduced by this bridge. It reuses
that feature plus `polar-billing-events`.

**Ordering constraint:** `#[cfg(feature = "paid-order-reward")]` is now present in
`polar_billing/mod.rs`. If the tree is built before that feature is declared,
`unexpected_cfgs` fires (and `cargo clippy -- -D warnings` fails). Apply team2's
feature line together with this module, or before it.

### 2. Optional umbrella feature (recommended)

The bridge needs **both** `paid-order-reward` and `polar-billing-events`.
`paid-order-reward` does not imply `polar-billing-events`, so a consumer must
otherwise enable two features by name. Recommended, not required:

```toml
# Polar paid-order reward composition; never in `default` or a worker profile.
polar-paid-order-reward = ["paid-order-reward", "polar-billing-events"]
```

Place it beside `paid-order-reward`/`polar-billing-events`. It changes no
existing graph and adds no crate.

### 3. Optional explicit test target

`tests/polar_reward_bridge.rs` starts with
`#![cfg(all(feature = "polar-billing-events", feature = "paid-order-reward"))]`,
so it self-gates and **no `[[test]]` entry is required** (matching team2's
convention). If the root prefers an explicit gate:

```toml
[[test]]
name = "polar_reward_bridge"
required-features = ["polar-billing-events", "paid-order-reward"]
```

(or `["polar-paid-order-reward"]` if the umbrella feature above is adopted).

### Cross-team prerequisites this module cannot compile without

These are already proposed by other handoffs; they are listed so the integration
order is explicit:

1. Team2 v2 patch: `paid-order-reward` feature, `utils/mod.rs` →
   `pub mod paid_order_reward;`, `schemas/mod.rs` → `referral_code`.
2. Team1 wave-2C: `referral-service` feature, `utils::referral`,
   `utils::referral_ledger`, `schemas::referral_code`.
3. Team1 wave-1: `billing-service` feature and `utils::billing`.
4. Team1 wave-2A: `polar-billing-events` feature and, in
   `src/domain_events/mod.rs`, `#[path = "polar_billing/mod.rs"] pub mod
   polar_billing;`. Without this declaration the bridge is unreachable, because
   `polar_billing/mod.rs` itself is not compiled.

Until 1–4 land, enabling the bridge fails on those modules, not on anything in
`reward_bridge.rs`.

## Test inventory (`dimabot/tests/polar_reward_bridge.rs`)

Pure, no MongoDB/Redis/network (4 tests):

| Test | Covers |
|---|---|
| `supported_cadences_map_to_the_typed_reward_input` | `monthly`/`yearly` → typed input, field-for-field |
| `unsupported_cadences_are_business_errors_with_the_bridge_message` | `""`, `"Monthly"`, `"weekly"`, `" yearly"` rejected as `Business` with the exact bridge message |
| `adapter_errors_keep_their_source_messages_and_driver_failures_stay_runtime` | all 7 business variants preserve the source text; `Index`/`Mongo` become `Runtime` with the adapter's prefix; `InvalidCadence` message |
| `the_disposable_fixture_contract_refuses_non_disposable_resources` | the fixture guard refuses a missing/wrong expectation, a missing URI or database, `mongodb+srv://`, a non-prefixed or malformed database name, and a non-loopback host without the private-network acknowledgement |

One `#[ignore]`d test (requires an explicit disposable fixture; it refuses
anything else and never skips):

* `the_bridge_dispatches_replays_and_propagates_errors_against_a_disposable_database`
  * environment contract:
    * `POLAR_REWARD_BRIDGE_TEST_EXPECT=disposable` (hard requirement),
    * `POLAR_REWARD_BRIDGE_TEST_MONGO_URI` (a `mongodb+srv://` URI is refused),
    * `POLAR_REWARD_BRIDGE_TEST_DATABASE` (must start with
      `rust_polar_reward_bridge_fixture_`, ≤ 60 simple identifier bytes, and be
      empty before the fixture writes),
    * `POLAR_REWARD_BRIDGE_TEST_PRIVATE_NETWORK=1` only when the host is not
      loopback and is a task-owned isolated network.
  * runs the real composition: `MongoPolarBillingStore` owner resolution →
    `dispatch_paid_order_reward_event` → `PaidOrderRewardService` writes.
  * exercises:
    * bot-path credit for a PREMIUM monthly order (amount 50, `balanceAfter`,
      `appliedAt`, metadata, bot balance);
    * replay of the same event (one transaction, unchanged `appliedAt` and
      `balanceAfter`, balance credited once);
    * referrer path for a PRO yearly order (referrer credited 1000, raw
      `referralCodeUsed`, `rewardTargetType: "referrer"`, description);
    * canonical filters: wrong event type, wrong source, one-time order without
      `subscriptionId`, `$0` order, non-plan product — all succeed with no write;
    * error propagation: unpaid order (`REWARD_PAYLOAD`), missing cadence
      (`REWARD_CADENCE`), unsupported cadence (bridge message, no reservation),
      missing owner mapping and unknown owner (`Missing prerequisite: …`);
    * final state unchanged after every rejected/filtered event; the task-owned
      database is dropped at the end.

Command (exact):

```sh
POLAR_REWARD_BRIDGE_TEST_EXPECT=disposable \
POLAR_REWARD_BRIDGE_TEST_MONGO_URI='mongodb://127.0.0.1:27017/?directConnection=true' \
POLAR_REWARD_BRIDGE_TEST_DATABASE='rust_polar_reward_bridge_fixture_<unique>' \
  cargo test --locked --test polar_reward_bridge -- --ignored \
    --exact the_bridge_dispatches_replays_and_propagates_errors_against_a_disposable_database
```

Nothing in this inventory has been executed. Do not treat any of it as passing.

## Remaining gaps and limitations

1. **No compile or runtime evidence.** The author could not run Cargo, rustfmt,
   clippy, Node, tests, Docker, or network commands. Type-checking is unproven;
   treat every signature claim as source-reading only.
2. **Caller adoption is separate.** The reward branch becomes *shippable* once
   the prerequisites land, but nothing calls it yet: no route, worker, or
   application struct constructs the service or calls
   `dispatch_paid_order_reward_event`. That wiring belongs to the integration
   team and is not part of this scope.
3. **Two features, not one.** Without the proposed umbrella feature, callers
   must enable `paid-order-reward` and `polar-billing-events`; enabling only one
   leaves the bridge absent (or the module unbuilt).
4. **Trait-impl ownership.** The `PolarRewardApplier` impl is on team2's
   `PaidOrderRewardService`. A second impl elsewhere is a coherence error.
5. **Gift seam still open.** `PolarGiftAcceptor` remains unadapted (team1
   wave 3-A); this task does not touch it.
6. **Concurrency not exercised.** The fixture covers sequential replay, not two
   simultaneous first applies racing the unique `idempotencyKey` index; that
   duplicate-key path belongs to team2's adapter coverage.
7. **Index install per call.** `PaidOrderRewardService` installs the
   credit-transaction indexes on every invocation (team2's documented
   deviation). The bridge inherits that cost and its failure mode (`Runtime`).
8. **`PolarOwnerResolver` unexercised here.** The fixture uses
   `MongoPolarBillingStore` and `ownerUserId`; a deployment-specific resolver
   remains the caller's responsibility.
9. **New message text.** `REWARD_CADENCE_UNSUPPORTED` has no TypeScript
   counterpart; log/alert filters keyed on the TS strings will not see it.
10. **Driver error type is flattened.** `Runtime(String)` loses the typed
    `mongodb::error::Error`; callers cannot branch on the driver kind.
11. **`paid-order-reward` feature name** is team2's proposed name and still
    needs confirmation against the final manifest; if it is renamed, the `cfg`
    in `mod.rs` must change with it.

## Verification performed by the author

Static only:

* read `AGENTS.md`, `dimabot/AGENTS.md`, `dimabot/RUST_AGENTS.md`,
  `ready/team2-api-data-slice-6-paid-order-reward.md`, the Team1/Team2 central
  patches, `src/utils/paid_order_reward.{ts,rs}`, `src/utils/referral.rs`,
  `src/domain_events/polar_billing/*`, `tests/polar_billing_events.rs`,
  `tests/polar_billing_mongo.rs`, `tests/paid_order_reward.rs`,
  `src/utils/domain_events.rs`, `src/schemas/{users,credit_transaction}.schema.rs`;
* `git diff --check` clean for tracked files;
* zero trailing-whitespace matches in the three touched/added Rust files;
* `wc -l` and `sha256sum` recorded above;
* `git status` used to confirm no central or Team2 file was modified by this
  task (the pre-existing working-tree changes belong to other work and were not
  touched).

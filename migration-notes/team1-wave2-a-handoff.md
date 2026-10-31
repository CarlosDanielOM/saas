# Team 1 / Lane A — Wave 2-A handoff (Polar billing domain events + adapters + tests)

Date: 2026-10-31
Lane: `team1-billing-ai` worker LANE-A
Checkout: `/root/saas-rust` (branch `master`), shared with sibling lanes.
Status: **AUTHORED — NOT RUN.** Nothing here was compiled, formatted, executed,
deployed, or committed. Root runs every check centrally.

Tooling disclosure: this turn used only read-only inspection, `sha256sum` on
repository files, and a static bracket/quote balance scan over the new Rust and
`.cjs` files. **No host `node` was invoked at all** — not to execute an oracle and
not even for `--check`. The oracles' own pinned assertions are the gate.

## 1. Files

### 1.1 Wave 2-A implementation

| File | Lines | SHA-256 |
|---|---|---|
| `src/domain_events/polar_billing/mod.rs` | 425 | `86a2839546374062ccbd49381cbf0b05c7ff1535a0dee2e723e593ab2c1808fa` |
| `src/domain_events/polar_billing/entitlements.rs` | 758 | `8e38d810539e2d532e5a3f02e5354d3e7bb6a87c1b53ce051617bde5578f408c` |
| `src/domain_events/polar_billing/plan_projection.rs` | 413 | `0ef3b06cad9a9bbf2152f0520a32c80cde2b61ecadb7762c593abdb3cff7bc40` |
| `src/domain_events/polar_billing/credits_projection.rs` | 281 | `7a990b1c9eef5b09ec70dbace1392ddbccd902d17e9c0106d4202f51f943f001` |
| `src/domain_events/polar_billing/webhook_signature.rs` | 268 | `1b3a1303f202bed891895da41ffd0472cb1f149c96fd801c512dc9cdf91aa64c` |
| `src/domain_events/polar_billing/mongo_store.rs` | 269 | `7184e633de57483c015b4c20361092af0c729fd0d994a7cc4c3aa63fb2bd8edb` |
| `src/domain_events/polar_billing/mongo_owner.rs` | 142 | `9ed8bfda5e0ac3d99c221d2405ac3384430d29d7f7b2d1d1c0360ee5413a1c05` |
| `src/domain_events/polar_billing/plan_cache_effects.rs` | 182 | `bd8b3b03aa2dc45a0a5c30f23f5a41d31940b429289c3e18c46346f344153ef5` |

### 1.2 Tests and oracle fixtures

| File | Lines | SHA-256 |
|---|---|---|
| `tests/polar_entitlements.rs` | 688 | `ef976c77e126824bbc99893456bc69734a8d80e09ddb7f0f6d5ecf750664e942` |
| `tests/polar_billing_events.rs` | 1609 | `cb0190affad4f62398f5f422ebedf0582a829114b2018d67df7adc06d25fbbd8` |
| `tests/polar_webhook_signature.rs` | 313 | `0570d0a1a551b6426700f58b47746e07e4d12c2cdf4b18797a362727d2f0cc95` |
| `tests/polar_billing_mongo.rs` | 656 | `91971f13a8925e89e26e66b68ff1013de8b17465062e9a47d91737a565189a15` |
| `tests/fixtures/polar_billing_events_reference.cjs` | 491 | `0b5118ea736dcd8476c986ad3316cce423d5a7704f1b90fd1198f727d595c8e4` |
| `tests/billing_reference.rs` | 668 | `35e4091a33f59860577977182eb48372b62aa1a2d355b9233a0120fe6c2702bb` |
| `tests/billing_adapters.rs` | 818 | `822c5caf5f45072ed2f48d86dfac9e94e2fe1e2877ff226b8fd36b3299edec49` |
| `tests/fixtures/billing_reference.cjs` | 473 | `4f279de298c71a84a375b1f0208e06c067b6408c246a712790df26728c3a6ffa` |
| `src/utils/ai_credit_sources.rs` | 506 | `0887d30ce11275e9034cb3ec8b74e742fba8745fdc8ae97cbed43880f8f72c00` |

`tests/billing_adapters.rs`, `tests/fixtures/billing_reference.cjs`, and
`src/utils/ai_credit_sources.rs` are unchanged from the previous turn; their
hashes are listed so the record is complete.

## 2. Crate-path correction (important for integration)

The crate exposes `src/domain_events/mod.rs` as **`domain_event_contracts`**
(`src/lib.rs`: `#[path = "domain_events/mod.rs"] pub mod domain_event_contracts;`),
not as `domain_events`. Every module and test in this lane now uses
`crate::domain_event_contracts::…` / `dima_rust::domain_event_contracts::…`; the
earlier `domain_events::…` paths were wrong and are fixed. The public path to this
feature is therefore:

```rust
dima_rust::domain_event_contracts::polar_billing::{plan_projection, credits_projection, …}
```

## 3. Concrete adapters (the wave-2-A completeness requirement)

| Adapter | Implements | Behaviour |
|---|---|---|
| `mongo_store::MongoPolarBillingStore` | `PolarBillingStore` | Reads/writes the `users` collection through `schemas::users::schema()`; `find_owner` uses the schema's default (hidden-excluding) projection; `plan_find_one_and_update` runs the caller's exact filter/`$set` with `returnDocument: After`; `credit_find_one_and_update` / `credit_find_by_id` apply `.select('+polar_credit_snapshot')` by removing the field from the schema's hidden exclusion, so the snapshot is returned while every other hidden field stays excluded; `unset_plan_effects_pending` matches `{_id, polar_plan_event_key}`; every Mongo failure is `PolarBillingError::Runtime`, never a panic |
| `mongo_owner::MongoPolarOwnerResolver` | `PolarOwnerResolver` | Resolves a Polar **customer** subject in the source's order: pinned `polar_sh_customer_id`, then an ObjectId `externalCustomerId` checked against the link, then the retained `legacyTwitchChannelId` through `accounts: {$elemMatch: {type: 'twitch', id}}` with the source's `$or` link condition. Returns the full owner (id, plan tier, Polar customer id, Twitch accounts); a non-customer subject returns `None`; an unresolvable Polar customer is `owner:polar customer mapping unresolved` |
| `plan_cache_effects::PlanCacheFenceEffects` | `PolarBillingEffects` | `invalidate_plan` → the existing `PlanCacheFence::invalidate_plan` (which owns `INVALIDATE_PLAN_SCRIPT`); `sync_credits` → `PlanCacheFence::sync_credits` (owns `SYNC_CREDITS_SCRIPT`); `delete_cache_key` → a plain `DEL`; `adjust_usage_retention` → the native `utils::ai_usage_retention::AiUsageRetention`. Also exposes `invalidation_keys` / `sync_credits_keys`, built from the fence's own key helpers so they cannot drift |

Both the trait and the concrete implementation exist; the traits remain the
substitution seam.

## 4. Corrected retention finding

`adjustAiUsageRetention` **is** natively ported:
`src/utils/ai_usage_retention.rs` documents itself as the explicit-database
adapter and exposes `AiUsageRetention::{new, with_clock, adjust}` (+
`RetentionError`). Its `adjust` already preserves the source semantics: an empty
list returns immediately, the tier is validated through `RetentionTier`, the
dashboard collection is deleted, the ledger state's `coverageStart` is raised with
`$max`, the receipt/daily collections receive `retentionTier` and `$dateAdd`
expiry from `occurredAt` (days) and `dayStart` (days + 1), and the two expiry
deletes run as a `Promise.all` equivalent — `tokio::spawn` for both plus
`tokio::select!` so the first failure rejects while the sibling continues.

The earlier "no native equivalent" finding was wrong. The seam is gone:
`PolarBillingEffects::adjust_usage_retention` is now implemented by calling that
adapter, and `PlanCacheFenceEffects` holds the retention handle. No
five-collection mutation was re-implemented, and no `try_join_all` was added
because the adapter's `select!` already gives fail-fast rejection with the
sibling continuing — adding a second concurrent primitive here would duplicate
the mutation rather than reuse it.

## 5. Central patches (report only)

`dimabot/Cargo.toml` `[features]`:

```toml
billing-service = ["polar-client", "ai-credit-projection", "credit-policy", "plan-cache", "js-date", "dep:sha2"]
polar-billing-events = ["domain-events", "mongo", "redis", "polar-client", "credit-policy", "plan-cache", "ai-credit-projection", "billing-service", "ai-usage-retention", "unicode-collation", "dep:sha2", "dep:serde_json", "dep:uuid"]
```

(`ai-usage-retention` added: it provides `utils::ai_usage_retention` and
`application-schemas`, which the Mongo adapters need.)

`dimabot/Cargo.toml` test targets:

```toml
[[test]]
name = "credit_packs"
required-features = ["billing-service"]
[[test]]
name = "credit_gift_provider"
required-features = ["billing-service"]
[[test]]
name = "billing"
required-features = ["billing-service"]
[[test]]
name = "ai_credit_sources"
required-features = ["billing-service"]
[[test]]
name = "billing_reference"
required-features = ["billing-service"]
[[test]]
name = "billing_adapters"
required-features = ["billing-service"]
[[test]]
name = "polar_entitlements"
required-features = ["polar-billing-events"]
[[test]]
name = "polar_billing_events"
required-features = ["polar-billing-events"]
[[test]]
name = "polar_webhook_signature"
required-features = ["polar-billing-events"]
[[test]]
name = "polar_billing_mongo"
required-features = ["polar-billing-events"]
```

`dimabot/src/utils/mod.rs`:

```rust
#[cfg(feature = "billing-service")]
pub mod ai_credit_sources;
#[cfg(feature = "billing-service")]
pub mod billing;
#[cfg(feature = "billing-service")]
pub mod credit_gift_provider;
#[cfg(feature = "billing-service")]
pub mod credit_packs;
```

`dimabot/src/domain_events/mod.rs`:

```rust
#[cfg(feature = "polar-billing-events")]
#[path = "polar_billing/mod.rs"]
pub mod polar_billing;
```

## 6. Source → module map

| Module | TypeScript source |
|---|---|
| `polar_billing::entitlements` | `src/domain_events/polar_entitlements.ts` |
| `polar_billing::plan_projection` | `polar_billing_events.ts`: `applyPolarPlanDomainEvent`, `projectPolarPlan`, `reconcilePolarPlanEntitlement` |
| `polar_billing::credits_projection` | `polar_billing_events.ts`: `applyPolarCreditsDomainEvent`, `LEGACY_USAGE_METER_ID` |
| `polar_billing::webhook_signature` | `src/server/routes/webhooks/polarsh.webhook.ts` (`validateEvent`) + the Polar SDK's `standardwebhooks` wrapper |
| `polar_billing::{mongo_store,mongo_owner,plan_cache_effects}` | the `IUsers` reads/writes, `resolveOwner`, and the cache/retention effects of the same file |
| `polar_billing` (root) | `PolarBillingDependencies` + the reward/gift filters |

## 7. Reuse map

| Existing native module | Satisfies |
|---|---|
| `utils::billing` | `PLAN_PRODUCT_ID_*`, `credit_pack_billing_context_cache_key`, `plan_tier_name` |
| `utils::plan_cache_fence` | `PlanCacheFence::{invalidate_plan, sync_credits}`, the two Lua scripts, `plan_cache_version`, all key helpers, `Exhaustion`, `TtlSeconds`, `FenceError` |
| `utils::ai_usage_retention` | `adjustAiUsageRetention` (the seam replacement) |
| `utils::ai_credit_projection` | `build_ai_credits_data_from_meter`, `AI_CREDITS_METER_ID`, `AI_CREDITS_CACHE_TTL_SECONDS`, `PlanTier` |
| `utils::polar` | Billing/Gift transport; the 10 s entitlement bound is applied explicitly |
| `schemas::users` | collection name, hidden-field projection, `native_collection` |
| `domain_event_contracts` | `DomainEventEnvelope`, `DomainEventPrerequisiteMissingError` (crate path corrected) |

## 8. Fixture and golden contracts

### 8.1 Golden consumers must FAIL, never skip

Both oracle consumers are **hard failures** when the golden is unavailable.
There is no `Ok(())`/skip path on a missing or empty fixture:

- `tests/billing_reference.rs` → `DIMA_BILLING_REFERENCE_DIR` + `billing_reference.json`:
  an absent env var, an unreadable file, or an empty file panics with the path and
  the env var name (audited this turn: no skip path existed, none added).
- `tests/polar_billing_events.rs` → `DIMA_POLAR_BILLING_REFERENCE_DIR` +
  `polar_billing_events_reference.json`: `oracle()` panics naming the env var, the
  resolved path and the `--write` command for a missing/unreadable/empty/invalid
  golden.

`tests/billing_adapters.rs`'s Redis fixture and `tests/polar_billing_mongo.rs`'s
Mongo fixture likewise fail on a missing env var or a non-task-owned namespace;
they are `#[ignore]`d only so a plain `cargo test` does not need a service, and
Root runs them under the lease.

### 8.2 Loopback HTTP (`tests/billing_adapters.rs`, unchanged behaviour)

Real `BillingService` / `GiftProvider` / `PolarCreditSourceReads` against an
in-process `TcpListener` stand-in: the 422 `customer_id` retry (exactly one, retry
omits the field, shared idempotency key), the source request paths/bodies,
portal/checkout response mapping incl. `ProviderResponse(field)`, the gift offer,
and the grant/order paths (asserted byte-for-byte on the wire).

### 8.3 Private Redis (`tests/billing_adapters.rs`)

`DIMA_TEST_REDIS_URL`, `DIMA_RUST_TEST_RESOURCE_OWNER=dimabot-migration`,
`DIMA_BILLING_FIXTURE_NAMESPACE=billing-fixture-…`; key format, TTL
`min(120, ceil(…))` with the 1 s floor, free-tier `expiresAt: null`, and
invalid-cache rewrite. Keys are deleted before and after.

### 8.4 Private MongoDB (`tests/polar_billing_mongo.rs`)

```sh
MONGO_TEST_EXPECT=billing MONGO_URI='mongodb://…/?' \
DIMA_POLAR_BILLING_MONGO_DB='billing-fixture-<unique>' \
  cargo test --test polar_billing_mongo -- --ignored --exact polar_billing_mongo_fixture
```

Covers: the schema-backed owner read and Twitch filtering; the plan
`findOneAndUpdate` `$set` against a real document (tier, until, watermark, key,
fingerprint); the pending bit surviving a failed retention effect and clearing
after a successful retry; a stale observation losing the watermark and raising the
lost-race error; the credit snapshot write; the default projection hiding
`polar_credit_snapshot` while `+polar_credit_snapshot` returns it; the stale
credit event falling back to the stored snapshot; `unset_plan_effects_pending`
matching the event key; owner resolution by pinned link, external ObjectId and
legacy Twitch channel; the missing-owner prerequisite; plus a non-ignored pure
test pinning the five-key invalidation and sync sets. The database is dropped at
the end.

### 8.5 Projection oracle (`tests/fixtures/polar_billing_events_reference.cjs`)

Same canonical pattern: pinned hashes, AST export assertions, virtual-file
typecheck (zero diagnostics), real bodies in a `vm` realm with a scripted
`UsersSchema` and a recording cache, `--write DIR` / `--check DIR` only, four
artifacts, and the untouched `v24.22.1` / V8 / TypeScript-5.9.3 pins. Seven cases:
plan projection, no-Twitch deletion, legacy-tier guard, lost race, reconciliation
dry-run, credits publication, and the legacy-meter exhaustion path. Each case
records the exact filter branches, `$set`, `$unset` acknowledgement, cache keys and
arguments, `DEL` key, and retention call; the Rust consumer recomputes them with
the in-file `Memory` runtime and compares.

`plan_cache_fence.ts` has been retired to Rust, so `planCacheVersion` /
`PLAN_CACHE_VERSION_FIELD` are the only stubbed pieces, documented in the fixture.

Generate centrally with the pinned Node image (never host Node):

```
node tests/fixtures/polar_billing_events_reference.cjs --write "$DIMA_POLAR_BILLING_REFERENCE_DIR"
node tests/fixtures/polar_billing_events_reference.cjs --check "$DIMA_POLAR_BILLING_REFERENCE_DIR"
```

Pinned source hashes: `polar_billing_events.ts`
`bf134b805840bfee44b94f861736976dc6739ac535e75c6bf2203ae11a54948d`,
`polar_entitlements.ts`
`681d065391cdb2853959b52074476d5406e321c51cfa640d72d0c2e057795b81`,
`billing.ts`
`a14d58f094e58dbb34ff5191cbb09b792759187adaca862413873fa83c780c0d`, plus the
unchanged `package.json`, `package-lock.json`, and TypeScript pins from
`billing_reference.cjs`.

## 9. Remaining genuinely external seams

- **Reward** — `PolarRewardApplier::apply_paid_order_reward`. `applyPolarRewardDomainEvent`'s
  filter, `paid`/`orderId`/`subscriptionId`/`totalAmount`/product/cadence
  validation and owner resolution are implemented; the reward application is
  team2-api-data's `src/utils/paid_order_reward.ts` (contract tl1-c4) and **has no
  concrete adapter**. That branch is NOT complete and must not be claimed as such.
- **Gift** — `PolarGiftAcceptor::accept_credit_gift_paid_order`
  (`src/utils/credit_gifts.ts`, a later team1 wave). Filters implemented; the
  acceptor is injected.

## 10. Remaining gaps

1. The HTTP webhook route and raw-body middleware stay central (`src/lib.rs`); the
   verifier, response bodies and header-normalisation rule are delivered here.
2. The oracles and the service-backed fixtures have **not been run**; Root runs
   them centrally and generates the golden files with the pinned Node image.
3. The reward branch awaits team2 (see §9).

## 11. Verification performed here (static only)

- `git status --porcelain` on the central files in the brief: empty (untouched);
  `git diff --check`: clean.
- Bracket/quote-aware balance scan over all twelve Rust files and both `.cjs`
  fixtures: clean.
- No `unsafe`, `todo!`, `unimplemented!`, or `unwrap()` in the eight library
  modules; `std::env` only inside explicit `from_env`-style constructors.
- No host `node` invocation of any kind.

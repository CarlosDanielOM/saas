# Team 1 / Lane A handoff — Polar billing core (Rust)

Date: 2026-10-31
Lane: `team1-billing-ai` worker LANE-A
Checkout: `/root/saas-rust` (branch `master`), shared with two sibling workers.
Wave: **authoring only** — no `cargo`/`rustc`/`rustfmt`/`node`/`npm`/`docker`/network
command was run, no dependency was added, and no git state was mutated. All
verification below is static (reads, `grep`, `git diff --check`, `git status`).

## 1. Files created (this lane's whole diff)

| File | Lines |
|---|---|
| `dimabot/src/utils/credit_packs.rs` | 203 |
| `dimabot/src/utils/credit_gift_provider.rs` | 687 |
| `dimabot/src/utils/billing.rs` | 2007 |
| `dimabot/src/utils/ai_credit_sources.rs` | 494 |
| `dimabot/tests/credit_packs.rs` | 341 |
| `dimabot/tests/credit_gift_provider.rs` | 376 |
| `dimabot/tests/billing.rs` | 521 |
| `dimabot/tests/ai_credit_sources.rs` | 583 |
| `migration-notes/team1-lane-a-handoff.md` | this note |

No other file was created or modified. `Cargo.toml`, `Cargo.lock`, `src/lib.rs`,
`src/utils/mod.rs`, and the other central files listed in the brief were left
untouched; the patches in §2 must be applied by the integration team.

## 2. Central patches to apply (verbatim)

### 2.1 `dimabot/Cargo.toml` — new feature

Add one line inside `[features]` (next to the other opt-in service features,
for example directly after `polar-client = [...]`):

```toml
# Billing context/checkout/portal, gift packs, and credit-source reporting.
# No default feature and no deployed worker profile enables it.
billing-service = ["polar-client", "ai-credit-projection", "credit-policy", "plan-cache", "js-date", "dep:sha2"]
```

Difference from the brief's proposal: **`js-date` was added.** The source's
`getRechargeExpiry` applies `Date.parse` to raw provider strings, so the V8
compatible parser in `utils::js_date` is required. `js-date` only activates
`dep:libc`, which Mongo/`cron-supervisor` builds already compile, and it is not
in `default`. No other feature or dependency is needed: `serde`, `serde_json`
(`float_roundtrip`), `tokio` (with `macros`), `reqwest`, `redis` and `sha2` all
arrive transitively through `polar-client` / `credit-policy` / `plan-cache` /
`ai-credit-projection`.

### 2.2 `dimabot/Cargo.toml` — explicit test targets

Append after the existing `[[test]] name = "js_date"` block:

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
```

(All four files also start with `#![cfg(feature = "billing-service")]`, so they
compile to an empty test target even if auto-discovered before these entries
land.)

### 2.3 `dimabot/src/utils/mod.rs` — module registration

Add, keeping the file's existing `#[cfg(feature = …)]` + `pub mod` style (the
`ai-credit-projection` block near line 134 is a good neighbour):

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

**Decision:** `ai_credit_sources` belongs to `billing-service`. It depends on the
credit-pack catalog, the gift pairs, the Gift Polar transport and the V8 date
parser — a strict subset of this feature — and its classification exists only to
label billing credits. Keeping it in the same feature avoids a second feature
that would enable almost the same graph.

## 3. Source → module map

| New module | TypeScript source | Symbols ported |
|---|---|---|
| `utils::credit_packs` | `src/utils/credit_packs.ts` | `CreditPackKind`, `CreditPackSize`, `CreditPackDefinition`, `CREDIT_PACK_DEFINITIONS`, `getCreditPackDefinition`, `RechargeSubscriptionCycleLike`, `RechargeExpiry`, `getRechargeExpiry`, `PolarCreditPackProduct` (+ price/benefit shapes), `CreditPackConfigurationError`, `buildCreditPackOffers` |
| `utils::credit_gift_provider` | `src/utils/credit_gift_provider.ts` | `GIFT_PACK_PAIRS`, `GiftPackPair`, `GiftOffer`, `GiftProduct`, `GiftCheckout`, `GiftOrder`, `GiftGrant`, `GiftProviderError`, `validateGiftPair`, `loadGiftPair`, `getGiftPackCatalog`, `recoverGiftCheckout`, `getGiftCheckoutOrder`, `getGiftCreditGrant` |
| `utils::billing` | `src/utils/billing.ts` (non-AI-credit part) | `BillingAction`, `BillingScenario`, `BillingContext`, `CheckoutDecision`, `CheckoutCreateRequest`, `CreditPackCatalog`, `CreditPackCheckoutRequest`, `CreditPackCheckoutDecision`, `CreditPackRequestError`, `PortalSessionResponse`, `DiscountLike`, `PolarSubscription`, `PRODUCT_IDS`, `PLAN_RANK`, `WINBACK_MONTHS`, `isUuidV4`, `getPolarBaseUrl`/`getPolarToken` (delegated), `diffMonths`, `getLastActivityDate`, `getDefaultUrl`, `isAllowedHost`, `sanitizeRedirectUrl`, `getDiscountConfigByScenario`, `extractPriceAmountCents`, `getProductBaseAmount`, `listSubscriptions`, `getDiscountById`, `isDiscountApplicableToProduct`, `findDiscountByPromoCode`, `estimateDiscountValue`, `compactMetadata`, `selectBestDiscount`, `inferScenario`, `getCurrentPlanFromActiveSubscription`, `getPaidSubscriptionFromSubscriptions`, `getPaidPlanFromSubscriptions`, `creditPackBillingContextCacheKey`, `validCachedBillingContext`, `cacheCreditPackBillingContext`, `getCachedCreditPackBillingContext`, `getBillingContext`, `getCreditPackCatalog`, `createCreditPackCheckout`, `createBillingCheckout`, `createCustomerPortalSession` |
| `utils::ai_credit_sources` | `src/utils/ai_credit_sources.ts` | `CreditSourceEvent`, `CreditGrant`, `CreditOrder`, `CreditSourceReads`, `polarCreditSourceReads`, `CREDIT_SOURCE_MATCH_MS`, `classifyPolarCreditSources`, metadata `text()`/`at()` rules |

Public names are snake_case; TypeScript field names are reproduced in JSON
bodies (`customer_id`, `external_customer_id`, `allow_discount_codes`,
`metadata`, `pack_type`, `pack_size`, …) and in `#[serde(rename_all = "camelCase")]`
response types (`creditPackOffer`, `GiftOffer`, `rechargeExpiry`).

## 4. Reuse map (existing native module → source dependency)

| Existing native module | Satisfies | Notes |
|---|---|---|
| `utils::polar` (`polarsh.rs`) | `polarRequest` and `giftPolarRequest` | Billing flows use `PolarPolicy::Billing`; gift and credit-source reads use `PolarPolicy::Gift`. Error text, redirect policy, 15 s Gift timeout and body redaction come from there. No second HTTP client was written. |
| `utils::credit_policy` | `credit_packs.ts` catalog + offer validation + recharge expiry arithmetic | `credit_packs.rs` is a typed adapter: `CREDIT_PACK_DEFINITIONS` reads ids/orders from `credit_policy::CREDIT_PACK_DEFINITIONS` (single source of truth for the six UUIDs); `build_credit_pack_offers` delegates so the five error messages and their detection order live in one place. |
| `utils::credit_policy::JsDate` | JS `Date`/TimeClip boundary | Used for expiry instants and `diffMonths`. |
| `utils::js_date::parse_date` | `Date.parse` | `getRechargeExpiry` inputs, `validCachedBillingContext` `expiresAt`, gift `granted_at` confirmation. |
| `utils::ai_credit_projection` | `AI_CREDITS_METER_ID`, `PlanTier` | The AI-credit projection/reader was **not** re-ported. |
| `utils::ai_credit_reader` | `getAiCredits` | Unchanged, not re-implemented. |
| `utils::redis::get_redis_client` | `getDragonflyClient` | Only used by the explicit async `BillingService::with_default_cache`; constructors never open Redis. |
| `redis::aio::ConnectionManager` | Dragonfly handle | Injected, matching `plan_cache_fence` / `ai_credit_reader` adapter style. |

Redis key/TTL parity: `billing:credit-packs:context:v1:<sha256(customerId)[..20]>`,
TTL `min(120, ceil((expiresAt - now)/1000))` with a `1 s` floor, free-tier
contexts normalised to `expiresAt: null`, no new namespace.

## 5. Test coverage written

All tests are deterministic; none needs a network, Docker, production Redis,
MongoDB, or `.env`. No ignored fixture test was added for this lane.

`tests/credit_packs.rs`
- catalog table: all six ids/kinds/sizes/orders, found/absent lookup;
- offers: `Math.round` on units and price, currency lower-casing, name fallback;
- eligibility: `credits` always eligible, `recharge` gated on an active paid plan,
  `eligibility_reason == "paid_plan_required"`;
- each configuration error and message, including detection order (archived
  beats missing price) and rollover mismatch in both directions;
- typed error is a `std::error::Error`;
- recharge expiry: minimum of two timestamps, single timestamp, neither, empty
  and unparseable values, past date clamped to 0 days.

`tests/credit_gift_provider.rs`
- the three configured pairs, `find_gift_pair`, `find_gift_pair_by_fulfillment`;
- valid pair → offer (name trim, price, currency, credits, benefit id);
- mismatch/unconfigured pair, archived/draft/recurring (paid and fulfillment);
- price-shape errors: two prices, priced delivery, currency mismatch,
  non-integer price, benefits on the paid product, zero/two benefits;
- benefit errors: wrong units, non-permanent rollover, wrong meter, wrong type,
  deleted benefit, blank benefit id;
- blank/absent name fallback; every `GiftProviderError` message.

`tests/billing.rs`
- discount selection: higher value wins, first candidate wins a tie, empty set;
- discount estimates for fixed/percentage/unknown, with and without a base;
- applicability for unrestricted/empty/restricted product lists;
- scenario inference: all six scenarios plus subscription-beats-action precedence;
- checkout flow for premium/pro/free/absent/unknown active products;
- current-plan mapping and Pro-over-Premium paid subscription selection;
- redirect sanitising: no allow list, allow-list hit, allow-list miss, relative
  value, empty value, absent value, bare-origin normalisation, env parsing,
  dropped invalid default;
- cache key: prefix, 20 hex chars, distinct per customer, SHA-256 known vector;
- cached context: free normalisation, paid expiry, wrong version, unknown tier,
  expired, missing expiry, non-object;
- metadata compaction; portal request/response mapping and its typed
  missing-field error; source error messages and 400/403 codes; UUID v4
  detection; `diffMonths` whole-month arithmetic.

`tests/ai_credit_sources.rs` (in-file `MemoryReads` implementing the trait)
- unique subscription credit, unique purchased pack, unique gifted credit;
- ambiguous credit (two matching benefits) rejected;
- one benefit with two nearby credits rejected;
- rollover mismatch, different customer, unknown grant, grant benefit/meter
  mismatch, benefit-id mismatch;
- one-time exact-unit requirement (and no order read on mismatch) vs
  subscription unit drift allowed;
- 5 000 ms inclusive window, 5 001 ms rejection, benefit-before-credit rejection;
- unpaid / foreign / subscription orders rejected;
- non-gift source, non-zero gift total, unknown gift product, gift-sourced pack;
- malformed events ignored; per-call grant cache used once; error messages.

## 6. Remaining gaps / deliberate differences

1. **No HTTP route, middleware, or Mongo user loading.** `billing.route.ts` was
   read for caller context only; the route, auth middleware, and
   `UsersSchema` projection stay with the integration team. Callers pass
   `BillingUser` with already-parsed `JsDate` values, matching the
   `credit_policy` date boundary.
2. **`dotenv` file loading is not performed.** Only `BillingService::from_env`,
   `GiftProvider::from_env`, and `PolarCreditSourceReads::from_env` read the
   documented environment names, matching `utils::polar`.
3. **Missing provider fields are typed errors, not `undefined`.** A provider
   response without `checkout.id`/`checkout.url`/`session.id`/
   `session.customer_portal_url` yields `BillingError::ProviderResponse(field)`
   instead of the source's silently-propagated `undefined`. This can only turn a
   would-be broken redirect into an explicit failure.
4. **`console.warn` on the 422 `customer_id` retry** is an injected
   `with_checkout_retry_notice(Arc<dyn Fn(&CheckoutRetryNotice)>)` sink instead
   of a direct log call. Behaviour (single retry without `customer_id`) is
   unchanged; the log destination is the caller's choice.
5. **`console.error` sites were not ported** (`recordAiCreditUsage` logging is in
   `ai_credit_projection`; this slice has no `console.error`). No `getAiCredits`
   fallback path was re-ported.
6. **Degraded reads are explicit.** `getProductBaseAmount`, `getDiscountById`,
   and the credit-pack context cache read/write return `Degraded<T>` with a
   `DegradeReason` instead of swallowing the error. Values are identical to the
   source (`0`, `None`, `false`).
7. **`JSON.stringify` key order is not preserved** in request bodies/cache
   payloads (`serde_json::Map` is a `BTreeMap` here; the crate does not enable
   `preserve_order`). Semantics are unchanged; bodies are compared by Polar, not
   byte-wise. `metadata` values and names are exact.
8. **`credit_packs.rs` is an adapter, not a second catalog.** The ids and the
   validation logic already existed in `credit_policy.rs` (verified port of the
   same TypeScript file). A parallel implementation was rejected under the
   repository reuse-first rule; the typed enum surface and
   `RechargeSubscriptionCycleLike` are the additive part. If the integration team
   prefers full duplication, delete the delegation — but the six UUIDs should
   then live in one place only.
9. **Legacy JS date strings** are supported exactly as V8 does through
   `js_date::parse_date`; no RFC 3339 substitution was introduced.
10. **`referral_code` in `CheckoutCreateRequest`** is accepted for contract
    parity only; like the source, eligibility comes from
    `user.referralCodeUsed`, not the request field.
11. **No deployment/cutover.** Nothing in the TypeScript application imports the
    new modules; production `billing.ts` remains the live path.
12. **`load_gift_pair` returns the validated pair.** The source throws
    `Unknown gift pack` for an unconfigured id, which is reproduced
    (`GiftProviderError::UnknownGiftPack`); the optional-lookup form the brief
    mentioned is the separate synchronous `find_gift_pair` /
    `find_gift_pair_by_fulfillment`, so both shapes exist.
13. **Pagination without a `max_page`.** The source's `result.pagination.max_page`
    read throws when Polar omits pagination. Gift checkout/grant scans and the
    credit-source grant scan treat a missing `max_page` as the standard
    "fewer than `limit` items means the last page" rule instead, matching the
    credit-source source's own fallback and never scanning past the 5/100-page
    caps.

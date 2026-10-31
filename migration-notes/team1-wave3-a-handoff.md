# Credit gifts handoff — not complete

## Files

- `dimabot/src/utils/credit_gifts.rs`: 73 lines; SHA-256 `6535f18052ccafdf6945f73ff08099b3cf6bcbb4d76769ec7c9f659502817f9d`.
- `dimabot/src/utils/credit_gifts/lookup.rs`: 52 lines; SHA-256 `938d22627e224cd10814500b0260b8f25fef6c9954389e059490453b866d542a`.
- `dimabot/src/utils/credit_gifts/checkout.rs`: 62 lines; SHA-256 `f5917d2721e32e148afee8d80c917f3bf633e7150ccc46519e6809161339c9dc`.
- `dimabot/src/utils/credit_gifts/delivery.rs`: 20 lines; SHA-256 `eb4ddd7614df69d530a85f9c48dd39880d1fb3f4e27ce09907f50a1dc48ae066`.
- `dimabot/src/workers/credit_gifts.worker.rs`: 10 lines; SHA-256 `d39f7b0c921e280888ef10a99a7f887334111ef00df04ce6c5decb01c9f2b6cb`.
- `dimabot/tests/credit_gifts.rs`: 24 lines; SHA-256 `d83c35d95a06055fb158492ab947e81cfe8a7a29255f38144e950b8344d6605a`.
- This note's own line count and SHA-256 are reported separately; embedding its digest would change it.

## Integration snippets

These are provisional, not permission to enable the unfinished code. Check the existing feature graph and worker layout when integrating.

```toml
[features]
credit-gifts = ["mongo", "redis", "polar-client", "ai-credit-reader", "domain-events", "dep:uuid", "dep:futures-util"]

[[test]]
name = "credit_gifts"
path = "tests/credit_gifts.rs"
required-features = ["credit-gifts"]
```

```rust
// src/utils/mod.rs
#[cfg(feature = "credit-gifts")]
pub mod credit_gifts;
```

```rust
// src/workers/mod.rs: verify this module is used before adding it.
#[cfg(feature = "credit-gifts")]
#[path = "credit_gifts.worker.rs"]
pub mod credit_gifts_worker;
```

The worker may instead need an explicit Cargo binary target and registry wiring; do not assume this module snippet starts a worker. The feature must also enable whichever existing feature exposes `domain_event_contracts::polar_billing` and `credit_gift_provider`; resolve those against the final manifest.

## Reuse and decisions

The adapter constructs the existing `GiftProvider` and shares its Gift-policy Polar transport; provider recovery and grant methods are available for the unfinished state machine. Mongo `users` and `creditgifts` collections are supplied through the adapter database; confirm actual collection names before integration. The reader equivalent exists in `utils/ai_credit_reader.rs` (`get_ai_credits` with `require_verified`), not in the inspected Rust billing module. The `redis` utility supplies the cache client. Recipient normalization and announcement helpers retain the previously reviewed behavior. The checkout and order guards use raw BSON documents and source messages. Paid-order acceptance filters metadata, checks the reservation, loads buyer and checkout, validates, and updates payment state; it has not been compiled or exercised.

## Test inventory

The feature-gated test file covers normalization and validation, both announcement locales, basic URL allowlisting and case-insensitive gift ID derivation. No test was run. Identity/price guards, real Mongo/Polar behavior, lease fencing and state transitions still require tests.

## Not complete

The concrete `PolarGiftAcceptor` implementation is present but unverified; the branch is not shippable. Checkout creation, reservation/upsert, customer verification, idempotent purchase and recovery, fulfillment checkout and free-order verification, bounded claim and fenced lease state machine, retries, delivery, verified credit refresh and Redis invalidation, and injected Twitch chat are missing. The worker remains a fail-closed placeholder with no watchdog, signal handling, or loop. Mongo/Polar integration, Redis cache effect and real reader wiring, injected chat adapter, feature/module registration, worker binary and supervisor registration, isolated runtime tests and caller adoption are outstanding. Confirm guard parity and all collection names, driver APIs, write concern, timeout behavior and feature dependencies before integration. The current code has not been compiled, formatted, executed, committed or deployed. No production resources were touched.

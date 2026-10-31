# Pet settings service — authoring handoff

`pet_settings.service.rs` now authors defaults, validation, Mongo persistence and get/save orchestration. It is not registered in central files and has not been compiled, run, tested or deployed. TypeScript callers (pet routes, OAuth, admission, selection, queue, runtime, tokens and sockets) are unchanged.

## Reuse and behavior

The Mongo adapter uses slice 9 `pet_settings` / `pet_runtime` schema collections and their unique index; `users` ownership is queried with `$elemMatch`, and profile reads use `channelaipersonalities`. Voice catalogs reuse `utils::tts::KOKORO_VOICES` and `tts_services::fish_tts::FISH_VOICES`. `PetSettingsService` receives the existing team4 `AssetLibrary` and its actual `with_asset_library` lock and `find_asset`; its native constructor registers the existing `MongoPetConsumer`. Integration must pass the same `Arc<AssetLibrary>` used by uploads and deletes.

Save orders plan, request and settings validation, conditional profile lookup, previous record and session validation before the owner lock; inside the lock it validates both asset references, installs the index and performs the revision insert/CAS, invalidates, and calls get while still holding the lock. The lock's `AssetError` result wraps an inner service result so Mongo, pet, settings and asset errors remain distinguishable. Get performs the three independent reads concurrently, normalizes legacy fields, resolves profile/rules, computes readiness/appearance issues and lease status. The concrete store has no import-time I/O. Injected store and asset repository seams exist for source-oracle replay; production uses `MongoPetSettings` and the shared native `AssetLibrary`.

## Required concrete dependencies and gaps

Team4 must implement `PetCoordination::validate_sessions(owner, playback, previous)` using owned OAuth sessions and live authorized peers, `has_shared_vts_readiness(owner, generation, revision, session)` using the shared readiness projection, and `invalidate(owner, "settings_changed")` with all real state side effects. Its errors must be mapped to `Error::Pet { code, status }` without swallowing failures. These are required application dependencies, not completed by the trait or test doubles. Confirm their exact contracts when team4 lands. Consumer registration requires the same shared native library instance; `AssetLibrary::native` registers `MongoPetConsumer` already, whereas `with_repositories` does not. No OAuth or pet caller adoption is included.

Parity caveats for integrator review: Rust `String`/`serde_json::Value` cannot represent lone UTF-16 surrogates. Rust validation currently requires strings for enum choices where the source first applies JavaScript `String(...)` to check some enum values, and Rust's whitespace trimming differs at some Unicode code points. Malformed historical documents can raise `MalformedStoredData` instead of a JavaScript runtime error, and Mongo ObjectId cast errors are represented as `InvalidUserId`. The exact Mongo driver's BSON numeric serialization, index behavior, Mongoose casting/validators, date formatting and error propagation need execution against isolated fixtures. The low-level public `write` primitive expects already validated settings; application callers must use `save`. Rust types and feature gates require compiler review.

## Authored checks, not executed

The pinned actual-source oracle stubs the same database, asset, session, readiness and invalidation boundaries, imports the real Fish catalog and archived Kokoro catalog (the active TypeScript file was retired), and includes validation plus read/save scenarios and error ordering. The native replay uses a test store and the real native AssetLibrary with a test asset repository; it compares outputs, errors, persistence and session/index/write/invalidation/readiness order. Asset-ID and lock trace entries are excluded from trace equality because the native asset repository receives only owner; result cases exercise missing and invalid assets. It does not yet prove concurrent delete/write exclusion or failure injection at every Mongo operation. The ignored private Mongo test covers ownership, plan, `$elemMatch`, first insert, duplicate and stale revision conflicts, persisted revision and value, empty profile/runtime reads, and get/save with a concrete Mongo store and native asset library including failed asset and stale-revision writes. Neither oracle nor tests were run in authoring.

## Integration snippets (central files remain untouched)

```toml
pet-settings-service = ["application-schemas", "tts-services", "media-assets", "credit-policy", "dep:serde_json"]
```

```rust
// src/lib.rs
#[cfg(feature = "pet-settings-service")]
#[path = "server/services/pet_settings.service.rs"]
pub mod pet_settings_service;
```

Register slice 9 `pet_settings` and `pet_runtime` under the feature in `schemas/mod.rs`; register team4's `media` module as directed by its handoff. Audit exact feature names and central ownership before applying. Run the oracle only under the pinned isolated Node/TypeScript/Mongoose environment, external empty directory and SHA-256 fixture contract. The private Mongo test requires an isolated task-owned URI, unique empty `rust_pet_settings_fixture_*` database, `PET_SETTINGS_TEST_MONGO_ACK=disposable`, and the established owner marker; it drops that database. The integration team must lease and inspect those resources before execution.

Lead static follow-up: `get` now formats `updatedAt` with the existing JavaScript Date/TimeClip formatter, preserving `.000Z` when the milliseconds are zero; the proposed feature explicitly enables `credit-policy`. `read_formats_updated_at_like_javascript_date_json` authors a direct read-boundary regression for that timestamp. The fixture replay still masks other timestamps. This follow-up is uncompiled and untested.

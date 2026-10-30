# Ordinary application schemas handoff

**Status: verified local schema/type batch; source retirement accepted.** Commit `bb4bf87f17485d81e9d244cbd59ae9406851ccec` retired the six ordinary TypeScript schema sources byte-for-byte and verified their native descriptors, source replays, private Mongo behavior, and strict checks. The verification summary and current rollup are in [the functional migration batch note](functional-migration-batches-2026-10-30.md). Caller adoption and deployment remain separate.

The detailed authoring record below is historical where it describes pending parent wiring, execution, or source files remaining live. Its candidate-specific contracts remain useful; the accepted scope and results are summarized by the linked batch note.

Benchmark drafts are preserved and deferred. They are not an acceptance gate. Measure them only after the native application works.

HEAD at authoring: `cf0c6d72adafeb139f56f232033b954f1df30bd9`. The six TypeScript sources stay live. No retirement, archive, matrix, manifest, README, OpenRouter attribution, or resolver edits.

## Commit the shared helper first

`dimabot/src/schemas/ordinary_model_values.rs` is the strict DTO helper. `dimabot/src/schemas/follow_defense_schema_values.rs` already imports it read-only. Parent should validate and commit this helper before the follow-defense schema. Do not rename or change these signatures.

Follow-defense imports:

- `Reader`, `StrictDecodeError`
- `insert_string`, `insert_optional_string`, `insert_f64`, `insert_optional_f64`
- `insert_datetime`, `insert_nullable_datetime`

It calls `Reader::new`, `with_prefix`, `document`, `location`, `require_string`, `require_bool`, `require_datetime`, `optional_string`, `require_array`, `optional_document`, and `nullable_datetime`. It builds `StrictDecodeError { path, kind }` itself. It does not call `js_f64` or `require_f64`. Its own number reader accepts non-finite `Double` values. `require_f64` / `js_f64` reject non-finite numbers. Leave both behaviors.

`Reader` ignores unknown keys and `__v`. Ordinary readers treat BSON null as `kind: "null"`. `nullable_datetime` is the exception: missing is `None`, null is `Some(None)`, a date is `Some(Some(DateTime))`. Readers do not reapply schema defaults. `require_array` returns `&Vec<Bson>`. `optional_document` / `require_document` return a `Reader` whose `location()` is the dotted prefix.

`insert_*` helpers write owned BSON. Strings go through `JsString::to_utf8_lossy`, which replaces each unpaired UTF-16 unit with U+FFFD. Rust BSON cannot hold a lone surrogate. `CalendarDate` is `day` / `month` / `year` as `f64`, with `from_reader` and `to_document`.

## Six concrete models

Each module exposes `MODEL_NAME`, `COLLECTION_NAME`, `EXPORT_NAME`, `schema()`, `collection(database)`, `repository(database)`, and `async install_indexes(database)`. Constructors do not connect. Repositories are `SchemaRepository` on a caller-owned database. There is no trait-only stand-in.

Collection names follow installed Mongoose 8.24.2 `pluralize`: lowercase, then the `s$` rule keeps a trailing `s`. The oracle must reconfirm `model.collection.name`.

| Source model | Rust module | Collection | Runtime export | Indexes | Timestamps |
| --- | --- | --- | --- | --- | --- |
| `temporary_moderator` | `temporary_moderator` | `temporary_moderators` | `TemporaryModeratorSchema` | `channelID`, `userID`, `expireTimestamp`, unique `(channelID, userID)` | none |
| `vip` | `vip` | `vips` | `VipSchema` | none | none |
| `titleConfig` | `title_config` | `titleconfigs` | `TitleConfigSchema` | none | none |
| `TriggerFile` | `trigger_file` | `triggerfiles` | `TriggerFileSchema` | none | none |
| `eventsub` | `eventsub` | `eventsubs` | `default` | `(channelID, type)`, `id` | none |
| `site_analytics` | `site_analytics` | `site_analytics` | `SiteAnalyticsSchema` | unique `singletonKey` | `created_at` / `updated_at` |

No TTL was declared. Do not invent `expireAfterSeconds` on `expireTimestamp`. Callers query `$lte` and delete.

`date.month` on VIP is `FieldDefault::LocalMonthZero` (`Date#getMonth`, 0–11). TriggerFile and the existing `command_timer` date stay `FieldDefault::LocalMonth` (`getMonth() + 1`, `tm_mon + 1`). Defaults run in `resolve_default` on each construct. The `OnceLock` caches only the descriptor.

VIP `expireDate` is a required object with no defaults. Missing parent reports `expireDate.day` / `.month` / `.year`. A present null parent stays null and does not run child checks. A present null `_id` stays null.

Eventsub `condition`, `transport`, and `cheerTiers` are Mixed storage with `minimize()`. Typed views are `ICondition`, `ITransport`, `ICheerTiers`, and `IEventsub`. Empty required `{}` validates and is then omitted, so `IEventsub::from_document` fails even though `construct` accepted it. Empty objects inside an array stay. Unknown Mixed keys stay in the repository document and are ignored by the view. This module does not use `utils::eventsub::Condition`.

`IEventsub.created_at` is the Twitch string. `remote_missing_since` is `Option<Option<DateTime>>`. `document_id` reads the generated ObjectId, which the interface does not declare.

Site `liveChannels` is an array of subdocuments with `generate_id: false`. `botPlatforms` is `ArrayElement` of `twitch | kick`. `planTier` is `free | premium | pro` on `site_analytics::PlanTier`. It is not `utils::ai_credit_projection::PlanTier`. Schema timestamps are applied by `prepare_insert` / `prepare_save`, not by `construct`. `createdAt` on VIP, temporary moderator, and TriggerFile is `FieldDefault::Now` at construct.

Strict DTOs: `ITemporaryModerator`, `IVip`, `ITitleConfig`, `ITriggerFile`, `ILiveChannel`, `ISiteAnalytics`, plus the Eventsub types above. `to_document` writes the declared fields. The repository still round-trips raw BSON that a strict reader rejects.

## Core delta

`dimabot/src/schemas/schema.rs` adds `FieldDefault::LocalMonthZero` and one `resolve_default` arm: `month - 1`, where `month` is the existing one-based libc month. `LocalMonth` is unchanged. Non-Unix `local_calendar` still returns `None`.

## Parent wiring

Do not put this feature in `default` or a worker profile. Do not edit `src/lib.rs`. Do not append these schemas to `definitions()` (the 42-element catalog).

In `dimabot/Cargo.toml`, after `application-schemas`:

```toml
ordinary-application-schemas = ["application-schemas"]
```

In `dimabot/src/schemas/mod.rs`, next to the other feature-gated modules:

```rust
#[cfg(feature = "ordinary-application-schemas")]
#[path = "ordinary_model_values.rs"]
pub mod ordinary_model_values;
#[cfg(feature = "ordinary-application-schemas")]
#[path = "temporary_moderator.schema.rs"]
pub mod temporary_moderator;
#[cfg(feature = "ordinary-application-schemas")]
#[path = "vip.schema.rs"]
pub mod vip;
#[cfg(feature = "ordinary-application-schemas")]
#[path = "title_config.schema.rs"]
pub mod title_config;
#[cfg(feature = "ordinary-application-schemas")]
#[path = "trigger_file.schema.rs"]
pub mod trigger_file;
#[cfg(feature = "ordinary-application-schemas")]
#[path = "eventsub.schema.rs"]
pub mod eventsub;
#[cfg(feature = "ordinary-application-schemas")]
#[path = "site_analytics.schema.rs"]
pub mod site_analytics;
```

`lib.rs` already exposes `schemas` behind `application-schemas`. The new feature enables that. Tests are `#![cfg(feature = "ordinary-application-schemas")]`, so a default `cargo test` treats them as empty until the feature exists. `unexpected_cfgs` may warn until the feature is declared. Add it before a warnings-denied run.

Generate the oracle after wiring. `sourceSha256` covers `Cargo.toml`, `Cargo.lock`, `src/schemas/mod.rs`, `src/lib.rs`, and `schema.rs`.

## Correctness checks for the parent

Pins: Node `24.22.1` SHA-256 `569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108`, V8 `13.6.233.17-node.58`, ICU `78.3`, Unicode `17.0`, TypeScript `5.9.3`, Mongoose `8.24.2`, BSON `6.10.4`. The oracle compiles the six live modules against a disconnected `new mongoose.Mongoose()` (`autoIndex` and `autoCreate` false, `readyState` 0). It shadows `Date` and sets `instance.now` to a real `Date` at the same mutable clock.

From `dimabot/`, with `DIMA_ORDINARY_SCHEMA_TZ_CHILD` unset:

```sh
DIMA_ORDINARY_SCHEMA_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108 \
DIMA_ORDINARY_SCHEMA_SOURCE_ROOT=<abs dimabot realpath> \
node tests/fixtures/ordinary_application_schemas_reference.cjs --write <abs dir outside the repo>
```

`--check` uses the same variables and the same directory. The directory must be absolute, already a real path, exclusive, and outside `dimabot` and the workspace. The only artifact is `ordinary-application-schemas-reference.json`.

Non-ignored Rust tests, after wiring:

```sh
cargo test --features ordinary-application-schemas --test ordinary_application_schemas
```

Those tests are TZ-relative: trigger month is VIP month plus one, same day and year, ranges 0–11 and 1–12. They do not pin absolute calendar values.

Ignored replay, once per `TZ` in `UTC`, `America/New_York`, `Europe/Berlin`, `Australia/Lord_Howe`, `Pacific/Apia`, so libc is checked in that zone. Node and libc must share zoneinfo.

```sh
TZ=<zone> \
DIMA_ORDINARY_SCHEMAS_FIXTURE_DIR=<abs oracle dir> \
DIMA_ORDINARY_SCHEMAS_FIXTURE_SHA256=<artifact sha> \
cargo test --release --features ordinary-application-schemas \
  --test ordinary_application_schemas -- --ignored replay_ordinary_application_schemas
```

Ignored Mongo uses a private fixture only. `ORDINARY_APPLICATION_SCHEMAS_MONGO_URI` must be a direct `mongodb://` URI. The test sets `direct_connection`, and disables retry reads and writes. `ORDINARY_APPLICATION_SCHEMAS_DATABASE` must be `rust_ordinary_schema_fixture_` plus a non-empty `[a-z0-9_]+` suffix, and must not be `admin`, `local`, `config`, or contain `prod`. `ORDINARY_APPLICATION_SCHEMAS_OWNER` is non-empty and must not contain `prod`. The test refuses a non-empty database, inserts `_owner`, and drops only after that insert. A panic still drops.

```sh
cargo test --features ordinary-application-schemas \
  --test ordinary_application_schemas -- --ignored mongo_ordinary_application_schemas
```

Oracle env names use `DIMA_ORDINARY_SCHEMA_` (singular). Replay and benchmark env names use `DIMA_ORDINARY_SCHEMAS_` (plural).

If replay disagrees on a present null `_id` or a present null nested object, that is existing core behavior. Do not change `schema.rs` to chase it. `Document` equality is key-order sensitive. `list_indexes` key order is assumed to follow the schema key order. If the Mongo test disagrees, report it. Do not add `background` to `SchemaIndex`.

`prepare_save` always writes the update clock. The oracle marks one real path modified before the save hook. An explicit `created_at` on site insert makes `updated_at` equal that value. Null `created_at` on insert is replaced.

## Callers, not edited

- `workers/temporary_roles.worker.ts`: VIP `vip: true`; temporary moderator `expireTimestamp: { $lte }` then `deleteOne`.
- `utils/ast_parser/functions/moderation.functions.ts`: VIP and temporary-moderator upserts. `expireDate.month` is the caller’s zero-based `getMonth()`, not a schema default.
- `commands/add_vip.command.ts`, `functions/redemptions/vip.redemption.ts`, `functions/redemptions/unvipexpired.redemption.ts`: VIP create, save, find, delete.
- `commands/title.command.ts` line 48: title lookup is commented (“titleConfigSchema not migrated yet”). `utils/account_deletion.ts` still `deleteMany`s `TitleConfig` by `channelID`. The schema port is complete; the command gap is a caller gap.
- `scripts/cleanup_invalid_legacy_trigger_files.script.ts`: `fileUrl` `$regex` of an escaped prefix. `utils/account_deletion.ts` and `server/routes/auth.route.ts` delete trigger files by `channelID`.
- Eventsub find/update/delete: `server/routes/eventsub.route.ts` (`_id`, `type` `$in`, dotted `condition.*`), `utils/eventsub.ts`, `utils/eventsub_reconciliation.ts`, `bits_rules/store.ts`, `handlers/eventsub.handler.ts`, `handlers/revocation.handler.ts`, `server/routes/dashboard.route.ts`, `server/routes/auth.route.ts`, `utils/account_deletion.ts`, domain-event announcement and stream-analytics modules. Many handlers import only the type.
- `utils/siteanalytics.ts`: `findOne` / `findOneAndUpdate` on `singletonKey`.

## Deferred benchmarks

These files exist and were not executed. They are not required to accept the schemas:

- `dimabot/tests/fixtures/ordinary_application_schemas_benchmark.cjs`
- `dimabot/tests/ordinary_application_schemas_benchmark.rs`

They share fixed clocks, ids, and inputs, and they return checksums. They contain no timings. Do not treat them as a speed, RSS, or allocation result.

## Owned files

- `dimabot/src/schemas/schema.rs` (`LocalMonthZero` only)
- `dimabot/src/schemas/ordinary_model_values.rs`
- `dimabot/src/schemas/temporary_moderator.schema.rs`
- `dimabot/src/schemas/vip.schema.rs`
- `dimabot/src/schemas/title_config.schema.rs`
- `dimabot/src/schemas/trigger_file.schema.rs`
- `dimabot/src/schemas/eventsub.schema.rs`
- `dimabot/src/schemas/site_analytics.schema.rs`
- `dimabot/tests/ordinary_application_schemas.rs`
- `dimabot/tests/fixtures/ordinary_application_schemas_reference.cjs`
- `dimabot/tests/ordinary_application_schemas_benchmark.rs` (deferred)
- `dimabot/tests/fixtures/ordinary_application_schemas_benchmark.cjs` (deferred)
- `migration-notes/ordinary-application-schemas-handoff.md` (this file)

`Cargo.toml`, `Cargo.lock`, `src/lib.rs`, and `src/schemas/mod.rs` were not edited.

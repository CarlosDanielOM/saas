//! MongoDB document types, collections, indexes and write helpers: the Rust counterpart of the
//! Mongoose schemas in `dimabot/src/schemas/`.
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md` (sections 3 and 7 for
//! data). Writes go through `dima_store::mongo` (read its crate docs first); this crate says,
//! per collection, what those helpers need and what Mongoose would have validated or hooked.
//!
//! # A collection module
//!
//! One module per collection (two related collections may share one, like the countdown and its
//! configuration), named after the collection in snake case (`stream_sessions` for
//! `streamsessions`); types are named after one document (`StreamSession`, `NewStreamSession`).
//! Take the collection name, options, fields, hooks and data census from `ledger/mongo.json` and
//! the TypeScript schema, never from guesses. A module declares, in this order:
//!
//! 1. A header naming the reference file and the options that matter: timestamps, `__v`, hooks,
//!    indexes, `select: false` paths.
//! 2. `COLLECTION`, and each enumeration with `str_enum!` (closed, the schema's values in its
//!    order).
//! 3. `SCHEMA`: the store's [`dima_store::mongo::schema::Schema`], field by field in declaration
//!    order (fields a plugin or `schema.add` appends come last), with every default, `trim` and
//!    `immutable`. A Mixed path declared with `default: {}` is `default_fn` (Mongoose turns the
//!    literal into a function). Private when the collection has hooks.
//! 4. `HIDDEN` (the `select: false` paths), `INDEXES` (in `schema.indexes()` order: field-level
//!    `index: true` first, then `schema.index` calls) and `RULES` (every validator in schema path
//!    order; `$` stands for each element of a document array: `config.$.id`).
//! 5. `INFO`, a [`CollectionInfo`], added to [`REGISTRY`].
//! 6. The read type: `#[derive(Clone, Debug, Deserialize)]`, never `Serialize` (a whole document
//!    is never written back: unknown fields must survive, `MIGRATION.md` data rule 1). `Debug`
//!    is derived only because every private value is a [`Private`] field (its `Debug` prints
//!    `<private>`): every `select: false` path, e-mail addresses, tokens, external customer ids,
//!    payloads with personal data, anything a person would not want in a log. List them in
//!    `PRIVATE` (`INFO.private`); input types wrap the same fields.
//! 7. The input type `NewX` (`Serialize`, `to_document()`, `prepare(ctx)` through
//!    [`CollectionInfo::prepare_create`]): required fields are not `Option`, enumerations are the
//!    closed enums, ranges and lengths are checked by a constructor that returns
//!    [`ValidationError`] (see `custom_timers`). Unset optional fields are left out so the schema
//!    defaults apply, as in `Model.create`.
//! 8. Adapters for hooks (see below) and the few accessors several features need (a user's Twitch
//!    account, the user owning an account). No query repository: features own their queries.
//!
//! ```
//! use dima_model::custom_timers::{CustomTimer, FrequencyUnit, NewCustomTimer, INFO};
//! use dima_store::mongo::WriteContext;
//!
//! // Mongoose's own validation messages, before anything is sent.
//! let error = NewCustomTimer::new("x".repeat(31), "hi", 0, None, "chan", "1").err();
//! assert_eq!(
//!     error.map(|e| e.to_string()).as_deref(),
//!     Some("custom_timer validation failed: name: Path `name` (`xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx...`, \
//!           length 31) is longer than the maximum allowed length (30)., \
//!           frequency: Path `frequency` (0) is less than minimum allowed value (1).")
//! );
//! let timer = NewCustomTimer::new("  promo ", "Follow 👋", 30, Some(FrequencyUnit::Minutes), "chan", "1")?;
//! let insert = timer.prepare(&mut WriteContext::new(0))?; // trimmed, defaults, timestamps, __v
//! assert_eq!(insert.document.get_str("name").ok(), Some("promo"));
//! let stored = bson::RawDocumentBuf::try_from(&insert.document)?;
//! let read: CustomTimer = dima_model::decode(&stored)?;
//! assert!(read.active && read.frequency.0 == 30.0 && INFO.name == "custom_timers");
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! # Read types
//!
//! A read type shows a document as a hydrated Mongoose document shows it and accepts every shape
//! found in the production copy (`tests/real_data.rs` proves it). Unknown fields are ignored.
//!
//! | Mongoose path | Rust field |
//! |---|---|
//! | literal default (`default: 'x'`, `0`, `true`) | the type, `#[serde(default = "…")]` |
//! | default whose real data also holds `null` | `Option<T>`, default `Some(…)` (`commands.description`) |
//! | `default: null`, or no default | `Option<T>` |
//! | `Date.now` and other time-dependent defaults | `Option<T>`: a read never invents the read time |
//! | `Number` | [`dima_store::mongo::number::JsNumber`] (any width; `JsInt` only for integer-only epoch fields) |
//! | `Date` | [`dima_store::mongo::date::JsDate`] |
//! | `enum` | [`Open<E>`] (keeps values the schema no longer lists) |
//! | `Map` of strings | [`values::StringMap`] (stored order) |
//! | sub-document | a struct, `Option` when the path has no default |
//! | `select: false` | `Option<T>`: present only when the read selected it |
//! | content of another domain (`Mixed`, `Object`, `[Object]`) | a named newtype over `Bson` |
//!
//! **Typed or raw.** Type what this collection's schema defines. Keep raw, behind a newtype named
//! for what it is (`CommandBlocks`, `PermissionExpression`, `DomainEventPayload`), what the schema
//! leaves `Mixed` and another package owns: the stored shape stays untouched and that package
//! converts the newtype's public `Bson` into its own types later. No null-versus-missing
//! distinction was needed in this package's read types (the reference makes it only in queries,
//! which features write); add a three-state type only where a reader really tells them apart.
//!
//! A feature reading many documents should skip and log one that fails to [`decode()`] (the error
//! names the field) rather than fail the whole read. Decode from the driver's raw bytes
//! (`Collection<RawDocumentBuf>`): it needs no intermediate `Document`.
//!
//! # Writes
//!
//! - Create: `NewX::prepare(ctx)` gives the store's `PreparedInsert` (its `_id` included); run it
//!   with `store.writes(COLLECTION)`.
//! - Update, `findOneAndUpdate`, save: [`CollectionInfo::prepare_update`],
//!   [`CollectionInfo::prepare_find_one_and_update`], [`CollectionInfo::prepare_save`], which
//!   also treat paths below an immutable `Mixed` path as immutable (the store does not). They
//!   refuse collections with [`Hooks`]: use the module's adapters (`commands::prepare_update`
//!   with an [`availability::Writer`], `admins::prepare_save`...).
//! - A save takes a [`LoadedForSave`], which only [`CollectionInfo::load_for_save`] creates (the
//!   whole document, `select: false` paths included). A save hydrates the loaded document and
//!   writes the defaults of the paths it lacks, so a projected document would lose what the
//!   projection left out (`streamsessions.applied_domain_event_keys` would become `[]`). Module
//!   adapters take it too and go through `writes::save_with_hooks`.
//! - Filters: `dima_store::mongo::filter::prepare_filter(INFO.schema, …)`; responses:
//!   [`CollectionInfo::find_json`] and friends leave out the hidden paths.
//! - At startup, binaries call [`ensure_indexes`] for every [`REGISTRY`] entry with
//!   [`startup_policy`] and a deadline (Mongoose's `Model.init()`: collection, then each index
//!   with `background: true`), log each [`IndexReport`], and write to a collection only once
//!   [`IndexReport::require`] passed for it (the journal's unique indexes); best-effort
//!   collections never wait. The cutover rehearsal runs [`preflight_indexes`] (read only) first.
//!
//! # Tests every collection gets
//!
//! All three run from the registry; a new collection is covered once it is registered and its
//! Mongoose model is added to the two Node scripts. Both scripts need a `dimabot/` checkout with
//! `node_modules` (`DIMABOT_DIR`; its `src/` must be the frozen reference) and run under `TZ=UTC`:
//!
//! ```text
//! cd "$DIMABOT_DIR" && TZ=UTC node_modules/.bin/tsx \
//!     "$REPO/dima-rust/crates/model/tests/mongoose/dump_schemas.mts" \
//!     "$REPO/dima-rust/crates/model/tests/mongoose/schemas.json"
//! eval "$("$REPO/dima-rust/tools/test-env")"
//! cd "$DIMABOT_DIR" && TZ=UTC node_modules/.bin/tsx \
//!     "$REPO/dima-rust/crates/model/tests/mongoose/record.mts" \
//!     "$REPO/dima-rust/crates/model/tests/mongoose/writes.json"
//! ```
//!
//! 1. **Drift** (`tests/schema_drift.rs`, offline): add the model to `MODELS` in
//!    `dump_schemas.mts`; every field, default (computed ones at a fixed instant), option,
//!    hidden path, validator and index is compared with what Mongoose reports.
//! 2. **Real data** (`tests/real_data.rs`, read only on `domdimabot`): automatic through
//!    `INFO.decode`; every document below 50,000 per collection, a spread of 50,000 above
//!    (`DIMA_MODEL_FULL_SCAN=1` reads all). It also checks the copy's indexes against `INDEXES`.
//! 3. **Writes** (`tests/writes.rs`, throwaway database): add the model to `FILES` and cases to
//!    `CASES` in `record.mts` (a `create` naming a `rust` builder, `validate` cases, updates,
//!    upserts, saves, a duplicate key, every hook path); add the builder to `typed_create` and,
//!    for a hooked collection, the adapter to `run_case`. The write commands (filter, update,
//!    inserted documents) and the stored documents are compared exactly (types, key order,
//!    missing versus null). Fixture keys are left out, never `undefined`.
//!
//! What Mongoose really does, learned from the recordings (the helpers and validators here follow
//! it): validation runs before `minimize`, so a required path given `{}` passes and is then not
//! stored; missing required paths are reported first, in reverse schema order; a sub-document's
//! messages name the path inside it; an empty string fails `required`; the server stores
//! `background: true`; it copies an upsert filter's equality fields in a varying order (the test
//! sorts that run only).
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod collection;
pub mod decode;
mod defaults;
pub mod enums;
pub mod error;
mod hooks;
pub mod index;
pub mod loaded;
pub mod private;
pub mod shape;
pub mod validation;
pub mod values;
mod writes;

pub mod admins;
pub mod app_configs;
pub mod ast_variables;
pub mod availability;
pub mod command_user_variables;
pub mod commands;
pub mod countdown_timers;
pub mod custom_timers;
pub mod domain_event_checkpoints;
pub mod domain_event_deliveries;
pub mod domain_events;
pub mod events;
pub mod eventsubs;
pub mod redemption_rewards;
pub mod stream_sessions;
pub mod timer_commands;
pub mod users;

pub use collection::{CollectionInfo, Hooks, ReadError};
pub use decode::{DecodeError, decode, decode_document};
pub use enums::{Open, StrEnum};
pub use error::ModelError;
pub use index::{
    IndexPolicy, IndexReport, IndexSpec, ensure_indexes, preflight_indexes, startup_policy,
};
pub use loaded::LoadedForSave;
pub use private::Private;
pub use shape::ReadNeed;
pub use validation::{Rule, ValidationError, ValidatorError, ValidatorKind};

/// Every collection, one entry per collection (a module may hold two, like the countdown and its
/// configuration).
pub static REGISTRY: &[&CollectionInfo] = &[
    &users::INFO,
    &admins::INFO,
    &app_configs::INFO,
    &commands::INFO,
    &redemption_rewards::INFO,
    &events::INFO,
    &eventsubs::INFO,
    &ast_variables::INFO,
    &command_user_variables::INFO,
    &timer_commands::INFO,
    &custom_timers::INFO,
    &countdown_timers::INFO,
    &countdown_timers::CONFIG_INFO,
    &stream_sessions::INFO,
    &domain_events::INFO,
    &domain_event_deliveries::INFO,
    &domain_event_checkpoints::INFO,
];

//! MongoDB document types, collections, indexes and write helpers: the Rust counterpart of the
//! Mongoose schemas in `dimabot/src/schemas/`.
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md` (sections 3, 7 and 8
//! for data). Writes go through `dima_store::mongo` (read its crate docs first); this crate says,
//! per collection, what those helpers need, validates what Mongoose would have validated, runs
//! what Mongoose would have hooked, and refuses what the collection's read type could not read
//! back.
//!
//! # A collection module
//!
//! One module per collection (two related collections may share one, like the countdown and its
//! configuration), named after the collection in snake case (`stream_sessions` for
//! `streamsessions`); types are named after one document (`StreamSession`, `NewStreamSession`).
//! Take the collection name, options, fields, hooks and data census from `ledger/mongo.json` and
//! the TypeScript schema, never from guesses, and read every call site of the model in
//! `dimabot/src` (creates, updates, saves, the filters they use). A module declares, in order:
//!
//! 1. A header naming the reference file and the options that matter (timestamps, `__v`, hooks,
//!    indexes, `select: false` paths), and the intended differences: the write helpers refuse
//!    what [`shape`] refuses (say which `null`s the census never shows, see `READ_NEEDS`).
//! 2. `COLLECTION`, and each enumeration with `str_enum!` (closed, the schema's values in its
//!    order).
//! 3. `SCHEMA`: the store's [`dima_store::mongo::schema::Schema`], field by field in declaration
//!    order (fields a plugin or `schema.add` appends come last), with every default, `trim` and
//!    `immutable`. A Mixed path declared with `default: {}` is `default_fn` (Mongoose turns the
//!    literal into a function). Private when the collection has hooks.
//! 4. `HIDDEN` (the `select: false` paths), `INDEXES` (in `schema.indexes()` order: field-level
//!    `index: true` first, then `schema.index` calls) and `RULES` (every validator in schema path
//!    order; `$` stands for each element of a document array: `config.$.id`).
//! 5. `PRIVATE`: the private paths (every `select: false` path, e-mail addresses, tokens,
//!    external customer ids, payloads with personal data, anything a person would not want in a
//!    log). Their fields are [`Private`] in the read and input types.
//! 6. `READ_NEEDS`: a [`ReadNeed`] for every read type field that is neither an `Option` nor raw
//!    `Bson` (`not_null` when a serde default reads a missing path, `value` when nothing does,
//!    `present` for a raw `Bson` field without a default). The write helpers refuse to store what
//!    the read type cannot read, so the declaration must match the read type exactly;
//!    `tests/write_read.rs` finds a missing one.
//! 7. `INFO`, a [`CollectionInfo`] (`read_needs: READ_NEEDS`, `private: PRIVATE`,
//!    `decode: decode_boxed::<X>`), added to [`REGISTRY`].
//! 8. The read type: `#[derive(Clone, Debug, Deserialize)]`, never `Serialize` (a whole document
//!    is never written back: unknown fields must survive, `MIGRATION.md` data rule 1). `Debug`
//!    may be derived only because every private value is a [`Private`] field, whose `Debug`
//!    prints `<private>` (`tests/private.rs` checks it).
//! 9. The input type `NewX` (`Serialize`, `to_document()`, `prepare(ctx)` through
//!    [`CollectionInfo::prepare_create`]): required fields are not `Option`, enumerations are the
//!    closed enums, private fields are [`Private`], ranges and lengths are checked by a
//!    constructor that returns [`ValidationError`] (see `custom_timers`). Unset optional fields
//!    are left out so the schema defaults apply, as in `Model.create`. Where a create path of
//!    the reference passes an explicit `null` through (the command restore passes a stored
//!    `description: null`, sign-up passes `plan_tier_until: null`), the field is a
//!    [`values::Nullable`] (unset, `null`, value); nowhere else. A `Mixed` input is `Bson`,
//!    which holds `null` itself.
//! 10. Adapters for hooks (below) and the few accessors several features need (a user's Twitch
//!     account, the user owning an account). No query repository: features own their queries.
//!
//! ```
//! use bson::{Bson, doc, oid::ObjectId};
//! use dima_model::custom_timers::{CustomTimer, FrequencyUnit, NewCustomTimer, INFO};
//! use dima_model::{ModelError, ValidatorKind};
//! use dima_store::mongo::WriteContext;
//! use dima_store::mongo::update::UpdateOptions;
//!
//! // Mongoose's own validation messages, before anything is sent.
//! let error = NewCustomTimer::new("x".repeat(31), "hi", 0, None, "chan", "1").err();
//! assert_eq!(
//!     error.map(|e| e.to_string()).as_deref(),
//!     Some("custom_timer validation failed: name: Path `name` (`xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx...`, \
//!           length 31) is longer than the maximum allowed length (30)., \
//!           frequency: Path `frequency` (0) is less than minimum allowed value (1).")
//! );
//! let mut ctx = WriteContext::new(0);
//! let timer = NewCustomTimer::new("  promo ", "Follow 👋", 30, Some(FrequencyUnit::Minutes), "chan", "1")?;
//! let insert = timer.prepare(&mut ctx)?; // trimmed, defaults, timestamps, __v
//! assert_eq!(insert.document.get_str("name").ok(), Some("promo"));
//! let stored = bson::RawDocumentBuf::try_from(&insert.document)?;
//! let read: CustomTimer = dima_model::decode(&stored)?;
//! assert!(read.active && read.frequency.0 == 30.0 && INFO.name == "custom_timers");
//!
//! // What the read type could not read back is refused: `active` is a `bool`, values are not
//! // cast.
//! let filter = doc! { "_id": ObjectId::new() };
//! let update = doc! { "$set": { "active": Bson::Null, "frequency": "15" } };
//! let Err(ModelError::Validation(refused)) =
//!     INFO.prepare_update(&filter, update, UpdateOptions::default(), &mut ctx)
//! else {
//!     panic!("refused");
//! };
//! let kinds: Vec<_> = refused.errors.iter().map(|e| e.kind).collect();
//! assert_eq!(kinds, [ValidatorKind::Null, ValidatorKind::Type]);
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! # Read types
//!
//! A read type shows a document as a hydrated Mongoose document shows it, accepts every shape
//! found in the production copy (`tests/real_data.rs`) and every shape the write helpers accept
//! (`tests/write_read.rs`). Unknown fields are ignored.
//!
//! | Mongoose path | Rust field |
//! |---|---|
//! | literal default (`default: 'x'`, `0`, `true`) | the type, `#[serde(default = "…")]`, `ReadNeed::not_null` |
//! | required, no default | the type, `ReadNeed::value` |
//! | default whose real data also holds `null` | `Option<T>`, default `Some(…)` (`commands.description`) |
//! | `default: null`, or no default | `Option<T>` |
//! | `Date.now` and other time-dependent defaults | `Option<T>`: a read never invents the read time |
//! | `Number` | [`dima_store::mongo::number::JsNumber`] (any width; `JsInt` only for integer-only epoch fields) |
//! | `Date` | [`dima_store::mongo::date::JsDate`] |
//! | `enum` | [`Open<E>`] (keeps values the schema no longer lists) |
//! | `Map` of strings | [`values::StringMap`] (stored order) |
//! | sub-document | a struct, `Option` when the path has no default |
//! | `select: false` | `Option<Private<T>>`: present only when the read selected it |
//! | e-mail, token, personal payload | [`Private<T>`] (inside the `Option`) |
//! | `Mixed`, `Object`, `[Object]` (content of another domain) | a named newtype over `Bson` (`Vec<Bson>` for an array); a `Default` of `{}` where the schema defaults to it |
//!
//! **Null.** For a typed path the schema allows `null` on, decide from the census
//! (`ledger/mongo.json`, `null` counts per path) and the reference code: where `null` is really
//! stored or written, the field is an `Option` and a consumer sees what JavaScript saw; where it
//! is not, the field keeps its type, `READ_NEEDS` lists it, the write helpers refuse `null` with
//! a [`ValidationError`] (kind `null`), and the module header says so. Never read `null` as the
//! default: JavaScript sees `null`, not the default.
//!
//! **Typed or raw.** Type what this collection's schema defines. Keep raw, behind a newtype named
//! for what it is (`CommandBlocks`, `PermissionExpression`, `DomainEventPayload`), what the schema
//! leaves `Mixed` and another package owns: any value may be stored there, so the newtype wraps
//! `Bson` (never `Document`), and that package converts its public `Bson` into its own types
//! later.
//!
//! A feature reading many documents should skip and log one that fails to [`decode()`] (the error
//! names the field) rather than fail the whole read. Decode from the driver's raw bytes
//! (`Collection<RawDocumentBuf>`): it needs no intermediate `Document`.
//!
//! # Writes
//!
//! - Create: `NewX::prepare(ctx)` (through [`CollectionInfo::prepare_create`]: defaults, `trim`,
//!   validation, the write guard) gives the store's `PreparedInsert` (its `_id` included); run it
//!   with `store.writes(COLLECTION)`.
//! - Update, `findOneAndUpdate`: [`CollectionInfo::prepare_update`],
//!   [`CollectionInfo::prepare_find_one_and_update`] (paths below an immutable `Mixed` path are
//!   immutable too, which the store does not do). Updates do not validate (no reference call
//!   sets `runValidators`), but they pass the write guard.
//! - Save: [`CollectionInfo::prepare_save`] takes a [`LoadedForSave`], which only
//!   [`CollectionInfo::load_for_save`] creates (the whole document, `select: false` paths
//!   included: a save writes the defaults of the paths the loaded document lacks, so a projected
//!   one would lose what the projection left out). It validates as Mongoose's
//!   `validateBeforeSave` does (recorded): the whole hydrated document after the caller's
//!   changes, every loaded, changed and required path (an untouched invalid stored value fails
//!   the save too), before the collection's `pre('save')` hooks (what they set is not
//!   validated), errors in Mongoose's order (untouched missing required paths in reverse schema
//!   order, unchanged stored paths in stored key order, changed paths in change order, then
//!   sub-documents). A refused save sends nothing.
//! - The write guard ([`shape`]): every prepared create, update, upsert and save delta is
//!   refused, naming the path, when it holds a value of the wrong BSON type (the store sends
//!   scalars uncast where Mongoose casts them; pass typed values), `null` or a removal where
//!   `READ_NEEDS` says the read type has none, or a dotted write that could create a partial
//!   object (into a sub-document or nested object whose read type needs fields, or at a numeric
//!   array position) without a filter that proves the object exists (a condition on it or a path
//!   inside it, as `free_credit_reset.worker.ts` does); positional `$`, `$[]` need no proof, and a
//!   save checks the loaded document instead. An upsert's inserted document is checked whole.
//! - Hooks: a collection with Mongoose middleware sets [`Hooks`], and the generic entry points
//!   refuse it; its module offers the adapters instead (`commands::prepare_update` with an
//!   [`availability::Writer`], `admins::prepare_save`...). An update adapter applies its hook to
//!   the update, then calls `writes::update_after_hooks(&INFO, …)` (or
//!   `find_and_update_after_hooks`); a save adapter calls `writes::save_with_hooks(&INFO, loaded,
//!   changes, hook, ctx)`, where `hook` returns the changes the middleware makes (`hooks.rs` has
//!   the `updatedAt`-on-save one). Both run validation and the guard; never call the store's
//!   helpers directly. A create with document middleware uses `writes::create_with_hooks`
//!   (`pre('validate')` before validation, `pre('save')` after); a hook that reads another
//!   collection takes what it reads as an argument (`channel_ai_personalities` takes the owner's
//!   plan), and a hook that throws is [`ModelError::Refused`] with the reference's message.
//! - Filters: `dima_store::mongo::filter::prepare_filter(INFO.schema, …)`; responses:
//!   [`CollectionInfo::find_json`] and friends leave out the hidden paths.
//! - At startup, binaries call [`ensure_indexes`] for every [`REGISTRY`] entry with
//!   [`startup_policy`] and a deadline (Mongoose's `Model.init()`: collection, then each index
//!   with `background: true`), log each [`IndexReport`] (every index: exists, created, or failed
//!   and why), and write to a collection only once [`IndexReport::require`] passed for it (the
//!   journal's unique indexes); best-effort collections never wait. The cutover rehearsal runs
//!   [`preflight_indexes`] (read only) against production first.
//!
//! # Tests every collection gets
//!
//! All five run from the registry. A new collection is covered once it is registered, its
//! Mongoose model is added to the two Node scripts and their output regenerated, and (with hooks)
//! its adapters are added to `entry` in `tests/support/mod.rs`. Both scripts need a `dimabot/`
//! checkout with `node_modules` (`DIMABOT_DIR`; its `src/` must be the frozen reference) and run
//! under `TZ=UTC`:
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
//!    hidden path, validator and index is compared with what Mongoose reports. The snapshot
//!    records the reference commit and the SHA-256 of every source file it was made from (the
//!    schema files and what they import); a file that changed fails the test.
//! 2. **Real data** (`tests/real_data.rs`, read only on `domdimabot`): automatic through
//!    `INFO.decode`; with `DIMA_TEST_REQUIRE_STORES=1` (the gate) every document of every
//!    collection, otherwise a sample above 50,000. It also runs [`preflight_indexes`] on the copy.
//! 3. **Writes** (`tests/writes.rs`, throwaway database): add the model to `FILES` and cases to
//!    `CASES` in `record.mts`: a `create` naming a `rust` builder (and one per create path that
//!    passes a `null` through), `validate` cases, updates, upserts, saves, saves Mongoose refuses
//!    (an invalid change, an invalid untouched value, a missing required path, several errors to
//!    pin the order), a duplicate key, every hook path. Add the builder to `typed_create`. The
//!    write commands and the stored documents are compared exactly (types, key order, missing
//!    versus null). A case Rust refuses on purpose (the write guard) is marked `refused` with the
//!    reason; one it accepts on purpose, `differs`. Fixture keys are left out, never
//!    `undefined`; a dotted update carries a filter that proves what it writes into. Like the
//!    schema snapshot, the recording names the reference commit and the SHA-256 of every source
//!    file it loaded, and a file that changed fails the test.
//! 4. **Write then read** (`tests/write_read.rs`, throwaway database): automatic; every path and
//!    probe value through every write the helpers offer, every written document decoded. Its
//!    base document merges the collection's recorded create cases, so they should fill every
//!    array and sub-document.
//! 5. **Private values** (`tests/private.rs`, offline): automatic; markers at every `PRIVATE`
//!    path must not appear in `Debug`, every `select: false` path and every e-mail, secret or
//!    OAuth token path must be private.
//!
//! What Mongoose really does, learned from the recordings (the helpers and validators here follow
//! it): validation runs before `minimize`, so a required path given `{}` passes and is then not
//! stored; on a new document, missing required paths are reported first, in reverse schema order;
//! a save validates the whole document before the save hooks, in the order above; a
//! sub-document's messages name the path inside it; an empty string fails `required`; the server
//! stores `background: true`; it copies an upsert filter's equality fields in a varying order
//! (the test sorts that run only).
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

pub mod accounts;
pub mod admins;
pub mod ai_usage_dailies;
pub mod ai_usage_dashboards;
pub mod ai_usage_ledger_states;
pub mod ai_usage_receipts;
pub mod app_configs;
pub mod ast_variables;
pub mod availability;
pub mod channel_ai_memories;
pub mod channel_ai_personalities;
pub mod channel_configs;
pub mod channel_extension_items;
pub mod channel_fish_voice_favorites;
pub mod channel_tts_settings;
pub mod command_user_variables;
pub mod commands;
pub mod countdown_timers;
pub mod credit_gifts;
pub mod credit_transactions;
pub mod cron_job_intents;
pub mod custom_timers;
pub mod dimafx_playbacks;
pub mod domain_event_checkpoints;
pub mod domain_event_deliveries;
pub mod domain_events;
pub mod events;
pub mod eventsubs;
pub mod extension_wallet_transactions;
pub mod media_assets;
pub mod oauth_clients;
pub mod oauth_grants;
pub mod oauth_refresh_tokens;
pub mod oauth_sessions;
pub mod redemption_rewards;
pub mod referral_codes;
pub mod site_analytics;
pub mod stream_sessions;
pub mod timer_commands;
pub mod user_extension_inventories;
pub mod user_media_library_items;
pub mod users;

pub use collection::{CollectionInfo, Hooks, ReadError};
pub use decode::{DecodeError, decode, decode_document};
pub use enums::{Open, StrEnum};
pub use error::ModelError;
pub use index::{
    IndexPolicy, IndexReport, IndexSpec, Preflight, ensure_indexes, preflight_indexes,
    startup_policy,
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
    &accounts::INFO,
    &channel_configs::INFO,
    &oauth_clients::INFO,
    &oauth_grants::INFO,
    &oauth_refresh_tokens::INFO,
    &oauth_sessions::INFO,
    &cron_job_intents::INFO,
    &site_analytics::INFO,
    &ai_usage_receipts::INFO,
    &ai_usage_dailies::INFO,
    &ai_usage_ledger_states::INFO,
    &ai_usage_dashboards::INFO,
    &credit_gifts::INFO,
    &credit_transactions::INFO,
    &referral_codes::INFO,
    &channel_extension_items::INFO,
    &user_extension_inventories::INFO,
    &extension_wallet_transactions::INFO,
    &dimafx_playbacks::INFO,
    &channel_fish_voice_favorites::INFO,
    &channel_tts_settings::INFO,
    &channel_ai_memories::INFO,
    &channel_ai_personalities::INFO,
    &media_assets::INFO,
    &user_media_library_items::INFO,
];

//! MongoDB access that stays compatible with the TypeScript (Mongoose 8 on the Node driver)
//! writing the same collections.
//!
//! The specification is `dima-rust/ledger/mongo.md`, section "Rules a Rust data layer must
//! follow to stay compatible"; every rule this module implements was checked against what
//! Mongoose 8.24.3 really sends and stores: `tests/mongo_golden/record.mjs` records it and
//! `tests/mongo_golden.rs` replays every recorded case through these helpers.
//!
//! - [`connection`]: [`MongoStore`] (client + database handle) from a [`MongoConfig`], with a
//!   [`CommandHook`] for telemetry.
//! - [`number`], [`date`], [`id`]: BSON numbers, dates and ids as the Node driver writes and
//!   Mongoose reads them; ObjectId casting.
//! - [`schema`]: the per-collection description the write helpers work from.
//! - [`filter`]: filters cast to the schema types as Mongoose casts them (string ids to
//!   ObjectIds, date text to dates…), for reads ([`filter::prepare_filter`]) and inside every
//!   write helper.
//! - [`update`], [`insert`], [`save`]: the update or document Mongoose would really send for
//!   the caller's intent (timestamps, `__v`, defaults on insert and upsert, `minimize`, `trim`,
//!   immutable paths, sub-document ids, the save delta). They take the time and id source as a
//!   [`WriteContext`], so callers stay deterministic.
//! - [`write`](mod@write): the one checked way to run a prepared write ([`write::Writes`]): unknown
//!   paths fail in debug builds and are reported in release builds; a save that matched
//!   nothing is a conflict.
//! - [`json`]: documents rendered as Express renders a `.lean()` read.
//! - [`error`]: duplicate-key detection; [`transaction`]: transaction with the standalone
//!   fallback.
//!
//! # How a model crate uses this
//!
//! A model crate declares one [`schema::Schema`] per collection as a `static`, mirroring the
//! TypeScript schema field by field (same order, types, defaults, `trim`, `immutable`, sub-schemas
//! and the options matrix in `ledger/mongo.md`). Its typed structs read documents with the
//! tolerant readers ([`number::JsNumber`], [`number::JsInt`], [`date::JsDate`], [`id::DocId`]);
//! every write goes `prepare_*` → [`write::Writes`]; every filter goes through
//! [`filter::prepare_filter`] (or a write helper, which casts its own filter). Hooks
//! (`pre('save')` and the like) are the model's: it adds what they set as changes.
//!
//! ```no_run
//! use bson::{Document, doc};
//! use dima_store::mongo::filter::{prepare_filter, prepare_id_filter};
//! use dima_store::mongo::insert::{InsertStyle, prepare_insert};
//! use dima_store::mongo::json;
//! use dima_store::mongo::save::{Change, prepare_save};
//! use dima_store::mongo::schema::{DefaultValue as D, Field, MapOf, Schema, Timestamps};
//! use dima_store::mongo::update::{Returned, UpdateOptions, prepare_find_one_and_update, prepare_update};
//! use dima_store::mongo::write::SaveOutcome;
//! use dima_store::mongo::{MongoStore, WriteContext};
//!
//! // `new Schema({ … }, { timestamps: true })` in the TypeScript, field by field.
//! static STEP: Schema = Schema::subdocument(&[
//!     Field::string("status"),
//!     Field::date("at"),
//! ])
//! .no_id();
//! static TIMERS: Schema = Schema::new(&[
//!     Field::string("channelID").immutable(),
//!     Field::string("name").trim(),
//!     Field::number("frequency").default(D::Int(5)),
//!     Field::boolean("active").default(D::Bool(true)),
//!     Field::date("lastRunAt").default(D::Null),
//!     Field::string("overlayToken"), // `select: false`
//!     Field::map("steps", MapOf::Subdocuments(&STEP)).default(D::EmptyDocument),
//! ])
//! .timestamps(Timestamps::CAMEL);
//! const COLLECTION: &str = "custom_timers";
//! const HIDDEN: [&str; 1] = ["overlayToken"]; // the collection's `select: false` paths
//!
//! async fn example(store: &MongoStore, id: &str, now_ms: i64) -> Result<(), Box<dyn std::error::Error>> {
//!     // The time and id source of every write: injected, so tests are deterministic.
//!     let mut ctx = WriteContext::new(now_ms);
//!     let mut timers = store.writes(COLLECTION);
//!
//!     // Read: `findById(id)` with the id as the route gave it (a CastError is the 400 the
//!     // route returns), without the `select: false` paths.
//!     let filter = prepare_id_filter(&TIMERS, id, &mut ctx)?;
//!     let loaded: Option<Document> = store
//!         .documents(COLLECTION)
//!         .find_one(filter)
//!         .projection(json::exclusion_projection(HIDDEN))
//!         .await?;
//!
//!     // Update: `updateOne({_id: id}, {$set: {name}, $inc: {frequency: 1}})`.
//!     let update = prepare_update(
//!         &TIMERS,
//!         &doc! { "_id": id },
//!         doc! { "$set": { "name": "  Timer 👋 " }, "$inc": { "frequency": 1 } },
//!         UpdateOptions::default(),
//!         &mut ctx,
//!     )?;
//!     let outcome = timers.update_one(&update).await?;
//!     assert!(outcome.matched <= 1);
//!
//!     // Upsert of one Map entry, as `stream_operations_events.ts` writes progress.
//!     let upsert = prepare_update(
//!         &TIMERS,
//!         &doc! { "channelID": "c1", "name": "daily" },
//!         doc! { "$set": { "steps.announce": { "status": "completed", "at": bson::DateTime::from_millis(now_ms) } } },
//!         UpdateOptions::upsert(),
//!         &mut ctx,
//!     )?;
//!     timers.update_one(&upsert).await?;
//!
//!     // Insert: `Model.create({...})` (defaults, `_id`, timestamps, `__v`).
//!     let insert = prepare_insert(&TIMERS, &doc! { "channelID": "c2", "name": "new" }, InsertStyle::Create, &mut ctx)?;
//!     timers.insert_one(&insert).await?;
//!
//!     // Save: load, change, `doc.save()`, guarded by the revision the client saw.
//!     if let Some(loaded) = loaded {
//!         let revision = doc! { "updatedAt": loaded.get("updatedAt").cloned() };
//!         let save = prepare_save(&TIMERS, &loaded, &[Change::set("active", false)], &mut ctx)?
//!             .with_predicates(&revision)?;
//!         match timers.save(&save).await? {
//!             SaveOutcome::Saved | SaveOutcome::Unchanged => {}
//!             SaveOutcome::Conflict => { /* changed or deleted meanwhile: reload, or report */ }
//!         }
//!     }
//!
//!     // A query filter built from strings: cast like Mongoose (`"true"`, `"5"`, ISO text).
//!     let filter = prepare_filter(
//!         &TIMERS,
//!         &doc! { "channelID": "c1", "active": "true", "frequency": { "$gte": "5" } },
//!         &mut ctx,
//!     )?;
//!     let count = store.documents(COLLECTION).count_documents(filter).await?;
//!     assert!(count <= u64::MAX);
//!
//!     // HTTP response of a document read without the projection (a `findOneAndUpdate` result):
//!     // drop the `select: false` paths, render like Express renders a `.lean()` read.
//!     let found = prepare_find_one_and_update(
//!         &TIMERS,
//!         &doc! { "_id": id },
//!         doc! { "$set": { "active": true } },
//!         UpdateOptions::default(),
//!         Returned::After,
//!         &mut ctx,
//!     )?;
//!     if let Some(mut document) = timers.find_one_and_update(&found).await? {
//!         json::remove_paths(&mut document, &HIDDEN);
//!         let body: String = json::to_json_string(&document);
//!         assert!(!body.contains("overlayToken"));
//!     }
//!     Ok(())
//! }
//! ```
#![warn(missing_docs)]

mod cast;
pub mod connection;
pub mod date;
pub mod error;
pub mod filter;
pub mod id;
pub mod insert;
pub mod json;
pub mod number;
pub mod save;
pub mod schema;
pub mod transaction;
pub mod update;
pub mod write;

pub use cast::{MAX_DEPTH, PrepareError, WriteContext};
pub use connection::{CommandHook, MongoConfig, MongoStore};
pub use error::MongoError;

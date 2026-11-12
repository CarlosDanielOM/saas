//! Maps (`{ type: Map, of: … }`): the value kinds, the key rule and the dropped-path
//! diagnostics. What Mongoose sends for each is pinned by the `*map*` cases of `golden.json`
//! (replayed by `mongo_golden.rs`); this file checks what the replay does not compare.

use bson::{Bson, DateTime, doc, oid::ObjectId};
use dima_store::mongo::insert::{InsertStyle, prepare_insert};
use dima_store::mongo::save::{Change, prepare_save};
use dima_store::mongo::schema::{DefaultValue as D, Field, MapOf, Schema, ValueType};
use dima_store::mongo::update::{UpdateDoc, UpdateOptions, prepare_update};
use dima_store::mongo::{PrepareError, WriteContext};

/// The shape of `stream_operations_receipts` (`dimabot/src/schemas/stream_operations_receipt.schema.ts`).
static STEP: Schema = Schema::subdocument(&[
    Field::string("status"),
    Field::string("reason"),
    Field::date("at"),
])
.no_id();
static RECEIPTS: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("channelID").immutable(),
    Field::date("expiresAt").immutable(),
    Field::map("steps", MapOf::Subdocuments(&STEP)).default(D::EmptyDocument),
    Field::map("variables", MapOf::Values(ValueType::String)),
])
.declared_id()
.no_version_key();

const KEY: &str = "clé 👋 مرحبا";

fn invalid(path: &str, key: &str) -> Option<PrepareError> {
    Some(PrepareError::InvalidMapKey {
        path: path.to_owned(),
        key: key.to_owned(),
        rule: if key.contains('.') {
            "contain \".\""
        } else {
            "start with \"$\""
        },
    })
}

#[test]
fn write_progress_upsert_of_one_entry() -> Result<(), PrepareError> {
    // `stream_operations_events.ts:83`: `$setOnInsert` the immutable fields, `$set` one step.
    let mut ctx = WriteContext::new(0);
    let at = DateTime::from_millis(1);
    let out = prepare_update(
        &RECEIPTS,
        &doc! { "_id": "event-1" },
        doc! {
            "$setOnInsert": { "channelID": "c1", "expiresAt": at },
            "$set": { format!("steps.{KEY}"): { "status": "completed", "at": at, "junk": 1 } },
        },
        UpdateOptions::upsert(),
        &mut ctx,
    )?;
    let Some(UpdateDoc::Document(update)) = out.update else {
        panic!("not sent");
    };
    assert_eq!(
        update,
        doc! {
            "$set": { format!("steps.{KEY}"): { "status": "completed", "at": at } },
            "$setOnInsert": { "channelID": "c1", "expiresAt": at },
        }
    );
    assert_eq!(out.dropped_paths, [format!("steps.{KEY}.junk")]);
    Ok(())
}

#[test]
fn whole_maps_check_keys_and_cast_entries() -> Result<(), PrepareError> {
    let mut ctx = WriteContext::new(0);
    let out = prepare_insert(
        &RECEIPTS,
        &doc! { "_id": "r", "steps": { KEY: { "status": "skipped", "zz": 1 }, "": { "reason": "empty key" } } },
        InsertStyle::Create,
        &mut ctx,
    )?;
    assert_eq!(
        out.document.get_document("steps").ok(),
        Some(&doc! { KEY: { "status": "skipped" }, "": { "reason": "empty key" } })
    );
    assert_eq!(out.dropped_paths, [format!("steps.{KEY}.zz")]);

    for key in ["a.b", "$x", "👋.👋"] {
        let insert = prepare_insert(
            &RECEIPTS,
            &doc! { "_id": "r", "variables": { key: "v" } },
            InsertStyle::Create,
            &mut ctx,
        );
        assert_eq!(insert.err(), invalid("variables", key));
        let update = prepare_update(
            &RECEIPTS,
            &doc! {},
            doc! { "$set": { "steps": { key: { "status": "x" } } } },
            UpdateOptions::default(),
            &mut ctx,
        );
        assert_eq!(update.err(), invalid("steps", key));
    }
    // A `$` inside a key is fine; only a leading one is refused.
    let inner = prepare_insert(
        &RECEIPTS,
        &doc! { "_id": "r", "variables": { "a$": "v" } },
        InsertStyle::Create,
        &mut ctx,
    )?;
    assert_eq!(
        inner.document.get_document("variables").ok(),
        Some(&doc! { "a$": "v" })
    );
    Ok(())
}

#[test]
fn dotted_update_paths_are_sent_unchecked_but_saves_check_them() -> Result<(), PrepareError> {
    let mut ctx = WriteContext::new(0);
    // Mongoose sends `variables.$x` as it is in an update (the server then decides).
    let out = prepare_update(
        &RECEIPTS,
        &doc! {},
        doc! { "$set": { "variables.$x": "y" } },
        UpdateOptions::default(),
        &mut ctx,
    )?;
    assert_eq!(
        out.update,
        Some(UpdateDoc::Document(
            doc! { "$set": { "variables.$x": "y" } }
        ))
    );
    // A save sets the key on the Map first, which refuses it.
    let loaded = doc! { "_id": "r", "variables": { "a": "x" }, "steps": {} };
    assert_eq!(
        prepare_save(
            &RECEIPTS,
            &loaded,
            &[Change::set("variables.$x", "y")],
            &mut ctx
        )
        .err(),
        invalid("variables", "$x")
    );
    assert_eq!(
        prepare_save(
            &RECEIPTS,
            &loaded,
            &[Change::set("variables", doc! { "a.b": "y" })],
            &mut ctx
        )
        .err(),
        invalid("variables", "a.b")
    );
    // An entry of a Map the document does not have sets the whole Map.
    let sparse = doc! { "_id": ObjectId::from_bytes([1; 12]).to_hex(), "steps": {} };
    let saved = prepare_save(
        &RECEIPTS,
        &sparse,
        &[Change::set(format!("variables.{KEY}"), "v")],
        &mut ctx,
    )?;
    assert_eq!(
        saved.update,
        Some(doc! { "$set": { "variables": { KEY: "v" } } })
    );
    assert_eq!(
        saved
            .update
            .as_ref()
            .and_then(|u| u.get_document("$set").ok())
            .and_then(|s| s.get("variables")),
        Some(&Bson::Document(doc! { KEY: "v" }))
    );
    Ok(())
}

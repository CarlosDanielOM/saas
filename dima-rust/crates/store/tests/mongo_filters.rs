//! Filters as the reference builds them (strings from route parameters and Redis), cast by
//! `prepare_filter` / `prepare_id_filter` and run against the local MongoDB: they must match the
//! stored documents, as they do under Mongoose. What Mongoose sends for each filter shape is
//! pinned by `golden.json` (`filters`, replayed by `mongo_golden.rs`). The live part uses its own
//! `dima_test_store_<random>` database and drops it; it is skipped when `DIMA_TEST_MONGO_URI` is
//! not set.

use anyhow::{Context, Result};
use bson::{Bson, DateTime, Document, doc, oid::ObjectId};
use dima_store::mongo::filter::{prepare_filter, prepare_id_filter};
use dima_store::mongo::schema::{Field, Schema, Timestamps, ValueType};
use dima_store::mongo::{PrepareError, WriteContext};
use futures_util::{FutureExt, TryStreamExt};
use std::panic::AssertUnwindSafe;

/// The parts of `custom_timers` / `triggers` the filters touch.
static TIMERS: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::string("name").trim(),
    Field::boolean("active"),
    Field::number("frequency"),
    Field::date("lastRunAt"),
    Field::array("tags", ValueType::String),
])
.timestamps(Timestamps::CAMEL);

/// A collection with string ids (41 collections in the reference).
static RECEIPTS: Schema = Schema::new(&[Field::string("_id"), Field::date("expiresAt")])
    .declared_id()
    .no_version_key();

const ID: &str = "65a1b2c3d4e5f60718293a4b";

fn ctx() -> WriteContext {
    WriteContext::new(0)
}

#[test]
fn find_by_id_with_a_route_parameter() -> Result<(), PrepareError> {
    // `site.route.ts:245` `findByIdAndUpdate(idStr)`, `timer_cache.ts:91` `findById(timerID)`.
    let id = ObjectId::parse_str(ID).map_err(|_| PrepareError::MissingId)?;
    assert_eq!(
        prepare_id_filter(&TIMERS, ID, &mut ctx())?,
        doc! { "_id": id }
    );
    assert_eq!(
        prepare_id_filter(&TIMERS, ID.to_uppercase(), &mut ctx())?,
        doc! { "_id": id }
    );
    for bad in [
        "",
        "nope",
        "65a1b2c3d4e5f60718293a4",
        " 65a1b2c3d4e5f60718293a4b",
        "👋",
    ] {
        assert_eq!(
            prepare_id_filter(&TIMERS, bad, &mut ctx()).err(),
            Some(PrepareError::Cast {
                kind: "ObjectId",
                path: "_id".into()
            }),
            "{bad:?}"
        );
    }
    // A string-id collection keeps the text.
    assert_eq!(
        prepare_id_filter(&RECEIPTS, "event:שלום", &mut ctx())?,
        doc! { "_id": "event:שלום" }
    );
    Ok(())
}

#[test]
fn filters_built_from_strings() -> Result<(), PrepareError> {
    let id = ObjectId::parse_str(ID).map_err(|_| PrepareError::MissingId)?;
    // `trigger.route.ts:1272` `findOne({ channelID, _id: triggerIdStr })`.
    assert_eq!(
        prepare_filter(&TIMERS, &doc! { "channelID": "c1", "_id": ID }, &mut ctx())?,
        doc! { "channelID": "c1", "_id": id }
    );
    let filter = doc! {
        "_id": { "$in": [ID, ID] },
        "active": "true",
        "frequency": { "$gte": "5" },
        "lastRunAt": { "$lt": "2026-11-11T10:00:00.000Z" },
        "name": "  timer 👋 ",
        "$or": [{ "tags": "a" }, { "tags": { "$size": "0" } }],
    };
    assert_eq!(
        prepare_filter(&TIMERS, &filter, &mut ctx())?,
        doc! {
            "$or": [{ "tags": "a" }, { "tags": { "$size": 0 } }],
            "_id": { "$in": [id, id] },
            "active": true,
            "frequency": { "$gte": 5 },
            "lastRunAt": { "$lt": DateTime::from_millis(1_794_391_200_000) },
            "name": "timer 👋",
        }
    );
    assert_eq!(
        prepare_filter(&TIMERS, &doc! { "frequency": "often" }, &mut ctx()).err(),
        Some(PrepareError::Cast {
            kind: "Number",
            path: "frequency".into()
        })
    );
    Ok(())
}

#[tokio::test]
async fn cast_filters_match_what_is_stored() -> Result<()> {
    let Ok(uri) = std::env::var("DIMA_TEST_MONGO_URI") else {
        eprintln!("skipped: DIMA_TEST_MONGO_URI is not set (eval \"$(dima-rust/tools/test-env)\")");
        return Ok(());
    };
    let client = mongodb::Client::with_uri_str(&uri).await?;
    let db = client.database(&format!("dima_test_store_{}", ObjectId::new().to_hex()));
    // A failed assertion panics: the database is dropped first, then the panic goes on.
    let outcome = AssertUnwindSafe(async {
        let id = ObjectId::parse_str(ID)?;
        let timers = db.collection::<Document>("custom_timers");
        timers
            .insert_one(doc! {
                "_id": id, "channelID": "c1", "name": "timer", "active": true, "frequency": 10,
                "lastRunAt": DateTime::from_millis(1_700_000_000_000), "tags": [],
            })
            .await?;
        // The string the reference passes matches nothing unless it is cast.
        assert_eq!(timers.find_one(doc! { "_id": ID }).await?, None);
        let found = timers
            .find_one(prepare_id_filter(&TIMERS, ID, &mut ctx())?)
            .await?
            .context("findById by string")?;
        assert_eq!(found.get("_id"), Some(&Bson::ObjectId(id)));
        let filter = prepare_filter(
            &TIMERS,
            &doc! {
                "channelID": "c1",
                "_id": { "$in": [ID] },
                "active": "1",
                "frequency": { "$gt": "9.5" },
                "lastRunAt": { "$gte": "1700000000000" },
                "tags": { "$size": "0" },
            },
            &mut ctx(),
        )?;
        let matched: Vec<Document> = timers.find(filter).await?.try_collect().await?;
        assert_eq!(matched.len(), 1);
        Ok::<(), anyhow::Error>(())
    })
    .catch_unwind()
    .await;
    db.drop().await?;
    match outcome {
        Ok(outcome) => outcome,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

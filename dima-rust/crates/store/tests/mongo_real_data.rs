//! Read-only pass over the real data in the local `domdimabot` copy (a stale production copy;
//! nothing is written to it). Every value of every field the ledger's type-variance table lists
//! (`ledger/mongo.md`, "BSON type variance") must read as a `JsNumber`, and the integer ones also
//! as a `JsInt`; every `_id` of every collection must read as a `DocId`, every top-level date
//! through `read_time`, and every sampled document must render to JSON that parses back.
//!
//! Skipped with a message when `DIMA_TEST_MONGO_URI` is not set or `domdimabot` is absent.

use anyhow::{Result, bail};
use bson::{Bson, Document, doc};
use dima_store::mongo::date::{JsDate, read_time};
use dima_store::mongo::id::DocId;
use dima_store::mongo::json;
use dima_store::mongo::number::{JsInt, JsNumber};
use futures_util::TryStreamExt;
use mongodb::Database;
use std::collections::BTreeMap;

const DATABASE: &str = "domdimabot";

/// (collection, field paths read as numbers, of which these are integers)
const NUMBER_FIELDS: &[(&str, &[&str], &[&str])] = &[
    (
        "channelaimemories",
        &["confidence", "qdrantPointID"],
        &["qdrantPointID"],
    ),
    (
        "channelstreamsummaries",
        &["duration_minutes", "proposed_actions.confidence"],
        &[],
    ),
    (
        "extensionwallettransactions",
        &["balanceDelta"],
        &["balanceDelta"],
    ),
    (
        "moderation_decisions",
        &["cost", "charge.billableCostUSD"],
        &[],
    ),
    ("stream_activities", &["offset"], &[]),
    (
        "stream_activity_aggregates",
        &[
            "bits",
            "bucket",
            "chatters",
            "commands",
            "count",
            "emoteMessages",
            "emotes",
            "failures",
            "firstSeq",
            "follows",
            "lastSeq",
            "messages",
            "raids",
            "redemptions",
            "subs",
        ],
        &[
            "bits",
            "bucket",
            "chatters",
            "commands",
            "count",
            "emoteMessages",
            "emotes",
            "failures",
            "firstSeq",
            "follows",
            "lastSeq",
            "messages",
            "raids",
            "redemptions",
            "subs",
        ],
    ),
    ("stream_activity_states", &["seq"], &["seq"]),
    ("streamsessions", &["duration_minutes"], &[]),
];

async fn database() -> Result<Option<Database>> {
    let Ok(uri) = std::env::var("DIMA_TEST_MONGO_URI") else {
        eprintln!("skipped: DIMA_TEST_MONGO_URI is not set (eval \"$(dima-rust/tools/test-env)\")");
        return Ok(None);
    };
    let client = mongodb::Client::with_uri_str(&uri).await?;
    if !client
        .list_database_names()
        .await?
        .iter()
        .any(|name| name == DATABASE)
    {
        eprintln!("skipped: the local {DATABASE} copy is not present");
        return Ok(None);
    }
    Ok(Some(client.database(DATABASE)))
}

/// Every value at a dotted path, descending through arrays.
fn values_at<'a>(value: &'a Bson, path: &[&str], out: &mut Vec<&'a Bson>) {
    match (value, path.split_first()) {
        (Bson::Array(items), _) => items.iter().for_each(|item| values_at(item, path, out)),
        (_, None) => out.push(value),
        (Bson::Document(doc), Some((first, rest))) => {
            if let Some(inner) = doc.get(*first) {
                values_at(inner, rest, out);
            }
        }
        _ => {}
    }
}

fn type_name(value: &Bson) -> &'static str {
    match value {
        Bson::Int32(_) => "int",
        Bson::Int64(_) => "long",
        Bson::Double(_) => "double",
        _ => "other",
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn numbers_in_real_data_read_as_js_numbers() -> Result<()> {
    let Some(db) = database().await? else {
        return Ok(());
    };
    let mut failures = Vec::new();
    for (collection, fields, integers) in NUMBER_FIELDS {
        let projection: Document = fields
            .iter()
            .map(|f| ((*f).to_owned(), Bson::Int32(1)))
            .collect();
        let mut cursor = db
            .collection::<Document>(collection)
            .find(doc! {})
            .projection(projection)
            .await?;
        let mut seen: BTreeMap<(String, &'static str), u64> = BTreeMap::new();
        while let Some(document) = cursor.try_next().await? {
            let root = Bson::Document(document);
            for field in *fields {
                let pieces: Vec<&str> = field.split('.').collect();
                let mut values = Vec::new();
                values_at(&root, &pieces, &mut values);
                for value in values.into_iter().filter(|v| !matches!(v, Bson::Null)) {
                    *seen
                        .entry(((*field).to_owned(), type_name(value)))
                        .or_default() += 1;
                    let typed: Result<JsNumber, _> = bson::deserialize_from_bson(value.clone());
                    if JsNumber::from_bson(value).is_none() || typed.is_err() {
                        failures.push(format!("{collection}.{field}: {value:?} is not a JsNumber"));
                    }
                    if integers.contains(field) {
                        let typed: Result<JsInt, _> = bson::deserialize_from_bson(value.clone());
                        if JsInt::from_bson(value).is_none() || typed.is_err() {
                            failures
                                .push(format!("{collection}.{field}: {value:?} is not a JsInt"));
                        }
                    }
                }
            }
        }
        eprintln!("{collection}: {seen:?}");
        if seen.is_empty() {
            failures.push(format!("{collection}: no values read"));
        }
    }
    failures.truncate(20);
    assert!(failures.is_empty(), "{failures:#?}");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ids_dates_and_json_in_every_collection() -> Result<()> {
    let Some(db) = database().await? else {
        return Ok(());
    };
    let mut failures = Vec::new();
    let mut checked = (0_u64, 0_u64, 0_u64);
    let names = db.list_collection_names().await?;
    if names.is_empty() {
        bail!("{DATABASE} has no collections");
    }
    for name in names {
        // Every `_id`.
        let mut ids = db
            .collection::<Document>(&name)
            .find(doc! {})
            .projection(doc! { "_id": 1 })
            .await?;
        while let Some(document) = ids.try_next().await? {
            match document.get("_id").map(DocId::from_bson) {
                Some(Some(_)) => checked.0 += 1,
                other => failures.push(format!("{name}: _id {other:?}")),
            }
        }
        // Dates and JSON on a sample (whole documents can be large: GridFS chunks are skipped).
        if name.ends_with(".chunks") {
            continue;
        }
        let mut sample = db
            .collection::<Document>(&name)
            .find(doc! {})
            .limit(200)
            .await?;
        while let Some(document) = sample.try_next().await? {
            for (key, value) in &document {
                if let Bson::DateTime(date) = value {
                    let ok = read_time(value) == Some(date.timestamp_millis())
                        && bson::deserialize_from_bson::<JsDate>(value.clone())
                            .is_ok_and(|d| d.0 == date.timestamp_millis());
                    if ok {
                        checked.1 += 1;
                    } else {
                        failures.push(format!("{name}.{key}: date {value:?}"));
                    }
                }
            }
            let text = json::to_json_string(&document);
            let reparsed: Result<serde_json::Value, _> = serde_json::from_str(&text);
            match reparsed {
                Ok(value) if value == json::to_json_value(&document) => checked.2 += 1,
                _ => failures.push(format!(
                    "{name}: JSON does not parse back: {}",
                    text.chars().take(200).collect::<String>()
                )),
            }
        }
    }
    eprintln!(
        "ids read: {}, dates read: {}, documents rendered: {}",
        checked.0, checked.1, checked.2
    );
    failures.truncate(20);
    assert!(failures.is_empty(), "{failures:#?}");
    assert!(checked.0 > 1_000_000, "only {} ids", checked.0);
    Ok(())
}

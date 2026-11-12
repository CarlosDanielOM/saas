//! Every registered collection decoded from the local `domdimabot` copy (a stale production
//! copy, read only) with its read type: every document of a collection under 50,000 documents,
//! an even spread of 50,000 above that (every n-th document in `_id` order), or every document
//! with `DIMA_MODEL_FULL_SCAN=1`. Documents are read without a projection, so the `select: false`
//! paths are decoded too. A failure names the collection, the `_id` and the field.
//!
//! Skipped with a message when `DIMA_TEST_MONGO_URI` is not set or the copy is absent.

mod support;

use anyhow::{Result, bail};
use bson::{Bson, Document, RawDocumentBuf, doc};
use dima_model::REGISTRY;
use futures_util::TryStreamExt;

const SAMPLE: u64 = 50_000;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_real_document_decodes() -> Result<()> {
    let Some(store) = support::real_store().await? else {
        return Ok(());
    };
    let full = std::env::var("DIMA_MODEL_FULL_SCAN").is_ok_and(|v| v == "1");
    let mut failures = Vec::new();
    let mut total = 0_u64;
    for info in REGISTRY {
        let collection = store.database().collection::<RawDocumentBuf>(info.name);
        let count = collection.count_documents(doc! {}).await?;
        let stride = if full || count <= SAMPLE {
            1
        } else {
            count.div_ceil(SAMPLE)
        };
        let mut cursor = collection.find(doc! {}).sort(doc! { "_id": 1 }).await?;
        let (mut seen, mut decoded, mut failed) = (0_u64, 0_u64, 0_u64);
        while let Some(raw) = cursor.try_next().await? {
            seen += 1;
            if (seen - 1) % stride != 0 {
                continue;
            }
            decoded += 1;
            if let Err(error) = (info.decode)(&raw) {
                failed += 1;
                let id = raw
                    .get("_id")
                    .ok()
                    .flatten()
                    .map_or_else(|| "<no _id>".to_owned(), |id| format!("{id:?}"));
                if failures.len() < 50 {
                    failures.push(format!("{} {id}: {error}", info.name));
                }
            }
        }
        total += decoded;
        eprintln!(
            "{:<28} {decoded:>7} of {count:>7} decoded{}, {failed} failed",
            info.name,
            if stride > 1 {
                format!(" (1 in {stride})")
            } else {
                String::new()
            }
        );
    }
    eprintln!("{total} documents decoded");
    if !failures.is_empty() {
        bail!(
            "{} documents failed to decode:\n{}",
            failures.len(),
            failures.join("\n")
        );
    }
    Ok(())
}

/// The specification the server stores for a declared index (`listIndexes` without `v`).
fn declared_spec(spec: &dima_model::IndexSpec) -> Document {
    let mut out = doc! { "key": spec.key_document(), "name": spec.name(), "background": true };
    if spec.unique {
        out.insert("unique", true);
    }
    if spec.sparse {
        out.insert("sparse", true);
    }
    if let Some(seconds) = spec.expire_after_seconds {
        out.insert(
            "expireAfterSeconds",
            Bson::Int64(i64::try_from(seconds).unwrap_or(i64::MAX)),
        );
    }
    if let Some(filter) = spec.partial_filter {
        out.insert("partialFilterExpression", filter());
    }
    out
}

/// Same specification whatever the key order and number width.
fn same_spec(a: &Document, b: &Document) -> bool {
    let number = dima_store::mongo::number::read_number;
    a.len() == b.len()
        && a.iter().all(|(key, x)| {
            b.get(key).is_some_and(|y| match (x, y) {
                (Bson::Document(x), Bson::Document(y)) => same_spec(x, y),
                _ => match (number(x), number(y)) {
                    (Some(x), Some(y)) => x == y,
                    _ => x == y,
                },
            })
        })
}

/// The production copy's indexes against the declarations: every declared index exists with the
/// declared options, and no other index exists (besides `_id_`). Read only.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_indexes_match_declarations() -> Result<()> {
    let Some(store) = support::real_store().await? else {
        return Ok(());
    };
    let mut problems = Vec::new();
    for info in REGISTRY {
        let reply = store
            .database()
            .run_command(doc! { "listIndexes": info.name })
            .await;
        let listed: Vec<Document> = match reply {
            Ok(reply) => reply
                .get_document("cursor")
                .and_then(|c| c.get_array("firstBatch"))
                .map(|batch| {
                    batch
                        .iter()
                        .filter_map(|b| b.as_document().cloned())
                        .map(|mut d| {
                            d.remove("v");
                            d
                        })
                        .filter(|d| d.get_str("name").ok() != Some("_id_"))
                        .collect()
                })
                .unwrap_or_default(),
            // A collection the copy does not have (none today) has no indexes to compare.
            Err(_) => Vec::new(),
        };
        let declared: Vec<Document> = info.indexes.iter().map(declared_spec).collect();
        for spec in &declared {
            match listed
                .iter()
                .find(|l| l.get_str("name").ok() == spec.get_str("name").ok())
            {
                None => problems.push(format!(
                    "{}: {} is declared but missing",
                    info.name,
                    spec.get_str("name").unwrap_or("?")
                )),
                Some(found) if !same_spec(found, spec) => {
                    problems.push(format!(
                        "{}: {found} differs from the declaration {spec}",
                        info.name
                    ));
                }
                Some(_) => {}
            }
        }
        for found in &listed {
            if !declared
                .iter()
                .any(|d| d.get_str("name").ok() == found.get_str("name").ok())
            {
                problems.push(format!("{}: {found} exists but is not declared", info.name));
            }
        }
    }
    if !problems.is_empty() {
        bail!("{}", problems.join("\n"));
    }
    eprintln!(
        "the production copy's indexes match the declarations of {} collections",
        REGISTRY.len()
    );
    Ok(())
}

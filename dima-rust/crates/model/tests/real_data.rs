//! Every registered collection decoded from the local `domdimabot` copy (a stale production
//! copy, read only) with its read type. With `DIMA_TEST_REQUIRE_STORES=1` (the gate) or
//! `DIMA_MODEL_FULL_SCAN=1`, every document of every collection; otherwise every document of a
//! collection under 50,000 documents and an even spread of 50,000 above that (every n-th
//! document in `_id` order). Documents are read without a projection, so the `select: false`
//! paths are decoded too. A failure names the collection, the `_id` and the field.
//!
//! Without the copy the tests skip with a notice; with `DIMA_TEST_REQUIRE_STORES=1` a missing
//! server, copy or registered collection fails them.

mod support;

use anyhow::{Result, bail};
use bson::{RawDocumentBuf, doc};
use dima_model::REGISTRY;
use futures_util::TryStreamExt;

const SAMPLE: u64 = 50_000;

/// Every registered collection exists in the copy (an empty one included).
async fn expected_collections(store: &dima_store::mongo::MongoStore) -> Result<()> {
    let names = store.database().list_collection_names().await?;
    let absent: Vec<&str> = REGISTRY
        .iter()
        .map(|info| info.name)
        .filter(|name| !names.iter().any(|n| n == name))
        .collect();
    if !absent.is_empty() {
        let message = format!("collections missing from the copy: {}", absent.join(", "));
        if support::stores_required() {
            bail!("{message} (DIMA_TEST_REQUIRE_STORES=1)");
        }
        eprintln!("{message}");
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_real_document_decodes() -> Result<()> {
    let Some(store) = support::real_store().await? else {
        return Ok(());
    };
    expected_collections(&store).await?;
    let full =
        support::stores_required() || std::env::var("DIMA_MODEL_FULL_SCAN").is_ok_and(|v| v == "1");
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
        let mut decoding = std::time::Duration::ZERO;
        while let Some(raw) = cursor.try_next().await? {
            seen += 1;
            if (seen - 1) % stride != 0 {
                continue;
            }
            decoded += 1;
            let started = std::time::Instant::now();
            let outcome = (info.decode)(&raw);
            decoding += started.elapsed();
            if let Err(error) = outcome {
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
            "{:<28} {decoded:>7} of {count:>7} decoded{}, {failed} failed, {:.2} µs per document (debug build)",
            info.name,
            if stride > 1 {
                format!(" (1 in {stride})")
            } else {
                String::new()
            },
            decoding.as_secs_f64() * 1e6 / decoded.max(1) as f64
        );
    }
    eprintln!(
        "{total} documents decoded{}",
        if full {
            " (every document)"
        } else {
            " (sampled)"
        }
    );
    if !failures.is_empty() {
        bail!(
            "{} documents failed to decode:\n{}",
            failures.len(),
            failures.join("\n")
        );
    }
    Ok(())
}

/// The production copy's indexes against the declarations, read only: every declared index
/// exists with the declared options, and no other index exists (besides `_id_`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_indexes_match_declarations() -> Result<()> {
    let Some(store) = support::real_store().await? else {
        return Ok(());
    };
    expected_collections(&store).await?;
    let differences =
        dima_model::preflight_indexes(&store, REGISTRY, std::time::Duration::from_secs(60)).await?;
    // A collection the copy does not have (none today) has no indexes to compare.
    let real: Vec<String> = differences
        .iter()
        .filter(|d| {
            !matches!(
                d,
                dima_model::index::IndexDifference::MissingCollection { .. }
            )
        })
        .map(ToString::to_string)
        .collect();
    if !real.is_empty() {
        bail!("{}", real.join("\n"));
    }
    eprintln!(
        "the production copy's indexes match the declarations of {} collections",
        REGISTRY.len()
    );
    Ok(())
}

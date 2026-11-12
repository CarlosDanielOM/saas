//! Every registered collection decoded from the local `domdimabot` copy (a stale production
//! copy, read only) with its read type. With `DIMA_TEST_REQUIRE_STORES=1` (the gate) or
//! `DIMA_MODEL_FULL_SCAN=1`, every document of every collection; otherwise every document of a
//! collection under 50,000 documents and an even spread of 50,000 above that (every n-th
//! document in `_id` order). Documents are read without a projection, so the `select: false`
//! paths are decoded too. A failure names the collection, the `_id` and the field.
//!
//! Without the copy the tests skip with a notice; with `DIMA_TEST_REQUIRE_STORES=1` a missing
//! server, copy or registered collection fails them, and so does an empty collection that the
//! census (`ledger/mongo.json`) shows with documents: the copy has expiring collections, so the
//! counts are not compared, but one emptied by accident would otherwise pass with nothing
//! decoded.

mod support;

use anyhow::{Result, bail};
use bson::{RawDocumentBuf, doc};
use dima_model::REGISTRY;
use futures_util::TryStreamExt;

const SAMPLE: u64 = 50_000;

/// The document count of each collection in the census of the production copy
/// (`ledger/mongo.json`, `collections.<name>.db.count`).
fn census_counts() -> Result<std::collections::HashMap<String, u64>> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../ledger/mongo.json");
    let ledger: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    let collections = ledger
        .get("collections")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| anyhow::anyhow!("{path}: no collections"))?;
    Ok(collections
        .iter()
        .filter_map(|(name, entry)| {
            let count = entry.pointer("/db/count")?.as_u64()?;
            Some((name.clone(), count))
        })
        .collect())
}

/// Every registered collection that start-up initialises exists in the copy (an empty one
/// included). The others (`initialised_at_startup: false`, schemas no process imports) may or
/// may not: `channelconfigs` never existed, `accounts` and `app_configs` are left from older code.
async fn expected_collections(store: &dima_store::mongo::MongoStore) -> Result<()> {
    let names = store.database().list_collection_names().await?;
    let absent: Vec<&str> = REGISTRY
        .iter()
        .filter(|info| info.initialised_at_startup)
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

/// Index differences the production copy is known to have: (collection, index name, why). Each
/// is listed in the package report; the cutover rehearsal's preflight shows them too.
const KNOWN_DIFFERENCES: &[(&str, &str, &str)] = &[(
    "extensionwallettransactions",
    "twitchTransactionID_1",
    "production has a plain index where the schema declares a unique partial one \
     (IndexOptionsConflict: Mongoose never built it; ledger mongo.md \"Option conflict\")",
)];

fn is_known(difference: &dima_model::index::IndexDifference, known: &(&str, &str, &str)) -> bool {
    match difference {
        dima_model::index::IndexDifference::Differs {
            collection, stored, ..
        } => *collection == known.0 && stored.get_str("name").ok() == Some(known.1),
        _ => false,
    }
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
    let mut emptied = Vec::new();
    let census = census_counts()?;
    let mut total = 0_u64;
    for info in REGISTRY {
        let scan_started = std::time::Instant::now();
        let collection = store.database().collection::<RawDocumentBuf>(info.name);
        let count = collection.count_documents(doc! {}).await?;
        let counted = census.get(info.name).copied().unwrap_or(0);
        if count == 0 && counted > 0 {
            emptied.push(format!("{} (the census counted {counted})", info.name));
        }
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
            "{:<28} {decoded:>7} of {count:>7} decoded{}, {failed} failed, {:.2} µs per document (debug build), {:.3}s scan",
            info.name,
            if stride > 1 {
                format!(" (1 in {stride})")
            } else {
                String::new()
            },
            decoding.as_secs_f64() * 1e6 / decoded.max(1) as f64,
            scan_started.elapsed().as_secs_f64()
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
    if !emptied.is_empty() {
        let message = format!(
            "collections the census shows with documents are empty in the copy: {}",
            emptied.join(", ")
        );
        if support::stores_required() {
            bail!("{message} (DIMA_TEST_REQUIRE_STORES=1)");
        }
        eprintln!("{message}");
    }
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
    let preflight =
        dima_model::preflight_indexes(&store, REGISTRY, std::time::Duration::from_secs(60)).await?;
    // The collections start-up does not initialise are reported apart, and the differences
    // production is known to have are reported, not failed.
    for skipped in &preflight.not_initialised {
        eprintln!("{skipped}");
    }
    let mut known = Vec::new();
    let real: Vec<String> = preflight
        .differences
        .iter()
        .filter(
            |d| match KNOWN_DIFFERENCES.iter().find(|k| is_known(d, k)) {
                Some((collection, index, why)) => {
                    known.push(format!("{collection}.{index}: {why}"));
                    false
                }
                None => true,
            },
        )
        .map(ToString::to_string)
        .collect();
    for line in &known {
        eprintln!("known difference: {line}");
    }
    if !real.is_empty() {
        bail!("{}", real.join("\n"));
    }
    eprintln!(
        "the production copy's indexes match the declarations of {} collections",
        REGISTRY.len()
    );
    Ok(())
}

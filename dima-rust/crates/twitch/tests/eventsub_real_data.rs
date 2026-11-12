//! The stored subscriptions of the production copy (`domdimabot`, read only): every document
//! decodes with the model's read type, and for every type of the table the stored condition is
//! the one the condition logic expects for the document's channel. Prints the counts per type
//! (`--nocapture`) and the ids of anything the logic would call wrong.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
mod support;

use anyhow::Result;
use bson::Document;
use dima_twitch::eventsub::condition::Condition;
use dima_twitch::eventsub::{SUBSCRIPTION_TYPES, is_legacy_bits_event_type};
use std::collections::BTreeMap;

#[derive(Default, Debug)]
struct Counts {
    documents: u64,
    expected: u64,
    stale_version: u64,
    unmanaged: u64,
}

#[tokio::test]
async fn production_copy_conditions_agree_with_the_table() -> Result<()> {
    let Some(mongo) = support::connect_mongo("domdimabot").await? else {
        return Ok(());
    };
    let mut cursor = mongo.documents("eventsubs").find(bson::doc! {}).await?;
    let mut counts: BTreeMap<String, Counts> = BTreeMap::new();
    let mut wrong: Vec<String> = Vec::new();
    let mut keys: BTreeMap<String, u64> = BTreeMap::new();
    let mut total = 0_u64;
    while cursor.advance().await? {
        let document: Document = cursor.deserialize_current()?;
        let raw = bson::RawDocumentBuf::try_from(&document)?;
        let _: dima_model::eventsubs::Eventsub = dima_model::decode(&raw)?;
        total += 1;
        let kind = document.get_str("type").unwrap_or_default().to_owned();
        let version = document.get_str("version").unwrap_or_default();
        let channel = document.get_str("channelID").unwrap_or_default();
        let id = document.get_str("id").unwrap_or_default().to_owned();
        let condition = document
            .get("condition")
            .map(|c| Condition::from_value(&c.clone().into_relaxed_extjson()))
            .unwrap_or_default();
        let entry = counts.entry(kind.clone()).or_default();
        entry.documents += 1;
        let same_type: Vec<_> = SUBSCRIPTION_TYPES
            .iter()
            .filter(|t| t.kind == kind)
            .collect();
        if same_type.is_empty() || is_legacy_bits_event_type(&kind) {
            entry.unmanaged += 1;
            continue;
        }
        let candidates: Vec<_> = same_type.iter().filter(|t| t.version == version).collect();
        if candidates.is_empty() {
            entry.stale_version += 1;
            continue;
        }
        if candidates
            .iter()
            .any(|t| t.condition_for(channel).identity() == condition.identity())
        {
            entry.expected += 1;
            *keys
                .entry(format!(
                    "{channel}|{kind}|{version}|{}",
                    condition.identity()
                ))
                .or_default() += 1;
        } else {
            wrong.push(id);
        }
    }
    if support::stores_required() {
        assert!(total > 0, "the production copy holds no eventsubs");
    }
    for (kind, count) in &counts {
        println!(
            "{kind}: {} documents, {} expected, {} stale version, {} not in the table",
            count.documents, count.expected, count.stale_version, count.unmanaged
        );
    }
    let duplicates: u64 = keys.values().filter(|n| **n > 1).map(|n| n - 1).sum();
    println!(
        "{total} documents; {} wrong condition; {duplicates} duplicate local documents",
        wrong.len()
    );
    assert!(
        wrong.is_empty(),
        "conditions the logic calls wrong: {wrong:?}"
    );
    Ok(())
}

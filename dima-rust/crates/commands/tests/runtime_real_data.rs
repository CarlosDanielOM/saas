//! The command lookup over the real stored commands of the local production copy
//! (`domdimabot`, read only), against what `Commands.getCommandFromDB` found there
//! (`tests/runtime/real_data.json`, recorded by `tests/runtime/record_real.mts`): every channel
//! with a command, every stored name with its upper case, `!` + name and name + `x`, and two
//! names nothing has. The fixture holds hashes, never names or channel ids. Only Dragonfly
//! (database 11, a unique prefix, removed afterwards) is written.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod runtime_support;

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use anyhow::{Result, bail};
use bson::{Bson, doc};
use dima_commands::runtime::lookup::{CommandCache, CommandCacheConfig, Source};
use dima_commands::runtime::{KeyPrefix, Stores};
use dima_core::{ManualClock, SystemRandom};
use futures_util::TryStreamExt;
use runtime_support::*;
use serde_json::Value;
use sha2::{Digest, Sha256};

const DATABASE: &str = "domdimabot";

fn short(channel: &str, name: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(channel.as_bytes());
    hasher.update([0]);
    hasher.update(name.as_bytes());
    hex::encode(hasher.finalize())[..16].to_owned()
}

#[tokio::test]
async fn real_commands_are_found_as_the_reference_finds_them() -> Result<()> {
    let Some(mongo) = connect_mongo(DATABASE).await? else {
        return Ok(());
    };
    let names = mongo.client().list_database_names().await?;
    if !names.iter().any(|name| name == DATABASE) {
        if stores_required() {
            bail!("the local domdimabot copy is not present (DIMA_TEST_REQUIRE_STORES=1)");
        }
        return Ok(());
    }
    let Some(dragonfly) = connect_dragonfly().await? else {
        return Ok(());
    };
    let fixture: Value = serde_json::from_str(include_str!("runtime/real_data.json"))?;
    let commands = mongo.documents("commands");
    let documents = commands.count_documents(doc! {}).await?;
    let last = commands
        .find_one(doc! {})
        .sort(doc! { "_id": -1 })
        .await?
        .and_then(|d| d.get_object_id("_id").ok().map(|id| id.to_hex()))
        .unwrap_or_default();
    assert_eq!(
        (documents, last.as_str()),
        (
            fixture["census"]["documents"].as_u64().unwrap(),
            fixture["census"]["lastId"].as_str().unwrap()
        ),
        "the local copy changed since the recording: run record_real.mts again"
    );
    let expected: HashMap<&str, &Value> = fixture["lookups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pair| (pair[0].as_str().unwrap(), &pair[1]))
        .collect();

    let prefix = format!("dcmreal{}:", random_suffix());
    let stores = Stores {
        mongo: mongo.clone(),
        dragonfly: dragonfly.clone(),
        keys: KeyPrefix::new(prefix.clone()),
    };
    let cache = CommandCache::new(
        stores,
        Arc::new(ManualClock::new(reference()["now"].as_i64().unwrap())),
        Arc::new(SystemRandom),
        CommandCacheConfig::default(),
    );
    let outcome = async {
        let mut channels: Vec<String> = commands
            .distinct("channelID", doc! { "activation": { "$ne": "keyword" } })
            .await?
            .into_iter()
            .filter_map(|value| match value {
                Bson::String(text) => Some(text),
                _ => None,
            })
            .collect();
        channels.sort();
        assert_eq!(channels.len() as u64, fixture["channels"].as_u64().unwrap());
        let mut compared = 0;
        let mut found = 0;
        for channel in &channels {
            let mut names = BTreeSet::new();
            let mut cursor = commands
                .find(doc! { "channelID": channel })
                .projection(doc! { "cmd": 1 })
                .await?;
            while let Some(document) = cursor.try_next().await? {
                let stored: Vec<String> = match document.get("cmd") {
                    Some(Bson::String(cmd)) => vec![cmd.clone()],
                    Some(Bson::Array(items)) => items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_owned))
                        .collect(),
                    _ => Vec::new(),
                };
                for cmd in stored {
                    names.insert(dima_text::to_upper(&cmd));
                    names.insert(format!("!{cmd}"));
                    names.insert(format!("{cmd}x"));
                    names.insert(cmd);
                }
            }
            names.insert("zz-no-such-command".to_owned());
            names.insert(String::new());
            for name in names {
                let hash = short(channel, &name);
                let Some(&want) = expected.get(hash.as_str()) else {
                    bail!("a lookup the recording does not have ({hash})");
                };
                let lookup = cache.find(channel, &name).await?;
                assert!(lookup.cache_error.is_none());
                let got = lookup
                    .command
                    .as_ref()
                    .map_or(Value::Null, |command| Value::String(command.id.to_hex()));
                assert_eq!(&got, want, "lookup {hash}");
                if lookup.source == Source::Cache && got.is_string() {
                    found += 1;
                }
                compared += 1;
            }
        }
        assert_eq!(compared, expected.len(), "every recorded lookup was made");
        assert!(found > 0);
        Ok::<_, anyhow::Error>(())
    }
    .await;
    clean_prefix(&dragonfly, &prefix).await?;
    outcome
}

//! The two runtime additions of P4-CHAT-MESSAGE against the local stores: a command's counter
//! incremented by id under the cache's write protocol (`CommandCache::increment_count`), and the
//! keyword cache's store (`runtime::keyword_store::StoreKeywordStorage`) under the shared index,
//! the body cache, the revision fence and the counter.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod runtime_support;

use std::sync::Arc;

use anyhow::Result;
use bson::{Bson, Document, doc, oid::ObjectId};
use dima_commands::keywords::{
    KeywordIndexCache, KeywordMatchMode, KeywordStorage, SharedKeywordLoader, get_keyword_body,
    keyword_body_key, keyword_index_key, keyword_revision_key, load_shared_index,
    refresh_keyword_index, save_keyword_count,
};
use dima_commands::runtime::keyword_store::{KeywordBody, KeywordStoreConfig, StoreKeywordStorage};
use dima_commands::runtime::lookup::Source;
use dima_core::SystemRandom;
use dima_store::dragonfly::Ttl;
use runtime_support::*;

const CHANNEL: &str = "990000077";
const NOW: i64 = 1_893_490_200_123;

fn command(cmd: &str, count: Bson) -> Document {
    doc! {
        "_id": ObjectId::new(), "channelID": CHANNEL, "channel": "streamer", "name": cmd, "cmd": cmd,
        "func": "custom", "message": "hola", "type": "command", "platform": "twitch",
        "reserved": false, "cooldown": 0, "count": count, "userLevel": 0, "enabled": true, "__v": 0,
    }
}

fn keyword(cmd: &str, mode: Option<Bson>, enabled: bool) -> Document {
    let mut document = command(cmd, Bson::Int32(3));
    document.insert("activation", "keyword");
    document.insert("enabled", enabled);
    document.insert("blocks", doc! { "hidden": true });
    if let Some(mode) = mode {
        document.insert("keywordSettings", doc! { "matchMode": mode });
    }
    document
}

async fn count_of(env: &Env, id: ObjectId) -> Result<Option<Bson>> {
    Ok(env
        .stores
        .mongo
        .documents("commands")
        .find_one(doc! { "_id": id })
        .await?
        .and_then(|document| document.get("count").cloned()))
}

#[tokio::test]
async fn a_count_is_incremented_by_id_and_the_name_marked_stale() -> Result<()> {
    with_env(NOW, |env| async move {
        let hola = command("hola", Bson::Int32(5));
        let id = hola.get_object_id("_id")?;
        env.stores
            .mongo
            .documents("commands")
            .insert_one(hola)
            .await?;
        let cache = env.cache();
        assert_eq!(cache.find(CHANNEL, "hola").await?.source, Source::Database);
        assert_eq!(cache.find(CHANNEL, "hola").await?.source, Source::Cache);

        assert!(
            cache
                .increment_count(CHANNEL, &["hola", "hola"], id, 1.0)
                .await
                .map_err(|e| e.into_runtime())?
        );
        assert_eq!(
            count_of(&env, id).await?,
            Some(Bson::Int32(6)),
            "an int32 total stays int32"
        );
        // The name was marked stale: the next lookup reads MongoDB and sees the new count.
        let found = cache.find(CHANNEL, "hola").await?;
        assert_eq!(found.source, Source::Database);
        assert_eq!(found.command.map(|c| c.count.0), Some(6.0));

        // Two increments at once both land (the reference's `$set` of each run's total loses one).
        let (a, b) = tokio::join!(
            cache.increment_count(CHANNEL, &["hola"], id, 1.0),
            cache.increment_count(CHANNEL, &["hola"], id, 1.0),
        );
        assert!(a.map_err(|e| e.into_runtime())? && b.map_err(|e| e.into_runtime())?);
        assert_eq!(count_of(&env, id).await?, Some(Bson::Int32(8)));

        // A fractional change is a double, as `$inc` stores it.
        cache
            .increment_count(CHANNEL, &["hola"], id, 0.5)
            .await
            .map_err(|e| e.into_runtime())?;
        assert_eq!(count_of(&env, id).await?, Some(Bson::Double(8.5)));

        // No change writes nothing and answers whether the command exists.
        assert!(
            cache
                .increment_count(CHANNEL, &["hola"], id, 0.0)
                .await
                .map_err(|e| e.into_runtime())?
        );
        assert!(
            !cache
                .increment_count(CHANNEL, &["hola"], ObjectId::new(), 0.0)
                .await
                .map_err(|e| e.into_runtime())?
        );
        // Another channel's id, or an unknown one, matches nothing.
        assert!(
            !cache
                .increment_count("990000078", &["hola"], id, 1.0)
                .await
                .map_err(|e| e.into_runtime())?
        );
        assert!(
            !cache
                .increment_count(CHANNEL, &["hola"], ObjectId::new(), 1.0)
                .await
                .map_err(|e| e.into_runtime())?
        );
        assert_eq!(count_of(&env, id).await?, Some(Bson::Double(8.5)));
        Ok(())
    })
    .await
}

fn storage(env: &Env) -> StoreKeywordStorage {
    StoreKeywordStorage::new(
        env.stores.clone(),
        env.clock(),
        Arc::new(SystemRandom),
        KeywordStoreConfig::default(),
    )
}

#[tokio::test]
async fn the_keyword_store_loads_publishes_and_fences() -> Result<()> {
    with_env(NOW, |env| async move {
        let saludo = keyword("  Buenos   DÍAS ", Some(Bson::String("anywhere".into())), true);
        let saludo_id = saludo.get_object_id("_id")?;
        let plain = keyword("hola", None, true);
        let numeric_mode = keyword("adios", Some(Bson::Int32(4)), true);
        let off = keyword("apagado", Some(Bson::String("exact".into())), false);
        let documents = env.stores.mongo.documents("commands");
        for document in [saludo, plain, numeric_mode, off, command("comando", Bson::Int32(0))] {
            documents.insert_one(document).await?;
        }
        let store = storage(&env);

        let entries = load_shared_index(&store, CHANNEL).await?;
        let summary: Vec<(String, KeywordMatchMode)> =
            entries.iter().map(|entry| (entry.text.clone(), entry.match_mode)).collect();
        assert_eq!(
            summary,
            vec![
                ("buenos días".to_owned(), KeywordMatchMode::Anywhere),
                ("hola".to_owned(), KeywordMatchMode::Start),
                ("adios".to_owned(), KeywordMatchMode::Anywhere),
            ],
            "enabled keyword commands only, natural order, normalised, the reference's modes"
        );
        let index = env.key(&keyword_index_key(CHANNEL));
        assert!(matches!(env.stores.dragonfly.ttl(&index).await?, Ttl::Seconds(s) if s > 86_000));
        // The shared copy answers next time, even after MongoDB changed.
        documents.delete_many(doc! { "cmd": "hola" }).await?;
        assert_eq!(load_shared_index(&store, CHANNEL).await?.len(), 3);

        // The body: the stored document without the hidden paths, cached for 30 s.
        let body: KeywordBody = get_keyword_body(&store, CHANNEL, &saludo_id.to_hex()).await?.expect("body");
        let command = body.command()?;
        assert_eq!(command.id, saludo_id);
        assert_eq!(command.cmd.as_deref(), Some("  Buenos   DÍAS "));
        assert!(command.blocks.is_none(), "select: false paths are not loaded");
        let body_key = env.key(&keyword_body_key(CHANNEL, &saludo_id.to_hex()));
        assert!(matches!(env.stores.dragonfly.ttl(&body_key).await?, Ttl::Seconds(s) if s <= 30 && s > 0));
        let again = get_keyword_body(&store, CHANNEL, &saludo_id.to_hex()).await?.expect("cached");
        assert_eq!(again, body);
        assert!(get_keyword_body(&store, CHANNEL, &ObjectId::new().to_hex()).await?.is_none());
        assert!(get_keyword_body(&store, CHANNEL, "not-an-id").await.is_err());

        // A load that raced an edit is not published: the revision moved since it was read.
        let revision = env.key(&keyword_revision_key(CHANNEL));
        assert!(!store
            .set_if_revision(
                dima_commands::keywords::BODY_SCRIPT,
                &keyword_body_key(CHANNEL, "x"),
                &keyword_revision_key(CHANNEL),
                "7",
                "\"\"",
            )
            .await?);

        // The counter: `$set` on the keyword, then its body is dropped.
        save_keyword_count(&store, CHANNEL, &saludo_id.to_hex(), 11.0).await?;
        assert_eq!(count_of(&env, saludo_id).await?, Some(Bson::Int32(11)));
        assert_eq!(env.stores.dragonfly.exists(&[body_key.as_str()]).await?, 0);

        // A settings change: the revision moves, the shared index goes, the process reloads.
        let cache = KeywordIndexCache::new(SharedKeywordLoader { storage: Arc::new(store.clone()) }, env.clock());
        assert!(cache.get(CHANNEL).await.is_ok());
        documents.insert_one(keyword("nuevo", None, true)).await?;
        refresh_keyword_index(&cache, CHANNEL, Some(&saludo_id.to_hex())).await.map_err(|e| anyhow::anyhow!("{e}"))?;
        assert_eq!(env.stores.dragonfly.get(&revision).await?, Some(b"1".to_vec()));
        let reloaded = load_shared_index(&store, CHANNEL).await?;
        assert_eq!(
            reloaded.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(),
            ["buenos días", "adios", "nuevo"]
        );
        // A text `cmd` is required, as `normalizeKeyword` throws on anything else.
        documents.insert_one(keyword("x", None, true)).await?;
        documents.update_one(doc! { "cmd": "x" }, doc! { "$set": { "cmd": 5 } }).await?;
        store.delete(&keyword_index_key(CHANNEL)).await?;
        assert!(load_shared_index(&store, CHANNEL).await.is_err());
        Ok(())
    })
    .await
}

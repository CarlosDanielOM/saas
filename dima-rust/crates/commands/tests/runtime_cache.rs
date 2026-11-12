//! The command cache under the conditions the reference gets wrong (module docs of
//! `runtime::lookup`): a lookup that read MongoDB before a write and publishes after it, a
//! writer killed in the middle, Dragonfly failing, several processes reading and writing at
//! once, and channels or names over the bounds.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod runtime_support;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::Result;
use bson::doc;
use dima_commands::runtime::lookup::{
    CommandCacheConfig, Names, PublishGate, Source, WriteFailure, entry_field, snapshot_key,
};
use runtime_support::*;
use tokio::sync::Notify;

const CHANNEL_A: &str = "990000001";
const OFF: &str = "64a000000000000000000003";

fn now() -> i64 {
    reference()["now"].as_i64().unwrap()
}

/// A gate that holds the first publication until released.
fn gate() -> (PublishGate, Arc<Notify>, Arc<Notify>) {
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let armed = Arc::new(AtomicBool::new(true));
    let (e, r) = (Arc::clone(&entered), Arc::clone(&release));
    let gate = PublishGate(Arc::new(move || {
        let (entered, release, armed) = (Arc::clone(&e), Arc::clone(&r), Arc::clone(&armed));
        Box::pin(async move {
            if armed.swap(false, Ordering::SeqCst) {
                entered.notify_one();
                release.notified().await;
            }
        })
    }));
    (gate, entered, release)
}

async fn set_enabled(env: &Env, id: &str, enabled: bool) -> Result<()> {
    env.stores
        .mongo
        .documents("commands")
        .update_one(
            doc! { "_id": oid(id) },
            doc! { "$set": { "enabled": enabled } },
        )
        .await?;
    Ok(())
}

/// The reference stores the old command after the write's delete and serves it for an hour
/// (`reference.json`, `read_write_race`). Here the late publication is refused, for a cold
/// channel (whole snapshot) and for one stale entry.
#[tokio::test]
async fn a_load_that_raced_a_write_is_not_published() -> Result<()> {
    with_env(now(), |env| async move {
        seed(&env).await?;
        let (publish_gate, entered, release) = gate();
        let gated = env.cache().with_publish_gate(publish_gate);
        let cache = env.cache();

        // Cold channel: the reader loads everything, then waits before publishing.
        let reader = tokio::spawn({
            let gated = gated.clone();
            async move { gated.find(CHANNEL_A, "off").await }
        });
        entered.notified().await;
        let write_env = env.clone();
        cache
            .write(CHANNEL_A, Names::These(&["off"]), || async move {
                set_enabled(&write_env, OFF, true).await
            })
            .await
            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        release.notify_one();
        let early = reader.await??;
        assert!(
            !early.command.unwrap().is_enabled(),
            "it read before the write"
        );
        assert!(early.cache_error.is_none(), "a refusal is not an error");
        let after = cache.find(CHANNEL_A, "off").await?;
        assert!(after.command.unwrap().is_enabled());
        assert_eq!(after.source, Source::Database, "nothing was published");
        assert_eq!(cache.find(CHANNEL_A, "off").await?.source, Source::Cache);

        // A stale entry of a loaded snapshot: the refill waits, another write lands.
        let (publish_gate, entered, release) = gate();
        let gated = env.cache().with_publish_gate(publish_gate);
        let write_env = env.clone();
        cache
            .write(CHANNEL_A, Names::These(&["off"]), || async move {
                set_enabled(&write_env, OFF, false).await
            })
            .await
            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let reader = tokio::spawn(async move { gated.find(CHANNEL_A, "off").await });
        entered.notified().await;
        let write_env = env.clone();
        cache
            .write(CHANNEL_A, Names::These(&["off"]), || async move {
                set_enabled(&write_env, OFF, true).await
            })
            .await
            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        release.notify_one();
        assert!(!reader.await??.command.unwrap().is_enabled());
        let after = cache.find(CHANNEL_A, "off").await?;
        assert!(after.command.unwrap().is_enabled());
        assert_eq!(after.source, Source::Database);
        Ok(())
    })
    .await
}

/// A writer killed after its MongoDB write and before it finished: readers get MongoDB's
/// answer (the entry was marked stale first), nothing is published while its lease lives, and
/// once the lease is over the cache fills again with the new document.
#[tokio::test]
async fn a_killed_writer_leaves_nothing_stale() -> Result<()> {
    with_env(now(), |env| async move {
        seed(&env).await?;
        let cache = env.cache();
        assert_eq!(cache.find(CHANNEL_A, "off").await?.source, Source::Database);
        assert_eq!(cache.find(CHANNEL_A, "off").await?.source, Source::Cache);
        let written = Arc::new(Notify::new());
        let writer = tokio::spawn({
            let cache = cache.clone();
            let env = env.clone();
            let written = Arc::clone(&written);
            async move {
                cache
                    .write(CHANNEL_A, Names::These(&["off"]), || async move {
                        set_enabled(&env, OFF, true).await?;
                        written.notify_one();
                        std::future::pending::<Result<()>>().await
                    })
                    .await
            }
        });
        written.notified().await;
        writer.abort();
        let _ = writer.await;
        for _ in 0..3 {
            let lookup = cache.find(CHANNEL_A, "off").await?;
            assert!(lookup.command.unwrap().is_enabled());
            assert_eq!(
                lookup.source,
                Source::Database,
                "the lease holds the cache back"
            );
        }
        env.clock.advance(30_001);
        assert_eq!(cache.find(CHANNEL_A, "off").await?.source, Source::Database);
        let lookup = cache.find(CHANNEL_A, "off").await?;
        assert_eq!(lookup.source, Source::Cache);
        assert!(lookup.command.unwrap().is_enabled());
        Ok(())
    })
    .await
}

/// Dragonfly answering with an error: the lookup answers from MongoDB and says why; a write
/// whose first step fails is not made.
#[tokio::test]
async fn a_failing_cache_falls_back_and_blocks_writes() -> Result<()> {
    with_env(now(), |env| async move {
        seed(&env).await?;
        let cache = env.cache();
        let key = snapshot_key(&env.stores.keys, CHANNEL_A);
        // The wrong type: every hash command on it fails.
        env.stores
            .dragonfly
            .query_value(redis::cmd("SET").arg(&key).arg("not a hash"))
            .await?;
        let lookup = cache.find(CHANNEL_A, "hola").await?;
        assert_eq!(lookup.source, Source::Database);
        assert_eq!(
            lookup.command.unwrap().id.to_hex(),
            "64a000000000000000000001"
        );
        assert!(lookup.cache_error.is_some());
        let ran = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&ran);
        let outcome = cache
            .write(CHANNEL_A, Names::These(&["hola"]), || async move {
                flag.store(true, Ordering::SeqCst);
                Ok::<(), anyhow::Error>(())
            })
            .await;
        assert!(matches!(outcome, Err(WriteFailure::Cache(_))));
        assert!(
            !ran.load(Ordering::SeqCst),
            "nothing is written without the protocol"
        );
        // Dropping the channel (always allowed) repairs it.
        env.stores.dragonfly.del(&[key.as_str()]).await?;
        cache.invalidate_channel(CHANNEL_A).await?;
        assert!(cache.find(CHANNEL_A, "hola").await?.cache_error.is_none());
        Ok(())
    })
    .await
}

/// Three processes (their own handles on the same stores) read in a loop while one rewrites a
/// command: once each write has returned, every process's next lookup sees it.
#[tokio::test]
async fn processes_never_see_a_finished_write_undone() -> Result<()> {
    with_env(now(), |env| async move {
        seed(&env).await?;
        let writer = env.cache();
        let readers: Vec<_> = (0..3).map(|_| env.cache()).collect();
        let stop = Arc::new(AtomicBool::new(false));
        let mut tasks = Vec::new();
        for reader in readers.clone() {
            let stop = Arc::clone(&stop);
            tasks.push(tokio::spawn(async move {
                let mut lookups = 0_u32;
                while !stop.load(Ordering::SeqCst) {
                    reader.find(CHANNEL_A, "hola").await?;
                    lookups += 1;
                    tokio::task::yield_now().await;
                }
                Ok::<u32, anyhow::Error>(lookups)
            }));
        }
        for round in 0..25 {
            let text = format!("round {round}");
            let mongo = env.stores.mongo.clone();
            let message = text.clone();
            writer
                .write(CHANNEL_A, Names::These(&["hola"]), || async move {
                    mongo
                        .documents("commands")
                        .update_one(
                            doc! { "_id": oid("64a000000000000000000001") },
                            doc! { "$set": { "message": message } },
                        )
                        .await
                })
                .await
                .map_err(|e| anyhow::anyhow!("{e:?}"))?;
            for reader in &readers {
                let lookup = reader.find(CHANNEL_A, "hola").await?;
                assert_eq!(lookup.command.unwrap().message, text, "round {round}");
            }
        }
        stop.store(true, Ordering::SeqCst);
        for task in tasks {
            assert!(task.await?? > 0);
        }
        Ok(())
    })
    .await
}

/// A channel over the snapshot's bounds gets a partial one: found names are kept (within the
/// entry count and size), names that do not exist query MongoDB each time, as in the reference.
#[tokio::test]
async fn large_channels_get_a_partial_snapshot() -> Result<()> {
    with_env(now(), |env| async move {
        seed(&env).await?;
        let cache = env.cache_with(CommandCacheConfig {
            max_commands: 3,
            max_partial_entries: 2,
            ..CommandCacheConfig::default()
        });
        assert_eq!(
            cache.find(CHANNEL_A, "hola").await?.source,
            Source::Database
        );
        let mode: Option<String> = env
            .stores
            .dragonfly
            .query(
                redis::cmd("HGET")
                    .arg(snapshot_key(&env.stores.keys, CHANNEL_A))
                    .arg("v"),
            )
            .await?;
        assert_eq!(mode.as_deref(), Some("p"));
        assert_eq!(cache.find(CHANNEL_A, "hola").await?.source, Source::Cache);
        assert_eq!(
            cache.find(CHANNEL_A, "Mayus").await?.source,
            Source::Database
        );
        assert_eq!(cache.find(CHANNEL_A, "Mayus").await?.source, Source::Cache);
        // Two entries held: a third found name is not kept.
        assert_eq!(cache.find(CHANNEL_A, "off").await?.source, Source::Database);
        assert_eq!(cache.find(CHANNEL_A, "off").await?.source, Source::Database);
        for _ in 0..2 {
            let missing = cache.find(CHANNEL_A, "nope").await?;
            assert!(missing.command.is_none());
            assert_eq!(missing.source, Source::Database);
        }
        Ok(())
    })
    .await
}

/// Byte bounds: an entry over the entry limit is never kept; a complete snapshot that a refill
/// would push over the byte budget is dropped, and the channel then loads as partial.
#[tokio::test]
async fn byte_bounds_hold() -> Result<()> {
    with_env(now(), |env| async move {
        seed(&env).await?;
        let cache = env.cache();
        cache.find(CHANNEL_A, "hola").await?;
        let key = snapshot_key(&env.stores.keys, CHANNEL_A);
        let bytes: String = env
            .stores
            .dragonfly
            .query(redis::cmd("HGET").arg(&key).arg("b"))
            .await?;
        let total: usize = bytes.parse()?;
        let tight = env.cache_with(CommandCacheConfig {
            max_snapshot_bytes: total + 100,
            max_entry_bytes: 64 * 1024,
            ..CommandCacheConfig::default()
        });
        let mongo = env.stores.mongo.clone();
        tight
            .write(CHANNEL_A, Names::These(&["hola"]), || async move {
                mongo
                    .documents("commands")
                    .update_one(
                        doc! { "_id": oid("64a000000000000000000001") },
                        doc! { "$set": { "message": "x".repeat(4_000) } },
                    )
                    .await
            })
            .await
            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let refill = tight.find(CHANNEL_A, "hola").await?;
        assert_eq!(refill.command.unwrap().message.len(), 4_000);
        assert_eq!(
            env.stores.dragonfly.exists(&[&key]).await?,
            0,
            "dropped, not overfilled"
        );
        assert_eq!(
            tight.find(CHANNEL_A, "hola").await?.source,
            Source::Database
        );
        let mode: Option<String> = env
            .stores
            .dragonfly
            .query(redis::cmd("HGET").arg(&key).arg("v"))
            .await?;
        assert_eq!(mode.as_deref(), Some("p"));

        // An entry larger than the entry limit stays out of a partial snapshot.
        env.stores.dragonfly.del(&[key.as_str()]).await?;
        let small = env.cache_with(CommandCacheConfig {
            max_commands: 1,
            max_entry_bytes: 1_000,
            ..CommandCacheConfig::default()
        });
        assert_eq!(
            small.find(CHANNEL_A, "hola").await?.source,
            Source::Database
        );
        assert_eq!(
            small.find(CHANNEL_A, "hola").await?.source,
            Source::Database
        );
        assert_eq!(
            small.find(CHANNEL_A, "Mayus").await?.source,
            Source::Database
        );
        assert_eq!(small.find(CHANNEL_A, "Mayus").await?.source, Source::Cache);
        Ok(())
    })
    .await
}

/// What a viewer can type: very long names skip the cache, names that do not exist in a
/// complete snapshot cost no query, pathological Unicode is a plain field lookup.
#[tokio::test]
async fn viewer_input_stays_cheap() -> Result<()> {
    with_env(now(), |env| async move {
        seed(&env).await?;
        let cache = env.cache();
        cache.find(CHANNEL_A, "hola").await?;
        let long = "a".repeat(5_000);
        let lookup = cache.find(CHANNEL_A, &long).await?;
        assert!(lookup.command.is_none());
        assert_eq!(lookup.source, Source::Database);
        let key = snapshot_key(&env.stores.keys, CHANNEL_A);
        let field_exists: i64 = env
            .stores
            .dragonfly
            .query(redis::cmd("HEXISTS").arg(&key).arg(entry_field(&long)))
            .await?;
        assert_eq!(field_exists, 0);
        let zalgo = format!("h{}", "\u{301}\u{302}\u{303}".repeat(160));
        for name in [
            zalgo.as_str(),
            "\u{202e}aloh",
            "\u{1f389}\u{200d}\u{1f525}",
            "\u{0}",
            "hola\u{0}",
        ] {
            let started = std::time::Instant::now();
            let lookup = cache.find(CHANNEL_A, name).await?;
            assert!(lookup.command.is_none());
            assert_eq!(lookup.source, Source::Cache);
            assert!(started.elapsed() < Duration::from_secs(5));
        }
        Ok(())
    })
    .await
}

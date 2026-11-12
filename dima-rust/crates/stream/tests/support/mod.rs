#![allow(dead_code)]
use anyhow::{Context, Result};
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Hooks};
use dima_store::mongo::{MongoConfig, MongoStore};
use futures_util::FutureExt;
use std::{future::Future, panic::AssertUnwindSafe, time::Duration};

pub async fn mongo(database: &str) -> Result<Option<MongoStore>> {
    let uri = match std::env::var("DIMA_TEST_MONGO_URI") {
        Ok(uri) => uri,
        Err(_) if std::env::var("DIMA_TEST_REQUIRE_STORES").as_deref() != Ok("1") => {
            eprintln!("skipped: local MongoDB not configured");
            return Ok(None);
        }
        Err(e) => return Err(e.into()),
    };
    let mut config = MongoConfig::new(uri);
    config.database = Some(database.into());
    config.server_selection_timeout = Some(Duration::from_secs(5));
    Ok(Some(MongoStore::connect(&config, None).await?))
}
pub async fn cache() -> Result<Option<Dragonfly>> {
    let address = match std::env::var("DIMA_TEST_DRAGONFLY") {
        Ok(address) => address,
        Err(_) if std::env::var("DIMA_TEST_REQUIRE_STORES").as_deref() != Ok("1") => {
            eprintln!("skipped: local Dragonfly not configured");
            return Ok(None);
        }
        Err(e) => return Err(e.into()),
    };
    let (host, port) = address.rsplit_once(':').context("cache host:port")?;
    Ok(Some(
        Dragonfly::connect(
            DragonflyConfig::from_env_values(
                Some(host),
                Some(&format!("{port}/2")),
                "stream-tests",
            ),
            Hooks::default(),
        )
        .await?,
    ))
}
pub async fn with_store<F, Fut>(test: F) -> Result<()>
where
    F: FnOnce(MongoStore) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let name = format!("dima_test_stream_{}", uuid::Uuid::new_v4().simple());
    let Some(store) = mongo(&name).await? else {
        return Ok(());
    };
    let result = AssertUnwindSafe(test(store.clone())).catch_unwind().await;
    store.database().drop().await?;
    match result {
        Ok(r) => r,
        Err(p) => std::panic::resume_unwind(p),
    }
}
pub async fn cleanup(cache: &Dragonfly, prefix: &str) -> Result<()> {
    let mut scan = cache.scan(&format!("{prefix}*"), Some(100));
    while let Some(page) = scan.next_page().await? {
        for key in page {
            cache.del(&[std::str::from_utf8(&key)?]).await?;
        }
    }
    Ok(())
}

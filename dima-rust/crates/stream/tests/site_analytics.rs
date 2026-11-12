mod support;
use anyhow::{Context, Result, ensure};
use dima_core::ManualClock;
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Hooks};
use dima_stream::site_analytics::*;
use futures_util::FutureExt;
use serde_json::{Value, json};
use std::{panic::AssertUnwindSafe, sync::Arc};
fn recording() -> Result<Value> {
    Ok(serde_json::from_str(include_str!(
        "site-analytics-reference.json"
    ))?)
}
async fn cache() -> Result<Option<Dragonfly>> {
    let address = match std::env::var("DIMA_TEST_DRAGONFLY") {
        Ok(v) => v,
        Err(e) if std::env::var("DIMA_TEST_REQUIRE_STORES").as_deref() == Ok("1") => {
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("skipped: local cache absent");
            return Ok(None);
        }
    };
    let (host, port) = address.rsplit_once(':').context("host:port")?;
    Ok(Some(
        Dragonfly::connect(
            DragonflyConfig::from_env_values(Some(host), Some(&format!("{port}/7")), "site-tests"),
            Hooks::default(),
        )
        .await?,
    ))
}
async fn state(cache: &Dragonfly, prefix: &str) -> Result<Value> {
    let mut keys = Vec::new();
    let mut scan = cache.scan(&format!("{prefix}site:analytics:*"), Some(100));
    while let Some(page) = scan.next_page().await? {
        keys.extend(page);
    }
    keys.sort();
    let mut result = Vec::new();
    for k in keys {
        let k = String::from_utf8(k)?;
        let kind: String = cache.query(redis::cmd("TYPE").arg(&k)).await?;
        let ttl: i64 = cache.query(redis::cmd("TTL").arg(&k)).await?;
        let value = if kind == "hash" {
            json!(
                cache
                    .hgetall(&k)
                    .await?
                    .into_iter()
                    .collect::<std::collections::BTreeMap<_, _>>()
            )
        } else {
            json!(cache.query::<String>(redis::cmd("GET").arg(&k)).await?)
        };
        result.push(json!({"key":k.strip_prefix(prefix).context("prefix")?,"type":kind,"value":value,"ttl":ttl}));
    }
    Ok(json!(result))
}
#[tokio::test]
async fn recorded_counters_unknown_empty_aliases_negative_and_concurrent() -> Result<()> {
    let Some(cache) = cache().await? else {
        return Ok(());
    };
    let prefix = format!("dima_test_stream_{}:", uuid::Uuid::new_v4());
    let result = AssertUnwindSafe(async {
        let site = SiteAnalytics::new(
            cache.clone(),
            Arc::new(ManualClock::new(1794355200000)),
            Config {
                key_prefix: prefix.clone(),
                ..Default::default()
            },
        );
        for case in recording()?["counters"].as_array().context("cases")? {
            let op = case["op"].as_str().context("op")?;
            let filter = case["filter"].as_str();
            let value = case["value"].as_i64().unwrap_or(1);
            let result = match op {
                "get" => site.get_site_analytics(filter).await?,
                "inc" => {
                    site.increment_site_analytics(filter.context("filter")?, value)
                        .await?;
                    Value::Null
                }
                "dec" => {
                    site.decrement_site_analytics(filter.context("filter")?, value)
                        .await?;
                    Value::Null
                }
                _ => {
                    futures_util::future::try_join_all(
                        case["operations"]
                            .as_array()
                            .context("ops")?
                            .iter()
                            .map(|op| async {
                                let filter = op["filter"].as_str().context("filter")?;
                                let value = op["value"].as_i64().context("value")?;
                                if op["op"] == "inc" {
                                    site.increment_site_analytics(filter, value).await?
                                } else {
                                    site.decrement_site_analytics(filter, value).await?
                                }
                                Ok::<_, anyhow::Error>(())
                            }),
                    )
                    .await?;
                    Value::Null
                }
            };
            ensure!(result == case["result"], "return {case}");
            ensure!(
                state(&cache, &prefix).await? == case["state"],
                "cache {case}"
            );
        }
        Ok(())
    })
    .catch_unwind()
    .await;
    support::cleanup(&cache, &prefix).await?;
    ensure!(state(&cache, &prefix).await? == json!([]));
    match result {
        Ok(r) => r,
        Err(p) => std::panic::resume_unwind(p),
    }
}

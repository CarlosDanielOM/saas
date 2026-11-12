#![forbid(unsafe_code)]
use dima_core::{Shutdown, SystemClock};
use std::{collections::HashMap, sync::Arc, time::Duration};
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> anyhow::Result<()> {
    let env: HashMap<_, _> = std::env::vars().collect();
    let value = |k: &str, default: &str| {
        env.get(k)
            .filter(|v| !v.is_empty())
            .cloned()
            .unwrap_or_else(|| default.to_owned())
    };
    let port = dima_text::parse_number(&value("PORT", "3210"));
    if !port.is_finite() || port.fract() != 0. || !(0. ..=65535.).contains(&port) {
        anyhow::bail!("Invalid PORT");
    }
    if std::env::args().nth(1).as_deref() == Some("--healthcheck") {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        tokio::time::timeout(Duration::from_secs(4), async {
            let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port as u16)).await?;
            stream
                .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                .await?;
            let mut buf = [0; 64];
            let n = stream.read(&mut buf).await?;
            if !buf[..n].starts_with(b"HTTP/1.1 200 ") {
                anyhow::bail!("analytics unhealthy");
            }
            Ok::<_, anyhow::Error>(())
        })
        .await??;
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--migrate-only") {
        let store = dima_analytics::store::Store::connect(&value("DATABASE_URL", "")).await?;
        use dima_core::Clock;
        let result = store.migrate(SystemClock.now_ms()).await;
        store.close().await?;
        result?;
        return Ok(());
    }
    let config = dima_analytics::Config {
        key_prefix: String::new(),
        database_url: value("DATABASE_URL", ""),
        redis_url: value("REDIS_URL", "redis://dragonfly:6379"),
        owner_id: value("OWNER_TWITCH_ID", ""),
        mongo_url: env.get("MONGO_METRICS_URI").cloned(),
        qdrant_url: env.get("QDRANT_URL").cloned(),
        qdrant_key: env.get("QDRANT_API_KEY").cloned(),
        hoststats_url: match env.get("HOSTSTATS_URL") {
            None => Some("http://dima-hoststats:3211".into()),
            Some(v) if v == "off" || v.is_empty() => None,
            Some(v) => Some(v.clone()),
        },
        collectors: value("COLLECTORS_DISABLED", "") != "true",
    };
    let shutdown = Shutdown::new();
    let app = dima_analytics::build(config, Arc::new(SystemClock), shutdown.clone()).await?;
    let stop = shutdown.clone();
    let signals = tokio::spawn(async move {
        let _ = dima_core::runtime::shutdown::stop_signal().await;
        stop.trigger();
    });
    let task_app = app.clone();
    let token = shutdown.cancellation_token();
    let worker = tokio::spawn(async move {
        let mut drain = tokio::time::interval(Duration::from_secs(1));
        drain.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        drain.tick().await;

        loop {
            tokio::select! {_ = token.cancelled()=>break,_=drain.tick()=>{if task_app.state().drain().await.is_err(){let mut h=task_app.state().health.lock().await;h["ingestionErrors"]=serde_json::json!(h["ingestionErrors"].as_u64().unwrap_or(0)+1);}}}
        }
    });
    let retain_app = app.clone();
    let retain_token = shutdown.cancellation_token();
    let retention = tokio::spawn(async move {
        let mut timer = tokio::time::interval(Duration::from_secs(3600));
        timer.tick().await;
        loop {
            tokio::select! {_=retain_token.cancelled()=>break,_=timer.tick()=>{let s=retain_app.state();if s.store.retain(s.clock.now_ms()).await.is_err(){s.health.lock().await["collectorError"]=serde_json::json!(true);}}}
        }
    });
    let collect_app = app.clone();
    let collect_token = shutdown.cancellation_token();
    let collector = tokio::spawn(async move {
        if !collect_app.state().config.collectors {
            return;
        }
        let mut timer = tokio::time::interval(Duration::from_secs(30));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {_=collect_token.cancelled()=>break,_=timer.tick()=>{let failed=dima_analytics::collectors::sample(collect_app.state()).await.is_err();collect_app.state().health.lock().await["collectorError"]=serde_json::json!(failed);}}
        }
    });
    let result = dima_web::serve(
        dima_web::bind(port as u16)?,
        app.clone(),
        shutdown.cancellation_token(),
        Default::default(),
    )
    .await;
    shutdown.trigger();
    retention.abort();
    let _ = retention.await;
    collector.abort();
    let _ = collector.await;
    worker.abort();
    let _ = worker.await;
    signals.abort();
    let _ = signals.await;
    app.state().close_mongo().await;
    app.state().store.close().await?;
    result?;
    Ok(())
}

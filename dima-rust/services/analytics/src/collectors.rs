//! Bounded resource collectors. The caller owns cadence and cancellation.
use crate::{Result, service::State};
use serde_json::{Value as V, json};
use std::{collections::HashMap, time::Duration};
#[derive(Default)]
pub struct CollectorState {
    cursor: u64,
    queues: HashMap<String, (String, String, i64)>,
    samples: u64,
    rolled: i64,
}
pub fn parse_info(raw: &str) -> V {
    let mut out = json!({});
    for line in raw.lines() {
        if let Some((key, value)) = line.split_once(':') {
            out[key] = json!(value.trim());
        }
    }
    out
}
pub fn parse_openmetrics(raw: &str) -> V {
    let mut out = json!({});
    let Ok(re) = regex::Regex::new(r"^([a-z_]+)(?:\{[^}]*\})?\s+([\d.eE+-]+)$") else {
        return out;
    };
    for line in raw.lines() {
        if let Some(c) = re.captures(line.trim()) {
            let name = &c[1];
            if [
                "memory_active_bytes",
                "memory_allocated_bytes",
                "memory_resident_bytes",
                "process_resident_memory_bytes",
                "collections_total",
                "collections_vector_total",
                "rest_responses_fail_total",
            ]
            .contains(&name)
                && let Ok(n) = c[2].parse::<f64>()
                && n.is_finite()
            {
                out[name] = json!(out[name].as_f64().unwrap_or(0.) + n);
            }
        }
    }
    out
}
fn record(rows: &mut Vec<V>, service: &str, name: &str, value: f64) {
    if value.is_finite() {
        rows.push(json!({"service":service,"name":name,"value":value}));
    }
}
pub async fn sample(s: &State) -> Result<()> {
    let Ok(mut c) = s.collector.try_lock() else {
        return Ok(());
    };
    let now = s.clock.now_ms();
    let mut rows = vec![];
    let container_turn = c.samples.is_multiple_of(2);
    c.samples += 1;
    let dragonfly = async {
        let raw: String = s.redis.query(&redis::cmd("INFO")).await?;
        let info = parse_info(&raw);
        let mut rows = vec![];
        for key in [
            "used_memory",
            "used_memory_rss",
            "maxmemory",
            "evicted_keys",
            "expired_keys",
            "keyspace_hits",
            "keyspace_misses",
            "connected_clients",
            "instantaneous_ops_per_sec",
        ] {
            if let Some(v) = info[key].as_str() {
                record(&mut rows, "dragonfly", key, dima_text::parse_number(v));
            }
        }
        let batches: i64 = s
            .redis
            .query(redis::cmd("LLEN").arg(s.key("observability:v1:inbox")))
            .await?;
        let dropped: Option<String> = s
            .redis
            .query(redis::cmd("GET").arg(s.key("observability:v1:overflow")))
            .await?;
        record(&mut rows, "analytics", "buffer_batches", batches as f64);
        record(
            &mut rows,
            "analytics",
            "buffer_dropped_batches",
            dropped.map(|v| dima_text::parse_number(&v)).unwrap_or(0.),
        );
        record(&mut rows, "dragonfly", "collector_up", 1.);
        Ok::<_, crate::Error>(rows)
    }
    .await;
    match dragonfly {
        Ok(r) => rows.extend(r),
        Err(_) => record(&mut rows, "dragonfly", "collector_up", 0.),
    }
    let pg=s.rows("SELECT pg_database_size(current_database())::float8 AS database_bytes,(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database())::float8 AS connections,(SELECT sum(pg_database_size(datname)) FROM pg_database WHERE datallowconn AND has_database_privilege(datname,'CONNECT'))::float8 AS server_bytes,(SELECT sum(pg_total_relation_size(c.oid)) FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname='public' AND c.relkind='r')::float8 AS table_bytes",&[]).await;
    match pg {
        Ok(stats) => {
            if let Some(m) = stats.first().and_then(V::as_object) {
                for (k, v) in m {
                    record(&mut rows, "postgres", k, v.as_f64().unwrap_or(0.));
                }
            }
            record(&mut rows, "postgres", "collector_up", 1.);
        }
        Err(_) => record(&mut rows, "postgres", "collector_up", 0.),
    }
    if let Some(url) = &s.config.qdrant_url {
        let result = async {
            let provider = dima_http::Provider::builder("qdrant-metrics", url)
                .internal(true)
                .timeout(Duration::from_secs(3))
                .max_bytes(1024 * 1024)
                .build()
                .map_err(|_| crate::Error::Config)?;
            let mut req = s.http.get(&provider, dima_http::Path::fixed("/metrics"));
            if let Some(key) = &s.config.qdrant_key {
                req = req.header("api-key", key);
            }
            let response = req.send().await?;
            if !response.status().is_success() {
                return Err(crate::Error::Invalid("Qdrant collector unavailable"));
            }
            let text = response.text().await?;
            Ok(parse_openmetrics(&text))
        }
        .await;
        match result {
            Ok(v) => {
                if let Some(m) = v.as_object() {
                    for (k, v) in m {
                        record(&mut rows, "qdrant", k, v.as_f64().unwrap_or(0.));
                    }
                }
                record(&mut rows, "qdrant", "collector_up", 1.);
            }
            Err(_) => record(&mut rows, "qdrant", "collector_up", 0.),
        }
    }
    if let Some(url) = &s.config.hoststats_url {
        let result=async{let provider=dima_http::Provider::builder("hoststats",url).internal(true).timeout(Duration::from_secs(3)).max_bytes(512000).build().map_err(|_|crate::Error::Config)?;let response=s.http.get(&provider,dima_http::Path::fixed("/v1/snapshot")).send().await?;if !response.status().is_success(){return Err(crate::Error::Invalid("Host stats unavailable"));}let raw:V=response.json().await?;let snapshot=crate::infrastructure::sanitize(&raw)?;let _:()=s.redis.query(redis::cmd("SET").arg(s.key("observability:v1:infra:latest")).arg(dima_text::to_js_json(&json!({"receivedAt":dima_text::to_iso_string(now),"snapshot":snapshot}))).arg("EX").arg(300)).await?;Ok(crate::infrastructure::resources(&snapshot,container_turn))}.await;
        match result {
            Ok(r) => {
                rows.extend(r);
                record(&mut rows, "host", "collector_up", 1.);
            }
            Err(_) => record(&mut rows, "host", "collector_up", 0.),
        }
    }
    if let Some(lazy_mongo) = &s.mongo {
        let result = async {
            let mongo = lazy_mongo.get().await.map_err(|_| crate::Error::Config)?;
            let admin = mongo.client().database("admin");
            let (server, storage) = tokio::try_join!(
                admin
                    .run_command(bson::doc! {"serverStatus":1})
                    .into_future(),
                mongo
                    .database()
                    .run_command(bson::doc! {"dbStats":1,"scale":1})
                    .into_future()
            )
            .map_err(|_| crate::Error::Config)?;
            Ok::<_, crate::Error>((
                dima_store::mongo::json::to_json_value(&server),
                dima_store::mongo::json::to_json_value(&storage),
            ))
        };
        let result = tokio::time::timeout(Duration::from_secs(3), result).await;
        match result {
            Ok(Ok((server, storage))) => {
                for (name, v) in [
                    (
                        "resident_bytes",
                        server["mem"]["resident"].as_f64().unwrap_or(0.) * 1024. * 1024.,
                    ),
                    (
                        "cache_bytes",
                        server["wiredTiger"]["cache"]["bytes currently in the cache"]
                            .as_f64()
                            .unwrap_or(f64::NAN),
                    ),
                    (
                        "cache_limit_bytes",
                        server["wiredTiger"]["cache"]["maximum bytes configured"]
                            .as_f64()
                            .unwrap_or(f64::NAN),
                    ),
                    (
                        "connections",
                        server["connections"]["current"]
                            .as_f64()
                            .unwrap_or(f64::NAN),
                    ),
                ] {
                    record(&mut rows, "mongodb", name, v);
                }
                for key in ["dataSize", "storageSize", "indexSize"] {
                    record(
                        &mut rows,
                        "mongodb",
                        key,
                        storage[key].as_f64().unwrap_or(f64::NAN),
                    );
                }
                record(&mut rows, "mongodb", "collector_up", 1.);
            }
            _ => record(&mut rows, "mongodb", "collector_up", 0.),
        }
    }
    if let Ok(status) = tokio::fs::read_to_string("/proc/self/status").await
        && let Some(line) = status.lines().find_map(|l| l.strip_prefix("VmRSS:"))
        && let Some(kb) = line
            .split_whitespace()
            .next()
            .and_then(|v| v.parse::<f64>().ok())
    {
        record(&mut rows, "analytics", "rss_bytes", kb * 1024.);
    }
    let re = regex::Regex::new(r"^twitch:([a-zA-Z0-9_-]+):(tts|clips):queue$")
        .map_err(|_| crate::Error::Config)?;
    let mut scanned = 0;
    let mut metrics = vec![];
    for _ in 0..4 {
        let (next, keys): (u64, Vec<String>) = s
            .redis
            .query(
                redis::cmd("SCAN")
                    .arg(c.cursor)
                    .arg("MATCH")
                    .arg(s.key("twitch:*:*:queue"))
                    .arg("COUNT")
                    .arg(100),
            )
            .await?;
        c.cursor = next;
        scanned += keys.len();
        for key in keys.into_iter().take(100) {
            let Some(caps) = re.captures(key.strip_prefix(&s.config.key_prefix).unwrap_or(&key))
            else {
                continue;
            };
            let channel = caps[1].to_owned();
            let name = caps[2].to_owned();
            let count: i64 = s.redis.query(redis::cmd("ZCARD").arg(&key)).await?;
            let first: Vec<(String, f64)> = s
                .redis
                .query(
                    redis::cmd("ZRANGE")
                        .arg(&key)
                        .arg(0)
                        .arg(0)
                        .arg("WITHSCORES"),
                )
                .await?;
            if c.queues.len() < 1000 || c.queues.contains_key(&key) {
                c.queues.insert(key, (channel.clone(), name.clone(), now));
            }
            let age = first
                .first()
                .filter(|(_, score)| *score > 1e12)
                .map(|(_, score)| (now as f64 - score).max(0.))
                .unwrap_or(0.);
            for (suffix, value) in [("waiting", count as f64), ("oldest_wait_ms", age)] {
                metrics.push(metric(&format!("{name}.{suffix}"), value, &channel, now));
            }
        }
        if next == 0 {
            break;
        }
    }
    for (key, (channel, name, seen)) in c.queues.clone().into_iter().take(100) {
        if now - seen < 10000 {
            continue;
        }
        let exists: bool = s.redis.query(redis::cmd("EXISTS").arg(&key)).await?;
        if !exists {
            metrics.push(metric(&format!("{name}.waiting"), 0., &channel, now));
            c.queues.remove(&key);
        }
        if now - seen > 3600000 {
            c.queues.remove(&key);
        }
    }
    record(
        &mut rows,
        "analytics",
        "queue_keys_observed",
        scanned as f64,
    );
    for chunk in metrics.chunks(100) {
        let batch = json!({"version":1,"id":uuid::Uuid::new_v4().to_string(),"service":"queues","instance":"collector","metrics":chunk,"spans":[],"logs":[]});
        s.store.ingest(&batch, now).await?;
    }
    s.store.execute("INSERT INTO analytics_resources SELECT $1::text::timestamptz,service,name,value FROM jsonb_to_recordset($2::jsonb) AS r(service text,name text,value double precision) ON CONFLICT DO NOTHING",&[&dima_text::to_iso_string(now),&json!(rows)]).await?;
    let hour = now / 3600000;
    if s.config.hoststats_url.is_some()
        && hour != c.rolled
        && crate::infrastructure::rollups(s, now).await.is_ok()
    {
        c.rolled = hour;
    }
    Ok(())
}
fn metric(name: &str, value: f64, channel: &str, now: i64) -> V {
    let mut h = [0; 16];
    h[crate::batch::BOUNDS
        .iter()
        .position(|bound| value <= *bound)
        .unwrap_or(0)] = 1;
    json!({"at":now/10000*10000,"kind":"queue","name":name,"channel":channel,"outcome":"ok","count":1,"sum":value,"max":value,"histogram":h})
}
use std::future::IntoFuture;

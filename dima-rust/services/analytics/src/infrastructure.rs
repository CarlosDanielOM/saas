//! Allowlisted sidecar payloads and stored infrastructure trend series.
use crate::{Error, Result, service::State};
use serde_json::{Value as V, json};
use std::collections::{BTreeMap, HashMap};
type TrendBuckets = Vec<(String, String, BTreeMap<i64, (f64, u64, f64)>)>;
const HOST: &[(&str, &str)] = &[
    ("cpu_pct", "cpuPct"),
    ("iowait_pct", "iowaitPct"),
    ("load1", "load1"),
    ("mem_used_bytes", "memUsed"),
    ("mem_total_bytes", "memTotal"),
    ("swap_used_bytes", "swapUsed"),
    ("disk_used_bytes", "diskUsed"),
    ("disk_total_bytes", "diskTotal"),
    ("disk_read_bps", "diskReadBps"),
    ("disk_write_bps", "diskWriteBps"),
    ("net_rx_bps", "netRxBps"),
    ("net_tx_bps", "netTxBps"),
];
const CONTAINER: &[(&str, &str)] = &[
    ("cpu_pct", "cpuPct"),
    ("mem_bytes", "memBytes"),
    ("net_rx_bps", "netRxBps"),
    ("net_tx_bps", "netTxBps"),
    ("blk_read_bps", "blkReadBps"),
    ("blk_write_bps", "blkWriteBps"),
    ("restart_count", "restartCount"),
];
pub fn name(v: &V) -> Option<&str> {
    v.as_str().filter(|s| {
        !s.is_empty()
            && s.len() <= 128
            && s.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    })
}
fn matches(v: &V, pattern: &str) -> V {
    v.as_str()
        .filter(|s| regex::Regex::new(pattern).is_ok_and(|r| r.is_match(s)))
        .map(|s| json!(s))
        .unwrap_or(V::Null)
}
fn when(v: &V) -> V {
    v.as_str()
        .filter(|s| s.len() <= 40)
        .and_then(dima_text::parse_date)
        .and_then(dima_text::to_iso_string)
        .map(V::String)
        .unwrap_or(V::Null)
}
fn pick(v: &V, keys: &str) -> V {
    let mut out = json!({});
    for key in keys.split_whitespace() {
        out[key] = v[key]
            .as_f64()
            .filter(|n| n.is_finite())
            .map(|n| json!(n))
            .unwrap_or(V::Null);
    }
    out
}
pub fn sanitize(raw: &V) -> Result<V> {
    if raw["version"].as_f64() != Some(1.) || when(&raw["at"]).is_null() {
        return Err(Error::Invalid("Invalid host stats snapshot"));
    }
    let mut containers = vec![];
    for c in raw["containers"].as_array().into_iter().flatten().take(64) {
        let Some(name) = name(&c["name"]) else {
            continue;
        };
        let mut v = json!({"name":name,"project":matches(&c["project"],r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$"),"service":matches(&c["service"],r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$"),"image":matches(&c["image"],r"^[a-zA-Z0-9][a-zA-Z0-9_./:@+-]{0,199}$"),"state":if matches!(c["state"].as_str(),Some("created"|"running"|"paused"|"restarting"|"removing"|"exited"|"dead"|"unknown")){c["state"].clone()}else{json!("unknown")},"health":if matches!(c["health"].as_str(),Some("healthy"|"unhealthy"|"starting")){c["health"].clone()}else{V::Null},"startedAt":when(&c["startedAt"]),"finishedAt":when(&c["finishedAt"]),"oomKilled":c["oomKilled"]==true,"restartPolicy":matches(&c["restartPolicy"],r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$")});
        extend(
            &mut v,
            pick(
                c,
                "failingStreak exitCode restartCount cpuPct cpuLimit memBytes memLimit pids pidsLimit netRx netTx netRxBps netTxBps blkRead blkWrite blkReadBps blkWriteBps imageBytes writableBytes volumeBytes",
            ),
        );
        containers.push(v);
    }
    let mut host = pick(
        &raw["host"],
        "cpus uptimeSec cpuPct iowaitPct stealPct load1 load5 load15 running procs memTotal memAvailable memUsed memFree memCache memShared swapTotal swapUsed diskTotal diskFree diskUsed inodesTotal inodesUsed diskReadBps diskWriteBps netRxBps netTxBps netRx netTx",
    );
    host["pressure"] = pick(&raw["host"]["pressure"], "cpu memory io");
    let df = &raw["docker"]["df"];
    let df = if df.is_object() || df.is_array() {
        let mut v = json!({"at":when(&df["at"])});
        extend(
            &mut v,
            pick(
                df,
                "imagesCount imagesBytes imagesUnusedBytes buildCacheBytes buildCacheReclaimable volumesCount volumesBytes containersBytes",
            ),
        );
        v
    } else {
        V::Null
    };
    Ok(
        json!({"at":when(&raw["at"]),"sampleMs":raw["sampleMs"].as_f64(),"host":host,"docker":{"reachable":raw["docker"]["reachable"]==true,"version":matches(&raw["docker"]["version"],r"^[0-9][0-9a-zA-Z.+-]{0,39}$"),"df":df},"containers":containers,"errors":raw["errors"].as_array().into_iter().flatten().filter_map(V::as_str).take(5).map(|s|dima_text::truncate_chars(s,120)).collect::<Vec<_>>()}),
    )
}
fn extend(v: &mut V, other: V) {
    if let Some(m) = other.as_object() {
        for (k, x) in m {
            v[k] = x.clone();
        }
    }
}
pub fn resources(snapshot: &V, containers: bool) -> Vec<V> {
    let mut rows = vec![];
    let mut add = |service: &str, name: &str, value: V| {
        if value.as_f64().is_some_and(f64::is_finite) {
            rows.push(json!({"service":service,"name":name,"value":value}));
        }
    };
    for (name, key) in HOST {
        add("host", name, snapshot["host"][key].clone());
    }
    let cs = snapshot["containers"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    add(
        "host",
        "containers_running",
        json!(cs.iter().filter(|c| c["state"] == "running").count()),
    );
    add("host", "containers_total", json!(cs.len()));
    add(
        "host",
        "docker_up",
        json!(if snapshot["docker"]["reachable"] == true {
            1
        } else {
            0
        }),
    );
    if containers {
        for c in cs {
            let service = format!("container:{}", c["name"].as_str().unwrap_or(""));
            add(
                &service,
                "running",
                json!(if c["state"] == "running" { 1 } else { 0 }),
            );
            for (name, key) in CONTAINER {
                add(&service, name, c[key].clone());
            }
        }
    }
    rows
}
pub async fn rollups(s: &State, now: i64) -> Result<()> {
    let current = now / 3600000 * 3600000;
    let from = dima_text::to_iso_string(current - 48 * 3600000);
    let to = dima_text::to_iso_string(current);
    let rows=s.store.query("SELECT DISTINCT (extract(epoch FROM date_trunc('hour',at))*1000)::bigint AS hour FROM analytics_resources WHERE at>=$1::text::timestamptz AND at<$2::text::timestamptz AND service='host' AND name='docker_up' EXCEPT SELECT (extract(epoch FROM at)*1000)::bigint FROM analytics_resources WHERE at>=$1::text::timestamptz AND service='host' AND name LIKE '%.h_avg'",&[&from,&to]).await?;
    for row in rows {
        let hour: i64 = row.try_get(0)?;
        s.store.execute("INSERT INTO analytics_resources(at,service,name,value) SELECT $1::text::timestamptz,service,name||x.suffix,x.v FROM (SELECT service,name,avg(value) AS a,max(value) AS m FROM analytics_resources WHERE at>=$1::text::timestamptz AND at<$1::text::timestamptz+interval '1 hour' AND (service='host' OR service LIKE 'container:%') AND name NOT LIKE '%.h\\_%' GROUP BY 1,2) g CROSS JOIN LATERAL (VALUES ('.h_avg',g.a),('.h_max',g.m)) AS x(suffix,v) ON CONFLICT(at,service,name) DO UPDATE SET value=excluded.value",&[&dima_text::to_iso_string(hour)]).await?;
    }
    Ok(())
}
pub async fn series(s: &State, minutes: i32, container: Option<&str>, now: i64) -> Result<V> {
    let span = minutes.min(43200);
    let cache_key = format!("{span}|{}", container.unwrap_or(""));
    {
        let cache = s.infra_cache.lock().await;
        if let Some((_, _, value)) = cache
            .iter()
            .find(|(key, until, _)| key == &cache_key && *until > now)
        {
            return Ok(value.clone());
        }
    }

    let long = span > 1440;
    let host_slot = if long { 3600 } else { 30 }.max((span * 60 + 119) / 120);
    let list_slot = if long { 3600 } else { 60 }.max((span * 60 + 59) / 60);
    let detail_slot = 60.max(host_slot);
    let mut groups = vec![
        (
            host_slot,
            "host".to_owned(),
            vec![
                "cpu_pct",
                "mem_used_bytes",
                "disk_used_bytes",
                "load1",
                "net_rx_bps",
                "net_tx_bps",
                "disk_read_bps",
                "disk_write_bps",
                "swap_used_bytes",
                "iowait_pct",
            ],
            false,
        ),
        (
            list_slot,
            "container:%".into(),
            vec!["running", "cpu_pct", "mem_bytes", "restart_count"],
            false,
        ),
    ];
    if let Some(c) = container {
        groups.push((
            detail_slot,
            format!("container:{c}"),
            CONTAINER.iter().map(|(n, _)| *n).collect(),
            true,
        ));
    }
    let mut series = vec![];
    for (slot, service, names, detail) in groups {
        let names: Vec<String> = names.into_iter().map(str::to_owned).collect();
        let since = now - i64::from(span) * 60000;
        let current = now / 3600000 * 3600000;
        let from = dima_text::to_iso_string(if long { current } else { since });
        let sql = "SELECT service,name,(floor(extract(epoch FROM at)/$2::int)*$2::int*1000)::float8 AS at,avg(value) AS avg,max(value) AS max FROM analytics_resources WHERE at>=$1::text::timestamptz AND service LIKE $3 AND name=ANY($4::text[]) GROUP BY 1,2,3 ORDER BY 1,2,3 LIMIT 20000";
        let mut rows = s
            .rows(
                sql,
                &[&from, &if long { 60 } else { slot }, &service, &names],
            )
            .await?;
        if long {
            let rolled=s.rows("SELECT (extract(epoch FROM at)*1000)::float8 AS at,service,name,value FROM analytics_resources WHERE at>=$1::text::timestamptz AND at<$2::text::timestamptz AND service LIKE $3 AND name=ANY($4::text[])",&[&dima_text::to_iso_string(((since+3599999)/3600000)*3600000),&dima_text::to_iso_string(current),&service,&names.iter().flat_map(|n|[format!("{n}.h_avg"),format!("{n}.h_max")]).collect::<Vec<_>>()]).await?;
            let mut merged: HashMap<String, V> = HashMap::new();
            for r in rolled {
                let name = r["name"].as_str().unwrap_or("");
                let (base, field) = if let Some(n) = name.strip_suffix(".h_avg") {
                    (n, "avg")
                } else if let Some(n) = name.strip_suffix(".h_max") {
                    (n, "max")
                } else {
                    continue;
                };
                let id = format!("{}|{base}|{}", r["service"], r["at"]);
                let v=merged.entry(id).or_insert_with(||json!({"service":r["service"],"name":base,"at":r["at"],"avg":null,"max":null}));
                v[field] = r["value"].clone();
            }
            rows.splice(
                0..0,
                merged
                    .into_values()
                    .filter(|v| v["avg"].is_number() && v["max"].is_number()),
            );
        }
        let mut buckets: TrendBuckets = vec![];
        for r in rows {
            let service = r["service"].as_str().unwrap_or("");
            let name = r["name"].as_str().unwrap_or("");
            let index = buckets
                .iter()
                .position(|(s, n, _)| s == service && n == name)
                .unwrap_or_else(|| {
                    buckets.push((service.into(), name.into(), BTreeMap::new()));
                    buckets.len() - 1
                });
            let at = r["at"].as_f64().unwrap_or(0.) as i64;
            let point = buckets[index]
                .2
                .entry(at / (i64::from(slot) * 1000) * (i64::from(slot) * 1000))
                .or_insert((0., 0, f64::NEG_INFINITY));
            point.0 += r["avg"].as_f64().unwrap_or(0.);
            point.1 += 1;
            point.2 = point.2.max(r["max"].as_f64().unwrap_or(0.));
        }
        let round = |v: f64| format!("{v:.3e}").parse::<f64>().ok();
        for (service, name, points) in buckets {
            series.push(json!({"service":service,"name":name,"detail":detail,"points":points.into_iter().map(|(at,(sum,n,max))|json!([at,round(sum/n as f64),round(max)])).collect::<Vec<_>>()}));
        }
    }
    let value = json!({"slotSeconds":{"host":host_slot,"list":list_slot,"detail":detail_slot},"series":series});
    let mut cache = s.infra_cache.lock().await;
    if cache.len() > 200 {
        cache.clear();
    }
    cache.retain(|(key, _, _)| key != &cache_key);
    cache.push_back((
        cache_key,
        now + (i64::from(list_slot) * 500).clamp(15000, 300000),
        value.clone(),
    ));
    Ok(value)
}

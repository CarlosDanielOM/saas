//! Read-only host sampler and HTTP service; environment is owned by the binary.
#![forbid(unsafe_code)]
pub mod config;
pub mod docker;
pub mod parse;
use config::Config;
use dima_core::{Clock, Random};
use parse as p;
use serde_json::{Value as V, json};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{Mutex, RwLock};
#[derive(Debug)]
pub struct State {
    pub config: Config,
    pub clock: Arc<dyn Clock>,
    pub latest: RwLock<V>,
    last_attempt: std::sync::atomic::AtomicI64,
    sample: Mutex<Previous>,
    df: Arc<Mutex<Df>>,
    docker: docker::Docker,
    collator: dima_text::Collator,
    df_task: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}
#[derive(Debug, Default)]
struct Previous {
    host: V,
    containers: HashMap<String, V>,
    version: V,
    version_at: Option<i64>,
}
#[derive(Debug, Default)]
struct Df {
    value: V,
    at: i64,
}
pub fn build(
    config: Config,
    clock: Arc<dyn Clock>,
    _random: Arc<dyn Random>,
) -> Result<dima_web::App<State>, BuildError> {
    let state = State {
        docker: docker::Docker {
            socket: config.socket.clone(),
        },
        df_task: Default::default(),
        config,
        clock,
        latest: RwLock::new(V::Null),
        last_attempt: Default::default(),
        sample: Mutex::new(Previous::default()),
        df: Arc::new(Mutex::new(Df::default())),
        collator: dima_text::Collator::new().map_err(|e| BuildError(e.to_string()))?,
    };
    let mut root = dima_web::Router::new();
    root.middleware(handle);
    dima_web::App::new(root, state).map_err(|e| BuildError(e.to_string()))
}
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct BuildError(String);
async fn read(path: impl AsRef<std::path::Path>) -> String {
    tokio::fs::read_to_string(path).await.unwrap_or_default()
}
impl State {
    pub async fn sample(&self) {
        let Ok(mut prev) = self.sample.try_lock() else {
            return;
        }; // interval busy guard
        let at = self.clock.now_ms();
        self.last_attempt
            .store(at, std::sync::atomic::Ordering::Relaxed);
        let base = &self.config.proc;
        let (stat, mem, load, uptime, disks, net, pc, pm, pi) = tokio::join!(
            read(base.join("stat")),
            read(base.join("meminfo")),
            read(base.join("loadavg")),
            read(base.join("uptime")),
            read(base.join("diskstats")),
            read(&self.config.net_dev),
            read(base.join("pressure/cpu")),
            read(base.join("pressure/memory")),
            read(base.join("pressure/io"))
        );
        let cpu = p::cpu(&stat);
        let io = p::disks(&disks);
        let nic = p::net(&net);
        let usage = p::cpu_between(&prev.host["cpu"], &cpu);
        let sec = (at as f64 - p::number(&prev.host["at"])) / 1000.;
        // CPU count must ignore cgroup quota, as os.cpus() does. Read the real kernel stat.
        let cpus = read("/proc/stat")
            .await
            .lines()
            .filter(|l| {
                l.strip_prefix("cpu")
                    .is_some_and(|s| s.starts_with(|c: char| c.is_ascii_digit()))
            })
            .count();
        let mut host = json!({"cpus":if cpus>0{json!(cpus)}else{V::Null},"uptimeSec":if uptime.is_empty(){V::Null}else{p::uptime(&uptime)},"cpuPct":usage["cpuPct"],"iowaitPct":usage["iowaitPct"],"stealPct":usage["stealPct"]});
        for v in [
            if load.is_empty() {
                V::Null
            } else {
                p::load(&load)
            },
            if mem.is_empty() {
                V::Null
            } else {
                p::mem(&mem)
            },
        ] {
            if let Some(m) = v.as_object() {
                for (k, v) in m {
                    host[k] = v.clone();
                }
            }
        }
        let disk = self.config.disk_path.clone();
        if let Ok(Ok(fs)) =
            tokio::task::spawn_blocking(move || nix::sys::statfs::statfs(&disk)).await
        {
            for (k, v) in [
                ("diskTotal", fs.blocks() as f64 * fs.block_size() as f64),
                (
                    "diskFree",
                    fs.blocks_available() as f64 * fs.block_size() as f64,
                ),
                (
                    "diskUsed",
                    (fs.blocks() as f64 - fs.blocks_free() as f64) * fs.block_size() as f64,
                ),
                ("inodesTotal", fs.files() as f64),
                ("inodesUsed", fs.files() as f64 - fs.files_free() as f64),
            ] {
                host[k] = json!(v);
            }
        }
        for (k, a, b) in [
            ("diskReadBps", &prev.host["io"]["read"], &io["read"]),
            ("diskWriteBps", &prev.host["io"]["written"], &io["written"]),
            ("netRxBps", &prev.host["nic"]["rx"], &nic["rx"]),
            ("netTxBps", &prev.host["nic"]["tx"], &nic["tx"]),
        ] {
            host[k] = p::rate(a, b, sec);
        }
        host["netRx"] = nic["rx"].clone();
        host["netTx"] = nic["tx"].clone();
        host["pressure"] =
            json!({"cpu":p::pressure(&pc),"memory":p::pressure(&pm),"io":p::pressure(&pi)});
        prev.host = json!({"at":at,"cpu":cpu,"io":io,"nic":nic});
        let mut errors = Vec::new();
        let mut rows = Vec::new();
        let mut reachable = false;
        match self.docker.get("/containers/json?all=1", 5000).await {
            Err(e) => {
                let msg = match &e {
                    docker::Error::Io(io) if io.kind() == std::io::ErrorKind::NotFound => {
                        format!("docker: connect ENOENT {}", self.config.socket.display())
                    }
                    _ => format!("docker: {e}"),
                };
                errors.push(msg.chars().take(120).collect::<String>());
            }
            Ok(list) => {
                reachable = true;
                let list = p::select(&list, &self.config.projects);
                if prev.version_at.is_none_or(|last| at - last > 3600000) {
                    if let Ok(v) = self.docker.get("/version", 5000).await {
                        if v["Version"].as_str().is_some_and(|s| !s.is_empty()) {
                            prev.version = v["Version"].clone();
                        }
                    }
                    prev.version_at = Some(at);
                }
                let df = self.df.lock().await;
                use futures_util::{StreamExt, stream};
                let reads = stream::iter(list.iter().cloned())
                    .map(|entry| async move {
                        let id = entry["id"].as_str().unwrap_or("");
                        let inspect = self
                            .docker
                            .get(&format!("/containers/{id}/json"), 5000)
                            .await?;
                        let counters = if inspect["State"]["Status"] == "running" {
                            p::counters(
                                &self
                                    .docker
                                    .get(
                                        &format!(
                                            "/containers/{id}/stats?stream=false&one-shot=true"
                                        ),
                                        5000,
                                    )
                                    .await
                                    .unwrap_or(V::Null),
                            )
                        } else {
                            V::Null
                        };
                        Ok::<_, docker::Error>((entry, inspect, counters))
                    })
                    .buffered(4)
                    .collect::<Vec<_>>()
                    .await;
                let mut failed = 0;
                prev.containers
                    .retain(|id, _| list.iter().any(|e| e["id"] == *id));
                for result in reads {
                    match result {
                        Err(_) => failed += 1,
                        Ok((entry, inspect, counters)) => {
                            let id = entry["id"].as_str().unwrap_or("");
                            let old = prev.containers.get(id).unwrap_or(&V::Null);
                            let mut row = p::view(&entry, &inspect, &counters, old, at as f64);
                            if counters.is_null() {
                                prev.containers.remove(id);
                            } else {
                                let mut saved = counters;
                                saved["at"] = json!(at);
                                prev.containers.insert(id.into(), saved);
                            }
                            let d = &df.value;
                            row["imageBytes"] =
                                d["byImage"][inspect["Image"].as_str().unwrap_or("")].clone();
                            row["writableBytes"] = d["byContainer"][id].clone();
                            if !d.is_null() && !p::array(&row["volumes"]).is_empty() {
                                row["volumeBytes"] = json!(
                                    p::array(&row["volumes"])
                                        .iter()
                                        .map(|n| p::number(
                                            &d["byVolume"][n.as_str().unwrap_or("")]
                                        ))
                                        .sum::<f64>()
                                );
                            }
                            rows.push(row);
                        }
                    }
                }
                if failed > 0 {
                    errors.push(format!("docker: {failed} container reads failed"));
                }
                rows.sort_by(|a, b| {
                    self.collator.compare(
                        a["name"].as_str().unwrap_or(""),
                        b["name"].as_str().unwrap_or(""),
                    )
                });
            }
        }
        let version = prev.version.clone();
        let mut latest = self.latest.write().await;
        let mut df = self.df.lock().await.value.clone();
        if let Some(m) = df.as_object_mut() {
            m.remove("byImage");
            m.remove("byContainer");
            m.remove("byVolume");
        }
        *latest = json!({"version":1,"at":dima_text::to_iso_string(at),"sampleMs":self.config.sample_ms,"host":host,"docker":{"reachable":reachable,"version":version,"df":df},"containers":rows,"errors":errors});
        drop(latest);
        if reachable {
            let df = self.df.lock().await;
            let due = df.value.is_null() || at - df.at > self.config.df_ms as i64;
            drop(df);
            if due && let Ok(mut task) = self.df_task.lock() {
                if task.as_ref().is_none_or(|h| h.is_finished()) {
                    let docker = self.docker.clone();
                    let shared = self.df.clone();
                    let clock = self.clock.clone();
                    *task = Some(tokio::spawn(async move {
                        let result = docker.get("/system/df", 120000).await;
                        let mut df = shared.lock().await;
                        if let Ok(v) = result {
                            df.value = p::df(&v, clock.now_ms());
                        }
                        df.at = clock.now_ms();
                    }));
                }
            }
        }
    }
}
async fn handle(req: &mut dima_web::Req<State>) -> dima_web::Response {
    let state = req.state();
    let latest = state.latest.read().await;
    let (status, body) = if req.method() != http::Method::GET {
        (405, json!({"message":"Read-only service"}))
    } else {
        match req.original_url() {
            "/health" => {
                let fresh = state.clock.now_ms()
                    - state
                        .last_attempt
                        .load(std::sync::atomic::Ordering::Relaxed)
                    < state.config.sample_ms as i64 * 4;
                (
                    if fresh { 200 } else { 503 },
                    json!({"status":if fresh{"ok"}else{"stale"},"sampledAt":latest["at"],"dockerReachable":latest["docker"]["reachable"].as_bool().unwrap_or(false)}),
                )
            }
            "/v1/snapshot" => {
                if latest.is_null() {
                    (503, json!({"message":"No sample yet"}))
                } else {
                    (200, latest.clone())
                }
            }
            _ => (404, json!({"message":"Not found"})),
        }
    };
    // Raw response avoids Express defaults (ETag, charset) in dima-web's JSON helper.
    let body = dima_text::to_js_json(&body);
    let response = http::Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .body(dima_web::Body::from(body));
    match response {
        Ok(r) => dima_web::Response::from_http(r),
        Err(_) => dima_web::Response::status(500).end(),
    }
}

impl Drop for State {
    fn drop(&mut self) {
        if let Ok(task) = self.df_task.get_mut() {
            if let Some(task) = task.take() {
                task.abort();
            }
        }
    }
}

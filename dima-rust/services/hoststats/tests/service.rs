#![forbid(unsafe_code)]
#![allow(clippy::unwrap_used, clippy::panic)]
use dima_core::{ManualClock, SystemRandom};
use dima_hoststats::{build, config::Config, parse};
use http_body_util::BodyExt;
use serde_json::{Value as V, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[tokio::test]
async fn sampler_server_fake_docker_project_filter_disappearance_and_cache() -> anyhow::Result<()> {
    let dir = std::env::temp_dir().join(format!("hoststats-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    for (name, text) in [
        ("stat", "cpu  1 0 1 10 0 0 0 0"),
        ("meminfo", "MemTotal: 100 kB\nMemAvailable: 50 kB"),
        ("loadavg", "0.5 0.4 0.3 2/300 9"),
        ("uptime", "123.4 9"),
        ("net", "a\nb\n eth0: 10 0 0 0 0 0 0 0 20 0 0 0 0 0 0 0"),
    ] {
        std::fs::write(dir.join(name), text)?;
    }
    let socket = dir.join("docker.sock");
    let listener = tokio::net::UnixListener::bind(&socket)?;
    let present = Arc::new(AtomicBool::new(true));
    let version_calls = Arc::new(AtomicUsize::new(0));
    let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (pr, vc, ca) = (present.clone(), version_calls.clone(), calls.clone());
    let server = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let pr = pr.clone();
            let vc = vc.clone();
            let ca = ca.clone();
            tokio::spawn(async move {
                let mut buf = [0; 4096];
                let n = stream.read(&mut buf).await.unwrap();
                let line = String::from_utf8_lossy(&buf[..n]);
                let path = line.split_whitespace().nth(1).unwrap();
                ca.lock().unwrap().push(path.to_string());
                let value = match path {
                    "/containers/json?all=1" => {
                        if pr.load(Ordering::Relaxed) {
                            json!([{"Id":"a".repeat(64),"Names":["/dima-server"],"Labels":{"com.docker.compose.project":"dimabot"}},{"Id":"b".repeat(64),"Names":["/other"],"Labels":{"com.docker.compose.project":"nope"}}])
                        } else {
                            json!([])
                        }
                    }
                    "/version" => {
                        vc.fetch_add(1, Ordering::Relaxed);
                        json!({"Version":"29.0.0"})
                    }
                    "/system/df" => {
                        json!({"Images":[{"Id":"sha256:img","Size":9}],"Containers":[],"Volumes":[],"BuildCache":[]})
                    }
                    p if p.ends_with("/json") => {
                        json!({"State":{"Status":"running"},"HostConfig":{},"Image":"sha256:img","Config":{"Labels":{}}})
                    }
                    _ => {
                        json!({"cpu_stats":{"cpu_usage":{"total_usage":1}},"memory_stats":{"usage":10}})
                    }
                };
                let body = value.to_string();
                let out = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(out.as_bytes()).await;
            });
        }
    });
    let mut config = Config::from_values(|_| None);
    config.proc = dir.clone();
    config.net_dev = dir.join("net");
    config.socket = socket;
    let clock = Arc::new(ManualClock::new(1000));
    let app = build(config, clock.clone(), Arc::new(SystemRandom))?;
    app.state().sample().await;
    let first = app.state().latest.read().await.clone();
    assert_eq!(first["containers"].as_array().unwrap().len(), 1);
    assert_eq!(first["docker"]["version"], "29.0.0");
    assert_eq!(first["host"]["memUsed"], 51200.);
    assert_eq!(first["host"]["load1"], 0.5);
    assert!(first["host"]["diskUsed"].as_f64().unwrap() > 0.);
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    clock.advance(15000);
    app.state().sample().await;
    let second = app.state().latest.read().await.clone();
    assert_eq!(second["docker"]["df"]["imagesBytes"], 9.);
    assert_eq!(second["containers"][0]["imageBytes"], 9.);
    assert_eq!(second["host"]["netRxBps"], 0.);
    assert_eq!(version_calls.load(Ordering::Relaxed), 1);
    assert!(
        !calls
            .lock()
            .unwrap()
            .iter()
            .any(|p| p.contains(&"b".repeat(64)))
    );
    assert!(second["docker"]["df"].get("byImage").is_none());
    for (method, path, status) in [
        ("GET", "/health", 200),
        ("GET", "/health?x", 404),
        ("HEAD", "/health", 405),
        ("POST", "/v1/snapshot", 405),
        ("GET", "/nope", 404),
        ("GET", "/v1/snapshot", 200),
    ] {
        let response = app
            .handle(
                http::Request::builder()
                    .method(method)
                    .uri(path)
                    .body(dima_web::Body::empty())?,
            )
            .await;
        assert_eq!(response.status(), status);
        assert_eq!(response.headers()["content-type"], "application/json");
        assert_eq!(response.headers()["cache-control"], "no-store");
        let _ = response.into_body().collect().await?;
    }
    present.store(false, Ordering::Relaxed);
    clock.advance(15000);
    app.state().sample().await;
    assert_eq!(app.state().latest.read().await["containers"], json!([]));
    present.store(true, Ordering::Relaxed);
    clock.advance(15000);
    app.state().sample().await;
    assert!(app.state().latest.read().await["containers"][0]["cpuPct"].is_null());
    clock.advance(60001);
    let response = app
        .handle(
            http::Request::builder()
                .uri("/health")
                .body(dima_web::Body::empty())?,
        )
        .await;
    assert_eq!(response.status(), 503);
    server.abort();
    let _ = server.await;
    drop(app);
    std::fs::remove_dir_all(dir)?;
    Ok(())
}
#[test]
fn serialization_and_configuration() {
    assert_eq!(
        dima_text::to_js_json(&json!({"x":1.0,"y":1e21})),
        "{\"x\":1,\"y\":1e+21}"
    );
    let c = Config::from_values(|k| match k {
        "HOSTSTATS_SAMPLE_MS" => Some("abc".into()),
        "HOSTSTATS_DF_MS" => Some("0".into()),
        _ => None,
    });
    assert_eq!(c.sample_ms, 15000);
    assert_eq!(c.df_ms, 60000);
    assert_eq!(parse::cpu("cpu  1 broken 3 4"), V::Null);
}

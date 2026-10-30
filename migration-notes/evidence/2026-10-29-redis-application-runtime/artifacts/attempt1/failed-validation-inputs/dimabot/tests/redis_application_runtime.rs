#![cfg(feature = "redis-application-runtime")]
#[path = "ai_credit_projection_support/mod.rs"]
mod support;
use dima_rust::utils::redis_application_runtime::ApplicationCacheRuntime;
use std::{
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

// Each child owns a new process and runtime: the underlying global Redis OnceCell
// is deliberately never carried between Tokio runtimes.
#[test]
#[ignore = "requires explicit fresh task-owned private Redis fixture"]
fn isolated_runtime_probes() {
    let (_, host, port) = support::fixture_url();
    let run = |case: &str, host: &str, port: u16, disabled: bool| {
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "child_runtime_probe", "--nocapture"])
            .env("APPLICATION_CACHE_PROBE_CASE", case)
            .env("DRAGONFLY_HOST", host)
            .env("DRAGONFLY_PORT", port.to_string())
            .env(
                "OBSERVABILITY_DISABLED",
                if disabled { "true" } else { "false" },
            )
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let output = support::child_output(child, Duration::from_secs(20));
        assert!(
            output.status.success(),
            "probe {case} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    // Real fixture is read-only: telemetry disabled, no publisher or key writes.
    run("real-disabled", &host, port, true);
    // An owned local RESP endpoint receives exporter traffic; it never touches
    // fixture inbox keys. Its accepted connection count proves manager sharing.
    let endpoint = support::Endpoint::new(|args| match args[0].as_str() {
        "PING" => b"+PONG\r\n".to_vec(),
        _ => b":0\r\n".to_vec(),
    });
    let (mock_host, mock_port) = support::parse_fixture_url(&endpoint.url);
    run("shutdown-pending", &mock_host, mock_port, false);
    assert_eq!(endpoint.connections.load(Ordering::SeqCst), 0);
    run("shared", &mock_host, mock_port, false);
    let calls = endpoint.calls.lock().unwrap();
    let eval = calls
        .iter()
        .find(|c| c.first().map(String::as_str) == Some("EVAL"))
        .expect("shutdown must export an EVAL");
    assert_eq!(eval[3], "observability:v1:inbox");
    assert_eq!(eval[4], "observability:v1:overflow");
    let payload: serde_json::Value = serde_json::from_str(&eval[5]).unwrap();
    assert!(
        payload["metrics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["name"] == "probe")
    );
    drop(calls);
    // Exactly one manager socket and one separate shutdown exporter socket.
    assert_eq!(endpoint.connections.load(Ordering::SeqCst), 2);
    #[cfg(all(feature = "moderation-permit", feature = "moderation-offenses"))]
    {
        let stores = support::Endpoint::new(|args| match args[0].as_str() {
            "PING" => b"+PONG\r\n".to_vec(),
            "SET" => b"+OK\r\n".to_vec(),
            "GET" => b"$-1\r\n".to_vec(),
            "EVAL" if args[3] == "observability:v1:inbox" => b":0\r\n".to_vec(),
            "EVAL" => b":1\r\n".to_vec(),
            _ => b":0\r\n".to_vec(),
        });
        let (store_host, store_port) = support::parse_fixture_url(&stores.url);
        run("default-stores", &store_host, store_port, false);
        assert_eq!(stores.connections.load(Ordering::SeqCst), 2);
        let calls = stores.calls.lock().unwrap();
        let export = calls
            .iter()
            .find(|c| {
                c.first().map(String::as_str) == Some("EVAL")
                    && c.get(3).map(String::as_str) == Some("observability:v1:inbox")
            })
            .expect("shutdown export");
        let payload: serde_json::Value = serde_json::from_str(&export[5]).unwrap();
        let metrics = payload["metrics"].as_array().unwrap();
        for name in ["set", "get", "eval"] {
            assert!(
                metrics
                    .iter()
                    .any(|m| m["kind"] == "cache" && m["name"] == name)
            );
        }
        assert!(
            metrics.iter().any(|m| m["kind"] == "cache_lookup"
                && m["name"] == "get"
                && m["outcome"] == "miss")
        );
        assert!(
            calls
                .iter()
                .any(|c| c.first().map(String::as_str) == Some("EVAL")
                    && c.get(3).is_some_and(|k| k.starts_with("moderation:")))
        );
    }
    let attempts = Arc::new(AtomicUsize::new(0));
    let counter = attempts.clone();
    let failing = support::Endpoint::new(move |args| match args[0].as_str() {
        "PING" if counter.fetch_add(1, Ordering::SeqCst) == 0 => {
            b"-ERR first ping rejected\r\n".to_vec()
        }
        "PING" => b"+PONG\r\n".to_vec(),
        _ => b":0\r\n".to_vec(),
    });
    let (mock_host, mock_port) = support::parse_fixture_url(&failing.url);
    run("retry", &mock_host, mock_port, true);
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
    let attempts = Arc::new(AtomicUsize::new(0));
    let counter = attempts.clone();
    let held = support::Endpoint::new(move |args| match args[0].as_str() {
        "PING" if counter.fetch_add(1, Ordering::SeqCst) == 0 => {
            // Hold only an in-flight initial PING, never ready work.
            std::thread::sleep(Duration::from_secs(2));
            b"+PONG\r\n".to_vec()
        }
        "PING" => b"+PONG\r\n".to_vec(),
        _ => b":0\r\n".to_vec(),
    });
    let (mock_host, mock_port) = support::parse_fixture_url(&held.url);
    run("cancel", &mock_host, mock_port, false);
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    assert_eq!(held.connections.load(Ordering::SeqCst), 2);
}

#[test]
#[ignore = "subprocess entry point; invoked by isolated_runtime_probes"]
fn child_runtime_probe() {
    let case = std::env::var("APPLICATION_CACHE_PROBE_CASE").expect("private parent case");
    // Even direct child invocation requires the private fixture ownership guard.
    let (_, fixture_host, fixture_port) = support::fixture_url();
    let host = std::env::var("DRAGONFLY_HOST").unwrap();
    let port: u16 = std::env::var("DRAGONFLY_PORT").unwrap().parse().unwrap();
    match case.as_str() {
        "real-disabled" => assert_eq!((host.as_str(), port), (fixture_host.as_str(), fixture_port)),
        "shared" | "retry" | "cancel" | "default-stores" | "shutdown-pending" => {
            assert_eq!(host, "127.0.0.1")
        }
        _ => panic!("unknown private probe"),
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        #[cfg(all(feature = "moderation-permit", feature = "moderation-offenses"))]
        if case == "default-stores" {
            use dima_rust::utils::{
                js_string::JsString,
                moderation::{offenses::OffenseStore, permit::PermitStore},
                redis_application_runtime,
            };
            let permit = PermitStore::connect().await.unwrap();
            let offenses = OffenseStore::connect().await.unwrap();
            let (_, telemetry) = redis_application_runtime::acquire().await.unwrap();
            let telemetry = telemetry.unwrap();
            let channel = JsString::from("channel");
            let login = JsString::from("login");
            let rule = JsString::from("rule");
            let decision = JsString::from("decision");
            permit
                .grant_permit_at(&channel, 60.0, Some(&login), 1_000.0)
                .await
                .unwrap();
            assert!(!permit.has_active_permit(&channel, &login).await.unwrap());
            assert_eq!(
                offenses
                    .record_offense(&channel, &rule, &login, 60.0, Some(&decision))
                    .await
                    .unwrap(),
                1.0
            );
            let snapshot = telemetry.snapshot();
            for name in ["set", "get", "eval"] {
                assert!(
                    snapshot
                        .metrics
                        .iter()
                        .any(|m| m.kind == "cache" && m.name == name)
                );
            }
            assert!(
                snapshot
                    .metrics
                    .iter()
                    .any(|m| m.kind == "cache_lookup" && m.name == "get" && m.outcome == "miss")
            );
            tokio::time::timeout(
                Duration::from_secs(4),
                redis_application_runtime::shutdown(),
            )
            .await
            .unwrap();
            return;
        }
        let owner = ApplicationCacheRuntime::new();
        if case == "shutdown-pending" {
            use std::{future::Future, task::Poll};
            let mut acquire = std::pin::pin!(owner.acquire());
            // Poll once on the sole runtime thread: the leader is installed but
            // has not run. Shutdown must drop its guard and wake this waiter.
            std::future::poll_fn(|cx| {
                assert!(acquire.as_mut().poll(cx).is_pending());
                Poll::Ready(())
            })
            .await;
            tokio::time::timeout(Duration::from_secs(2), owner.shutdown())
                .await
                .unwrap();
            let error = tokio::time::timeout(Duration::from_secs(1), acquire)
                .await
                .unwrap()
                .err()
                .unwrap();
            assert_eq!(error.kind(), redis::ErrorKind::InvalidClientConfig);
            assert!(owner.acquire().await.is_err());
            return;
        }
        if case == "retry" {
            let (a, b) = tokio::time::timeout(Duration::from_secs(7), async {
                tokio::join!(owner.acquire(), owner.acquire())
            })
            .await
            .unwrap();
            let (a, b) = (
                a.err().expect("first waiter must fail"),
                b.err().expect("second waiter must fail"),
            );
            assert_eq!(a.kind(), b.kind());
            assert_eq!(a.to_string(), b.to_string());
        }
        if case == "cancel" {
            assert!(
                tokio::time::timeout(Duration::from_secs(1), owner.acquire())
                    .await
                    .is_err(),
                "initial PING must be held before cancellation"
            );
        }
        let (a, b) = tokio::time::timeout(Duration::from_secs(7), async {
            tokio::join!(owner.acquire(), owner.acquire())
        })
        .await
        .unwrap();
        let (mut a, ta) = a.unwrap();
        let (mut b, tb) = b.unwrap();
        if case == "shared" || case == "cancel" {
            let ta = ta.unwrap();
            let tb = tb.unwrap();
            ta.observe("cache", "probe", 1.0, "ok", None, 0);
            assert!(tb.snapshot().metrics.iter().any(|row| row.name == "probe"));
        } else {
            assert!(ta.is_none() && tb.is_none());
            if case == "real-disabled" {
                let ids: (i64, i64) = tokio::try_join!(
                    redis::cmd("CLIENT").arg("ID").query_async(&mut a),
                    redis::cmd("CLIENT").arg("ID").query_async(&mut b)
                )
                .unwrap();
                assert_eq!(ids.0, ids.1);
            }
        }
        tokio::time::timeout(Duration::from_secs(4), owner.shutdown())
            .await
            .unwrap();
        assert!(owner.acquire().await.is_err());
    });
}

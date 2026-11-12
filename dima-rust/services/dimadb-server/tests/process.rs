//! The binary as a process: behaviour the side-by-side rig cannot record because the reference
//! crashes or hangs on it, start-up checks, expired sessions in the data files, and shutdown.

#![allow(
    clippy::expect_used,
    reason = "helpers of the tests below fail the test when a step fails"
)]

mod support;

use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::json;
use support::{api, request, scratch, start_rust};

fn app_dir(with_index: bool) -> std::path::PathBuf {
    let public = scratch("public");
    if with_index {
        std::fs::write(public.join("index.html"), "<html>app</html>").expect("index");
    }
    public
}

/// The reference crashed (uncaught exception, process exit) on these; here they are 400s and the
/// server keeps serving.
#[test]
fn malformed_requests_are_answered_not_crashed() {
    let data = scratch("malformed");
    let server = start_rust(&data, &app_dir(true), &[]).expect("starts");
    let port = server.port;
    for target in ["/%", "/%E0%A4%A", "/a%ZZb", "/%C0%80"] {
        let reply = request(port, "GET", target, &[], None).expect("answered");
        assert_eq!(reply.status, 400, "{target}");
    }
    let bad_host = request(port, "GET", "/", &["Host: bad host[x]"], None).expect("answered");
    assert_eq!(bad_host.status, 400);
    let bad_port =
        request(port, "GET", "/api/health", &["Host: localhost:99999"], None).expect("answered");
    assert_eq!(bad_port.status, 400);
    let health = request(port, "GET", "/api/health", &[], None).expect("still serving");
    assert_eq!(health.status, 200);
    drop(server);
    let _ = std::fs::remove_dir_all(&data);
}

#[test]
fn missing_public_assets_are_a_503() {
    let data = scratch("no-assets");
    let server = start_rust(&data, &app_dir(false), &[]).expect("starts");
    let reply = request(server.port, "GET", "/anything", &[], None).expect("answered");
    assert_eq!(reply.status, 503);
    assert_eq!(
        reply.header("content-type"),
        Some("text/plain; charset=utf-8")
    );
    assert_eq!(reply.body, b"dimadb public assets missing");
    drop(server);
    let _ = std::fs::remove_dir_all(&data);
}

/// Sessions are pruned by `expiresAt`; the file is rewritten without the expired rows.
#[test]
fn expired_and_tampered_sessions_are_refused() {
    let data = scratch("sessions");
    let server = start_rust(&data, &app_dir(true), &[]).expect("starts");
    let port = server.port;
    let setup = api(
        port,
        "POST",
        "/api/setup",
        None,
        Some(json!({ "username": "root", "password": "long enough" })),
    )
    .expect("setup");
    let cookie = setup.cookie();
    let sessions: serde_json::Value =
        serde_json::from_slice(&std::fs::read(data.join("sessions.json")).expect("sessions"))
            .expect("JSON");
    let user_id = sessions[0]["userId"].clone();
    let rows = json!([
        sessions[0],
        { "id": "11111111-1111-4111-8111-111111111111", "userId": user_id, "createdAt": "2020-01-01T00:00:00.000Z", "expiresAt": "2020-01-15T00:00:00.000Z" },
        { "id": "22222222-2222-4222-8222-222222222222", "userId": user_id, "createdAt": "2026-01-01T00:00:00.000Z", "expiresAt": "2999-01-01T00:00:00.000Z" },
        { "id": "33333333-3333-4333-8333-333333333333", "userId": "no such user", "expiresAt": "2999-01-01T00:00:00.000Z" },
        { "id": "44444444-4444-4444-8444-444444444444", "userId": user_id, "expiresAt": "not a date" }
    ]);
    std::fs::write(
        data.join("sessions.json"),
        serde_json::to_string_pretty(&rows).expect("text"),
    )
    .expect("write");
    let me = |cookie: &str| api(port, "GET", "/api/me", Some(cookie), None).map(|r| r.status);
    assert_eq!(
        me("dimadb_session=11111111-1111-4111-8111-111111111111"),
        Some(401),
        "expired"
    );
    assert_eq!(
        me("dimadb_session=44444444-4444-4444-8444-444444444444"),
        Some(401),
        "unparseable expiry"
    );
    assert_eq!(
        me("dimadb_session=22222222-2222-4222-8222-222222222222"),
        Some(200),
        "valid"
    );
    assert_eq!(
        me("dimadb_session=33333333-3333-4333-8333-333333333333"),
        Some(401),
        "user gone"
    );
    assert_eq!(me(&format!("{cookie}0")), Some(401), "tampered");
    assert_eq!(me(&cookie), Some(200));
    let pruned: serde_json::Value =
        serde_json::from_slice(&std::fs::read(data.join("sessions.json")).expect("sessions"))
            .expect("JSON");
    assert_eq!(
        pruned.as_array().map(Vec::len),
        Some(3),
        "expired rows are removed from the file"
    );
    drop(server);
    let _ = std::fs::remove_dir_all(&data);
}

/// node-redis retries an unreachable server forever and the request never answers; here the
/// connection attempt fails within its timeout.
#[test]
fn an_unreachable_redis_answers_instead_of_hanging() {
    let data = scratch("unreachable");
    let dead = support::free_port();
    let url = format!("redis://127.0.0.1:{dead}");
    let server = start_rust(
        &data,
        &app_dir(true),
        &[("DIMADB_REDIS_DEAD", url.as_str())],
    )
    .expect("starts");
    let cookie = api(
        server.port,
        "POST",
        "/api/setup",
        None,
        Some(json!({ "username": "root", "password": "long enough" })),
    )
    .expect("setup")
    .cookie();
    let started = Instant::now();
    let reply = api(
        server.port,
        "POST",
        "/api/connections/env%3Adead/ping",
        Some(&cookie),
        None,
    )
    .expect("answered");
    assert!(started.elapsed() < Duration::from_secs(15));
    assert_eq!(reply.status, 500);
    assert_eq!(
        reply.json()["message"],
        format!("connect ECONNREFUSED 127.0.0.1:{dead}")
    );
    drop(server);
    let _ = std::fs::remove_dir_all(&data);
}

#[test]
fn bodies_over_the_limit_are_refused() {
    let data = scratch("limits");
    let server = start_rust(&data, &app_dir(true), &[]).expect("starts");
    let big = format!(
        "{{\"username\":\"{}\",\"password\":\"x\"}}",
        "a".repeat(70 * 1024)
    );
    let reply = request(
        server.port,
        "POST",
        "/api/login",
        &["X-Dimadb: 1"],
        Some(big.as_bytes()),
    )
    .expect("answered");
    assert_eq!(reply.status, 413);
    assert_eq!(
        reply.json(),
        json!({ "error": true, "status": 413, "message": "Request body too large" })
    );
    drop(server);
    let _ = std::fs::remove_dir_all(&data);
}

#[test]
fn bad_configuration_fails_fast() {
    let run = |envs: &[(&str, &str)]| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_dimadb-server"));
        command.env_clear();
        for (name, value) in envs {
            command.env(name, value);
        }
        command.output().expect("runs")
    };
    let data = scratch("config");
    let data_text = data.display().to_string();
    for port in ["abc", "70000", "8080.5"] {
        let output = run(&[("PORT", port), ("DATA_DIR", &data_text)]);
        assert!(!output.status.success(), "PORT={port}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("Invalid PORT"),
            "PORT={port}"
        );
    }
    // A data directory that cannot be created.
    let blocker = data.join("file");
    std::fs::write(&blocker, "x").expect("file");
    let output = run(&[
        ("PORT", "0"),
        ("DATA_DIR", &blocker.join("sub").display().to_string()),
    ]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("cannot create the data directory"));
    // A port in use.
    let taken = std::net::TcpListener::bind("0.0.0.0:0").expect("bind");
    let port = taken.local_addr().expect("addr").port().to_string();
    let output = run(&[("PORT", &port), ("DATA_DIR", &data_text)]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("cannot listen"));
    let _ = std::fs::remove_dir_all(&data);
}

#[test]
fn sigterm_stops_the_server_cleanly() {
    let data = scratch("sigterm");
    let server = start_rust(&data, &app_dir(true), &[("DIMADB_SECRET", "s")]).expect("starts");
    let status = server.terminate().expect("exits after SIGTERM");
    assert!(status.success(), "{status:?}");
    let _ = std::fs::remove_dir_all(&data);
}

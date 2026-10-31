//! Run only under the isolated migration driver with a private marked directory.
#![cfg(feature = "api-file-routes")]
#[path = "support/api_auth_support.rs"]
mod support;
use dima_rust::{
    admin_tools_route::AdminToolsRoute,
    api_auth::{AuthConfig, AuthService, token_cache_key},
    file_route::FileRoute,
    utils::fs::{TOO_LARGE, read_file},
    workspace_owner::WORKSPACE_OWNER_TWITCH_USER_ID,
};
use redis::AsyncCommands;
use serde_json::Value;
use std::path::PathBuf;

fn owned_dir() -> PathBuf {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration")
    );
    let parent =
        PathBuf::from(std::env::var("DIMA_FILE_ROUTES_TEST_ROOT").expect("private test root"));
    assert!(
        parent.starts_with("/tmp")
            && parent != std::path::Path::new("/tmp")
            && parent.canonicalize().unwrap() == parent
    );
    assert!(!parent.starts_with(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap()));
    assert_eq!(
        std::fs::read_to_string(parent.join(".dimabot-migration-owner")).unwrap(),
        "dimabot-migration\n"
    );
    let path = parent.join(format!("file-routes-{}", std::process::id()));
    std::fs::create_dir(&path).expect("fresh test directory");
    std::fs::write(path.join(".owner"), "dimabot-migration\n").unwrap();
    path
}
struct OwnedDirectory(PathBuf);
impl std::ops::Deref for OwnedDirectory {
    type Target = PathBuf;
    fn deref(&self) -> &PathBuf {
        &self.0
    }
}
impl Drop for OwnedDirectory {
    fn drop(&mut self) {
        if std::fs::read_to_string(self.0.join(".owner"))
            .ok()
            .as_deref()
            == Some("dimabot-migration\n")
        {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
fn cleanup(path: &PathBuf) {
    assert_eq!(
        std::fs::read_to_string(path.join(".owner")).unwrap(),
        "dimabot-migration\n"
    );
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
#[ignore = "private fixture resources required"]
async fn real_http_files_and_auth() {
    let fixture_path =
        PathBuf::from(std::env::var("DIMA_FILE_ROUTES_REFERENCE").expect("external oracle"));
    assert!(fixture_path.is_absolute());
    let fixture_dir = fixture_path.parent().unwrap();
    assert!(fixture_dir.starts_with("/tmp") && fixture_dir != std::path::Path::new("/tmp"));
    assert_eq!(fixture_dir.canonicalize().unwrap(), fixture_dir);
    assert!(!fixture_dir.starts_with(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap()));
    assert_eq!(
        std::fs::read_to_string(fixture_dir.join(".dimabot-migration-owner")).unwrap(),
        "dimabot-migration\n"
    );
    assert!(
        std::fs::symlink_metadata(&fixture_path)
            .unwrap()
            .file_type()
            .is_file()
    );
    let fixture_bytes = std::fs::read(&fixture_path).unwrap();
    assert_eq!(
        support::sha256_hex(&fixture_bytes),
        std::env::var("DIMA_FILE_ROUTES_REFERENCE_SHA256").expect("independent oracle digest")
    );
    let fixture: Value = serde_json::from_slice(&fixture_bytes).unwrap();
    assert_eq!(fixture["node"], "v24.22.1");
    assert_eq!(fixture["typescript"], "5.9.3");
    assert_eq!(fixture["express"], "4.22.2");
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for (name, pin) in [
        (
            "src/utils/fs.ts",
            "a4011f419c21a8aab4e019982e14842ad749616cee9c605b774d15e463432e4e",
        ),
        (
            "src/server/routes/file.route.ts",
            "379b363be6866a6355723c16a29a82af4aa4da0cf35c0a9b0a3211a4902d156b",
        ),
        (
            "src/server/routes/admin-tools.route.ts",
            "f23b6f31b54ba1b5ab0d125db8f1a7679882335210797149942c3a6b821aa3ff",
        ),
    ] {
        assert_eq!(
            support::sha256_hex(&std::fs::read(manifest.join(name)).unwrap()),
            pin
        );
        assert_eq!(fixture["source"][name], pin);
    }
    assert_eq!(
        fixture["script"],
        support::sha256_hex(
            &std::fs::read(manifest.join("tests/fixtures/file_routes_reference.cjs")).unwrap()
        )
    );
    assert_eq!(fixture["nodeSha256"], support::NODE_SHA256);
    assert_eq!(fixture["typescriptSha256"], support::TYPESCRIPT_SHA256);
    assert_eq!(fixture["v8"], "13.6.233.17-node.58");
    assert_eq!(
        fixture["sourceAst"],
        serde_json::json!({"readFile":true,"clip":true,"adminAuthOrder":true})
    );
    let expected_native = [
        "Cargo.toml",
        "src/lib.rs",
        "src/utils/mod.rs",
        "src/utils/fs.rs",
        "src/server/routes/file.route.rs",
        "src/server/routes/admin-tools.route.rs",
        "tests/file_routes.rs",
        "tests/support/api_auth_support.rs",
        "src/middleware/auth.middleware.rs",
        "src/middleware/workspace-owner.middleware.rs",
    ];
    assert_eq!(
        fixture["native"].as_object().unwrap().len(),
        expected_native.len()
    );
    for name in expected_native {
        assert_eq!(
            fixture["native"][name],
            support::sha256_hex(&std::fs::read(manifest.join(name)).unwrap()),
            "{name}"
        );
    }

    assert_eq!(
        fixture["scratch"].as_str().unwrap(),
        fixture_dir.to_str().unwrap()
    );
    let cases = fixture["cases"].as_array().unwrap();
    let expected_names = [
        "clip_missing",
        "clip_full",
        "clip_empty",
        "clip_first",
        "clip_middle",
        "clip_open",
        "clip_last",
        "clip_outside",
        "admin_no_path",
        "admin_denied",
        "admin_text",
        "admin_large",
        "admin_missing",
        "admin_limit",
        "admin_é.txt",
        "admin_empty",
        "admin_link",
        "admin_directory",
        "admin_prefix",
        "admin_traversal",
    ];
    // Missing query and missing file must have distinct IDs.
    let names: Vec<_> = cases.iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert_eq!(names, expected_names);
    let dir = OwnedDirectory(owned_dir());
    let fx = support::fixtures("fileroutes").await;
    let owner = fx.token("owner");
    let denied = fx.token("denied");
    let other_id = fx.user_id("other");
    let owner_key = dima_rust::api_auth::activity_touch_key(WORKSPACE_OWNER_TWITCH_USER_ID);
    use futures_util::FutureExt;
    let outcome = std::panic::AssertUnwindSafe(async {
        let downloads = dir.join("public/downloads");
        std::fs::create_dir_all(&downloads).unwrap();
        std::fs::write(downloads.join("demo-clip.mp4"), b"0123456789").unwrap();
        let allow = dir.join("allowed");
        std::fs::create_dir(&allow).unwrap();
        std::fs::create_dir(dir.join("allowed-sibling")).unwrap();
        std::fs::write(dir.join("allowed-sibling/text"), "sibling").unwrap();
        std::fs::write(dir.join("outside"), "traversal").unwrap();
        std::os::unix::fs::symlink(dir.join("outside"), allow.join("link")).unwrap();
        std::fs::write(downloads.join("empty-clip.mp4"), b"").unwrap();
        std::fs::write(allow.join("é.txt"), "雪").unwrap();
        std::fs::write(allow.join("empty"), "").unwrap();
        std::fs::write(allow.join("text"), [65, 255, 66]).unwrap();
        std::fs::write(allow.join("large"), vec![0; 1_048_577]).unwrap();
        std::fs::write(allow.join("limit"), vec![b'x'; 1_048_576]).unwrap();
        assert_eq!(read_file(allow.join("text")).await.unwrap(), "A\u{fffd}B");
        assert_eq!(
            read_file(allow.join("limit")).await.unwrap().len(),
            1_048_576
        );
        assert_eq!(read_file(allow.join("large")).await.unwrap_err(), TOO_LARGE);
        assert!(
            read_file(allow.join("missing"))
                .await
                .unwrap_err()
                .starts_with("ENOENT:")
        );
        let route = AdminToolsRoute::new(vec![allow.to_string_lossy().into_owned()]);
        assert!(route.path_allowed(&format!("{}-prefix", allow.display())));
        assert!(!route.path_allowed("/unrelated"));
        let mut redis = fx.redis.clone();
        for (token, id) in [
            (&owner, WORKSPACE_OWNER_TWITCH_USER_ID),
            (&denied, other_id.as_str()),
        ] {
            let _: () = redis
                .hset_multiple(
                    token_cache_key(token),
                    &[
                        ("id", id),
                        ("login", "fixture"),
                        ("display_name", "Fixture"),
                    ],
                )
                .await
                .unwrap();
        }
        // Cold activity keys prove the real auth adapter reaches private Mongo and Redis.
        let other_key = dima_rust::api_auth::activity_touch_key(&other_id);
        let exists: bool = redis.exists(&owner_key).await.unwrap();
        assert!(!exists);
        let exists: bool = redis.exists(&other_key).await.unwrap();
        assert!(!exists);
        let users = fx.database.collection::<mongodb::bson::Document>("users");
        users.insert_many([
            mongodb::bson::doc! {"accounts": [{"id": WORKSPACE_OWNER_TWITCH_USER_ID, "type": "twitch"}]},
            mongodb::bson::doc! {"accounts": [{"id": &other_id, "type": "twitch"}]},
        ]).await.unwrap();
        assert!(AdminToolsRoute::default().path_allowed("/home/cdom/saas/dimabot/example"));
        assert!(!AdminToolsRoute::default().path_allowed("/tmp/disallowed"));
        assert!(route.path_allowed(&format!("{}\\text", allow.display())));
        let endpoint = support::closed_endpoint().await;
        let auth = AuthService::new(
            AuthConfig::new(&endpoint, &endpoint),
            reqwest::Client::new(),
            fx.redis.clone(),
            fx.database.collection("users"),
            None,
        )
        .unwrap();
        let app = support::serve_app(
            route
                .mounted_router(&auth)
                .merge(FileRoute::from_module_dir(&*dir).mounted_router()),
            "file-routes",
        )
        .await;
        let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(5)).build().unwrap();
        let url = |p: &str| support::app_url(app.addr, p);
        let unauth = client.get(url("/admin/read-file")).send().await.unwrap();
        assert_eq!(unauth.status(), 401);
        assert_eq!(unauth.json::<Value>().await.unwrap(), serde_json::json!({"error":true,"message":"No token provided","status":401,"type":"no_token"}));
        let exists: bool = redis.exists(&owner_key).await.unwrap(); assert!(!exists);
        let exists: bool = redis.exists(&other_key).await.unwrap(); assert!(!exists);
        let nonowner = client.get(url("/admin/read-file")).bearer_auth(&denied).send().await.unwrap();
        assert_eq!(nonowner.status(), 403);
        assert_eq!(nonowner.json::<Value>().await.unwrap(), serde_json::json!({"error":true,"message":"Admin workspace access required","status":403}));
        // Replay every source record against the real protected stack. Only paths differ.
        let source_root = fixture_dir.to_str().unwrap();
        let mut replayed = 0;
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let request = if name.starts_with("clip_") {
                let clip = if name == "clip_missing" {
                    "missing"
                } else if name == "clip_empty" {
                    "empty"
                } else {
                    "demo"
                };
                let mut request = client.get(url(&format!("/video/clip/{clip}")));
                if let Some(range) = match name {
                    "clip_first" => Some("bytes=0-0"),
                    "clip_middle" => Some("bytes=2-5"),
                    "clip_open" => Some("bytes=7-"),
                    "clip_last" => Some("bytes=9-9"),
                    "clip_outside" => Some("bytes=10-"),
                    _ => None,
                } {
                    request = request.header("range", range);
                }
                request
            } else {
                let mut request = client.get(url("/admin/read-file")).bearer_auth(&owner);
                let path = match name {
                    "admin_no_path" => None,
                    "admin_denied" => Some(dir.join("denied").to_string_lossy().into_owned()),
                    "admin_directory" => Some(allow.to_string_lossy().into_owned()),
                    "admin_prefix" => Some(
                        dir.join("allowed-sibling/text")
                            .to_string_lossy()
                            .into_owned(),
                    ),
                    "admin_traversal" => Some(format!("{}/../outside", allow.display())),
                    _ => Some(
                        allow
                            .join(name.strip_prefix("admin_").unwrap())
                            .to_string_lossy()
                            .into_owned(),
                    ),
                };
                if let Some(path) = path {
                    request = request.query(&[("path", path)]);
                }
                request
            };
            let response = request.send().await.unwrap();
            assert_eq!(
                response.status().as_u16(),
                case["status"].as_u64().unwrap() as u16,
                "{name}"
            );
            if name.starts_with("clip_") && response.status().is_success() {
                for header in [
                    "content-length",
                    "content-range",
                    "accept-ranges",
                    "content-type",
                ] {
                    assert_eq!(
                        response.headers().get(header).map(|v| v.to_str().unwrap()),
                        case["headers"][header].as_str(),
                        "{name} {header}"
                    );
                }
            }
            let bytes = response.bytes().await.unwrap();
            if case["body"].is_object() {
                let mut expected = case["body"].clone();
                fn replace_paths(value: &mut Value, from: &str, to: &str) {
                    match value {
                        Value::String(s) => *s = s.replace(from, to),
                        Value::Object(map) => {
                            for v in map.values_mut() {
                                replace_paths(v, from, to);
                            }
                        }
                        Value::Array(items) => {
                            for v in items {
                                replace_paths(v, from, to);
                            }
                        }
                        _ => {}
                    }
                }
                replace_paths(&mut expected, source_root, dir.to_str().unwrap());
                assert_eq!(
                    serde_json::from_slice::<Value>(&bytes).unwrap(),
                    expected,
                    "{name}"
                );
            } else {
                let actual: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
                assert_eq!(actual, case["body"].as_str().unwrap(), "{name}");
            }
            replayed += 1;
            println!("source replay {replayed}/20: {name}");
        }
        assert_eq!(replayed, 20);
        for id in [WORKSPACE_OWNER_TWITCH_USER_ID, other_id.as_str()] {
            let user = users.find_one(mongodb::bson::doc! {"accounts.id": id}).await.unwrap().unwrap();
            user.get_datetime("last_app_activity_at").unwrap();
            let key = dima_rust::api_auth::activity_touch_key(id);
            assert_eq!(redis.get::<_, String>(&key).await.unwrap(), "1");
            let ttl: i64 = redis.ttl(&key).await.unwrap();
            assert!(ttl > 0 && ttl <= 86400);
        }
        println!("real protected auth: 401/403 bodies; 2 Mongo activity updates and 2 Redis throttles");
        for (range, status) in [("bad", 400), ("bytes=2-99", 416), ("bytes=5-2", 416)] {
            assert_eq!(
                client
                    .get(url("/video/clip/demo"))
                    .header("range", range)
                    .send()
                    .await
                    .unwrap()
                    .status()
                    .as_u16(),
                status
            );
        }
        drop(app);
    })
    .catch_unwind()
    .await;
    // The constant owner id is not namespaced: remove its touch only if our
    // cold-auth value remains, while helper cleanup handles task-prefixed records.
    let mut redis = fx.redis.clone();
    let value: Option<String> = redis.get(&owner_key).await.unwrap();
    if value.as_deref() == Some("1") {
        let _: () = redis.del(&owner_key).await.unwrap();
    }
    fx.cleanup(&[owner, denied], &[other_id]).await;
    if let Err(payload) = outcome {
        std::panic::resume_unwind(payload);
    }
    cleanup(&dir);
}

// The real HTTP transport consumes the same stream adapter as the Tokio file.
// A gated reader makes the pending read and resource drop observable without
// relying on filesystem timing, large payloads, or production sleeps.
struct GatedReader {
    first: bool,
    gate: tokio::sync::oneshot::Receiver<()>,
    dropped: Option<tokio::sync::oneshot::Sender<()>>,
    fail: bool,
}
impl Drop for GatedReader {
    fn drop(&mut self) {
        if let Some(tx) = self.dropped.take() {
            let _ = tx.send(());
        }
    }
}
impl tokio::io::AsyncRead for GatedReader {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        if !self.first {
            self.first = true;
            buf.put_slice(b"abc");
            return std::task::Poll::Ready(Ok(()));
        }
        match std::future::Future::poll(std::pin::Pin::new(&mut self.gate), cx) {
            std::task::Poll::Pending => std::task::Poll::Pending,
            std::task::Poll::Ready(_) if self.fail => {
                std::task::Poll::Ready(Err(std::io::Error::other("controlled read error")))
            }
            std::task::Poll::Ready(_) => std::task::Poll::Ready(Ok(())),
        }
    }
}

#[tokio::test]
async fn controlled_stream_cancellation_and_failures() {
    use axum::{Router, http::header, routing::get};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    for mode in ["cancel", "error", "truncated"] {
        let (release, gate) = tokio::sync::oneshot::channel();
        let (dropped, drop_notice) = tokio::sync::oneshot::channel();
        let reader = Arc::new(Mutex::new(Some(GatedReader {
            first: false,
            gate,
            dropped: Some(dropped),
            fail: mode == "error",
        })));
        let app = Router::new()
            .route(
                "/stream",
                get({
                    let reader = reader.clone();
                    move || {
                        let reader = reader.lock().unwrap().take().unwrap();
                        async move {
                            (
                                [(header::CONTENT_LENGTH, "6")],
                                dima_rust::file_route::stream_body(reader, 6),
                            )
                        }
                    }
                }),
            )
            .route("/health", get(|| async { "ok" }));
        let server = support::serve_app(app, "file-stream").await;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        let mut response = tokio::time::timeout(
            Duration::from_secs(5),
            client.get(support::app_url(server.addr, "/stream")).send(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(response.status(), 200);
        let first = tokio::time::timeout(Duration::from_secs(5), response.chunk())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(&first[..], b"abc");
        if mode == "cancel" {
            drop(response);
        } else {
            release.send(()).unwrap();
            let result = tokio::time::timeout(Duration::from_secs(5), response.bytes())
                .await
                .unwrap();
            assert!(
                result.is_err(),
                "{mode} must terminate an incomplete response"
            );
        }
        let health = tokio::time::timeout(
            Duration::from_secs(5),
            client.get(support::app_url(server.addr, "/health")).send(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(health.text().await.unwrap(), "ok");
        tokio::time::timeout(Duration::from_secs(5), drop_notice)
            .await
            .expect("reader dropped")
            .unwrap();
        println!("controlled stream {mode}: response terminated, reader dropped, server serves");
    }
}

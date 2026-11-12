//! The `/data` volume is shared with the Node release this one would roll back to: the Rust
//! server must start on files the Node server wrote, and the reverse. Each test writes with one
//! implementation (accounts, a session, a connection with an encrypted password, the secret
//! file) and reads with the other: logins verify the scrypt hashes, the other side's cookie is
//! accepted, connection passwords decrypt, and the files keep their format.
//!
//! Needs `node` and `dimadb/server/node_modules`; skips with a message otherwise.

#![allow(
    clippy::expect_used,
    reason = "helpers of the tests below fail the test when a step fails"
)]

mod support;

use std::path::Path;
use std::process::Command;

use serde_json::{Value, json};
use support::{api, node_unavailable, scratch, start_node, start_rust};

const ADMIN_PASSWORD: &str = "pässwörd 🔑 ok";
const USER_PASSWORD: &str = "ユーザー-パスワード";
const REDIS_PASSWORD: &str = "s3cr@t:ü/🔒";

/// Writes through one server: setup, a second (user-role) account, a connection with a password.
/// Returns the admin's session cookie.
fn populate(port: u16) -> String {
    let setup = api(
        port,
        "POST",
        "/api/setup",
        None,
        Some(json!({ "username": "Root", "password": ADMIN_PASSWORD })),
    )
    .expect("setup answers");
    assert_eq!(setup.status, 200, "{:?}", setup.json());
    let cookie = setup.cookie();
    let user = api(
        port,
        "POST",
        "/api/users",
        Some(&cookie),
        Some(json!({ "username": "viewer", "password": USER_PASSWORD, "role": "user" })),
    )
    .expect("users answers");
    assert_eq!(user.status, 200, "{:?}", user.json());
    let encoded: String = url_encode(REDIS_PASSWORD);
    let added = api(port, "POST", "/api/connections", Some(&cookie), Some(json!({ "name": "cache 🧊", "url": format!("redis://:{encoded}@cache.internal:6380/3") })))
        .expect("connections answers");
    assert_eq!(added.status, 200, "{:?}", added.json());
    cookie
}

fn url_encode(text: &str) -> String {
    text.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// Reads through the other server: both logins, the old cookie, the connection list.
fn check(port: u16, old_cookie: &str) {
    let me = api(port, "GET", "/api/me", Some(old_cookie), None).expect("me answers");
    assert_eq!(
        me.status,
        200,
        "the other implementation's session cookie is accepted: {:?}",
        me.json()
    );
    assert_eq!(me.json()["data"]["user"]["username"], "root");

    let login = api(
        port,
        "POST",
        "/api/login",
        None,
        Some(json!({ "username": "root", "password": ADMIN_PASSWORD })),
    )
    .expect("login answers");
    assert_eq!(
        login.status,
        200,
        "admin password verifies: {:?}",
        login.json()
    );
    let viewer = api(
        port,
        "POST",
        "/api/login",
        None,
        Some(json!({ "username": "viewer", "password": USER_PASSWORD })),
    )
    .expect("login answers");
    assert_eq!(
        viewer.status,
        200,
        "user password verifies: {:?}",
        viewer.json()
    );
    assert_eq!(viewer.json()["data"]["user"]["role"], "user");
    let wrong = api(
        port,
        "POST",
        "/api/login",
        None,
        Some(json!({ "username": "root", "password": "nope-nope" })),
    )
    .expect("login answers");
    assert_eq!(wrong.status, 401);

    let list =
        api(port, "GET", "/api/connections", Some(&login.cookie()), None).expect("list answers");
    assert_eq!(
        list.status,
        200,
        "connection passwords decrypt: {:?}",
        list.json()
    );
    let rows = list.json()["data"].as_array().cloned().unwrap_or_default();
    let local = rows
        .iter()
        .find(|row| row["source"] == "local")
        .expect("the local row");
    assert_eq!(local["url"], "redis://:***@cache.internal:6380/3");
    assert_eq!(local["name"], "cache 🧊");
}

/// The stored password, decrypted by the Node reference's own `store.mjs`.
fn node_decrypt(data: &Path) -> String {
    let script = format!(
        "import {{ createStore }} from {store:?}; import {{ readFileSync }} from 'node:fs';\
         const rows = JSON.parse(readFileSync({file:?}, 'utf8'));\
         process.stdout.write(createStore({dir:?}).decrypt(rows[0].passwordEnc));",
        store = support::repo_root()
            .join("dimadb/server/store.mjs")
            .display()
            .to_string(),
        file = data.join("connections.json").display().to_string(),
        dir = data.display().to_string(),
    );
    let output = Command::new("node")
        .args(["--input-type=module", "-e", &script])
        .env_remove("DIMADB_SECRET")
        .output()
        .expect("node runs");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// The stored password, decrypted by the Rust store.
fn rust_decrypt(data: &Path) -> String {
    let rows: Value = serde_json::from_slice(
        &std::fs::read(data.join("connections.json")).expect("connections.json"),
    )
    .expect("JSON");
    let store =
        dimadb_server::store::Store::open(data, None, std::sync::Arc::new(dima_core::SystemRandom))
            .expect("store opens");
    store
        .decrypt(rows[0]["passwordEnc"].as_str().unwrap_or_default())
        .expect("decrypts")
}

/// The files both servers write: pretty JSON arrays with a trailing newline, a 0600 secret.
fn check_files(data: &Path) {
    use std::os::unix::fs::PermissionsExt as _;
    for name in ["users.json", "sessions.json", "connections.json"] {
        let text = std::fs::read_to_string(data.join(name)).expect("file exists");
        assert!(
            text.starts_with("[\n  {\n    \"id\": "),
            "{name} is JSON.stringify(rows, null, 2)"
        );
        assert!(text.ends_with("}\n]\n"), "{name} ends with a newline");
    }
    let secret = std::fs::read_to_string(data.join("secret")).expect("secret");
    assert_eq!(secret.len(), 65);
    let mode = std::fs::metadata(data.join("secret"))
        .expect("secret")
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn rust_starts_on_files_node_wrote() {
    if let Some(why) = node_unavailable() {
        eprintln!("SKIPPED rust_starts_on_files_node_wrote: {why}");
        return;
    }
    let data = scratch("node-to-rust");
    let public = scratch("public");
    let cookie = {
        let node = start_node(&data, &public, &[]).expect("node starts");
        let cookie = populate(node.port);
        node.terminate();
        cookie
    };
    check_files(&data);
    assert_eq!(rust_decrypt(&data), url_encode(REDIS_PASSWORD));
    let rust = start_rust(&data, &public, &[]).expect("rust starts on node's files");
    check(rust.port, &cookie);
    drop(rust);
    check_files(&data);
    let _ = std::fs::remove_dir_all(&data);
}

#[test]
fn node_starts_on_files_rust_wrote() {
    if let Some(why) = node_unavailable() {
        eprintln!("SKIPPED node_starts_on_files_rust_wrote: {why}");
        return;
    }
    let data = scratch("rust-to-node");
    let public = scratch("public");
    let cookie = {
        let rust = start_rust(&data, &public, &[]).expect("rust starts");
        let cookie = populate(rust.port);
        let status = rust.terminate().expect("rust stops on SIGTERM");
        assert!(status.success(), "graceful shutdown exits 0: {status:?}");
        cookie
    };
    check_files(&data);
    assert_eq!(node_decrypt(&data), url_encode(REDIS_PASSWORD));
    let node = start_node(&data, &public, &[]).expect("node starts on rust's files");
    check(node.port, &cookie);
    drop(node);
    let _ = std::fs::remove_dir_all(&data);
}

#[test]
fn an_environment_secret_is_shared_by_both() {
    if let Some(why) = node_unavailable() {
        eprintln!("SKIPPED an_environment_secret_is_shared_by_both: {why}");
        return;
    }
    let secret = [("DIMADB_SECRET", "  shared secret with spaces 🔑 ")];
    let data = scratch("env-secret");
    let public = scratch("public");
    let cookie = {
        let rust = start_rust(&data, &public, &secret).expect("rust starts");
        let cookie = populate(rust.port);
        drop(rust);
        cookie
    };
    assert!(
        !data.join("secret").exists(),
        "no secret file when DIMADB_SECRET is set"
    );
    let node = start_node(&data, &public, &secret).expect("node starts");
    check(node.port, &cookie);
    drop(node);
    let _ = std::fs::remove_dir_all(&data);
}

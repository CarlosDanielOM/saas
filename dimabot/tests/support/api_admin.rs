//! Task-owned support for `tests/api_admin.rs`.
//!
//! Everything here is disposable and loopback-only:
//! - an external source-oracle loader with an independently supplied SHA-256;
//! - a capture logger sink for the native `Logger` error mapping;
//! - a real loopback Axum app server;
//! - a task-owned MongoDB database derived from the driver fixture env.
//!
//! The admin middleware needs no cache, so no Redis resource is created. No
//! host networking, production service, credential or shared volume is used.

#![allow(dead_code)]

use axum::{Router, extract::Request, middleware::Next, response::Response};
use dima_rust::api_auth::AuthenticatedUser;
use dima_rust::utils::logger::{
    ConsoleRecord, ConsoleSink, Level, Logger, LoggerConfig, SinkFuture, SinkHandles, SystemClock,
    UuidSource,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::{net::TcpListener, task::JoinHandle};

/// Header the fixture identity layer reads instead of a real access token.
pub const FIXTURE_USER_HEADER: &str = "x-fixture-user";
/// Marker that inserts an authenticated identity with an empty id.
pub const EMPTY_USER_MARKER: &str = "-";

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Loads the externally written oracle and verifies its independent digest.
pub fn fixture() -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .expect("manifest directory");
    let workspace = root.parent().expect("workspace root").to_path_buf();
    let directory = PathBuf::from(
        std::env::var_os("DIMA_API_ADMIN_FIXTURE_DIR").expect("external fixture directory"),
    );
    assert!(
        directory.is_absolute(),
        "fixture directory must be absolute"
    );
    assert_eq!(
        directory.canonicalize().expect("fixture directory"),
        directory
    );
    assert!(
        !directory.starts_with(&workspace),
        "fixture must live outside the workspace"
    );
    let expected = std::env::var("DIMA_API_ADMIN_FIXTURE_SHA256").expect("fixture digest");
    assert!(
        expected.len() == 64
            && expected
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "fixture digest must be lowercase hex"
    );
    let file = directory.join("api-admin-reference.json");
    assert!(
        std::fs::symlink_metadata(&file)
            .expect("fixture metadata")
            .file_type()
            .is_file(),
        "fixture must be a regular file"
    );
    let bytes = std::fs::read(&file).expect("fixture bytes");
    assert_eq!(sha256_hex(&bytes), expected, "fixture digest mismatch");
    serde_json::from_slice(&bytes).expect("fixture JSON")
}

/// Cases of one fixture section, in source order.
pub fn cases<'a>(fixture: &'a Value, section: &str) -> &'a [Value] {
    fixture[section]
        .as_array()
        .unwrap_or_else(|| panic!("fixture section {section}"))
}

pub fn case_names<'a>(fixture: &'a Value, section: &str) -> Vec<&'a str> {
    cases(fixture, section)
        .iter()
        .map(|case| case["name"].as_str().expect("case name"))
        .collect()
}

pub fn find_case<'a>(fixture: &'a Value, section: &str, name: &str) -> &'a Value {
    cases(fixture, section)
        .iter()
        .find(|case| case["name"] == name)
        .unwrap_or_else(|| panic!("fixture case {section}.{name}"))
}

pub struct CaptureConsole {
    records: Mutex<Vec<Value>>,
}

impl CaptureConsole {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            records: Mutex::new(Vec::new()),
        })
    }

    pub fn records(&self) -> Vec<Value> {
        self.records
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn error_functions(&self) -> Vec<String> {
        self.records()
            .iter()
            .filter(|record| record["level"] == "error")
            .filter_map(|record| record["data"]["function"].as_str().map(str::to_owned))
            .collect()
    }
}

impl ConsoleSink for CaptureConsole {
    fn write(&self, record: ConsoleRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            let value: Value = serde_json::from_str(&record.json)
                .map_err(|_| dima_rust::utils::logger::SinkError::Rejected)?;
            self.records
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(value);
            Ok(())
        })
    }
}

/// Native logger with a capturing console sink and no cache sink.
pub fn capture_logger() -> (Logger, Arc<CaptureConsole>) {
    let console = CaptureConsole::new();
    let logger = Logger::new(
        LoggerConfig {
            min_level: Level::Trace,
            ..Default::default()
        },
        SinkHandles {
            console: Some(console.clone()),
            ..Default::default()
        },
        Arc::new(SystemClock),
        Arc::new(UuidSource),
    )
    .expect("logger configuration");
    (logger, console)
}

/// Serves a test router through a real loopback Axum HTTP server.
pub struct AppServer {
    pub addr: SocketAddr,
    handle: JoinHandle<()>,
}

pub async fn serve_app(app: Router<()>) -> AppServer {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("app listener");
    let addr = listener.local_addr().expect("app address");
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    AppServer { addr, handle }
}

impl Drop for AppServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// Test-owned stand-in for the already-ported authentication layer.
///
/// It inserts the concrete [`AuthenticatedUser`] the admin middleware reads, so
/// no token, Redis cache or Twitch provider is needed for this batch.
pub async fn fixture_identity(mut request: Request, next: Next) -> Response {
    if let Some(value) = request
        .headers()
        .get(FIXTURE_USER_HEADER)
        .and_then(|value| value.to_str().ok())
    {
        let id = if value == EMPTY_USER_MARKER {
            String::new()
        } else {
            value.to_owned()
        };
        request.extensions_mut().insert(AuthenticatedUser {
            id,
            login: "fixture".to_owned(),
            display_name: "Fixture".to_owned(),
            profile_image_url: None,
        });
    }
    next.run(request).await
}

pub fn app_url(addr: SocketAddr, path: &str) -> String {
    format!("http://{addr}{path}")
}

/// GET with an optional fixture identity; `""` means an empty id.
pub async fn get_as(client: &reqwest::Client, url: &str, user_id: Option<&str>) -> (u16, Value) {
    let mut request = client.get(url);
    if let Some(user_id) = user_id {
        let value = if user_id.is_empty() {
            EMPTY_USER_MARKER.to_owned()
        } else {
            user_id.to_owned()
        };
        request = request.header(FIXTURE_USER_HEADER, value);
    }
    let response = request.send().await.expect("app response");
    let status = response.status().as_u16();
    let bytes = response.bytes().await.expect("app body");
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, body)
}

/// Task-owned MongoDB namespace derived from the driver fixture env.
pub struct Fixtures {
    pub database: mongodb::Database,
    pub mongo_client: mongodb::Client,
    pub stem: String,
}

pub async fn fixtures(suffix: &str) -> Fixtures {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER")
            .as_deref()
            .ok(),
        Some("dimabot-migration"),
        "task-owned fixture owner marker"
    );
    let mongo_uri = std::env::var("KEYWORD_FIXTURE_MONGO_URI").expect("fixture Mongo URI");
    let namespace = std::env::var("KEYWORD_FIXTURE_NAMESPACE").expect("fixture namespace");
    assert_eq!(mongo_uri, "mongodb://keyword-mongo:27017");
    let namespace_id = namespace
        .strip_prefix("keyword-fixture-")
        .and_then(|value| value.strip_suffix(':'))
        .expect("driver-owned fixture namespace");
    assert_eq!(namespace_id.len(), 12);
    assert!(namespace_id.bytes().all(|value| value.is_ascii_hexdigit()));
    let alphanumeric: String = namespace
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let hex = alphanumeric.trim_start_matches("keywordfixture").to_owned();
    assert!(!hex.is_empty(), "fixture namespace must carry an id");
    let clean = suffix.replace(|c: char| !c.is_ascii_alphanumeric(), "");
    let mongo_client = mongodb::Client::with_uri_str(mongo_uri)
        .await
        .expect("fixture Mongo client");
    let database = mongo_client.database(&format!("api_admin_{hex}_{clean}"));
    assert!(
        database
            .list_collection_names()
            .await
            .expect("empty fixture database")
            .is_empty()
    );
    database
        .collection::<mongodb::bson::Document>("_owner")
        .insert_one(mongodb::bson::doc! {"_id": &namespace, "owner": "dimabot-migration"})
        .await
        .expect("fixture ownership");
    Fixtures {
        database,
        mongo_client,
        stem: format!("api-admin-{hex}-{clean}"),
    }
}

impl Fixtures {
    /// The native `admins` collection the production schema names.
    pub fn admins(&self) -> mongodb::Collection<mongodb::bson::Document> {
        self.database.collection("admins")
    }

    /// Inserts the oracle's admin rows verbatim into the task-owned database.
    pub async fn seed_admins(&self, rows: &[Value]) {
        let documents: Vec<mongodb::bson::Document> = rows
            .iter()
            .map(|row| mongodb::bson::serialize_to_document(row).expect("admin row document"))
            .collect();
        if documents.is_empty() {
            return;
        }
        self.admins()
            .insert_many(documents)
            .await
            .expect("seed admin rows");
    }

    pub fn admin_name(&self, suffix: &str) -> String {
        format!("{}-admin-{suffix}", self.stem)
    }

    pub fn channel_name(&self, suffix: &str) -> String {
        format!("{}-channel-{suffix}", self.stem)
    }

    /// Removes only this task's database.
    pub async fn cleanup(&self) {
        let owner = self
            .database
            .collection::<mongodb::bson::Document>("_owner")
            .find_one(mongodb::bson::doc! {"owner": "dimabot-migration"})
            .await
            .expect("fixture owner lookup");
        assert!(owner.is_some(), "fixture ownership missing");
        self.database
            .drop()
            .await
            .expect("fixture database cleanup");
    }
}

/// A loopback URL whose listener was closed again, so connections are refused.
pub async fn closed_endpoint() -> String {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("ephemeral listener");
    let addr = listener.local_addr().expect("ephemeral address");
    drop(listener);
    format!("http://{addr}")
}

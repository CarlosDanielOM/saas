//! Digest-checked source fixture and task-owned loopback Helix recorder.
#![allow(dead_code)]
use axum::{
    Json, Router,
    extract::{Request, State},
    routing::{get, post},
};
use dima_rust::utils::twitch::{
    AccessToken, TokenFuture, TokenSource, TokenSourceError, TwitchAuth,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::{net::TcpListener, task::JoinHandle};

pub fn fixture() -> Value {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .expect("manifest directory")
        .parent()
        .expect("workspace root")
        .to_path_buf();
    let directory = PathBuf::from(
        std::env::var_os("DIMA_SITE_ANALYTICS_FIXTURE_DIR")
            .expect("external source fixture directory"),
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
        "fixture must live outside workspace"
    );
    let expected = std::env::var("DIMA_SITE_ANALYTICS_FIXTURE_SHA256").expect("fixture digest");
    assert!(
        expected.len() == 64
            && expected
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "lowercase SHA-256 required"
    );
    let file = directory.join("site-analytics-reference.json");
    assert!(
        std::fs::symlink_metadata(&file)
            .expect("fixture metadata")
            .file_type()
            .is_file()
    );
    let bytes = std::fs::read(file).expect("fixture bytes");
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        expected,
        "fixture digest mismatch"
    );
    let fixture: Value = serde_json::from_slice(&bytes).expect("fixture JSON");
    assert_eq!(
        fixture_case_names(&fixture),
        vec![
            "root",
            "create",
            "duplicate",
            "missing",
            "bad-tier",
            "bad-label",
            "list",
            "get",
            "get-missing",
            "patch",
            "patch-invalid",
            "patch-missing",
            "patch-malformed"
        ],
        "all 13 ordered route cases required"
    );
    for case in fixture["cases"].as_array().expect("cases") {
        assert!(
            case["request"]["method"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        );
        assert!(
            case["request"]["path"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        );
        assert!(case["expected"]["status"].as_u64().is_some());
        assert!(case["expected"].get("body").is_some());
    }
    assert_eq!(
        fixture["schemaCases"]
            .as_array()
            .expect("schema cases")
            .iter()
            .map(|c| c["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![
            "empty-mixed",
            "defaults",
            "casting",
            "generated-id-showif",
            "missing-condition",
            "missing-nested-description",
            "missing-showif",
            "invalid-enum",
            "null-config"
        ],
        "exact constructor inventory"
    );
    for (key, expected) in [
        ("patchCases", PATCH_CASES),
        ("operatorCases", &PATCH_CASES[6..]),
    ] {
        let cases = fixture[key].as_array().expect("nonempty operator cases");
        assert_eq!(
            cases
                .iter()
                .map(|c| c["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            expected,
            "exact ordered inventory {key}"
        );
        for case in cases {
            assert!(case.get("input").is_some());
            assert!(case.get("expected").is_some());
        }
    }
    fixture
}
pub fn fixture_case<'a>(fixture: &'a Value, name: &str) -> &'a Value {
    fixture["cases"]
        .as_array()
        .expect("cases array")
        .iter()
        .find(|case| case["name"] == name)
        .unwrap_or_else(|| panic!("fixture case {name}"))
        .get("expected")
        .expect("expected")
}
pub fn fixture_case_names(fixture: &Value) -> Vec<String> {
    fixture["cases"]
        .as_array()
        .expect("cases array")
        .iter()
        .map(|case| case["name"].as_str().expect("name").to_owned())
        .collect()
}
pub fn assert_case(fixture: &Value, name: &str, status: u16, body: &Value) {
    let expected = fixture_case(fixture, name);
    assert_eq!(
        expected["status"].as_u64(),
        Some(u64::from(status)),
        "{name}: status"
    );
    assert_eq!(body, &expected["body"], "{name}: body");
}

#[derive(Clone)]
pub struct HelixReply {
    pub status: u16,
    pub body: Value,
}
#[derive(Default)]
struct HelixState {
    replies: Mutex<VecDeque<HelixReply>>,
    requests: Mutex<Vec<String>>,
}
pub struct HelixRecorder {
    pub addr: SocketAddr,
    state: Arc<HelixState>,
    task: JoinHandle<()>,
}
impl HelixRecorder {
    pub async fn start(replies: Vec<HelixReply>) -> Self {
        let state = Arc::new(HelixState {
            replies: Mutex::new(replies.into()),
            requests: Mutex::new(Vec::new()),
        });
        let app = Router::new()
            .route("/oauth/token", post(reply))
            .route("/helix/streams", get(reply))
            .route("/helix/users", get(reply))
            .with_state(state.clone());
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("loopback recorder");
        let addr = listener.local_addr().expect("recorder address");
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self { addr, state, task }
    }
    pub fn base_url(&self) -> String {
        format!("http://{}/helix/", self.addr)
    }
    pub fn requests(&self) -> Vec<String> {
        self.state
            .requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}
impl Drop for HelixRecorder {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn reply(
    State(state): State<Arc<HelixState>>,
    request: Request,
) -> (axum::http::StatusCode, Json<Value>) {
    state
        .requests
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(request.uri().to_string());
    let response = state
        .replies
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .pop_front();
    match response {
        Some(reply) => (
            axum::http::StatusCode::from_u16(reply.status)
                .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR),
            Json(reply.body),
        ),
        None => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({})),
        ),
    }
}
pub struct FixedAppToken;
impl TokenSource for FixedAppToken {
    fn token<'a>(&'a self, auth: &'a TwitchAuth) -> TokenFuture<'a> {
        Box::pin(async move {
            if matches!(auth, TwitchAuth::App) {
                Ok(AccessToken::app("fixture-app-token"))
            } else {
                Err(TokenSourceError::Missing)
            }
        })
    }
}

pub const PATCH_CASES: &[&str] = &[
    "trim-number-bool",
    "no-validation",
    "nested",
    "dotted",
    "cast-error",
    "null",
    "push-one",
    "push-each",
    "add-one",
    "add-each",
    "push-array",
    "pull-id",
    "pull-in",
    "pull-rel",
    "pull-logical",
    "pull-all",
    "pull-mixed",
    "numeric-path",
    "positional",
    "all-positional",
    "array-id",
    "unknown-path",
    "inc",
    "mul",
    "min-max",
    "bit",
    "bit-mixed",
    "unset",
    "rename",
    "current-date",
    "pop",
    "id-version",
    "nested-dotted",
    "no-validator-hook",
    "inc-error",
    "push-error",
    "rename-error",
    "pop-error",
    "pull-error",
    "nested-set",
    "setoninsert",
    "current-date-false",
    "numeric-label",
    "mixed-nested",
    "mixed-config",
    "pull-unknown",
    "pull-exists",
    "pull-showif",
    "inc-null",
    "id-change",
    "id-invalid",
];

pub fn seed_document(value: &Value) -> mongodb::bson::Document {
    use mongodb::bson::{Bson, DateTime, oid::ObjectId};
    fn convert(key: &str, value: &Value) -> Bson {
        match value {
            Value::Object(fields) => Bson::Document(
                fields
                    .iter()
                    .map(|(k, v)| (k.clone(), convert(k, v)))
                    .collect(),
            ),
            Value::Array(values) => Bson::Array(values.iter().map(|v| convert("", v)).collect()),
            Value::String(s) if key == "_id" => Bson::ObjectId(ObjectId::parse_str(s).unwrap()),
            Value::String(s) if key == "createdAt" || key == "updatedAt" => {
                Bson::DateTime(DateTime::parse_rfc3339_str(s).unwrap())
            }
            other => mongodb::bson::serialize_to_bson(other).unwrap(),
        }
    }
    convert("", value).as_document().unwrap().clone()
}

/// Keep caller/seed IDs and dates exact; normalize only generated values.
pub fn normalize_operator_value(value: &mut Value, case: &Value) {
    fn collect(v: &Value, known: &mut std::collections::HashSet<String>) {
        match v {
            Value::String(s) => {
                known.insert(s.clone());
            }
            Value::Object(m) => {
                for v in m.values() {
                    collect(v, known);
                }
            }
            Value::Array(a) => {
                for v in a {
                    collect(v, known);
                }
            }
            _ => {}
        }
    }
    fn normalize(v: &mut Value, known: &std::collections::HashSet<String>) {
        match v {
            Value::String(s) if !known.contains(s) => {
                if s.len() == 24 && s.bytes().all(|b| b.is_ascii_hexdigit()) {
                    *s = "<object-id>".into();
                } else if s.len() >= 20 && s.as_bytes().get(10) == Some(&b'T') && s.ends_with('Z') {
                    *s = "<date>".into();
                }
            }
            Value::Object(m) => {
                for v in m.values_mut() {
                    normalize(v, known);
                }
            }
            Value::Array(a) => {
                for v in a {
                    normalize(v, known);
                }
            }
            _ => {}
        }
    }
    let mut known = std::collections::HashSet::new();
    collect(&case["seed"], &mut known);
    collect(&case["input"], &mut known);
    normalize(value, &known);
}

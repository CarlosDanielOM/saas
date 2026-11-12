//! A stateful Twitch for the Rust-only EventSub tests, the same as the recorder's `FakeTwitch`:
//! subscriptions with ids `sub-0001`..., 409 for a second one with the same type, version,
//! condition and callback, pages of `page_size`, 204 / 404 deletes, and scripted answers that
//! take precedence.
#![allow(dead_code, clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use dima_http::testing::{MockResponse, RecordedRequest};
use serde_json::{Map, Value, json};
use std::sync::{Arc, Mutex};

/// A scripted answer for the `n`-th Helix request (0-based), or `None` to let the fake answer.
pub type Script = Box<dyn Fn(&RecordedRequest, usize) -> Option<MockResponse> + Send + Sync>;

/// The fake's state.
pub struct FakeState {
    pub subs: Vec<Map<String, Value>>,
    pub next: u32,
    pub page_size: usize,
    pub status: String,
    pub cost: i64,
    pub now_ms: i64,
    pub served: usize,
    pub script: Option<Script>,
}

/// The shared fake.
#[derive(Clone)]
pub struct FakeTwitch(pub Arc<Mutex<FakeState>>);

fn iso(ms: i64, nanos: u32) -> String {
    let text = dima_text::to_iso_string(ms).unwrap_or_default();
    let seconds = text.get(..19).unwrap_or_default();
    format!("{seconds}.{nanos:09}Z")
}

fn key(sub: &Map<String, Value>) -> String {
    let mut condition: Vec<(String, Value)> = sub
        .get("condition")
        .and_then(Value::as_object)
        .map(|c| {
            c.iter()
                .filter(|(_, v)| !v.is_null() && v.as_str() != Some(""))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default();
    condition.sort_by(|a, b| a.0.cmp(&b.0));
    format!(
        "{}|{}|{:?}|{}",
        sub.get("type").and_then(Value::as_str).unwrap_or_default(),
        sub.get("version")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        condition,
        sub.get("transport")
            .and_then(|t| t.get("callback"))
            .and_then(Value::as_str)
            .unwrap_or_default()
    )
}

impl FakeTwitch {
    pub fn new(now_ms: i64) -> Self {
        Self(Arc::new(Mutex::new(FakeState {
            subs: Vec::new(),
            next: 1,
            page_size: 100,
            status: "webhook_callback_verification_pending".into(),
            cost: 1,
            now_ms,
            served: 0,
            script: None,
        })))
    }

    pub fn lock(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.0.lock().expect("fake")
    }

    /// Adds a subscription as Twitch would list it.
    pub fn create(&self, body: &Value, status: &str) -> Map<String, Value> {
        let mut state = self.lock();
        state.create(body, status)
    }

    /// The subscriptions now.
    pub fn subs(&self) -> Vec<Map<String, Value>> {
        self.lock().subs.clone()
    }

    pub fn script(&self, script: Script) {
        self.lock().script = Some(script);
    }

    /// The mock's Helix handler.
    pub fn handle(&self, request: &RecordedRequest) -> MockResponse {
        let mut state = self.lock();
        let n = state.served;
        state.served += 1;
        if let Some(script) = &state.script
            && let Some(answer) = script(request, n)
        {
            return answer;
        }
        state.answer(request)
    }
}

impl FakeState {
    fn create(&mut self, body: &Value, status: &str) -> Map<String, Value> {
        let kind = body["type"].as_str().unwrap_or_default();
        let condition = if kind == "channel.raid" {
            json!({
                "from_broadcaster_user_id": body["condition"]["from_broadcaster_user_id"].as_str().unwrap_or(""),
                "to_broadcaster_user_id": body["condition"]["to_broadcaster_user_id"].as_str().unwrap_or(""),
            })
        } else {
            body["condition"].clone()
        };
        let n = self.next;
        let sub = json!({
            "id": format!("sub-{n:04}"),
            "status": status,
            "type": kind,
            "version": body["version"],
            "condition": condition,
            "created_at": iso(self.now_ms, n * 1000),
            "transport": {
                "method": body["transport"]["method"].as_str().unwrap_or("webhook"),
                "callback": body["transport"]["callback"].as_str().unwrap_or(""),
            },
            "cost": self.cost,
        });
        self.next += 1;
        let sub = match sub {
            Value::Object(sub) => sub,
            _ => Map::new(),
        };
        self.subs.push(sub.clone());
        sub
    }

    fn totals(&self) -> Map<String, Value> {
        let cost: i64 = self
            .subs
            .iter()
            .map(|s| s.get("cost").and_then(Value::as_i64).unwrap_or(0))
            .sum();
        let mut map = Map::new();
        map.insert("total".into(), json!(self.subs.len()));
        map.insert("total_cost".into(), json!(cost));
        map.insert("max_total_cost".into(), json!(10000));
        map
    }

    fn answer(&mut self, request: &RecordedRequest) -> MockResponse {
        if request.path() != "/helix/eventsub/subscriptions" {
            return MockResponse::json(404, r#"{"error":"Not Found","status":404,"message":""}"#);
        }
        let query: Vec<(String, String)> =
            url::form_urlencoded::parse(request.query().unwrap_or_default().as_bytes())
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
        let param = |name: &str| {
            query
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone())
        };
        match request.method.as_str() {
            "POST" => {
                let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
                let probe = body.as_object().cloned().unwrap_or_default();
                if self.subs.iter().any(|sub| key(sub) == key(&probe)) {
                    return MockResponse::json(
                        409,
                        r#"{"error":"Conflict","status":409,"message":"subscription already exists"}"#,
                    );
                }
                let status = self.status.clone();
                let sub = self.create(&body, &status);
                let mut page = Map::new();
                page.insert("data".into(), Value::Array(vec![Value::Object(sub)]));
                page.extend(self.totals());
                MockResponse::json(202, &Value::Object(page).to_string())
            }
            "DELETE" => {
                let id = param("id").unwrap_or_default();
                match self
                    .subs
                    .iter()
                    .position(|sub| sub.get("id").and_then(Value::as_str) == Some(id.as_str()))
                {
                    Some(index) => {
                        self.subs.remove(index);
                        MockResponse::new(204)
                    }
                    None => MockResponse::json(
                        404,
                        r#"{"error":"Not Found","status":404,"message":"subscription not found"}"#,
                    ),
                }
            }
            "GET" => {
                let user = param("user_id");
                let first: usize = param("first").and_then(|f| f.parse().ok()).unwrap_or(20);
                let after: usize = param("after")
                    .and_then(|a| a.strip_prefix("cursor-").and_then(|n| n.parse().ok()))
                    .unwrap_or(0);
                let listed: Vec<&Map<String, Value>> = self
                    .subs
                    .iter()
                    .filter(|sub| {
                        user.as_ref().is_none_or(|user| {
                            sub.get("condition")
                                .and_then(Value::as_object)
                                .is_some_and(|c| c.values().any(|v| v.as_str() == Some(user)))
                        })
                    })
                    .collect();
                let size = first.min(self.page_size);
                let page: Vec<Value> = listed
                    .iter()
                    .skip(after)
                    .take(size)
                    .map(|sub| Value::Object((*sub).clone()))
                    .collect();
                let more = after + size < listed.len();
                let mut body = Map::new();
                body.insert("data".into(), Value::Array(page));
                body.extend(self.totals());
                body.insert(
                    "pagination".into(),
                    if more {
                        json!({"cursor": format!("cursor-{}", after + size)})
                    } else {
                        json!({})
                    },
                );
                MockResponse::json(200, &Value::Object(body).to_string())
            }
            _ => MockResponse::json(405, r#"{"error":"Method Not Allowed","status":405}"#),
        }
    }
}

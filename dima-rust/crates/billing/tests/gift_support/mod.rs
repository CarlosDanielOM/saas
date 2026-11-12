//! Harness of the gift, referral, reward and cancellation tests: a Polar mock that replays a
//! recording, a stateful Polar world for the once-only, kill and abuse tests (with lost answers
//! after a commit), the contexts, and fixtures.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use bson::oid::ObjectId;
use bson::{Bson, Document, doc};
use dima_billing::config::PolarConfig;
use dima_billing::polar::PolarClient;
use dima_core::{ManualClock, SecretString, SeededRandom};
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer, RecordedRequest};
use dima_store::mongo::MongoStore;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

/// The token the recordings were made with.
pub const TOKEN: &str = "rec-polar-token";
/// `AI_CREDITS_METER_ID`.
pub const METER: &str = "5103e79b-fd74-4ba8-a287-f95574f9addf";

/// A Polar client on `server`.
pub fn polar(server: &MockServer) -> PolarClient {
    let provider = server
        .provider(PolarClient::provider(&PolarConfig::default()))
        .unwrap();
    let http = HttpClient::builder().build().unwrap();
    PolarClient::new(http, provider, Some(SecretString::from(TOKEN)))
}

/// A request as the recordings hold it: method, target, the headers that matter, the body
/// parsed (`None` without one).
#[derive(Clone, Debug, PartialEq)]
pub struct Sent {
    pub method: String,
    pub target: String,
    pub authorization: Option<String>,
    pub content_type: Option<String>,
    pub idempotency_key: Option<String>,
    pub body: Option<Value>,
}

impl Sent {
    pub fn of(request: &RecordedRequest) -> Self {
        Self {
            method: request.method.clone(),
            target: request.target.clone(),
            authorization: request.header("authorization").map(str::to_owned),
            content_type: request.header("content-type").map(str::to_owned),
            idempotency_key: request.header("idempotency-key").map(str::to_owned),
            body: (!request.body.is_empty())
                .then(|| serde_json::from_slice(&request.body).unwrap()),
        }
    }

    pub fn recorded(exchange: &Value) -> Self {
        let header = |name: &str| exchange["headers"][name].as_str().map(str::to_owned);
        Self {
            method: exchange["method"].as_str().unwrap().to_owned(),
            target: exchange["target"].as_str().unwrap().to_owned(),
            authorization: header("authorization"),
            content_type: header("content-type"),
            idempotency_key: header("idempotency-key"),
            body: exchange["body"]
                .as_str()
                .map(|text| serde_json::from_str(text).unwrap()),
        }
    }
}

/// Replays recorded answers: each request takes the first unused recorded exchange with the
/// same method, target and body; anything else is a 501 (a request the reference did not make).
#[derive(Clone, Default)]
pub struct Replay {
    pending: Arc<Mutex<Vec<(Sent, u16, String)>>>,
}

impl Replay {
    pub fn install(&self, server: &MockServer) {
        let pending = Arc::clone(&self.pending);
        server.fallback(move |request| {
            let sent = Sent::of(request);
            let mut pending = pending.lock().unwrap();
            let found = pending.iter().position(|(recorded, _, _)| {
                recorded.method == sent.method
                    && recorded.target == sent.target
                    && recorded.body == sent.body
            });
            match found {
                Some(index) => {
                    let (_, status, body) = pending.remove(index);
                    MockResponse::json(status, &body)
                }
                None => MockResponse::json(501, r#"{"detail":"not recorded"}"#),
            }
        });
    }

    /// Loads one step's exchanges.
    pub fn load(&self, exchanges: &[Value]) {
        let mut pending = self.pending.lock().unwrap();
        pending.clear();
        for exchange in exchanges {
            pending.push((
                Sent::recorded(exchange),
                u16::try_from(exchange["status"].as_u64().unwrap()).unwrap(),
                exchange["response"].as_str().unwrap().to_owned(),
            ));
        }
    }

    /// Exchanges not asked for.
    pub fn unused(&self) -> Vec<Sent> {
        self.pending
            .lock()
            .unwrap()
            .iter()
            .map(|(sent, _, _)| sent.clone())
            .collect()
    }
}

/// Canonical extended JSON with every object's keys sorted (an upsert's key order varies).
pub fn sorted(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().cloned().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|k| (k.clone(), sorted(&map[&k])))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

/// Every document of `collection`, by `_id`, as canonical extended JSON.
pub async fn snapshot(store: &MongoStore, collection: &str) -> Vec<Value> {
    use futures_util::TryStreamExt;
    let documents: Vec<Document> = store
        .documents(collection)
        .find(doc! {})
        .sort(doc! { "_id": 1 })
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap();
    documents
        .into_iter()
        .map(|d| Bson::Document(d).into_canonical_extjson())
        .collect()
}

/// Inserts canonical-EJSON documents as they are.
pub async fn insert_ejson(store: &MongoStore, collection: &str, documents: &[Value]) {
    for document in documents {
        let Bson::Document(document) = Bson::try_from(document.clone()).unwrap() else {
            panic!("not a document");
        };
        store
            .documents(collection)
            .insert_one(document)
            .await
            .unwrap();
    }
}

/// A fixed clock and a seeded random source.
pub fn clock(now: i64) -> ManualClock {
    ManualClock::new(now)
}

pub fn random() -> SeededRandom {
    SeededRandom::new(7)
}

// ------------------------------------------------------------------ the stateful Polar world

/// The gift packs as the world sells them.
pub const PAIRS: [(&str, &str, u32, u32, &str); 3] = [
    (
        "6e0c530d-affc-44be-a51b-e11453ef1fa7",
        "f14a61f4-a572-4c05-bf4e-1b013d0dc77a",
        40_000,
        999,
        "ben_40k",
    ),
    (
        "815d0efe-1d23-4fca-8762-ae3a9253b0bc",
        "019b6291-80a0-4b31-bb09-feaaa9afe5eb",
        250_000,
        4999,
        "ben_250k",
    ),
    (
        "7d0d5f0e-102a-4255-abf3-6f379e2da4ce",
        "3f6010b6-4108-4bf9-ab83-b035eeed6962",
        550_000,
        9999,
        "ben_550k",
    ),
];

/// A fault to inject on the next request matching `method` and a path prefix.
#[derive(Clone, Debug)]
pub enum Fault {
    /// Commit the request, then drop the connection (a lost answer).
    LoseAnswerAfterCommit,
    /// Commit, then answer 200 with a body that is not JSON.
    GarbleAnswerAfterCommit,
    /// Do not commit; answer this status.
    Status(u16),
}

/// Polar's state: customers, checkouts, orders, grants, subscriptions, and what it was asked.
#[derive(Default)]
pub struct WorldState {
    pub customers: Vec<(String, String)>,
    pub deleted: HashSet<String>,
    pub checkouts: Vec<Value>,
    pub orders: Vec<Value>,
    pub grants: Vec<Value>,
    pub subscriptions: Vec<Value>,
    pub revoke_fails: HashSet<String>,
    pub requests: Vec<Sent>,
    pub faults: Vec<(String, String, Fault)>,
    pub counter: u32,
    pub idempotency: Vec<(String, Value)>,
    pub honour_idempotency: bool,
}

/// A stateful Polar mock shared with a [`MockServer`] handler.
#[derive(Clone, Default)]
pub struct World {
    pub state: Arc<Mutex<WorldState>>,
}

fn product(id: &str) -> Option<Value> {
    let (paid, free, credits, price, benefit) =
        PAIRS.iter().find(|(p, f, ..)| *p == id || *f == id)?;
    let is_free = *free == id;
    Some(json!({
        "id": id,
        "name": if is_free { "Gift delivery".to_owned() } else { format!(" Gift {credits} ") },
        "is_archived": false, "is_recurring": false, "visibility": "public",
        "prices": [{ "type": "one_time", "amount_type": "fixed",
            "price_amount": if is_free { 0 } else { *price }, "price_currency": if is_free { "usd" } else { "USD" }, "is_archived": false }],
        "benefits": if is_free { json!([{ "id": benefit, "type": "meter_credit", "is_deleted": false,
            "properties": { "units": credits, "rollover": true, "meter_id": METER } }]) } else { json!([]) },
        "_paid": paid,
    }))
}

impl World {
    pub fn new(customers: &[(&str, &str)]) -> Self {
        let world = Self::default();
        world.state.lock().unwrap().customers = customers
            .iter()
            .map(|(c, u)| ((*c).to_owned(), (*u).to_owned()))
            .collect();
        world
    }

    pub fn install(&self, server: &MockServer) {
        let world = self.clone();
        server.fallback(move |request| world.answer(request));
    }

    pub fn fault(&self, method: &str, prefix: &str, fault: Fault) {
        self.state
            .lock()
            .unwrap()
            .faults
            .push((method.to_owned(), prefix.to_owned(), fault));
    }

    pub fn requests(&self) -> Vec<Sent> {
        self.state.lock().unwrap().requests.clone()
    }

    pub fn count(&self, method: &str, target_prefix: &str) -> usize {
        self.requests()
            .iter()
            .filter(|r| r.method == method && r.target.starts_with(target_prefix))
            .count()
    }

    /// The buyer pays the checkout of `gift_id` (an order appears).
    pub fn pay(&self, gift_id: &str) -> Value {
        let mut state = self.state.lock().unwrap();
        let index = state
            .checkouts
            .iter()
            .position(|c| {
                c["metadata"]["gift_id"] == gift_id
                    && c["metadata"]["source"] == "dimabot_gift_purchase"
            })
            .unwrap();
        make_order(&mut state, index)
    }

    pub fn grants_for(&self, customer: &str) -> usize {
        self.state
            .lock()
            .unwrap()
            .grants
            .iter()
            .filter(|g| g["customer_id"] == customer)
            .count()
    }

    pub fn checkouts_for_gift(&self, gift_id: &str, source: &str) -> usize {
        self.state
            .lock()
            .unwrap()
            .checkouts
            .iter()
            .filter(|c| c["metadata"]["gift_id"] == gift_id && c["metadata"]["source"] == source)
            .count()
    }

    fn answer(&self, request: &RecordedRequest) -> MockResponse {
        let sent = Sent::of(request);
        let mut state = self.state.lock().unwrap();
        state.requests.push(sent.clone());
        let fault = state
            .faults
            .iter()
            .position(|(m, p, _)| *m == sent.method && sent.target.starts_with(p.as_str()))
            .map(|i| state.faults.remove(i).2);
        if let Some(Fault::Status(status)) = fault {
            return MockResponse::json(status, r#"{"detail":"injected"}"#);
        }
        let (status, body) = route(&mut state, &sent);
        match fault {
            Some(Fault::LoseAnswerAfterCommit) => MockResponse::drop_connection(),
            Some(Fault::GarbleAnswerAfterCommit) => MockResponse::json(200, "<html>"),
            _ => MockResponse::json(status, &body.to_string()),
        }
    }
}

fn make_order(state: &mut WorldState, index: usize) -> Value {
    state.counter += 1;
    let checkout = state.checkouts[index].clone();
    let order = json!({
        "id": format!("ord_{}", state.counter), "paid": true, "status": "paid",
        "product_id": checkout["product_id"], "checkout_id": checkout["id"], "subscription_id": null,
        "customer_id": checkout["customer_id"],
        "customer": { "id": checkout["customer_id"], "external_id": checkout["customer_external_id"] },
        "net_amount": checkout["total_amount"], "total_amount": checkout["total_amount"],
        "discount_amount": 0, "refunded_amount": 0, "currency": "usd", "metadata": checkout["metadata"],
    });
    state.orders.push(order.clone());
    state.checkouts[index]["status"] = json!("succeeded");
    order
}

fn page(items: Vec<Value>) -> Value {
    json!({ "items": items, "pagination": { "total_count": items.len(), "max_page": 1 } })
}

fn query(target: &str) -> Vec<(String, String)> {
    target
        .split_once('?')
        .map(|(_, q)| {
            url::form_urlencoded::parse(q.as_bytes())
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect()
        })
        .unwrap_or_default()
}

fn route(state: &mut WorldState, sent: &Sent) -> (u16, Value) {
    let path = sent.target.split('?').next().unwrap_or_default().to_owned();
    let q = query(&sent.target);
    let param = |k: &str| q.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    match (sent.method.as_str(), segments.as_slice()) {
        ("GET", ["v1", "products", id]) => product(id).map_or((404, json!({})), |p| (200, p)),
        ("GET", ["v1", "customers", id, "state"]) => {
            let credited: f64 = state
                .grants
                .iter()
                .filter(|g| g["customer_id"] == *id)
                .map(|g| g["benefit"]["properties"]["units"].as_f64().unwrap())
                .sum();
            (
                200,
                json!({ "id": id, "active_meters": [{ "meter_id": METER, "consumed_units": 120,
                "credited_units": credited, "balance": credited - 120.0 }] }),
            )
        }
        ("GET", ["v1", "customers", id]) => match state.customers.iter().find(|(c, _)| c == id) {
            Some((c, user)) => (
                200,
                json!({ "id": c, "external_id": user,
                "deleted_at": if state.deleted.contains(*id) { json!("2026-11-12T00:00:00Z") } else { Value::Null } }),
            ),
            None => (404, json!({})),
        },
        ("POST", ["v1", "checkouts", ""]) => {
            let body = sent.body.clone().unwrap();
            if state.honour_idempotency
                && let Some(key) = &sent.idempotency_key
                && let Some((_, known)) = state.idempotency.iter().find(|(k, _)| k == key)
            {
                return (201, known.clone());
            }
            state.counter += 1;
            let n = state.counter;
            let product_id = body["products"][0].as_str().unwrap().to_owned();
            let amount = product(&product_id).unwrap()["prices"][0]["price_amount"].clone();
            let checkout = json!({
                "id": format!("chk_{n}"), "url": format!("https://sandbox.polar.test/checkout/polar_c_secret{n}"),
                "client_secret": format!("polar_c_secret{n}"), "status": "open", "product_id": product_id,
                "customer_id": body["customer_id"], "customer_external_id": body["external_customer_id"],
                "amount": amount, "discount_amount": 0, "total_amount": amount, "currency": "usd",
                "metadata": body["metadata"],
            });
            state.checkouts.push(checkout.clone());
            if let Some(key) = &sent.idempotency_key {
                state.idempotency.push((key.clone(), checkout.clone()));
            }
            (201, checkout)
        }
        ("GET", ["v1", "checkouts", ""]) => {
            let items = state
                .checkouts
                .iter()
                .filter(|c| {
                    Some(c["product_id"].as_str().unwrap().to_owned()) == param("product_id")
                        && Some(
                            c["customer_external_id"]
                                .as_str()
                                .unwrap_or_default()
                                .to_owned(),
                        ) == param("external_customer_id")
                })
                .cloned()
                .collect();
            (200, page(items))
        }
        ("POST", ["v1", "checkouts", "client", secret, "confirm"]) => {
            let Some(index) = state
                .checkouts
                .iter()
                .position(|c| c["client_secret"] == *secret && c["status"] == "open")
            else {
                return (400, json!({ "detail": "not open" }));
            };
            state.checkouts[index]["status"] = json!("confirmed");
            let order = make_order(state, index);
            let product_id = order["product_id"].as_str().unwrap().to_owned();
            let (_, _, credits, _, benefit) =
                PAIRS.iter().find(|(_, f, ..)| *f == product_id).unwrap();
            state.counter += 1;
            let grant = json!({
                "id": format!("grant_{}", state.counter), "order_id": order["id"], "customer_id": order["customer_id"],
                "benefit_id": benefit, "is_granted": true, "is_revoked": false, "granted_at": "2026-11-12T12:00:00Z",
                "benefit": { "id": benefit, "type": "meter_credit", "properties": { "meter_id": METER, "units": credits, "rollover": true } },
            });
            state.grants.push(grant);
            let mut checkout = state.checkouts[index].clone();
            checkout["status"] = json!("confirmed");
            (200, checkout)
        }
        ("GET", ["v1", "checkouts", id]) => state
            .checkouts
            .iter()
            .find(|c| c["id"] == *id)
            .map_or((404, json!({})), |c| (200, c.clone())),
        ("GET", ["v1", "orders", ""]) => {
            let items = state
                .orders
                .iter()
                .filter(|o| o["checkout_id"].as_str().map(str::to_owned) == param("checkout_id"))
                .cloned()
                .collect();
            (200, page(items))
        }
        ("GET", ["v1", "orders", id]) => state
            .orders
            .iter()
            .find(|o| o["id"] == *id)
            .map_or((404, json!({})), |o| (200, o.clone())),
        ("GET", ["v1", "benefit-grants", ""]) => {
            let items = state
                .grants
                .iter()
                .filter(|g| g["customer_id"].as_str().map(str::to_owned) == param("customer_id"))
                .cloned()
                .collect();
            (200, page(items))
        }
        ("GET", ["v1", "subscriptions", ""]) => {
            let (key, value) = q
                .iter()
                .find(|(k, _)| k == "customer_id" || k == "external_customer_id")
                .cloned()
                .unwrap();
            let page_number: usize = param("page").and_then(|p| p.parse().ok()).unwrap_or(1);
            let all: Vec<Value> = state
                .subscriptions
                .iter()
                .filter(|s| s[&key] == value.as_str())
                .cloned()
                .collect();
            let max_page = all.len().div_ceil(2).max(1);
            let items: Vec<Value> = all
                .into_iter()
                .skip((page_number - 1) * 2)
                .take(2)
                .collect();
            (
                200,
                json!({ "items": items, "pagination": { "max_page": max_page } }),
            )
        }
        ("DELETE", ["v1", "subscriptions", id]) => {
            if state.revoke_fails.contains(*id) {
                return (409, json!({ "detail": "already" }));
            }
            match state.subscriptions.iter_mut().find(|s| s["id"] == *id) {
                Some(subscription) => {
                    subscription["status"] = json!("canceled");
                    (200, subscription.clone())
                }
                None => (404, json!({})),
            }
        }
        ("GET", ["v1", "subscriptions", id]) => state
            .subscriptions
            .iter()
            .find(|s| s["id"] == *id)
            .map_or((404, json!({})), |s| (200, s.clone())),
        _ => (501, json!({ "detail": "unexpected" })),
    }
}

/// A user document as the reference stores one (fixtures only).
pub fn user_document(id: ObjectId, twitch: &str, name: &str, customer: Option<&str>) -> Document {
    doc! {
        "_id": id, "name": name.to_lowercase(), "email": format!("{}@example.test", name.to_lowercase()),
        "language": "en", "plan_tier": "free",
        "accounts": [{ "_id": ObjectId::new(), "type": "twitch", "id": twitch, "name": name, "actived": true }],
        "token_balance": 0_i32,
        "polar_sh_customer_id": customer.map_or(Bson::Null, |c| Bson::String(c.to_owned())),
        "created_at": bson::DateTime::from_millis(1_794_398_400_000),
        "__v": 0_i32,
    }
}

#![cfg(feature = "billing-service")]

//! Loopback-HTTP and private-Redis coverage for the concrete billing adapters.
//!
//! `BillingService`, `GiftProvider`, and `PolarCreditSourceReads` are exercised
//! against an in-process stand-in for the Polar API so the request paths, bodies,
//! retry behaviour, and response mapping are real rather than mocked at the
//! method boundary. The Redis context-cache test is `#[ignore]`d and requires an
//! explicitly provided disposable instance.

use dima_rust::utils::{
    ai_credit_projection::{AI_CREDITS_METER_ID, PlanTier},
    ai_credit_sources::{self, CreditSourceReads, PolarCreditSourceReads},
    billing::{
        self, BillingConfig, BillingError, BillingService, BillingUser, CheckoutCreateRequest,
        CheckoutFlow, CreditPackCheckoutRequest, DefaultUrl, PaidPlanTier, PortalSessionRequest,
        credit_pack_billing_context_cache_key,
    },
    credit_gift_provider::{self, GiftProvider},
    credit_packs::CREDIT_PACK_DEFINITIONS,
    credit_policy::JsDate,
    js_date::parse_date,
    polar::{PolarClient, PolarConfig, PolarPolicy},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const CUSTOMER: &str = "5103e79b-fd74-4ba8-a287-f95574f9addf";
const NOW_MS: i64 = 1_788_000_000_000;

fn fixed_clock() -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(NOW_MS as u64)
}

fn iso_at(millis: i64) -> String {
    JsDate::from_millis(millis as f64)
        .to_iso_string()
        .expect("iso")
}

#[derive(Debug, Clone)]
struct Recorded {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Recorded {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).expect("json request body")
    }
}

struct Reply {
    status: u16,
    body: String,
}

impl Reply {
    fn json(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            body: body.into(),
        }
    }

    fn ok(body: impl Into<String>) -> Self {
        Self::json(200, body)
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        403 => "Forbidden",
        422 => "Unprocessable Entity",
        500 => "Internal Server Error",
        _ => "OK",
    }
}

/// Minimal blocking HTTP/1.1 stand-in. Each connection serves exactly one
/// request and closes, so a pooled client never reuses a stale socket.
struct StandIn {
    origin: String,
    requests: Arc<Mutex<Vec<Recorded>>>,
    stop: Arc<AtomicBool>,
    addr: SocketAddr,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl StandIn {
    fn start<R>(responder: R) -> Self
    where
        R: Fn(&Recorded) -> Reply + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().expect("loopback addr");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = Arc::clone(&stop);
        let responder = Arc::new(responder);
        let thread = std::thread::spawn(move || {
            for stream in listener.incoming() {
                if stopped.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(mut stream) = stream else { break };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                let Some(request) = read_request(&mut stream) else {
                    continue;
                };
                let reply = responder(&request);
                recorded.lock().expect("requests").push(request);
                let response = format!(
                    "HTTP/1.1 {} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    reply.status,
                    reason(reply.status),
                    reply.body.len(),
                    reply.body
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        Self {
            origin: format!("http://{addr}"),
            requests,
            stop,
            addr,
            thread: Some(thread),
        }
    }

    fn client(&self, policy: PolarPolicy) -> PolarClient {
        PolarClient::new(
            PolarConfig::new(&self.origin, "fixture-oat").expect("loopback origin is accepted"),
            policy,
        )
        .expect("client")
    }

    fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().expect("requests").clone()
    }
}

impl Drop for StandIn {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn read_request(stream: &mut TcpStream) -> Option<Recorded> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break index;
        }
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > 1 << 20 {
            return None;
        }
    };
    let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut start = lines.next()?.split(' ');
    let method = start.next()?.to_owned();
    let path = start.next()?.to_owned();
    let mut headers = Vec::new();
    for line in lines {
        let (name, value) = line.split_once(':')?;
        headers.push((name.trim().to_lowercase(), value.trim().to_owned()));
    }
    let content_length = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = buffer[(header_end + 4).min(buffer.len())..].to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);
    Some(Recorded {
        method,
        path,
        headers,
        body,
    })
}

fn user<'a>(plan: PlanTier) -> BillingUser<'a> {
    BillingUser {
        id: "user-1",
        email: Some("owner@example.com"),
        name: Some("Owner"),
        plan_tier: plan,
        polar_sh_customer_id: Some(CUSTOMER),
        referral_code_used: false,
        last_app_activity_at: None,
        updated_at: None,
    }
}

fn pack_products() -> String {
    let packs: Vec<Value> = CREDIT_PACK_DEFINITIONS
        .iter()
        .map(|definition| {
            json!({
                "id": definition.id,
                "name": format!("{} pack", definition.size.as_str()),
                "visibility": "public",
                "is_archived": false,
                "prices": [{
                    "type": "one_time",
                    "amount_type": "fixed",
                    "price_amount": 1999,
                    "price_currency": "USD",
                    "is_archived": false
                }],
                "benefits": [{
                    "type": "meter_credit",
                    "properties": {
                        "units": 40000,
                        "rollover": definition.kind.expected_rollover(),
                        "meter_id": AI_CREDITS_METER_ID
                    }
                }]
            })
        })
        .collect();
    json!({"items": packs}).to_string()
}

#[tokio::test]
async fn the_checkout_422_retry_omits_customer_id_exactly_once() {
    let posts = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&posts);
    let server = StandIn::start(move |request| {
        if request.path.starts_with("/v1/subscriptions/") {
            return Reply::ok(r#"{"items":[]}"#);
        }
        if request.path.starts_with("/v1/products/") {
            return Reply::ok(r#"{"prices":[{"amount":1999}]}"#);
        }
        if request.method == "POST" && request.path == "/v1/checkouts/" {
            if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                return Reply::json(422, r#"{"detail":"customer mismatch"}"#);
            }
            return Reply::ok(r#"{"id":"checkout-1","url":"https://polar.test/checkout/1"}"#);
        }
        Reply::json(404, r#"{"detail":"unexpected"}"#)
    });
    let notices: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&notices);
    let service = BillingService::new(server.client(PolarPolicy::Billing), None, BillingConfig::default())
        .with_fixed_clock(fixed_clock())
        .with_checkout_retry_notice(Arc::new(move |notice| {
            captured.lock().expect("notices").push(json!({
                "user_id": notice.user_id,
                "customer_id": notice.customer_id,
                "scenario": notice.scenario.as_str(),
                "provider_body": notice.provider_body,
            }));
        }));
    let decision = service
        .create_billing_checkout(&CheckoutCreateRequest {
            user: user(PlanTier::Free),
            target_plan: PaidPlanTier::Premium,
            action: None,
            promo_code: None,
            success_url: None,
            return_url: None,
            referral_code: None,
        })
        .await
        .expect("checkout");
    assert_eq!(decision.flow, CheckoutFlow::Checkout);
    assert_eq!(decision.scenario.as_str(), "new");
    assert_eq!(decision.checkout_id.as_deref(), Some("checkout-1"));
    assert_eq!(decision.checkout_url, "https://polar.test/checkout/1");

    let requests = server.requests();
    let posts: Vec<&Recorded> = requests
        .iter()
        .filter(|request| request.method == "POST" && request.path == "/v1/checkouts/")
        .collect();
    assert_eq!(posts.len(), 2, "exactly one retry");
    let first = posts[0].json();
    let second = posts[1].json();
    assert_eq!(first["customer_id"], json!(CUSTOMER));
    assert!(second.get("customer_id").is_none(), "the retry omits it");
    assert_eq!(
        posts[0].header("idempotency-key"),
        posts[1].header("idempotency-key"),
        "both attempts share one idempotency key"
    );
    assert_eq!(first["products"], json!([billing::PLAN_PRODUCT_ID_PREMIUM]));
    assert_eq!(first["allow_discount_codes"], json!(true));
    assert_eq!(first["external_customer_id"], json!("user-1"));
    assert_eq!(first["customer_email"], json!("owner@example.com"));
    assert_eq!(first["metadata"]["source"], json!("dimabot_billing"));
    assert_eq!(first["metadata"]["target_plan"], json!("premium"));
    assert_eq!(first["metadata"]["user_id"], json!("user-1"));

    // Both subscription reads used the source query, in either completion order.
    let subscriptions: Vec<&str> = requests
        .iter()
        .filter(|request| request.path.starts_with("/v1/subscriptions/"))
        .map(|request| request.path.as_str())
        .collect();
    assert_eq!(subscriptions.len(), 2);
    assert!(subscriptions.contains(&format!("/v1/subscriptions/?customer_id={CUSTOMER}&limit=100&active=true").as_str()));
    assert!(subscriptions.contains(&format!("/v1/subscriptions/?customer_id={CUSTOMER}&limit=100").as_str()));
    assert!(
        requests
            .iter()
            .any(|request| request.path == format!("/v1/products/{}/", billing::PLAN_PRODUCT_ID_PREMIUM)),
        "the product base amount is read with the source's trailing slash"
    );

    let notices = notices.lock().expect("notices").clone();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0]["customer_id"], json!(CUSTOMER));
    assert_eq!(notices[0]["scenario"], json!("new"));
    assert!(notices[0]["provider_body"]
        .as_str()
        .expect("body")
        .contains("customer mismatch"));
}

#[tokio::test]
async fn the_customer_portal_session_maps_the_source_request_and_response() {
    let server = StandIn::start(|request| {
        if request.method == "POST" && request.path == "/v1/customer-sessions/" {
            return Reply::ok(
                r#"{"id":"ses_1","customer_portal_url":"https://polar.test/portal/ses_1","expires_at":"2026-09-04T11:00:00.000Z"}"#,
            );
        }
        Reply::json(404, r#"{"detail":"unexpected"}"#)
    });
    let config = BillingConfig::default()
        .with_default_url(DefaultUrl::PortalReturn, "https://app.example.com/portal");
    let service = BillingService::new(server.client(PolarPolicy::Billing), None, config)
        .with_fixed_clock(fixed_clock());
    let session = service
        .create_customer_portal_session(&PortalSessionRequest {
            user: user(PlanTier::Premium),
            return_url: None,
        })
        .await
        .expect("session");
    assert_eq!(session.session_id, "ses_1");
    assert_eq!(session.url, "https://polar.test/portal/ses_1");
    assert_eq!(
        session.expires_at.as_deref(),
        Some("2026-09-04T11:00:00.000Z")
    );
    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].json(),
        json!({
            "customer_id": CUSTOMER,
            "return_url": "https://app.example.com/portal"
        })
    );

    // A response without `customer_portal_url` is a typed provider-response error.
    let incomplete = StandIn::start(|_| Reply::ok(r#"{"id":"ses_2"}"#));
    let service = BillingService::new(
        incomplete.client(PolarPolicy::Billing),
        None,
        BillingConfig::default(),
    );
    let error = service
        .create_customer_portal_session(&PortalSessionRequest {
            user: user(PlanTier::Premium),
            return_url: None,
        })
        .await
        .expect_err("must fail");
    assert_eq!(
        error.to_string(),
        "Polar provider response is missing customer_portal_url"
    );

    // A user without a Polar customer id never reaches the provider.
    let anonymous = StandIn::start(|_| Reply::ok("{}"));
    let service = BillingService::new(
        anonymous.client(PolarPolicy::Billing),
        None,
        BillingConfig::default(),
    );
    let mut unreachable = user(PlanTier::Free);
    unreachable.polar_sh_customer_id = None;
    let error = service
        .create_customer_portal_session(&PortalSessionRequest {
            user: unreachable,
            return_url: None,
        })
        .await
        .expect_err("must fail");
    assert_eq!(
        error.to_string(),
        "Customer does not have a Polar customer ID."
    );
    assert!(anonymous.requests().is_empty());
}

#[tokio::test]
async fn the_credit_pack_catalog_and_checkout_use_the_source_requests() {
    let products = pack_products();
    let server = StandIn::start(move |request| {
        if request.path == "/v1/products/?limit=100" {
            return Reply::ok(products.clone());
        }
        if request.path.starts_with("/v1/subscriptions/") {
            return Reply::ok(format!(
                r#"{{"items":[{{"id":"sub-1","product_id":"{}","status":"active","current_period_end":"2026-12-01T00:00:00Z"}}]}}"#,
                billing::PLAN_PRODUCT_ID_PREMIUM
            ));
        }
        if request.method == "POST" && request.path == "/v1/checkouts/" {
            // Missing `id` on purpose: the native type must reject it.
            return Reply::ok(r#"{"url":"https://polar.test/checkout/9"}"#);
        }
        Reply::json(404, r#"{"detail":"unexpected"}"#)
    });
    let service = BillingService::new(server.client(PolarPolicy::Billing), None, BillingConfig::default())
        .with_fixed_clock(fixed_clock());
    let catalog = service
        .get_credit_pack_catalog(&user(PlanTier::Premium))
        .await
        .expect("catalog");
    assert_eq!(catalog.offers.len(), 6);
    assert!(catalog.has_active_paid_subscription);
    assert_eq!(billing::plan_tier_name(catalog.plan_tier), "premium");
    assert_eq!(
        catalog.recharge_expires_at.as_deref(),
        Some(iso_at(parse_date("2026-12-01T00:00:00Z").expect("date")).as_str())
    );
    assert!(catalog.offers.iter().all(|offer| offer.eligible));
    assert_eq!(catalog.offers[0].name, "sample pack");
    assert_eq!(catalog.offers[0].price_currency, "usd");

    let error = service
        .create_credit_pack_checkout(&CreditPackCheckoutRequest {
            user: user(PlanTier::Premium),
            product_id: CREDIT_PACK_DEFINITIONS[0].id,
            success_url: Some("https://app.example.com/success"),
            return_url: None,
        })
        .await
        .expect_err("must fail");
    assert_eq!(error.to_string(), "Polar provider response is missing id");
    match error {
        BillingError::ProviderResponse(field) => assert_eq!(field, "id"),
        other => panic!("unexpected error {other:?}"),
    }

    let requests = server.requests();
    let post = requests
        .iter()
        .find(|request| request.method == "POST" && request.path == "/v1/checkouts/")
        .expect("checkout post");
    let body = post.json();
    assert_eq!(body["products"], json!([CREDIT_PACK_DEFINITIONS[0].id]));
    assert_eq!(body["allow_discount_codes"], json!(false));
    assert_eq!(body["metadata"]["source"], json!("dimabot_credit_store"));
    assert_eq!(body["metadata"]["pack_type"], json!("credits"));
    assert_eq!(body["metadata"]["pack_size"], json!("sample"));
    assert_eq!(body["metadata"]["credits"], json!(40000.0));
    assert_eq!(body["metadata"]["rollover"], json!(true));
    assert_eq!(body["metadata"]["user_id"], json!("user-1"));
}

#[tokio::test]
async fn the_gift_provider_builds_the_source_offer_over_http() {
    let pair = credit_gift_provider::GIFT_PACK_PAIRS[0];
    let server = StandIn::start(move |request| {
        if request.path == format!("/v1/products/{}", pair.product_id) {
            return Reply::ok(json!({
                "id": pair.product_id,
                "name": "  Gift credits  ",
                "is_archived": false,
                "is_recurring": false,
                "visibility": "public",
                "prices": [{"type": "one_time", "amount_type": "fixed", "price_amount": 1999, "price_currency": "USD", "is_archived": false}],
                "benefits": []
            }).to_string());
        }
        if request.path == format!("/v1/products/{}", pair.fulfillment_product_id) {
            return Reply::ok(json!({
                "id": pair.fulfillment_product_id,
                "name": "Gift fulfillment",
                "is_archived": false,
                "is_recurring": false,
                "visibility": "public",
                "prices": [{"type": "one_time", "amount_type": "fixed", "price_amount": 0, "price_currency": "usd", "is_archived": false}],
                "benefits": [{
                    "id": "benefit-1",
                    "type": "meter_credit",
                    "is_deleted": false,
                    "properties": {"units": pair.credits, "rollover": true, "meter_id": AI_CREDITS_METER_ID}
                }]
            }).to_string());
        }
        Reply::json(404, r#"{"detail":"unexpected"}"#)
    });
    let provider = GiftProvider::new(server.client(PolarPolicy::Gift)).expect("gift client");
    let validation = provider.load_gift_pair(pair.product_id).await.expect("offer");
    assert_eq!(validation.offer.id, pair.product_id);
    assert_eq!(validation.offer.name, "Gift credits");
    assert_eq!(validation.offer.credits, pair.credits);
    assert!(validation.offer.rollover);
    assert_eq!(validation.offer.price_amount, 1999.0);
    assert_eq!(validation.offer.price_currency, "usd");
    assert_eq!(validation.fulfillment_product_id, pair.fulfillment_product_id);
    assert_eq!(validation.benefit_id, "benefit-1");
    let mut paths: Vec<String> = server
        .requests()
        .into_iter()
        .map(|request| request.path)
        .collect();
    paths.sort();
    let mut expected = vec![
        format!("/v1/products/{}", pair.product_id),
        format!("/v1/products/{}", pair.fulfillment_product_id),
    ];
    expected.sort();
    assert_eq!(paths, expected);
}

#[tokio::test]
async fn the_credit_source_reader_walks_the_source_paths() {
    let server = StandIn::start(|request| {
        if request.path.starts_with("/v1/benefit-grants/") {
            return Reply::ok(json!({
                "items": [
                    {"id": "g1", "benefit_id": "b1", "customer_id": "customer-1",
                     "is_granted": true, "is_revoked": false, "subscription_id": "sub-1"},
                    {"id": "g2", "benefit_id": "b1", "customer_id": "customer-1",
                     "is_granted": false, "is_revoked": false, "subscription_id": "sub-2"}
                ],
                "pagination": {"max_page": 1}
            }).to_string());
        }
        if request.path == "/v1/orders/order-1" {
            return Reply::ok(json!({
                "id": "order-1", "customer_id": "customer-1",
                "product_id": "45c32959-3fa2-41a6-855c-bbeafcf9ce3c",
                "subscription_id": null, "paid": true, "total_amount": 1999, "metadata": {}
            }).to_string());
        }
        Reply::json(404, r#"{"detail":"unexpected"}"#)
    });
    let mut reads =
        PolarCreditSourceReads::new(server.client(PolarPolicy::Gift), "customer-1").expect("reads");
    let grant = reads.grant("g1").await.expect("grant read").expect("grant");
    assert_eq!(grant.id, "g1");
    assert_eq!(grant.benefit_id, "b1");
    assert_eq!(grant.subscription_id.as_deref(), Some("sub-1"));
    // A second read is served from the per-instance grant cache.
    assert!(reads.grant("g1").await.expect("cached").is_some());
    let order = reads.order("order-1").await.expect("order");
    assert_eq!(order.id, "order-1");
    assert_eq!(order.product_id, "45c32959-3fa2-41a6-855c-bbeafcf9ce3c");

    let paths = server.requests();
    let grants: Vec<&str> = paths
        .iter()
        .filter(|request| request.path.starts_with("/v1/benefit-grants/"))
        .map(|request| request.path.as_str())
        .collect();
    assert_eq!(
        grants,
        vec!["/v1/benefit-grants/?customer_id=customer-1&limit=100&page=1&sorting=-created_at"],
        "the grant list query matches the source exactly"
    );
    assert!(paths.iter().any(|request| request.path == "/v1/orders/order-1"));
    // The path builders the oracle pins are what the client actually requests.
    assert_eq!(
        ai_credit_sources::grant_list_path("customer-1", 1),
        grants[0]
    );
}

// ---------------------------------------------------------------------------
// Private Redis fixture: the credit-pack billing context cache.
// ---------------------------------------------------------------------------

const FIXTURE_OWNER: &str = "dimabot-migration";

async fn fixture_connection() -> (redis::aio::ConnectionManager, String) {
    let url = std::env::var("DIMA_TEST_REDIS_URL")
        .expect("DIMA_TEST_REDIS_URL must name a disposable Redis/Dragonfly fixture");
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok(FIXTURE_OWNER),
        "only a task-owned disposable fixture may be used"
    );
    assert!(
        url.starts_with("redis://") || url.starts_with("rediss://"),
        "the fixture URL must be an explicit Redis connection URL"
    );
    let namespace = std::env::var("DIMA_BILLING_FIXTURE_NAMESPACE")
        .expect("DIMA_BILLING_FIXTURE_NAMESPACE must name a unique task-owned namespace");
    assert!(
        namespace.starts_with("billing-fixture-") && namespace.len() <= 48,
        "namespace must be unique and task-owned"
    );
    assert!(
        namespace
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'),
        "namespace must be a simple identifier"
    );
    let client = redis::Client::open(url).expect("redis client");
    let connection = redis::aio::ConnectionManager::new(client)
        .await
        .expect("redis fixture manager");
    (connection, namespace)
}

async fn redis_del(connection: &mut redis::aio::ConnectionManager, key: &str) {
    let _: i64 = redis::cmd("DEL")
        .arg(key)
        .query_async(connection)
        .await
        .expect("del");
}

#[tokio::test]
#[ignore = "requires an explicitly provided isolated Redis fixture"]
async fn the_credit_pack_context_cache_uses_the_source_key_and_ttl() {
    let (mut connection, namespace) = fixture_connection().await;
    let now = NOW_MS;
    // The fixture sells the cache behaviour; the clock pins the TTL arithmetic.
    let plus = |millis: i64| iso_at(now + millis);
    let premium_customer = format!("{namespace}-premium");
    let free_customer = format!("{namespace}-free");
    let edge_customer = format!("{namespace}-edge");
    let premium_items = json!({
        "items": [{
            "id": "sub-1",
            "product_id": billing::PLAN_PRODUCT_ID_PREMIUM,
            "status": "active",
            "current_period_end": plus(60_000)
        }]
    });
    let edge_items = json!({
        "items": [{
            "id": "sub-2",
            "product_id": billing::PLAN_PRODUCT_ID_PREMIUM,
            "status": "active",
            "current_period_end": plus(500)
        }]
    });
    let premium_items = premium_items.to_string();
    let edge_items = edge_items.to_string();
    let premium_customer_for_reply = premium_customer.clone();
    let edge_customer_for_reply = edge_customer.clone();
    let server = StandIn::start(move |request| {
        if request.path == "/v1/products/?limit=100" {
            return Reply::ok(pack_products());
        }
        if request.path.starts_with("/v1/subscriptions/") {
            if request.path.contains(&premium_customer_for_reply) {
                return Reply::ok(premium_items.clone());
            }
            if request.path.contains(&edge_customer_for_reply) {
                return Reply::ok(edge_items.clone());
            }
            return Reply::ok(r#"{"items":[]}"#);
        }
        Reply::json(404, r#"{"detail":"unexpected"}"#)
    });
    let service = BillingService::new(
        server.client(PolarPolicy::Billing),
        Some(connection.clone()),
        BillingConfig::default(),
    )
    .with_fixed_clock(fixed_clock());

    // 1. A paid context stores the source key, normalised value, and clamped TTL.
    let premium_key = credit_pack_billing_context_cache_key(&premium_customer);
    redis_del(&mut connection, &premium_key).await;
    assert_eq!(
        premium_key,
        format!(
            "billing:credit-packs:context:v1:{}",
            &format!(
                "{:x}",
                sha2::Sha256::digest(premium_customer.as_bytes())
            )[..20]
        )
    );
    let mut premium_user = user(PlanTier::Premium);
    premium_user.polar_sh_customer_id = Some(premium_customer.as_str());
    let catalog = service.get_credit_pack_catalog(&premium_user).await.expect("catalog");
    assert!(catalog.has_active_paid_subscription);
    let stored: Option<String> = redis::cmd("GET")
        .arg(&premium_key)
        .query_async(&mut connection)
        .await
        .expect("get");
    let stored: Value = serde_json::from_str(&stored.expect("cached context")).expect("json");
    assert_eq!(stored["version"], json!(1));
    assert_eq!(stored["planTier"], json!("premium"));
    assert_eq!(stored["expiresAt"], json!(plus(60_000)));
    let ttl: i64 = redis::cmd("TTL")
        .arg(&premium_key)
        .query_async(&mut connection)
        .await
        .expect("ttl");
    assert!((59..=60).contains(&ttl), "60s remaining, got {ttl}");

    // 2. A free context normalises the expiry to null and uses the full TTL.
    let free_key = credit_pack_billing_context_cache_key(&free_customer);
    redis_del(&mut connection, &free_key).await;
    let mut free_user = user(PlanTier::Free);
    free_user.polar_sh_customer_id = Some(free_customer.as_str());
    let catalog = service.get_credit_pack_catalog(&free_user).await.expect("catalog");
    assert!(!catalog.has_active_paid_subscription);
    let stored: Option<String> = redis::cmd("GET")
        .arg(&free_key)
        .query_async(&mut connection)
        .await
        .expect("get");
    let stored: Value = serde_json::from_str(&stored.expect("cached context")).expect("json");
    assert_eq!(stored["planTier"], json!("free"));
    assert_eq!(stored["expiresAt"], Value::Null);
    let ttl: i64 = redis::cmd("TTL")
        .arg(&free_key)
        .query_async(&mut connection)
        .await
        .expect("ttl");
    assert_eq!(ttl, 120);

    // 3. A sub-second remainder floors at one second.
    let edge_key = credit_pack_billing_context_cache_key(&edge_customer);
    redis_del(&mut connection, &edge_key).await;
    let mut edge_user = user(PlanTier::Premium);
    edge_user.polar_sh_customer_id = Some(edge_customer.as_str());
    service.get_credit_pack_catalog(&edge_user).await.expect("catalog");
    let ttl: i64 = redis::cmd("TTL")
        .arg(&edge_key)
        .query_async(&mut connection)
        .await
        .expect("ttl");
    assert!(
        (0..=1).contains(&ttl),
        "a sub-second remainder floors to one second, got {ttl}"
    );

    // 4. An invalid cached value is ignored and rewritten from the provider.
    let mut invalid = serde_json::Map::new();
    invalid.insert("version".into(), json!(2));
    invalid.insert("planTier".into(), json!("premium"));
    invalid.insert("expiresAt".into(), json!(plus(60_000)));
    let _: () = redis::cmd("SET")
        .arg(&premium_key)
        .arg(Value::Object(invalid).to_string())
        .query_async(&mut connection)
        .await
        .expect("set invalid");
    service.get_credit_pack_catalog(&premium_user).await.expect("catalog");
    let stored: Option<String> = redis::cmd("GET")
        .arg(&premium_key)
        .query_async(&mut connection)
        .await
        .expect("get");
    let stored: Value = serde_json::from_str(&stored.expect("rewritten")).expect("json");
    assert_eq!(stored["version"], json!(1), "the version-2 payload is rewritten");
    let ttl: i64 = redis::cmd("TTL")
        .arg(&premium_key)
        .query_async(&mut connection)
        .await
        .expect("ttl");
    assert!((59..=60).contains(&ttl));

    for key in [&premium_key, &free_key, &edge_key] {
        redis_del(&mut connection, key).await;
    }
}

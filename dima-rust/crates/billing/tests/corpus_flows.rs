//! The corpus's flows: the checkout, portal and credit-pack flows against the loopback Polar mock
//! (Polar's answers keyed by method and target as the recording scripted them; the requests Rust
//! sends compared with the reference's, the checkout body byte for byte), and `getAiCredits`
//! against Dragonfly (database 10; the recorded channel id mapped to one no other run uses).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::too_many_lines
)]

mod support;

use dima_billing::NoopObserver;
use dima_billing::config::{PolarConfig, RedirectConfig, ScenarioDiscounts};
use dima_billing::plans::PaidTier;
use dima_billing::plans::checkout::{self, Billing, BillingAction, BillingUser, CheckoutRequest};
use dima_billing::plans::credits_cache::{
    CreditOptions, CreditsCache, CustomerStateSource, LookupError, PlanLookup, PlanOwner,
};
use dima_billing::plans::pack_context::PackContextCache;
use dima_billing::polar::{PolarClient, PolarError};
use dima_core::{ManualClock, SecretString};
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer, RecordedRequest};
use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use support::{field, is_undefined, number, same, text};

fn cases(op: &str) -> Vec<Value> {
    let corpus = support::corpus();
    corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["op"] == op)
        .cloned()
        .collect()
}

fn now() -> i64 {
    support::corpus()["now"].as_i64().unwrap()
}

/// A mock answering as the recording's `fetch` stand-in did: by `METHOD target`, a list answering
/// repeated calls in order (its last entry repeating), 404 for anything else.
async fn scripted(answers: &Value) -> MockServer {
    let server = MockServer::start().await.unwrap();
    let table: HashMap<String, VecDeque<Value>> = answers
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                v.as_array()
                    .cloned()
                    .unwrap_or_else(|| vec![v.clone()])
                    .into(),
            )
        })
        .collect();
    let table = Arc::new(Mutex::new(table));
    server.fallback(move |request: &RecordedRequest| {
        let key = format!("{} {}", request.method, request.target);
        let mut table = table.lock().unwrap();
        let Some(queue) = table.get_mut(&key) else {
            return MockResponse::json(404, r#"{"detail":"Not Found"}"#);
        };
        let answer = if queue.len() > 1 {
            queue.pop_front().unwrap()
        } else {
            queue[0].clone()
        };
        let status = answer.get("status").and_then(Value::as_u64).unwrap_or(200) as u16;
        let body = match &answer["body"] {
            Value::String(text) => text.clone(),
            other => serde_json::to_string(other).unwrap(),
        };
        MockResponse::json(status, &body)
    });
    server
}

fn client(server: &MockServer) -> PolarClient {
    let provider = server
        .provider(PolarClient::provider(&PolarConfig::default()))
        .unwrap();
    PolarClient::new(
        HttpClient::builder().build().unwrap(),
        provider,
        Some(SecretString::from("polar_oat_corpus")),
    )
}

fn polar_config(env: &Value) -> PolarConfig {
    let get = |key: &str| text(env, key).filter(|v| !v.is_empty()).map(str::to_owned);
    PolarConfig {
        token: Some(SecretString::from("polar_oat_corpus")),
        referral_discount_id: get("POLARSH_REFERRAL_DISCOUNT_ID"),
        scenario_discounts: ScenarioDiscounts {
            winback: get("POLARSH_WINBACK_DISCOUNT_ID"),
            upgrade: get("POLARSH_UPGRADE_DISCOUNT_ID"),
            change: get("POLARSH_CHANGE_DISCOUNT_ID"),
        },
        ..Default::default()
    }
}

fn redirects(env: &Value) -> RedirectConfig {
    let get = |key: &str| text(env, key).filter(|v| !v.is_empty()).map(str::to_owned);
    RedirectConfig {
        success_url: get("BILLING_SUCCESS_URL"),
        return_url: get("BILLING_RETURN_URL"),
        portal_return_url: get("BILLING_PORTAL_RETURN_URL"),
        allowed_hosts: get("BILLING_ALLOWED_REDIRECT_HOSTS"),
    }
}

fn user(value: &Value) -> BillingUser {
    let date = |key: &str| text(value, key).and_then(dima_text::parse_date);
    BillingUser {
        id: value["_id"].as_str().unwrap().into(),
        email: text(value, "email").map(Into::into),
        name: text(value, "name").map(Into::into),
        plan_tier: text(value, "plan_tier").unwrap_or("free").into(),
        polar_sh_customer_id: text(value, "polar_sh_customer_id").map(Into::into),
        last_app_activity_at: date("last_app_activity_at"),
        updated_at: date("updated_at"),
        referral_code_used: text(value, "referralCodeUsed").map(Into::into),
    }
}

/// The requests as `(method, target, body)`, sorted (the two subscription lists go out in
/// parallel, so their order is not the reference's to fix).
fn requests_of(recorded: &[RecordedRequest]) -> Vec<(String, String, Option<String>)> {
    let mut out: Vec<_> = recorded
        .iter()
        .map(|r| {
            (
                r.method.clone(),
                r.target.clone(),
                (!r.body.is_empty()).then(|| r.body_text()),
            )
        })
        .collect();
    out.sort();
    out
}

fn expected_requests(case: &Value) -> Vec<(String, String, Option<String>)> {
    let mut out: Vec<_> = case["requests"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["method"].as_str().unwrap().into(),
                r["target"].as_str().unwrap().into(),
                r["body"].as_str().map(Into::into),
            )
        })
        .collect();
    out.sort();
    out
}

fn idempotency_keys(recorded: &[RecordedRequest]) -> Vec<Option<String>> {
    recorded
        .iter()
        .filter(|r| r.method == "POST")
        .map(|r| r.header("idempotency-key").map(Into::into))
        .collect()
}

fn opt(value: &Option<String>) -> Value {
    value.as_ref().map_or(Value::Null, |v| json!(v))
}

fn context_json(c: &checkout::BillingContext) -> Value {
    let mut map = Map::new();
    map.insert("planTier".into(), json!(c.plan_tier));
    map.insert(
        "hasActiveSubscription".into(),
        json!(c.has_active_subscription),
    );
    map.insert(
        "hasAnySubscriptionHistory".into(),
        json!(c.has_any_subscription_history),
    );
    map.insert(
        "hasPaidSubscriptionHistory".into(),
        json!(c.has_paid_subscription_history),
    );
    map.insert("hasUsedTrial".into(), json!(c.has_used_trial));
    map.insert("inactivityMonths".into(), json!(c.inactivity_months as f64));
    map.insert("isWinbackEligible".into(), json!(c.is_winback_eligible));
    map.insert("scenario".into(), json!(c.scenario.as_str()));
    for (key, value) in [
        ("activeSubscriptionId", &c.active_subscription_id),
        ("activeProductId", &c.active_product_id),
        ("recoverySubscriptionId", &c.recovery_subscription_id),
    ] {
        if let Some(v) = value {
            map.insert(key.into(), json!(v));
        }
    }
    if let Some(p) = c.target_product_id {
        map.insert("targetProductId".into(), json!(p));
    }
    map.insert("isReferralEligible".into(), json!(c.is_referral_eligible));
    Value::Object(map)
}

fn error_matches(case: &Value, error: &checkout::CheckoutError) -> bool {
    let message = case["error"].as_str().unwrap_or("");
    match error {
        // The reference's message carries Polar's body; Rust keeps only the status.
        checkout::CheckoutError::Polar(PolarError::Status { status, .. }) => {
            case["errorType"] == "PolarApiError"
                && message.starts_with(&format!("Polar API error {status}:"))
        }
        checkout::CheckoutError::CreditPackRequest { message: m, .. } => {
            case["errorType"] == "CreditPackRequestError" && message == *m
        }
        checkout::CheckoutError::CreditPack(
            dima_billing::credit_packs::CreditPackError::Configuration(m),
        ) => case["errorType"] == "CreditPackConfigurationError" && message == m,
        checkout::CheckoutError::CreditPack(
            dima_billing::credit_packs::CreditPackError::Malformed(_),
        )
        | checkout::CheckoutError::Malformed => case["errorType"] == "TypeError",
        other => message == other.to_string(),
    }
}

struct Report {
    op: &'static str,
    checked: usize,
    failures: Vec<String>,
}

impl Report {
    fn new(op: &'static str) -> Self {
        Self {
            op,
            checked: 0,
            failures: Vec::new(),
        }
    }
    fn check(&mut self, ok: bool, case: &Value, detail: impl FnOnce() -> String) {
        self.checked += 1;
        if !ok && self.failures.len() < 6 {
            let mut input = case["input"].clone();
            if let Some(o) = input.as_object_mut() {
                o.remove("answers");
            }
            self.failures
                .push(format!("{}\n  input: {input}\n  {}", self.op, detail()));
        }
    }
    fn finish(self) {
        assert!(
            self.failures.is_empty(),
            "{} mismatches:\n{}",
            self.op,
            self.failures.join("\n")
        );
        assert!(self.checked > 0);
        eprintln!("{}: {} checked", self.op, self.checked);
    }
}

#[tokio::test]
async fn billing_context_and_checkouts_match_the_reference() {
    let clock = ManualClock::new(now());
    let mut report = Report::new("billing_context");
    for case in cases("billing_context") {
        let input = &case["input"];
        let server = scripted(&input["answers"]).await;
        let polar = client(&server);
        let target = text(input, "targetPlan").and_then(PaidTier::parse);
        let actual = checkout::billing_context(
            &polar,
            &user(&input["user"]),
            target,
            BillingAction::parse(input["action"].as_str().unwrap()).unwrap(),
            now(),
        )
        .await;
        let requests = requests_of(&server.requests());
        let ok = requests == expected_requests(&case)
            && match (&actual, case.get("error")) {
                (Ok(context), None) => same(&case["expected"], &context_json(context)),
                (Err(PolarError::Status { status, .. }), Some(error)) => error
                    .as_str()
                    .unwrap()
                    .starts_with(&format!("Polar API error {status}")),
                _ => false,
            };
        report.check(ok, &case, || {
            format!(
                "expected {:?}\n  got {actual:?}\n  requests {requests:?}",
                case.get("expected").or(case.get("error"))
            )
        });
    }
    report.finish();

    let mut report = Report::new("billing_checkout");
    for case in cases("billing_checkout")
        .into_iter()
        .chain(cases("portal_session"))
    {
        let input = &case["input"];
        let server = scripted(&input["answers"]).await;
        let polar = client(&server);
        let config = polar_config(&input["env"]);
        let redirects = redirects(&input["env"]);
        let packs = PackContextCache::new(support::dragonfly(10).await.unwrap().unwrap());
        let billing = Billing {
            polar: &polar,
            config: &config,
            redirects: &redirects,
            packs: &packs,
            clock: &clock,
        };
        let buyer = user(&input["user"]);
        let outcome: Result<Value, checkout::CheckoutError> = if case["op"] == "portal_session" {
            billing
                .create_customer_portal_session(&buyer, text(input, "returnUrl"))
                .await
                .map(
                    |s| json!({"sessionId": s.session_id, "url": s.url, "expiresAt": s.expires_at}),
                )
        } else {
            let request = CheckoutRequest {
                target: PaidTier::parse(input["targetPlan"].as_str().unwrap()).unwrap(),
                action: BillingAction::Auto,
                promo_code: text(input, "promoCode").map(Into::into),
                success_url: text(input, "successUrl").map(Into::into),
                return_url: text(input, "returnUrl").map(Into::into),
            };
            billing
                .create_billing_checkout(&buyer, &request)
                .await
                .map(|d| {
                    let mut map = Map::new();
                    map.insert("flow".into(), json!(d.flow));
                    map.insert("scenario".into(), json!(d.scenario.as_str()));
                    map.insert("selectedDiscountId".into(), opt(&d.selected_discount_id));
                    map.insert(
                        "selectedDiscountCode".into(),
                        opt(&d.selected_discount_code),
                    );
                    map.insert(
                        "selectedDiscountReason".into(),
                        d.selected_discount_reason
                            .map_or(Value::Null, |r| json!(r.as_str())),
                    );
                    map.insert("checkoutId".into(), opt(&d.checkout_id));
                    if let Some(id) = &d.portal_session_id {
                        map.insert("portalSessionId".into(), json!(id));
                    }
                    map.insert("checkoutUrl".into(), json!(d.checkout_url));
                    map.insert("allowDiscountCodes".into(), json!(d.allow_discount_codes));
                    Value::Object(map)
                })
        };
        let recorded = server.requests();
        let keys_ok = idempotency_keys(&recorded)
            == case["requests"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|r| r["method"] == "POST")
                .map(|r| r["idempotencyKey"].as_str().map(Into::into))
                .collect::<Vec<_>>();
        let ok = requests_of(&recorded) == expected_requests(&case)
            && keys_ok
            && match (&outcome, case.get("error")) {
                (Ok(value), None) => same(&case["expected"], value),
                (Err(error), Some(_)) => error_matches(&case, error),
                _ => false,
            };
        report.check(ok, &case, || {
            format!(
                "expected {:?}\n  got {outcome:?}\n  requests {:?}\n  wanted   {:?}",
                case.get("expected").or(case.get("error")),
                requests_of(&recorded),
                expected_requests(&case)
            )
        });
    }
    report.finish();
}

#[tokio::test]
async fn credit_pack_flows_match_the_reference() {
    let Some(dragonfly) = support::dragonfly(10).await.unwrap() else {
        return;
    };
    let clock = ManualClock::new(now());
    let packs = PackContextCache::new(dragonfly.clone());
    let mut report = Report::new("credit packs");
    for case in cases("pack_catalog")
        .into_iter()
        .chain(cases("pack_checkout"))
    {
        let input = &case["input"];
        let buyer = user(&input["user"]);
        let customer = buyer
            .polar_sh_customer_id
            .as_ref()
            .map(|c| c.expose().clone())
            .filter(|c| !c.is_empty());
        let key = customer.as_deref().map(plans_key);
        if let Some(key) = &key {
            dragonfly.del(&[key]).await.unwrap();
            if let Some(cached) = text(input, "cached") {
                dragonfly
                    .set(
                        key,
                        cached.as_bytes(),
                        dima_store::dragonfly::SetOptions::ex(60),
                    )
                    .await
                    .unwrap();
            }
        }
        let server = scripted(&input["answers"]).await;
        let polar = client(&server);
        let config = polar_config(&input["env"]);
        let redirects = redirects(&input["env"]);
        let billing = Billing {
            polar: &polar,
            config: &config,
            redirects: &redirects,
            packs: &packs,
            clock: &clock,
        };
        let outcome: Result<Value, checkout::CheckoutError> = if case["op"] == "pack_catalog" {
            billing
                .credit_pack_catalog(&buyer)
                .await
                .map(|c| catalog_json(&c))
        } else {
            billing
                .create_credit_pack_checkout(&buyer, input["productId"].as_str().unwrap(), Some("https://domdimabot.com/ok"), None)
                .await
                .map(|c| json!({"checkoutId": c.checkout_id, "checkoutUrl": c.checkout_url, "offer": serde_json::to_value(&c.offer).unwrap()}))
        };
        let cache_after = match &key {
            Some(key) => dragonfly
                .get_text(key)
                .await
                .unwrap()
                .map_or(Value::Null, Value::String),
            None => Value::Null,
        };
        if let Some(key) = &key {
            dragonfly.del(&[key]).await.unwrap();
        }
        let recorded = server.requests();
        let expected_cache = case.get("cacheAfter").cloned().unwrap_or(Value::Null);
        let ok = requests_of(&recorded) == expected_requests(&case)
            && cache_after == expected_cache
            && match (&outcome, case.get("error")) {
                (Ok(value), None) => same(&case["expected"], value),
                (Err(error), Some(_)) => error_matches(&case, error),
                _ => false,
            };
        report.check(ok, &case, || {
            format!(
                "expected {:?}\n  got {outcome:?}\n  cache {cache_after} wanted {expected_cache}\n  requests {:?}\n  wanted   {:?}",
                case.get("expected").or(case.get("error")),
                requests_of(&recorded),
                expected_requests(&case)
            )
        });
    }
    report.finish();
}

fn plans_key(customer: &str) -> String {
    dima_billing::plans::pack_context::context_cache_key(customer)
}

fn catalog_json(c: &checkout::CreditPackCatalog) -> Value {
    json!({
        "planTier": c.plan_tier.to_string(),
        "hasActivePaidSubscription": c.has_active_paid_subscription,
        "rechargeExpiresAt": c.recharge_expires_at,
        "rechargeExpiryDays": c.recharge_expiry_days,
        "offers": serde_json::to_value(&c.offers).unwrap(),
    })
}

/// The recording's owner stand-in.
struct Owner {
    owner: Value,
    id: String,
    lookups: Mutex<Vec<Value>>,
}

impl PlanLookup for Owner {
    fn current_plan<'a>(
        &'a self,
        twitch_id: &'a str,
        customer_id: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Option<PlanOwner>, LookupError>> {
        Box::pin(async move {
            let recorded_id = if twitch_id == self.id {
                "41245072"
            } else {
                twitch_id
            };
            self.lookups
                .lock()
                .unwrap()
                .push(json!({"id": recorded_id, "customerId": customer_id}));
            match &self.owner {
                Value::String(s) if s == "throw" => Err(LookupError("lookup failed".into())),
                Value::Null => Ok(None),
                owner => Ok(Some(PlanOwner {
                    plan_tier: text(owner, "plan_tier").map(Into::into),
                    polar_sh_customer_id: text(owner, "polar_sh_customer_id").map(Into::into),
                    polar_plan_event_at: field(owner, "polar_plan_event_at")
                        .and_then(number)
                        .map(|n| n as i64),
                    polar_plan_event_key: text(owner, "polar_plan_event_key").map(Into::into),
                })),
            }
        })
    }
}

/// The recording's state stand-in.
struct State(Value);

impl CustomerStateSource for State {
    fn customer_state<'a>(
        &'a self,
        _customer_id: &'a str,
    ) -> BoxFuture<'a, Result<Value, PolarError>> {
        Box::pin(async move {
            match &self.0 {
                Value::String(s) if s == "throw" => Err(PolarError::Status {
                    status: 503,
                    mutation: false,
                }),
                state => Ok(state.clone()),
            }
        })
    }
}

#[tokio::test]
async fn get_ai_credits_matches_the_reference() {
    let Some(dragonfly) = support::dragonfly(10).await.unwrap() else {
        return;
    };
    let clock = Arc::new(ManualClock::new(now()));
    let cache = CreditsCache::new(dragonfly.clone(), clock, Arc::new(NoopObserver));
    let mut report = Report::new("get_ai_credits");
    let mut published = 0;
    let mut unavailable_kept = 0;
    for case in cases("get_ai_credits") {
        let input = &case["input"];
        let id = support::channel_id();
        let local = |key: &str| key.replace("41245072", &id);
        let recorded = |key: &str| key.replace(&id, "41245072");
        for (key, value) in input["cache"].as_object().unwrap() {
            dragonfly
                .set(
                    &local(key),
                    value.as_str().unwrap().as_bytes(),
                    Default::default(),
                )
                .await
                .unwrap();
        }
        let owner = Owner {
            owner: input["owner"].clone(),
            id: id.clone(),
            lookups: Mutex::new(Vec::new()),
        };
        let caller = &input["caller"];
        let caller = PlanOwner {
            plan_tier: text(caller, "plan_tier").map(Into::into),
            polar_sh_customer_id: text(caller, "polar_sh_customer_id").map(Into::into),
            ..Default::default()
        };
        let options = CreditOptions {
            require_verified: input["requireVerified"] == true,
        };
        let actual = cache
            .get_ai_credits(
                &caller,
                &id,
                options,
                &owner,
                &State(input["state"].clone()),
            )
            .await
            .unwrap();
        // Intended difference (item 4 of P2-BILLING-01b): a published balance advances the
        // usage revision, a Rust-only hash the reference does not have. It is checked here and
        // left out of the comparison of the reference's keys.
        let revision_key = dima_billing::plans::balance::revision_key(&id);
        let revision: Vec<Option<String>> = dragonfly
            .query(redis::cmd("HMGET").arg(&revision_key).arg("rev").arg("pub"))
            .await
            .unwrap();
        if revision[0].is_some() {
            assert_eq!(revision[0], revision[1], "a publication sets pub to rev");
            assert_eq!(revision[0].as_deref(), Some("1"));
            published += 1;
            dragonfly.del(&[&revision_key]).await.unwrap();
        }
        let after: Map<String, Value> = support::keys_with(&dragonfly, &id)
            .await
            .unwrap()
            .into_iter()
            .map(|(k, v)| (recorded(&k), Value::String(v)))
            .collect();
        support::cleanup(&dragonfly, &id).await.unwrap();
        let expected_after = case["cacheAfter"].as_object().unwrap();
        let cache_ok = after.len() == expected_after.len()
            && expected_after.iter().all(|(k, v)| {
                after.get(k).is_some_and(|a| {
                    a == v
                        || serde_json::from_str::<Value>(a.as_str().unwrap()).ok()
                            == serde_json::from_str::<Value>(v.as_str().unwrap()).ok()
                })
            });
        let lookups = Value::Array(owner.lookups.into_inner().unwrap());
        // Intended difference (item 5 of P2-BILLING-01b): a cached snapshot stored as
        // unavailable reads back as unavailable where the reference, without requireVerified,
        // answered it as available. Recognised from the recording alone: the cached snapshot
        // was unavailable, the reference answered from it (the cached value is unchanged and
        // the answer has its numbers) and read it as available.
        let mut expected = case["expected"].clone();
        let raw_credits = input["cache"].get("twitch:41245072:ai:credits");
        let stored: Option<Value> = raw_credits
            .and_then(Value::as_str)
            .and_then(|raw| serde_json::from_str(raw).ok());
        if let Some(stored) = stored
            && input["requireVerified"] != true
            && (stored["available"] == false || stored["status"] == "unavailable")
            && case["cacheAfter"].get("twitch:41245072:ai:credits") == raw_credits
            && expected["used"] == stored["used"]
            && expected["limit"] == stored["limit"]
            && expected["status"] == "available"
        {
            expected["available"] = json!(false);
            expected["status"] = json!("unavailable");
            unavailable_kept += 1;
        }
        let ok = same(&expected, &Value::Object(actual.data.to_json()))
            && cache_ok
            && lookups == case["lookups"];
        report.check(ok, &case, || {
            format!("expected {}\n  got {}\n  cache {after:?}\n  wanted {expected_after:?}\n  lookups {lookups} wanted {}", case["expected"], Value::Object(actual.data.to_json()), case["lookups"])
        });
    }
    report.finish();
    // Every case whose fetch reached Polar and was accepted: the cache value itself is the
    // reference's, byte for byte or as JSON (no debit happens during these fetches).
    assert_eq!(published, 340, "cases that published under the revision");
    assert_eq!(
        unavailable_kept, 18,
        "cached unavailable snapshots that stay unavailable"
    );
}

#[allow(dead_code)]
fn unused(_: &Value) -> bool {
    is_undefined(&Value::Null)
}

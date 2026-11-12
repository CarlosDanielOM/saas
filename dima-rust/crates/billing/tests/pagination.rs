//! Lists are read to the end or the decision fails (item 6 of P2-BILLING-01b, review finding
//! 10): subscriptions, products and discounts are read page by page within
//! `polar::MAX_LIST_PAGES`; past it the call fails with an incomplete-history error instead of
//! deciding from a partial list. Polar is the loopback mock, answering by request target.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use dima_billing::config::{PolarConfig, RedirectConfig};
use dima_billing::credit_packs::{CREDIT_PACK_DEFINITIONS, CreditPackKind};
use dima_billing::plans::PaidTier;
use dima_billing::plans::checkout::{
    Billing, BillingAction, BillingUser, CheckoutError, CheckoutRequest, billing_context,
};
use dima_billing::plans::pack_context::PackContextCache;
use dima_billing::polar::{PolarClient, PolarError};
use dima_billing::products::{AI_CREDITS_METER_ID, FREE_PRODUCT_ID, PREMIUM_PRODUCT_ID};
use dima_core::{ManualClock, SecretString};
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer, RecordedRequest};
use serde_json::{Value, json};
use std::collections::HashMap;

const CUSTOMER: &str = "9b2f4c1e-3a5d-4e6f-8a7b-1c2d3e4f5a6b";
const NOW: i64 = 1_793_000_000_000;

/// A mock answering by `METHOD target`; anything else is a 404.
async fn scripted(answers: Vec<(String, Value)>) -> MockServer {
    let server = MockServer::start().await.unwrap();
    let table: HashMap<String, Value> = answers.into_iter().collect();
    server.fallback(move |request: &RecordedRequest| {
        match table.get(&format!("{} {}", request.method, request.target)) {
            Some(body) => MockResponse::json(200, &body.to_string()),
            None => MockResponse::json(404, r#"{"detail":"Not Found"}"#),
        }
    });
    server
}

fn client(server: &MockServer) -> PolarClient {
    PolarClient::new(
        HttpClient::builder().build().unwrap(),
        server
            .provider(PolarClient::provider(&PolarConfig::default()))
            .unwrap(),
        Some(SecretString::from("polar_oat_pages")),
    )
}

fn user() -> BillingUser {
    BillingUser {
        id: "6650a0000000000000000001".into(),
        plan_tier: "free".into(),
        polar_sh_customer_id: Some(CUSTOMER.into()),
        last_app_activity_at: Some(NOW - 86_400_000),
        ..Default::default()
    }
}

fn subscription(id: &str, product: &str, status: &str, trial: bool) -> Value {
    json!({
        "id": id, "status": status, "product_id": product,
        "trial_start": if trial { json!("2026-01-01T00:00:00Z") } else { Value::Null },
        "trial_end": if trial { json!("2026-01-08T00:00:00Z") } else { Value::Null },
        "ended_at": "2026-02-01T00:00:00Z",
    })
}

fn subscriptions_target(active: bool, page: u32) -> String {
    let mut target = format!("GET /v1/subscriptions/?customer_id={CUSTOMER}&limit=100");
    if active {
        target.push_str("&active=true");
    }
    if page > 1 {
        target.push_str(&format!("&page={page}"));
    }
    target
}

fn page(items: Vec<Value>, max_page: u32) -> Value {
    json!({"items": items, "pagination": {"total_count": items.len(), "max_page": max_page}})
}

#[tokio::test]
async fn a_trial_on_the_second_page_is_seen_and_no_second_trial_is_offered() {
    let Some(dragonfly) = support::dragonfly(10).await.unwrap() else {
        return;
    };
    // The first page of the history holds a free subscription; the paid trial is on page 2.
    let server = scripted(vec![
        (subscriptions_target(true, 1), page(vec![], 1)),
        (
            subscriptions_target(false, 1),
            page(
                vec![subscription("s_free", FREE_PRODUCT_ID, "canceled", false)],
                2,
            ),
        ),
        (
            subscriptions_target(false, 2),
            page(
                vec![subscription(
                    "s_trial",
                    PREMIUM_PRODUCT_ID,
                    "canceled",
                    true,
                )],
                2,
            ),
        ),
        (
            format!("GET /v1/products/{PREMIUM_PRODUCT_ID}/"),
            json!({"prices": []}),
        ),
        (
            "POST /v1/checkouts/".into(),
            json!({"id": "chk", "url": "https://polar.sh/c"}),
        ),
    ])
    .await;
    let polar = client(&server);
    let context = billing_context(
        &polar,
        &user(),
        Some(PaidTier::Premium),
        BillingAction::Auto,
        NOW,
    )
    .await
    .unwrap();
    assert!(context.has_used_trial);
    assert!(context.has_paid_subscription_history);

    let clock = ManualClock::new(NOW);
    let config = PolarConfig::default();
    let redirects = RedirectConfig::default();
    let packs = PackContextCache::new(dragonfly);
    let billing = Billing {
        polar: &polar,
        config: &config,
        redirects: &redirects,
        packs: &packs,
        clock: &clock,
    };
    billing
        .create_billing_checkout(
            &user(),
            &CheckoutRequest {
                target: PaidTier::Premium,
                action: BillingAction::Auto,
                promo_code: None,
                success_url: None,
                return_url: None,
            },
        )
        .await
        .unwrap();
    let posted = server
        .requests()
        .into_iter()
        .find(|r| r.method == "POST")
        .unwrap();
    assert!(
        posted.body_text().contains(r#""allow_trial":false"#),
        "{}",
        posted.body_text()
    );
}

#[tokio::test]
async fn a_list_past_the_bound_fails_instead_of_deciding() {
    let Some(dragonfly) = support::dragonfly(10).await.unwrap() else {
        return;
    };
    let server = scripted(vec![
        (subscriptions_target(true, 1), page(vec![], 1)),
        (
            subscriptions_target(false, 1),
            page(
                vec![subscription("s1", FREE_PRODUCT_ID, "canceled", false)],
                500,
            ),
        ),
    ])
    .await;
    let polar = client(&server);
    let clock = ManualClock::new(NOW);
    let config = PolarConfig::default();
    let redirects = RedirectConfig::default();
    let packs = PackContextCache::new(dragonfly);
    let billing = Billing {
        polar: &polar,
        config: &config,
        redirects: &redirects,
        packs: &packs,
        clock: &clock,
    };
    let outcome = billing
        .create_billing_checkout(
            &user(),
            &CheckoutRequest {
                target: PaidTier::Pro,
                action: BillingAction::Auto,
                promo_code: None,
                success_url: None,
                return_url: None,
            },
        )
        .await;
    assert!(
        matches!(
            outcome,
            Err(CheckoutError::Polar(PolarError::IncompleteHistory { .. }))
        ),
        "{outcome:?}"
    );
    assert!(server.requests().iter().all(|r| r.method == "GET"));
}

#[tokio::test]
async fn full_pages_without_pagination_are_followed_and_bounded() {
    let filler = |n: usize| -> Vec<Value> {
        (0..n)
            .map(|i| subscription(&format!("s{i}"), FREE_PRODUCT_ID, "canceled", false))
            .collect()
    };
    let mut answers = vec![
        (
            subscriptions_target(false, 1),
            json!({"items": filler(100)}),
        ),
        (subscriptions_target(false, 2), json!({"items": filler(3)})),
    ];
    let server = scripted(answers.clone()).await;
    let polar = client(&server);
    assert_eq!(
        polar
            .list_subscriptions(CUSTOMER, None)
            .await
            .unwrap()
            .len(),
        103
    );

    // Every page full: past the bound the read fails.
    answers.clear();
    for page in 1..=20 {
        answers.push((
            subscriptions_target(false, page),
            json!({"items": filler(100)}),
        ));
    }
    let server = scripted(answers).await;
    let polar = client(&server);
    let error = polar.list_subscriptions(CUSTOMER, None).await.unwrap_err();
    assert!(
        matches!(error, PolarError::IncompleteHistory { .. }),
        "{error:?}"
    );
    assert_eq!(
        server.requests().len(),
        dima_billing::polar::MAX_LIST_PAGES as usize
    );
}

#[tokio::test]
async fn pack_products_on_the_second_page_are_offered() {
    let Some(dragonfly) = support::dragonfly(10).await.unwrap() else {
        return;
    };
    let products: Vec<Value> = CREDIT_PACK_DEFINITIONS
        .iter()
        .map(|definition| {
            json!({
                "id": definition.id, "name": definition.size.as_str(), "is_archived": false,
                "prices": [{"type": "one_time", "amount_type": "fixed", "is_archived": false,
                            "price_amount": 500, "price_currency": "usd"}],
                "benefits": [{"type": "meter_credit", "properties": {
                    "meter_id": AI_CREDITS_METER_ID, "units": 40000,
                    "rollover": definition.kind == CreditPackKind::Credits}}],
            })
        })
        .collect();
    let server = scripted(vec![
        (
            "GET /v1/products/?limit=100".into(),
            page(products[..3].to_vec(), 2),
        ),
        (
            "GET /v1/products/?limit=100&page=2".into(),
            page(products[3..].to_vec(), 2),
        ),
    ])
    .await;
    let polar = client(&server);
    let clock = ManualClock::new(NOW);
    let config = PolarConfig::default();
    let redirects = RedirectConfig::default();
    let packs = PackContextCache::new(dragonfly);
    let billing = Billing {
        polar: &polar,
        config: &config,
        redirects: &redirects,
        packs: &packs,
        clock: &clock,
    };
    let anonymous = BillingUser {
        polar_sh_customer_id: None,
        ..user()
    };
    let catalog = billing.credit_pack_catalog(&anonymous).await.unwrap();
    assert_eq!(catalog.offers.len(), 6);
}

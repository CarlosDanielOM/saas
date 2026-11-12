//! No personal data in `Debug` (item 9 of P2-BILLING-01b, review finding 11): every public type
//! that can hold an e-mail, a customer id, a name or a session or checkout URL is built with
//! marker values and formatted with `{:?}` and `{:#?}`; no marker may appear. Offline except
//! the flows that produce a URL, which run against the loopback mock.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use bson::doc;
use bson::oid::ObjectId;
use dima_billing::config::{PolarConfig, RedirectConfig};
use dima_billing::credit_packs::{CreditPackKind, CreditPackOffer, CreditPackSize};
use dima_billing::credit_sources::PolarCreditSourceReads;
use dima_billing::plans::PaidTier;
use dima_billing::plans::checkout::{
    Billing, BillingAction, BillingUser, CheckoutRequest, CreditPackCheckout,
};
use dima_billing::plans::credits_cache::PlanOwner;
use dima_billing::plans::pack_context::PackContextCache;
use dima_billing::plans::projection::PlanOwnerState;
use dima_billing::polar::{
    AcceptedUsage, BenefitGrant, BenefitGrantPage, Checkout, CustomerSession, EntitlementState,
    GrantInput, IngestEvent, PolarClient, SdkSubscription, UsageEventInput, build_grant_event,
    build_usage_event,
};
use dima_core::{ManualClock, SecretString};
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer};
use serde_json::json;
use std::fmt::Debug;

const EMAIL: &str = "marker-email@example.com";
const CUSTOMER: &str = "55c8d1d0-5cb8-405c-bcf2-0000marker01";
const NAME: &str = "Marker Name";
const ADMIN: &str = "markeradminlogin";
const SESSION_URL: &str = "https://polar.sh/portal/marker-session-token";
const CHECKOUT_URL: &str = "https://polar.sh/checkout/marker-checkout-secret";
const MARKERS: [&str; 6] = [
    "marker-email",
    "0000marker01",
    "Marker Name",
    "markeradmin",
    "marker-session",
    "marker-checkout",
];

fn assert_redacted(what: &str, value: &dyn Debug) {
    for shown in [format!("{value:?}"), format!("{value:#?}")] {
        for marker in MARKERS {
            assert!(!shown.contains(marker), "{what} prints {marker}: {shown}");
        }
    }
}

fn stored_user() -> dima_model::users::User {
    let now = bson::DateTime::from_millis(1_793_000_000_000);
    let document = doc! {
        "_id": ObjectId::new(), "name": NAME, "email": EMAIL,
        "accounts": [{ "_id": ObjectId::new(), "type": "twitch", "id": "9100", "actived": true }],
        "polar_sh_customer_id": CUSTOMER, "plan_tier": "premium", "plan_tier_until": bson::Bson::Null,
        "polar_plan_event_key": "evt", "polar_plan_event_at": now,
        "token_balance": 0, "created_at": now, "updated_at": now, "__v": 0,
    };
    dima_model::decode_document(&document).unwrap()
}

#[test]
fn stored_users_and_their_projections_print_no_personal_data() {
    let user = stored_user();
    let billing = BillingUser::of(&user);
    assert_eq!(
        billing.email.as_ref().map(|e| e.expose().as_str()),
        Some(EMAIL)
    );
    assert_redacted("BillingUser", &billing);
    assert_redacted("PlanOwner", &PlanOwner::of(&user));
    assert_redacted("PlanOwnerState", &PlanOwnerState::of(&user));
}

#[test]
fn polar_answers_print_no_personal_data() {
    let checkout: Checkout =
        serde_json::from_value(json!({"id": "chk_1", "url": CHECKOUT_URL})).unwrap();
    assert_redacted("Checkout", &checkout);
    let session: CustomerSession = serde_json::from_value(
        json!({"id": "cs_1", "customer_portal_url": SESSION_URL, "expires_at": null}),
    )
    .unwrap();
    assert_redacted("CustomerSession", &session);
    let state: EntitlementState = serde_json::from_value(
        json!({"id": CUSTOMER, "active_subscriptions": [], "granted_benefits": []}),
    )
    .unwrap();
    assert_redacted("EntitlementState", &state);
    let grant: BenefitGrant = serde_json::from_value(json!({
        "id": "g", "benefit_id": "b", "customer_id": CUSTOMER, "is_granted": true,
    }))
    .unwrap();
    assert_redacted("BenefitGrant", &grant);
    let page: BenefitGrantPage = serde_json::from_value(json!({
        "items": [{"id": "g", "benefit_id": "b", "customer_id": CUSTOMER}],
        "pagination": {"max_page": 1},
    }))
    .unwrap();
    assert_redacted("BenefitGrantPage", &page);
    let subscription: SdkSubscription = serde_json::from_value(json!({
        "id": "s", "customer_id": CUSTOMER, "product_id": "p", "status": "past_due",
    }))
    .unwrap();
    assert_redacted("SdkSubscription", &subscription);
    let pack = CreditPackCheckout {
        checkout_id: "chk".into(),
        checkout_url: CHECKOUT_URL.into(),
        offer: CreditPackOffer {
            id: "p".into(),
            name: "Pack".into(),
            kind: CreditPackKind::Recharge,
            size: CreditPackSize::Small,
            credits: 40_000.0,
            rollover: false,
            price_amount: 500.0,
            price_currency: "usd".into(),
            eligible: true,
            eligibility_reason: None,
        },
    };
    assert_redacted("CreditPackCheckout", &pack);
}

#[test]
fn ingest_events_and_grants_print_no_personal_data() {
    let random = support::ZeroRandom;
    let usage = UsageEventInput {
        customer_id: CUSTOMER.into(),
        channel_id: Some("9100".into()),
        external_id: Some("aiu_1".into()),
        cost: 0.001,
        reason: "messages".into(),
        ..Default::default()
    };
    assert_redacted("UsageEventInput", &usage);
    let (event, context) = build_usage_event(&usage, &random).unwrap();
    assert_redacted("IngestEvent (usage)", &event);
    let accepted = AcceptedUsage {
        channel_id: "9100",
        customer_id: &event.customer_id,
        context: &context,
        credits: 1.0,
    };
    assert_redacted("AcceptedUsage", &accepted);
    let grant = GrantInput {
        customer_id: CUSTOMER.into(),
        channel_id: Some("9100".into()),
        credits: 10.0,
        reason: "support".into(),
        admin_login: Some(ADMIN.into()),
        ..grant_identity()
    };
    assert_redacted("GrantInput", &grant);
    let (event, _, _) = build_grant_event(&grant, &random).unwrap().unwrap();
    assert_redacted("IngestEvent (grant)", &event);
    let named = IngestEvent {
        name: "ai_assistant".into(),
        customer_id: CUSTOMER.into(),
        external_id: "n1".into(),
        metadata: json!({"login": ADMIN}).as_object().cloned().unwrap(),
    };
    assert_redacted("IngestEvent (named)", &named);
}

fn grant_identity() -> GrantInput {
    GrantInput::default()
}

fn client(server: &MockServer) -> PolarClient {
    PolarClient::new(
        HttpClient::builder().build().unwrap(),
        server
            .provider(PolarClient::provider(&PolarConfig::default()))
            .unwrap(),
        Some(SecretString::from("polar_oat_debug")),
    )
}

#[tokio::test]
async fn flow_results_and_cached_reads_print_no_personal_data() {
    let Some(dragonfly) = support::dragonfly(10).await.unwrap() else {
        return;
    };
    let server = MockServer::start().await.unwrap();
    let polar = client(&server);
    let config = PolarConfig::default();
    let redirects = RedirectConfig::default();
    let packs = PackContextCache::new(dragonfly);
    let clock = ManualClock::new(1_793_000_000_000);
    let billing = Billing {
        polar: &polar,
        config: &config,
        redirects: &redirects,
        packs: &packs,
        clock: &clock,
    };
    let user = BillingUser::of(&stored_user());

    server.push(MockResponse::json(
        200,
        &json!({"id": "cs", "customer_portal_url": SESSION_URL}).to_string(),
    ));
    let session = billing
        .create_customer_portal_session(&user, None)
        .await
        .unwrap();
    assert_redacted("PortalSession", &session);

    // Two empty subscription lists, the product, then the checkout.
    for body in [
        json!({"items": [], "pagination": {"max_page": 1}}),
        json!({"items": [], "pagination": {"max_page": 1}}),
        json!({"prices": []}),
        json!({"id": "chk", "url": CHECKOUT_URL}),
    ] {
        server.push(MockResponse::json(200, &body.to_string()));
    }
    let decision = billing
        .create_billing_checkout(
            &user,
            &CheckoutRequest {
                target: PaidTier::Pro,
                action: BillingAction::Auto,
                promo_code: None,
                success_url: None,
                return_url: None,
            },
        )
        .await
        .unwrap();
    assert_redacted("CheckoutDecision", &decision);

    let mut reads = PolarCreditSourceReads::new(&polar, CUSTOMER);
    server.push(MockResponse::json(
        200,
        &json!({"items": [{"id": "g1", "customer_id": CUSTOMER, "properties": {"email": EMAIL}}],
                "pagination": {"max_page": 1}})
        .to_string(),
    ));
    let found = dima_billing::credit_sources::CreditSourceReads::grant(&mut reads, "g1")
        .await
        .unwrap();
    assert!(found.is_some());
    assert_redacted("PolarCreditSourceReads", &reads);
}

#![cfg(feature = "billing-service")]

//! Deterministic billing decisions for `utils::billing`
//! (source: `src/utils/billing.ts`). These cover the pure decision boundaries:
//! discount selection, scenario inference, checkout flow, redirect sanitising,
//! portal session mapping, the credit-pack context cache and helpers. No
//! provider, Redis, or Mongo call is made.

use dima_rust::utils::{
    ai_credit_projection::PlanTier,
    billing::{
        self, BillingAction, BillingConfig, BillingScenario, CheckoutFlow, DefaultUrl,
        DiscountCandidate, DiscountLike, DiscountProduct, DiscountReason, PaidPlanTier,
        PLAN_PRODUCT_ID_FREE, PLAN_PRODUCT_ID_PREMIUM, PLAN_PRODUCT_ID_PRO, PolarSubscription,
    },
    credit_policy::JsDate,
    js_date::parse_date,
};
use serde_json::json;

fn date(value: &str) -> JsDate {
    JsDate::from_millis(parse_date(value).expect("fixture date") as f64)
}

fn fixed(id: &str, amount: f64, code: Option<&str>) -> DiscountLike {
    DiscountLike {
        id: id.into(),
        code: code.map(str::to_owned),
        discount_type: Some("fixed".into()),
        basis_points: None,
        amount: Some(amount),
        products: None,
    }
}

fn percentage(id: &str, basis_points: f64) -> DiscountLike {
    DiscountLike {
        id: id.into(),
        code: None,
        discount_type: Some("percentage".into()),
        basis_points: Some(basis_points),
        amount: None,
        products: None,
    }
}

fn candidate(reason: DiscountReason, discount: DiscountLike) -> DiscountCandidate {
    DiscountCandidate { reason, discount }
}

#[test]
fn the_biggest_discount_wins_and_the_first_candidate_breaks_ties() {
    let referral = candidate(DiscountReason::Referral, fixed("referral", 500.0, None));
    let promo = candidate(DiscountReason::Promo, fixed("promo", 900.0, None));
    let best = billing::select_best_discount(&[referral.clone(), promo], 0.0).expect("best");
    assert_eq!(best.reason, DiscountReason::Promo);
    assert_eq!(best.discount.id, "promo");

    // Equal value: the earlier candidate (referral before promo) stays.
    let promo = candidate(DiscountReason::Promo, fixed("promo", 500.0, None));
    let best = billing::select_best_discount(&[referral, promo], 0.0).expect("best");
    assert_eq!(best.reason, DiscountReason::Referral);
    assert_eq!(best.discount.id, "referral");

    assert!(billing::select_best_discount(&[], 10_000.0).is_none());
}

#[test]
fn discount_value_follows_the_source_estimates() {
    assert_eq!(billing::estimate_discount_value(&fixed("f", 750.0, None), 0.0), 750.0);
    // 1000 basis points = 10% of the product base, floored.
    let ten_percent = percentage("p", 1_000.0);
    assert_eq!(billing::estimate_discount_value(&ten_percent, 10_050.0), 1_005.0);
    // Without a base amount the basis points themselves are the estimate.
    assert_eq!(billing::estimate_discount_value(&ten_percent, 0.0), 1_000.0);
    let unknown = DiscountLike {
        id: "u".into(),
        discount_type: Some("mystery".into()),
        ..DiscountLike::default()
    };
    assert_eq!(billing::estimate_discount_value(&unknown, 10_000.0), 0.0);
}

#[test]
fn discounts_apply_to_all_products_unless_restricted() {
    let unrestricted = fixed("d", 1.0, None);
    assert!(billing::is_discount_applicable_to_product(&unrestricted, PLAN_PRODUCT_ID_PRO));

    let empty = DiscountLike {
        products: Some(Vec::new()),
        ..unrestricted.clone()
    };
    assert!(billing::is_discount_applicable_to_product(&empty, PLAN_PRODUCT_ID_PRO));

    let restricted = DiscountLike {
        products: Some(vec![DiscountProduct {
            id: Some(PLAN_PRODUCT_ID_PREMIUM.into()),
        }]),
        ..unrestricted
    };
    assert!(billing::is_discount_applicable_to_product(&restricted, PLAN_PRODUCT_ID_PREMIUM));
    assert!(!billing::is_discount_applicable_to_product(&restricted, PLAN_PRODUCT_ID_PRO));
}

#[test]
fn scenario_inference_lets_the_live_subscription_win() {
    let infer = |action: BillingAction,
                 active: bool,
                 target: PaidPlanTier,
                 current: PlanTier,
                 winback: bool,
                 history: bool| {
        billing::infer_scenario(action, active, target, current, winback, history)
    };

    // Polar's current subscription outranks the caller's requested action.
    assert_eq!(
        infer(BillingAction::New, true, PaidPlanTier::Pro, PlanTier::Pro, true, true),
        BillingScenario::ActiveNoChange
    );
    assert_eq!(
        infer(BillingAction::New, true, PaidPlanTier::Pro, PlanTier::Premium, false, true),
        BillingScenario::Upgrade
    );
    assert_eq!(
        infer(BillingAction::Auto, true, PaidPlanTier::Premium, PlanTier::Pro, false, true),
        BillingScenario::Change
    );
    assert_eq!(
        infer(BillingAction::Auto, true, PaidPlanTier::Pro, PlanTier::Free, false, true),
        BillingScenario::Upgrade
    );

    // Explicit actions apply only without an active subscription.
    assert_eq!(
        infer(BillingAction::New, false, PaidPlanTier::Premium, PlanTier::Free, true, true),
        BillingScenario::New
    );
    assert_eq!(
        infer(BillingAction::Upgrade, false, PaidPlanTier::Pro, PlanTier::Free, false, false),
        BillingScenario::Upgrade
    );
    assert_eq!(
        infer(BillingAction::Change, false, PaidPlanTier::Premium, PlanTier::Free, false, false),
        BillingScenario::Change
    );
    assert_eq!(
        infer(BillingAction::Reactivate, false, PaidPlanTier::Premium, PlanTier::Free, false, true),
        BillingScenario::Reactivate
    );
    assert_eq!(
        infer(BillingAction::Reactivate, false, PaidPlanTier::Premium, PlanTier::Free, true, true),
        BillingScenario::ReturningWinback
    );

    // `auto` infers from history and the winback window.
    assert_eq!(
        infer(BillingAction::Auto, false, PaidPlanTier::Premium, PlanTier::Free, true, true),
        BillingScenario::ReturningWinback
    );
    assert_eq!(
        infer(BillingAction::Auto, false, PaidPlanTier::Premium, PlanTier::Free, false, true),
        BillingScenario::Reactivate
    );
    assert_eq!(
        infer(BillingAction::Auto, false, PaidPlanTier::Premium, PlanTier::Free, true, false),
        BillingScenario::New
    );
}

#[test]
fn existing_paid_subscriptions_route_to_the_customer_portal() {
    assert_eq!(
        billing::plan_checkout_flow(Some(PLAN_PRODUCT_ID_PREMIUM)),
        CheckoutFlow::CustomerPortal
    );
    assert_eq!(
        billing::plan_checkout_flow(Some(PLAN_PRODUCT_ID_PRO)),
        CheckoutFlow::CustomerPortal
    );
    assert_eq!(
        billing::plan_checkout_flow(Some(PLAN_PRODUCT_ID_FREE)),
        CheckoutFlow::Checkout
    );
    assert_eq!(billing::plan_checkout_flow(None), CheckoutFlow::Checkout);
    assert_eq!(
        billing::plan_checkout_flow(Some("00000000-0000-4000-8000-000000000000")),
        CheckoutFlow::Checkout
    );
}

#[test]
fn the_active_product_selects_the_current_plan() {
    assert_eq!(
        billing::plan_tier_name(billing::get_current_plan_from_active_subscription(
            PlanTier::Free,
            Some(PLAN_PRODUCT_ID_PRO)
        )),
        "pro"
    );
    assert_eq!(
        billing::plan_tier_name(billing::get_current_plan_from_active_subscription(
            PlanTier::Free,
            Some(PLAN_PRODUCT_ID_PREMIUM)
        )),
        "premium"
    );
    assert_eq!(
        billing::plan_tier_name(billing::get_current_plan_from_active_subscription(
            PlanTier::Premium,
            Some(PLAN_PRODUCT_ID_FREE)
        )),
        "free"
    );
    assert_eq!(
        billing::plan_tier_name(billing::get_current_plan_from_active_subscription(PlanTier::Pro, None)),
        "pro"
    );
}

#[test]
fn the_paid_plan_prefers_pro_over_premium() {
    let subscription = |id: &str, product: &str| PolarSubscription {
        id: id.into(),
        product_id: Some(product.into()),
        ..PolarSubscription::default()
    };
    let subscriptions = vec![
        subscription("premium-sub", PLAN_PRODUCT_ID_PREMIUM),
        subscription("pro-sub", PLAN_PRODUCT_ID_PRO),
        subscription("free-sub", PLAN_PRODUCT_ID_FREE),
    ];
    assert_eq!(
        billing::get_paid_plan_from_subscriptions(&subscriptions),
        Some(PaidPlanTier::Pro)
    );
    assert_eq!(
        billing::get_paid_subscription_from_subscriptions(&subscriptions).map(|(_, s)| s.id.as_str()),
        Some("pro-sub")
    );

    let premium_only = vec![subscription("premium-sub", PLAN_PRODUCT_ID_PREMIUM)];
    assert_eq!(
        billing::get_paid_plan_from_subscriptions(&premium_only),
        Some(PaidPlanTier::Premium)
    );

    let free_only = vec![subscription("free-sub", PLAN_PRODUCT_ID_FREE)];
    assert_eq!(billing::get_paid_plan_from_subscriptions(&free_only), None);
    assert_eq!(billing::get_paid_plan_from_subscriptions(&[]), None);
}

#[test]
fn redirect_urls_are_sanitized_against_the_allow_list() {
    let config = BillingConfig::default()
        .with_default_url(DefaultUrl::Success, "https://app.example.com/success")
        .with_default_url(DefaultUrl::Return, "https://app.example.com/return")
        .with_default_url(DefaultUrl::PortalReturn, "https://app.example.com/portal");

    // No allow list configured: any absolute URL is accepted as-is.
    assert_eq!(
        billing::sanitize_redirect_url(&config, Some("https://elsewhere.example/x"), DefaultUrl::Success)
            .as_deref(),
        Some("https://elsewhere.example/x")
    );
    // A relative or empty value falls back to the configured default.
    assert_eq!(
        billing::sanitize_redirect_url(&config, Some("not a url"), DefaultUrl::Success).as_deref(),
        Some("https://app.example.com/success")
    );
    assert_eq!(
        billing::sanitize_redirect_url(&config, Some(""), DefaultUrl::Return).as_deref(),
        Some("https://app.example.com/return")
    );
    assert_eq!(
        billing::sanitize_redirect_url(&config, None, DefaultUrl::PortalReturn).as_deref(),
        Some("https://app.example.com/portal")
    );

    let allow_listed = config
        .clone()
        .with_allowed_redirect_hosts(["APP.example.com".to_string()]);
    assert_eq!(
        billing::sanitize_redirect_url(
            &allow_listed,
            Some("https://app.example.com/ok"),
            DefaultUrl::Success
        )
        .as_deref(),
        Some("https://app.example.com/ok")
    );
    assert_eq!(
        billing::sanitize_redirect_url(
            &allow_listed,
            Some("https://elsewhere.example/x"),
            DefaultUrl::Success
        )
        .as_deref(),
        Some("https://app.example.com/success")
    );

    // The source normalises a bare origin through `new URL(...).toString()`.
    let bare = BillingConfig::default().with_default_url(DefaultUrl::Success, "https://app.example.com");
    assert_eq!(
        billing::sanitize_redirect_url(&bare, None, DefaultUrl::Success).as_deref(),
        Some("https://app.example.com/")
    );
}

#[test]
fn redirect_hosts_are_parsed_from_the_source_environment_name() {
    let config = BillingConfig::from_lookup(|name| match name {
        "BILLING_ALLOWED_REDIRECT_HOSTS" => Some(" A.example.com , ,b.example.com ".into()),
        "BILLING_SUCCESS_URL" => Some("https://fallback.example/success".into()),
        _ => None,
    });
    assert_eq!(
        billing::sanitize_redirect_url(&config, Some("https://a.example.com/ok"), DefaultUrl::Success)
            .as_deref(),
        Some("https://a.example.com/ok")
    );
    assert_eq!(
        billing::sanitize_redirect_url(&config, Some("https://c.example.com/ok"), DefaultUrl::Success)
            .as_deref(),
        Some("https://fallback.example/success")
    );
    // An invalid default URL is dropped instead of being re-emitted.
    let no_default = BillingConfig::from_lookup(|name| match name {
        "BILLING_ALLOWED_REDIRECT_HOSTS" => Some("app.example.com".into()),
        "BILLING_SUCCESS_URL" => Some("not a valid url".into()),
        _ => None,
    });
    assert_eq!(
        billing::sanitize_redirect_url(&no_default, Some("https://x.example/ok"), DefaultUrl::Success),
        None
    );
}

#[test]
fn the_context_cache_key_is_the_hashed_source_key() {
    let key = billing::credit_pack_billing_context_cache_key("cust");
    assert!(key.starts_with("billing:credit-packs:context:v1:"));
    let hash = &key["billing:credit-packs:context:v1:".len()..];
    assert_eq!(hash.len(), 20);
    assert!(hash.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
    assert_ne!(key, billing::credit_pack_billing_context_cache_key("other"));

    // Known SHA-256 vector: sha256("") = e3b0c44298fc1c149afb...
    assert_eq!(
        billing::credit_pack_billing_context_cache_key(""),
        "billing:credit-packs:context:v1:e3b0c44298fc1c149afb"
    );
}

#[test]
fn cached_contexts_normalise_free_and_reject_expired_values() {
    let now = parse_date("2026-11-01T00:00:00.000Z").expect("date") as f64;

    let free = billing::valid_cached_billing_context(
        &json!({"version": 1, "planTier": "free", "expiresAt": "2027-01-01T00:00:00.000Z"}),
        now,
    )
    .expect("free context");
    assert_eq!(billing::plan_tier_name(free.plan_tier), "free");
    assert_eq!(free.expires_at, None);

    let paid = billing::valid_cached_billing_context(
        &json!({"version": 1, "planTier": "pro", "expiresAt": "2026-12-01T00:00:00.000Z"}),
        now,
    )
    .expect("paid context");
    assert_eq!(billing::plan_tier_name(paid.plan_tier), "pro");
    assert_eq!(paid.expires_at.as_deref(), Some("2026-12-01T00:00:00.000Z"));

    // Wrong version, unknown tier, expired timestamp, and a non-object payload.
    assert!(billing::valid_cached_billing_context(
        &json!({"version": 2, "planTier": "pro", "expiresAt": "2026-12-01T00:00:00.000Z"}),
        now
    )
    .is_none());
    assert!(billing::valid_cached_billing_context(&json!({"version": 1, "planTier": "gold"}), now).is_none());
    assert!(billing::valid_cached_billing_context(
        &json!({"version": 1, "planTier": "premium", "expiresAt": "2026-11-01T00:00:00.000Z"}),
        now
    )
    .is_none());
    assert!(billing::valid_cached_billing_context(
        &json!({"version": 1, "planTier": "premium"}),
        now
    )
    .is_none());
    assert!(billing::valid_cached_billing_context(&json!("pro"), now).is_none());
}

#[test]
fn metadata_compaction_drops_empty_and_structural_values() {
    let metadata = billing::compact_metadata(&[
        ("source", Some(json!("dimabot_billing"))),
        ("blank", Some(json!("   "))),
        ("missing", None),
        ("null", Some(json!(null))),
        ("count", Some(json!(3))),
        ("flag", Some(json!(true))),
        ("object", Some(json!({"a": 1}))),
    ]);
    assert_eq!(metadata.get("source"), Some(&json!("dimabot_billing")));
    assert_eq!(metadata.get("count"), Some(&json!(3)));
    assert_eq!(metadata.get("flag"), Some(&json!(true)));
    for dropped in ["blank", "missing", "null", "object"] {
        assert!(!metadata.contains_key(dropped), "{dropped} must be dropped");
    }
}

#[test]
fn portal_session_payload_and_response_map_the_source_fields() {
    let without_return = billing::portal_session_payload("cust-1", None);
    assert_eq!(without_return, json!({"customer_id": "cust-1"}));

    let with_return = billing::portal_session_payload(
        "cust-1",
        Some("https://app.example.com/portal"),
    );
    assert_eq!(
        with_return,
        json!({
            "customer_id": "cust-1",
            "return_url": "https://app.example.com/portal",
        })
    );

    let session = json!({
        "id": "ses_1",
        "customer_portal_url": "https://polar.sh/portal/ses_1",
        "expires_at": "2026-11-01T01:00:00.000Z",
    });
    let response = billing::portal_session_from_response(&session).expect("response");
    assert_eq!(response.session_id, "ses_1");
    assert_eq!(response.url, "https://polar.sh/portal/ses_1");
    assert_eq!(response.expires_at.as_deref(), Some("2026-11-01T01:00:00.000Z"));

    let no_expiry = billing::portal_session_from_response(&json!({
        "id": "ses_2",
        "customer_portal_url": "https://polar.sh/portal/ses_2",
    }))
    .expect("response");
    assert_eq!(no_expiry.expires_at, None);

    let error = billing::portal_session_from_response(&json!({"id": "ses_3"}))
        .expect_err("must fail");
    assert_eq!(
        error.to_string(),
        "Polar provider response is missing customer_portal_url"
    );
}

#[test]
fn billing_errors_keep_the_source_messages() {
    assert_eq!(
        billing::BillingError::AlreadySubscribed.to_string(),
        "You are already subscribed to this plan."
    );
    assert_eq!(
        billing::BillingError::CustomerMissingPolarId.to_string(),
        "Customer does not have a Polar customer ID."
    );
    assert_eq!(
        billing::BillingError::InvalidPromoCode.to_string(),
        "Invalid or inapplicable promo code for the selected plan."
    );
    assert_eq!(
        billing::BillingError::CreditPack(billing::CreditPackRequestError::invalid_product())
            .to_string(),
        "Invalid credit pack product"
    );
    assert_eq!(
        billing::CreditPackRequestError::invalid_product().status_code,
        400
    );
    assert_eq!(
        billing::CreditPackRequestError::paid_plan_required().to_string(),
        "Recharge packs require an active Premium or Pro subscription"
    );
    assert_eq!(
        billing::CreditPackRequestError::paid_plan_required().status_code,
        403
    );
}

#[test]
fn uuid_v4_detection_matches_the_source_regex() {
    assert!(billing::is_uuid_v4(Some("5103e79b-fd74-4ba8-a287-f95574f9addf")));
    assert!(billing::is_uuid_v4(Some(" 5103E79B-FD74-4BA8-A287-F95574F9ADDF ")));
    // Version and variant nibbles must match.
    assert!(!billing::is_uuid_v4(Some("5103e79b-fd74-3ba8-a287-f95574f9addf")));
    assert!(!billing::is_uuid_v4(Some("5103e79b-fd74-4ba8-1287-f95574f9addf")));
    assert!(!billing::is_uuid_v4(Some("5103e79b-fd74-4ba8-a287-f95574f9add")));
    assert!(!billing::is_uuid_v4(Some("not-a-uuid")));
    assert!(!billing::is_uuid_v4(None));
    assert!(!billing::is_uuid_v4(Some("")));
}

#[test]
fn month_differences_count_only_whole_elapsed_months() {
    assert_eq!(
        billing::diff_months(date("2026-01-15T00:00:00.000Z"), date("2026-07-20T00:00:00.000Z")),
        6.0
    );
    // The day-of-month has not been reached yet, so February is incomplete.
    assert_eq!(
        billing::diff_months(date("2026-01-31T00:00:00.000Z"), date("2026-02-28T00:00:00.000Z")),
        0.0
    );
    assert_eq!(
        billing::diff_months(date("2026-03-01T00:00:00.000Z"), date("2025-12-31T00:00:00.000Z")),
        0.0
    );
    assert_eq!(
        billing::diff_months(date("2025-01-01T00:00:00.000Z"), date("2026-01-01T00:00:00.000Z")),
        12.0
    );
}

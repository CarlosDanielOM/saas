#![cfg(feature = "polar-billing-events")]

//! Decision boundaries for `domain_event_contracts::polar_billing::entitlements`
//! (source: `src/domain_events/polar_entitlements.ts`). Pure logic only: the
//! provider is represented by an in-file grace lookup, so no network is used.

use dima_rust::domain_event_contracts::polar_billing::entitlements::{
    self, EntitlementError, MAX_GRACE_GRANT_PAGES, MAX_GRACE_SUBSCRIPTIONS, POLAR_PLAN_EVENT_TYPES,
    PolarDate, PolarEntitlementGrant, PolarEntitlementState, PolarEntitlementSubscription,
    PolarGraceLookup, PolarGraceSubscription, PolarGrantRecord, absorb_grant_page,
    polar_entitlement_fingerprint, requested_grants, subscription_expiry,
};
use dima_rust::domain_event_contracts::polar_billing::BillingFuture;
use dima_rust::utils::billing::{PLAN_PRODUCT_ID_FREE, PLAN_PRODUCT_ID_PREMIUM, PLAN_PRODUCT_ID_PRO};
use dima_rust::utils::js_date::parse_date;
use serde_json::Value;
use sha2::{Digest, Sha256};

fn ms(value: &str) -> i64 {
    parse_date(value).expect("fixture date")
}

fn at(value: Option<&str>) -> Option<PolarDate> {
    value.map(|value| PolarDate::Millis(ms(value)))
}

#[allow(clippy::too_many_arguments)]
fn subscription(
    id: &str,
    product_id: &str,
    status: &str,
    current_period_end: Option<&str>,
    ends_at: Option<&str>,
    trial_start: Option<&str>,
    trial_end: Option<&str>,
) -> PolarEntitlementSubscription {
    PolarEntitlementSubscription {
        id: id.into(),
        product_id: product_id.into(),
        status: status.into(),
        current_period_end: at(current_period_end),
        ends_at: at(ends_at),
        trial_start: at(trial_start),
        trial_end: at(trial_end),
    }
}

fn grant(id: &str, benefit_id: &str) -> PolarEntitlementGrant {
    PolarEntitlementGrant {
        id: id.into(),
        benefit_id: benefit_id.into(),
    }
}

struct FixedGrace(Vec<PolarGraceSubscription>);

impl PolarGraceLookup for FixedGrace {
    fn grace_subscriptions<'a>(
        &'a self,
        _customer_id: &'a str,
        _grants: &'a [PolarEntitlementGrant],
    ) -> BillingFuture<'a, Vec<PolarGraceSubscription>> {
        let subscriptions = self.0.clone();
        Box::pin(async move { Ok(subscriptions) })
    }
}

fn no_grace() -> FixedGrace {
    FixedGrace(Vec::new())
}

async fn resolve(
    state: &PolarEntitlementState,
    customer_id: &str,
    now: i64,
    grace: &FixedGrace,
) -> Result<entitlements::PolarPlan, EntitlementError> {
    entitlements::resolve_polar_entitled_plan(state, customer_id, now, grace).await
}

#[test]
fn the_plan_event_type_list_matches_the_source_expansion() {
    // 3 billing + 6 subscription + 4 benefit_grant, in source order.
    assert_eq!(POLAR_PLAN_EVENT_TYPES.len(), 13);
    assert_eq!(POLAR_PLAN_EVENT_TYPES[0], "billing.order.paid");
    assert_eq!(POLAR_PLAN_EVENT_TYPES[2], "billing.customer.state.changed");
    assert_eq!(POLAR_PLAN_EVENT_TYPES[3], "provider.polar.subscription.created");
    assert_eq!(POLAR_PLAN_EVENT_TYPES[8], "provider.polar.subscription.revoked");
    assert_eq!(POLAR_PLAN_EVENT_TYPES[9], "provider.polar.benefit_grant.created");
    assert_eq!(POLAR_PLAN_EVENT_TYPES[12], "provider.polar.benefit_grant.revoked");
}

#[test]
fn the_product_tier_mapping_only_ranks_the_paid_products() {
    assert_eq!(
        entitlements::plan_tier_name(entitlements::plan_tier_for_product(
            PLAN_PRODUCT_ID_PRO
        )),
        "pro"
    );
    assert_eq!(
        entitlements::plan_tier_name(entitlements::plan_tier_for_product(
            PLAN_PRODUCT_ID_PREMIUM
        )),
        "premium"
    );
    assert_eq!(
        entitlements::plan_tier_name(entitlements::plan_tier_for_product(PLAN_PRODUCT_ID_FREE)),
        "free"
    );
    assert_eq!(
        entitlements::plan_tier_name(entitlements::plan_tier_for_product(
            "00000000-0000-4000-8000-000000000000"
        )),
        "free"
    );
}

#[test]
fn the_expiry_is_the_earliest_period_or_ends_at() {
    let subscription = subscription(
        "sub",
        PLAN_PRODUCT_ID_PREMIUM,
        "active",
        Some("2026-10-10T00:00:00Z"),
        Some("2026-10-05T00:00:00Z"),
        None,
        None,
    );
    assert_eq!(
        subscription_expiry(&subscription).expect("expiry"),
        Some(ms("2026-10-05T00:00:00Z"))
    );

    let without_period = subscription(
        "sub",
        PLAN_PRODUCT_ID_PREMIUM,
        "active",
        None,
        Some("2026-10-05T00:00:00Z"),
        None,
        None,
    );
    assert_eq!(
        subscription_expiry(&without_period).expect("expiry"),
        Some(ms("2026-10-05T00:00:00Z"))
    );

    let open_ended = subscription(
        "sub",
        PLAN_PRODUCT_ID_PREMIUM,
        "active",
        None,
        None,
        None,
        None,
    );
    assert_eq!(subscription_expiry(&open_ended).expect("expiry"), None);
}

#[test]
fn the_trial_end_counts_only_while_trialing() {
    let trialing = subscription(
        "sub",
        PLAN_PRODUCT_ID_PREMIUM,
        "trialing",
        Some("2026-12-01T00:00:00Z"),
        None,
        Some("2026-08-01T00:00:00Z"),
        Some("2026-08-10T00:00:00Z"),
    );
    assert_eq!(
        subscription_expiry(&trialing).expect("expiry"),
        Some(ms("2026-08-10T00:00:00Z"))
    );

    // An active subscription ignores a stale trial end entirely.
    let active = PolarEntitlementSubscription {
        status: "active".into(),
        ..trialing
    };
    assert_eq!(
        subscription_expiry(&active).expect("expiry"),
        Some(ms("2026-12-01T00:00:00Z"))
    );
}

#[test]
fn an_invalid_date_is_a_typed_expiry_error() {
    let mut subscription = subscription(
        "sub",
        PLAN_PRODUCT_ID_PREMIUM,
        "active",
        Some("2026-12-01T00:00:00Z"),
        None,
        None,
        None,
    );
    subscription.ends_at = Some(PolarDate::Invalid);
    assert_eq!(
        subscription_expiry(&subscription),
        Err(EntitlementError::InvalidExpiry)
    );
    assert_eq!(
        EntitlementError::InvalidExpiry.to_string(),
        "Polar entitlement has an invalid expiry"
    );

    // An absent (null) date contributes nothing.
    subscription.ends_at = None;
    subscription.current_period_end = None;
    assert_eq!(subscription_expiry(&subscription), Ok(None));
}

#[tokio::test]
async fn active_and_trialing_subscriptions_grant_and_expired_ones_do_not() {
    let now = ms("2026-09-04T10:00:00Z");
    let state = PolarEntitlementState {
        id: "customer".into(),
        active_subscriptions: vec![
            subscription(
                "expired",
                PLAN_PRODUCT_ID_PRO,
                "active",
                Some("2020-01-01T00:00:00Z"),
                None,
                None,
                None,
            ),
            subscription("unpaid", PLAN_PRODUCT_ID_PRO, "unpaid", None, None, None, None),
            subscription(
                "incomplete",
                PLAN_PRODUCT_ID_PRO,
                "incomplete",
                None,
                None,
                None,
                None,
            ),
            subscription(
                "past-due",
                PLAN_PRODUCT_ID_PRO,
                "past_due",
                None,
                None,
                None,
                None,
            ),
            subscription(
                "canceled",
                PLAN_PRODUCT_ID_PRO,
                "canceled",
                None,
                None,
                None,
                None,
            ),
            subscription(
                "short",
                PLAN_PRODUCT_ID_PREMIUM,
                "active",
                Some("2026-10-01T00:00:00Z"),
                None,
                None,
                None,
            ),
            subscription(
                "long",
                PLAN_PRODUCT_ID_PREMIUM,
                "active",
                Some("2026-11-01T00:00:00Z"),
                None,
                None,
                None,
            ),
        ],
        granted_benefits: Vec::new(),
    };
    let plan = resolve(&state, "customer", now, &no_grace())
        .await
        .expect("plan");
    // Same tier: the longer access wins. Expired/unpaid/other states never grant.
    assert_eq!(entitlements::plan_tier_name(plan.plan_tier), "premium");
    assert_eq!(plan.until, Some(ms("2026-11-01T00:00:00Z")));
}

#[tokio::test]
async fn the_highest_ranked_tier_wins_a_weaker_active_subscription() {
    let now = ms("2026-09-04T10:00:00Z");
    let state = PolarEntitlementState {
        id: "customer".into(),
        active_subscriptions: vec![
            subscription(
                "premium",
                PLAN_PRODUCT_ID_PREMIUM,
                "active",
                Some("2026-12-01T00:00:00Z"),
                None,
                None,
                None,
            ),
            subscription(
                "pro",
                PLAN_PRODUCT_ID_PRO,
                "active",
                Some("2026-11-01T00:00:00Z"),
                None,
                None,
                None,
            ),
        ],
        granted_benefits: Vec::new(),
    };
    let plan = resolve(&state, "customer", now, &no_grace())
        .await
        .expect("plan");
    assert_eq!(entitlements::plan_tier_name(plan.plan_tier), "pro");
    assert_eq!(plan.until, Some(ms("2026-11-01T00:00:00Z")));

    // A free product id never replaces a paid tier.
    let state = PolarEntitlementState {
        id: "customer".into(),
        active_subscriptions: vec![subscription(
            "free",
            PLAN_PRODUCT_ID_FREE,
            "active",
            Some("2026-12-01T00:00:00Z"),
            None,
            None,
            None,
        )],
        granted_benefits: Vec::new(),
    };
    let plan = resolve(&state, "customer", now, &no_grace())
        .await
        .expect("plan");
    assert_eq!(entitlements::plan_tier_name(plan.plan_tier), "free");
    assert_eq!(plan.until, None);
}

#[tokio::test]
async fn a_live_grant_backs_past_due_grace_with_no_deadline() {
    let now = ms("2026-09-04T10:00:00Z");
    let state = PolarEntitlementState {
        id: "customer".into(),
        active_subscriptions: Vec::new(),
        granted_benefits: vec![grant("live-grant", "benefit-1")],
    };
    let grace = FixedGrace(vec![PolarGraceSubscription {
        customer_id: "customer".into(),
        subscription: subscription(
            "premium-sub",
            PLAN_PRODUCT_ID_PREMIUM,
            "past_due",
            Some("2026-11-10T00:00:00Z"),
            None,
            None,
            None,
        ),
    }]);
    let plan = resolve(&state, "customer", now, &grace).await.expect("plan");
    assert_eq!(entitlements::plan_tier_name(plan.plan_tier), "premium");
    // Polar owns the deadline during past_due, so the plan has no expiry.
    assert_eq!(plan.until, None);

    // A past_due subscription that is NOT linked to a grant grants nothing.
    let no_grant_state = PolarEntitlementState {
        id: "customer".into(),
        active_subscriptions: Vec::new(),
        granted_benefits: Vec::new(),
    };
    let plan = resolve(&no_grant_state, "customer", now, &grace)
        .await
        .expect("plan");
    assert_eq!(entitlements::plan_tier_name(plan.plan_tier), "free");
}

#[tokio::test]
async fn an_active_pro_subscription_skips_the_grace_lookup() {
    let now = ms("2026-09-04T10:00:00Z");
    let state = PolarEntitlementState {
        id: "customer".into(),
        active_subscriptions: vec![subscription(
            "pro",
            PLAN_PRODUCT_ID_PRO,
            "active",
            Some("2026-12-01T00:00:00Z"),
            None,
            None,
            None,
        )],
        granted_benefits: vec![grant("grant", "benefit")],
    };
    // A lookup that would report a customer mismatch must never be consulted.
    let grace = FixedGrace(vec![PolarGraceSubscription {
        customer_id: "elsewhere".into(),
        subscription: subscription(
            "x",
            PLAN_PRODUCT_ID_PRO,
            "past_due",
            None,
            None,
            None,
            None,
        ),
    }]);
    let plan = resolve(&state, "customer", now, &grace).await.expect("plan");
    assert_eq!(entitlements::plan_tier_name(plan.plan_tier), "pro");
}

#[tokio::test]
async fn the_state_must_belong_to_the_customer() {
    let state = PolarEntitlementState {
        id: "other-customer".into(),
        active_subscriptions: Vec::new(),
        granted_benefits: Vec::new(),
    };
    let error = resolve(&state, "customer", 0, &no_grace())
        .await
        .expect_err("must fail");
    assert_eq!(
        error.to_string(),
        "Polar entitlement state is missing or belongs to another customer"
    );

    // A response without both arrays is the same failure.
    let error = PolarEntitlementState::from_json(&serde_json::json!({"id": "customer"}))
        .expect_err("must fail");
    assert_eq!(error, EntitlementError::StateMissingOrForeign);
    assert!(PolarEntitlementState::from_json(&serde_json::json!({
        "id": "customer", "active_subscriptions": [], "granted_benefits": []
    }))
    .is_ok());
}

#[tokio::test]
async fn malformed_subscriptions_and_grants_are_typed_errors() {
    let mut malformed = subscription(
        "",
        PLAN_PRODUCT_ID_PREMIUM,
        "active",
        Some("2026-12-01T00:00:00Z"),
        None,
        None,
        None,
    );
    let state = PolarEntitlementState {
        id: "customer".into(),
        active_subscriptions: vec![malformed.clone()],
        granted_benefits: Vec::new(),
    };
    assert_eq!(
        resolve(&state, "customer", 0, &no_grace())
            .await
            .expect_err("must fail")
            .to_string(),
        "Malformed Polar entitlement subscription"
    );

    // Only included (active/trialing) subscriptions are validated.
    malformed.status = "canceled".into();
    let state = PolarEntitlementState {
        id: "customer".into(),
        active_subscriptions: vec![malformed],
        granted_benefits: Vec::new(),
    };
    assert!(resolve(&state, "customer", 0, &no_grace()).await.is_ok());

    let state = PolarEntitlementState {
        id: "customer".into(),
        active_subscriptions: Vec::new(),
        granted_benefits: vec![grant("grant", "")],
    };
    assert_eq!(
        resolve(&state, "customer", 0, &no_grace())
            .await
            .expect_err("must fail")
            .to_string(),
        "Malformed Polar entitlement grant"
    );
}

#[tokio::test]
async fn a_grace_subscription_for_another_customer_is_rejected() {
    let state = PolarEntitlementState {
        id: "customer".into(),
        active_subscriptions: Vec::new(),
        granted_benefits: vec![grant("grant", "benefit")],
    };
    let grace = FixedGrace(vec![PolarGraceSubscription {
        customer_id: "elsewhere".into(),
        subscription: subscription(
            "sub",
            PLAN_PRODUCT_ID_PREMIUM,
            "past_due",
            None,
            None,
            None,
            None,
        ),
    }]);
    assert_eq!(
        resolve(&state, "customer", 0, &grace)
            .await
            .expect_err("must fail")
            .to_string(),
        "Polar grace subscription customer mismatch"
    );
}

fn grant_record(id: &str, benefit_id: &str, subscription_id: Option<&str>) -> PolarGrantRecord {
    PolarGrantRecord {
        id: id.into(),
        benefit_id: benefit_id.into(),
        customer_id: "customer".into(),
        is_granted: true,
        is_revoked: false,
        subscription_id: subscription_id.map(str::to_owned),
    }
}

#[test]
fn only_live_matching_subscription_linked_grants_are_collected() {
    let requested = requested_grants(&[grant("live", "shared-benefit")]);
    let mut ids = Vec::new();
    let page = vec![
        grant_record("live", "shared-benefit", Some("grace-sub")),
        grant_record("live", "shared-benefit", Some("grace-sub")),
        grant_record("live", "shared-benefit", None),
        PolarGrantRecord {
            is_revoked: true,
            ..grant_record("live", "shared-benefit", Some("revoked"))
        },
        PolarGrantRecord {
            is_granted: false,
            ..grant_record("live", "shared-benefit", Some("not-granted"))
        },
        PolarGrantRecord {
            customer_id: "elsewhere".into(),
            ..grant_record("live", "shared-benefit", Some("other-customer"))
        },
        PolarGrantRecord {
            benefit_id: "different".into(),
            ..grant_record("live", "shared-benefit", Some("wrong-benefit"))
        },
        grant_record("unlisted", "shared-benefit", Some("unlisted")),
    ];
    let finished = absorb_grant_page(&requested, "customer", &page, &mut ids, 1, Some(2.0))
        .expect("page");
    assert!(!finished, "page 1 of 2 is not the last page");
    assert_eq!(ids, vec!["grace-sub".to_owned()]);
}

#[test]
fn more_than_twenty_collected_subscriptions_exceed_the_bound() {
    let requested = requested_grants(&[grant("grant", "benefit")]);
    let mut ids = Vec::new();
    let grants: Vec<_> = (0..=MAX_GRACE_SUBSCRIPTIONS)
        .map(|index| {
            let subscription_id = format!("subscription-{index}");
            grant_record("grant", "benefit", Some(&subscription_id))
        })
        .collect();
    assert_eq!(grants.len(), MAX_GRACE_SUBSCRIPTIONS + 1);
    assert_eq!(
        absorb_grant_page(&requested, "customer", &grants, &mut ids, 1, Some(1.0)),
        Err(EntitlementError::SubscriptionLookupExceeded)
    );
    assert_eq!(
        EntitlementError::SubscriptionLookupExceeded.to_string(),
        "Polar entitlement subscription lookup exceeded bounded scope"
    );
}

#[test]
fn exhausting_the_five_page_cap_without_max_page_fails_the_scan() {
    let requested = requested_grants(&[grant("grant", "benefit")]);
    let mut ids = Vec::new();
    let page = vec![grant_record("grant", "benefit", Some("subscription"))];
    let mut finished = false;
    for index in 1..=MAX_GRACE_GRANT_PAGES {
        finished = absorb_grant_page(&requested, "customer", &page, &mut ids, index, Some(6.0))
            .expect("page");
        if finished {
            break;
        }
    }
    assert_eq!(MAX_GRACE_GRANT_PAGES, 5);
    assert!(!finished, "a six-page result exhausts the bounded scan");
    assert_eq!(
        EntitlementError::GrantLookupExceeded.to_string(),
        "Polar entitlement grant lookup exceeded bounded scope"
    );
}

/// Reference implementation of the source's fingerprint, including its
/// `JSON.stringify(row).localeCompare(...)` sort through ICU root collation.
fn reference_fingerprint(
    subscriptions: &[PolarEntitlementSubscription],
    grants: &[PolarEntitlementGrant],
) -> String {
    let collator = icu_collator::Collator::try_new(Default::default(), Default::default())
        .expect("collator");
    let iso = |date: Option<PolarDate>| match date {
        None => Value::Null,
        Some(PolarDate::Millis(millis)) => Value::String(
            dima_rust::utils::credit_policy::JsDate::from_millis(millis as f64)
                .to_iso_string()
                .expect("iso"),
        ),
        Some(PolarDate::Invalid) => panic!("invalid date"),
    };
    let mut rows: Vec<String> = subscriptions
        .iter()
        .map(|subscription| {
            serde_json::to_string(&serde_json::json!([
                subscription.id,
                subscription.product_id,
                subscription.status,
                iso(subscription.current_period_end),
                iso(subscription.ends_at),
                iso(subscription.trial_start),
                iso(subscription.trial_end),
            ]))
            .expect("row")
        })
        .collect();
    rows.sort_by(|left, right| collator.compare(left, right));
    let mut grant_rows: Vec<String> = grants
        .iter()
        .map(|grant| {
            serde_json::to_string(&serde_json::json!([grant.id, grant.benefit_id])).expect("row")
        })
        .collect();
    grant_rows.sort_by(|left, right| collator.compare(left, right));
    let document = format!("[{},{}]", rows.join(","), grant_rows.join(","));
    format!("{:x}", Sha256::digest(document.as_bytes()))
}

#[test]
fn the_fingerprint_is_order_independent_and_content_sensitive() {
    // `"a"` vs `"B"` discriminates locale collation from codepoint order.
    let first = subscription(
        "a",
        PLAN_PRODUCT_ID_PREMIUM,
        "active",
        Some("2026-10-04T10:00:00Z"),
        None,
        None,
        None,
    );
    let second = subscription(
        "B",
        PLAN_PRODUCT_ID_PRO,
        "trialing",
        None,
        Some("2026-11-04T10:00:00Z"),
        Some("2026-09-01T00:00:00Z"),
        Some("2026-09-10T00:00:00Z"),
    );
    let grants = vec![grant("g2", "b2"), grant("g1", "b1")];

    let ordered =
        polar_entitlement_fingerprint(&[first.clone(), second.clone()], &grants).expect("hash");
    let reordered =
        polar_entitlement_fingerprint(&[second.clone(), first.clone()], &grants).expect("hash");
    assert_eq!(ordered, reordered, "sorting removes input order");
    assert_eq!(ordered, reference_fingerprint(&[first.clone(), second.clone()], &grants));

    // Changing a single field changes the digest.
    let changed = PolarEntitlementSubscription {
        status: "canceled".into(),
        ..first.clone()
    };
    assert_ne!(
        ordered,
        polar_entitlement_fingerprint(&[changed, second.clone()], &grants).expect("hash")
    );
    // An unparseable date is rejected rather than silently normalized.
    let invalid = PolarEntitlementSubscription {
        ends_at: Some(PolarDate::Invalid),
        ..second
    };
    assert_eq!(
        polar_entitlement_fingerprint(&[invalid], &[]),
        Err(EntitlementError::InvalidExpiry)
    );
}

#![cfg(feature = "billing-service")]

//! Correlation algorithm boundaries for `utils::ai_credit_sources`
//! (source: `src/utils/ai_credit_sources.ts`). Every case is pure logic against
//! an in-file `CreditSourceReads` implementation: no provider, no network.

use dima_rust::utils::{
    ai_credit_projection::AI_CREDITS_METER_ID,
    ai_credit_sources::{
        self, CREDIT_SOURCE_MATCH_MS, CreditGrant, CreditGrantBenefit, CreditGrantProperties,
        CreditOrder, CreditSourceError, CreditSourceEvent, CreditSourceReads, EventTimestamp,
        GIFTED_CREDITS, PURCHASED_PACK, SUBSCRIPTION_CREDITS,
    },
    credit_gift_provider::GIFT_PACK_PAIRS,
    credit_packs::CREDIT_PACK_DEFINITIONS,
};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

const CUSTOMER: &str = "customer-1";

fn metadata(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

fn credit(id: &str, at_ms: i64, units: f64, rollover: bool) -> CreditSourceEvent {
    CreditSourceEvent {
        id: Some(id.into()),
        name: Some("meter.credited".into()),
        timestamp: Some(EventTimestamp::Date(at_ms)),
        metadata: Some(metadata(&[
            ("meterId", json!(AI_CREDITS_METER_ID)),
            ("units", json!(units)),
            ("rollover", json!(rollover)),
        ])),
    }
}

fn benefit(
    event_id: &str,
    grant_id: &str,
    benefit_id: &str,
    at_ms: i64,
) -> CreditSourceEvent {
    CreditSourceEvent {
        id: Some(event_id.into()),
        name: Some("benefit.granted".into()),
        timestamp: Some(EventTimestamp::Date(at_ms)),
        metadata: Some(metadata(&[
            ("benefitType", json!("meter_credit")),
            ("benefitGrantId", json!(grant_id)),
            ("benefitId", json!(benefit_id)),
        ])),
    }
}

#[allow(clippy::too_many_arguments)]
fn grant(
    id: &str,
    customer: &str,
    benefit_id: &str,
    units: f64,
    rollover: bool,
    subscription_id: Option<&str>,
    order_id: Option<&str>,
) -> CreditGrant {
    CreditGrant {
        id: id.into(),
        customer_id: customer.into(),
        benefit_id: benefit_id.into(),
        order_id: order_id.map(str::to_owned),
        subscription_id: subscription_id.map(str::to_owned),
        benefit: CreditGrantBenefit {
            id: benefit_id.into(),
            benefit_type: "meter_credit".into(),
            properties: CreditGrantProperties {
                meter_id: Some(AI_CREDITS_METER_ID.into()),
                units: Some(units),
                rollover: Some(rollover),
            },
        },
    }
}

fn order(
    id: &str,
    customer: &str,
    product_id: &str,
    paid: bool,
    total_amount: f64,
    metadata: Map<String, Value>,
) -> CreditOrder {
    CreditOrder {
        id: id.into(),
        customer_id: customer.into(),
        product_id: product_id.into(),
        subscription_id: None,
        paid,
        total_amount,
        metadata: Some(metadata),
    }
}

#[derive(Default)]
struct MemoryReads {
    grants: BTreeMap<String, CreditGrant>,
    orders: BTreeMap<String, CreditOrder>,
    grant_reads: usize,
    order_reads: usize,
}

impl CreditSourceReads for MemoryReads {
    async fn grant(&mut self, id: &str) -> Result<Option<CreditGrant>, CreditSourceError> {
        self.grant_reads += 1;
        Ok(self.grants.get(id).cloned())
    }

    async fn order(&mut self, id: &str) -> Result<CreditOrder, CreditSourceError> {
        self.order_reads += 1;
        Ok(self.orders.get(id).cloned().unwrap_or_default())
    }
}

async fn classify(
    events: &[CreditSourceEvent],
    reads: &mut MemoryReads,
) -> BTreeMap<String, String> {
    ai_credit_sources::classify_polar_credit_sources(CUSTOMER, events, reads)
        .await
        .expect("classification")
}

fn gift_metadata(gift_id: &str) -> Map<String, Value> {
    metadata(&[
        ("source", json!("dimabot_gift_fulfillment")),
        ("gift_id", json!(gift_id)),
    ])
}

#[tokio::test]
async fn a_unique_subscription_credit_is_classified() {
    let mut reads = MemoryReads::default();
    reads
        .grants
        .insert("g1".into(), grant("g1", CUSTOMER, "b1", 40_000.0, false, Some("sub-1"), None));

    // Subscription grants may drift in units, so only rollover must agree.
    let events = [
        credit("c1", 1_000_000, 25_000.0, false),
        benefit("e1", "g1", "b1", 1_002_000),
    ];
    let result = classify(&events, &mut reads).await;
    assert_eq!(result.get("c1").map(String::as_str), Some(SUBSCRIPTION_CREDITS));
    assert_eq!(reads.order_reads, 0);
}

#[tokio::test]
async fn a_unique_purchased_pack_is_classified() {
    let mut reads = MemoryReads::default();
    reads
        .grants
        .insert("g1".into(), grant("g1", CUSTOMER, "b1", 40_000.0, true, None, Some("o1")));
    reads.orders.insert(
        "o1".into(),
        order(
            "o1",
            CUSTOMER,
            CREDIT_PACK_DEFINITIONS[0].id,
            true,
            1_999.0,
            metadata(&[("source", json!("dimabot_credit_store"))]),
        ),
    );

    let events = [
        credit("c1", 1_000_000, 40_000.0, true),
        benefit("e1", "g1", "b1", 1_001_000),
    ];
    let result = classify(&events, &mut reads).await;
    assert_eq!(result.get("c1").map(String::as_str), Some(PURCHASED_PACK));
}

#[tokio::test]
async fn a_unique_gifted_credit_is_classified() {
    let mut reads = MemoryReads::default();
    reads
        .grants
        .insert("g1".into(), grant("g1", CUSTOMER, "b1", 250_000.0, true, None, Some("o1")));
    reads.orders.insert(
        "o1".into(),
        order(
            "o1",
            CUSTOMER,
            GIFT_PACK_PAIRS[1].fulfillment_product_id,
            true,
            0.0,
            gift_metadata("gift-1"),
        ),
    );

    let events = [
        credit("c1", 1_000_000, 250_000.0, true),
        benefit("e1", "g1", "b1", 1_003_000),
    ];
    let result = classify(&events, &mut reads).await;
    assert_eq!(result.get("c1").map(String::as_str), Some(GIFTED_CREDITS));
}

#[tokio::test]
async fn a_credit_with_two_matching_benefits_is_rejected() {
    let mut reads = MemoryReads::default();
    reads
        .grants
        .insert("g1".into(), grant("g1", CUSTOMER, "b1", 40_000.0, true, None, Some("o1")));
    reads
        .grants
        .insert("g2".into(), grant("g2", CUSTOMER, "b1", 40_000.0, true, None, Some("o2")));
    for id in ["o1", "o2"] {
        reads.orders.insert(
            id.into(),
            order(
                id,
                CUSTOMER,
                CREDIT_PACK_DEFINITIONS[0].id,
                true,
                1_999.0,
                metadata(&[]),
            ),
        );
    }

    // Both benefit events pair with the single credit event: ambiguous.
    let events = [
        credit("c1", 1_000_000, 40_000.0, true),
        benefit("e1", "g1", "b1", 1_001_000),
        benefit("e2", "g2", "b1", 1_002_000),
    ];
    let result = classify(&events, &mut reads).await;
    assert!(result.is_empty(), "ambiguous credits must never be classified");
}

#[tokio::test]
async fn one_benefit_with_two_nearby_credits_is_rejected() {
    let mut reads = MemoryReads::default();
    reads
        .grants
        .insert("g1".into(), grant("g1", CUSTOMER, "b1", 40_000.0, false, Some("sub-1"), None));

    let events = [
        credit("c1", 1_000_000, 10_000.0, false),
        credit("c2", 1_001_000, 10_000.0, false),
        benefit("e1", "g1", "b1", 1_003_000),
    ];
    let result = classify(&events, &mut reads).await;
    assert!(result.is_empty(), "a non-unique benefit must not classify");
}

#[tokio::test]
async fn a_rollover_mismatch_never_pairs() {
    let mut reads = MemoryReads::default();
    reads
        .grants
        .insert("g1".into(), grant("g1", CUSTOMER, "b1", 40_000.0, true, Some("sub-1"), None));

    let events = [
        credit("c1", 1_000_000, 40_000.0, false),
        benefit("e1", "g1", "b1", 1_001_000),
    ];
    let result = classify(&events, &mut reads).await;
    assert!(result.is_empty());
}

#[tokio::test]
async fn a_grant_for_another_customer_never_pairs() {
    let mut reads = MemoryReads::default();
    reads
        .grants
        .insert("g1".into(), grant("g1", "other-customer", "b1", 40_000.0, true, None, Some("o1")));

    let events = [
        credit("c1", 1_000_000, 40_000.0, true),
        benefit("e1", "g1", "b1", 1_001_000),
    ];
    let result = classify(&events, &mut reads).await;
    assert!(result.is_empty());
    assert_eq!(reads.order_reads, 0);
}

#[tokio::test]
async fn unknown_grants_and_grant_field_mismatches_are_skipped() {
    let events = [
        credit("c1", 1_000_000, 40_000.0, true),
        benefit("e1", "missing", "b1", 1_001_000),
    ];
    let mut reads = MemoryReads::default();
    assert!(classify(&events, &mut reads).await.is_empty());

    // benefit.id must equal benefit_id on the grant.
    let mut reads = MemoryReads::default();
    let mut mismatched = grant("g1", CUSTOMER, "b1", 40_000.0, true, None, Some("o1"));
    mismatched.benefit.id = "b2".into();
    reads.grants.insert("g1".into(), mismatched);
    assert!(classify(&events, &mut reads).await.is_empty());

    // The grant's meter must be the AI credits meter.
    let mut reads = MemoryReads::default();
    let mut wrong_meter = grant("g1", CUSTOMER, "b1", 40_000.0, true, None, Some("o1"));
    wrong_meter.benefit.properties.meter_id = Some("other-meter".into());
    reads.grants.insert("g1".into(), wrong_meter);
    assert!(classify(&events, &mut reads).await.is_empty());

    // A benefit event with a different benefit id is skipped too.
    let mut reads = MemoryReads::default();
    reads
        .grants
        .insert("g1".into(), grant("g1", CUSTOMER, "b1", 40_000.0, true, None, Some("o1")));
    let events = [
        credit("c1", 1_000_000, 40_000.0, true),
        benefit("e1", "g1", "b9", 1_001_000),
    ];
    assert!(classify(&events, &mut reads).await.is_empty());
}

#[tokio::test]
async fn one_time_grants_require_the_exact_credited_quantity() {
    let mut reads = MemoryReads::default();
    reads
        .grants
        .insert("g1".into(), grant("g1", CUSTOMER, "b1", 40_000.0, true, None, Some("o1")));
    reads.orders.insert(
        "o1".into(),
        order(
            "o1",
            CUSTOMER,
            CREDIT_PACK_DEFINITIONS[0].id,
            true,
            1_999.0,
            metadata(&[]),
        ),
    );

    let events = [
        credit("c1", 1_000_000, 25_000.0, true),
        benefit("e1", "g1", "b1", 1_001_000),
    ];
    let result = classify(&events, &mut reads).await;
    assert!(result.is_empty());
    assert_eq!(reads.order_reads, 0, "mismatched units never load the order");
}

#[tokio::test]
async fn the_match_window_is_inclusive_and_the_benefit_must_follow() {
    let grant_event = |at| benefit("e1", "g1", "b1", at);
    let mut reads = MemoryReads::default();
    reads
        .grants
        .insert("g1".into(), grant("g1", CUSTOMER, "b1", 40_000.0, false, Some("sub-1"), None));
    let events = [credit("c1", 1_000_000, 40_000.0, false), grant_event(1_005_000)];
    assert_eq!(
        classify(&events, &mut reads).await.get("c1").map(String::as_str),
        Some(SUBSCRIPTION_CREDITS),
        "a {}ms gap is inside the window",
        CREDIT_SOURCE_MATCH_MS
    );

    let mut reads = MemoryReads::default();
    reads
        .grants
        .insert("g1".into(), grant("g1", CUSTOMER, "b1", 40_000.0, false, Some("sub-1"), None));
    let events = [credit("c1", 1_000_000, 40_000.0, false), grant_event(1_005_001)];
    assert!(classify(&events, &mut reads).await.is_empty());

    // A benefit event that precedes the credit is not a match.
    let mut reads = MemoryReads::default();
    reads
        .grants
        .insert("g1".into(), grant("g1", CUSTOMER, "b1", 40_000.0, false, Some("sub-1"), None));
    let events = [credit("c1", 1_000_000, 40_000.0, false), grant_event(999_000)];
    assert!(classify(&events, &mut reads).await.is_empty());
}

#[tokio::test]
async fn orders_must_be_paid_and_owned_by_the_customer() {
    let events = || {
        [
            credit("c1", 1_000_000, 40_000.0, true),
            benefit("e1", "g1", "b1", 1_001_000),
        ]
    };
    let valid = || {
        order(
            "o1",
            CUSTOMER,
            CREDIT_PACK_DEFINITIONS[0].id,
            true,
            1_999.0,
            metadata(&[]),
        )
    };

    let mut reads = MemoryReads::default();
    reads
        .grants
        .insert("g1".into(), grant("g1", CUSTOMER, "b1", 40_000.0, true, None, Some("o1")));
    let mut unpaid = valid();
    unpaid.paid = false;
    reads.orders.insert("o1".into(), unpaid);
    assert!(classify(&events(), &mut reads).await.is_empty());

    let mut reads = MemoryReads::default();
    reads
        .grants
        .insert("g1".into(), grant("g1", CUSTOMER, "b1", 40_000.0, true, None, Some("o1")));
    let mut foreign = valid();
    foreign.customer_id = "other-customer".into();
    reads.orders.insert("o1".into(), foreign);
    assert!(classify(&events(), &mut reads).await.is_empty());

    let mut reads = MemoryReads::default();
    reads
        .grants
        .insert("g1".into(), grant("g1", CUSTOMER, "b1", 40_000.0, true, None, Some("o1")));
    let mut subscription_order = valid();
    subscription_order.subscription_id = Some("sub-1".into());
    reads.orders.insert("o1".into(), subscription_order);
    assert!(classify(&events(), &mut reads).await.is_empty());
}

#[tokio::test]
async fn non_gift_order_sources_and_products_are_not_classified() {
    let events = || {
        [
            credit("c1", 1_000_000, 40_000.0, true),
            benefit("e1", "g1", "b1", 1_001_000),
        ]
    };

    // A gift fulfillment product without the gift source is not a pack either.
    let mut reads = MemoryReads::default();
    reads
        .grants
        .insert("g1".into(), grant("g1", CUSTOMER, "b1", 40_000.0, true, None, Some("o1")));
    reads.orders.insert(
        "o1".into(),
        order(
            "o1",
            CUSTOMER,
            GIFT_PACK_PAIRS[0].fulfillment_product_id,
            true,
            0.0,
            metadata(&[]),
        ),
    );
    assert!(classify(&events(), &mut reads).await.is_empty());

    // A gift-sourced order with a non-zero total is not a gift.
    let mut reads = MemoryReads::default();
    reads
        .grants
        .insert("g1".into(), grant("g1", CUSTOMER, "b1", 40_000.0, true, None, Some("o1")));
    reads.orders.insert(
        "o1".into(),
        order(
            "o1",
            CUSTOMER,
            GIFT_PACK_PAIRS[0].fulfillment_product_id,
            true,
            5.0,
            gift_metadata("gift-1"),
        ),
    );
    assert!(classify(&events(), &mut reads).await.is_empty());

    // A gift-sourced order for an unknown product is not a gift.
    let mut reads = MemoryReads::default();
    reads
        .grants
        .insert("g1".into(), grant("g1", CUSTOMER, "b1", 40_000.0, true, None, Some("o1")));
    reads.orders.insert(
        "o1".into(),
        order(
            "o1",
            CUSTOMER,
            "00000000-0000-4000-8000-000000000000",
            true,
            0.0,
            gift_metadata("gift-1"),
        ),
    );
    assert!(classify(&events(), &mut reads).await.is_empty());

    // A credit pack bought through the gift storefront is not a purchased pack.
    let mut reads = MemoryReads::default();
    reads
        .grants
        .insert("g1".into(), grant("g1", CUSTOMER, "b1", 40_000.0, true, None, Some("o1")));
    reads.orders.insert(
        "o1".into(),
        order(
            "o1",
            CUSTOMER,
            CREDIT_PACK_DEFINITIONS[0].id,
            true,
            1_999.0,
            gift_metadata("gift-1"),
        ),
    );
    assert!(classify(&events(), &mut reads).await.is_empty());
}

#[tokio::test]
async fn unrelated_or_malformed_events_are_ignored() {
    let mut reads = MemoryReads::default();
    reads
        .grants
        .insert("g1".into(), grant("g1", CUSTOMER, "b1", 40_000.0, false, Some("sub-1"), None));

    // Wrong meter.
    let mut wrong_meter = credit("c1", 1_000_000, 40_000.0, false);
    wrong_meter
        .metadata
        .as_mut()
        .expect("metadata")
        .insert("meterId".into(), json!("other-meter"));
    // Non-positive units.
    let zero_units = credit("c2", 1_000_000, 0.0, false);
    // Missing rollover.
    let mut no_rollover = credit("c3", 1_000_000, 40_000.0, false);
    no_rollover
        .metadata
        .as_mut()
        .expect("metadata")
        .remove("rollover");
    // Invalid timestamp.
    let mut invalid_date = credit("c4", 1_000_000, 40_000.0, false);
    invalid_date.timestamp = Some(EventTimestamp::Text("not a date".into()));
    // A benefit event without a grant id.
    let no_grant_id = CreditSourceEvent {
        id: Some("e1".into()),
        name: Some("benefit.granted".into()),
        timestamp: Some(EventTimestamp::Date(1_001_000)),
        metadata: Some(metadata(&[("benefitType", json!("meter_credit"))])),
    };

    let events = [wrong_meter, zero_units, no_rollover, invalid_date, no_grant_id];
    let result = classify(&events, &mut reads).await;
    assert!(result.is_empty());
    assert_eq!(reads.grant_reads, 0);
}

#[tokio::test]
async fn grant_reads_are_cached_within_one_classification() {
    let mut reads = MemoryReads::default();
    reads
        .grants
        .insert("g1".into(), grant("g1", CUSTOMER, "b1", 40_000.0, false, Some("sub-1"), None));

    // Two cycles, each with its own credit and benefit event for the same grant.
    let events = [
        credit("c1", 1_000_000, 40_000.0, false),
        benefit("e1", "g1", "b1", 1_001_000),
        credit("c2", 2_000_000, 40_000.0, false),
        benefit("e2", "g1", "b1", 2_001_000),
    ];
    let result = classify(&events, &mut reads).await;
    assert_eq!(result.get("c1").map(String::as_str), Some(SUBSCRIPTION_CREDITS));
    assert_eq!(result.get("c2").map(String::as_str), Some(SUBSCRIPTION_CREDITS));
    assert_eq!(reads.grant_reads, 1);
}

#[test]
fn error_display_matches_the_source_messages() {
    assert_eq!(
        CreditSourceError::GrantHistoryTooLarge.to_string(),
        "Credit source grant history is too large"
    );
    assert_eq!(
        CreditSourceError::WrongPolicy.to_string(),
        "Credit source reads require the Gift Polar policy"
    );
}

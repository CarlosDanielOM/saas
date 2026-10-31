#![cfg(feature = "billing-service")]

//! Catalog, offer-building, and recharge-expiry boundaries for
//! `utils::credit_packs` (source: `src/utils/credit_packs.ts`).

use dima_rust::utils::{
    credit_packs::{
        self, CREDIT_PACK_DEFINITIONS, CreditPackConfigurationError, CreditPackDefinition,
        CreditPackKind, CreditPackSize, MeterCreditProperties, PolarCreditPackProduct,
        PolarMeterCreditBenefit, PolarPrice, RechargeSubscriptionCycleLike,
    },
    credit_policy::JsDate,
    js_date::parse_date,
};

const METER: &str = "5103e79b-fd74-4ba8-a287-f95574f9addf";

fn at(value: &str) -> JsDate {
    JsDate::from_millis(parse_date(value).expect("fixture date") as f64)
}

fn price(amount: f64, currency: &str) -> PolarPrice {
    PolarPrice {
        price_type: Some("one_time".into()),
        amount_type: Some("fixed".into()),
        price_amount: Some(amount),
        price_currency: Some(currency.into()),
        is_archived: Some(false),
    }
}

fn product(
    definition: &CreditPackDefinition,
    units: f64,
    amount: f64,
    currency: &str,
) -> PolarCreditPackProduct {
    PolarCreditPackProduct {
        id: Some(definition.id.to_owned()),
        name: None,
        visibility: Some("public".into()),
        is_archived: Some(false),
        prices: Some(vec![price(amount, currency)]),
        benefits: Some(vec![PolarMeterCreditBenefit {
            benefit_type: Some("meter_credit".into()),
            properties: Some(MeterCreditProperties {
                units: Some(units),
                rollover: Some(definition.kind.expected_rollover()),
                meter_id: Some(METER.into()),
            }),
        }]),
    }
}

fn products() -> Vec<PolarCreditPackProduct> {
    CREDIT_PACK_DEFINITIONS
        .iter()
        .enumerate()
        .map(|(index, definition)| {
            product(definition, 1_000.0 * (index as f64 + 1.0), 499.0, "USD")
        })
        .collect()
}

#[test]
fn catalog_matches_the_source_table_exactly() {
    let expected = [
        ("45c32959-3fa2-41a6-855c-bbeafcf9ce3c", CreditPackKind::Credits, CreditPackSize::Sample, 0),
        ("2f446a84-69a9-42f6-96ed-6be2b31fdf0c", CreditPackKind::Credits, CreditPackSize::Starter, 1),
        ("4315e89b-bf47-4ddd-a889-e6be6056853d", CreditPackKind::Credits, CreditPackSize::Medium, 2),
        ("44d391d1-8952-408d-ad51-06200404d3ad", CreditPackKind::Recharge, CreditPackSize::Small, 0),
        ("44a6baba-e057-4af7-82c4-ec8ddd528913", CreditPackKind::Recharge, CreditPackSize::Starter, 1),
        ("ac85860a-dee1-4399-9c32-932229d112c1", CreditPackKind::Recharge, CreditPackSize::Medium, 2),
    ];
    assert_eq!(CREDIT_PACK_DEFINITIONS.len(), expected.len());
    for (definition, (id, kind, size, order)) in CREDIT_PACK_DEFINITIONS.iter().zip(expected) {
        assert_eq!(definition.id, id);
        assert_eq!(definition.kind, kind);
        assert_eq!(definition.size, size);
        assert_eq!(definition.order, order);
    }
    assert_eq!(
        credit_packs::get_credit_pack_definition("44d391d1-8952-408d-ad51-06200404d3ad").map(|p| p.size),
        Some(CreditPackSize::Small)
    );
    assert!(credit_packs::get_credit_pack_definition("00000000-0000-4000-8000-000000000000").is_none());
}

#[test]
fn offers_round_and_lowercase_the_provider_values() {
    let mut source = products();
    // Name falls back to the configured size; units/price use JS Math.round.
    source[0].prices = Some(vec![price(1_999.6, "USD")]);
    source[0].benefits.as_mut().expect("benefits")[0]
        .properties
        .as_mut()
        .expect("properties")
        .units = Some(40_000.5);

    let offers = credit_packs::build_credit_pack_offers(&source, METER, false).expect("offers");
    assert_eq!(offers.len(), 6);
    assert_eq!(offers[0].id, CREDIT_PACK_DEFINITIONS[0].id);
    assert_eq!(offers[0].name, "sample");
    assert_eq!(offers[0].credits, 40_001.0);
    assert_eq!(offers[0].price_amount, 2_000.0);
    assert_eq!(offers[0].price_currency, "usd");
    assert!(offers[0].rollover);
}

#[test]
fn credits_packs_are_always_eligible_and_recharges_require_a_paid_plan() {
    let offers = credit_packs::build_credit_pack_offers(&products(), METER, false).expect("offers");
    for offer in &offers {
        match offer.kind {
            "credits" => {
                assert!(offer.eligible, "credits packs stay purchasable");
                assert_eq!(offer.eligibility_reason, None);
            }
            "recharge" => {
                assert!(!offer.eligible);
                assert_eq!(offer.eligibility_reason, Some("paid_plan_required"));
            }
            other => panic!("unexpected kind {other}"),
        }
    }

    let offers = credit_packs::build_credit_pack_offers(&products(), METER, true).expect("offers");
    assert!(offers.iter().all(|offer| offer.eligible));
    assert!(offers.iter().all(|offer| offer.eligibility_reason.is_none()));
}

/// Each configuration failure keeps the source's message and detection order.
#[test]
fn configuration_errors_keep_the_source_messages() {
    let error = |products: &[PolarCreditPackProduct]| {
        credit_packs::build_credit_pack_offers(products, METER, false)
            .expect_err("must fail")
            .to_string()
    };
    let id = |index: usize| CREDIT_PACK_DEFINITIONS[index].id;

    let mut missing = products();
    missing.remove(2);
    assert_eq!(error(&missing), format!("Polar credit pack {} is missing", id(2)));

    let mut archived = products();
    archived[3].is_archived = Some(true);
    assert_eq!(error(&archived), format!("Polar credit pack {} is unavailable", id(3)));

    let mut draft = products();
    draft[4].visibility = Some("draft".into());
    assert_eq!(error(&draft), format!("Polar credit pack {} is unavailable", id(4)));

    // Availability is checked before the price so the state message wins.
    let mut archived_without_price = products();
    archived_without_price[5].is_archived = Some(true);
    archived_without_price[5].prices = Some(Vec::new());
    assert_eq!(
        error(&archived_without_price),
        format!("Polar credit pack {} is unavailable", id(5))
    );

    let mut no_price = products();
    no_price[0].prices = Some(Vec::new());
    assert_eq!(
        error(&no_price),
        format!("Polar credit pack {} has no active fixed price", id(0))
    );

    let mut archived_price_only = products();
    archived_price_only[1].prices = Some(vec![PolarPrice {
        is_archived: Some(true),
        ..price(100.0, "usd")
    }]);
    assert_eq!(
        error(&archived_price_only),
        format!("Polar credit pack {} has no active fixed price", id(1))
    );

    let mut recurring_price = products();
    recurring_price[2].prices = Some(vec![PolarPrice {
        price_type: Some("recurring".into()),
        ..price(100.0, "usd")
    }]);
    assert_eq!(
        error(&recurring_price),
        format!("Polar credit pack {} has no active fixed price", id(2))
    );

    let mut no_currency = products();
    no_currency[0].prices = Some(vec![PolarPrice {
        price_currency: None,
        ..price(100.0, "usd")
    }]);
    assert_eq!(
        error(&no_currency),
        format!("Polar credit pack {} has no active fixed price", id(0))
    );

    let mut wrong_meter = products();
    wrong_meter[3].benefits.as_mut().expect("benefits")[0]
        .properties
        .as_mut()
        .expect("properties")
        .meter_id = Some("00000000-0000-4000-8000-000000000000".into());
    assert_eq!(
        error(&wrong_meter),
        format!("Polar credit pack {} has an invalid credit benefit", id(3))
    );

    let mut zero_units = products();
    zero_units[4].benefits.as_mut().expect("benefits")[0]
        .properties
        .as_mut()
        .expect("properties")
        .units = Some(0.0);
    assert_eq!(
        error(&zero_units),
        format!("Polar credit pack {} has an invalid credit benefit", id(4))
    );

    let mut missing_rollover = products();
    missing_rollover[5].benefits.as_mut().expect("benefits")[0]
        .properties
        .as_mut()
        .expect("properties")
        .rollover = None;
    assert_eq!(
        error(&missing_rollover),
        format!("Polar credit pack {} has an invalid credit benefit", id(5))
    );

    let mut rollover_mismatch = products();
    rollover_mismatch[0].benefits.as_mut().expect("benefits")[0]
        .properties
        .as_mut()
        .expect("properties")
        .rollover = Some(false);
    assert_eq!(
        error(&rollover_mismatch),
        format!(
            "Polar credit pack {} rollover does not match its configured type",
            id(0)
        )
    );

    let mut recharge_rollover = products();
    recharge_rollover[3].benefits.as_mut().expect("benefits")[0]
        .properties
        .as_mut()
        .expect("properties")
        .rollover = Some(true);
    assert_eq!(
        error(&recharge_rollover),
        format!(
            "Polar credit pack {} rollover does not match its configured type",
            id(3)
        )
    );
}

#[test]
fn configuration_error_is_a_typed_error() {
    let error: CreditPackConfigurationError =
        credit_packs::build_credit_pack_offers(&[], METER, false).expect_err("must fail");
    assert!(error.to_string().starts_with("Polar credit pack "));
    let _: &dyn std::error::Error = &error;
}

#[test]
fn recharge_expiry_takes_the_earliest_provider_timestamp() {
    let now = at("2026-11-01T00:00:00.000Z");
    let expiry = credit_packs::get_recharge_expiry(
        &RechargeSubscriptionCycleLike {
            current_period_end: Some("2026-11-15T00:00:00.000Z"),
            ends_at: Some("2026-11-10T00:00:00.000Z"),
        },
        now,
    )
    .expect("expiry");
    assert_eq!(expiry.expires_at, "2026-11-10T00:00:00.000Z");
    assert_eq!(expiry.days_remaining, 9.0);
}

#[test]
fn recharge_expiry_accepts_a_single_timestamp_and_clamps_past_dates() {
    let now = at("2026-11-01T00:00:00.000Z");
    let only_end = credit_packs::get_recharge_expiry(
        &RechargeSubscriptionCycleLike {
            current_period_end: None,
            ends_at: Some("2026-12-01T00:00:00.000Z"),
        },
        now,
    )
    .expect("expiry");
    assert_eq!(only_end.expires_at, "2026-12-01T00:00:00.000Z");
    assert_eq!(only_end.days_remaining, 30.0);

    let only_period = credit_packs::get_recharge_expiry(
        &RechargeSubscriptionCycleLike {
            current_period_end: Some("2026-11-02T12:00:00.000Z"),
            ends_at: None,
        },
        now,
    )
    .expect("expiry");
    assert_eq!(only_period.days_remaining, 2.0);

    let past = credit_packs::get_recharge_expiry(
        &RechargeSubscriptionCycleLike {
            current_period_end: Some("2026-10-01T00:00:00.000Z"),
            ends_at: None,
        },
        now,
    )
    .expect("expiry");
    assert_eq!(past.days_remaining, 0.0);
}

#[test]
fn recharge_expiry_is_none_without_a_finite_timestamp() {
    let now = at("2026-11-01T00:00:00.000Z");
    assert!(credit_packs::get_recharge_expiry(
        &RechargeSubscriptionCycleLike {
            current_period_end: None,
            ends_at: None,
        },
        now,
    )
    .is_none());

    // Empty and unparseable values are `Date.parse` NaN, so they are dropped.
    assert!(credit_packs::get_recharge_expiry(
        &RechargeSubscriptionCycleLike {
            current_period_end: Some(""),
            ends_at: Some("not a date"),
        },
        now,
    )
    .is_none());
}

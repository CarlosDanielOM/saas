#![cfg(feature = "billing-service")]

//! Gift pair lookup and validation boundaries for `utils::credit_gift_provider`
//! (source: `src/utils/credit_gift_provider.ts`). Pure validation only: no
//! provider call, no checkout, no network.

use dima_rust::utils::credit_gift_provider::{
    self, GIFT_PACK_PAIRS, GiftBenefit, GiftBenefitProperties, GiftPackPair, GiftPrice, GiftProduct,
    GiftProviderError,
};

const METER: &str = "5103e79b-fd74-4ba8-a287-f95574f9addf";

fn one_time(amount: f64, currency: &str) -> GiftPrice {
    GiftPrice {
        price_type: Some("one_time".into()),
        amount_type: Some("fixed".into()),
        price_amount: Some(amount),
        price_currency: Some(currency.into()),
        is_archived: Some(false),
    }
}

/// The paid product: a normal priced product with no benefits.
fn paid_product(pair: &GiftPackPair) -> GiftProduct {
    GiftProduct {
        id: Some(pair.product_id.to_owned()),
        name: Some("  Gift credits  ".into()),
        is_archived: Some(false),
        is_recurring: Some(false),
        visibility: Some("public".into()),
        prices: vec![one_time(1_999.0, "USD")],
        benefits: Vec::new(),
    }
}

/// The zero-priced fulfillment product carrying the permanent credit benefit.
fn fulfillment_product(pair: &GiftPackPair) -> GiftProduct {
    GiftProduct {
        id: Some(pair.fulfillment_product_id.to_owned()),
        name: Some("Gift fulfillment".into()),
        is_archived: Some(false),
        is_recurring: Some(false),
        visibility: Some("public".into()),
        prices: vec![one_time(0.0, "usd")],
        benefits: vec![GiftBenefit {
            id: Some("benefit-1".into()),
            benefit_type: Some("meter_credit".into()),
            is_deleted: Some(false),
            properties: Some(GiftBenefitProperties {
                units: Some(pair.credits as f64),
                rollover: Some(true),
                meter_id: Some(METER.into()),
            }),
        }],
    }
}

fn validate(
    paid: &GiftProduct,
    free: &GiftProduct,
) -> Result<credit_gift_provider::GiftPairValidation, GiftProviderError> {
    credit_gift_provider::validate_gift_pair(paid, free)
}

#[test]
fn configured_pairs_match_the_source() {
    let expected = [
        (
            "6e0c530d-affc-44be-a51b-e11453ef1fa7",
            "f14a61f4-a572-4c05-bf4e-1b013d0dc77a",
            40_000,
        ),
        (
            "815d0efe-1d23-4fca-8762-ae3a9253b0bc",
            "019b6291-80a0-4b31-bb09-feaaa9afe5eb",
            250_000,
        ),
        (
            "7d0d5f0e-102a-4255-abf3-6f379e2da4ce",
            "3f6010b6-4108-4bf9-ab83-b035eeed6962",
            550_000,
        ),
    ];
    assert_eq!(GIFT_PACK_PAIRS.len(), expected.len());
    for (pair, (product, fulfillment, credits)) in GIFT_PACK_PAIRS.iter().zip(expected) {
        assert_eq!(pair.product_id, product);
        assert_eq!(pair.fulfillment_product_id, fulfillment);
        assert_eq!(pair.credits, credits);
    }
    assert_eq!(
        credit_gift_provider::find_gift_pair("7d0d5f0e-102a-4255-abf3-6f379e2da4ce")
            .map(|pair| pair.credits),
        Some(550_000)
    );
    assert_eq!(
        credit_gift_provider::find_gift_pair_by_fulfillment(
            "f14a61f4-a572-4c05-bf4e-1b013d0dc77a"
        )
        .map(|pair| pair.credits),
        Some(40_000)
    );
    assert!(credit_gift_provider::find_gift_pair("unknown").is_none());
    assert!(credit_gift_provider::find_gift_pair_by_fulfillment("unknown").is_none());
}

#[test]
fn a_configured_pair_produces_the_source_offer() {
    let pair = &GIFT_PACK_PAIRS[0];
    let validation = validate(&paid_product(pair), &fulfillment_product(pair)).expect("valid");

    assert_eq!(validation.offer.id, pair.product_id);
    assert_eq!(validation.offer.name, "Gift credits");
    assert_eq!(validation.offer.credits, pair.credits);
    assert!(validation.offer.rollover);
    assert_eq!(validation.offer.price_amount, 1_999.0);
    assert_eq!(validation.offer.price_currency, "usd");
    assert_eq!(validation.fulfillment_product_id, pair.fulfillment_product_id);
    assert_eq!(validation.benefit_id, "benefit-1");
}

#[test]
fn mismatched_product_ids_are_unavailable() {
    let paid = paid_product(&GIFT_PACK_PAIRS[0]);
    let free = fulfillment_product(&GIFT_PACK_PAIRS[1]);
    assert_eq!(
        validate(&paid, &free).expect_err("must fail").to_string(),
        "Gift pack is unavailable"
    );

    // An unconfigured paid product is equally unavailable.
    let mut unknown = paid_product(&GIFT_PACK_PAIRS[0]);
    unknown.id = Some("00000000-0000-4000-8000-000000000000".into());
    assert_eq!(
        validate(&unknown, &fulfillment_product(&GIFT_PACK_PAIRS[0]))
            .expect_err("must fail")
            .to_string(),
        "Gift pack is unavailable"
    );
}

#[test]
fn archived_draft_or_recurring_products_are_unavailable() {
    let pair = &GIFT_PACK_PAIRS[0];
    let mutations: [fn(&mut GiftProduct); 3] = [
        |product| product.is_archived = Some(true),
        |product| product.is_recurring = Some(true),
        |product| product.visibility = Some("draft".into()),
    ];
    for mutate in mutations {
        let mut paid = paid_product(pair);
        mutate(&mut paid);
        assert_eq!(
            validate(&paid, &fulfillment_product(pair))
                .expect_err("must fail")
                .to_string(),
            "Gift pack is unavailable"
        );

        let mut free = fulfillment_product(pair);
        mutate(&mut free);
        assert_eq!(
            validate(&paid_product(pair), &free)
                .expect_err("must fail")
                .to_string(),
            "Gift pack is unavailable"
        );
    }
}

#[test]
fn price_and_benefit_shape_errors_keep_the_source_message() {
    let pair = &GIFT_PACK_PAIRS[1];

    let mut two_prices = paid_product(pair);
    two_prices.prices.push(one_time(2_499.0, "usd"));
    assert_eq!(
        validate(&two_prices, &fulfillment_product(pair))
            .expect_err("must fail")
            .to_string(),
        "Gift pack prices or benefits are invalid"
    );

    let mut priced_delivery = fulfillment_product(pair);
    priced_delivery.prices = vec![one_time(100.0, "usd")];
    assert_eq!(
        validate(&paid_product(pair), &priced_delivery)
            .expect_err("must fail")
            .to_string(),
        "Gift pack prices or benefits are invalid"
    );

    let mut currency_mismatch = fulfillment_product(pair);
    currency_mismatch.prices = vec![one_time(0.0, "eur")];
    assert_eq!(
        validate(&paid_product(pair), &currency_mismatch)
            .expect_err("must fail")
            .to_string(),
        "Gift pack prices or benefits are invalid"
    );

    let mut fractional_price = paid_product(pair);
    fractional_price.prices = vec![one_time(19.99, "usd")];
    assert_eq!(
        validate(&fractional_price, &fulfillment_product(pair))
            .expect_err("must fail")
            .to_string(),
        "Gift pack prices or benefits are invalid"
    );

    let mut paid_with_benefit = paid_product(pair);
    paid_with_benefit.benefits = fulfillment_product(pair).benefits;
    assert_eq!(
        validate(&paid_with_benefit, &fulfillment_product(pair))
            .expect_err("must fail")
            .to_string(),
        "Gift pack prices or benefits are invalid"
    );

    let mut two_benefits = fulfillment_product(pair);
    let extra = two_benefits.benefits[0].clone();
    two_benefits.benefits.push(extra);
    assert_eq!(
        validate(&paid_product(pair), &two_benefits)
            .expect_err("must fail")
            .to_string(),
        "Gift pack prices or benefits are invalid"
    );

    let mut no_benefit = fulfillment_product(pair);
    no_benefit.benefits.clear();
    assert_eq!(
        validate(&paid_product(pair), &no_benefit)
            .expect_err("must fail")
            .to_string(),
        "Gift pack prices or benefits are invalid"
    );
}

#[test]
fn the_fulfillment_benefit_must_grant_the_configured_permanent_credits() {
    let pair = &GIFT_PACK_PAIRS[2];

    let mut wrong_units = fulfillment_product(pair);
    wrong_units.benefits[0]
        .properties
        .as_mut()
        .expect("properties")
        .units = Some(1.0);
    assert_eq!(
        validate(&paid_product(pair), &wrong_units)
            .expect_err("must fail")
            .to_string(),
        "Gift pack must grant the configured permanent credits"
    );

    let mut non_permanent = fulfillment_product(pair);
    non_permanent.benefits[0]
        .properties
        .as_mut()
        .expect("properties")
        .rollover = Some(false);
    assert_eq!(
        validate(&paid_product(pair), &non_permanent)
            .expect_err("must fail")
            .to_string(),
        "Gift pack must grant the configured permanent credits"
    );

    let mut wrong_meter = fulfillment_product(pair);
    wrong_meter.benefits[0]
        .properties
        .as_mut()
        .expect("properties")
        .meter_id = Some("00000000-0000-4000-8000-000000000000".into());
    assert_eq!(
        validate(&paid_product(pair), &wrong_meter)
            .expect_err("must fail")
            .to_string(),
        "Gift pack must grant the configured permanent credits"
    );

    let mut wrong_type = fulfillment_product(pair);
    wrong_type.benefits[0].benefit_type = Some("discord".into());
    assert_eq!(
        validate(&paid_product(pair), &wrong_type)
            .expect_err("must fail")
            .to_string(),
        "Gift pack must grant the configured permanent credits"
    );

    let mut deleted = fulfillment_product(pair);
    deleted.benefits[0].is_deleted = Some(true);
    assert_eq!(
        validate(&paid_product(pair), &deleted)
            .expect_err("must fail")
            .to_string(),
        "Gift pack must grant the configured permanent credits"
    );

    let mut no_id = fulfillment_product(pair);
    no_id.benefits[0].id = Some(String::new());
    assert_eq!(
        validate(&paid_product(pair), &no_id)
            .expect_err("must fail")
            .to_string(),
        "Gift pack must grant the configured permanent credits"
    );
}

#[test]
fn a_blank_name_falls_back_to_the_default_label() {
    let pair = &GIFT_PACK_PAIRS[0];
    let mut paid = paid_product(pair);
    paid.name = Some("   ".into());
    assert_eq!(
        validate(&paid, &fulfillment_product(pair))
            .expect("valid")
            .offer
            .name,
        "Gift credits"
    );
    paid.name = None;
    assert_eq!(
        validate(&paid, &fulfillment_product(pair))
            .expect("valid")
            .offer
            .name,
        "Gift credits"
    );
}

#[test]
fn gift_provider_error_display_matches_the_source_messages() {
    assert_eq!(
        GiftProviderError::Unavailable.to_string(),
        "Gift pack is unavailable"
    );
    assert_eq!(
        GiftProviderError::InvalidPricesOrBenefits.to_string(),
        "Gift pack prices or benefits are invalid"
    );
    assert_eq!(
        GiftProviderError::InvalidCreditGrant.to_string(),
        "Gift pack must grant the configured permanent credits"
    );
    assert_eq!(
        GiftProviderError::UnknownGiftPack.to_string(),
        "Unknown gift pack"
    );
    assert_eq!(
        GiftProviderError::MultipleGiftCheckouts.to_string(),
        "Multiple gift checkouts require support"
    );
    assert_eq!(
        GiftProviderError::GiftCheckoutRecoveryRequiresSupport.to_string(),
        "Gift checkout recovery requires support"
    );
    assert_eq!(
        GiftProviderError::MultipleGiftOrders.to_string(),
        "Multiple gift orders require support"
    );
    assert_eq!(
        GiftProviderError::GiftGrantRevoked.to_string(),
        "Gift credit grant was revoked"
    );
    assert_eq!(
        GiftProviderError::GiftGrantConfirmationMissing.to_string(),
        "Gift grant permanent credit confirmation is missing"
    );
    assert_eq!(
        GiftProviderError::GiftGrantLookupRequiresSupport.to_string(),
        "Gift credit grant lookup requires support"
    );
    assert_eq!(GiftProviderError::Unavailable.status(), None);
}

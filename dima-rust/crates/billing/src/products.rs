//! Polar product, meter and pack identifiers the reference hard-codes.
//!
//! Sources: `dimabot/src/utils/referral.ts` (`PRODUCT_IDS`), `utils/billing.ts`
//! (`AI_CREDITS_METER_ID`), `domain_events/polar_billing_events.ts` (`LEGACY_USAGE_METER_ID`) and
//! `utils/credit_gift_provider.ts` (`GIFT_PACK_PAIRS`, which `ai_credit_sources.ts` reads).

/// `PRODUCT_IDS.FREE`.
pub const FREE_PRODUCT_ID: &str = "fccf0669-adab-447d-89c8-d77d8b83bea5";
/// `PRODUCT_IDS.PREMIUM`.
pub const PREMIUM_PRODUCT_ID: &str = "55c8d1d0-5cb8-405c-bcf2-d8dbb9ba0134";
/// `PRODUCT_IDS.PRO`.
pub const PRO_PRODUCT_ID: &str = "1468eea1-7ad0-40d2-b828-4d4cd6b4abdc";
/// The three plan products, in `Object.values(PRODUCT_IDS)` order.
pub const PLAN_PRODUCT_IDS: [&str; 3] = [FREE_PRODUCT_ID, PREMIUM_PRODUCT_ID, PRO_PRODUCT_ID];

/// `AI_CREDITS_METER_ID`.
pub const AI_CREDITS_METER_ID: &str = "5103e79b-fd74-4ba8-a287-f95574f9addf";
/// `LEGACY_USAGE_METER_ID` (`polar_billing_events.ts`).
pub const LEGACY_USAGE_METER_ID: &str = "01d90c16-87d0-4e31-880a-4045a8da90cd";

/// One `GIFT_PACK_PAIRS` entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GiftPackPair {
    /// The paid product the giver buys.
    pub product_id: &'static str,
    /// The free product that delivers the credits to the recipient.
    pub fulfillment_product_id: &'static str,
    /// Credits granted.
    pub credits: u32,
}

/// `GIFT_PACK_PAIRS`.
pub const GIFT_PACK_PAIRS: [GiftPackPair; 3] = [
    GiftPackPair {
        product_id: "6e0c530d-affc-44be-a51b-e11453ef1fa7",
        fulfillment_product_id: "f14a61f4-a572-4c05-bf4e-1b013d0dc77a",
        credits: 40_000,
    },
    GiftPackPair {
        product_id: "815d0efe-1d23-4fca-8762-ae3a9253b0bc",
        fulfillment_product_id: "019b6291-80a0-4b31-bb09-feaaa9afe5eb",
        credits: 250_000,
    },
    GiftPackPair {
        product_id: "7d0d5f0e-102a-4255-abf3-6f379e2da4ce",
        fulfillment_product_id: "3f6010b6-4108-4bf9-ab83-b035eeed6962",
        credits: 550_000,
    },
];

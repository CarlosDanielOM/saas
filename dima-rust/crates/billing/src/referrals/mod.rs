//! Referrals: campaign codes, the attribution of a new account to its referrer, the stats and
//! the ledger the dashboard shows (`utils/referral.ts`, `utils/referral_ledger.ts`; the routes
//! `server/routes/referral.route.ts`, the sign-up in `server/routes/auth.route.ts:1104`, the site
//! assistant's `site_agent/tools/read.ts:517`).
//!
//! What pays the referrer is the paid-order reward ([`crate::order_rewards`]): the payer's
//! referrer (when the code is still active and the referrer still exists) or the bot account
//! receives `token_balance`, keyed by the order. `token_balance` is only shown (the stats'
//! `currentBalance`); nothing in the reference spends it.
//!
//! # Not ported
//!
//! `processSubscriptionReward` and `processBotSubscriptionReward` have no caller in the
//! reference (checked: only their own file names them); they check and then create without an
//! idempotency key, and the paid-order reward replaced them. `REFERRAL_REWARDS` is used by the
//! first only.
//!
//! # Abuse, as the reference allows it (kept)
//!
//! - A code is applied only while an account is created (`auth.route.ts`; `POST /referrals/apply`
//!   answers 410), to an account without a referrer: no code after a first purchase, no second
//!   code, no mutual referral (the referrer existed before the referred account).
//! - Self-referral is refused for the same account only; a second account of the same person
//!   can use the first one's code. Its paid orders then reward the first account's
//!   `token_balance` (which nothing spends).
//! - Codes are chosen by their owners (1 to 16 of `[A-Za-z0-9_]`), not random, and `GET
//!   /referrals/validate/:code` answers without authentication: a code can be guessed. A guessed
//!   code can only attribute the guesser's own new account to its owner.
//! - The codes of a deleted account stay active; an account attributed to one rewards the bot.
//!
//! # Differences from the reference
//!
//! - Two code creations racing past the plan's limit: the reference counts then inserts, so both
//!   could pass; here the creation counts again after inserting and removes its own code when the
//!   limit was passed (either may then fail; neither stays above the limit).
//! - A code taken between the check and the insert (the unique index refuses it) answers the
//!   reference's "already taken" message instead of the duplicate-key error the reference let
//!   through (a 500 in the route).
//! - `label.substring(0, 50)` counts characters here, not UTF-16 units (text rule 1: an emoji
//!   counts one).

pub mod codes;
pub mod ledger;
pub mod stats;

pub use codes::{
    apply_referral_code, create_campaign_code, delete_campaign_code, find_by_code, get_user_codes,
};
pub use ledger::{REFERRAL_LEDGER_PAGE_SIZE, referral_people_page, referral_timeline_page};
pub use stats::get_referral_stats;

use crate::mongo_ops::MongoOpError;
use crate::products::{FREE_PRODUCT_ID, PREMIUM_PRODUCT_ID, PRO_PRODUCT_ID};
use bson::{Document, doc};

/// `PlanType`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanType {
    /// `FREE`.
    Free,
    /// `PREMIUM`.
    Premium,
    /// `PRO`.
    Pro,
}

impl PlanType {
    /// `'FREE' | 'PREMIUM' | 'PRO'`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Free => "FREE",
            Self::Premium => "PREMIUM",
            Self::Pro => "PRO",
        }
    }

    /// `REFERRAL_CODE_LIMITS[plan]`.
    pub fn code_limit(self) -> u64 {
        match self {
            Self::Free => 1,
            Self::Premium => 5,
            Self::Pro => 15,
        }
    }

    /// `getUserPlanType(user)`: `pro`, `premium`, anything else free.
    pub fn of_tier(plan_tier: &str) -> Self {
        match plan_tier {
            "pro" => Self::Pro,
            "premium" => Self::Premium,
            _ => Self::Free,
        }
    }

    /// `getPlanTypeFromProductId(productId)`: unknown products are free.
    pub fn of_product(product_id: &str) -> Self {
        match product_id {
            PRO_PRODUCT_ID => Self::Pro,
            PREMIUM_PRODUCT_ID => Self::Premium,
            FREE_PRODUCT_ID => Self::Free,
            _ => Self::Free,
        }
    }
}

/// `SubscriptionCadence`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cadence {
    /// `monthly`.
    Monthly,
    /// `yearly`.
    Yearly,
}

impl Cadence {
    /// The text.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Monthly => "monthly",
            Self::Yearly => "yearly",
        }
    }

    /// `'monthly' | 'yearly'`.
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "monthly" => Some(Self::Monthly),
            "yearly" => Some(Self::Yearly),
            _ => None,
        }
    }
}

/// `getBotSubscriptionRewardAmount(planType, cadence)` (`BOT_SUBSCRIPTION_REWARDS`).
pub fn bot_subscription_reward_amount(plan: PlanType, cadence: Cadence) -> f64 {
    match (plan, cadence) {
        (PlanType::Free, _) => 0.0,
        (PlanType::Premium, Cadence::Monthly) => 50.0,
        (PlanType::Premium, Cadence::Yearly) => 500.0,
        (PlanType::Pro, Cadence::Monthly) => 100.0,
        (PlanType::Pro, Cadence::Yearly) => 1000.0,
    }
}

/// `COMPLETED_REFERRAL_REWARD_FILTER`: referral bonuses, and subscription rewards that went to
/// the referrer and were applied (or are legacy receipts without a key).
pub fn completed_referral_reward_filter() -> Vec<bson::Bson> {
    vec![
        doc! { "type": "referral_bonus" }.into(),
        doc! {
            "type": "subscription_reward",
            "metadata.rewardTargetType": "referrer",
            "$or": [
                { "appliedAt": { "$type": "date" } },
                { "idempotencyKey": { "$exists": false } },
            ],
        }
        .into(),
    ]
}

/// Why a referral call failed.
#[derive(Debug, thiserror::Error)]
pub enum ReferralError {
    /// `throw new Error(message)` with the reference's message (the route maps some to 400/403).
    #[error("{0}")]
    Refused(String),
    /// MongoDB failed.
    #[error(transparent)]
    Mongo(#[from] MongoOpError),
}

/// `UsersSchema.findById(id)` as a raw document.
pub(crate) async fn load_user(
    store: &dima_store::mongo::MongoStore,
    id: bson::oid::ObjectId,
) -> Result<Option<Document>, ReferralError> {
    Ok(crate::mongo_ops::find_one(
        store,
        dima_model::users::COLLECTION,
        doc! { "_id": id },
        None,
    )
    .await?)
}

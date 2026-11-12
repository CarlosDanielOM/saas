//! Plans: tiers and what each allows, the AI credit allowance and its fenced cache, the checkout
//! and portal decisions, the credit-pack catalog, the entitled plan Polar's state grants (expiry
//! and grace), and the writes that project a plan change onto the user and the caches.
//!
//! Reference: `dimabot/src/utils/billing.ts`, `utils/plan_cache_fence.ts`,
//! `domain_events/polar_entitlements.ts` and the plan and credit projections of
//! `domain_events/polar_billing_events.ts` (the event-envelope dispatch around them is the
//! event-handler package's).
//!
//! **The effective plan.** Everything here reads the stored `plan_tier` as the user's plan. The
//! reference never downgrades on read: `plan_tier_until` is not consulted by any entitlement
//! check; it is written by the Polar projection ([`projection`]) from the entitled plan's expiry
//! ([`entitlements`]), and the projection is what moves a user back to `free` when Polar's state
//! no longer grants a paid tier. A caller's tier is checked against the plan fence before it is
//! trusted for credits ([`credits_cache`]).

pub mod checkout;
pub mod credits;
pub mod credits_cache;
pub mod entitlements;
pub mod pack_context;
pub mod projection;

use dima_model::StrEnum;
pub use dima_model::users::PlanTier;

use crate::products::{PREMIUM_PRODUCT_ID, PRO_PRODUCT_ID};

/// `AI_CREDIT_LIMITS.free`.
pub const FREE_AI_CREDITS: f64 = 25_000.0;
/// `AI_CREDIT_LIMITS.premium`.
pub const PREMIUM_AI_CREDITS: f64 = 200_000.0;
/// `AI_CREDIT_LIMITS.pro`.
pub const PRO_AI_CREDITS: f64 = 800_000.0;

/// `AI_CREDIT_LIMITS[tier]`.
pub fn ai_credit_limit(tier: PlanTier) -> f64 {
    match tier {
        PlanTier::Free => FREE_AI_CREDITS,
        PlanTier::Premium => PREMIUM_AI_CREDITS,
        PlanTier::Pro => PRO_AI_CREDITS,
    }
}

/// A stored tier text as a tier: `free` for anything the reference does not list.
///
/// Quirk not reproduced: `getAiCreditLimitForPlan` tests `planTier in AI_CREDIT_LIMITS`, which is
/// also true for names `Object.prototype` holds (`constructor`, `toString`...); the reference
/// would then compute with a function and produce `NaN` credits that never read as exhausted.
/// No stored user has such a tier; Rust treats it as `free` (fails closed).
pub fn tier_of(text: Option<&str>) -> PlanTier {
    text.and_then(PlanTier::parse).unwrap_or(PlanTier::Free)
}

/// `getAiCreditLimitForPlan(planTier)`.
pub fn ai_credit_limit_for_plan(tier: Option<&str>) -> f64 {
    ai_credit_limit(tier_of(tier))
}

/// `PLAN_RANK`.
pub fn plan_rank(tier: PlanTier) -> u8 {
    match tier {
        PlanTier::Free => 0,
        PlanTier::Premium => 1,
        PlanTier::Pro => 2,
    }
}

/// A paid tier (`Exclude<PlanTier, 'free'>`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PaidTier {
    /// Premium.
    Premium,
    /// Pro.
    Pro,
}

impl PaidTier {
    /// As a plan tier.
    pub fn tier(self) -> PlanTier {
        match self {
            Self::Premium => PlanTier::Premium,
            Self::Pro => PlanTier::Pro,
        }
    }

    /// `PLAN_PRODUCT_MAP[tier]`.
    pub fn product_id(self) -> &'static str {
        match self {
            Self::Premium => PREMIUM_PRODUCT_ID,
            Self::Pro => PRO_PRODUCT_ID,
        }
    }

    /// The text.
    pub fn as_str(self) -> &'static str {
        self.tier().as_str()
    }

    /// `premium` or `pro`.
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "premium" => Some(Self::Premium),
            "pro" => Some(Self::Pro),
            _ => None,
        }
    }
}

/// The plan a product grants (`tier()` in `polar_entitlements.ts`): `free` for any other product.
pub fn product_tier(product_id: &str) -> PlanTier {
    if product_id == PRO_PRODUCT_ID {
        PlanTier::Pro
    } else if product_id == PREMIUM_PRODUCT_ID {
        PlanTier::Premium
    } else {
        PlanTier::Free
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_by_plan() {
        assert_eq!(ai_credit_limit_for_plan(Some("pro")), 800_000.0);
        assert_eq!(ai_credit_limit_for_plan(Some("premium")), 200_000.0);
        assert_eq!(ai_credit_limit_for_plan(None), 25_000.0);
        assert_eq!(ai_credit_limit_for_plan(Some("PRO")), 25_000.0);
        assert_eq!(ai_credit_limit_for_plan(Some("constructor")), 25_000.0);
        assert!(plan_rank(PlanTier::Pro) > plan_rank(PlanTier::Premium));
        assert_eq!(product_tier(PRO_PRODUCT_ID), PlanTier::Pro);
        assert_eq!(
            product_tier(crate::products::FREE_PRODUCT_ID),
            PlanTier::Free
        );
    }
}

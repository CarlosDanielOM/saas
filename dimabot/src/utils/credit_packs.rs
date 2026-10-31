//! Billing-facing credit-pack catalog adapter.
//!
//! Source contract: `dimabot/src/utils/credit_packs.ts` (`CreditPackKind`,
//! `CreditPackSize`, `CreditPackDefinition`, `CREDIT_PACK_DEFINITIONS`,
//! `getCreditPackDefinition`, `getRechargeExpiry`, `buildCreditPackOffers`).
//!
//! This module adds the typed catalog surface the billing slice consumes and
//! keeps the catalog/validation behaviour in exactly one place: the already
//! verified `utils::credit_policy` port of the same TypeScript file. Pack ids
//! and display order are read from that table, so the UUIDs are not duplicated.
//! `get_recharge_expiry` supplies the source's `Date.parse` boundary by parsing
//! the raw subscription strings with V8-compatible `utils::js_date`.
//!
//! Deliberately NOT here: Polar HTTP calls, Redis/DB access, the products list
//! request, customer lookup, checkout creation, or any AI-credit projection.
//! Validation order and every error message are preserved because the delegated
//! builder produces them.

use super::{
    credit_policy::{
        self, CREDIT_PACK_DEFINITIONS as POLICY_DEFINITIONS, JsDate, RechargeExpiry,
    },
    js_date::parse_date,
};
use std::fmt;

/// `CreditPackKind` from `credit_packs.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreditPackKind {
    Credits,
    Recharge,
}

impl CreditPackKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Credits => "credits",
            Self::Recharge => "recharge",
        }
    }

    /// Parses a configured kind name; unknown names are not a pack kind.
    pub fn from_name(value: &str) -> Option<Self> {
        match value {
            "credits" => Some(Self::Credits),
            "recharge" => Some(Self::Recharge),
            _ => None,
        }
    }

    /// A `credits` pack keeps its balance across periods; a `recharge` pack does not.
    pub const fn expected_rollover(self) -> bool {
        matches!(self, Self::Credits)
    }
}

impl fmt::Display for CreditPackKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `CreditPackSize` from `credit_packs.ts`. Declaration order is not the offer
/// order; [`CreditPackDefinition::order`] is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreditPackSize {
    Sample,
    Small,
    Starter,
    Medium,
}

impl CreditPackSize {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Sample => "sample",
            Self::Small => "small",
            Self::Starter => "starter",
            Self::Medium => "medium",
        }
    }

    /// Parses a configured size name; unknown names are not a pack size.
    pub fn from_name(value: &str) -> Option<Self> {
        match value {
            "sample" => Some(Self::Sample),
            "small" => Some(Self::Small),
            "starter" => Some(Self::Starter),
            "medium" => Some(Self::Medium),
            _ => None,
        }
    }
}

impl fmt::Display for CreditPackSize {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `CreditPackDefinition` from `credit_packs.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CreditPackDefinition {
    pub id: &'static str,
    pub kind: CreditPackKind,
    pub size: CreditPackSize,
    pub order: u8,
}

/// The six configured packs, in source order. Ids/orders come from the single
/// verified table in `credit_policy`, so the catalog cannot silently diverge.
pub const CREDIT_PACK_DEFINITIONS: [CreditPackDefinition; 6] = [
    CreditPackDefinition {
        id: POLICY_DEFINITIONS[0].id,
        kind: CreditPackKind::Credits,
        size: CreditPackSize::Sample,
        order: POLICY_DEFINITIONS[0].order,
    },
    CreditPackDefinition {
        id: POLICY_DEFINITIONS[1].id,
        kind: CreditPackKind::Credits,
        size: CreditPackSize::Starter,
        order: POLICY_DEFINITIONS[1].order,
    },
    CreditPackDefinition {
        id: POLICY_DEFINITIONS[2].id,
        kind: CreditPackKind::Credits,
        size: CreditPackSize::Medium,
        order: POLICY_DEFINITIONS[2].order,
    },
    CreditPackDefinition {
        id: POLICY_DEFINITIONS[3].id,
        kind: CreditPackKind::Recharge,
        size: CreditPackSize::Small,
        order: POLICY_DEFINITIONS[3].order,
    },
    CreditPackDefinition {
        id: POLICY_DEFINITIONS[4].id,
        kind: CreditPackKind::Recharge,
        size: CreditPackSize::Starter,
        order: POLICY_DEFINITIONS[4].order,
    },
    CreditPackDefinition {
        id: POLICY_DEFINITIONS[5].id,
        kind: CreditPackKind::Recharge,
        size: CreditPackSize::Medium,
        order: POLICY_DEFINITIONS[5].order,
    },
];

/// `getCreditPackDefinition`, returning `None` where the source returns `null`.
pub fn get_credit_pack_definition(product_id: &str) -> Option<&'static CreditPackDefinition> {
    CREDIT_PACK_DEFINITIONS
        .iter()
        .find(|pack| pack.id == product_id)
}

/// `RechargeSubscriptionCycleLike` from `credit_packs.ts`. The source reads the
/// raw provider strings and applies `Date.parse`; that parsing stays here so
/// callers never invent their own date grammar.
#[derive(Debug, Clone, Copy, Default)]
pub struct RechargeSubscriptionCycleLike<'a> {
    pub current_period_end: Option<&'a str>,
    pub ends_at: Option<&'a str>,
}

/// `getRechargeExpiry`: the earliest finite provider timestamp wins, an invalid
/// `now` yields `NaN` days exactly as the source's arithmetic does, and no
/// finite timestamp yields `None`.
pub fn get_recharge_expiry(
    subscription: &RechargeSubscriptionCycleLike<'_>,
    now: JsDate,
) -> Option<RechargeExpiry> {
    // JS truthiness: an empty string is falsy and contributes no candidate.
    let parse = |value: Option<&str>| {
        value
            .filter(|value| !value.is_empty())
            .and_then(parse_date)
            .map(|millis| JsDate::from_millis(millis as f64))
    };
    credit_policy::get_recharge_expiry(
        parse(subscription.current_period_end),
        parse(subscription.ends_at),
        now,
    )
}

pub use super::credit_policy::{
    CreditPackConfigurationError, CreditPackOffer, MeterCreditProperties, PolarCreditPackProduct,
    PolarMeterCreditBenefit, PolarPrice,
};

/// `buildCreditPackOffers`, delegating to the verified port so the validation
/// order and messages (`is missing`, `is unavailable`, `has no active fixed
/// price`, `has an invalid credit benefit`, `rollover does not match its
/// configured type`) exist in exactly one implementation.
pub fn build_credit_pack_offers(
    products: &[PolarCreditPackProduct],
    ai_credits_meter_id: &str,
    has_active_paid_subscription: bool,
) -> Result<Vec<CreditPackOffer>, CreditPackConfigurationError> {
    credit_policy::build_credit_pack_offers(products, ai_credits_meter_id, has_active_paid_subscription)
}

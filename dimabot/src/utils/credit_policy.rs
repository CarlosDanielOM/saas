//! Pure free-credit reset, allowlisted credit-pack, recharge-expiry, and TTS
//! calculations. No usage tracking, billing calls, cache, clock, or persistence.
//! Gate with `credit-policy` (existing serde + serde_json only).
//!
//! Dates cross this API as [`JsDate`] epoch milliseconds, after the caller's
//! Date.parse/new Date conversion. This deliberately does not implement legacy
//! JS date-string parsing or silently replace it with RFC3339 parsing. Date
//! validity, TimeClip, full milliseconds, offsets after parsing, extended years,
//! and UTC formatting remain observable. Pass `JsDate::invalid()` for invalid
//! source dates, and None for an absent/falsy previous timestamp.
//! Typed pack fields follow the TS interfaces; arbitrary invalid runtime casts,
//! prototypes, Symbols, and custom valueOf/toString hooks are outside the API.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

use super::tts_usage_pricing::js_round;
pub use super::tts_usage_pricing::{TtsUsageResult, calculate_tts_usage};

/// ECMAScript Date's TimeClip range, integral milliseconds, and invalid state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JsDate(Option<i64>);

impl JsDate {
    pub fn from_millis(value: f64) -> Self {
        Self(
            if value.is_finite() && value.abs() <= 8_640_000_000_000_000.0 {
                Some(value.trunc() as i64)
            } else {
                None
            },
        )
    }

    pub const fn invalid() -> Self {
        Self(None)
    }
    pub const fn timestamp_millis(self) -> Option<i64> {
        self.0
    }

    pub fn to_iso_string(self) -> Result<String, InvalidDate> {
        let millis = self.0.ok_or(InvalidDate)?;
        let days = millis.div_euclid(86_400_000);
        // Gregorian civil date from epoch days, including year zero and BCE.
        let shifted = days + 719_468;
        let era = shifted.div_euclid(146_097);
        let day_of_era = shifted - era * 146_097;
        let year_of_era =
            (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
        let mut year = year_of_era + era * 400;
        let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
        let month_prime = (5 * day_of_year + 2) / 153;
        let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
        let month = month_prime + if month_prime < 10 { 3 } else { -9 };
        year += i64::from(month <= 2);
        let year = if (0..=9999).contains(&year) {
            format!("{year:04}")
        } else {
            format!("{year:+07}")
        };
        let within_day = millis.rem_euclid(86_400_000);
        let hour = within_day / 3_600_000;
        let minute = (within_day / 60_000) % 60;
        let second = (within_day / 1000) % 60;
        let fraction = within_day % 1000;
        Ok(format!(
            "{year}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{fraction:03}Z"
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidDate;
impl fmt::Display for InvalidDate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Invalid time value")
    }
}
impl std::error::Error for InvalidDate {}

/// Number(value) for the reset's numeric fields. Typed f64 preserves NaN and
/// infinity; JSON additionally models persisted numeric strings/bools/arrays.
#[derive(Debug, Clone, Copy)]
pub enum ResetNumber<'a> {
    Undefined,
    Number(f64),
    Json(&'a Value),
}

impl ResetNumber<'_> {
    fn number(self) -> f64 {
        match self {
            Self::Undefined => f64::NAN,
            Self::Number(value) => value,
            Self::Json(value) => super::json_number::to_number(value),
        }
    }
}

fn reset_credits(value: ResetNumber<'_>) -> f64 {
    let value = value.number();
    // Number(value) || 0 then floor and Math.max(0, ...). Positive infinity
    // remains infinity, rather than being saturated into a Rust integer.
    if value.is_nan() || value <= 0.0 {
        0.0
    } else {
        value.floor()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct FreeCreditResetRecord<'a> {
    pub period_start: Option<JsDate>,
    pub status: &'a str,
    pub credits: ResetNumber<'a>,
    pub external_id: &'a str,
}

#[derive(Debug, Clone, Copy)]
pub struct FreeCreditResetInput<'a> {
    pub user_id: &'a str,
    pub period_source: &'a str,
    pub period_start: JsDate,
    pub previous: Option<FreeCreditResetRecord<'a>>,
    pub used_credits: ResetNumber<'a>,
    pub maximum_reset_credits: ResetNumber<'a>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum FreeCreditResetDecision {
    Initialize {
        #[serde(rename = "externalId")]
        external_id: String,
    },
    Skip,
    CompleteZero {
        #[serde(rename = "externalId")]
        external_id: String,
    },
    Grant {
        credits: f64,
        #[serde(rename = "externalId")]
        external_id: String,
    },
}

pub fn build_free_credit_reset_external_id(
    user_id: &str,
    period_start: JsDate,
) -> Result<String, InvalidDate> {
    let iso = period_start.to_iso_string()?;
    // Slice ten characters exactly, including the source's unusual result for
    // extended ISO years; do not truncate by calendar date instead.
    Ok(format!("free-credit-reset-{user_id}-{}", &iso[..10]))
}

pub fn decide_free_credit_reset(input: FreeCreditResetInput<'_>) -> FreeCreditResetDecision {
    use FreeCreditResetDecision::*;
    let Some(start) = input.period_start.timestamp_millis() else {
        return Skip;
    };
    if input.period_source != "free_monthly" {
        return Skip;
    }
    let external_id = build_free_credit_reset_external_id(input.user_id, input.period_start)
        .expect("validated period start");
    let previous_start = input
        .previous
        .and_then(|previous| previous.period_start)
        .and_then(JsDate::timestamp_millis);
    let Some(previous_start) = previous_start else {
        return Initialize { external_id };
    };
    if previous_start > start {
        return Skip;
    }
    let (credits, external_id) = if previous_start == start {
        let previous = input.previous.expect("previous timestamp exists");
        if previous.status != "pending" {
            return Skip;
        }
        (
            reset_credits(previous.credits),
            if previous.external_id.is_empty() {
                external_id
            } else {
                previous.external_id.into()
            },
        )
    } else {
        (
            reset_credits(input.used_credits).min(reset_credits(input.maximum_reset_credits)),
            external_id,
        )
    };
    if credits > 0.0 {
        Grant {
            credits,
            external_id,
        }
    } else {
        CompleteZero { external_id }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CreditPackDefinition {
    pub id: &'static str,
    pub kind: &'static str,
    pub size: &'static str,
    pub order: u8,
}

pub const CREDIT_PACK_DEFINITIONS: [CreditPackDefinition; 6] = [
    CreditPackDefinition {
        id: "45c32959-3fa2-41a6-855c-bbeafcf9ce3c",
        kind: "credits",
        size: "sample",
        order: 0,
    },
    CreditPackDefinition {
        id: "2f446a84-69a9-42f6-96ed-6be2b31fdf0c",
        kind: "credits",
        size: "starter",
        order: 1,
    },
    CreditPackDefinition {
        id: "4315e89b-bf47-4ddd-a889-e6be6056853d",
        kind: "credits",
        size: "medium",
        order: 2,
    },
    CreditPackDefinition {
        id: "44d391d1-8952-408d-ad51-06200404d3ad",
        kind: "recharge",
        size: "small",
        order: 0,
    },
    CreditPackDefinition {
        id: "44a6baba-e057-4af7-82c4-ec8ddd528913",
        kind: "recharge",
        size: "starter",
        order: 1,
    },
    CreditPackDefinition {
        id: "ac85860a-dee1-4399-9c32-932229d112c1",
        kind: "recharge",
        size: "medium",
        order: 2,
    },
];

pub fn get_credit_pack_definition(product_id: &str) -> Option<&'static CreditPackDefinition> {
    CREDIT_PACK_DEFINITIONS
        .iter()
        .find(|pack| pack.id == product_id)
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct PolarPrice {
    #[serde(rename = "type")]
    pub price_type: Option<String>,
    pub amount_type: Option<String>,
    pub price_amount: Option<f64>,
    pub price_currency: Option<String>,
    pub is_archived: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct MeterCreditProperties {
    pub units: Option<f64>,
    pub rollover: Option<bool>,
    pub meter_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct PolarMeterCreditBenefit {
    #[serde(rename = "type")]
    pub benefit_type: Option<String>,
    pub properties: Option<MeterCreditProperties>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct PolarCreditPackProduct {
    pub id: Option<String>,
    pub name: Option<String>,
    pub visibility: Option<String>,
    pub is_archived: Option<bool>,
    pub prices: Option<Vec<PolarPrice>>,
    pub benefits: Option<Vec<PolarMeterCreditBenefit>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditPackOffer {
    pub id: &'static str,
    pub name: String,
    pub kind: &'static str,
    pub size: &'static str,
    pub credits: f64,
    pub rollover: bool,
    pub price_amount: f64,
    pub price_currency: String,
    pub eligible: bool,
    pub eligibility_reason: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreditPackConfigurationError(pub String);
impl fmt::Display for CreditPackConfigurationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for CreditPackConfigurationError {}

pub fn build_credit_pack_offers(
    products: &[PolarCreditPackProduct],
    ai_credits_meter_id: &str,
    has_active_paid_subscription: bool,
) -> Result<Vec<CreditPackOffer>, CreditPackConfigurationError> {
    CREDIT_PACK_DEFINITIONS
        .iter()
        .map(|definition| {
            let fail = |message: &str| {
                CreditPackConfigurationError(format!(
                    "Polar credit pack {} {message}",
                    definition.id
                ))
            };
            // JS Map constructed from the list retains the last duplicate ID.
            let product = products
                .iter()
                .rev()
                .find(|product| product.id.as_deref() == Some(definition.id))
                .ok_or_else(|| fail("is missing"))?;
            if product.is_archived == Some(true) || product.visibility.as_deref() == Some("draft") {
                return Err(fail("is unavailable"));
            }
            let price = product
                .prices
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .find(|candidate| {
                    candidate.price_type.as_deref() == Some("one_time")
                        && candidate.amount_type.as_deref() == Some("fixed")
                        && candidate.is_archived != Some(true)
                        && candidate.price_amount.is_some_and(f64::is_finite)
                })
                .ok_or_else(|| fail("has no active fixed price"))?;
            let currency = price
                .price_currency
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| fail("has no active fixed price"))?;
            let properties = product
                .benefits
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .find(|candidate| {
                    candidate.benefit_type.as_deref() == Some("meter_credit")
                        && candidate
                            .properties
                            .as_ref()
                            .and_then(|p| p.meter_id.as_deref())
                            == Some(ai_credits_meter_id)
                })
                .and_then(|benefit| benefit.properties.as_ref())
                .ok_or_else(|| fail("has an invalid credit benefit"))?;
            let units = properties
                .units
                .filter(|n| n.is_finite() && *n > 0.0)
                .ok_or_else(|| fail("has an invalid credit benefit"))?;
            let rollover = properties
                .rollover
                .ok_or_else(|| fail("has an invalid credit benefit"))?;
            if rollover != (definition.kind == "credits") {
                return Err(fail("rollover does not match its configured type"));
            }
            let eligible = definition.kind == "credits" || has_active_paid_subscription;
            Ok(CreditPackOffer {
                id: definition.id,
                name: product
                    .name
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .unwrap_or(definition.size)
                    .into(),
                kind: definition.kind,
                size: definition.size,
                credits: js_round(units),
                rollover,
                price_amount: js_round(price.price_amount.expect("finite selected price")),
                price_currency: currency.to_lowercase(),
                eligible,
                eligibility_reason: if eligible {
                    None
                } else {
                    Some("paid_plan_required")
                },
            })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RechargeExpiry {
    pub expires_at: String,
    pub days_remaining: f64,
}

/// Supply parsed Date values for each subscription field; missing/invalid
/// expiry candidates are ignored. An invalid `now` produces NaN days, as JS.
pub fn get_recharge_expiry(
    current_period_end: Option<JsDate>,
    ends_at: Option<JsDate>,
    now: JsDate,
) -> Option<RechargeExpiry> {
    let expiry = [current_period_end, ends_at]
        .into_iter()
        .flatten()
        .filter_map(JsDate::timestamp_millis)
        .min()?;
    let days_remaining = match now.timestamp_millis() {
        Some(now) => {
            // Convert BEFORE subtraction: the difference can exceed 2^53.
            let days = (((expiry as f64) - (now as f64)) / 86_400_000.0).ceil();
            if days > 0.0 { days } else { 0.0 }
        }
        None => f64::NAN,
    };
    Some(RechargeExpiry {
        expires_at: JsDate(Some(expiry)).to_iso_string().expect("valid expiry"),
        days_remaining,
    })
}

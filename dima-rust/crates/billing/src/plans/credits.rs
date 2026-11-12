//! The AI credit snapshot (`AiCreditsData`): how Polar's credit meter becomes the allowance the
//! dashboard and every AI feature read, and how a cached snapshot is read back.
//!
//! Reference: `buildAiCreditsDataFromMeter`, `applyAiCreditUsageToSnapshot`,
//! `unavailableAiCredits` and the cached branch of `getAiCredits` in `dimabot/src/utils/billing.ts`.
//!
//! Numbers are JavaScript numbers (`f64`) with the reference's `Math.round`, `Math.ceil`,
//! `Math.max`. JSON goes out with [`dima_text::to_js_json`] (an integral `f64` is written `25000`,
//! not `25000.0`). The cache value is Rust's own (`twitch:{id}:ai:credits` is a *rebuilt* key
//! family: cleared at cutover and refilled from Polar), so reading it back only needs to accept
//! what Rust and the usage script write.

use super::ai_credit_limit_for_plan;
use crate::js;
use crate::products::AI_CREDITS_METER_ID;
use dima_store::dragonfly::plan_cache_fence::PLAN_CACHE_VERSION_FIELD;
use serde_json::{Map, Value};

/// `AI_CREDITS_CACHE_SCHEMA_VERSION`.
pub const AI_CREDITS_CACHE_SCHEMA_VERSION: u32 = 3;
/// `AI_CREDITS_CACHE_TTL_SECONDS`.
pub const AI_CREDITS_CACHE_TTL_SECONDS: u64 = 5 * 60;

/// `AiCreditStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CreditStatus {
    /// No verified allowance.
    Unavailable,
    /// Credits left.
    Available,
    /// None left.
    Exhausted,
}

impl CreditStatus {
    /// The text.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::Available => "available",
            Self::Exhausted => "exhausted",
        }
    }
}

/// `AiCreditsData`.
#[derive(Clone, Debug, PartialEq)]
pub struct AiCreditsData {
    /// Always [`AI_CREDITS_CACHE_SCHEMA_VERSION`] when built here.
    pub version: u32,
    /// Credits spent.
    pub used: f64,
    /// The allowance.
    pub limit: f64,
    /// Credits left (may be negative).
    pub balance: f64,
    /// The meter.
    pub meter_id: String,
    /// ISO time.
    pub updated_at: String,
    /// Whether the numbers are a verified allowance.
    pub available: bool,
    /// Status.
    pub status: CreditStatus,
}

impl AiCreditsData {
    /// The object the reference returns, keys in its order.
    pub fn to_json(&self) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert("version".into(), Value::from(self.version));
        map.insert("used".into(), crate::polar::js_number(self.used));
        map.insert("limit".into(), crate::polar::js_number(self.limit));
        map.insert("balance".into(), crate::polar::js_number(self.balance));
        map.insert("meterId".into(), Value::from(self.meter_id.as_str()));
        map.insert("updatedAt".into(), Value::from(self.updated_at.as_str()));
        map.insert("available".into(), Value::Bool(self.available));
        map.insert("status".into(), Value::from(self.status.as_str()));
        map
    }

    /// `JSON.stringify({...payload, [PLAN_CACHE_VERSION_FIELD]: version})`: the cached value.
    pub fn to_cache_text(&self, plan_version: &str) -> String {
        let mut map = self.to_json();
        map.insert(PLAN_CACHE_VERSION_FIELD.into(), Value::from(plan_version));
        dima_text::to_js_json(&Value::Object(map))
    }

    fn status_of(balance: f64) -> CreditStatus {
        if balance <= 0.0 {
            CreditStatus::Exhausted
        } else {
            CreditStatus::Available
        }
    }
}

fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value
        .and_then(Value::as_object)
        .and_then(|object| object.get(key))
}

/// `buildAiCreditsDataFromMeter(meter, planTier, updatedAt)`.
///
/// Polar's meter: `consumed_units` is the source of truth for usage when positive; with credits
/// granted, usage is `credited_units - balance`; otherwise a negative balance is usage.
pub fn build_ai_credits_data_from_meter(
    meter: Option<&Value>,
    plan_tier: Option<&str>,
    updated_at: String,
) -> AiCreditsData {
    let polar_limit = js::finite_or(field(meter, "limit"), 0.0);
    let credited_units = js::finite_or(field(meter, "credited_units"), 0.0);
    let plan_limit = ai_credit_limit_for_plan(plan_tier);
    let consumed_units = js::finite_or(field(meter, "consumed_units"), f64::NAN);
    let balance_value = js::finite_or(field(meter, "balance"), f64::NAN);

    let used = if consumed_units.is_finite() && consumed_units > 0.0 {
        consumed_units
    } else if credited_units > 0.0 && balance_value.is_finite() {
        js::max(0.0, credited_units - balance_value)
    } else if balance_value.is_finite() && balance_value < 0.0 {
        balance_value.abs()
    } else if consumed_units.is_finite() {
        js::max(0.0, consumed_units)
    } else {
        0.0
    };

    let rounded_used = js::max(0.0, js::round(used));
    let remaining_from_polar = if balance_value.is_finite() {
        js::max(0.0, js::round(balance_value))
    } else {
        0.0
    };
    let limit = js::max(
        0.0,
        js::round(js::max(
            js::max(plan_limit, polar_limit),
            js::max(credited_units, remaining_from_polar),
        )),
    );
    let remaining = if balance_value > 0.0 {
        js::max(limit - rounded_used, remaining_from_polar)
    } else {
        limit - rounded_used
    };
    AiCreditsData {
        version: AI_CREDITS_CACHE_SCHEMA_VERSION,
        used: rounded_used,
        limit,
        balance: remaining,
        meter_id: AI_CREDITS_METER_ID.into(),
        updated_at,
        available: true,
        status: AiCreditsData::status_of(remaining),
    }
}

/// `applyAiCreditUsageToSnapshot(snapshot, credits, updatedAt)`.
pub fn apply_ai_credit_usage_to_snapshot(
    snapshot: &AiCreditsData,
    credits: f64,
    updated_at: String,
) -> AiCreditsData {
    let consumed = js::max(0.0, if credits.is_finite() { credits } else { 0.0 }.ceil());
    if !snapshot.available || consumed == 0.0 {
        return snapshot.clone();
    }
    let balance = snapshot.balance - consumed;
    AiCreditsData {
        version: AI_CREDITS_CACHE_SCHEMA_VERSION,
        used: snapshot.used + consumed,
        balance,
        updated_at,
        status: AiCreditsData::status_of(balance),
        ..snapshot.clone()
    }
}

/// `unavailableAiCredits()`: a rejected plan version never escapes as a paid allowance.
pub fn unavailable_ai_credits(now_iso: String) -> AiCreditsData {
    AiCreditsData {
        version: AI_CREDITS_CACHE_SCHEMA_VERSION,
        used: 0.0,
        limit: super::FREE_AI_CREDITS,
        balance: 0.0,
        meter_id: AI_CREDITS_METER_ID.into(),
        updated_at: now_iso,
        available: false,
        status: CreditStatus::Unavailable,
    }
}

/// A cached snapshot as `getAiCredits` reads it, with the plan version stored beside it.
#[derive(Clone, Debug, PartialEq)]
pub struct CachedCredits {
    /// The payload `getAiCredits` would return.
    pub payload: AiCreditsData,
    /// `parsed[PLAN_CACHE_VERSION_FIELD] ?? ''`.
    pub plan_version: String,
}

/// The cached branch of `getAiCredits`: `None` when the value is not a version-3 snapshot with
/// numeric `used` and `limit` (or not JSON).
///
/// Quirk kept: without `requireVerified` the payload is `available: true` whatever the cache
/// said, so a cached `unavailable` snapshot reads back as available (with its numbers).
pub fn read_cached_credits(
    raw: &str,
    require_verified: bool,
    now_iso: impl FnOnce() -> String,
) -> Option<CachedCredits> {
    let parsed: Value =
        serde_json::from_slice(&dima_text::sanitize_lone_surrogates(raw.as_bytes())).ok()?;
    let object = parsed.as_object()?;
    if js::as_number(object.get("version")) != Some(f64::from(AI_CREDITS_CACHE_SCHEMA_VERSION)) {
        return None;
    }
    let used = js::as_number(object.get("used"))?;
    let limit = js::as_number(object.get("limit"))?;
    let available = !require_verified
        || (object.get("available") == Some(&Value::Bool(true))
            && object.get("status").and_then(Value::as_str) != Some("unavailable"));
    let balance =
        js::as_number(object.get("balance")).unwrap_or_else(|| js::max(0.0, limit - used));
    // `parsed.balance ?? parsed.limit - parsed.used`, compared with `<= 0` (coercing).
    let status_balance = match object.get("balance") {
        None | Some(Value::Null) => limit - used,
        Some(other) => js::number(Some(other)),
    };
    let text = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let status = if !available {
        CreditStatus::Unavailable
    } else if object.get("status").and_then(Value::as_str) == Some("exhausted")
        || status_balance <= 0.0
    {
        CreditStatus::Exhausted
    } else {
        CreditStatus::Available
    };
    let plan_version = match object.get(PLAN_CACHE_VERSION_FIELD) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => dima_text::string_of(other),
    };
    Some(CachedCredits {
        payload: AiCreditsData {
            version: AI_CREDITS_CACHE_SCHEMA_VERSION,
            used,
            limit,
            balance,
            meter_id: text("meterId").unwrap_or_else(|| AI_CREDITS_METER_ID.into()),
            updated_at: text("updatedAt").unwrap_or_else(now_iso),
            available,
            status,
        },
        plan_version,
    })
}

/// `isAiCreditsExhausted`'s read of a cached snapshot: `status === 'exhausted'`, or available with
/// a numeric balance at or below 0. Not JSON is not exhausted.
pub fn cached_snapshot_is_exhausted(raw: &str) -> bool {
    let Ok(parsed) =
        serde_json::from_slice::<Value>(&dima_text::sanitize_lone_surrogates(raw.as_bytes()))
    else {
        return false;
    };
    let Some(object) = parsed.as_object() else {
        // `null` throws (caught: not exhausted); other primitives have no such properties.
        return false;
    };
    object.get("status").and_then(Value::as_str) == Some("exhausted")
        || (object.get("available") == Some(&Value::Bool(true))
            && js::as_number(object.get("balance")).is_some_and(|balance| balance <= 0.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn now() -> String {
        "2026-11-11T00:00:00.000Z".into()
    }

    // ai_credit_status.test.ts: "credit snapshot becomes exhausted exactly when usage reaches the limit"
    #[test]
    fn credit_snapshot_becomes_exhausted_exactly_when_usage_reaches_the_limit() {
        let before = build_ai_credits_data_from_meter(
            Some(
                &json!({"meter_id": AI_CREDITS_METER_ID, "consumed_units": 24_999, "balance": -24_999}),
            ),
            Some("free"),
            "2026-09-09T00:00:00.000Z".into(),
        );
        assert_eq!(before.status, CreditStatus::Available);
        let after =
            apply_ai_credit_usage_to_snapshot(&before, 1.0, "2026-09-09T00:00:01.000Z".into());
        assert_eq!(
            after,
            AiCreditsData {
                version: AI_CREDITS_CACHE_SCHEMA_VERSION,
                used: 25_000.0,
                limit: 25_000.0,
                balance: 0.0,
                meter_id: AI_CREDITS_METER_ID.into(),
                updated_at: "2026-09-09T00:00:01.000Z".into(),
                available: true,
                status: CreditStatus::Exhausted,
            }
        );
    }

    // ai_credit_status.test.ts: "meter snapshot is exhausted when Polar usage already equals the limit"
    #[test]
    fn meter_snapshot_is_exhausted_when_polar_usage_already_equals_the_limit() {
        let snapshot = build_ai_credits_data_from_meter(
            Some(
                &json!({"meter_id": AI_CREDITS_METER_ID, "consumed_units": 200_000, "balance": -200_000}),
            ),
            Some("premium"),
            now(),
        );
        assert_eq!(
            (snapshot.balance, snapshot.status),
            (0.0, CreditStatus::Exhausted)
        );
    }

    // ai_credit_status.test.ts: "Piper consumption can exceed the available balance and stays exhausted"
    #[test]
    fn piper_consumption_can_exceed_the_available_balance_and_stays_exhausted() {
        let before = build_ai_credits_data_from_meter(
            Some(&json!({"consumed_units": 25_000, "balance": -25_000})),
            Some("free"),
            now(),
        );
        let after = apply_ai_credit_usage_to_snapshot(&before, 2.0, now());
        assert_eq!(
            (after.balance, after.used, after.status),
            (-2.0, 25_002.0, CreditStatus::Exhausted)
        );
        let refreshed = build_ai_credits_data_from_meter(
            Some(&json!({"consumed_units": 25_002, "balance": -25_002})),
            Some("free"),
            now(),
        );
        assert_eq!(
            (refreshed.balance, refreshed.status),
            (-2.0, CreditStatus::Exhausted)
        );
    }

    #[test]
    fn granted_credits_and_strings_follow_the_reference() {
        let snapshot = build_ai_credits_data_from_meter(
            Some(
                &json!({"consumed_units": "-40000", "credited_units": 40_000, "balance": "39000.4", "limit": null}),
            ),
            Some("premium"),
            now(),
        );
        assert_eq!(
            (snapshot.used, snapshot.limit, snapshot.balance),
            (1000.0, 200_000.0, 199_000.0)
        );
        let empty = build_ai_credits_data_from_meter(None, Some("pro"), now());
        assert_eq!(
            (empty.used, empty.balance, empty.status),
            (0.0, 800_000.0, CreditStatus::Available)
        );
        assert_eq!(
            dima_text::to_js_json(&Value::Object(empty.to_json())),
            r#"{"version":3,"used":0,"limit":800000,"balance":800000,"meterId":"5103e79b-fd74-4ba8-a287-f95574f9addf","updatedAt":"2026-11-11T00:00:00.000Z","available":true,"status":"available"}"#
        );
    }

    #[test]
    fn cached_reads_follow_the_reference() {
        let raw = r#"{"version":3,"used":10,"limit":25000,"available":false,"status":"unavailable","__polar_plan_version":"x"}"#;
        let loose = read_cached_credits(raw, false, now).unwrap();
        assert!(loose.payload.available);
        assert_eq!(loose.payload.balance, 24_990.0);
        assert_eq!(loose.plan_version, "x");
        let strict = read_cached_credits(raw, true, now).unwrap();
        assert_eq!(strict.payload.status, CreditStatus::Unavailable);
        assert!(read_cached_credits(r#"{"version":2,"used":1,"limit":1}"#, false, now).is_none());
        assert!(read_cached_credits("null", false, now).is_none());
        assert!(cached_snapshot_is_exhausted(
            r#"{"available":true,"balance":0}"#
        ));
        assert!(!cached_snapshot_is_exhausted(
            r#"{"available":false,"balance":0}"#
        ));
        assert!(!cached_snapshot_is_exhausted("{"));
    }
}

//! The monthly free-credit reset: what to do for a Free user's current billing period.
//!
//! Reference: `dimabot/src/utils/free_credit_reset.ts` (the worker that applies the decision is
//! `workers/free_credit_reset.worker.ts`, ported with the cron workers).
//!
//! Dates are epoch milliseconds already read the way the reference reads them (`new Date(x)`;
//! [`crate::js::date_ms`] for text and stored values, `None` for an invalid date). The external
//! id takes the first ten characters of the period start's ISO text, which is the UTC day
//! (`YYYY-MM-DD`; for years outside 0..9999 it is the reference's `+010000-01` cut, kept as is).
//! Numbers are the values after `Number(x)`, so `NaN` and infinities follow the reference's
//! `Math.floor(Number(x) || 0)`.

/// `FreeCreditResetStatus`.
pub use dima_model::users::ResetStatus;

use crate::plans::credits::VerifiedBalance;

/// What a new period's grant may be computed from (item 5 of P2-BILLING-01b).
///
/// Item 2 of P2-BILLING-01c: the usage is the [`VerifiedBalance`] itself, which only a read of
/// Polar whose publication was accepted can make, so no number can be passed off as verified.
#[derive(Clone, Debug, PartialEq)]
pub enum ResetUsage {
    /// Credits used in the period, as the read that verified the balance published them.
    Verified(VerifiedBalance),
    /// No verified balance (Polar could not be reached, the read was fenced or superseded, or
    /// only a cached or fallback balance exists): a new period is deferred, never granted from
    /// it.
    Unverified,
}

impl From<VerifiedBalance> for ResetUsage {
    fn from(balance: VerifiedBalance) -> Self {
        Self::Verified(balance)
    }
}

impl From<&VerifiedBalance> for ResetUsage {
    fn from(balance: &VerifiedBalance) -> Self {
        Self::Verified(balance.clone())
    }
}

/// The previous reset record (`FreeCreditResetRecordLike`), as stored on the user.
#[derive(Clone, Debug, PartialEq)]
pub struct PreviousReset<'a> {
    /// `timestamp(previous.periodStart)`: `None` when missing, empty or invalid.
    pub period_start_ms: Option<i64>,
    /// `previous.status` as stored (any text).
    pub status: &'a str,
    /// `Number(previous.credits)`.
    pub credits: f64,
    /// `previous.externalId` (empty text counts as missing).
    pub external_id: &'a str,
}

/// The decision's input.
#[derive(Clone, Debug, PartialEq)]
pub struct FreeCreditResetInput<'a> {
    /// The user's id as text.
    pub user_id: &'a str,
    /// `period.source` (`free_monthly`, `subscription`...).
    pub period_source: &'a str,
    /// `new Date(period.startsAt).getTime()`, `None` when invalid.
    pub period_starts_at_ms: Option<i64>,
    /// The stored record, if any.
    pub previous: Option<PreviousReset<'a>>,
    /// The usage a new period's grant is computed from. The reference took `usedCredits` from
    /// `getAiCredits`, whose fallback invents `used = limit` with `available: true` when Polar
    /// cannot be reached and an exhaustion flag exists; its worker then granted a full reset
    /// from it.
    pub usage: ResetUsage,
    /// `Number(maximumResetCredits)`.
    pub maximum_reset_credits: f64,
}

/// `FreeCreditResetDecision`.
#[derive(Clone, Debug, PartialEq)]
pub enum FreeCreditResetDecision {
    /// Baseline a user seen for the first time into the current period.
    Initialize {
        /// Polar idempotency id.
        external_id: String,
    },
    /// Nothing to do.
    Skip,
    /// Close the period without a grant.
    CompleteZero {
        /// Polar idempotency id.
        external_id: String,
    },
    /// A new period needs a verified usage and has none ([`ResetUsage::Unverified`]): nothing
    /// is written; the worker tries again later (its "Credit usage unavailable; reset deferred").
    Defer,
    /// Grant credits (a whole JavaScript number above 0).
    Grant {
        /// Credits.
        credits: f64,
        /// Polar idempotency id.
        external_id: String,
    },
}

impl FreeCreditResetDecision {
    /// The reference's `action` text.
    pub fn action(&self) -> &'static str {
        match self {
            Self::Initialize { .. } => "initialize",
            Self::Skip => "skip",
            Self::CompleteZero { .. } => "complete_zero",
            Self::Defer => "defer",
            Self::Grant { .. } => "grant",
        }
    }
}

/// `buildFreeCreditResetExternalId(userId, periodStart)`; `None` only for a time outside the
/// `Date` range (the reference would throw).
pub fn free_credit_reset_external_id(user_id: &str, period_start_ms: i64) -> Option<String> {
    let iso = dima_text::to_iso_string(period_start_ms)?;
    // `.slice(0, 10)`: ISO text is ASCII.
    Some(format!(
        "free-credit-reset-{user_id}-{}",
        dima_text::truncate_chars(&iso, 10)
    ))
}

/// `Math.max(0, Math.floor(Number(x) || 0))`.
fn whole_credits(value: f64) -> f64 {
    let value = if value.is_nan() { 0.0 } else { value };
    crate::js::max(0.0, value.floor())
}

/// `decideFreeCreditReset(input)`.
pub fn decide_free_credit_reset(input: &FreeCreditResetInput<'_>) -> FreeCreditResetDecision {
    if input.period_source != "free_monthly" {
        return FreeCreditResetDecision::Skip;
    }
    let Some(period_start) = input.period_starts_at_ms else {
        return FreeCreditResetDecision::Skip;
    };
    let Some(external_id) = free_credit_reset_external_id(input.user_id, period_start) else {
        return FreeCreditResetDecision::Skip;
    };
    let previous = input.previous.as_ref();
    // Existing users are baselined into their current period on first rollout.
    let Some(previous_start) = previous.and_then(|p| p.period_start_ms) else {
        return FreeCreditResetDecision::Initialize { external_id };
    };
    if previous_start > period_start {
        return FreeCreditResetDecision::Skip;
    }
    if previous_start == period_start {
        let Some(previous) = previous.filter(|p| p.status == "pending") else {
            return FreeCreditResetDecision::Skip;
        };
        let external_id = if previous.external_id.is_empty() {
            external_id
        } else {
            previous.external_id.to_owned()
        };
        let pending = whole_credits(previous.credits);
        return if pending > 0.0 {
            FreeCreditResetDecision::Grant {
                credits: pending,
                external_id,
            }
        } else {
            FreeCreditResetDecision::CompleteZero { external_id }
        };
    }
    let ResetUsage::Verified(balance) = &input.usage else {
        return FreeCreditResetDecision::Defer;
    };
    let maximum = whole_credits(input.maximum_reset_credits);
    let used = whole_credits(balance.used());
    let credits = crate::js::min(used, maximum);
    if credits > 0.0 {
        FreeCreditResetDecision::Grant {
            credits,
            external_id,
        }
    } else {
        FreeCreditResetDecision::CompleteZero { external_id }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const START: &str = "2026-09-07T10:30:00.123Z";
    const OLD: &str = "2026-08-07T10:30:00.123Z";

    fn ms(text: &str) -> i64 {
        dima_text::parse_date(text).unwrap()
    }

    /// A balance as a read would have verified it (only this crate can make one).
    pub(super) fn verified(used: f64) -> ResetUsage {
        let data = crate::plans::credits::AiCreditsData {
            used,
            ..crate::plans::credits::unavailable_ai_credits(String::new())
        };
        ResetUsage::Verified(VerifiedBalance::new(&data, 0, "test".into(), 1))
    }

    fn input(previous: Option<PreviousReset<'static>>, used: f64) -> FreeCreditResetInput<'static> {
        FreeCreditResetInput {
            user_id: "user-1",
            period_source: "free_monthly",
            period_starts_at_ms: Some(ms(START)),
            previous,
            usage: verified(used),
            maximum_reset_credits: 25_000.0,
        }
    }

    fn previous(start: &str, status: &'static str, credits: f64) -> PreviousReset<'static> {
        PreviousReset {
            period_start_ms: Some(ms(start)),
            status,
            credits,
            external_id: "previous-id",
        }
    }

    #[test]
    fn first_sight_initializes_and_other_sources_skip() {
        assert_eq!(
            decide_free_credit_reset(&input(None, 5000.0)),
            FreeCreditResetDecision::Initialize {
                external_id: "free-credit-reset-user-1-2026-09-07".into()
            }
        );
        let mut paid = input(None, 5000.0);
        paid.period_source = "subscription";
        assert_eq!(
            decide_free_credit_reset(&paid),
            FreeCreditResetDecision::Skip
        );
    }

    #[test]
    fn a_new_period_grants_used_credits_up_to_the_maximum() {
        let decision =
            decide_free_credit_reset(&input(Some(previous(OLD, "completed", 0.0)), 30_000.9));
        assert_eq!(
            decision,
            FreeCreditResetDecision::Grant {
                credits: 25_000.0,
                external_id: "free-credit-reset-user-1-2026-09-07".into()
            }
        );
        let zero =
            decide_free_credit_reset(&input(Some(previous(OLD, "completed", 0.0)), f64::NAN));
        assert_eq!(zero.action(), "complete_zero");
    }

    // Item 5 of P2-BILLING-01b: a new period is never granted from an unverified balance; a
    // first sight and a pending retry need none.
    #[test]
    fn an_unverified_usage_defers_a_new_period_only() {
        let unverified = |previous| FreeCreditResetInput {
            usage: ResetUsage::Unverified,
            ..input(previous, 0.0)
        };
        assert_eq!(
            decide_free_credit_reset(&unverified(Some(previous(OLD, "completed", 0.0)))),
            FreeCreditResetDecision::Defer
        );
        assert_eq!(
            decide_free_credit_reset(&unverified(None)).action(),
            "initialize"
        );
        assert_eq!(
            decide_free_credit_reset(&unverified(Some(previous(START, "pending", 7.0)))).action(),
            "grant"
        );
    }

    #[test]
    fn a_pending_period_retries_its_own_grant() {
        let decision = decide_free_credit_reset(&input(Some(previous(START, "pending", 7.9)), 0.0));
        assert_eq!(
            decision,
            FreeCreditResetDecision::Grant {
                credits: 7.0,
                external_id: "previous-id".into()
            }
        );
        let done = decide_free_credit_reset(&input(Some(previous(START, "completed", 7.0)), 0.0));
        assert_eq!(done, FreeCreditResetDecision::Skip);
        let newer = decide_free_credit_reset(&input(
            Some(previous("2026-10-07T00:00:00Z", "pending", 7.0)),
            0.0,
        ));
        assert_eq!(newer, FreeCreditResetDecision::Skip);
    }

    #[test]
    fn external_ids_cut_the_iso_text_like_the_reference() {
        assert_eq!(
            free_credit_reset_external_id("u-😃", ms("+010000-01-01T00:00:00.000Z")).as_deref(),
            Some("free-credit-reset-u-😃-+010000-01")
        );
    }
}

/// The recorded cases of `decideFreeCreditReset` (`tests/corpus/billing.json`, op `free_reset`,
/// recorded from the TypeScript). They run inside the crate because a [`VerifiedBalance`] has no
/// public constructor (item 2 of P2-BILLING-01c): the recording's `usedCredits` (whatever value
/// the reference coerced with `Number`) stands for the read that verified it.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod corpus {
    use super::*;
    use serde_json::{Map, Value, json};

    /// A tagged number of the corpus (`{"$number": "NaN"}`...).
    fn number(value: &Value) -> Option<f64> {
        match value {
            Value::Number(n) => n.as_f64(),
            Value::Object(o) => match o.get("$number").and_then(Value::as_str)? {
                "NaN" => Some(f64::NAN),
                "+Infinity" => Some(f64::INFINITY),
                "-Infinity" => Some(f64::NEG_INFINITY),
                "-0" => Some(-0.0),
                _ => None,
            },
            _ => None,
        }
    }

    fn is_undefined(value: &Value) -> bool {
        value.get("$undefined").is_some()
    }

    fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
        value.get(key).filter(|v| !is_undefined(v))
    }

    fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
        field(value, key).and_then(Value::as_str)
    }

    /// A corpus value as plain JSON (`undefined` members dropped).
    fn plain(value: &Value) -> Option<Value> {
        Some(match value {
            Value::Object(o) if o.contains_key("$number") => {
                Value::Number(serde_json::Number::from_f64(number(value)?)?)
            }
            Value::Object(o) if o.contains_key("$undefined") => Value::Null,
            Value::Object(o) => {
                let mut out = Map::new();
                for (k, v) in o {
                    if !is_undefined(v) {
                        out.insert(k.clone(), plain(v)?);
                    }
                }
                Value::Object(out)
            }
            Value::Array(items) => Value::Array(items.iter().map(plain).collect::<Option<_>>()?),
            other => other.clone(),
        })
    }

    /// `Number(x)` of a corpus value (`undefined` is `NaN`).
    fn js_number(value: Option<&Value>) -> f64 {
        match value {
            None => f64::NAN,
            Some(v) if is_undefined(v) => f64::NAN,
            Some(v) => number(v).unwrap_or_else(|| crate::js::number(plain(v).as_ref())),
        }
    }

    fn date_of(value: Option<&Value>) -> Option<i64> {
        let value = value.filter(|v| !v.is_null() && !is_undefined(v))?;
        match value {
            Value::String(text) if text.is_empty() => None,
            other => crate::js::date_ms(Some(other)),
        }
    }

    fn decision_json(decision: &FreeCreditResetDecision) -> Value {
        let credits = |x: f64| {
            if x.is_nan() {
                json!({"$number": "NaN"})
            } else if x.is_infinite() {
                json!({"$number": if x > 0.0 { "+Infinity" } else { "-Infinity" }})
            } else {
                Value::Number(serde_json::Number::from_f64(x).unwrap())
            }
        };
        match decision {
            FreeCreditResetDecision::Initialize { external_id } => {
                json!({"action": "initialize", "externalId": external_id})
            }
            FreeCreditResetDecision::Skip => json!({"action": "skip"}),
            FreeCreditResetDecision::CompleteZero { external_id } => {
                json!({"action": "complete_zero", "externalId": external_id})
            }
            FreeCreditResetDecision::Grant {
                credits: n,
                external_id,
            } => json!({"action": "grant", "credits": credits(*n), "externalId": external_id}),
            FreeCreditResetDecision::Defer => json!({"action": "defer"}),
        }
    }

    /// Numbers by value (with the sign of zero), `undefined` members as absent.
    fn same(expected: &Value, actual: &Value) -> bool {
        if let Some(n) = number(expected).filter(|_| !expected.is_number()) {
            return number(actual).is_some_and(|a| {
                (a.is_nan() && n.is_nan())
                    || (a == n && a.is_sign_negative() == n.is_sign_negative())
            });
        }
        match (expected, actual) {
            (Value::Number(e), Value::Number(a)) => {
                let (e, a) = (e.as_f64().unwrap(), a.as_f64().unwrap());
                e == a && (e != 0.0 || e.is_sign_negative() == a.is_sign_negative())
            }
            (Value::Object(e), Value::Object(a)) if !e.contains_key("$undefined") => {
                let defined: Vec<_> = e.iter().filter(|(_, v)| !is_undefined(v)).collect();
                defined.len() == a.len()
                    && defined
                        .iter()
                        .all(|(k, v)| a.get(*k).is_some_and(|actual| same(v, actual)))
            }
            (e, a) => e == a,
        }
    }

    #[test]
    fn free_credit_reset_matches_the_reference() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/corpus/billing.json");
        let corpus: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let (mut checked, mut deferred, mut failures) = (0, 0, Vec::new());
        for case in corpus["cases"].as_array().unwrap() {
            if case["op"] != "free_reset" {
                continue;
            }
            let input = &case["input"];
            let starts_at = input["period"]["startsAt"].as_str().unwrap();
            let start_ms = dima_text::parse_date(starts_at);
            // The recording's own parse of the date text.
            assert_eq!(
                start_ms,
                number(&case["dateInputs"]["periodStartMs"])
                    .filter(|n| n.is_finite())
                    .map(|n| n as i64),
                "{starts_at}"
            );
            let previous = field(input, "previous").filter(|p| !p.is_null());
            let external = previous
                .map(|p| text(p, "externalId").unwrap_or("").to_owned())
                .unwrap_or_default();
            let status = previous
                .map(|p| text(p, "status").unwrap_or("").to_owned())
                .unwrap_or_default();
            let decision = decide_free_credit_reset(&FreeCreditResetInput {
                user_id: input["userId"].as_str().unwrap(),
                period_source: input["period"]["source"].as_str().unwrap(),
                period_starts_at_ms: start_ms,
                previous: previous.map(|p| PreviousReset {
                    period_start_ms: date_of(field(p, "periodStart")),
                    status: &status,
                    credits: js_number(field(p, "credits")),
                    external_id: &external,
                }),
                // The recording's `usedCredits` came from a read the worker trusted; replayed
                // as verified. Absent, it is the worker's first call, made before any read.
                usage: match field(input, "usedCredits") {
                    Some(used) => super::tests::verified(js_number(Some(used))),
                    None => ResetUsage::Unverified,
                },
                maximum_reset_credits: js_number(field(input, "maximumResetCredits")),
            });
            let actual = decision_json(&decision);
            // Intended difference (item 5 of P2-BILLING-01b): without a verified usage a new
            // period is deferred; the reference computed `Math.floor(NaN || 0)` = 0 and
            // answered `complete_zero` (its worker then read the credits and decided again,
            // trusting even the invented fallback).
            let expected = if decision == FreeCreditResetDecision::Defer {
                deferred += 1;
                assert_eq!(case["expected"]["action"], "complete_zero", "{input}");
                json!({"action": "defer"})
            } else {
                case["expected"].clone()
            };
            checked += 1;
            if !same(&expected, &actual) {
                failures.push(format!("{input}: expected {expected} got {actual}"));
            }
        }
        assert!(failures.is_empty(), "{failures:#?}");
        assert_eq!(checked, 128, "free_reset cases");
        assert_eq!(deferred, 1, "cases deferred for want of a verified usage");
    }
}

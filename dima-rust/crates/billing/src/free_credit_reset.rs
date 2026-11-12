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
    /// `Number(usedCredits)` (`NaN` when absent).
    pub used_credits: f64,
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
    let maximum = whole_credits(input.maximum_reset_credits);
    let used = whole_credits(input.used_credits);
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

    fn input(previous: Option<PreviousReset<'static>>, used: f64) -> FreeCreditResetInput<'static> {
        FreeCreditResetInput {
            user_id: "user-1",
            period_source: "free_monthly",
            period_starts_at_ms: Some(ms(START)),
            previous,
            used_credits: used,
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

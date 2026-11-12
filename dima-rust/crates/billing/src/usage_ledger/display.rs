//! The free plan's credit display: `buildFreeAiCreditDisplay` and `getFreeAiCreditDisplay` of
//! `utils/ai_credit_display.ts`. A UI estimate only: the cached balance, the credit cache and
//! enforcement are never changed by it.

use super::dashboard::DashboardInput;
use super::query::ReadInput;
use super::report::{
    BillingPeriod, CustomerStates, PacingCredits, PacingHistory, PeriodInput, build_pacing, num,
    resolve_period,
};
use super::{Ledger, retention_days};
use crate::usage_backfill::BackfillQueue;
use dima_model::ai_usage_receipts::RetentionTier;
use serde_json::{Map, Value};

/// What the display reads of a cycle.
#[derive(Clone, Debug)]
pub struct DisplayCycle<'a> {
    /// The billing period.
    pub billing_period: &'a BillingPeriod,
    /// The dashboard's summary (`totalSpentCredits`, `grantedCredits`,
    /// `adjustmentDebitedCredits`).
    pub summary: &'a Value,
    /// The dashboard's history.
    pub history: Option<&'a Value>,
    /// Whether the ledger is ready (`ledger?.status === 'ready'`).
    pub ledger_ready: bool,
}

fn unavailable() -> Value {
    let mut map = Map::new();
    map.insert("estimated".into(), Value::Bool(true));
    map.insert("credits".into(), Value::Null);
    map.insert("pacing".into(), Value::Null);
    Value::Object(map)
}

fn number(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// `buildFreeAiCreditDisplay(credits, cycle)`: `credits` is the `AiCreditsData` JSON.
pub fn build_free_display(
    credits: &Map<String, Value>,
    cycle: &DisplayCycle<'_>,
    now_ms: i64,
) -> Value {
    if !cycle.ledger_ready {
        return unavailable();
    }
    let summary = cycle.summary;
    let limit = crate::js::max(
        number(credits.get("limit")),
        number(summary.get("grantedCredits")),
    );
    let debited = summary
        .get("adjustmentDebitedCredits")
        .filter(|v| !v.is_null())
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let used = crate::js::max(0.0, number(summary.get("totalSpentCredits")) + debited);
    let balance = crate::js::max(0.0, limit - used);
    let status = if balance <= 0.0 {
        "exhausted"
    } else {
        "available"
    };
    let mut display = credits.clone();
    display.insert("used".into(), num(used));
    display.insert("limit".into(), num(limit));
    display.insert("balance".into(), num(balance));
    display.insert("status".into(), Value::from(status));
    let history = cycle.history.and_then(PacingHistory::from_json);
    let pacing = build_pacing(
        &PacingCredits {
            used,
            limit,
            balance,
            available: crate::js::truthy(credits.get("available")),
            status: status.to_owned(),
        },
        cycle.billing_period,
        history.as_ref(),
        Some(true),
        now_ms,
    );
    let mut map = Map::new();
    map.insert("estimated".into(), Value::Bool(true));
    map.insert("credits".into(), Value::Object(display));
    map.insert("pacing".into(), pacing);
    Value::Object(map)
}

/// The user fields `getFreeAiCreditDisplay` reads.
#[derive(Clone, Copy, Debug)]
pub struct DisplayUser<'a> {
    /// `plan_tier` (`None` when unset).
    pub plan_tier: Option<&'a str>,
    /// `polar_sh_customer_id`.
    pub customer_id: Option<&'a str>,
    /// `created_at` (ms; `None` when unset).
    pub created_at_ms: Option<i64>,
}

impl Ledger<'_> {
    /// `getFreeAiCreditDisplay(user, channelID, credits)` without an existing cycle: `None`
    /// (`undefined`, left out of the answer) unless the user is on the free plan with an
    /// available balance and a customer; any failure of the reads is the "unavailable" display
    /// (the reference catches everything there).
    pub async fn free_credit_display(
        &self,
        user: &DisplayUser<'_>,
        channel_id: &str,
        credits: &Map<String, Value>,
        backfills: &BackfillQueue<'_>,
        states: &dyn CustomerStates,
    ) -> Option<Value> {
        let customer = user.customer_id.filter(|c| !c.is_empty())?;
        if user.plan_tier != Some("free") || !crate::js::truthy(credits.get("available")) {
            return None;
        }
        let now = self.clock.now_ms();
        let read = async {
            let created = user.created_at_ms.ok_or(())?;
            #[allow(clippy::cast_precision_loss)]
            let period = resolve_period(
                PeriodInput {
                    free_period_anchor_ms: Some(created),
                    time_zone: Some("UTC"),
                    now_ms: now,
                    max_days: Some(retention_days(RetentionTier::Free) as f64),
                    ..PeriodInput::default()
                },
                states,
            )
            .await
            .map_err(|_| ())?;
            let input = ReadInput {
                channel_id,
                customer_id: customer,
                plan_tier: Some("free"),
                window: &period.window,
            };
            let ledger = self
                .usage_ledger_status(&input, backfills)
                .await
                .map_err(|_| ())?;
            let dashboard = self
                .get_dashboard(&DashboardInput {
                    channel_id,
                    customer_id: customer,
                    plan_tier: "free",
                    account_created_at_ms: created,
                    window: &period.window,
                })
                .await
                .map_err(|_| ())?;
            let summary = dashboard.summary().cloned().unwrap_or(Value::Null);
            Ok::<_, ()>(build_free_display(
                credits,
                &DisplayCycle {
                    billing_period: &period.billing_period,
                    summary: &summary,
                    history: dashboard.history(),
                    ledger_ready: ledger.ready,
                },
                now,
            ))
        };
        Some(read.await.unwrap_or_else(|()| unavailable()))
    }
}

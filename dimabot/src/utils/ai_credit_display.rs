//! Free-credit display projection from `dimabot/src/utils/ai_credit_display.ts`.
//!
//! Preserves the not-ready ledger estimate, the balance and exhausted status,
//! and the rule that a reporting failure must not drop the raw billing payload.
//! That failure is [`FreeAiCreditDisplayOutcome::Degraded`], not `Ok` with a
//! silent success.
//!
//! A non-free plan, unavailable credits, or a missing Polar customer id is
//! [`FreeAiCreditDisplayOutcome::NotApplicable`]. This module does not change
//! the billing cache or call Polar. The backfill queue is an injected callback
//! owned by `ai_usage_backfill_queue`.

use std::convert::Infallible;
use std::future::Future;

use mongodb::Database;
use redis::aio::ConnectionManager;

use super::{
    ai_usage_dashboard::{AiUsageDashboard, DashboardError, DashboardReadInput, MongoAiUsageDashboards},
    ai_usage_ledger_queries::AiUsagePacingHistory,
    ai_usage_ledger_reads::{AiUsageLedgerReadiness, MongoAiUsageLedgerReads},
    ai_usage_period::{
        AiUsageBillingPeriod, AiUsagePacing, AiUsagePeriodError, AiUsagePeriodInput,
        AiUsageReceiptError, build_ai_usage_pacing, js_max, resolve_ai_usage_period_with_state,
    },
    ai_usage_queries::{
        UsageLedgerStatusError, UsageLedgerStatusInput, usage_ledger_status,
    },
    ai_usage_receipt_parser::RetentionTier,
    credit_policy::JsDate,
    js_string::JsString,
    lossless_json::{JsonValue, truthy},
};

/// Fields the source reads from the user document. Nothing else.
#[derive(Clone, Debug)]
pub struct FreeCreditUser {
    pub plan_tier: JsString,
    pub polar_sh_customer_id: Option<JsString>,
    pub created_at: JsDate,
}

#[derive(Clone, Debug)]
pub struct DisplayActivity {
    pub total_spent_credits: f64,
    pub granted_credits: f64,
    /// `None` is the source `?? 0`. `Some(NaN)` stays NaN.
    pub adjustment_debited_credits: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct DisplayCycle<'a> {
    pub billing_period: &'a AiUsageBillingPeriod,
    pub summary: DisplayActivity,
    pub history: Option<&'a AiUsagePacingHistory>,
    /// Only `Some(Ready)` projects numbers. Anything else is the null estimate.
    pub ledger_status: Option<AiUsageLedgerReadiness>,
}

#[derive(Clone, Debug)]
pub struct FreeAiCreditDisplay {
    pub estimated: bool,
    pub credits: Option<JsonValue>,
    pub pacing: Option<AiUsagePacing>,
}

impl FreeAiCreditDisplay {
    pub fn unavailable() -> Self {
        Self {
            estimated: true,
            credits: None,
            pacing: None,
        }
    }
}

#[derive(Debug)]
pub enum FreeCreditFailure<E> {
    Projection(AiUsageReceiptError),
    Load(E),
}

impl<E: std::fmt::Display> std::fmt::Display for FreeCreditFailure<E> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Projection(error) => write!(formatter, "{error}"),
            Self::Load(error) => write!(formatter, "{error}"),
        }
    }
}

impl<E: std::error::Error + 'static> std::error::Error for FreeCreditFailure<E> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Projection(error) => Some(error),
            Self::Load(error) => Some(error),
        }
    }
}

#[derive(Debug)]
pub enum FreeCreditLoadError<E> {
    Period(AiUsagePeriodError<Infallible>),
    Status(UsageLedgerStatusError<E>),
    Dashboard(DashboardError),
}

impl<E: std::fmt::Display> std::fmt::Display for FreeCreditLoadError<E> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Period(error) => write!(formatter, "{error}"),
            Self::Status(error) => write!(formatter, "{error}"),
            Self::Dashboard(error) => write!(formatter, "{error}"),
        }
    }
}

impl<E: std::error::Error + 'static> std::error::Error for FreeCreditLoadError<E> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Period(error) => Some(error),
            Self::Status(error) => Some(error),
            Self::Dashboard(error) => Some(error),
        }
    }
}

/// `NotApplicable` is the source `undefined`. `Degraded` is the caught
/// reporting failure and still surfaces the null estimate through
/// [`FreeAiCreditDisplayOutcome::public_display`].
#[derive(Debug)]
pub enum FreeAiCreditDisplayOutcome<E> {
    NotApplicable,
    Ready(FreeAiCreditDisplay),
    Degraded(E),
}

impl<E> FreeAiCreditDisplayOutcome<E> {
    pub fn public_display(&self) -> Option<FreeAiCreditDisplay> {
        match self {
            Self::NotApplicable => None,
            Self::Ready(display) => Some(display.clone()),
            Self::Degraded(_) => Some(FreeAiCreditDisplay::unavailable()),
        }
    }
}

fn json_field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(fields) => fields
            .iter()
            .find(|(name, _)| name.as_str() == Some(key))
            .map(|(_, field)| field),
        _ => None,
    }
}

fn coerced_number(value: Option<&JsonValue>) -> f64 {
    match value {
        Some(JsonValue::Number(number)) => *number,
        Some(JsonValue::Null) => 0.0,
        Some(JsonValue::Bool(true)) => 1.0,
        Some(JsonValue::Bool(false)) => 0.0,
        _ => f64::NAN,
    }
}

fn object_override(credits: &JsonValue, updates: &[(&str, JsonValue)]) -> Result<JsonValue, AiUsageReceiptError> {
    let JsonValue::Object(fields) = credits else {
        return Err(AiUsageReceiptError::Validation(
            "AI credit display requires a credits object".to_string(),
        ));
    };
    let mut fields = fields.clone();
    for (key, value) in updates {
        if let Some(slot) = fields.iter_mut().find(|(name, _)| name.as_str() == Some(key)) {
            slot.1 = value.clone();
        } else {
            fields.push((JsString::from(*key), value.clone()));
        }
    }
    Ok(JsonValue::Object(fields))
}

fn applicable(user: &FreeCreditUser, credits: &JsonValue) -> bool {
    if user.plan_tier.as_str() != Some("free") {
        return false;
    }
    if !json_field(credits, "available").is_some_and(truthy) {
        return false;
    }
    user.polar_sh_customer_id
        .as_ref()
        .is_some_and(|value| !value.is_empty())
}

/// Pure projection. A ledger that is missing or not `ready` returns the null
/// estimate as a successful result.
pub fn build_free_ai_credit_display(
    credits: &JsonValue,
    cycle: &DisplayCycle<'_>,
    now: Option<JsDate>,
) -> Result<FreeAiCreditDisplay, AiUsageReceiptError> {
    if cycle.ledger_status != Some(AiUsageLedgerReadiness::Ready) {
        return Ok(FreeAiCreditDisplay::unavailable());
    }
    let limit = js_max(
        coerced_number(json_field(credits, "limit")),
        cycle.summary.granted_credits,
    );
    let debited = cycle.summary.adjustment_debited_credits.unwrap_or(0.0);
    let used = js_max(0.0, cycle.summary.total_spent_credits + debited);
    let balance = js_max(0.0, limit - used);
    let status = if balance <= 0.0 { "exhausted" } else { "available" };
    let display_credits = object_override(
        credits,
        &[
            ("used", JsonValue::Number(used)),
            ("limit", JsonValue::Number(limit)),
            ("balance", JsonValue::Number(balance)),
            ("status", JsonValue::String(status.into())),
        ],
    )?;
    let pacing = build_ai_usage_pacing(super::ai_usage_period::AiUsagePacingInput {
        credits: &display_credits,
        billing_period: cycle.billing_period,
        history: cycle.history,
        history_complete: Some(true),
        now,
    })?;
    Ok(FreeAiCreditDisplay {
        estimated: true,
        credits: Some(display_credits),
        pacing,
    })
}

pub struct LoadedFreeCycle {
    pub billing_period: AiUsageBillingPeriod,
    pub summary: DisplayActivity,
    pub history: Option<AiUsagePacingHistory>,
    pub ledger_status: Option<AiUsageLedgerReadiness>,
}

/// Synchronous orchestration used by the service and by tests. `loaded` runs
/// only when no existing cycle was supplied. Its `Err` is [`FreeCreditFailure::Load`].
pub fn orchestrate_free_ai_credit_display<E>(
    user: &FreeCreditUser,
    credits: &JsonValue,
    existing: Option<&DisplayCycle<'_>>,
    now: Option<JsDate>,
    loaded: impl FnOnce() -> Result<LoadedFreeCycle, E>,
) -> FreeAiCreditDisplayOutcome<FreeCreditFailure<E>> {
    if !applicable(user, credits) {
        return FreeAiCreditDisplayOutcome::NotApplicable;
    }
    if let Some(existing) = existing {
        return match build_free_ai_credit_display(credits, existing, now) {
            Ok(display) => FreeAiCreditDisplayOutcome::Ready(display),
            Err(error) => FreeAiCreditDisplayOutcome::Degraded(FreeCreditFailure::Projection(error)),
        };
    }
    let loaded = match loaded() {
        Ok(loaded) => loaded,
        Err(error) => return FreeAiCreditDisplayOutcome::Degraded(FreeCreditFailure::Load(error)),
    };
    let cycle = DisplayCycle {
        billing_period: &loaded.billing_period,
        summary: loaded.summary.clone(),
        history: loaded.history.as_ref(),
        ledger_status: loaded.ledger_status,
    };
    match build_free_ai_credit_display(credits, &cycle, now) {
        Ok(display) => FreeAiCreditDisplayOutcome::Ready(display),
        Err(error) => FreeAiCreditDisplayOutcome::Degraded(FreeCreditFailure::Projection(error)),
    }
}

pub struct FreeAiCreditDisplayService {
    reads: MongoAiUsageLedgerReads,
    dashboards: MongoAiUsageDashboards,
}

impl FreeAiCreditDisplayService {
    /// Clones the caller's handles. Does no I/O.
    pub fn new(database: &Database, cache: ConnectionManager) -> Self {
        Self {
            reads: MongoAiUsageLedgerReads::new(database),
            dashboards: MongoAiUsageDashboards::new(database, cache),
        }
    }

    /// `getFreeAiCreditDisplay`. `enqueue` is called only when the ledger read
    /// says a backfill is due. Pass `ai_usage_backfill_queue::enqueue_ai_usage_backfill`.
    pub async fn get_free_ai_credit_display<E, F, Fut>(
        &self,
        user: &FreeCreditUser,
        channel_id: &JsString,
        credits: &JsonValue,
        existing: Option<&DisplayCycle<'_>>,
        enqueue: F,
    ) -> FreeAiCreditDisplayOutcome<FreeCreditFailure<FreeCreditLoadError<E>>>
    where
        E: 'static,
        F: FnOnce(JsDate) -> Fut,
        Fut: Future<Output = Result<(), E>>,
    {
        if !applicable(user, credits) {
            return FreeAiCreditDisplayOutcome::NotApplicable;
        }
        if existing.is_some() {
            return orchestrate_free_ai_credit_display(user, credits, existing, None, || {
                Err(FreeCreditLoadError::Period(AiUsagePeriodError::CustomerStateRequired))
            });
        }
        let loaded = self.load(user, channel_id, enqueue).await;
        orchestrate_free_ai_credit_display(user, credits, None, None, || loaded)
    }

    async fn load<E, F, Fut>(
        &self,
        user: &FreeCreditUser,
        channel_id: &JsString,
        enqueue: F,
    ) -> Result<LoadedFreeCycle, FreeCreditLoadError<E>>
    where
        F: FnOnce(JsDate) -> Fut,
        Fut: Future<Output = Result<(), E>>,
    {
        let customer_id = user
            .polar_sh_customer_id
            .clone()
            .ok_or(FreeCreditLoadError::Period(AiUsagePeriodError::CustomerStateRequired))?;
        let period = resolve_ai_usage_period_with_state(
            &AiUsagePeriodInput {
                free_period_anchor: Some(user.created_at),
                time_zone: Some(JsString::from("UTC")),
                max_days: Some(RetentionTier::Free.days() as f64),
                ..AiUsagePeriodInput::default()
            },
            None::<Result<super::ai_usage_period::PolarCustomerState, Infallible>>,
        )
        .map_err(FreeCreditLoadError::Period)?;
        let status = usage_ledger_status(
            &self.reads,
            &UsageLedgerStatusInput {
                channel_id: channel_id.clone(),
                customer_id: customer_id.clone(),
                plan_tier: JsonValue::String("free".into()),
                account_created_at: Some(user.created_at),
                window: period.window.clone(),
            },
            enqueue,
        )
        .await
        .map_err(FreeCreditLoadError::Status)?;
        let dashboard: AiUsageDashboard = self
            .dashboards
            .get_ai_usage_dashboard(&DashboardReadInput {
                channel_id: channel_id.clone(),
                customer_id,
                plan_tier: JsonValue::String("free".into()),
                account_created_at: user.created_at,
                window: period.window,
            })
            .await
            .map_err(FreeCreditLoadError::Dashboard)?;
        Ok(LoadedFreeCycle {
            billing_period: period.billing_period,
            summary: DisplayActivity {
                total_spent_credits: dashboard.summary.total_spent_credits,
                granted_credits: dashboard.summary.granted_credits,
                adjustment_debited_credits: Some(dashboard.summary.adjustment_debited_credits),
            },
            history: dashboard.history,
            ledger_status: Some(status.status),
        })
    }
}

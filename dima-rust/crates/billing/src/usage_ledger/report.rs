//! The pure parts of the AI usage page: the date window of a request, the billing period it
//! falls in, the pacing forecast, the summary of a list of transactions and their in-memory
//! pagination.
//!
//! Reference: `resolveAiUsageWindow`, `resolveFreeCreditPeriod`, `resolveAiUsagePeriod`,
//! `buildAiUsagePacing`, `buildAiUsageSummary` and `paginateAiUsageTransactions` of
//! `dimabot/src/utils/ai_usage_receipts.ts`. Numbers are JavaScript numbers (`f64`) with the
//! reference's `Math.round`, `Math.ceil` and `Math.max`; every JSON object is built in the
//! reference's key order and written by `dima_text::to_js_json`.
//!
//! Dates: date labels are `YYYY-MM-DD` read as `Date.UTC` reads them (so years 0 to 99 are not
//! valid labels: `Date.UTC` maps them to 1900 to 1999, as the reference finds); local dates are
//! the viewer's time zone ([`super::zones`]). Orderings the viewer sees (categories with equal
//! credits, transactions at the same instant) use ICU collation (`localeCompare`).

use super::zones::{InvalidTimeZone, Zone};
use crate::js;
use crate::usage::{EntryKind, ResourceType, Unit};
use dima_text::{date_utc, to_iso_string, utc_fields};
use futures_util::future::BoxFuture;
use serde_json::{Map, Value};
use std::cmp::Ordering;

/// `AI_USAGE_RECEIPT_SCHEMA_VERSION`.
pub const RECEIPT_SCHEMA_VERSION: u32 = 1;
/// `AI_USAGE_ITEMIZATION_STARTED_AT`.
pub const ITEMIZATION_STARTED_AT: &str = "2026-09-18T19:30:00.000Z";
/// `AI_USAGE_MAX_RANGE_DAYS`.
pub const MAX_RANGE_DAYS: f64 = 90.0;
const DEFAULT_RANGE_DAYS: i64 = 30;
const DEFAULT_MAX_RANGE_DAYS: f64 = 31.0;
const MAX_SUBSCRIPTION_DATE_BUCKETS: f64 = 32.0;
const MINIMUM_PACING_HISTORY_DAYS: f64 = 7.0;
/// Milliseconds in a day.
pub const DAY_MS: i64 = 86_400_000;

/// Why a usage read refuses its input (`AiUsageReceiptValidationError`, answered 400, and
/// `AiUsageReceiptLimitError`, answered 422), with the reference's messages.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum UsageReadError {
    /// The request is malformed (400).
    #[error("{0}")]
    Validation(String),
    /// The request asks for more than the plan or the bounds allow (422).
    #[error("{0}")]
    Limit(String),
}

impl UsageReadError {
    /// The HTTP status the routes answer with.
    pub fn status(&self) -> u16 {
        match self {
            Self::Validation(_) => 400,
            Self::Limit(_) => 422,
        }
    }

    pub(crate) fn validation(message: impl Into<String>) -> Self {
        Self::Validation(message.into())
    }
}

impl From<InvalidTimeZone> for UsageReadError {
    fn from(error: InvalidTimeZone) -> Self {
        Self::Validation(error.to_string())
    }
}

/// A JavaScript number as JSON (`JSON.stringify` writes `-0` as `0` and a non-finite one as
/// `null`).
pub(crate) fn num(value: f64) -> Value {
    let value = if value == 0.0 { 0.0 } else { value };
    serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
}

/// `new Date(ms).toISOString()`; out of range is an empty text (never reached for the dates
/// these functions build).
pub(crate) fn iso(ms: i64) -> String {
    to_iso_string(ms).unwrap_or_default()
}

/// `iso(ms).slice(0, 10)`.
pub(crate) fn iso_day(ms: i64) -> String {
    iso(ms).get(0..10).unwrap_or_default().to_owned()
}

/// `parseDateLabel(value, field)`.
fn parse_date_label(value: &str, field: &str) -> Result<(i64, i64, i64), UsageReadError> {
    let bytes = value.as_bytes();
    let shaped = bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            _ => b.is_ascii_digit(),
        });
    if !shaped {
        return Err(UsageReadError::validation(format!(
            "{field} must use YYYY-MM-DD"
        )));
    }
    let part = |range: std::ops::Range<usize>| {
        value
            .get(range)
            .and_then(|text| text.parse::<i64>().ok())
            .unwrap_or(0)
    };
    let (year, month, day) = (part(0..4), part(5..7), part(8..10));
    let valid = date_utc(year, month - 1, day, 0, 0, 0, 0)
        .and_then(utc_fields)
        .is_some_and(|f| {
            f.year == year && i64::from(f.month) == month - 1 && i64::from(f.day) == day
        });
    if !valid {
        return Err(UsageReadError::validation(format!(
            "{field} is not a valid date"
        )));
    }
    Ok((year, month, day))
}

/// `shiftDateLabel(value, days)`.
fn shift_date_label(value: &str, days: i64) -> Result<String, UsageReadError> {
    let (year, month, day) = parse_date_label(value, "date")?;
    let shifted = date_utc(year, month - 1, day + days, 0, 0, 0, 0)
        .ok_or_else(|| UsageReadError::validation("date is not a valid date"))?;
    Ok(iso_day(shifted))
}

/// `zonedStartOfDay(value, timeZone)`: the instant the wall-clock day starts, found the way the
/// reference finds it (three corrections at most, so a day that starts inside a gap lands
/// where the reference's lands).
fn zoned_start_of_day(value: &str, zone: &Zone) -> Result<i64, UsageReadError> {
    let (year, month, day) = parse_date_label(value, "date")?;
    let wall = date_utc(year, month - 1, day, 0, 0, 0, 0)
        .ok_or_else(|| UsageReadError::validation("date is not a valid date"))?;
    let mut guess = wall;
    for _ in 0..3 {
        let Some(parts) = zone.local(guess) else {
            return Err(UsageReadError::validation("date is not a valid date"));
        };
        let represented = date_utc(
            parts.year,
            parts.month - 1,
            parts.day,
            parts.hour,
            parts.minute,
            parts.second,
            0,
        )
        .ok_or_else(|| UsageReadError::validation("date is not a valid date"))?;
        let next = wall - (represented - guess);
        if next == guess {
            break;
        }
        guess = next;
    }
    Ok(guess)
}

/// `buildDateLabels(from, to, maxDays)`.
fn build_date_labels(from: &str, to: &str, max_days: f64) -> Result<Vec<String>, UsageReadError> {
    let mut dates: Vec<String> = Vec::new();
    let mut current = from.to_owned();
    while current.as_str() <= to {
        dates.push(current.clone());
        #[allow(clippy::cast_precision_loss)]
        if dates.len() as f64 > max_days {
            return Err(UsageReadError::Limit(format!(
                "Date range cannot exceed {} days",
                dima_text::number_to_string(max_days)
            )));
        }
        current = shift_date_label(&current, 1)?;
    }
    Ok(dates)
}

/// `AiUsageWindow`.
#[derive(Clone, Debug, PartialEq)]
pub struct Window {
    /// First day (`YYYY-MM-DD`, local).
    pub from: String,
    /// Last day (inclusive).
    pub to: String,
    /// The viewer's zone.
    pub zone: Zone,
    /// `startTimestamp` (ms).
    pub start_ms: i64,
    /// `endTimestampExclusive` (ms).
    pub end_exclusive_ms: i64,
    /// Every day label of the window.
    pub days: Vec<String>,
}

impl Window {
    /// The zone's name as given.
    pub fn time_zone(&self) -> &str {
        self.zone.name()
    }

    /// `{from, to, timeZone, startTimestamp, endTimestampExclusive, days}` with the timestamps
    /// as ISO text (the dashboard request's `window`).
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("from".into(), Value::from(self.from.as_str()));
        map.insert("to".into(), Value::from(self.to.as_str()));
        map.insert("timeZone".into(), Value::from(self.time_zone()));
        map.insert("startTimestamp".into(), Value::from(iso(self.start_ms)));
        map.insert(
            "endTimestampExclusive".into(),
            Value::from(iso(self.end_exclusive_ms)),
        );
        map.insert(
            "days".into(),
            Value::Array(self.days.iter().map(|d| Value::from(d.as_str())).collect()),
        );
        Value::Object(map)
    }

    /// The summary's `period` (`{from, to, timeZone, dayCount}`).
    pub fn period_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("from".into(), Value::from(self.from.as_str()));
        map.insert("to".into(), Value::from(self.to.as_str()));
        map.insert("timeZone".into(), Value::from(self.time_zone()));
        map.insert("dayCount".into(), Value::from(self.days.len()));
        Value::Object(map)
    }
}

/// The input of `resolveAiUsageWindow`.
#[derive(Clone, Copy, Debug, Default)]
pub struct WindowInput<'a> {
    /// `from` (an empty text counts as unset).
    pub from: Option<&'a str>,
    /// `to`.
    pub to: Option<&'a str>,
    /// `timeZone` (unset or empty is UTC).
    pub time_zone: Option<&'a str>,
    /// `now`.
    pub now_ms: i64,
    /// `maxDays` (unset or 0 is 31).
    pub max_days: Option<f64>,
}

fn present(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}

/// `resolveAiUsageWindow(input)`.
pub fn resolve_window(input: WindowInput<'_>) -> Result<Window, UsageReadError> {
    let zone = Zone::parse(present(input.time_zone).unwrap_or("UTC"))?;
    resolve_window_in(input, zone)
}

fn resolve_window_in(input: WindowInput<'_>, zone: Zone) -> Result<Window, UsageReadError> {
    let today = zone
        .local_date(input.now_ms)
        .ok_or_else(|| UsageReadError::validation("Invalid timezone"))?;
    let asked = input.max_days.filter(|d| *d != 0.0 && !d.is_nan());
    let max_days = js::max(
        1.0,
        js::min(MAX_RANGE_DAYS, asked.unwrap_or(DEFAULT_MAX_RANGE_DAYS)),
    );
    let (from_given, to_given) = (present(input.from), present(input.to));
    if from_given.is_some() != to_given.is_some() {
        return Err(UsageReadError::validation(
            "from and to must be provided together",
        ));
    }
    let to = to_given.map_or_else(|| today.clone(), str::to_owned);
    let from = match from_given {
        Some(from) => from.to_owned(),
        None => shift_date_label(&to, -(DEFAULT_RANGE_DAYS - 1))?,
    };
    parse_date_label(&from, "from")?;
    parse_date_label(&to, "to")?;
    if from > to {
        return Err(UsageReadError::validation("from must be on or before to"));
    }
    if to > today {
        return Err(UsageReadError::validation("to cannot be in the future"));
    }
    #[allow(clippy::cast_possible_truncation)]
    let earliest = shift_date_label(&today, -((max_days - 1.0) as i64))?;
    if from < earliest {
        return Err(UsageReadError::Limit(format!(
            "Usage history for this plan is limited to {} days",
            dima_text::number_to_string(max_days)
        )));
    }
    let days = build_date_labels(&from, &to, max_days)?;
    let start_ms = zoned_start_of_day(&from, &zone)?;
    let end_exclusive_ms = zoned_start_of_day(&shift_date_label(&to, 1)?, &zone)?;
    Ok(Window {
        from,
        to,
        zone,
        start_ms,
        end_exclusive_ms,
        days,
    })
}

/// `AiUsagePeriodSource`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PeriodSource {
    /// The active Polar subscription's period.
    Subscription,
    /// The free plan's monthly anniversary.
    FreeMonthly,
    /// The last 30 days.
    Rolling30Day,
    /// A range the viewer chose.
    Custom,
}

impl PeriodSource {
    /// The reference's text.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Subscription => "subscription",
            Self::FreeMonthly => "free_monthly",
            Self::Rolling30Day => "rolling_30_day",
            Self::Custom => "custom",
        }
    }
}

/// `AiUsageBillingPeriod`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BillingPeriod {
    /// Where it comes from.
    pub source: PeriodSource,
    /// `startsAt` (ms).
    pub starts_at_ms: i64,
    /// `endsAt` (ms, exclusive).
    pub ends_at_ms: i64,
    /// First local day.
    pub from: String,
    /// Last local day.
    pub to: String,
    /// Days in the period.
    pub total_day_count: usize,
    /// Days elapsed.
    pub elapsed_day_count: usize,
}

impl BillingPeriod {
    /// `{source, startsAt, endsAt, endExclusive: true, from, to, totalDayCount, elapsedDayCount}`.
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("source".into(), Value::from(self.source.as_str()));
        map.insert("startsAt".into(), Value::from(iso(self.starts_at_ms)));
        map.insert("endsAt".into(), Value::from(iso(self.ends_at_ms)));
        map.insert("endExclusive".into(), Value::Bool(true));
        map.insert("from".into(), Value::from(self.from.as_str()));
        map.insert("to".into(), Value::from(self.to.as_str()));
        map.insert("totalDayCount".into(), Value::from(self.total_day_count));
        map.insert(
            "elapsedDayCount".into(),
            Value::from(self.elapsed_day_count),
        );
        Value::Object(map)
    }
}

/// `AiUsagePeriodResolution`.
#[derive(Clone, Debug, PartialEq)]
pub struct PeriodResolution {
    /// The window to read.
    pub window: Window,
    /// The billing period it belongs to.
    pub billing_period: BillingPeriod,
}

fn billing_period_from_window(window: &Window, source: PeriodSource) -> BillingPeriod {
    BillingPeriod {
        source,
        starts_at_ms: window.start_ms,
        ends_at_ms: window.end_exclusive_ms,
        from: window.from.clone(),
        to: window.to.clone(),
        total_day_count: window.days.len(),
        elapsed_day_count: window.days.len(),
    }
}

/// `addUtcCalendarMonths(anchor, months)`.
fn add_utc_calendar_months(anchor_ms: i64, months: i64) -> Option<i64> {
    let a = utc_fields(anchor_ms)?;
    let month = i64::from(a.month) + months;
    let first = date_utc(
        a.year,
        month,
        1,
        i64::from(a.hour),
        i64::from(a.minute),
        i64::from(a.second),
        i64::from(a.millisecond),
    )?;
    let target = utc_fields(first)?;
    let last_day = utc_fields(date_utc(
        target.year,
        i64::from(target.month) + 1,
        0,
        0,
        0,
        0,
        0,
    )?)?
    .day;
    date_utc(
        target.year,
        i64::from(target.month),
        i64::from(a.day.min(last_day)),
        i64::from(target.hour),
        i64::from(target.minute),
        i64::from(target.second),
        i64::from(target.millisecond),
    )
}

/// `resolveFreeCreditPeriod(anchor, now)`: the monthly period of the free plan's credits that
/// contains `now`, anchored on the account's creation; `None` before the anchor.
pub fn resolve_free_credit_period(anchor_ms: i64, now_ms: i64) -> Option<(i64, i64)> {
    if anchor_ms > now_ms {
        return None;
    }
    let a = utc_fields(anchor_ms)?;
    let n = utc_fields(now_ms)?;
    let mut offset = (n.year - a.year) * 12 + i64::from(n.month) - i64::from(a.month);
    let mut start = add_utc_calendar_months(anchor_ms, offset)?;
    if start > now_ms {
        offset -= 1;
        start = add_utc_calendar_months(anchor_ms, offset)?;
    }
    Some((start, add_utc_calendar_months(anchor_ms, offset + 1)?))
}

fn period_from_boundaries(
    source: PeriodSource,
    start_ms: i64,
    end_ms: i64,
    now_ms: i64,
    zone: Zone,
) -> Result<PeriodResolution, UsageReadError> {
    let local = |ms: i64| {
        zone.local_date(ms)
            .ok_or_else(|| UsageReadError::validation("Invalid timezone"))
    };
    let from = local(start_ms)?;
    let period_to = local(end_ms - 1)?;
    let elapsed_to = local(start_ms.max(now_ms.min(end_ms) - 1))?;
    let days = build_date_labels(&from, &elapsed_to, MAX_SUBSCRIPTION_DATE_BUCKETS)?;
    let total = build_date_labels(&from, &period_to, MAX_SUBSCRIPTION_DATE_BUCKETS)?;
    Ok(PeriodResolution {
        billing_period: BillingPeriod {
            source,
            starts_at_ms: start_ms,
            ends_at_ms: end_ms,
            from: from.clone(),
            to: period_to,
            total_day_count: total.len(),
            elapsed_day_count: days.len(),
        },
        window: Window {
            from,
            to: elapsed_to,
            zone,
            start_ms,
            end_exclusive_ms: end_ms,
            days,
        },
    })
}

/// A subscription's current period as the customer state lists it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SubscriptionPeriod {
    /// `status` (`None` when absent).
    pub status: Option<Value>,
    /// `currentPeriodStart`.
    pub start: Option<Value>,
    /// `currentPeriodEnd`.
    pub end: Option<Value>,
}

impl SubscriptionPeriod {
    /// One entry of `active_subscriptions` as Polar sends it (snake case) or as the SDK hands
    /// it over (camel case).
    pub fn from_json(value: &Value) -> Self {
        let get = |camel: &str, snake: &str| value.get(camel).or_else(|| value.get(snake)).cloned();
        Self {
            status: value.get("status").cloned(),
            start: get("currentPeriodStart", "current_period_start"),
            end: get("currentPeriodEnd", "current_period_end"),
        }
    }
}

/// `validDate(value)`: `new Date(String(value || ''))`.
fn valid_date(value: Option<&Value>) -> Option<i64> {
    if !js::truthy(value) {
        return None;
    }
    let text = dima_text::string_of(value?);
    dima_text::parse_date(&text)
}

/// `findCurrentSubscriptionPeriod(subscriptions, now)`.
fn current_subscription_period(
    subscriptions: &[SubscriptionPeriod],
    now_ms: i64,
) -> Option<(i64, i64)> {
    let mut candidates: Vec<(i64, i64)> = subscriptions
        .iter()
        .filter_map(|s| {
            let start = valid_date(s.start.as_ref())?;
            let end = valid_date(s.end.as_ref())?;
            let status_ok = match &s.status {
                None => true,
                Some(Value::String(status)) => status == "active" || status == "trialing",
                Some(_) => false,
            };
            (status_ok && start <= now_ms && now_ms < end && start < end).then_some((start, end))
        })
        .collect();
    candidates.sort_by_key(|c| std::cmp::Reverse(c.0));
    candidates.first().copied()
}

/// Reads a customer's active subscriptions (`customers.getState`); errors are the caller's
/// (the routes answer 502).
pub trait CustomerStates: Send + Sync {
    /// `activeSubscriptions` of the customer's state.
    fn active_subscriptions<'a>(
        &'a self,
        customer_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<SubscriptionPeriod>, String>>;
}

/// The input of `resolveAiUsagePeriod`.
#[derive(Clone, Copy, Debug, Default)]
pub struct PeriodInput<'a> {
    /// `customerId` (an empty text counts as unset).
    pub customer_id: Option<&'a str>,
    /// `freePeriodAnchor` (ms).
    pub free_period_anchor_ms: Option<i64>,
    /// `from`.
    pub from: Option<&'a str>,
    /// `to`.
    pub to: Option<&'a str>,
    /// `timeZone`.
    pub time_zone: Option<&'a str>,
    /// `now`.
    pub now_ms: i64,
    /// `maxDays`.
    pub max_days: Option<f64>,
}

/// Why `resolveAiUsagePeriod` failed.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum PeriodError {
    /// The request is refused (400 or 422).
    #[error(transparent)]
    Read(#[from] UsageReadError),
    /// Polar could not be read (the routes answer 502).
    #[error("customer state unavailable: {0}")]
    Polar(String),
}

/// `resolveAiUsagePeriod(input)`.
pub async fn resolve_period(
    input: PeriodInput<'_>,
    states: &dyn CustomerStates,
) -> Result<PeriodResolution, PeriodError> {
    let zone =
        Zone::parse(present(input.time_zone).unwrap_or("UTC")).map_err(UsageReadError::from)?;
    if present(input.from).is_some() || present(input.to).is_some() {
        let window = resolve_window_in(
            WindowInput {
                from: input.from,
                to: input.to,
                time_zone: None,
                now_ms: input.now_ms,
                max_days: input.max_days,
            },
            zone,
        )?;
        let billing_period = billing_period_from_window(&window, PeriodSource::Custom);
        return Ok(PeriodResolution {
            window,
            billing_period,
        });
    }
    if let Some(anchor) = input.free_period_anchor_ms
        && let Some((start, end)) = resolve_free_credit_period(anchor, input.now_ms)
    {
        return Ok(period_from_boundaries(
            PeriodSource::FreeMonthly,
            start,
            end,
            input.now_ms,
            zone,
        )?);
    }
    if let Some(customer) = present(input.customer_id) {
        let subscriptions = states
            .active_subscriptions(customer)
            .await
            .map_err(PeriodError::Polar)?;
        if let Some((start, end)) = current_subscription_period(&subscriptions, input.now_ms) {
            return Ok(period_from_boundaries(
                PeriodSource::Subscription,
                start,
                end,
                input.now_ms,
                zone,
            )?);
        }
    }
    let window = resolve_window_in(
        WindowInput {
            now_ms: input.now_ms,
            ..WindowInput::default()
        },
        zone,
    )?;
    let billing_period = billing_period_from_window(&window, PeriodSource::Rolling30Day);
    Ok(PeriodResolution {
        window,
        billing_period,
    })
}

/// `Math.round(value * 10 ** places) / 10 ** places`.
fn rounded(value: f64, places: i32) -> f64 {
    let multiplier = 10_f64.powi(places);
    js::round(value * multiplier) / multiplier
}

/// The credit figures pacing reads (`Pick<AiCreditsData, 'used' | 'limit' | 'balance' |
/// 'available' | 'status'>`).
#[derive(Clone, Debug, PartialEq)]
pub struct PacingCredits {
    /// `used`.
    pub used: f64,
    /// `limit`.
    pub limit: f64,
    /// `balance`.
    pub balance: f64,
    /// `available`.
    pub available: bool,
    /// `status`.
    pub status: String,
}

/// `AiUsagePacingHistory` (the dashboard's history).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PacingHistory {
    /// `averageDailyCredits`.
    pub average_daily_credits: f64,
    /// `totalSpentCredits`.
    pub total_spent_credits: f64,
    /// `dayCount`.
    pub day_count: f64,
    /// `from`.
    pub from: String,
    /// `to`.
    pub to: String,
    /// `activeDayCount`.
    pub active_day_count: Option<f64>,
    /// `coefficientOfVariation`.
    pub coefficient_of_variation: Option<f64>,
    /// `recentAverageDailyCredits`.
    pub recent_average_daily_credits: Option<f64>,
    /// `recentDayCount`.
    pub recent_day_count: Option<f64>,
}

impl PacingHistory {
    /// The history of a dashboard's JSON (`null` and anything else that is not an object is
    /// none).
    pub fn from_json(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let number = |key: &str| object.get(key).and_then(Value::as_f64);
        let text = |key: &str| {
            object
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned()
        };
        Some(Self {
            average_daily_credits: number("averageDailyCredits").unwrap_or(f64::NAN),
            total_spent_credits: number("totalSpentCredits").unwrap_or(f64::NAN),
            day_count: number("dayCount").unwrap_or(f64::NAN),
            from: text("from"),
            to: text("to"),
            active_day_count: number("activeDayCount"),
            coefficient_of_variation: number("coefficientOfVariation"),
            recent_average_daily_credits: number("recentAverageDailyCredits"),
            recent_day_count: number("recentDayCount"),
        })
    }
}

/// `buildAiUsagePacing(input)` as JSON (`null` when it does not apply).
pub fn build_pacing(
    credits: &PacingCredits,
    period: &BillingPeriod,
    history: Option<&PacingHistory>,
    history_complete: Option<bool>,
    now_ms: i64,
) -> Value {
    if !matches!(
        period.source,
        PeriodSource::Subscription | PeriodSource::FreeMonthly
    ) || !credits.available
    {
        return Value::Null;
    }
    let (start, end) = (period.starts_at_ms, period.ends_at_ms);
    if start >= end {
        return Value::Null;
    }
    #[allow(clippy::cast_precision_loss)]
    let (start, end, now, day) = (start as f64, end as f64, now_ms as f64, DAY_MS as f64);
    let is_subscription = period.source == PeriodSource::Subscription;
    let total_days = (end - start) / day;
    let elapsed_days = js::max(1.0, js::min(total_days, (js::min(now, end) - start) / day));
    let remaining = js::max(0.0, (end - js::max(now, start)) / day);
    let used = js::max(0.0, credits.used);
    let limit = js::max(0.0, credits.limit);
    let balance = js::max(0.0, credits.balance);
    let current_cycle = used / elapsed_days;
    let usable = history.filter(|h| h.day_count >= MINIMUM_PACING_HISTORY_DAYS);
    let forecast_daily = usable.map_or(current_cycle, |h| js::max(0.0, h.average_daily_credits));
    let projected = used + forecast_daily * remaining;
    let available_for_forecast = js::max(limit, credits.used + balance);
    let overage = js::max(0.0, (projected - available_for_forecast).ceil());
    let estimated_days = if balance <= 0.0 {
        Some(0.0)
    } else if forecast_daily > 0.0 {
        Some(balance / forecast_daily)
    } else {
        None
    };
    let expected_to_exhaust = estimated_days.is_some_and(|d| d < remaining);
    let show_estimate = balance <= 0.0 || expected_to_exhaust;
    let exhaustion_at = match estimated_days {
        Some(days) if show_estimate => {
            js::time_clip(now + days * day).map_or(Value::Null, |ms| Value::from(iso(ms)))
        }
        _ => Value::Null,
    };
    let status = if credits.status == "exhausted" || balance <= 0.0 {
        "exhausted"
    } else if forecast_daily <= 0.0 {
        "no_usage"
    } else if expected_to_exhaust {
        "over_pace"
    } else {
        "within_pace"
    };
    let history_days = usable
        .map(|h| h.day_count)
        .filter(|d| *d != 0.0 && !d.is_nan())
        .unwrap_or(elapsed_days);
    let active_days = usable.and_then(|h| h.active_day_count).unwrap_or(0.0);
    let variability = usable
        .and_then(|h| h.coefficient_of_variation)
        .unwrap_or(f64::INFINITY);
    let mut reasons = Vec::new();
    if history_days < 7.0 {
        reasons.push("insufficient_history");
    }
    if active_days < 3.0 {
        reasons.push("limited_activity");
    }
    if variability.is_finite() && variability > 1.0 {
        reasons.push("variable_usage");
    }
    if history_complete == Some(false) {
        reasons.push("history_sync_pending");
    }
    let confidence = if history_complete == Some(false) || history_days < 7.0 || active_days < 3.0 {
        "low"
    } else if history_days >= 21.0 && active_days >= 7.0 && variability <= 1.0 {
        "high"
    } else {
        "medium"
    };
    let percent = |part: f64| {
        if limit > 0.0 {
            rounded(part / limit * 100.0, 2)
        } else {
            0.0
        }
    };
    let mut map = Map::new();
    map.insert("status".into(), Value::from(status));
    map.insert("confidence".into(), Value::from(confidence));
    map.insert(
        "confidenceReasons".into(),
        Value::Array(reasons.into_iter().map(Value::from).collect()),
    );
    map.insert(
        "recentAverageDailyCredits".into(),
        history
            .and_then(|h| h.recent_average_daily_credits)
            .map_or(Value::Null, |v| num(rounded(v, 2))),
    );
    map.insert(
        "recentHistoryDays".into(),
        num(history
            .and_then(|h| h.recent_day_count)
            .filter(|d| *d != 0.0 && !d.is_nan())
            .unwrap_or(0.0)),
    );
    map.insert(
        "forecastBasis".into(),
        Value::from(if is_subscription {
            "current_billing_period"
        } else {
            "current_free_credit_period"
        }),
    );
    map.insert(
        "forecastRateBasis".into(),
        Value::from(if usable.is_some() {
            "retention_history"
        } else {
            "current_cycle"
        }),
    );
    map.insert(
        "quotaUsedPercent".into(),
        num(percent(js::max(0.0, credits.used))),
    );
    map.insert(
        "averageDailyCredits".into(),
        num(rounded(forecast_daily, 2)),
    );
    map.insert(
        "currentCycleAverageDailyCredits".into(),
        num(rounded(current_cycle, 2)),
    );
    map.insert(
        "historicalAverageDailyCredits".into(),
        usable.map_or(Value::Null, |h| num(rounded(h.average_daily_credits, 2))),
    );
    map.insert(
        "forecastHistoryDays".into(),
        num(usable.map_or(0.0, |h| rounded(h.day_count, 1))),
    );
    map.insert("projectedPeriodCredits".into(), num(js::round(projected)));
    map.insert("projectedQuotaUsedPercent".into(), num(percent(projected)));
    map.insert("projectedOverageCredits".into(), num(overage));
    map.insert("remainingPeriodDays".into(), num(rounded(remaining, 2)));
    map.insert(
        "dailyCreditsToLastPeriod".into(),
        num(if remaining > 0.0 {
            rounded(balance / remaining, 2)
        } else {
            0.0
        }),
    );
    map.insert(
        "expectedToExhaustWithinPeriod".into(),
        Value::Bool(expected_to_exhaust),
    );
    map.insert(
        "estimatedDaysUntilExhaustion".into(),
        match estimated_days {
            Some(days) if show_estimate => num(rounded(days, 1)),
            _ => Value::Null,
        },
    );
    map.insert("estimatedExhaustionAt".into(), exhaustion_at);
    Value::Object(map)
}

/// `AiUsageTransaction`: one line of the usage history.
#[derive(Clone, Debug, PartialEq)]
pub struct Transaction {
    /// `id` (the entry id).
    pub id: String,
    /// `requestId`.
    pub request_id: Option<String>,
    /// `occurredAt` (ms; written as ISO text).
    pub occurred_at_ms: i64,
    /// `entryKind`.
    pub entry_kind: EntryKind,
    /// `category` (one of the receipt categories, or `uncategorized`).
    pub category: String,
    /// `operation`.
    pub operation: String,
    /// `source`.
    pub source: Option<String>,
    /// `adjustmentType`.
    pub adjustment_type: Option<String>,
    /// `provider`.
    pub provider: String,
    /// `model`.
    pub model: Option<String>,
    /// `quantity`.
    pub quantity: Option<f64>,
    /// `unit`.
    pub unit: Option<Unit>,
    /// `credits` (negative for a grant).
    pub credits: f64,
    /// `resourceType`.
    pub resource_type: Option<ResourceType>,
    /// `resourceId`.
    pub resource_id: Option<String>,
    /// `itemized`.
    pub itemized: bool,
}

fn text_or_null(value: Option<&str>) -> Value {
    value.map_or(Value::Null, Value::from)
}

impl Transaction {
    /// The ISO text of `occurredAt`.
    pub fn occurred_at(&self) -> String {
        iso(self.occurred_at_ms)
    }

    /// The transaction as the API sends it.
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("id".into(), Value::from(self.id.as_str()));
        map.insert("requestId".into(), text_or_null(self.request_id.as_deref()));
        map.insert("occurredAt".into(), Value::from(self.occurred_at()));
        map.insert("entryKind".into(), Value::from(self.entry_kind.as_str()));
        map.insert("category".into(), Value::from(self.category.as_str()));
        map.insert("operation".into(), Value::from(self.operation.as_str()));
        map.insert("source".into(), text_or_null(self.source.as_deref()));
        map.insert(
            "adjustmentType".into(),
            text_or_null(self.adjustment_type.as_deref()),
        );
        map.insert("provider".into(), Value::from(self.provider.as_str()));
        map.insert("model".into(), text_or_null(self.model.as_deref()));
        map.insert("quantity".into(), self.quantity.map_or(Value::Null, num));
        map.insert("unit".into(), text_or_null(self.unit.map(Unit::as_str)));
        map.insert("credits".into(), num(self.credits));
        map.insert(
            "resourceType".into(),
            text_or_null(self.resource_type.map(ResourceType::as_str)),
        );
        map.insert(
            "resourceId".into(),
            text_or_null(self.resource_id.as_deref()),
        );
        map.insert("itemized".into(), Value::Bool(self.itemized));
        Value::Object(map)
    }
}

/// `localeCompare`, with code-unit order if the collator cannot be built (never on a normal
/// build: the data is compiled in).
pub(crate) fn locale_compare(left: &str, right: &str) -> Ordering {
    use std::sync::OnceLock;
    static COLLATOR: OnceLock<Option<dima_text::Collator>> = OnceLock::new();
    match COLLATOR.get_or_init(|| dima_text::Collator::new().ok()) {
        Some(collator) => collator.compare(left, right),
        None => dima_text::cmp_utf16(left, right),
    }
}

/// `transactionOrder`: newest first, then the id, both by `localeCompare`.
pub fn transaction_order(left: &Transaction, right: &Transaction) -> Ordering {
    locale_compare(&right.occurred_at(), &left.occurred_at())
        .then_with(|| locale_compare(&right.id, &left.id))
}

/// `buildAiUsageSummary(transactions, window)` as JSON.
pub fn build_summary(transactions: &[Transaction], window: &Window) -> Value {
    let mut daily: Vec<(String, f64, f64)> =
        window.days.iter().map(|d| (d.clone(), 0.0, 0.0)).collect();
    let mut categories: Vec<(String, f64, f64)> = Vec::new();
    let (mut spent, mut granted, mut count) = (0.0, 0.0, 0.0);
    for transaction in transactions {
        if transaction.credits <= 0.0 || transaction.entry_kind == EntryKind::Adjustment {
            if transaction.credits < 0.0 {
                granted += transaction.credits.abs();
            }
            continue;
        }
        spent += transaction.credits;
        count += 1.0;
        let date = window
            .zone
            .local_date(transaction.occurred_at_ms)
            .unwrap_or_default();
        if let Some(day) = daily.iter_mut().find(|d| d.0 == date) {
            day.1 += transaction.credits;
            day.2 += 1.0;
        }
        match categories.iter_mut().find(|c| c.0 == transaction.category) {
            Some(category) => {
                category.1 += transaction.credits;
                category.2 += 1.0;
            }
            None => categories.push((transaction.category.clone(), transaction.credits, 1.0)),
        }
    }
    // `(b.credits - a.credits) || a.category.localeCompare(b.category)`: a stable sort.
    categories.sort_by(|a, b| {
        let difference = b.1 - a.1;
        if difference != 0.0 && !difference.is_nan() {
            difference.partial_cmp(&0.0).unwrap_or(Ordering::Equal)
        } else {
            locale_compare(&a.0, &b.0)
        }
    });
    #[allow(clippy::cast_precision_loss)]
    let day_count = window.days.len() as f64;
    let mut map = Map::new();
    map.insert("schemaVersion".into(), Value::from(RECEIPT_SCHEMA_VERSION));
    map.insert(
        "itemizationStartedAt".into(),
        Value::from(ITEMIZATION_STARTED_AT),
    );
    map.insert("period".into(), window.period_json());
    map.insert("totalSpentCredits".into(), num(spent));
    map.insert(
        "averageDailySpentCredits".into(),
        num(js::round(spent / day_count * 100.0) / 100.0),
    );
    map.insert("grantedCredits".into(), num(granted));
    map.insert("netConsumedCredits".into(), num(spent - granted));
    map.insert("transactionCount".into(), num(count));
    map.insert(
        "daily".into(),
        Value::Array(
            daily
                .into_iter()
                .map(|(date, credits, count)| {
                    let mut day = Map::new();
                    day.insert("date".into(), Value::from(date));
                    day.insert("credits".into(), num(credits));
                    day.insert("transactionCount".into(), num(count));
                    Value::Object(day)
                })
                .collect(),
        ),
    );
    map.insert(
        "categories".into(),
        Value::Array(
            categories
                .into_iter()
                .map(|(category, credits, count)| {
                    let mut row = Map::new();
                    row.insert("category".into(), Value::from(category));
                    row.insert("credits".into(), num(credits));
                    row.insert("transactionCount".into(), num(count));
                    row.insert(
                        "percentage".into(),
                        num(if spent > 0.0 {
                            js::round(credits / spent * 10_000.0) / 100.0
                        } else {
                            0.0
                        }),
                    );
                    Value::Object(row)
                })
                .collect(),
        ),
    );
    Value::Object(map)
}

/// The receipt categories (`RECEIPT_CATEGORIES`).
pub const RECEIPT_CATEGORIES: [&str; 7] = [
    "tts",
    "ai_chat",
    "ai_agent",
    "memory",
    "clip_recommendation",
    "credit_adjustment",
    "other",
];

/// A page of transactions.
#[derive(Clone, Debug, PartialEq)]
pub struct TransactionPage {
    /// The items.
    pub items: Vec<Transaction>,
    /// The cursor of the next page.
    pub next_cursor: Option<String>,
}

fn base64url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// `Buffer.from(value, 'base64url')`: both alphabets, padding and anything after it ignored,
/// other characters refused (Node skips them; a cursor is always one this server wrote).
pub(crate) fn decode_base64url(value: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let cleaned: String = value
        .chars()
        .take_while(|c| *c != '=')
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            other => other,
        })
        .collect();
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cleaned.as_bytes())
        .ok()
}

/// `paginateAiUsageTransactions(input)`: the in-memory pagination with an opaque cursor
/// (`{id, at}` in base64url).
pub fn paginate_transactions(
    transactions: &[Transaction],
    category: Option<&str>,
    cursor: Option<&str>,
    limit: Option<f64>,
) -> Result<TransactionPage, UsageReadError> {
    let category = category.map(dima_text::trim).filter(|c| !c.is_empty());
    if let Some(c) = category
        && c != "uncategorized"
        && !RECEIPT_CATEGORIES.contains(&c)
    {
        return Err(UsageReadError::validation("Invalid usage category"));
    }
    let limit = limit.unwrap_or(25.0);
    if limit.fract() != 0.0 || !(1.0..=100.0).contains(&limit) {
        return Err(UsageReadError::validation(
            "limit must be between 1 and 100",
        ));
    }
    let mut filtered: Vec<&Transaction> = transactions
        .iter()
        .filter(|t| category.is_none_or(|c| t.category == c))
        .collect();
    filtered.sort_by(|a, b| transaction_order(a, b));
    let mut start = 0;
    if let Some(cursor) = cursor.filter(|c| !c.is_empty()) {
        let invalid = || UsageReadError::validation("Invalid transaction cursor");
        let bytes = decode_base64url(cursor).ok_or_else(invalid)?;
        let parsed: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        let (Some(id), Some(at)) = (
            parsed.get("id").and_then(Value::as_str),
            parsed.get("at").and_then(Value::as_str),
        ) else {
            return Err(invalid());
        };
        let index = filtered
            .iter()
            .position(|t| t.id == id && t.occurred_at() == at)
            .ok_or_else(|| {
                UsageReadError::validation("Transaction cursor is no longer available")
            })?;
        start = index + 1;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let limit = limit as usize;
    let items: Vec<Transaction> = filtered
        .iter()
        .skip(start)
        .take(limit)
        .map(|t| (*t).clone())
        .collect();
    let has_next = start + items.len() < filtered.len();
    let next_cursor = match items.last() {
        Some(last) if has_next => {
            let mut map = Map::new();
            map.insert("id".into(), Value::from(last.id.as_str()));
            map.insert("at".into(), Value::from(last.occurred_at()));
            Some(base64url(
                dima_text::to_js_json(&Value::Object(map)).as_bytes(),
            ))
        }
        _ => None,
    };
    Ok(TransactionPage { items, next_cursor })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_follow_date_utc() {
        assert!(parse_date_label("2026-02-29", "from").is_err());
        assert!(parse_date_label("2024-02-29", "from").is_ok());
        // Date.UTC maps years 0 to 99 to 1900 to 1999.
        assert_eq!(
            parse_date_label("0050-01-01", "from"),
            Err(UsageReadError::validation("from is not a valid date"))
        );
        assert_eq!(
            parse_date_label("2026-1-01", "to"),
            Err(UsageReadError::validation("to must use YYYY-MM-DD"))
        );
        assert_eq!(shift_date_label("2026-03-01", -1).unwrap(), "2026-02-28");
    }

    #[test]
    fn calendar_months_clamp_to_the_last_day() {
        let jan31 = dima_text::parse_date("2026-01-31T10:00:00.000Z").unwrap();
        let feb = add_utc_calendar_months(jan31, 1).unwrap();
        assert_eq!(iso(feb), "2026-02-28T10:00:00.000Z");
    }
}

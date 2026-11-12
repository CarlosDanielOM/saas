//! The reference's cases for the usage page's pure parts, ported one by one with their names:
//! `dimabot/src/utils/ai_usage_receipts.test.ts` and `ai_native_credit_reports.test.ts`; plus
//! the request Polar receives for one page of events (recorded from `@polar-sh/sdk` 0.42.5),
//! and text with emoji, combining marks and right-to-left letters.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use dima_billing::credit_sources::{CreditSourceError, CreditSourceReads};
use dima_billing::polar::{PolarClient, PolarError};
use dima_billing::usage::EntryKind;
use dima_billing::usage_ledger::history::{
    EventsRequest, UsageEvents, fetch_transactions, normalize_credit_event, normalize_usage_event,
};
use dima_billing::usage_ledger::report::{
    BillingPeriod, CustomerStates, PacingCredits, PacingHistory, PeriodInput, PeriodSource,
    SubscriptionPeriod, Transaction, UsageReadError, WindowInput, build_pacing, build_summary,
    paginate_transactions, resolve_period, resolve_window,
};
use dima_core::SecretString;
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer};
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use std::sync::Mutex;

fn at(text: &str) -> i64 {
    dima_text::parse_date(text).unwrap()
}

fn iso(ms: i64) -> String {
    dima_text::to_iso_string(ms).unwrap()
}

fn event(id: &str, timestamp: &str, credits: f64, extra: Value) -> Value {
    let mut metadata = json!({ "credits": credits });
    for (key, value) in extra.as_object().unwrap() {
        metadata[key] = value.clone();
    }
    json!({"id": id, "name": "ai_usage", "source": "user", "timestamp": timestamp, "metadata": metadata})
}

struct States(Vec<SubscriptionPeriod>);

impl CustomerStates for States {
    fn active_subscriptions<'a>(
        &'a self,
        _customer_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<SubscriptionPeriod>, String>> {
        Box::pin(async move { Ok(self.0.clone()) })
    }
}

fn subscription(start: &str, end: &str) -> States {
    States(vec![SubscriptionPeriod::from_json(&json!({
        "status": "active", "currentPeriodStart": start, "currentPeriodEnd": end,
    }))])
}

fn period(
    source: PeriodSource,
    starts: &str,
    ends: &str,
    from: &str,
    to: &str,
    total: usize,
    elapsed: usize,
) -> BillingPeriod {
    BillingPeriod {
        source,
        starts_at_ms: at(starts),
        ends_at_ms: at(ends),
        from: from.into(),
        to: to.into(),
        total_day_count: total,
        elapsed_day_count: elapsed,
    }
}

fn credits(used: f64, limit: f64, balance: f64) -> PacingCredits {
    PacingCredits {
        used,
        limit,
        balance,
        available: true,
        status: "available".into(),
    }
}

#[test]
fn usage_windows_use_local_calendar_dates_and_include_zero_spend_days() {
    let window = resolve_window(WindowInput {
        from: Some("2026-03-07"),
        to: Some("2026-03-09"),
        time_zone: Some("America/New_York"),
        now_ms: at("2026-03-10T12:00:00Z"),
        max_days: None,
    })
    .unwrap();
    assert_eq!(window.days, ["2026-03-07", "2026-03-08", "2026-03-09"]);
    assert_eq!(iso(window.start_ms), "2026-03-07T05:00:00.000Z");
    assert_eq!(iso(window.end_exclusive_ms), "2026-03-10T04:00:00.000Z");
}

#[test]
fn usage_windows_reject_invalid_timezones_and_ranges_over_31_days() {
    assert_eq!(
        resolve_window(WindowInput {
            time_zone: Some("Mars/Olympus"),
            ..WindowInput::default()
        }),
        Err(UsageReadError::Validation("Invalid timezone".into()))
    );
    let error = resolve_window(WindowInput {
        from: Some("2026-01-01"),
        to: Some("2026-02-01"),
        time_zone: Some("UTC"),
        now_ms: at("2026-03-01T00:00:00Z"),
        max_days: None,
    })
    .unwrap_err();
    assert!(matches!(error, UsageReadError::Limit(_)), "{error:?}");
    assert_eq!(error.status(), 422);
}

#[test]
fn plan_specific_windows_allow_60_premium_days_and_90_pro_days() {
    let window = |from: &str, max: f64| {
        resolve_window(WindowInput {
            from: Some(from),
            to: Some("2026-09-19"),
            time_zone: Some("UTC"),
            now_ms: at("2026-09-19T20:00:00Z"),
            max_days: Some(max),
        })
    };
    assert_eq!(window("2026-07-22", 60.0).unwrap().days.len(), 60);
    assert_eq!(window("2026-06-22", 90.0).unwrap().days.len(), 90);
    assert!(matches!(
        window("2026-07-21", 60.0),
        Err(UsageReadError::Limit(_))
    ));
}

#[tokio::test]
async fn default_paid_usage_period_follows_the_active_polar_subscription_boundaries() {
    let states = subscription("2026-09-07T10:00:00Z", "2026-10-07T10:00:00Z");
    let period = resolve_period(
        PeriodInput {
            customer_id: Some("customer-1"),
            time_zone: Some("UTC"),
            now_ms: at("2026-09-15T12:00:00Z"),
            ..PeriodInput::default()
        },
        &states,
    )
    .await
    .unwrap();
    let billing = &period.billing_period;
    assert_eq!(billing.source, PeriodSource::Subscription);
    assert_eq!(iso(billing.starts_at_ms), "2026-09-07T10:00:00.000Z");
    assert_eq!(iso(billing.ends_at_ms), "2026-10-07T10:00:00.000Z");
    assert_eq!(billing.from, "2026-09-07");
    assert_eq!(billing.to, "2026-10-07");
    assert_eq!(billing.total_day_count, 31);
    assert_eq!(billing.elapsed_day_count, 9);
    assert_eq!(period.window.from, "2026-09-07");
    assert_eq!(period.window.to, "2026-09-15");
    assert_eq!(iso(period.window.start_ms), "2026-09-07T10:00:00.000Z");
    assert_eq!(
        iso(period.window.end_exclusive_ms),
        "2026-10-07T10:00:00.000Z"
    );
}

#[tokio::test]
async fn monthly_subscription_periods_allow_partial_start_and_renewal_date_buckets() {
    let states = subscription("2026-08-20T07:06:23.993Z", "2026-09-20T07:06:23.993Z");
    let period = resolve_period(
        PeriodInput {
            customer_id: Some("customer-1"),
            time_zone: Some("UTC"),
            now_ms: at("2026-09-19T01:00:00Z"),
            ..PeriodInput::default()
        },
        &states,
    )
    .await
    .unwrap();
    assert_eq!(period.billing_period.total_day_count, 32);
    assert_eq!(period.billing_period.elapsed_day_count, 31);
    assert_eq!(period.billing_period.from, "2026-08-20");
    assert_eq!(period.billing_period.to, "2026-09-20");
}

#[test]
fn pacing_estimates_exhaustion_from_unchanged_credit_totals() {
    let pacing = build_pacing(
        &credits(250_000.0, 500_000.0, 250_000.0),
        &period(
            PeriodSource::Subscription,
            "2026-09-07T00:00:00.000Z",
            "2026-10-07T00:00:00.000Z",
            "2026-09-07",
            "2026-10-06",
            30,
            7,
        ),
        None,
        None,
        at("2026-09-14T00:00:00.000Z"),
    );
    assert_eq!(
        dima_text::to_js_json(&pacing),
        dima_text::to_js_json(&json!({
            "status": "over_pace",
            "confidence": "low", "confidenceReasons": ["limited_activity"],
            "recentAverageDailyCredits": null, "recentHistoryDays": 0,
            "forecastBasis": "current_billing_period",
            "forecastRateBasis": "current_cycle",
            "quotaUsedPercent": 50,
            "averageDailyCredits": 35_714.29,
            "currentCycleAverageDailyCredits": 35_714.29,
            "historicalAverageDailyCredits": null,
            "forecastHistoryDays": 0,
            "projectedPeriodCredits": 1_071_429,
            "projectedQuotaUsedPercent": 214.29,
            "projectedOverageCredits": 571_429,
            "remainingPeriodDays": 23,
            "dailyCreditsToLastPeriod": 10_869.57,
            "expectedToExhaustWithinPeriod": true,
            "estimatedDaysUntilExhaustion": 7,
            "estimatedExhaustionAt": "2026-09-21T00:00:00.000Z",
        }))
    );
}

fn history(average: f64, total: f64, days: f64, from: &str, to: &str) -> PacingHistory {
    PacingHistory {
        average_daily_credits: average,
        total_spent_credits: total,
        day_count: days,
        from: from.into(),
        to: to.into(),
        ..PacingHistory::default()
    }
}

#[test]
fn pacing_uses_retained_history_to_smooth_the_remaining_cycle_forecast() {
    let pacing = build_pacing(
        &credits(250_000.0, 500_000.0, 250_000.0),
        &period(
            PeriodSource::Subscription,
            "2026-09-07T00:00:00.000Z",
            "2026-10-07T00:00:00.000Z",
            "2026-09-07",
            "2026-10-06",
            30,
            7,
        ),
        Some(&history(
            5_000.0,
            450_000.0,
            90.0,
            "2026-06-17",
            "2026-09-14",
        )),
        None,
        at("2026-09-14T00:00:00.000Z"),
    );
    assert_eq!(pacing["forecastRateBasis"], "retention_history");
    assert_eq!(pacing["averageDailyCredits"], 5_000.0);
    assert_eq!(pacing["currentCycleAverageDailyCredits"], 35_714.29);
    assert_eq!(pacing["historicalAverageDailyCredits"], 5_000.0);
    assert_eq!(pacing["forecastHistoryDays"], 90.0);
    assert_eq!(pacing["projectedPeriodCredits"], 365_000.0);
    assert_eq!(pacing["projectedOverageCredits"], 0.0);
    assert_eq!(pacing["expectedToExhaustWithinPeriod"], false);
}

#[test]
fn pacing_waits_for_seven_historical_days_before_using_the_retained_average() {
    let pacing = build_pacing(
        &credits(70.0, 300.0, 230.0),
        &period(
            PeriodSource::FreeMonthly,
            "2026-09-07T00:00:00.000Z",
            "2026-10-07T00:00:00.000Z",
            "2026-09-07",
            "2026-10-06",
            30,
            7,
        ),
        Some(&history(1.0, 3.0, 3.0, "2026-09-11", "2026-09-14")),
        None,
        at("2026-09-14T00:00:00.000Z"),
    );
    assert_eq!(pacing["forecastRateBasis"], "current_cycle");
    assert_eq!(pacing["averageDailyCredits"], 10.0);
    assert_eq!(pacing["historicalAverageDailyCredits"], Value::Null);
}

#[test]
fn retained_history_forecasts_a_newly_reset_cycle_with_zero_current_usage() {
    let pacing = build_pacing(
        &credits(0.0, 100.0, 100.0),
        &period(
            PeriodSource::Subscription,
            "2026-09-14T00:00:00.000Z",
            "2026-10-14T00:00:00.000Z",
            "2026-09-14",
            "2026-10-13",
            30,
            1,
        ),
        Some(&history(10.0, 900.0, 90.0, "2026-06-17", "2026-09-14")),
        None,
        at("2026-09-14T00:00:00.000Z"),
    );
    assert_eq!(pacing["forecastRateBasis"], "retention_history");
    assert_eq!(pacing["status"], "over_pace");
    assert_eq!(pacing["projectedPeriodCredits"], 300.0);
}

#[tokio::test]
async fn free_pacing_follows_the_account_creation_monthly_anniversary() {
    let period = resolve_period(
        PeriodInput {
            free_period_anchor_ms: Some(at("2026-09-07T00:00:00.000Z")),
            time_zone: Some("UTC"),
            now_ms: at("2026-09-14T00:00:00.000Z"),
            ..PeriodInput::default()
        },
        &States(Vec::new()),
    )
    .await
    .unwrap();
    let pacing = build_pacing(
        &credits(12_500.0, 25_000.0, 12_500.0),
        &period.billing_period,
        None,
        None,
        at("2026-09-14T00:00:00.000Z"),
    );
    assert_eq!(period.billing_period.source, PeriodSource::FreeMonthly);
    assert_eq!(
        iso(period.billing_period.starts_at_ms),
        "2026-09-07T00:00:00.000Z"
    );
    assert_eq!(
        iso(period.billing_period.ends_at_ms),
        "2026-10-07T00:00:00.000Z"
    );
    assert_eq!(pacing["forecastBasis"], "current_free_credit_period");
    assert_eq!(pacing["status"], "over_pace");
    assert_eq!(pacing["projectedPeriodCredits"], 53_571.0);
    assert_eq!(pacing["projectedOverageCredits"], 28_572.0);
    assert_eq!(pacing["estimatedDaysUntilExhaustion"], 7.0);
}

#[test]
fn pacing_omits_exhaustion_estimates_that_fall_after_the_credit_reset() {
    let pacing = build_pacing(
        &credits(10.0, 100.0, 90.0),
        &period(
            PeriodSource::Subscription,
            "2026-09-01T00:00:00.000Z",
            "2026-10-01T00:00:00.000Z",
            "2026-09-01",
            "2026-09-30",
            30,
            15,
        ),
        None,
        None,
        at("2026-09-16T00:00:00.000Z"),
    );
    assert_eq!(pacing["status"], "within_pace");
    assert_eq!(pacing["expectedToExhaustWithinPeriod"], false);
    assert_eq!(pacing["estimatedDaysUntilExhaustion"], Value::Null);
    assert_eq!(pacing["estimatedExhaustionAt"], Value::Null);
}

#[test]
fn polar_event_normalization_exposes_only_receipt_safe_fields() {
    let normalized = normalize_usage_event(&json!({
        "id": "polar-event-1", "name": "ai_usage", "source": "user",
        "timestamp": "2026-09-19T12:00:00Z",
        "metadata": {
            "schema_version": 1, "entry_id": "entry-1", "request_id": "request-1",
            "entry_kind": "usage", "category": "tts", "operation": "synthesize",
            "provider": "fish", "model": "fish-v1", "quantity": 100, "unit": "characters",
            "resource_type": "speech", "resource_id": "speech-1", "credits": 150,
            "text": "private speech", "prompt": "private prompt", "message": "private message",
        },
    }))
    .unwrap();
    assert_eq!(
        dima_text::to_js_json(&normalized.to_json()),
        r#"{"id":"entry-1","requestId":"request-1","occurredAt":"2026-09-19T12:00:00.000Z","entryKind":"usage","category":"tts","operation":"synthesize","source":null,"adjustmentType":null,"provider":"fish","model":"fish-v1","quantity":100,"unit":"characters","credits":150,"resourceType":"speech","resourceId":"speech-1","itemized":true}"#
    );
    let text = dima_text::to_js_json(&normalized.to_json());
    for private in ["private speech", "private prompt", "private message"] {
        assert!(!text.contains(private));
    }
}

#[test]
fn summary_separates_spend_from_grants_and_groups_legacy_usage_as_uncategorized() {
    let window = resolve_window(WindowInput {
        from: Some("2026-09-17"),
        to: Some("2026-09-19"),
        time_zone: Some("UTC"),
        now_ms: at("2026-09-19T20:00:00Z"),
        max_days: None,
    })
    .unwrap();
    let transactions: Vec<Transaction> = [
        event("tts", "2026-09-19T12:00:00Z", 150.0, json!({"category": "tts", "operation": "synthesize", "provider": "fish", "schema_version": 1})),
        event("chat", "2026-09-19T10:00:00Z", 50.0, json!({"category": "ai_chat", "operation": "message", "provider": "openrouter", "schema_version": 1})),
        event("grant", "2026-09-18T10:00:00Z", -1000.0, json!({"category": "credit_adjustment", "entry_kind": "adjustment", "schema_version": 1})),
        event("legacy", "2026-09-17T10:00:00Z", 25.0, json!({})),
    ]
    .iter()
    .map(|e| normalize_usage_event(e).unwrap())
    .collect();
    let summary = build_summary(&transactions, &window);
    assert_eq!(summary["totalSpentCredits"], 225.0);
    assert_eq!(summary["averageDailySpentCredits"], 75.0);
    assert_eq!(summary["grantedCredits"], 1000.0);
    assert_eq!(summary["netConsumedCredits"], -775.0);
    assert_eq!(summary["transactionCount"], 3.0);
    assert_eq!(
        dima_text::to_js_json(&summary["daily"]),
        r#"[{"date":"2026-09-17","credits":25,"transactionCount":1},{"date":"2026-09-18","credits":0,"transactionCount":0},{"date":"2026-09-19","credits":200,"transactionCount":2}]"#
    );
    assert_eq!(
        dima_text::to_js_json(&summary["categories"]),
        r#"[{"category":"tts","credits":150,"transactionCount":1,"percentage":66.67},{"category":"ai_chat","credits":50,"transactionCount":1,"percentage":22.22},{"category":"uncategorized","credits":25,"transactionCount":1,"percentage":11.11}]"#
    );
}

/// `listEvents` as a closure over the request.
struct Events<F>(F, Mutex<Vec<String>>);

impl<F> UsageEvents for Events<F>
where
    F: Fn(&EventsRequest) -> Value + Send + Sync,
{
    fn page<'a>(&'a self, request: &'a EventsRequest) -> BoxFuture<'a, Result<Value, PolarError>> {
        self.1.lock().unwrap().push(format!(
            "{}:{}:{}",
            request.name, request.source, request.page
        ));
        let page = (self.0)(request);
        Box::pin(async move { Ok(page) })
    }
}

/// No grant or order is known (every credit stays `native_grant`).
struct NoReads;

impl CreditSourceReads for NoReads {
    fn grant<'a>(
        &'a mut self,
        _id: &'a str,
    ) -> BoxFuture<'a, Result<Option<Value>, CreditSourceError>> {
        Box::pin(async { Ok(None) })
    }
    fn order<'a>(&'a mut self, _id: &'a str) -> BoxFuture<'a, Result<Value, CreditSourceError>> {
        Box::pin(async { Err(CreditSourceError::Malformed) })
    }
}

#[tokio::test]
async fn polar_event_fetching_follows_pagination_and_deduplicates_stable_entry_ids() {
    let window = resolve_window(WindowInput {
        from: Some("2026-09-18"),
        to: Some("2026-09-19"),
        time_zone: Some("UTC"),
        now_ms: at("2026-09-19T20:00:00Z"),
        max_days: None,
    })
    .unwrap();
    let events = Events(
        |request: &EventsRequest| {
            if request.source == "system" {
                return json!({"items": [], "pagination": {"maxPage": 1}});
            }
            json!({"items": [event("one", "2026-09-19T12:00:00Z", 10.0, json!({"category": "tts", "schema_version": 1}))], "pagination": {"maxPage": 2}})
        },
        Mutex::new(Vec::new()),
    );
    let transactions = fetch_transactions("customer-1", &window, &events, &mut NoReads)
        .await
        .unwrap();
    let pages: Vec<String> = events
        .1
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.starts_with("ai_usage"))
        .cloned()
        .collect();
    assert_eq!(pages, ["ai_usage:user:1", "ai_usage:user:2"]);
    assert_eq!(transactions.len(), 1);
}

fn transaction(id: &str, category: &str) -> Transaction {
    Transaction {
        id: id.into(),
        request_id: None,
        occurred_at_ms: at(&format!("2026-09-19T0{id}:00:00.000Z")),
        entry_kind: EntryKind::Usage,
        category: category.into(),
        operation: "usage".into(),
        source: None,
        adjustment_type: None,
        provider: "unknown".into(),
        model: None,
        quantity: None,
        unit: None,
        credits: id.parse().unwrap(),
        resource_type: None,
        resource_id: None,
        itemized: true,
    }
}

#[test]
fn transaction_pagination_uses_an_opaque_stable_cursor_and_category_filters() {
    let transactions: Vec<Transaction> = ["3", "2", "1"]
        .iter()
        .map(|id| transaction(id, if *id == "1" { "ai_chat" } else { "tts" }))
        .collect();
    let first = paginate_transactions(&transactions, Some("tts"), None, Some(1.0)).unwrap();
    assert_eq!(
        first
            .items
            .iter()
            .map(|t| t.id.as_str())
            .collect::<Vec<_>>(),
        ["3"]
    );
    let cursor = first.next_cursor.unwrap();
    let second =
        paginate_transactions(&transactions, Some("tts"), Some(&cursor), Some(1.0)).unwrap();
    assert_eq!(
        second
            .items
            .iter()
            .map(|t| t.id.as_str())
            .collect::<Vec<_>>(),
        ["2"]
    );
    assert_eq!(second.next_cursor, None);
    assert_eq!(
        paginate_transactions(&transactions, Some("nope"), None, None),
        Err(UsageReadError::Validation("Invalid usage category".into()))
    );
    assert_eq!(
        paginate_transactions(&transactions, None, None, Some(101.0)),
        Err(UsageReadError::Validation(
            "limit must be between 1 and 100".into()
        ))
    );
}

#[test]
fn confidence_reflects_coverage_active_days_and_variability_without_changing_the_quota() {
    let billing = period(
        PeriodSource::Subscription,
        "2026-09-07T00:00:00Z",
        "2026-10-07T00:00:00Z",
        "2026-09-07",
        "2026-10-06",
        30,
        8,
    );
    let now = at("2026-09-15T00:00:00Z");
    let steady_history = PacingHistory {
        active_day_count: Some(25.0),
        coefficient_of_variation: Some(0.2),
        recent_average_daily_credits: Some(120.0),
        recent_day_count: Some(7.0),
        ..history(100.0, 3000.0, 30.0, "2026-08-15", "2026-09-13")
    };
    let credits = credits(1000.0, 10_000.0, 9000.0);
    let steady = build_pacing(&credits, &billing, Some(&steady_history), None, now);
    assert_eq!(steady["confidence"], "high");
    assert_eq!(steady["recentAverageDailyCredits"], 120.0);
    assert_eq!(steady["recentHistoryDays"], 7.0);
    assert_eq!(steady["quotaUsedPercent"], 10.0);
    assert_eq!(
        build_pacing(&credits, &billing, Some(&steady_history), Some(false), now)["confidence"],
        "low"
    );
    let spiky = build_pacing(
        &credits,
        &billing,
        Some(&PacingHistory {
            coefficient_of_variation: Some(3.0),
            ..steady_history.clone()
        }),
        None,
        now,
    );
    assert_eq!(spiky["confidence"], "medium");
    assert!(
        spiky["confidenceReasons"]
            .as_array()
            .unwrap()
            .contains(&json!("variable_usage"))
    );
    let idle = PacingHistory {
        active_day_count: Some(1.0),
        ..steady_history
    };
    assert_eq!(
        build_pacing(&credits, &billing, Some(&idle), None, now)["confidence"],
        "low"
    );
}

const METER: &str = "5103e79b-fd74-4ba8-a287-f95574f9addf";

fn credit(extra: Value) -> Value {
    let mut metadata = json!({"meter_id": METER, "units": 40_000, "rollover": true});
    for (key, value) in extra.as_object().unwrap() {
        metadata[key] = value.clone();
    }
    json!({"id": "6ea2dbab-2e34-4b59-bf76-b78a7c71737e", "name": "meter.credited", "source": "system", "timestamp": "2026-10-06T21:48:10.251928Z", "metadata": metadata})
}

// ai_native_credit_reports.test.ts
#[test]
fn native_credits_are_reporting_adjustments_with_stable_ids_and_permanent_period_labels() {
    let receipt = normalize_credit_event(&credit(json!({}))).unwrap();
    assert_eq!(
        receipt.id,
        "polar-credit:6ea2dbab-2e34-4b59-bf76-b78a7c71737e"
    );
    assert_eq!(receipt.credits, -40_000.0);
    assert_eq!(receipt.entry_kind, EntryKind::Adjustment);
    assert_eq!(receipt.category, "credit_adjustment");
    assert_eq!(receipt.operation, "permanent_credit_grant");
    assert_eq!(receipt.source.as_deref(), Some("polar_meter_credit"));
    assert_eq!(receipt.adjustment_type.as_deref(), Some("native_grant"));
    assert_eq!(receipt.provider, "polar");
    assert_eq!(
        normalize_credit_event(&credit(json!({"rollover": false})))
            .unwrap()
            .operation,
        "period_credit_grant"
    );
    let mut user = credit(json!({}));
    user["source"] = json!("user");
    assert_eq!(normalize_credit_event(&user), None);
    let mut benefit = credit(json!({}));
    benefit["name"] = json!("benefit.granted");
    assert_eq!(normalize_credit_event(&benefit), None);
    let mut no_id = credit(json!({}));
    no_id.as_object_mut().unwrap().remove("id");
    assert_eq!(normalize_credit_event(&no_id), None);
    let mut bad_time = credit(json!({}));
    bad_time["timestamp"] = json!("invalid");
    assert_eq!(normalize_credit_event(&bad_time), None);
    for units in [
        json!(0),
        json!(-1),
        json!(null),
        json!(""),
        json!(true),
        json!("40000"),
    ] {
        assert_eq!(
            normalize_credit_event(&credit(json!({"units": units}))),
            None
        );
    }
    assert_eq!(
        normalize_credit_event(&credit(json!({"meter_id": "another-meter"}))),
        None
    );
    let mut no_rollover = credit(json!({}));
    no_rollover["metadata"]
        .as_object_mut()
        .unwrap()
        .remove("rollover");
    assert_eq!(normalize_credit_event(&no_rollover), None);
}

#[tokio::test]
async fn both_event_streams_paginate_deduplicate_respect_the_date_window_and_isolate_spend_totals()
{
    let window = resolve_window(WindowInput {
        from: Some("2026-10-06"),
        to: Some("2026-10-06"),
        time_zone: Some("UTC"),
        now_ms: at("2026-10-07T00:00:00Z"),
        max_days: None,
    })
    .unwrap();
    let events = Events(
        |request: &EventsRequest| {
            let items = if request.source == "system" {
                let mut old = credit(json!({}));
                old["id"] = json!("old");
                old["timestamp"] = json!("2026-10-05T23:59:59Z");
                json!([
                    credit(json!({})),
                    credit(json!({})),
                    old,
                    credit(json!({"meter_id": "other"}))
                ])
            } else {
                json!([{"id": "usage", "name": "ai_usage", "source": "user", "timestamp": "2026-10-06T20:00:00Z", "metadata": {"credits": 110}}])
            };
            json!({"items": items, "pagination": {"maxPage": if request.source == "system" { 2 } else { 1 }}})
        },
        Mutex::new(Vec::new()),
    );
    let records = fetch_transactions("customer", &window, &events, &mut NoReads)
        .await
        .unwrap();
    assert_eq!(
        *events.1.lock().unwrap(),
        [
            "ai_usage:user:1",
            "meter.credited:system:1",
            "meter.credited:system:2",
            "benefit.granted:system:1",
            "benefit.granted:system:2",
            "benefit.cycled:system:1",
            "benefit.cycled:system:2"
        ]
    );
    assert_eq!(records.len(), 2);
    let summary = build_summary(&records, &window);
    assert_eq!(summary["grantedCredits"], 40_000.0);
    assert_eq!(summary["totalSpentCredits"], 110.0);
    assert_eq!(summary["transactionCount"], 1.0);
    assert_eq!(summary["netConsumedCredits"], -39_890.0);
    assert_eq!(summary["daily"][0]["credits"], 110.0);
}

// "SDK-parsed native event metadata is recognized alongside raw Polar JSON": the SDK hands the
// metadata over in camel case (`meterId`); Rust reads Polar's JSON, and accepts both.
#[test]
fn sdk_parsed_native_event_metadata_is_recognized_alongside_raw_polar_json() {
    let mut parsed = credit(json!({}));
    parsed["metadata"] = json!({"meterId": METER, "units": 40_000, "rollover": true});
    assert_eq!(normalize_credit_event(&parsed).unwrap().credits, -40_000.0);
    parsed["metadata"]["meterId"] = json!("other-meter");
    assert_eq!(normalize_credit_event(&parsed), None);
}

#[tokio::test]
async fn one_page_of_events_is_the_sdk_request() {
    let server = MockServer::start().await.unwrap();
    server.push(MockResponse::json(
        200,
        r#"{"items":[],"pagination":{"total_count":0,"max_page":1}}"#,
    ));
    let polar = PolarClient::new(
        HttpClient::builder().build().unwrap(),
        server
            .provider(PolarClient::provider(&Default::default()))
            .unwrap(),
        Some(SecretString::from("tok")),
    );
    let page = polar
        .list_events_page(&EventsRequest {
            customer_id: "cust-1".into(),
            name: "ai_usage",
            source: "user",
            start_ms: at("2026-09-18T00:00:00.000Z"),
            end_ms: at("2026-09-20T00:00:00.000Z"),
            page: 2,
        })
        .await
        .unwrap();
    assert_eq!(page["pagination"]["max_page"], 1);
    let request = server.requests().pop().unwrap();
    assert_eq!(request.path(), "/v1/events/");
    // Recorded from the SDK (`events.list`), see `polar/mod.rs`.
    assert_eq!(
        request.query(),
        Some(
            "customer_id=cust-1&end_timestamp=2026-09-20T00%3A00%3A00.000Z&limit=100&name=ai_usage&page=2&sorting=-timestamp&source=user&start_timestamp=2026-09-18T00%3A00%3A00.000Z"
        )
    );
    assert_eq!(request.header("authorization"), Some("Bearer tok"));
    assert_eq!(request.header("accept"), Some("application/json"));
}

#[test]
fn text_with_emoji_combining_marks_and_right_to_left_letters() {
    // Receipt-safe ids are ASCII: anything else is dropped, never cut inside a character.
    let normalized = normalize_usage_event(&event(
        "e\u{301}",
        "2026-09-19T12:00:00Z",
        5.0,
        json!({"entry_id": "שלום", "model": "😀", "operation": "e\u{301}", "provider": "👋"}),
    ))
    .unwrap();
    assert_eq!(normalized.id, "usage-1789819200000");
    assert_eq!(normalized.model, None);
    assert_eq!(normalized.operation, "usage");
    assert_eq!(normalized.provider, "unknown");
}

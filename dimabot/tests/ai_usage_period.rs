#![cfg(feature = "ai-usage-request-time")]

use std::convert::Infallible;

use dima_rust::utils::{
    ai_usage_ledger_queries::{AiUsageWindow, decode_ledger_transaction},
    ai_usage_ledger_reads::LedgerField,
    ai_usage_period::{
        AiUsageBillingPeriod, AiUsagePeriodInput, AiUsagePeriodSource, AiUsagePacingInput,
        AiUsageReceiptError, AiUsageWindowInput, FetchAiUsageError, PacingConfidence, PacingStatus,
        PolarTimestamp, PolarUsageEvent, PolarUsageEventsPage, PolarUsageListRequest,
        SubscriptionStatus, build_ai_usage_pacing, build_ai_usage_summary, fetch_ai_usage_transactions,
        resolve_ai_usage_period_with_state, resolve_ai_usage_window,
    },
    credit_policy::JsDate,
    js_string::JsString,
    lossless_json::JsonValue,
};
use mongodb::bson::{Bson, DateTime, doc};

fn date(millis: f64) -> JsDate {
    JsDate::from_millis(millis)
}

fn label(value: &JsString) -> String {
    value.as_str().unwrap().to_string()
}

fn message(error: AiUsageReceiptError) -> String {
    error.message().to_string()
}

fn transaction(id: &str, at: i64, kind: &str, category: &str, credits: f64) -> dima_rust::utils::ai_usage_ledger_queries::AiUsageTransaction {
    decode_ledger_transaction(&doc! {
        "entryId": id,
        "occurredAt": DateTime::from_millis(at),
        "entryKind": kind,
        "category": category,
        "credits": credits,
    })
    .unwrap()
}

fn field<'a>(transaction: &'a dima_rust::utils::ai_usage_ledger_queries::AiUsageTransaction, name: &str) -> &'a str {
    match transaction.get(name).and_then(LedgerField::as_bson) {
        Some(Bson::String(value)) => value,
        other => panic!("{name} string, got {other:?}"),
    }
}

#[test]
fn window_explicit_default_clamp_inverted_and_pre_itemization() {
    let now = date(1_773_144_000_000.0);
    let explicit = resolve_ai_usage_window(&AiUsageWindowInput {
        from: Some("2026-03-07".into()),
        to: Some("2026-03-09".into()),
        time_zone: Some("America/New_York".into()),
        now: Some(now),
        ..AiUsageWindowInput::default()
    })
    .unwrap();
    assert_eq!(explicit.days.len(), 3);
    assert_eq!(explicit.start_timestamp.to_iso_string().unwrap(), "2026-03-07T05:00:00.000Z");
    assert_eq!(
        explicit.end_timestamp_exclusive.to_iso_string().unwrap(),
        "2026-03-10T04:00:00.000Z"
    );

    let defaulted = resolve_ai_usage_window(&AiUsageWindowInput {
        now: Some(now),
        time_zone: Some("UTC".into()),
        ..AiUsageWindowInput::default()
    })
    .unwrap();
    assert_eq!(label(&defaulted.from), "2026-02-09");
    assert_eq!(label(&defaulted.to), "2026-03-10");
    assert_eq!(defaulted.days.len(), 30);
    assert_eq!(defaulted.end_timestamp_exclusive.to_iso_string().unwrap(), "2026-03-11T00:00:00.000Z");

    let clamped = resolve_ai_usage_window(&AiUsageWindowInput {
        from: Some("2026-01-01".into()),
        to: Some("2026-02-01".into()),
        now: Some(date(1_772_323_200_000.0)),
        time_zone: Some("UTC".into()),
        ..AiUsageWindowInput::default()
    });
    assert_eq!(
        message(clamped.unwrap_err()),
        "Usage history for this plan is limited to 31 days"
    );

    let inverted = resolve_ai_usage_window(&AiUsageWindowInput {
        from: Some("2026-03-10".into()),
        to: Some("2026-03-01".into()),
        now: Some(now),
        time_zone: Some("UTC".into()),
        ..AiUsageWindowInput::default()
    });
    assert_eq!(message(inverted.unwrap_err()), "from must be on or before to");

    let early = resolve_ai_usage_window(&AiUsageWindowInput {
        from: Some("2026-09-01".into()),
        to: Some("2026-09-02".into()),
        now: Some(date(1_789_848_000_000.0)),
        time_zone: Some("UTC".into()),
        ..AiUsageWindowInput::default()
    })
    .unwrap();
    assert_eq!(label(&early.from), "2026-09-01");
    let summary = build_ai_usage_summary(&[], &early).unwrap();
    assert_eq!(summary.itemization_started_at, "2026-09-18T19:30:00.000Z");
}

#[test]
fn period_subscription_free_rolling_and_custom_are_end_exclusive() {
    let now = date(1_789_344_000_000.0);
    let free = resolve_ai_usage_period_with_state::<Infallible>(
        &AiUsagePeriodInput {
            free_period_anchor: Some(date(1_788_739_200_000.0)),
            time_zone: Some("UTC".into()),
            now: Some(now),
            max_days: Some(30.0),
            ..AiUsagePeriodInput::default()
        },
        None,
    )
    .unwrap();
    assert_eq!(free.billing_period.source, AiUsagePeriodSource::FreeMonthly);
    assert_eq!(free.billing_period.end_exclusive, true);
    assert_eq!(free.billing_period.from, "2026-09-07");
    assert_eq!(free.billing_period.to, "2026-10-06");
    assert_eq!(free.billing_period.ends_at, "2026-10-07T00:00:00.000Z");
    assert_eq!(label(&free.window.to), "2026-09-13");

    let custom = resolve_ai_usage_period_with_state::<Infallible>(
        &AiUsagePeriodInput {
            free_period_anchor: Some(date(1_788_739_200_000.0)),
            from: Some("2026-09-01".into()),
            to: Some("2026-09-02".into()),
            time_zone: Some("UTC".into()),
            now: Some(date(1_789_848_000_000.0)),
            ..AiUsagePeriodInput::default()
        },
        None,
    )
    .unwrap();
    assert_eq!(custom.billing_period.source, AiUsagePeriodSource::Custom);
    assert_eq!(custom.billing_period.end_exclusive, true);

    let rolling = resolve_ai_usage_period_with_state::<Infallible>(
        &AiUsagePeriodInput {
            time_zone: Some("UTC".into()),
            now: Some(date(1_773_144_000_000.0)),
            ..AiUsagePeriodInput::default()
        },
        None,
    )
    .unwrap();
    assert_eq!(rolling.billing_period.source, AiUsagePeriodSource::Rolling30Day);
    assert_eq!(label(&rolling.window.from), "2026-02-09");

    let mut state = dima_rust::utils::ai_usage_period::PolarCustomerState::default();
    let start = date(1_788_775_200_000.0);
    let end = date(1_791_367_200_000.0);
    state.active_subscriptions.push(dima_rust::utils::ai_usage_period::PolarSubscriptionPeriod {
        status: SubscriptionStatus::Text("active".into()),
        current_period_start: Some(start),
        current_period_end: Some(end),
    });
    state.active_subscriptions.insert(
        0,
        dima_rust::utils::ai_usage_period::PolarSubscriptionPeriod {
            status: SubscriptionStatus::Text("active".into()),
            current_period_start: Some(start),
            current_period_end: Some(date(1_790_000_000_000.0)),
        },
    );
    let subscription = resolve_ai_usage_period_with_state(
        &AiUsagePeriodInput {
            customer_id: Some("customer".into()),
            time_zone: Some("UTC".into()),
            now: Some(date(1_789_473_600_000.0)),
            ..AiUsagePeriodInput::default()
        },
        Some(Ok(state)),
    )
    .unwrap();
    assert_eq!(subscription.billing_period.source, AiUsagePeriodSource::Subscription);
    assert_eq!(subscription.billing_period.end_exclusive, true);
    assert_eq!(subscription.billing_period.ends_at, "2026-10-07T10:00:00.000Z");
}

#[test]
fn pacing_over_within_exhausted_and_incomplete_history() {
    let period = AiUsageBillingPeriod {
        source: AiUsagePeriodSource::Subscription,
        starts_at: "2026-09-07T00:00:00.000Z".into(),
        ends_at: "2026-10-07T00:00:00.000Z".into(),
        end_exclusive: true,
        from: "2026-09-07".into(),
        to: "2026-10-06".into(),
        total_day_count: 30,
        elapsed_day_count: 7,
    };
    let credits = JsonValue::Object(vec![
        ("available".into(), JsonValue::Bool(true)),
        ("used".into(), JsonValue::Number(250_000.0)),
        ("limit".into(), JsonValue::Number(500_000.0)),
        ("balance".into(), JsonValue::Number(250_000.0)),
        ("status".into(), JsonValue::String("available".into())),
    ]);
    let pacing = build_ai_usage_pacing(AiUsagePacingInput {
        credits: &credits,
        billing_period: &period,
        history: None,
        history_complete: None,
        now: Some(date(1_789_344_000_000.0)),
    })
    .unwrap()
    .unwrap();
    assert_eq!(pacing.status, PacingStatus::OverPace);
    assert_eq!(pacing.confidence, PacingConfidence::Low);
    assert_eq!(pacing.confidence_reasons, vec!["limited_activity".to_string()]);
    assert_eq!(pacing.projected_period_credits, 1_071_429.0);
    assert_eq!(pacing.projected_overage_credits, 571_429.0);
    assert_eq!(pacing.estimated_days_until_exhaustion, Some(7.0));
    assert_eq!(pacing.estimated_exhaustion_at.as_deref(), Some("2026-09-21T00:00:00.000Z"));

    let quiet = JsonValue::Object(vec![
        ("available".into(), JsonValue::Bool(true)),
        ("used".into(), JsonValue::Number(10.0)),
        ("limit".into(), JsonValue::Number(100.0)),
        ("balance".into(), JsonValue::Number(90.0)),
        ("status".into(), JsonValue::String("available".into())),
    ]);
    let within = build_ai_usage_pacing(AiUsagePacingInput {
        credits: &quiet,
        billing_period: &AiUsageBillingPeriod {
            starts_at: "2026-09-01T00:00:00.000Z".into(),
            ends_at: "2026-10-01T00:00:00.000Z".into(),
            ..period.clone()
        },
        history: None,
        history_complete: None,
        now: Some(date(1_789_516_800_000.0)),
    })
    .unwrap()
    .unwrap();
    assert_eq!(within.status, PacingStatus::WithinPace);
    assert_eq!(within.estimated_days_until_exhaustion, None);

    let empty = JsonValue::Object(vec![
        ("available".into(), JsonValue::Bool(true)),
        ("used".into(), JsonValue::Number(0.0)),
        ("limit".into(), JsonValue::Number(100.0)),
        ("balance".into(), JsonValue::Number(100.0)),
        ("status".into(), JsonValue::String("available".into())),
    ]);
    let no_usage = build_ai_usage_pacing(AiUsagePacingInput {
        credits: &empty,
        billing_period: &period,
        history: None,
        history_complete: None,
        now: Some(date(1_789_344_000_000.0)),
    })
    .unwrap()
    .unwrap();
    assert_eq!(no_usage.status, PacingStatus::NoUsage);

    let spent = JsonValue::Object(vec![
        ("available".into(), JsonValue::Bool(true)),
        ("used".into(), JsonValue::Number(100.0)),
        ("limit".into(), JsonValue::Number(100.0)),
        ("balance".into(), JsonValue::Number(0.0)),
        ("status".into(), JsonValue::String("available".into())),
    ]);
    let exhausted = build_ai_usage_pacing(AiUsagePacingInput {
        credits: &spent,
        billing_period: &period,
        history: None,
        history_complete: Some(false),
        now: Some(date(1_789_344_000_000.0)),
    })
    .unwrap()
    .unwrap();
    assert_eq!(exhausted.status, PacingStatus::Exhausted);
    assert!(exhausted.confidence_reasons.iter().any(|reason| reason == "history_sync_pending"));
}

#[test]
fn summary_totals_daily_buckets_and_category_percentages() {
    let window = resolve_ai_usage_window(&AiUsageWindowInput {
        from: Some("2026-09-17".into()),
        to: Some("2026-09-19".into()),
        time_zone: Some("UTC".into()),
        now: Some(date(1_789_848_000_000.0)),
        ..AiUsageWindowInput::default()
    })
    .unwrap();
    let rows = vec![
        transaction("a", 1_789_603_200_000, "usage", "tts", 150.0),
        transaction("b", 1_789_689_600_000, "usage", "ai_chat", 50.0),
        transaction("c", 1_789_776_000_000, "usage", "nope", 25.0),
        transaction("g", 1_789_776_000_000, "adjustment", "credit_adjustment", -1000.0),
    ];
    let summary = build_ai_usage_summary(&rows, &window).unwrap();
    assert_eq!(summary.total_spent_credits, 225.0);
    assert_eq!(summary.average_daily_spent_credits, 75.0);
    assert_eq!(summary.granted_credits, 1000.0);
    assert_eq!(summary.net_consumed_credits, -775.0);
    assert_eq!(summary.transaction_count, 3.0);
    assert_eq!(summary.daily[0].credits, 150.0);
    assert_eq!(summary.daily[1].credits, 50.0);
    assert_eq!(summary.daily[2].credits, 25.0);
    assert_eq!(summary.categories[0].category, "tts");
    assert_eq!(summary.categories[0].percentage, 66.67);
    assert_eq!(summary.categories[1].percentage, 22.22);
    assert_eq!(summary.categories[2].category, "uncategorized");
    assert_eq!(summary.categories[2].percentage, 11.11);
}

#[tokio::test]
async fn fetch_normalizes_one_usage_event_and_limits_page_scans() {
    let window = AiUsageWindow {
        from: "2026-09-01".into(),
        to: "2026-09-02".into(),
        time_zone: "UTC".into(),
        start_timestamp: date(1_788_220_800_000.0),
        end_timestamp_exclusive: date(1_788_393_600_000.0),
        days: vec!["2026-09-01".into(), "2026-09-02".into()],
    };
    let list = |request: PolarUsageListRequest| {
        let items = if request.name == "ai_usage" && request.page == 1 {
            vec![PolarUsageEvent {
                id: Some(JsonValue::String("evt".into())),
                timestamp: Some(PolarTimestamp::Date(date(1_788_220_800_000.0))),
                source: Some(JsonValue::String("user".into())),
                name: Some(JsonValue::String("ai_usage".into())),
                metadata: Some(JsonValue::Object(vec![
                    ("credits".into(), JsonValue::Number(10.0)),
                    ("entry_id".into(), JsonValue::String("entry-1".into())),
                    ("category".into(), JsonValue::String("tts".into())),
                ])),
            }]
        } else {
            Vec::new()
        };
        async move {
            Ok::<_, Infallible>(PolarUsageEventsPage {
                items,
                max_page: Some(1.0),
                has_next_page: None,
            })
        }
    };
    let fetched = fetch_ai_usage_transactions("customer", &window, list, |_customer, _events| async {
        Ok::<_, Infallible>(Vec::new())
    })
    .await
    .unwrap();
    assert_eq!(fetched.len(), 1);
    assert_eq!(field(&fetched[0], "id"), "entry-1");
    assert_eq!(field(&fetched[0], "category"), "tts");

    let unbounded = fetch_ai_usage_transactions(
        "customer",
        &window,
        |_request: PolarUsageListRequest| async {
            Ok::<_, Infallible>(PolarUsageEventsPage {
                items: Vec::new(),
                max_page: Some(101.0),
                has_next_page: None,
            })
        },
        |_customer, _events| async { Ok::<_, Infallible>(Vec::new()) },
    )
    .await;
    match unbounded {
        Err(FetchAiUsageError::Receipt(error)) => {
            assert_eq!(error.message(), "Usage history is too large for this date range");
        }
        other => panic!("expected limit, got {other:?}"),
    }
}

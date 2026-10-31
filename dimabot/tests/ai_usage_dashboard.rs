#![cfg(feature = "ai-usage-request-time")]

use dima_rust::utils::{
    ai_usage_dashboard::{
        DashboardReadInput, DashboardWindow, dashboard_aggregate_pipeline, dashboard_cache_key,
        dashboard_request_json, dashboard_row_is_fresh, fold_dashboard_rows,
    },
    ai_usage_ledger_queries::AiUsageWindow,
    credit_policy::JsDate,
    lossless_json::JsonValue,
};
use mongodb::bson::{Bson, DateTime, Document, doc};

fn window() -> AiUsageWindow {
    AiUsageWindow {
        from: "2026-09-01".into(),
        to: "2026-09-02".into(),
        time_zone: "UTC".into(),
        start_timestamp: JsDate::from_millis(1_788_220_800_000.0),
        end_timestamp_exclusive: JsDate::from_millis(1_788_393_600_000.0),
        days: vec!["2026-09-01".into(), "2026-09-02".into()],
    }
}

#[test]
fn cache_key_matches_the_billing_request_order() {
    let request = dashboard_request_json(&DashboardReadInput {
        channel_id: "channel".into(),
        customer_id: "customer".into(),
        plan_tier: JsonValue::String("free".into()),
        account_created_at: JsDate::from_millis(1_767_225_600_000.0),
        window: window(),
    })
    .unwrap();
    assert_eq!(
        dashboard_cache_key(&request),
        "c3bbf75000c7f376208f440d44fc16e4469ac9bca070227a1594552ac859fcce"
    );
}

#[test]
fn fold_uses_the_timezone_label_and_icu_category_order() {
    let pipeline = dashboard_aggregate_pipeline(
        "channel",
        "customer",
        DateTime::from_millis(1_772_859_600_000),
        DateTime::from_millis(1_773_115_200_000),
        "America/New_York",
        DateTime::from_millis(1_773_144_000_000),
    );
    let timezone = pipeline[1]
        .get_document("$group")
        .unwrap()
        .get_document("_id")
        .unwrap()
        .get_document("date")
        .unwrap()
        .get_document("$dateToString")
        .unwrap()
        .get_str("timezone")
        .unwrap();
    assert_eq!(timezone, "America/New_York");

    let view = DashboardWindow {
        from: "2026-03-09".into(),
        to: "2026-03-10".into(),
        time_zone: "America/New_York".into(),
        start_timestamp: "2026-03-09T04:00:00.000Z".into(),
        end_timestamp_exclusive: "2026-03-11T04:00:00.000Z".into(),
        days: vec!["2026-03-09".into(), "2026-03-10".into()],
    };
    let rows = vec![
        doc! {"_id": {"date": "2026-03-09", "category": "B", "kind": "usage", "adjustmentType": "other"}, "spent": 10.0, "granted": 0.0, "debited": 0.0, "count": 1.0, "adjustments": 0.0},
        doc! {"_id": {"date": "2026-03-10", "category": "a", "kind": "usage", "adjustmentType": "other"}, "spent": 10.0, "granted": 0.0, "debited": 0.0, "count": 1.0, "adjustments": 0.0},
    ];
    let summary = fold_dashboard_rows(&view, &rows).unwrap();
    assert_eq!(summary.daily[0].date, "2026-03-09");
    assert_eq!(summary.daily[0].credits, 10.0);
    assert_eq!(summary.daily[1].credits, 10.0);
    assert_eq!(summary.categories[0].category, "a");
    assert_eq!(summary.categories[1].category, "B");
}

#[test]
fn cache_freshness_is_strictly_under_sixty_seconds() {
    let now = 1_789_848_000_000_i64;
    let fresh = doc! {
        "dirty": false,
        "refreshedAt": DateTime::from_millis(now - 59_999),
    };
    assert!(dashboard_row_is_fresh(&fresh, now as f64).unwrap());
    let boundary = doc! {
        "dirty": false,
        "refreshedAt": DateTime::from_millis(now - 60_000),
    };
    assert!(!dashboard_row_is_fresh(&boundary, now as f64).unwrap());
    let dirty = doc! {
        "dirty": true,
        "refreshedAt": DateTime::from_millis(now),
    };
    assert!(!dashboard_row_is_fresh(&dirty, now as f64).unwrap());
    let _ = Document::new();
}

#![cfg(feature = "ai-usage-request-time")]

use dima_rust::utils::{
    ai_usage_ledger_queries::AiUsageWindow,
    ai_usage_ledger_reads::AiUsageLedgerReadiness,
    ai_usage_period::AiUsageReceiptError,
    ai_usage_queries::{
        AiUsageQueryError, TransactionFilters, TransactionQueryInput, encode_transaction_cursor,
        prepare_transaction_query, transaction_scope_hash,
    },
    credit_policy::JsDate,
    js_string::JsString,
};
use mongodb::bson::Bson;

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

fn input(filters: TransactionFilters) -> TransactionQueryInput {
    TransactionQueryInput {
        channel_id: "channel".into(),
        customer_id: "customer".into(),
        window: window(),
        filters,
    }
}

fn validation(error: AiUsageQueryError) -> String {
    match error {
        AiUsageQueryError::Receipt(AiUsageReceiptError::Validation(message)) => message,
        other => panic!("expected validation, got {other}"),
    }
}

#[test]
fn unknown_category_is_rejected_before_the_token_check() {
    let error = prepare_transaction_query(
        &input(TransactionFilters {
            category: Some("BAD!".into()),
            ..TransactionFilters::default()
        }),
        JsDate::from_millis(1_789_848_000_000.0),
    )
    .unwrap_err();
    assert_eq!(validation(error), "Invalid usage category");
}

#[test]
fn default_sort_page_and_cursor_scope() {
    let prepared = prepare_transaction_query(&input(TransactionFilters::default()), JsDate::from_millis(1_789_848_000_000.0)).unwrap();
    assert_eq!(prepared.page_limit, 25);
    assert_eq!(prepared.fetch_limit, 26);
    assert_eq!(prepared.sort.get("occurredAt"), Some(&Bson::Int32(-1)));
    assert_eq!(prepared.sort.get("entryId"), Some(&Bson::Int32(-1)));

    let filters = [("category".into(), "tts".into()), ("source".into(), "fish".into())];
    let scope = transaction_scope_hash(
        &JsString::from("channel"),
        &JsString::from("customer"),
        JsDate::from_millis(1_788_220_800_000.0),
        JsDate::from_millis(1_788_393_600_000.0),
        &filters,
    );
    assert_eq!(scope, "4a4cbb5f196016c069a1c57cfb32259208c3ea4cbd6fe64b006051d2f6e12fbd");
    let cursor = encode_transaction_cursor("entry-1", "2026-09-19T12:00:00.000Z", &scope);
    assert_eq!(
        cursor,
        "eyJ2IjoyLCJpZCI6ImVudHJ5LTEiLCJhdCI6IjIwMjYtMDktMTlUMTI6MDA6MDAuMDAwWiIsInNjb3BlIjoiNGE0Y2JiNWYxOTYwMTZjMDY5YTFjNTdjZmIzMjI1OTIwOGMzZWE0Y2JkNmZlNjRiMDA2MDUxZDJmNmUxMmZiZCJ9"
    );
    let round = prepare_transaction_query(
        &input(TransactionFilters {
            category: Some("tts".into()),
            source: Some("fish".into()),
            cursor: Some(cursor.into()),
            ..TransactionFilters::default()
        }),
        JsDate::from_millis(1_789_848_000_000.0),
    )
    .unwrap();
    assert!(round.filter.contains_key("$or"));

    let wrong_scope = encode_transaction_cursor("entry-1", "2026-09-19T12:00:00.000Z", "not-the-scope");
    let rejected = prepare_transaction_query(
        &input(TransactionFilters {
            category: Some("tts".into()),
            source: Some("fish".into()),
            cursor: Some(wrong_scope.into()),
            ..TransactionFilters::default()
        }),
        JsDate::from_millis(1_789_848_000_000.0),
    )
    .unwrap_err();
    assert_eq!(validation(rejected), "Invalid transaction cursor for this query");

    let other_filters = prepare_transaction_query(
        &input(TransactionFilters {
            category: Some("ai_chat".into()),
            cursor: Some(encode_transaction_cursor("entry-1", "2026-09-19T12:00:00.000Z", &scope).into()),
            ..TransactionFilters::default()
        }),
        JsDate::from_millis(1_789_848_000_000.0),
    )
    .unwrap_err();
    assert_eq!(validation(other_filters), "Invalid transaction cursor for this query");
    let _ = AiUsageLedgerReadiness::Ready;
}

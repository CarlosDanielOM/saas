#![cfg(feature = "ai-usage-request-time")]

use dima_rust::utils::{
    ai_credit_display::{
        DisplayActivity, DisplayCycle, FreeAiCreditDisplayOutcome, FreeCreditFailure, FreeCreditUser,
        LoadedFreeCycle, build_free_ai_credit_display, orchestrate_free_ai_credit_display,
    },
    ai_usage_ledger_reads::AiUsageLedgerReadiness,
    ai_usage_period::{AiUsageBillingPeriod, AiUsagePeriodSource},
    credit_policy::JsDate,
    lossless_json::JsonValue,
};

fn user(plan: &str, customer: Option<&str>) -> FreeCreditUser {
    FreeCreditUser {
        plan_tier: plan.into(),
        polar_sh_customer_id: customer.map(Into::into),
        created_at: JsDate::from_millis(1_788_739_200_000.0),
    }
}

fn credits(limit: f64) -> JsonValue {
    JsonValue::Object(vec![
        ("available".into(), JsonValue::Bool(true)),
        ("used".into(), JsonValue::Number(0.0)),
        ("limit".into(), JsonValue::Number(limit)),
        ("balance".into(), JsonValue::Number(limit)),
        ("status".into(), JsonValue::String("available".into())),
    ])
}

fn period() -> AiUsageBillingPeriod {
    AiUsageBillingPeriod {
        source: AiUsagePeriodSource::FreeMonthly,
        starts_at: "2026-09-07T00:00:00.000Z".into(),
        ends_at: "2026-10-07T00:00:00.000Z".into(),
        end_exclusive: true,
        from: "2026-09-07".into(),
        to: "2026-10-06".into(),
        total_day_count: 30,
        elapsed_day_count: 8,
    }
}

fn activity(spent: f64, granted: f64, debited: f64) -> DisplayActivity {
    DisplayActivity {
        total_spent_credits: spent,
        granted_credits: granted,
        adjustment_debited_credits: Some(debited),
    }
}

fn number(value: &JsonValue, key: &str) -> f64 {
    match value.get(key) {
        Some(JsonValue::Number(number)) => *number,
        other => panic!("{key} number, got {other:?}"),
    }
}

fn text<'a>(value: &'a JsonValue, key: &str) -> &'a str {
    match value.get(key) {
        Some(JsonValue::String(text)) => text.as_str().unwrap(),
        other => panic!("{key} string, got {other:?}"),
    }
}

#[test]
fn not_ready_ledger_and_inapplicable_users_do_not_project() {
    let billing = period();
    let cycle = DisplayCycle {
        billing_period: &billing,
        summary: activity(40.0, 150.0, 10.0),
        history: None,
        ledger_status: Some(AiUsageLedgerReadiness::Pending),
    };
    let pending = build_free_ai_credit_display(&credits(100.0), &cycle, None).unwrap();
    assert!(pending.estimated);
    assert!(pending.credits.is_none());
    assert!(pending.pacing.is_none());

    let missing = DisplayCycle { ledger_status: None, ..cycle };
    let absent = build_free_ai_credit_display(&credits(100.0), &missing, None).unwrap();
    assert!(absent.credits.is_none());

    let premium = orchestrate_free_ai_credit_display(
        &user("premium", Some("customer")),
        &credits(100.0),
        None,
        None,
        || Ok::<_, &'static str>(unreachable_load()),
    );
    assert!(matches!(premium, FreeAiCreditDisplayOutcome::NotApplicable));
    assert!(premium.public_display().is_none());

    let unavailable = JsonValue::Object(vec![("available".into(), JsonValue::Bool(false))]);
    let hidden = orchestrate_free_ai_credit_display(&user("free", Some("customer")), &unavailable, None, None, || {
        Ok::<_, &'static str>(unreachable_load())
    });
    assert!(matches!(hidden, FreeAiCreditDisplayOutcome::NotApplicable));

    let no_customer = orchestrate_free_ai_credit_display(&user("free", None), &credits(100.0), None, None, || {
        Ok::<_, &'static str>(unreachable_load())
    });
    assert!(matches!(no_customer, FreeAiCreditDisplayOutcome::NotApplicable));
}

fn unreachable_load() -> LoadedFreeCycle {
    panic!("loader must not run")
}

#[test]
fn balance_exhausted_and_loader_failure_are_distinct() {
    let billing = period();
    let ready = DisplayCycle {
        billing_period: &billing,
        summary: activity(40.0, 150.0, 10.0),
        history: None,
        ledger_status: Some(AiUsageLedgerReadiness::Ready),
    };
    let display = build_free_ai_credit_display(&credits(100.0), &ready, Some(JsDate::from_millis(1_789_344_000_000.0))).unwrap();
    let shown = display.credits.as_ref().unwrap();
    assert_eq!(number(shown, "limit"), 150.0);
    assert_eq!(number(shown, "used"), 50.0);
    assert_eq!(number(shown, "balance"), 100.0);
    assert_eq!(text(shown, "status"), "available");
    assert!(display.pacing.is_some());

    let exhausted_cycle = DisplayCycle {
        summary: activity(200.0, 100.0, 0.0),
        ..ready
    };
    let exhausted = build_free_ai_credit_display(
        &credits(50.0),
        &exhausted_cycle,
        Some(JsDate::from_millis(1_789_344_000_000.0)),
    )
    .unwrap();
    let shown = exhausted.credits.as_ref().unwrap();
    assert_eq!(number(shown, "limit"), 100.0);
    assert_eq!(number(shown, "used"), 200.0);
    assert_eq!(number(shown, "balance"), 0.0);
    assert_eq!(text(shown, "status"), "exhausted");

    let failed = orchestrate_free_ai_credit_display(&user("free", Some("customer")), &credits(100.0), None, None, || {
        Err("reporting down")
    });
    match &failed {
        FreeAiCreditDisplayOutcome::Degraded(FreeCreditFailure::Load(message)) => {
            assert_eq!(*message, "reporting down");
        }
        other => panic!("expected degraded load, got {other:?}"),
    }
    let public = failed.public_display().unwrap();
    assert!(public.estimated && public.credits.is_none() && public.pacing.is_none());
}

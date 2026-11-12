//! Replays `tests/corpus/billing.json`, recorded from today's TypeScript and the real Polar SDK
//! (`tests/corpus/generate.mjs`), against the Rust port. Pure decisions run offline; the Polar
//! flows run against the loopback mock (answers keyed by method and target, requests compared);
//! `getAiCredits` and the credit-pack context run against Dragonfly (database 10, unique ids).
//!
//! Intended differences are written here as code, each with its reason, never as edits of the
//! recording. Cases whose input holds `NaN` or an infinity inside Polar JSON are skipped and
//! counted: JSON cannot carry them, so Polar and the stores never produce them.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::too_many_lines
)]

mod support;

use dima_billing::credit_packs::{self, CreditPackError};
use dima_billing::free_credit_reset::{
    FreeCreditResetDecision, FreeCreditResetInput, PreviousReset,
};
use dima_billing::plans::checkout::{self, BillingAction};
use dima_billing::plans::credits::{self, AiCreditsData, CreditStatus};
use dima_billing::plans::{self, PaidTier};
use dima_billing::polar::{self, GrantInput, LlmUsage, UsageEventInput};
use dima_billing::usage::{self, AdjustmentInput, AiUsageContext, AiUsageContextInput};
use dima_billing::{credit_sources, js};
use serde_json::{Map, Value, json};
use support::{field, is_undefined, number, plain, same, text};

fn cases(op: &str) -> Vec<Value> {
    let corpus = support::corpus();
    let cases: Vec<Value> = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["op"] == op)
        .cloned()
        .collect();
    assert!(!cases.is_empty(), "no {op} cases");
    cases
}

fn num(value: Option<&Value>) -> f64 {
    value.and_then(number).unwrap_or(f64::NAN)
}

/// `Number(x)` of a corpus value (`undefined` is `NaN`).
fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(v) if is_undefined(v) => f64::NAN,
        Some(v) => number(v).unwrap_or_else(|| js::number(plain(v).as_ref())),
    }
}

struct Tally {
    op: &'static str,
    checked: usize,
    skipped: usize,
    failures: Vec<String>,
}

impl Tally {
    fn new(op: &'static str) -> Self {
        Self {
            op,
            checked: 0,
            skipped: 0,
            failures: Vec::new(),
        }
    }
    fn check(&mut self, ok: bool, case: &Value, detail: impl FnOnce() -> String) {
        self.checked += 1;
        if !ok && self.failures.len() < 8 {
            self.failures.push(format!(
                "{}\n  input: {}\n  {}",
                self.op,
                case["input"],
                detail()
            ));
        }
    }
    fn finish(self) -> usize {
        assert!(
            self.failures.is_empty(),
            "{} mismatches:\n{}",
            self.op,
            self.failures.join("\n")
        );
        assert!(self.checked > 0, "{}: nothing checked", self.op);
        eprintln!(
            "{}: {} checked, {} skipped",
            self.op, self.checked, self.skipped
        );
        self.checked
    }
}

fn decision_json(decision: &FreeCreditResetDecision) -> Value {
    match decision {
        FreeCreditResetDecision::Initialize { external_id } => {
            json!({"action": "initialize", "externalId": external_id})
        }
        FreeCreditResetDecision::Skip => json!({"action": "skip"}),
        FreeCreditResetDecision::CompleteZero { external_id } => {
            json!({"action": "complete_zero", "externalId": external_id})
        }
        FreeCreditResetDecision::Grant {
            credits,
            external_id,
        } => {
            json!({"action": "grant", "credits": js_value(*credits), "externalId": external_id})
        }
    }
}

/// A Rust number as comparable JSON (`NaN` and infinities as the corpus tags them).
fn js_value(x: f64) -> Value {
    if x.is_nan() {
        json!({"$number": "NaN"})
    } else if x.is_infinite() {
        json!({"$number": if x > 0.0 { "+Infinity" } else { "-Infinity" }})
    } else {
        Value::Number(serde_json::Number::from_f64(x).unwrap())
    }
}

/// `timestamp(value)` / `new Date(value)` of a corpus date text.
fn date_of(value: Option<&Value>) -> Option<i64> {
    let value = value.filter(|v| !v.is_null() && !is_undefined(v))?;
    match value {
        Value::String(text) if text.is_empty() => None,
        other => js::date_ms(Some(other)),
    }
}

#[test]
fn free_credit_reset_matches_the_reference() {
    let mut tally = Tally::new("free_reset");
    for case in cases("free_reset") {
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
        let decision =
            dima_billing::free_credit_reset::decide_free_credit_reset(&FreeCreditResetInput {
                user_id: input["userId"].as_str().unwrap(),
                period_source: input["period"]["source"].as_str().unwrap(),
                period_starts_at_ms: start_ms,
                previous: previous.map(|p| PreviousReset {
                    period_start_ms: date_of(field(p, "periodStart")),
                    status: &status,
                    credits: js_number(field(p, "credits")),
                    external_id: &external,
                }),
                used_credits: js_number(field(input, "usedCredits")),
                maximum_reset_credits: js_number(field(input, "maximumResetCredits")),
            });
        let actual = decision_json(&decision);
        tally.check(same(&case["expected"], &actual), &case, || {
            format!("expected {} got {actual}", case["expected"])
        });
    }
    tally.finish();

    let mut tally = Tally::new("reset_external_id");
    for case in cases("reset_external_id") {
        let millis = js::time_clip(num(case["input"].get("millis"))).unwrap();
        let actual = dima_billing::free_credit_reset::free_credit_reset_external_id("user", millis);
        tally.check(
            case["expected"].as_str() == actual.as_deref(),
            &case,
            || format!("{actual:?}"),
        );
    }
    tally.finish();
}

#[test]
fn credit_packs_match_the_reference() {
    let mut tally = Tally::new("recharge_expiry");
    for case in cases("recharge_expiry") {
        let input = &case["input"];
        let now = num(input.get("nowMs")) as i64;
        let actual = credit_packs::recharge_expiry(
            text(&input["subscription"], "current_period_end"),
            text(&input["subscription"], "ends_at"),
            now,
        );
        let actual = actual.map_or(
            Value::Null,
            |e| json!({"expiresAt": e.expires_at, "daysRemaining": js_value(e.days_remaining)}),
        );
        tally.check(same(&case["expected"], &actual), &case, || {
            format!("expected {} got {actual}", case["expected"])
        });
    }
    tally.finish();

    let mut tally = Tally::new("pack_definition");
    for case in cases("pack_definition") {
        let actual = credit_packs::credit_pack_definition(case["input"]["productId"].as_str().unwrap())
            .map_or(Value::Null, |d| json!({"id": d.id, "kind": d.kind.as_str(), "size": d.size.as_str(), "order": d.order}));
        tally.check(same(&case["expected"], &actual), &case, || {
            format!("{actual}")
        });
    }
    tally.finish();

    let mut tally = Tally::new("pack_offers");
    for case in cases("pack_offers") {
        let input = &case["input"];
        let Some(Value::Array(products)) = plain(&input["products"]) else {
            tally.skipped += 1;
            continue;
        };
        let actual = credit_packs::build_credit_pack_offers(
            &products,
            input["meterId"].as_str().unwrap(),
            input["paid"] == true,
        );
        let ok = match (&actual, case.get("error")) {
            (Ok(offers), None) => same(&case["expected"], &serde_json::to_value(offers).unwrap()),
            (Err(CreditPackError::Configuration(message)), Some(error)) => {
                case["errorType"] == "CreditPackConfigurationError" && error == message
            }
            (Err(CreditPackError::Malformed(_)), Some(_)) => case["errorType"] == "TypeError",
            _ => false,
        };
        tally.check(ok, &case, || {
            format!(
                "expected {:?} got {actual:?}",
                case.get("expected").or(case.get("error"))
            )
        });
    }
    tally.finish();
}

fn usage_input(input: &Value) -> AiUsageContextInput {
    let t = |key: &str| text(input, key).map(str::to_owned);
    AiUsageContextInput {
        entry_id: t("entryId"),
        request_id: t("requestId"),
        parent_request_id: t("parentRequestId"),
        entry_kind: text(input, "entryKind").and_then(usage::EntryKind::parse),
        category: text(input, "category").and_then(usage::Category::parse),
        operation: t("operation"),
        source: t("source"),
        provider: t("provider"),
        model: t("model"),
        channel_id: t("channelID"),
        quantity: field(input, "quantity").and_then(number),
        unit: text(input, "unit").and_then(usage::Unit::parse),
        resource_type: text(input, "resourceType").and_then(usage::ResourceType::parse),
        resource_id: t("resourceId"),
    }
}

fn context_json(context: &AiUsageContext) -> Value {
    let mut map = Map::new();
    map.insert("schemaVersion".into(), json!(context.schema_version));
    map.insert("pricingVersion".into(), json!(context.pricing_version));
    map.insert("entryId".into(), json!(context.entry_id));
    map.insert("requestId".into(), json!(context.request_id));
    if let Some(v) = &context.parent_request_id {
        map.insert("parentRequestId".into(), json!(v));
    }
    map.insert("entryKind".into(), json!(context.entry_kind.as_str()));
    map.insert("category".into(), json!(context.category.as_str()));
    map.insert("operation".into(), json!(context.operation));
    map.insert("source".into(), json!(context.source));
    map.insert("provider".into(), json!(context.provider));
    for (key, value) in [
        ("model", &context.model),
        ("channelID", &context.channel_id),
    ] {
        if let Some(v) = value {
            map.insert(key.into(), json!(v));
        }
    }
    if let Some(q) = context.quantity {
        map.insert("quantity".into(), js_value(q));
    }
    if let Some(u) = context.unit {
        map.insert("unit".into(), json!(u.as_str()));
    }
    if let Some(r) = context.resource_type {
        map.insert("resourceType".into(), json!(r.as_str()));
    }
    if let Some(r) = &context.resource_id {
        map.insert("resourceId".into(), json!(r));
    }
    Value::Object(map)
}

fn keys(value: &Value) -> Vec<String> {
    value
        .as_object()
        .map(|o| {
            o.iter()
                .filter(|(_, v)| !is_undefined(v))
                .map(|(k, _)| k.clone())
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn usage_events_and_classification_match_the_reference() {
    let mut tally = Tally::new("usage_context");
    for case in cases("usage_context") {
        let reason = case["input"]["reason"].as_str().unwrap();
        let context = usage::create_ai_usage_context(
            reason,
            &usage_input(&case["input"]["input"]),
            &support::ZeroRandom,
        )
        .unwrap();
        let metadata = Value::Object(usage::to_polar_usage_metadata(&context));
        let mut accounting = Map::new();
        accounting.insert("cost".into(), json!(1));
        accounting.insert("credits".into(), json!(1000));
        accounting.insert("provider".into(), json!("kept-position"));
        accounting.insert("reason".into(), json!(reason));
        let enriched = Value::Object(usage::enrich_polar_usage_metadata(accounting, &context));
        let expected = &case["expected"];
        let ok = same(&expected["context"], &context_json(&context))
            && same(&expected["metadata"], &metadata)
            && same(&expected["enriched"], &enriched)
            && keys(&expected["metadata"]) == keys(&metadata)
            && keys(&expected["enriched"]) == keys(&enriched);
        tally.check(ok, &case, || {
            format!(
                "expected {expected}\n  got context {} metadata {metadata} enriched {enriched}",
                context_json(&context)
            )
        });
    }
    tally.finish();

    let mut tally = Tally::new("classify_adjustment");
    for case in cases("classify_adjustment") {
        let input = &case["input"];
        let actual = usage::classify_adjustment(AdjustmentInput {
            entry_kind: text(input, "entryKind"),
            operation: text(input, "operation"),
            source: text(input, "source"),
            reason: text(input, "reason"),
            adjustment_type: text(input, "adjustmentType"),
        });
        tally.check(case["expected"].as_str() == actual, &case, || {
            format!("{actual:?}")
        });
    }
    tally.finish();
}

fn credits_json(data: &AiCreditsData) -> Value {
    let mut map = data.to_json();
    for key in ["used", "limit", "balance"] {
        let n = match key {
            "used" => data.used,
            "limit" => data.limit,
            _ => data.balance,
        };
        map.insert(key.into(), js_value(n));
    }
    Value::Object(map)
}

fn credits_from(value: &Value) -> AiCreditsData {
    AiCreditsData {
        version: value["version"].as_u64().unwrap() as u32,
        used: num(value.get("used")),
        limit: num(value.get("limit")),
        balance: num(value.get("balance")),
        meter_id: value["meterId"].as_str().unwrap().into(),
        updated_at: value["updatedAt"].as_str().unwrap().into(),
        available: value["available"] == true,
        status: match value["status"].as_str().unwrap() {
            "available" => CreditStatus::Available,
            "exhausted" => CreditStatus::Exhausted,
            _ => CreditStatus::Unavailable,
        },
    }
}

#[test]
fn plan_limits_and_credit_snapshots_match_the_reference() {
    let mut tally = Tally::new("plan_limit");
    for case in cases("plan_limit") {
        let actual = plans::ai_credit_limit_for_plan(text(&case["input"], "tier"));
        tally.check(num(Some(&case["expected"])) == actual, &case, || {
            format!("{actual}")
        });
    }
    tally.finish();

    let mut tally = Tally::new("credits_from_meter");
    for case in cases("credits_from_meter") {
        let input = &case["input"];
        let meter = match field(input, "meter") {
            None => None,
            Some(meter) => match plain(meter) {
                Some(meter) => Some(meter),
                None => {
                    tally.skipped += 1;
                    continue;
                }
            },
        };
        let actual = credits::build_ai_credits_data_from_meter(
            meter.as_ref(),
            text(input, "tier"),
            "2026-11-11T00:00:00.000Z".into(),
        );
        let actual = credits_json(&actual);
        tally.check(same(&case["expected"], &actual), &case, || {
            format!("expected {} got {actual}", case["expected"])
        });
    }
    tally.finish();

    let mut tally = Tally::new("apply_usage");
    for case in cases("apply_usage") {
        let snapshot = credits_from(&case["input"]["snapshot"]);
        let actual = credits::apply_ai_credit_usage_to_snapshot(
            &snapshot,
            num(case["input"].get("credits")),
            "T1".into(),
        );
        let actual = credits_json(&actual);
        tally.check(same(&case["expected"], &actual), &case, || {
            format!("expected {} got {actual}", case["expected"])
        });
    }
    tally.finish();
}

fn action(text: &str) -> BillingAction {
    BillingAction::parse(text).unwrap()
}

#[test]
fn billing_helpers_match_the_reference() {
    let mut tally = Tally::new("diff_months");
    for case in cases("diff_months") {
        let actual = checkout::diff_months(
            num(case["input"].get("fromMs")) as i64,
            num(case["input"].get("toMs")) as i64,
        );
        tally.check(num(Some(&case["expected"])) == actual as f64, &case, || {
            format!("{actual}")
        });
    }
    tally.finish();

    let mut tally = Tally::new("infer_scenario");
    for case in cases("infer_scenario") {
        let i = &case["input"];
        let actual = checkout::infer_scenario(
            action(i["requestedAction"].as_str().unwrap()),
            i["hasActiveSubscription"] == true,
            PaidTier::parse(i["targetPlan"].as_str().unwrap()).unwrap(),
            i["currentPlan"].as_str().unwrap(),
            i["winbackEligible"] == true,
            i["hasAnySubscriptionHistory"] == true,
        );
        tally.check(
            case["expected"].as_str() == Some(actual.as_str()),
            &case,
            || actual.as_str().into(),
        );
    }
    tally.finish();

    let mut tally = Tally::new("sanitize_redirect");
    for case in cases("sanitize_redirect") {
        let i = &case["input"];
        let actual = checkout::sanitize_redirect_url(
            text(i, "raw"),
            text(i, "fallback"),
            text(i, "allowed"),
        );
        tally.check(
            case["expected"].as_str() == actual.as_deref(),
            &case,
            || format!("{actual:?}"),
        );
    }
    tally.finish();

    let mut tally = Tally::new("is_uuid_v4");
    for case in cases("is_uuid_v4") {
        let actual = checkout::is_uuid_v4(text(&case["input"], "value"));
        tally.check(case["expected"].as_bool() == Some(actual), &case, || {
            format!("{actual}")
        });
    }
    tally.finish();

    let discount = |value: &Value| -> polar::Discount {
        serde_json::from_value(plain(value).unwrap()).unwrap()
    };
    let mut tally = Tally::new("discount_value");
    for case in cases("discount_value") {
        let actual = checkout::estimate_discount_value(
            &discount(&case["input"]["discount"]),
            num(case["input"].get("base")),
        );
        tally.check(same(&case["expected"], &js_value(actual)), &case, || {
            format!("{actual}")
        });
    }
    tally.finish();

    let mut tally = Tally::new("best_discount");
    for case in cases("best_discount") {
        let candidates: Vec<(checkout::DiscountReason, polar::Discount)> =
            case["input"]["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .map(|pair| {
                    let reason = match pair[0].as_str().unwrap() {
                        "referral" => checkout::DiscountReason::Referral,
                        "promo" => checkout::DiscountReason::Promo,
                        "winback" => checkout::DiscountReason::Winback,
                        "upgrade" => checkout::DiscountReason::Upgrade,
                        _ => checkout::DiscountReason::Change,
                    };
                    (reason, discount(&pair[1]))
                })
                .collect();
        let best =
            checkout::select_best_discount(&candidates, num(case["input"].get("base"))).unwrap();
        let expected = &case["expected"];
        let ok = expected["reason"].as_str() == Some(best.0.as_str())
            && expected["discount"]["id"].as_str() == Some(best.1.id.as_str());
        tally.check(ok, &case, || format!("{best:?}"));
    }
    tally.finish();

    let mut tally = Tally::new("discount_applies");
    for case in cases("discount_applies") {
        let d = polar::Discount {
            id: "d".into(),
            products: field(&case["input"], "products").and_then(plain),
            ..Default::default()
        };
        let actual = checkout::discount_applies(&d, dima_billing::products::PRO_PRODUCT_ID);
        let ok = match (&actual, case.get("error")) {
            (Ok(applies), None) => case["expected"].as_bool() == Some(*applies),
            (Err(checkout::CheckoutError::Malformed), Some(_)) => case["errorType"] == "TypeError",
            _ => false,
        };
        tally.check(ok, &case, || format!("{actual:?}"));
    }
    tally.finish();

    let mut tally = Tally::new("price_amount");
    for case in cases("price_amount") {
        let Some(price) = plain(&case["input"]["price"]) else {
            tally.skipped += 1;
            continue;
        };
        let actual = checkout::price_amount_cents(&price);
        tally.check(num(Some(&case["expected"])) == actual, &case, || {
            format!("{actual}")
        });
    }
    tally.finish();

    let now = support::corpus()["now"].as_i64().unwrap();
    let mut tally = Tally::new("valid_pack_context");
    for case in cases("valid_pack_context") {
        let actual = plans::pack_context::valid_context(&plain(&case["input"]["value"]).unwrap(), now)
            .map_or(Value::Null, |c| json!({"version": 1, "planTier": c.plan_tier.to_string(), "expiresAt": c.expires_at}));
        tally.check(same(&case["expected"], &actual), &case, || {
            format!("expected {} got {actual}", case["expected"])
        });
    }
    tally.finish();

    let mut tally = Tally::new("current_plan_from_active");
    for case in cases("current_plan_from_active") {
        let actual = checkout::current_plan_from_active(
            case["input"]["tier"].as_str().unwrap(),
            text(&case["input"], "product"),
        );
        tally.check(
            case["expected"].as_str() == Some(actual.as_str()),
            &case,
            || actual.clone(),
        );
    }
    tally.finish();

    let mut tally = Tally::new("pack_context_key");
    for case in cases("pack_context_key") {
        let actual =
            plans::pack_context::context_cache_key(case["input"]["customerId"].as_str().unwrap());
        tally.check(
            case["expected"].as_str() == Some(actual.as_str()),
            &case,
            || actual.clone(),
        );
    }
    tally.finish();
}

fn plan_json(plan: &plans::entitlements::EntitledPlan) -> Value {
    json!({"planTier": plan.plan_tier.to_string(), "until": plan.until_ms.map_or(Value::Null, |ms| json!({"$date": ms}))})
}

struct FixedGrace(Option<Vec<polar::SdkSubscription>>);

impl plans::entitlements::GraceLookup for FixedGrace {
    fn grace_subscriptions<'a>(
        &'a self,
        _customer_id: &'a str,
        _grants: &'a [polar::GrantedBenefit],
    ) -> futures_util::future::BoxFuture<
        'a,
        Result<Vec<polar::SdkSubscription>, plans::entitlements::EntitlementError>,
    > {
        Box::pin(async move {
            self.0
                .clone()
                .ok_or(plans::entitlements::EntitlementError::Polar(
                    polar::PolarError::Decode,
                ))
        })
    }
}

fn iso(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_f64)
        .and_then(|ms| dima_text::to_iso_string(ms as i64))
}

#[tokio::test]
async fn entitlements_match_the_reference() {
    let mut tally = Tally::new("entitled_plan");
    for case in cases("entitled_plan") {
        let i = &case["input"];
        let subscription = |s: &Value| polar::EntitlementSubscription {
            id: s["id"].as_str().unwrap_or("").into(),
            product_id: s["productId"].as_str().unwrap_or("").into(),
            status: s["status"].as_str().unwrap_or("").into(),
            current_period_end: iso(s.get("currentPeriodEnd")),
            ends_at: iso(s.get("endsAt")),
            trial_end: iso(s.get("trialEnd")),
            trial_start: iso(s.get("trialStart")),
        };
        let state = polar::EntitlementState {
            id: i["stateId"].as_str().unwrap().into(),
            active_subscriptions: i["activeSubscriptions"]
                .as_array()
                .unwrap()
                .iter()
                .map(subscription)
                .collect(),
            granted_benefits: i["grantedBenefits"]
                .as_array()
                .unwrap()
                .iter()
                .map(|g| polar::GrantedBenefit {
                    id: g["id"].as_str().unwrap().into(),
                    benefit_id: g["benefitId"].as_str().unwrap().into(),
                })
                .collect(),
        };
        let grace = FixedGrace(field(i, "grace").and_then(Value::as_array).map(|items| {
            items
                .iter()
                .map(|s| {
                    let e = subscription(s);
                    polar::SdkSubscription {
                        id: e.id,
                        customer_id: s["customerId"].as_str().unwrap().into(),
                        product_id: e.product_id,
                        status: e.status,
                        current_period_end: e.current_period_end,
                        ends_at: e.ends_at,
                        trial_end: e.trial_end,
                        trial_start: e.trial_start,
                    }
                })
                .collect()
        }));
        let actual = plans::entitlements::resolve_entitled_plan(
            &state,
            "cust",
            num(i.get("nowMs")) as i64,
            &grace,
        )
        .await;
        let ok = match (&actual, case.get("error")) {
            (Ok(plan), None) => same(&case["expected"], &plan_json(plan)),
            (Err(error), Some(message)) => message.as_str() == Some(error.to_string().as_str()),
            _ => false,
        };
        tally.check(ok, &case, || {
            format!(
                "expected {:?} got {actual:?}",
                case.get("expected").or(case.get("error"))
            )
        });
    }
    tally.finish();

    let mut tally = Tally::new("fingerprint");
    for case in cases("fingerprint") {
        let date = |v: Option<&Value>| match v {
            None => plans::entitlements::FingerprintDate::None,
            Some(v) if v.is_null() || is_undefined(v) => plans::entitlements::FingerprintDate::None,
            Some(v) => plans::entitlements::FingerprintDate::Text(v.as_str().unwrap().into()),
        };
        let subscriptions: Vec<_> = case["input"]["activeSubscriptions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| plans::entitlements::FingerprintSubscription {
                id: text(s, "id").map(Into::into),
                product_id: text(s, "productId").map(Into::into),
                status: text(s, "status").map(Into::into),
                current_period_end: date(s.get("currentPeriodEnd")),
                ends_at: date(s.get("endsAt")),
                trial_start: date(s.get("trialStart")),
                trial_end: date(s.get("trialEnd")),
            })
            .collect();
        let grants: Vec<_> = case["input"]["grantedBenefits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| {
                (
                    text(g, "id").map(Into::into),
                    text(g, "benefitId").map(Into::into),
                )
            })
            .collect();
        let actual = plans::entitlements::entitlement_fingerprint(&subscriptions, &grants);
        let ok = match (&actual, case.get("error")) {
            (Ok(hex), None) => case["expected"].as_str() == Some(hex.as_str()),
            (Err(plans::entitlements::EntitlementError::InvalidExpiry), Some(_)) => {
                case["errorType"] == "RangeError"
            }
            _ => false,
        };
        tally.check(ok, &case, || format!("{actual:?}"));
    }
    tally.finish();
}

struct CorpusReads(Value, Value);

impl credit_sources::CreditSourceReads for CorpusReads {
    fn grant<'a>(
        &'a mut self,
        _id: &'a str,
    ) -> futures_util::future::BoxFuture<'a, Result<Option<Value>, credit_sources::CreditSourceError>>
    {
        Box::pin(async move { Ok(Some(self.0.clone()).filter(|g| !g.is_null())) })
    }
    fn order<'a>(
        &'a mut self,
        _id: &'a str,
    ) -> futures_util::future::BoxFuture<'a, Result<Value, credit_sources::CreditSourceError>> {
        Box::pin(async move { Ok(self.1.clone()) })
    }
}

#[tokio::test]
async fn credit_sources_match_the_reference() {
    let mut tally = Tally::new("credit_sources");
    for case in cases("credit_sources") {
        let i = &case["input"];
        let events: Vec<_> = i["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| credit_sources::CreditSourceEvent::from_json(&plain(e).unwrap()))
            .collect();
        let mut reads = CorpusReads(plain(&i["grant"]).unwrap(), plain(&i["order"]).unwrap());
        let actual = credit_sources::classify_credit_sources("customer", &events, &mut reads).await;
        let ok = match (&actual, case.get("error")) {
            (Ok(map), None) => {
                let entries: Vec<Value> = map.iter().map(|(k, v)| json!([k, v])).collect();
                case["expected"]["$map"] == Value::Array(entries)
            }
            (Err(credit_sources::CreditSourceError::Malformed), Some(_)) => {
                case["errorType"] == "TypeError"
            }
            _ => false,
        };
        tally.check(ok, &case, || {
            format!(
                "expected {:?} got {actual:?}",
                case.get("expected").or(case.get("error"))
            )
        });
    }
    tally.finish();
}

fn usage_event_input(i: &Value) -> UsageEventInput {
    let llm = field(i, "llm").map(|llm| LlmUsage {
        model: text(llm, "model").unwrap_or("").into(),
        prompt_tokens: llm
            .get("usage")
            .and_then(|u| field(u, "prompt_tokens"))
            .and_then(number),
        completion_tokens: llm
            .get("usage")
            .and_then(|u| field(u, "completion_tokens"))
            .and_then(number),
        total_tokens: llm
            .get("usage")
            .and_then(|u| field(u, "total_tokens"))
            .and_then(number),
    });
    UsageEventInput {
        customer_id: text(i, "customerId").unwrap_or("").into(),
        channel_id: text(i, "channelID").map(Into::into),
        external_id: text(i, "externalId").map(Into::into),
        cost: num(i.get("cost")),
        reason: text(i, "reason").unwrap_or("").into(),
        llm,
        tts_cost: field(i, "_cost").and_then(number),
        characters: field(i, "characters").and_then(number),
        usage: field(i, "usage").map(usage_input),
    }
}

#[test]
fn polar_ingest_events_match_the_sdk_wire() {
    let mut tally = Tally::new("ingest_usage");
    for case in cases("ingest_usage") {
        let i = &case["input"];
        let input = usage_event_input(i);
        let (event, _context) = polar::build_usage_event(&input, &support::ZeroRandom).unwrap();
        let batch = i["mode"] == "batch";
        // The reference queues `JSON.stringify(eventData)` in batch mode and sends what it parses
        // back: `undefined` members are gone and `NaN` is `null`. Rust keeps the queued event as
        // built and leaves an unset `characters` out (the immediate path with `_cost` has no caller).
        let wire = event
            .wire()
            .map(|w| dima_text::to_js_json(&json!({"events": [w]})));
        let recorded = case["wire"].as_array().unwrap();
        let expected_ok = case["expected"]["error"] == false;
        let immediate_tts_without_characters =
            !batch && input.tts_cost.is_some() && input.characters.is_none();
        let ok = if immediate_tts_without_characters {
            // Intended difference: the reference's SDK refuses `characters: undefined` here.
            !expected_ok && recorded.is_empty() && wire.is_ok()
        } else if expected_ok {
            recorded.len() == 1 && wire.as_deref().ok() == recorded[0]["body"].as_str()
        } else {
            wire.is_err() && recorded.is_empty()
        };
        // What the local projection receives after an accepted ingest.
        let projected = if expected_ok {
            let p = &case["projected"][0];
            num(p.get("credits")) == js::number(event.metadata.get("credits"))
                && p["externalId"].as_str() == Some(event.external_id.as_str())
        } else {
            true
        };
        tally.check(ok && projected, &case, || {
            format!(
                "expected {} / {:?}\n  got {wire:?}",
                case["expected"],
                recorded.first().map(|r| &r["body"])
            )
        });
    }
    tally.finish();

    let mut tally = Tally::new("grant_credits");
    for case in cases("grant_credits") {
        let i = &case["input"];
        let input = GrantInput {
            customer_id: text(i, "customerId").unwrap_or("").into(),
            channel_id: text(i, "channelID").map(Into::into),
            credits: js_number(field(i, "credits")),
            reason: text(i, "reason").unwrap_or("").into(),
            admin_login: text(i, "adminLogin").map(Into::into),
            external_id: text(i, "externalId").map(Into::into),
            source: text(i, "source").map(Into::into),
        };
        let built = polar::build_grant_event(&input, &support::ZeroRandom).unwrap();
        let ok = match built {
            Ok((event, _, credits)) => {
                let body = dima_text::to_js_json(&json!({"events": [event.wire().unwrap()]}));
                case["expected"]["error"] == false
                    && case["wire"][0]["body"].as_str() == Some(body.as_str())
                    && case["receipts"]
                        .as_array()
                        .is_none_or(|r| r.is_empty() || num(r[0].get("credits")) == -credits)
            }
            Err(refused) => {
                case["expected"]["message"].as_str() == Some(refused.to_string().as_str())
            }
        };
        tally.check(ok, &case, || format!("{}", case["expected"]));
    }
    tally.finish();

    let mut tally = Tally::new("ingest_answer");
    for case in cases("ingest_answer") {
        let answer = &case["input"]["answer"];
        let complete = answer["status"] == 200 && {
            let result: polar::IngestResult =
                serde_json::from_value(answer["body"].clone()).unwrap();
            result.is_complete(1)
        };
        tally.check(
            (case["expected"]["error"] == false) == complete,
            &case,
            || format!("{complete}"),
        );
    }
    tally.finish();
}

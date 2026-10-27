//! Public API parity against actual TypeScript statements, evaluated without
//! imports or runtime services. Regenerate/check with the adjacent .mjs script.
//! Special number tags must be compared before JSON serialization erases -0/NaN.
#![cfg(all(
    feature = "chat-message",
    feature = "timer-policy",
    feature = "credit-policy"
))]

use dima_rust::utils::{chat_message as chat, credit_policy as credit, timer_policy as timer};
use serde_json::{Value, json};

fn number(value: &Value) -> f64 {
    if let Some(number) = value.as_f64() {
        return number;
    }
    match value["$number"].as_str() {
        Some("NaN") => f64::NAN,
        Some("+Infinity") => f64::INFINITY,
        Some("-Infinity") => f64::NEG_INFINITY,
        Some("-0") => -0.0,
        _ => panic!("Expected numeric fixture: {value}"),
    }
}

fn tagged(number: f64) -> Value {
    if number.is_nan() {
        json!({"$number":"NaN"})
    } else if number == f64::INFINITY {
        json!({"$number":"+Infinity"})
    } else if number == f64::NEG_INFINITY {
        json!({"$number":"-Infinity"})
    } else if number == 0.0 && number.is_sign_negative() {
        json!({"$number":"-0"})
    } else {
        json!(number)
    }
}

fn optional_number(value: &Value) -> Option<f64> {
    if value.is_null() || value["$undefined"] == true {
        None
    } else {
        Some(number(value))
    }
}

fn timer_value(input: &Value) -> timer::TimerFrequencyValue<'_> {
    timer::TimerFrequencyValue {
        frequency: number(&input["frequency"]),
        frequency_unit: input["frequencyUnit"].as_str(),
    }
}

fn reset_number(value: &Value) -> credit::ResetNumber<'_> {
    if value["$undefined"] == true {
        credit::ResetNumber::Undefined
    } else if value.get("$number").is_some() {
        credit::ResetNumber::Number(number(value))
    } else {
        credit::ResetNumber::Json(value)
    }
}

fn date(value: &Value) -> credit::JsDate {
    credit::JsDate::from_millis(number(value))
}
fn optional_date(value: &Value) -> Option<credit::JsDate> {
    if value.is_null() {
        None
    } else {
        Some(date(value))
    }
}

fn decision_value(decision: credit::FreeCreditResetDecision) -> Value {
    match decision {
        credit::FreeCreditResetDecision::Skip => json!({"action":"skip"}),
        credit::FreeCreditResetDecision::Initialize { external_id } => {
            json!({"action":"initialize","externalId":external_id})
        }
        credit::FreeCreditResetDecision::CompleteZero { external_id } => {
            json!({"action":"complete_zero","externalId":external_id})
        }
        credit::FreeCreditResetDecision::Grant {
            credits,
            external_id,
        } => json!({"action":"grant","credits":tagged(credits),"externalId":external_id}),
    }
}

fn reset_case(input: &Value, dates: &Value) -> Value {
    let previous = input
        .get("previous")
        .filter(|value| !value.is_null())
        .map(|value| credit::FreeCreditResetRecord {
            period_start: optional_date(&dates["previousPeriodStartMs"]),
            status: value["status"].as_str().unwrap(),
            credits: reset_number(&value["credits"]),
            external_id: value["externalId"].as_str().unwrap(),
        });
    decision_value(credit::decide_free_credit_reset(
        credit::FreeCreditResetInput {
            user_id: input["userId"].as_str().unwrap(),
            period_source: input["period"]["source"].as_str().unwrap(),
            period_start: date(&dates["periodStartMs"]),
            previous,
            used_credits: reset_number(&input["usedCredits"]),
            maximum_reset_credits: reset_number(&input["maximumResetCredits"]),
        },
    ))
}

fn product(value: &Value) -> credit::PolarCreditPackProduct {
    let string = |field: &str| value[field].as_str().map(str::to_owned);
    let prices = value["prices"].as_array().map(|prices| {
        prices
            .iter()
            .map(|price| credit::PolarPrice {
                price_type: price["type"].as_str().map(str::to_owned),
                amount_type: price["amount_type"].as_str().map(str::to_owned),
                price_amount: price
                    .get("price_amount")
                    .filter(|v| !v.is_null())
                    .map(number),
                price_currency: price["price_currency"].as_str().map(str::to_owned),
                is_archived: price["is_archived"].as_bool(),
            })
            .collect()
    });
    let benefits = value["benefits"].as_array().map(|benefits| {
        benefits
            .iter()
            .map(|benefit| credit::PolarMeterCreditBenefit {
                benefit_type: benefit["type"].as_str().map(str::to_owned),
                properties: benefit
                    .get("properties")
                    .filter(|v| !v.is_null())
                    .map(|properties| credit::MeterCreditProperties {
                        units: properties.get("units").filter(|v| !v.is_null()).map(number),
                        rollover: properties["rollover"].as_bool(),
                        meter_id: properties["meter_id"].as_str().map(str::to_owned),
                    }),
            })
            .collect()
    });
    credit::PolarCreditPackProduct {
        id: string("id"),
        name: string("name"),
        visibility: string("visibility"),
        is_archived: value["is_archived"].as_bool(),
        prices,
        benefits,
    }
}

fn evaluate(case: &Value) -> Result<Value, String> {
    let input = &case["input"];
    let text = |field: &str| input[field].as_str().unwrap();
    Ok(match case["operation"].as_str().unwrap() {
        "shared_origin" => json!(chat::is_foreign_shared_chat_event(
            text("type"),
            &input["event"],
            input.get("receiver").filter(|v| v["$undefined"] != true)
        )),
        "bits_text" => json!(chat::get_bits_message_text(&input["message"])),
        "badges" => {
            let badges = input["badges"]
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .map(|value| serde_json::from_value(value.clone()).unwrap())
                        .collect::<Vec<chat::Badge>>()
                })
                .unwrap_or_default();
            let value = chat::format_badges(&badges);
            json!({"formattedBadges":value.formatted_badges,"badgeList":value.badge_list,
                "isMod":value.is_mod,"isSub":value.is_sub,"subMonths":tagged(value.sub_months)})
        }
        "legacy_frequency" => {
            let value = &input["frequency"];
            let frequency = if value.is_number() || value.get("$number").is_some() {
                Some(number(value))
            } else {
                None
            };
            timer::convert_legacy_timer_frequency(frequency)
                .map(tagged)
                .unwrap_or(Value::Null)
        }
        "parse_frequency" => timer::parse_timer_frequency_input(input["raw"].as_str())
            .map(tagged)
            .unwrap_or(Value::Null),
        "interval_minutes" => tagged(timer::get_timer_interval_minutes(timer_value(input))),
        "heartbeat_minutes" => tagged(timer::get_timer_heartbeat_minutes(
            timer_value(input),
            number(&input["storedHeartbeat"]),
            input["heartbeatUnit"].as_str(),
        )),
        "validate_interval" => json!(timer::validate_timer_interval(
            number(&input["minutes"]),
            text("tier")
        )),
        "validate_edit" => {
            let result = timer::validate_timer_edit_interval(
                timer_value(input),
                optional_number(&input["requested"]),
                text("tier"),
            );
            let mut value = serde_json::to_value(result.validation).unwrap();
            value
                .as_object_mut()
                .unwrap()
                .insert("minutes".into(), tagged(result.minutes));
            value
        }
        "free_reset" => reset_case(input, &case["dateInputs"]),
        "date_iso" => json!(
            date(&input["millis"])
                .to_iso_string()
                .map_err(|error| error.to_string())?
        ),
        "reset_external_id" => json!(
            credit::build_free_credit_reset_external_id(text("userId"), date(&input["millis"]))
                .map_err(|error| error.to_string())?
        ),
        "recharge_expiry" => {
            let dates = &case["dateInputs"];
            credit::get_recharge_expiry(optional_date(&dates["currentPeriodEndMs"]), optional_date(&dates["endsAtMs"]), date(&dates["nowMs"]))
                .map(|expiry| json!({"expiresAt":expiry.expires_at,"daysRemaining":tagged(expiry.days_remaining)}))
                .unwrap_or(Value::Null)
        }
        "pack_definition" => json!(credit::get_credit_pack_definition(text("productId"))),
        "pack_offers" => {
            let products = input["products"]
                .as_array()
                .unwrap()
                .iter()
                .map(product)
                .collect::<Vec<_>>();
            let offers = credit::build_credit_pack_offers(
                &products,
                text("meterId"),
                input["paid"].as_bool().unwrap(),
            )
            .map_err(|error| error.to_string())?;
            Value::Array(offers.into_iter().map(|offer| json!({
                "id":offer.id,"name":offer.name,"kind":offer.kind,"size":offer.size,
                "credits":tagged(offer.credits),"rollover":offer.rollover,"priceAmount":tagged(offer.price_amount),
                "priceCurrency":offer.price_currency,"eligible":offer.eligible,"eligibilityReason":offer.eligibility_reason,
            })).collect())
        }
        "tts_usage" => {
            let usage = credit::calculate_tts_usage(text("provider"), number(&input["characters"]));
            json!({"characters":tagged(usage.characters),"creditsConsumed":tagged(usage.credits_consumed),
                "polarshCost":tagged(usage.polarsh_cost),"costUsd":tagged(usage.cost_usd)})
        }
        operation => panic!("Unmapped operation: {operation}"),
    })
}

// JSON has one numeric type; serde distinguishes integer and f64 encoding.
// Compare their Number values, retaining special-number tags recursively.
fn equivalent(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equivalent(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| equivalent(value, other)))
        }
        _ => actual == expected,
    }
}

#[test]
fn policy_utils_match_source_fixtures_including_nonfinite_and_signed_zero() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/policy_utils_parity.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(
        cases.len() >= 1200,
        "Do not silently lose edge-case coverage"
    );
    assert_eq!(fixture["sources"].as_object().unwrap().len(), 7);
    for (index, case) in cases.iter().enumerate() {
        let actual = evaluate(case);
        if let Some(error) = case["error"].as_str() {
            assert_eq!(actual.unwrap_err(), error, "case {index}: {case}");
        } else {
            let actual = actual.unwrap_or_else(|error| panic!("case {index}: {case}: {error}"));
            assert!(
                equivalent(&actual, &case["expected"]),
                "case {index}: {case}\nactual: {actual}"
            );
        }
    }
}

#[test]
fn special_number_tags_cannot_mask_negative_zero_or_invalid_values() {
    assert!(!equivalent(&tagged(-0.0), &tagged(0.0)));
    assert!(!equivalent(&tagged(f64::NAN), &Value::Null));
    assert!(!equivalent(
        &tagged(f64::INFINITY),
        &tagged(f64::NEG_INFINITY)
    ));
}

#[test]
fn json_number_inputs_preserve_binary64_rounding() {
    for decimal in ["6.666666666666667e301", "0.49999999999999994", "1e308"] {
        let parsed: Value = serde_json::from_str(decimal).unwrap();
        assert_eq!(
            parsed.as_f64().unwrap().to_bits(),
            decimal.parse::<f64>().unwrap().to_bits(),
            "JSON input must preserve the source binary64 value: {decimal}"
        );
    }
    // Bit pattern recorded from actual JS calculateTtsUsage("kokoro", 1e308).
    assert_eq!(
        credit::calculate_tts_usage("kokoro", 1e308)
            .cost_usd
            .to_bits(),
        0x7e98_e314_6300_7a82
    );
}

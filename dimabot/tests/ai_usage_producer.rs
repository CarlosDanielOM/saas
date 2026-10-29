#![cfg(feature = "ai-usage-producer")]
//! Pure assertions plus mandatory full actual-source replay (parent runs ignored
//! replay after generating the pinned fixture). These are authored, not run here.
#[path = "support/ai_usage_producer.rs"]
mod support;
use dima_rust::utils::{
    ai_usage::AiUsageContext,
    ai_usage_producer::*,
    credit_policy::JsDate,
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
};
use std::sync::atomic::{AtomicUsize, Ordering};
use support::*;

struct CountClock {
    date: JsDate,
    calls: AtomicUsize,
}
impl ReceiptClock for CountClock {
    fn now(&self) -> JsDate {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.date
    }
}

#[test]
fn receipt_order_nullish_and_lossless_strings() {
    let c=parse_json(r#"{"entryId":"id\ud800","requestId":"","entryKind":"adjustment","category":"tts","operation":"refund","source":" x ","provider":"p","model":"","quantity":0,"resourceId":""}"#).unwrap();
    let r = build_queued_ai_usage_receipt_at(
        "c".into(),
        "u".into(),
        Some(JsDate::from_millis(0.0)),
        JsDate::invalid(),
        &c,
        -1.0,
    )
    .unwrap();
    assert_eq!(
        r.json(),
        r#"{"channelID":"c","customerId":"u","id":"id\ud800","requestId":null,"occurredAt":"1970-01-01T00:00:00.000Z","entryKind":"adjustment","category":"tts","operation":"refund","source":" x ","adjustmentType":"refund","provider":"p","model":null,"quantity":0,"unit":null,"credits":-1,"resourceType":null,"resourceId":"","itemized":true}"#
    );
    assert!(
        r.json_enqueued_at(JsDate::from_millis(1.0))
            .unwrap()
            .ends_with(r#","enqueuedAt":"1970-01-01T00:00:00.001Z"}"#)
    );
    assert_eq!(r.get("id"), c.get("entryId"));
    assert_eq!(r.clone().into_value(), *r.as_value());
}

#[test]
fn clock_default_only_when_absent_and_invalid_inputs() {
    let c=parse_json(r#"{"entryId":"a","entryKind":"usage","category":"other","operation":"x","source":"x","provider":"x"}"#).unwrap();
    let clock = CountClock {
        date: JsDate::from_millis(0.0),
        calls: AtomicUsize::new(0),
    };
    let b = |id: &str, date, credits| {
        build_queued_ai_usage_receipt_with_clock(id.into(), "u".into(), date, &clock, &c, credits)
    };
    assert!(b("c", Some(JsDate::invalid()), 1.0).is_none());
    assert!(b("", Some(JsDate::from_millis(0.0)), 1.0).is_none());
    assert!(b("c", Some(JsDate::from_millis(0.0)), f64::NAN).is_none());
    assert_eq!(clock.calls.load(Ordering::SeqCst), 0);
    assert!(b("c", None, 0.0).is_some());
    assert_eq!(clock.calls.load(Ordering::SeqCst), 1);
    for (date, part) in [
        (8_640_000_000_000_000.0, "+275760-09-13"),
        (-8_640_000_000_000_000.0, "-271821-04-20"),
    ] {
        assert!(
            b("c", Some(JsDate::from_millis(date)), 0.0)
                .unwrap()
                .json()
                .contains(part)
        );
    }
    assert!(
        build_queued_ai_usage_receipt_at(
            "c".into(),
            "u".into(),
            None,
            JsDate::from_millis(0.0),
            &parse_json(r#"{"source":["activation"]}"#).unwrap(),
            1.0
        )
        .is_none(),
        "invalid declared source type is rejected"
    );
}

#[test]
fn system_default_clock_is_bounded() {
    let c = parse_json("{}").unwrap();
    let before = SystemReceiptClock.now().timestamp_millis().unwrap();
    let r = build_queued_ai_usage_receipt_json("c".into(), "u".into(), None, &c, 1.0).unwrap();
    let after = SystemReceiptClock.now().timestamp_millis().unwrap();
    let iso = text(r.get("occurredAt").unwrap());
    assert!(
        iso >= JsDate::from_millis(before as f64)
            .to_iso_string()
            .unwrap()
            .as_str()
    );
    assert!(
        iso <= JsDate::from_millis(after as f64)
            .to_iso_string()
            .unwrap()
            .as_str()
    );
}

#[test]
#[ignore = "mandatory source replay; requires pinned Node-generated external fixture"]
fn replay_actual_source_fixture() {
    let f = fixture();
    let now = JsDate::from_millis(bits(field(&f, "fixedNowBits")));
    let mut native_count = 0;
    let mut replayed = 0;
    for case in array(field(&f, "cases")) {
        let label = field(case, "id").to_json_string();
        let input = field(case, "input");
        let out = field(case, "output");
        let c = context(input);
        let clock = CountClock {
            date: now,
            calls: AtomicUsize::new(0),
        };
        let actual = build_queued_ai_usage_receipt_with_clock(
            string(field(input, "channelID")).clone(),
            string(field(input, "customerId")).clone(),
            occurred(input),
            &clock,
            &c,
            bits(field(input, "creditsBits")),
        );
        let wire = actual
            .as_ref()
            .map_or_else(|| "null".to_owned(), QueuedAiUsageReceipt::json);
        assert_eq!(wire, text(field(out, "receiptWire")), "{label}");
        let numeric = field(out, "numericBits");
        if let Some(receipt) = &actual {
            for name in ["credits", "quantity"] {
                match field(numeric, name) {
                    JsonValue::Null => assert!(
                        matches!(receipt.get(name), Some(JsonValue::Null)),
                        "{label}: {name}"
                    ),
                    expected => match receipt.get(name) {
                        Some(JsonValue::Number(n)) => {
                            assert_eq!(n.to_bits(), bits(expected).to_bits(), "{label}: {name}")
                        }
                        _ => panic!("{label}: expected numeric {name}"),
                    },
                }
            }
        } else {
            assert!(matches!(numeric, JsonValue::Null));
        }
        assert_eq!(
            clock.calls.load(Ordering::SeqCst),
            number(field(out, "builderClockCalls")) as usize,
            "{label}"
        );
        for run in array(field(out, "runs")) {
            let calls = array(field(run, "calls"));
            assert_eq!(calls.len(), usize::from(actual.is_some()), "{label}");
            assert_eq!(
                number(field(run, "clockCalls")) as usize,
                calls.len(),
                "{label}"
            );
            if let Some(receipt) = &actual {
                assert_eq!(text(field(&calls[0], "key")), AI_USAGE_RECEIPT_QUEUE_KEY);
                assert_eq!(
                    receipt.json_enqueued_at(now).unwrap(),
                    text(field(&calls[0], "wire")),
                    "{label}"
                );
                assert_eq!(
                    matches!(field(run, "error"), JsonValue::String(_)),
                    yes(field(run, "fail"))
                );
            } else {
                assert!(matches!(field(run, "error"), JsonValue::Null));
            }
        }
        if input.get("nativeContext").is_some() {
            let mut native: AiUsageContext =
                serde_json::from_str(text(field(input, "contextJson")))
                    .expect("real event context/native declared data");
            if let Some(b) = input.get("quantityBits") {
                native.quantity = Some(bits(b));
            }
            let r = build_queued_ai_usage_receipt_native_with_clock(
                text(field(input, "channelID")),
                text(field(input, "customerId")),
                occurred(input),
                &FixedReceiptClock(now),
                &native,
                bits(field(input, "creditsBits")),
            );
            assert_eq!(
                r.as_ref()
                    .map_or_else(|| "null".into(), QueuedAiUsageReceipt::json),
                wire,
                "typed: {label}"
            );
            native_count += 1;
        }
        replayed += 1;
    }
    assert_eq!(replayed, array(field(&f, "cases")).len());
    assert!(native_count >= 16);
    for case in array(field(&f, "tiers")) {
        let i = field(case, "input");
        let value = match text(field(i, "kind")) {
            "undefined" => JsonValue::Null, // validTier's undefined/null both free
            "number" => JsonValue::Number(bits(field(i, "bits"))),
            "json" => parse_json(text(field(i, "wire"))).unwrap(),
            _ => panic!("unknown tier token"),
        };
        assert_eq!(
            get_ai_usage_retention_days(&value),
            number(field(case, "days")) as u32
        );
    }
}

#[test]
fn downstream_surrogate_gap_is_explicit() {
    let c =
        parse_json(r#"{"entryId":"id\ud800","entryKind":"usage","source":"tts_queue"}"#).unwrap();
    let r = build_queued_ai_usage_receipt_at(
        JsString::from("c"),
        "u".into(),
        Some(JsDate::from_millis(0.0)),
        JsDate::invalid(),
        &c,
        1.0,
    )
    .unwrap();
    assert!(parse_json(&r.json()).is_ok());
    assert!(
        serde_json::from_str::<serde_json::Value>(&r.json()).is_err(),
        "current native consumer parser rejects lone surrogate; producer must not replace it"
    );
}

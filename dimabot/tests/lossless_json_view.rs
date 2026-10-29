#![cfg(feature = "lossless-json-view")]
//! Authored only; parent runs these in its isolated capped compiler. The actual
//! source-oracle replay for this API is part of ai_usage_receipt_parser.rs and
//! binds this file and the shared implementation in fixture provenance.
use dima_rust::utils::{
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
    lossless_json_view::{JsonDocument, js_number},
};

fn nested(depth: usize, leaf: &str) -> String {
    format!("{}{leaf}{}", "[".repeat(depth), "]".repeat(depth))
}

#[test]
fn deep_ignored_bytes_remain_borrowed_and_drop_without_an_owned_tree() {
    let raw = format!(
        r#"{{"unknown":{},"wanted":"ok","after":-0}}"#,
        nested(4096, r#"{"leaf":"\ud800"}"#)
    );
    let doc = JsonDocument::parse(&raw).unwrap();
    let root = doc.root();
    let unknown = root.get("unknown").unwrap();
    assert_eq!(
        unknown.raw().as_ptr(),
        raw[11..].as_ptr(),
        "span borrows original bytes"
    );
    assert!(unknown.scalar().is_none(), "no owned container conversion");
    assert_eq!(
        root.get("wanted").unwrap().as_string().unwrap().as_str(),
        Some("ok")
    );
    assert_eq!(
        js_number(root.get("after")).unwrap().to_bits(),
        (-0.0_f64).to_bits()
    );
    // Existing service guard is intentionally preserved even for ignored data.
    assert!(parse_json(&raw).is_err());
    drop(doc);
    let raw = format!(
        r#"{{"toString":{},"id":{},"id":"last"}}"#,
        nested(4096, "null"),
        nested(4096, "null")
    );
    let doc = JsonDocument::parse(&raw).unwrap();
    assert_eq!(
        doc.root().get("id").unwrap().as_string().unwrap().as_str(),
        Some("last")
    );
    assert!(
        doc.root().js_string().is_err(),
        "own toString's deep value is never coerced"
    );
}

#[test]
fn strict_validation_covers_ignored_deep_syntax_and_all_input_bytes() {
    for depth in [0, 129, 256, 4096] {
        for leaf in [
            "null",
            "-0",
            "1e9999",
            r#""\ud800""#,
            r#"{"x":[],"y":[null,{}]}"#,
        ] {
            assert!(
                JsonDocument::parse(&nested(depth, leaf)).is_ok(),
                "{depth} {leaf}"
            );
        }
        for leaf in [
            "01",
            "+1",
            "1.",
            "1e",
            "1e+",
            "NaN",
            "Infinity",
            "undefined",
            "[1,]",
            "[,1]",
            "[1 2]",
            "{\"a\" 1}",
            "{\"a\":}",
            "{\"a\":1,}",
            "{a:1}",
            r#""\u12XZ""#,
            r#""\q""#,
            "\"a\nb\"",
            "\"\u{001f}\"",
        ] {
            assert!(
                JsonDocument::parse(&nested(depth, leaf)).is_err(),
                "{depth} {leaf:?}"
            );
        }
        let valid = nested(depth, "null");
        for invalid in [
            format!("{valid} false"),
            format!("\u{feff}{valid}"),
            format!("{valid}\u{000b}"),
            format!("{valid}]"),
            format!("[{valid}"),
            format!("{{\"ignored\":{valid},}}"),
        ] {
            assert!(JsonDocument::parse(&invalid).is_err());
        }
    }
    for raw in [
        "",
        " ",
        "[",
        "{",
        "\"unterminated",
        "[[{}]]garbage",
        "{\"a\":{]}",
    ] {
        assert!(JsonDocument::parse(raw).is_err(), "{raw:?}");
    }
}

#[test]
fn last_keys_decode_utf16_and_proto_names_are_plain_own_fields() {
    let raw = r#"{"id":"old","\u0069d":"last\ud800","\ud800":1,"\ud800":2,"__proto__":{"toString":null},"nil":null,"to\u0053tring":0,"toString":null}"#;
    let doc = JsonDocument::parse(raw).unwrap();
    let root = doc.root();
    assert_eq!(
        root.get("id").unwrap().as_string().unwrap().units(),
        vec![108, 97, 115, 116, 0xd800]
    );
    assert_eq!(
        js_number(root.get_key(&JsString::from_units(vec![0xd800]))).unwrap(),
        2.0
    );
    assert!(root.get("missing").is_none());
    assert!(root.get("nil").unwrap().is_null());
    assert!(root.get("__proto__").unwrap().js_string().is_err());
    assert!(
        root.js_string().is_err(),
        "own noncallable toString survives duplicates"
    );
    let doc = JsonDocument::parse(r#"{"__proto__":{"toString":null},"valueOf":null}"#).unwrap();
    assert_eq!(
        doc.root().js_string().unwrap().as_str(),
        Some("[object Object]")
    );
}

#[test]
fn nested_join_retains_each_arrays_empties_separators_utf16_and_throw() {
    for (raw, expected) in [
        ("[]", ""),
        ("[null]", ""),
        ("[null,[]]", ","),
        (r#"[null,[],["a","b"]]"#, ",,a,b"),
        (r#"[[null,[]],[[],null],[],[null,["x",null]]]"#, ",,,,,,x,"),
        (
            r#"[{},null,[false,true,-0,1e309]]"#,
            "[object Object],,false,true,0,Infinity",
        ),
    ] {
        let doc = JsonDocument::parse(raw).unwrap();
        assert!(doc.root().truthy());
        assert_eq!(
            doc.root().js_string().unwrap().as_str(),
            Some(expected),
            "{raw}"
        );
    }
    let doc = JsonDocument::parse(r#"[["\ud800",null],["😀","\udc00"]]"#).unwrap();
    assert_eq!(
        doc.root().js_string().unwrap().units(),
        vec![0xd800, 44, 44, 0xd83d, 0xde00, 44, 0xdc00]
    );
    for depth in [129, 256] {
        let raw = nested(depth, r#"[null,[],["\ud800","x"]]"#);
        let doc = JsonDocument::parse(&raw).unwrap();
        assert_eq!(
            doc.root().js_string().unwrap().units(),
            vec![44, 44, 0xd800, 44, 120]
        );
        let raw = nested(depth, r#"{"toString":{}}"#);
        let doc = JsonDocument::parse(&raw).unwrap();
        assert!(doc.root().js_string().is_err());
        assert!(js_number(Some(doc.root())).is_err());
    }
}

#[test]
fn scalar_policies_and_missing_null_and_truthiness_precede_conversion() {
    let doc = JsonDocument::parse(r#"{"nil":null,"empty":[],"zero":[[[" -0 "]]],"hex":["\ufeff0x20000000000003\u3000"],"bad":"\ud800","object":{}}"#).unwrap();
    let root = doc.root();
    assert!(js_number(root.get("missing")).unwrap().is_nan());
    assert_eq!(
        js_number(root.get("nil")).unwrap().to_bits(),
        0.0_f64.to_bits()
    );
    let empty = root.get("empty").unwrap();
    assert!(empty.truthy());
    assert!(empty.js_string().unwrap().is_empty());
    assert_eq!(js_number(Some(empty)).unwrap(), 0.0);
    assert_eq!(
        js_number(root.get("zero")).unwrap().to_bits(),
        (-0.0_f64).to_bits()
    );
    assert_eq!(js_number(root.get("hex")).unwrap(), 9_007_199_254_740_996.0);
    assert!(js_number(root.get("bad")).unwrap().is_nan());
    assert!(js_number(root.get("object")).unwrap().is_nan());
    for raw in ["null", "false", "0", "-0", r#""""#] {
        let doc = JsonDocument::parse(raw).unwrap();
        assert!(!doc.root().truthy());
        assert!(doc.root().get("id").is_none());
    }
    let doc = JsonDocument::parse("1e309").unwrap();
    assert!(matches!(doc.root().scalar(), Some(JsonValue::Number(n)) if n == f64::INFINITY));
}

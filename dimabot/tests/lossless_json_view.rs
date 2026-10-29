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

fn assert_scalar_lookups(raw: &str, cases: &[(&str, Option<f64>)]) {
    let doc = JsonDocument::parse(raw).unwrap();
    let owned = parse_json(raw).unwrap();
    for &(key, expected) in cases {
        let expected = expected.map(JsonValue::Number);
        let by_str = doc.root().get(key).map(|value| {
            value
                .scalar()
                .expect("lookup fixture has only scalar queried values")
        });
        let by_units = doc.root().get_key(&JsString::from(key)).map(|value| {
            value
                .scalar()
                .expect("lookup fixture has only scalar queried values")
        });
        assert_eq!(by_str, expected, "get {key:?} in {raw}");
        assert_eq!(by_units, expected, "get_key {key:?} in {raw}");
        assert_eq!(owned.get(key), expected.as_ref(), "owned {key:?} in {raw}");
    }
}

#[test]
fn raw_key_lookup_is_exact_for_empty_prefix_unicode_and_own_names() {
    let raw = r#"{"":0,"i":1,"id":2,"identifier":3,"é":4,"é":5,"😀":6,"😀x":7,"__proto__":8,"constructor":9,"toString":10,"/":11}"#;
    assert_scalar_lookups(
        raw,
        &[
            ("", Some(0.0)),
            ("i", Some(1.0)),
            ("id", Some(2.0)),
            ("identifier", Some(3.0)),
            ("é", Some(4.0)),
            ("e\u{0301}", Some(5.0)),
            ("😀", Some(6.0)),
            ("😀x", Some(7.0)),
            ("__proto__", Some(8.0)),
            ("constructor", Some(9.0)),
            ("toString", Some(10.0)),
            ("/", Some(11.0)),
            ("missing", None),
            ("ID", None),
            ("ident", None),
            ("identifierX", None),
            ("😀xx", None),
            ("e", None),
            ("\u{0301}", None),
            ("__proto", None),
            ("valueOf", None),
            ("hasOwnProperty", None),
        ],
    );
}

#[test]
fn raw_and_escaped_aliases_keep_the_last_value_in_both_orders() {
    for raw in [
        r#"{"id":1,"\u0069d":2,"é":3,"\u00e9":4,"😀":5,"\ud83d\ude00":6,"__proto__":7,"\u005f_proto__":8,"é":9,"e\u0301":10}"#,
        r#"{"\u0069d":1,"id":2,"\u00e9":3,"é":4,"\ud83d\ude00":5,"😀":6,"\u005f_proto__":7,"__proto__":8,"e\u0301":9,"é":10}"#,
    ] {
        assert_scalar_lookups(
            raw,
            &[
                ("id", Some(2.0)),
                ("é", Some(4.0)),
                ("😀", Some(6.0)),
                ("__proto__", Some(8.0)),
                ("e\u{0301}", Some(10.0)),
                ("i", None),
                ("idX", None),
                (r"\u0069d", None),
                (r"\ud83d\ude00", None),
            ],
        );
    }
}

#[test]
fn escaped_keys_preserve_controls_quotes_backslashes_and_literal_escape_text() {
    let raw = r#"{"":1,"\"":2,"\u0022":3,"\\":4,"\u005c":5,"\/":6,"/":7,"\b":8,"\u0008":9,"\f":10,"\u000c":11,"\n":12,"\u000a":13,"\r":14,"\u000d":15,"\t":16,"\u0009":17,"\u0000":18,"prefix\u0000suffix":19,"\u001f":20,"\\u0061":21,"a":22,"\\n":23,"x\\\"y":24}"#;
    assert_scalar_lookups(
        raw,
        &[
            ("", Some(1.0)),
            ("\"", Some(3.0)),
            ("\\", Some(5.0)),
            ("/", Some(7.0)),
            ("\u{0008}", Some(9.0)),
            ("\u{000c}", Some(11.0)),
            ("\n", Some(13.0)),
            ("\r", Some(15.0)),
            ("\t", Some(17.0)),
            ("\0", Some(18.0)),
            ("prefix\0suffix", Some(19.0)),
            ("\u{001f}", Some(20.0)),
            (r"\u0061", Some(21.0)),
            ("a", Some(22.0)),
            (r"\n", Some(23.0)),
            ("x\\\"y", Some(24.0)),
            ("prefix", None),
            ("prefix\0", None),
            (r"\u0000", None),
            ("x\"y", None),
        ],
    );
    // The established serializer supplies every control-character spelling;
    // the expected values do not reproduce the view's matching implementation.
    for control in 0_u8..0x20 {
        let key = char::from(control).to_string();
        let quoted = serde_json::to_string(&key).unwrap();
        let raw = format!("{{{quoted}:1,{quoted}:2}}");
        assert_scalar_lookups(&raw, &[(key.as_str(), Some(2.0))]);
    }
}

#[test]
fn utf16_key_lookup_keeps_lone_surrogates_reversed_pairs_and_replacement_distinct() {
    let raw = r#"{"plain":0,"�":1,"\ud800":2,"\uD800":3,"\udc00":4,"\uDC00":5,"\udc00\ud800":6,"\ud83d\ude00":7,"😀":8,"\ud800x":9,"x\udc00":10,"\ud800\ud83d\ude00\udc00":11,"\ud800\ud800":12,"\udc00\udc00":13,"\ud800\u0000":14,"\ud800\\":15,"\ud800\"":16}"#;
    assert_scalar_lookups(raw, &[("�", Some(1.0)), ("😀", Some(8.0))]);
    let doc = JsonDocument::parse(raw).unwrap();
    let JsonValue::Object(owned_fields) = parse_json(raw).unwrap() else {
        panic!("object fixture");
    };
    for (units, expected) in [
        (vec![0xd800], Some(3.0)),
        (vec![0xdc00], Some(5.0)),
        (vec![0xdc00, 0xd800], Some(6.0)),
        (vec![0xd83d, 0xde00], Some(8.0)),
        (vec![0xd800, 120], Some(9.0)),
        (vec![120, 0xdc00], Some(10.0)),
        (vec![0xd800, 0xd83d, 0xde00, 0xdc00], Some(11.0)),
        (vec![0xd800, 0xd800], Some(12.0)),
        (vec![0xdc00, 0xdc00], Some(13.0)),
        (vec![0xd800, 0], Some(14.0)),
        (vec![0xd800, 92], Some(15.0)),
        (vec![0xd800, 34], Some(16.0)),
        (vec![0xd800, 0xdc00], None),
        (vec![0xdc00, 0xd83d], None),
        (vec![0xd800, 120, 0], None),
    ] {
        let key = JsString::from_units(units);
        let expected = expected.map(JsonValue::Number);
        let actual = doc
            .root()
            .get_key(&key)
            .map(|value| value.scalar().unwrap());
        assert_eq!(actual, expected, "key units {:?}", key.units());
        // The owned reader has already decoded names and resolved duplicates.
        let owned = owned_fields
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| value);
        assert_eq!(
            owned,
            expected.as_ref(),
            "owned key units {:?}",
            key.units()
        );
        if let Some(key) = key.as_str() {
            assert_eq!(
                doc.root().get(key).map(|value| value.scalar().unwrap()),
                expected
            );
        }
    }
}

#[test]
fn key_lookup_stays_within_its_object_and_skips_whole_nested_subtrees() {
    let raw = r#"{"target":1,"ignored":{"target":2,"deeper":{"target":3}},"list":[{"target":4},[{"target":5}]],"nested":{"target":6,"\u0074arget":7},"\u0074arget":8,"after":9}"#;
    assert_scalar_lookups(
        raw,
        &[
            ("target", Some(8.0)),
            ("after", Some(9.0)),
            ("deeper", None),
            ("missing", None),
        ],
    );
    let doc = JsonDocument::parse(raw).unwrap();
    let root = doc.root();
    let owned = parse_json(raw).unwrap();
    for field in ["ignored", "nested"] {
        let nested = root.get(field).unwrap();
        let expected = owned.get(field).unwrap().get("target");
        assert_eq!(nested.get("target").unwrap().scalar().as_ref(), expected);
        assert_eq!(
            nested
                .get_key(&JsString::from("target"))
                .unwrap()
                .scalar()
                .as_ref(),
            expected
        );
        assert!(nested.get("after").is_none());
    }
    let list = root.get("list").unwrap();
    assert!(list.get("target").is_none());
    assert_eq!(
        list.array()
            .unwrap()
            .next()
            .unwrap()
            .get("target")
            .unwrap()
            .scalar(),
        Some(JsonValue::Number(4.0))
    );
    for raw in [
        "{}",
        "null",
        "false",
        "1",
        r#""id""#,
        "[]",
        r#"["id",{"id":1}]"#,
    ] {
        let doc = JsonDocument::parse(raw).unwrap();
        for key in ["", "id", "0", "length", "toString", "__proto__"] {
            assert!(doc.root().get(key).is_none(), "{raw} {key:?}");
            assert!(doc.root().get_key(&JsString::from(key)).is_none());
        }
        assert!(
            doc.root()
                .get_key(&JsString::from_units(vec![0xd800]))
                .is_none()
        );
    }
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

#![cfg(feature = "ai-usage-lossless")]

use dima_rust::utils::{
    ai_usage_lossless::{
        AiUsageLosslessError, create_ai_usage_context_json, create_ai_usage_context_json_with_id,
        enrich_polar_usage_metadata_json, to_polar_usage_metadata_json,
    },
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
};

fn string<'a>(value: &'a JsonValue, key: &str) -> &'a JsString {
    match value.get(key).expect("fixture field") {
        JsonValue::String(s) => s,
        _ => panic!("expected string: {key}"),
    }
}
fn parsed_string(value: &JsonValue, key: &str) -> JsonValue {
    parse_json(string(value, key).as_str().expect("fixture raw UTF-8")).unwrap()
}

#[test]
#[ignore = "requires independently hashed pinned actual-source fixture"]
fn replay_every_actual_source_case_and_exact_wires() {
    let dir = std::env::var_os("AI_USAGE_LOSSLESS_REFERENCE_DIR").expect(
        "parent must generate and check source oracle, then set AI_USAGE_LOSSLESS_REFERENCE_DIR",
    );
    let path = std::path::PathBuf::from(dir).join("ai_usage_lossless_reference.json");
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path).expect("source fixture missing");
    let pin = std::env::var("AI_USAGE_LOSSLESS_REFERENCE_SHA256")
        .expect("independent reference SHA-256 required");
    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), pin);
    let fixture = parse_json(std::str::from_utf8(&bytes).unwrap()).unwrap();
    let metadata = fixture.get("metadata").unwrap();
    assert_eq!(string(metadata, "node").as_str(), Some("v24.22.1"));
    assert_eq!(string(metadata, "v8").as_str(), Some("13.6.233.17-node.58"));
    assert_eq!(string(metadata, "typescript").as_str(), Some("5.9.3"));
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let JsonValue::Object(native) = metadata.get("nativeHashes").unwrap() else {
        panic!("native hashes")
    };
    assert_eq!(native.len(), 11);
    for (name, expected) in native {
        let relative = std::path::Path::new(name.as_str().unwrap());
        assert!(
            relative
                .components()
                .all(|p| matches!(p, std::path::Component::Normal(_)))
        );
        let actual = format!(
            "{:x}",
            Sha256::digest(std::fs::read(root.join(relative)).unwrap())
        );
        let JsonValue::String(expected) = expected else {
            panic!("digest")
        };
        assert_eq!(actual, expected.as_str().unwrap(), "{relative:?}");
    }
    let source = format!(
        "{:x}",
        Sha256::digest(std::fs::read(root.join("src/utils/ai_usage_event.ts")).unwrap())
    );
    assert_eq!(
        source,
        "87ff158c166652ea1eb64199ea4c9c6250b35db90399cb658ef6c3086628de60"
    );
    assert_eq!(
        string(
            metadata.get("hashes").unwrap(),
            "src/utils/ai_usage_event.ts"
        )
        .as_str(),
        Some(source.as_str())
    );
    let JsonValue::Array(cases) = fixture.get("cases").expect("cases") else {
        panic!("cases")
    };
    assert!(cases.len() >= 100, "full source corpus required");
    let fallback = JsString::from("aiu_00000000-0000-4000-8000-000000000001");
    for case in cases {
        let label = string(case, "id").to_utf8_lossy();
        let mut input = parsed_string(case, "raw");
        let JsonValue::Object(ref mut fields) = input else {
            panic!("input object")
        };
        if let Some(JsonValue::String(tag)) = case.get("quantityTag") {
            let number = match tag.as_str().unwrap() {
                "nan" => f64::NAN,
                "positiveInfinity" => f64::INFINITY,
                "negativeInfinity" => f64::NEG_INFINITY,
                _ => panic!("unknown quantity tag"),
            };
            fields.push(("quantity".into(), JsonValue::Number(number)));
        }
        let context =
            create_ai_usage_context_json_with_id(string(case, "reason"), &input, &fallback)
                .unwrap();
        let metadata = to_polar_usage_metadata_json(&context).unwrap();
        let enriched =
            enrich_polar_usage_metadata_json(&parsed_string(case, "accounting"), &context).unwrap();
        for (actual, field) in [
            (&context, "contextWire"),
            (&metadata, "metadataWire"),
            (&enriched, "enrichedWire"),
        ] {
            assert_eq!(
                actual.to_json_string(),
                string(case, field).as_str().unwrap(),
                "{label}: {field}"
            );
        }
    }
    let JsonValue::Array(metadata_cases) = fixture.get("metadataCases").expect("metadata cases")
    else {
        panic!("metadata cases")
    };
    assert!(!metadata_cases.is_empty());
    for case in metadata_cases {
        let context = parsed_string(case, "raw");
        let metadata = to_polar_usage_metadata_json(&context).unwrap();
        let enriched =
            enrich_polar_usage_metadata_json(&parsed_string(case, "accounting"), &context).unwrap();
        for (actual, field) in [(&metadata, "metadataWire"), (&enriched, "enrichedWire")] {
            assert_eq!(
                actual.to_json_string(),
                string(case, field).as_str().unwrap(),
                "{}: {field}",
                string(case, "id").to_utf8_lossy()
            );
        }
    }
}

#[test]
fn lossless_trim_and_collision_positions() {
    let input = JsonValue::Object(vec![
        (
            "entryId".into(),
            JsonValue::String(JsString::from_units(vec![0xfeff, 0xd800, 0x20])),
        ),
        (
            "resourceId".into(),
            JsonValue::String(JsString::from_units(vec![0x20, 0xdc00, 0x20])),
        ),
    ]);
    let reason = JsString::from_units(vec![0xdfff]);
    let ctx = create_ai_usage_context_json_with_id(&reason, &input, &"fallback".into()).unwrap();
    assert_eq!(string(&ctx, "entryId").units(), [0xd800]);
    assert_eq!(string(&ctx, "operation").units(), [0xdfff]);
    let accounting = parse_json(r#"{"x":1,"entry_id":"old","x":2,"z":3}"#).unwrap();
    let enriched = enrich_polar_usage_metadata_json(&accounting, &ctx).unwrap();
    let wire = enriched.to_json_string();
    assert!(wire.starts_with(r#"{"x":2,"entry_id":"\ud800","z":3,"schema_version":1"#));
    assert!(wire.contains(r#""resource_id":"\udc00""#));
}

#[test]
fn finite_quantity_and_object_errors() {
    for n in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let input = JsonValue::Object(vec![("quantity".into(), JsonValue::Number(n))]);
        let ctx =
            create_ai_usage_context_json_with_id(&"messages".into(), &input, &"fixture".into())
                .unwrap();
        assert!(ctx.get("quantity").is_none());
    }
    let ctx = create_ai_usage_context_json(
        &"messages".into(),
        &JsonValue::Object(vec![("entryId".into(), JsonValue::String("id".into()))]),
    )
    .unwrap();
    assert_eq!(string(&ctx, "entryId").as_str(), Some("id"));
    assert_eq!(
        to_polar_usage_metadata_json(&JsonValue::Object(vec![])),
        Err(AiUsageLosslessError::MissingContextField("schemaVersion"))
    );
    assert_eq!(
        create_ai_usage_context_json(&"messages".into(), &JsonValue::Null),
        Err(AiUsageLosslessError::ExpectedObject)
    );
    let bad = parse_json(r#"{"model":{"toString":null}}"#).unwrap();
    assert_eq!(
        create_ai_usage_context_json_with_id(&"messages".into(), &bad, &"fixture".into()),
        Err(AiUsageLosslessError::StringCoercion)
    );
}

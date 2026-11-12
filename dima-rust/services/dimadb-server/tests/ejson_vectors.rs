//! The document format against vectors written by the reference's own packages
//! (`tests/vectors/generate.mjs`: mongodb 6.20 / bson 6.10.4 under Node 26, `TZ=UTC`).

use dimadb_server::{ejson, js};
use serde_json::Value;

fn vectors() -> Value {
    let text = include_str!("vectors/ejson.json");
    serde_json::from_str(text).unwrap_or(Value::Null)
}

fn list<'a>(all: &'a Value, name: &str) -> &'a [Value] {
    let cases = all
        .get(name)
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    assert!(cases.len() >= 10, "vectors/ejson.json has no {name} cases");
    cases
}

fn text<'a>(case: &'a Value, name: &str) -> Option<&'a str> {
    case.get(name).and_then(Value::as_str)
}

#[test]
fn reads_render_as_the_reference_sends_them() {
    let all = vectors();
    let mut failures = Vec::new();
    for case in list(&all, "reads") {
        let name = text(case, "name").unwrap_or_default();
        let bytes = hex::decode(text(case, "bson").unwrap_or_default()).unwrap_or_default();
        let document = match bson::RawDocumentBuf::from_bytes(bytes) {
            Ok(document) => document,
            Err(error) => {
                failures.push(format!("{name}: bad vector: {error}"));
                continue;
            }
        };
        let rendered = ejson::serialize_document(&document);
        match (text(case, "json"), text(case, "error"), rendered) {
            (Some(expected), _, Ok(value)) => {
                let actual = dima_text::to_js_json(&value);
                if actual != expected {
                    failures.push(format!(
                        "{name}:\n  expected {expected}\n  actual   {actual}"
                    ));
                }
                let id = ejson::id_text(&document);
                if Some(id.as_str()) != text(case, "id") {
                    failures.push(format!(
                        "{name}: id {id:?}, expected {:?}",
                        text(case, "id")
                    ));
                }
            }
            (_, Some(expected), Err(error)) => {
                if error.0 != expected {
                    failures.push(format!(
                        "{name}: error {:?}, expected {expected:?}",
                        error.0
                    ));
                }
            }
            (_, _, other) => failures.push(format!("{name}: unexpected outcome {other:?}")),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn writes_store_the_reference_bson() {
    let all = vectors();
    let mut failures = Vec::new();
    for case in list(&all, "writes") {
        let name = text(case, "name").unwrap_or_default();
        let source = text(case, "text").unwrap_or_default();
        let Some(parsed) = js::parse_json(source.as_bytes()) else {
            failures.push(format!("{name}: does not parse"));
            continue;
        };
        let outcome = ejson::deserialize(&parsed).map(|value| ejson::to_bson(&value));
        match (text(case, "bson"), text(case, "error"), outcome) {
            (Some(expected), _, Ok(bson::Bson::Document(document))) => {
                let mut bytes = Vec::new();
                if let Err(error) = document.to_writer(&mut bytes) {
                    failures.push(format!("{name}: {error}"));
                    continue;
                }
                let actual = hex::encode(bytes);
                if actual != expected {
                    let theirs =
                        bson::RawDocumentBuf::from_bytes(hex::decode(expected).unwrap_or_default())
                            .ok()
                            .and_then(|raw| bson::Document::try_from(&raw).ok());
                    failures.push(format!(
                        "{name}:\n  expected {theirs:?}\n  actual   {document:?}"
                    ));
                }
            }
            (_, Some(expected), Err(error)) => {
                if error.0 != expected {
                    failures.push(format!(
                        "{name}: error {:?}, expected {expected:?}",
                        error.0
                    ));
                }
            }
            (_, _, other) => failures.push(format!("{name}: unexpected outcome {other:?}")),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn filters_parse_like_the_reference() {
    let all = vectors();
    let mut failures = Vec::new();
    for case in list(&all, "filters") {
        let name = text(case, "name").unwrap_or_default();
        let source = text(case, "text").unwrap_or_default();
        match (
            dimadb_server::mongo_hub::parse_filter(source),
            case.get("bson"),
        ) {
            (Ok(value), Some(Value::String(expected))) => {
                let mut bytes = Vec::new();
                if let bson::Bson::Document(document) = ejson::to_bson(&value) {
                    let _ = document.to_writer(&mut bytes);
                }
                if hex::encode(&bytes) != *expected {
                    failures.push(format!("{name}: bson differs"));
                }
            }
            (Ok(_), _) => {}
            (Err(error), _) => failures.push(format!("{name}: {}", error.message)),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#![cfg(feature = "ai-usage-ledger-persistence")]
//! AUTHOR ONLY: execution belongs to the parent capped isolated compiler.
use dima_rust::utils::{
    ai_usage_ledger_persistence::{
        self as policy, AiUsagePersistenceError, MongoAiUsageLedgerPersistence,
        PersistAiUsageReceiptOutcome,
    },
    ai_usage_lock::{self, AiUsageLock, AiUsageLockError},
    ai_usage_producer::{FixedReceiptClock, ReceiptClock, build_queued_ai_usage_receipt_at},
    ai_usage_receipt_parser::RetentionTier,
    credit_policy::JsDate,
    js_string::JsString,
    lossless_json::JsonValue,
};
use futures_util::{FutureExt, TryStreamExt};
use mongodb::{
    Client, Database,
    bson::{Bson, DateTime, Document, doc},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::Cursor,
    path::{Component, Path},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

const NOW: i64 = 1_793_275_200_000;
const DAY: i64 = 86_400_000;
fn date(ms: i64) -> JsDate {
    JsDate::from_millis(ms as f64)
}
fn object(fields: Vec<(&str, JsonValue)>) -> JsonValue {
    JsonValue::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn receipt() -> JsonValue {
    object(vec![
        ("channelID", JsonValue::String("channel".into())),
        ("customerId", JsonValue::String("customer".into())),
        ("id", JsonValue::String("receipt".into())),
        (
            "occurredAt",
            JsonValue::String(date(NOW).to_iso_string().unwrap().as_str().into()),
        ),
        ("entryKind", JsonValue::String("usage".into())),
        ("category", JsonValue::String("tts".into())),
        ("operation", JsonValue::String("synthesis".into())),
        ("provider", JsonValue::String("piper".into())),
        ("credits", JsonValue::Number(2.0)),
        ("quantity", JsonValue::Number(1.0)),
        ("itemized", JsonValue::Bool(true)),
    ])
}
fn set(row: &mut JsonValue, key: &str, value: JsonValue) {
    let JsonValue::Object(fields) = row else {
        panic!()
    };
    if let Some((_, v)) = fields.iter_mut().find(|(k, _)| k.as_str() == Some(key)) {
        *v = value;
    } else {
        fields.push((key.into(), value));
    }
}
fn group(day: &str, category: &str, spent: Bson, count: Bson) -> Document {
    doc! {"_id":{"date":day,"category":category},"spent":spent,"granted":0,"debited":0,"count":count,"expiresAt":DateTime::from_millis(NOW+30*DAY)}
}
fn numeric(doc: &Document, name: &str) -> f64 {
    match doc.get(name).unwrap() {
        Bson::Int32(v) => f64::from(*v),
        Bson::Double(v) => *v,
        Bson::Int64(v) => *v as f64,
        _ => panic!("numeric {name}"),
    }
}

#[test]
fn direct_producer_nan_is_not_normalized_by_a_queue_roundtrip() {
    let context = object(vec![
        ("entryId", JsonValue::String("receipt".into())),
        ("entryKind", JsonValue::String("usage".into())),
        ("operation", JsonValue::String(" usage ".into())),
        ("provider", JsonValue::String(" piper ".into())),
        ("quantity", JsonValue::Number(f64::NAN)),
    ]);
    let queued = build_queued_ai_usage_receipt_at(
        "channel".into(),
        "customer".into(),
        Some(date(NOW)),
        date(0),
        &context,
        2.0,
    )
    .unwrap();
    let document = policy::receipt_document(queued.as_value(), RetentionTier::Free).unwrap();
    assert!(matches!(document.fields.get("quantity"),Some(Bson::Double(v))if v.is_nan()));
    assert_eq!(document.fields.get_str("operation").unwrap(), " usage ");
    assert!(matches!(
        policy::receipt_upsert(queued.as_value(), &document, date(NOW)),
        Err(AiUsagePersistenceError::CastError { path: "quantity" })
    ));
}

#[test]
fn update_has_timestamps_defaults_and_no_save_validators_or_id_default() {
    let mut row = receipt();
    set(
        &mut row,
        "entryKind",
        JsonValue::String("legacy-kind".into()),
    );
    set(&mut row, "operation", JsonValue::String("".into()));
    let document = policy::receipt_document(&row, RetentionTier::Premium).unwrap();
    let update = policy::receipt_upsert(&row, &document, date(NOW + 13)).unwrap();
    let insert = update.update.get_document("$setOnInsert").unwrap();
    assert!(!insert.contains_key("_id"));
    assert_eq!(insert.get_i32("__v").unwrap(), 0);
    assert_eq!(insert.get_str("entryKind").unwrap(), "legacy-kind");
    assert_eq!(insert.get_str("operation").unwrap(), "");
    for name in [
        "requestId",
        "source",
        "adjustmentType",
        "model",
        "unit",
        "resourceType",
        "resourceId",
    ] {
        assert_eq!(insert.get(name), Some(&Bson::Null));
    }
    assert_eq!(
        insert.get_datetime("expiresAt").unwrap().timestamp_millis(),
        NOW + 60 * DAY
    );
    assert_eq!(
        update
            .update
            .get_document("$set")
            .unwrap()
            .get_datetime("updated_at")
            .unwrap()
            .timestamp_millis(),
        NOW + 13
    );
}

#[test]
fn lock_identity_stays_utf16_while_bson_collision_matches_source() {
    let channel_a = JsString::from_units(vec![0xd800]);
    let channel_b = JsString::from_units(vec![0xdc00]);
    assert_ne!(
        ai_usage_lock::account_key(&channel_a, &"customer".into()),
        ai_usage_lock::account_key(&channel_b, &"customer".into())
    );
    let mut a = receipt();
    let mut b = receipt();
    set(&mut a, "channelID", JsonValue::String(channel_a));
    set(&mut b, "channelID", JsonValue::String(channel_b));
    let a = policy::receipt_document(&a, RetentionTier::Free).unwrap();
    let b = policy::receipt_document(&b, RetentionTier::Free).unwrap();
    assert_eq!(a.fields.get("channelID"), b.fields.get("channelID"));
}

#[test]
fn source_sliced_day_differs_from_offset_date_floor_and_extended_iso_years() {
    let query =
        policy::daily_rebuild_query(&"c".into(), &"u".into(), date(NOW), date(NOW), date(NOW))
            .unwrap();
    assert_eq!(
        query.from.timestamp_millis(),
        Some(NOW.div_euclid(DAY) * DAY)
    );
    let extended = JsDate::from_millis(253_402_300_800_000.0);
    let query =
        policy::daily_rebuild_query(&"c".into(), &"u".into(), extended, extended, date(NOW))
            .unwrap();
    // Actual Node accepts the sliced extended year/month with a time suffix.
    // Keep this expectation tied to source replay rather than assuming invalidity.
    assert_eq!(query.from.timestamp_millis(), Some(253_402_300_800_000));
    assert_eq!(
        query.pipeline[0]
            .get_document("$match")
            .unwrap()
            .get_document("occurredAt")
            .unwrap()
            .get_datetime("$gte")
            .unwrap()
            .timestamp_millis(),
        253_402_300_800_000,
        "extended-year source slice remains a valid first-of-month date"
    );
    assert!(matches!(
        policy::daily_rebuild_range(JsDate::invalid(), extended),
        Err(AiUsagePersistenceError::RangeError {
            operation: "from.toISOString"
        })
    ));
}

#[test]
fn group_order_collision_and_wrapper_addition_survive_daily_schema_casting() {
    let rows = policy::reduce_daily_groups(&[
        group("2026-10-29", "legacy-a", 7.into(), 1.into()),
        group("2026-10-28", "tts", 5.into(), 1.into()),
        group("2026-10-29", "legacy-b", 11.into(), 1.into()),
    ])
    .unwrap();
    let docs = policy::prepare_daily_inserts(
        &"c".into(),
        &"u".into(),
        RetentionTier::Free,
        &rows,
        &FixedReceiptClock(date(NOW)),
    );
    assert_eq!(docs.len(), 2);
    assert_eq!(docs[0].get_str("date").unwrap(), "2026-10-29");
    assert_eq!(numeric(&docs[0], "spentCredits"), 18.0);
    assert_eq!(
        numeric(
            docs[0]
                .get_document("categories")
                .unwrap()
                .get_document("uncategorized")
                .unwrap(),
            "credits"
        ),
        11.0
    );
    let d: Bson = Bson::Decimal128("2.5".parse().unwrap());
    let rows = policy::reduce_daily_groups(&[
        group("2026-10-29", "tts", d, 1.into()),
        group("2026-10-29", "tts", 2.into(), 1.into()),
    ])
    .unwrap();
    let docs = policy::prepare_daily_inserts(
        &"c".into(),
        &"u".into(),
        RetentionTier::Free,
        &rows,
        &FixedReceiptClock(date(NOW)),
    );
    assert_eq!(
        numeric(&docs[0], "spentCredits"),
        2.52,
        "0 + Decimal('2.5') + 2 is string '02.52'"
    );
    assert_eq!(
        numeric(&docs[0], "netConsumedCredits"),
        2.52,
        "spent string + debited 0 => '02.520', then subtract"
    );
}

#[test]
fn unordered_insert_prevalidation_skips_invalid_rows_and_minimizes_categories() {
    let rows = policy::reduce_daily_groups(&[
        group("bad", "tts", 1.into(), 1.into()),
        group("2026-10-29", "tts", Bson::Double(f64::NAN), 1.into()),
        group("2026-10-28", "tts", 0.into(), 0.into()),
    ])
    .unwrap();
    let clock = CountClock::new(date(NOW));
    let docs =
        policy::prepare_daily_inserts(&"c".into(), &"u".into(), RetentionTier::Free, &rows, &clock);
    assert_eq!(docs.len(), 1);
    assert_eq!(clock.reads(), 1);
    assert!(!docs[0].contains_key("categories"));
    assert_eq!(docs[0].get_i32("__v").unwrap(), 0);
}

#[test]
fn unsupported_expiry_strings_fail_during_reduction_before_insert_preparation() {
    let future = Bson::DateTime(DateTime::from_millis(NOW + 60 * DAY));
    let expression = Bson::RegularExpression(mongodb::bson::Regex {
        pattern: "a".into(),
        options: "i".into(),
    });
    let mut deeply_nested = future.clone();
    for _ in 0..64 {
        deeply_nested = Bson::Array(vec![deeply_nested]);
    }
    for expiry in [
        Bson::Array(vec![future.clone()]),
        deeply_nested,
        Bson::Array(vec![expression.clone(), future.clone()]),
        Bson::Array(vec![future.clone(), expression.clone()]),
        expression,
    ] {
        let mut input = group("2026-10-29", "tts", 2.into(), 1.into());
        input.insert("expiresAt", expiry);
        let error = policy::reduce_daily_groups(&[input]).unwrap_err();
        assert!(matches!(
            error,
            AiUsagePersistenceError::UnsupportedLegacy {
                path: "expiresAt",
                ..
            }
        ));
        assert_eq!(error.name(), "UnsupportedLegacy");
        assert_eq!(error.path(), Some("expiresAt"));
    }
    let unsupported = AiUsagePersistenceError::Coercion(
        dima_rust::utils::ai_usage_ledger_reads::AiUsageLedgerReadError::UnsupportedLegacyBson {
            bson_type: "fixture-only unsupported BSON",
        },
    );
    assert_eq!(unsupported.name(), "UnsupportedLegacy");
}

#[test]
fn expiry_guard_preserves_supported_dates_arrays_and_object_string_semantics() {
    let future = Bson::DateTime(DateTime::from_millis(NOW + 60 * DAY));
    for expiry in [
        future.clone(),
        Bson::Array(vec![Bson::String("2026-12-01".into())]),
        Bson::Array(vec![Bson::Array(vec![Bson::String("2026-12-01".into())])]),
        Bson::Array(vec![]),
        // Object.toString does not inspect Date/RegExp-valued properties.
        Bson::Document(
            doc! {"nested":future.clone(),"expression":mongodb::bson::Regex {pattern:"a".into(),options:"".into()}},
        ),
        Bson::Array(vec![Bson::Document(doc! {"nested":future.clone()})]),
    ] {
        let mut input = group("2026-10-29", "tts", 2.into(), 1.into());
        input.insert("expiresAt", expiry);
        assert!(policy::reduce_daily_groups(&[input]).is_ok());
    }
    let mut input = group("2026-10-29", "tts", 2.into(), 1.into());
    input.insert("expiresAt", future);
    let rows = policy::reduce_daily_groups(&[input]).unwrap();
    let documents = policy::prepare_daily_inserts(
        &"c".into(),
        &"u".into(),
        RetentionTier::Free,
        &rows,
        &FixedReceiptClock(date(NOW)),
    );
    assert_eq!(documents.len(), 1);
    assert_eq!(
        documents[0]
            .get_datetime("expiresAt")
            .unwrap()
            .timestamp_millis(),
        NOW + 60 * DAY
    );
    for expiry in [
        Bson::Document(doc! {"toString":Bson::Null,"nested":DateTime::from_millis(NOW)}),
        Bson::Array(vec![Bson::Document(doc! {"toString":Bson::Null})]),
    ] {
        let mut input = group("2026-10-29", "tts", 2.into(), 1.into());
        input.insert("expiresAt", expiry);
        let error = policy::reduce_daily_groups(&[input]).unwrap_err();
        assert_eq!(error.name(), "TypeError");
        assert!(!matches!(
            error,
            AiUsagePersistenceError::UnsupportedLegacy { .. }
        ));
    }
}

#[derive(Clone)]
struct CountClock {
    value: JsDate,
    count: Arc<AtomicUsize>,
}
impl CountClock {
    fn new(value: JsDate) -> Self {
        Self {
            value,
            count: Arc::new(AtomicUsize::new(0)),
        }
    }
    fn reads(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }
}
impl ReceiptClock for CountClock {
    fn now(&self) -> JsDate {
        self.count.fetch_add(1, Ordering::SeqCst);
        self.value
    }
}

fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn fixture() -> Value {
    let output = std::env::var("DIMA_AI_LEDGER_PERSISTENCE_REFERENCE_DIR")
        .expect("external source fixture directory");
    let output = Path::new(&output).canonicalize().unwrap();
    let base = Path::new(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    assert!(!output.starts_with(base.parent().unwrap()));
    let bytes = std::fs::read(output.join("ai_usage_ledger_persistence_reference.json")).unwrap();
    assert!(!bytes.is_empty());
    let root: Value = serde_json::from_slice(&bytes).unwrap();
    let m = &root["metadata"];
    for (key, value) in [
        ("node", "v24.22.1"),
        ("v8", "13.6.233.17-node.58"),
        ("typescript", "5.9.3"),
        ("mongoose", "8.24.2"),
    ] {
        assert_eq!(m[key], value);
    }
    assert_eq!(m["format"], 1);
    assert_eq!(m["typeDiagnostics"], json!([]));
    let node = std::env::var("DIMA_AI_LEDGER_PERSISTENCE_NODE_BINARY")
        .expect("explicit pinned Node binary for hash only");
    assert_eq!(m["nodeSha256"], hash(std::fs::read(node).unwrap()));
    let dep = std::env::var("DIMA_AI_LEDGER_PERSISTENCE_NODE_DEPENDENCY_ROOT")
        .expect("public read-only Node dependencies for hashes only");
    let dep = Path::new(&dep);
    let safe = |file: &str| {
        let p = Path::new(file);
        assert!(!p.is_absolute());
        assert!(!p.components().any(|p| matches!(p, Component::ParentDir)));
    };
    for (name, version) in [
        ("typescript", "5.9.3"),
        ("mongoose", "8.24.2"),
        ("bson", "6.10.4"),
    ] {
        assert_eq!(m["packages"][name]["version"], version);
    }
    for package in m["packages"].as_object().unwrap().values() {
        for (file, digest) in [("entry", "entrySha256"), ("package", "packageSha256")] {
            let p = package[file].as_str().unwrap();
            safe(p);
            assert!(p.starts_with("node_modules/"));
            assert_eq!(package[digest], hash(std::fs::read(dep.join(p)).unwrap()));
        }
    }
    for (file, digest) in m["hashes"].as_object().unwrap() {
        safe(file);
        let p = if file.starts_with("node_modules/") {
            dep.join(file)
        } else {
            base.join(file)
        };
        assert_eq!(
            *digest,
            hash(std::fs::read(p).unwrap()),
            "source/native drift {file}"
        );
    }
    assert!(m["dependencies"].as_object().unwrap().len() > 10);
    for (file, digest) in m["dependencies"].as_object().unwrap() {
        safe(file);
        assert!(file.starts_with("node_modules/"));
        assert_eq!(
            *digest,
            hash(std::fs::read(dep.join(file)).unwrap()),
            "dependency drift {file}"
        );
    }
    for (key, file) in [
        (
            "extractedSha256",
            "ai_usage_ledger_persistence_extracted.ts",
        ),
        (
            "typecheckSha256",
            "ai_usage_ledger_persistence_typecheck.ts",
        ),
        ("compiledSha256", "ai_usage_ledger_persistence_compiled.cjs"),
    ] {
        let bytes = std::fs::read(output.join(file)).unwrap();
        assert!(!bytes.is_empty());
        assert_eq!(m[key], hash(bytes));
    }
    let declarations = m["declarations"].as_array().unwrap();
    assert!(declarations.len() > 15);
    for d in declarations {
        let source = std::fs::read_to_string(base.join(d["file"].as_str().unwrap())).unwrap();
        let a = d["startByte"].as_u64().unwrap() as usize;
        let b = d["endByte"].as_u64().unwrap() as usize;
        let text = format!("{}\n", &source[a..b]);
        assert_eq!(d["text"], text);
        assert_eq!(d["sha256"], hash(text));
    }
    for (name, exported) in [
        ("persistAiUsageReceipt", true),
        ("receiptDocument", false),
        ("rebuildUtcDailyAggregates", false),
        ("withAiUsageLock", true),
    ] {
        let d = declarations.iter().find(|d| d["name"] == name).unwrap();
        assert_eq!(d["kind"], "FunctionDeclaration");
        assert_eq!(d["exported"], exported);
        assert!(!d["parameters"].as_array().unwrap().is_empty());
    }
    assert_eq!(
        m["lockSourceSha256"],
        hash(m["lockSource"].as_str().unwrap())
    );
    let lock_dir = std::env::var("DIMA_AI_LOCK_REFERENCE_DIR")
        .expect("bound actual-source lock proof directory");
    let lock_dir = Path::new(&lock_dir).canonicalize().unwrap();
    assert!(!lock_dir.starts_with(base.parent().unwrap()));
    for (file, digest) in m["lockProofFiles"].as_object().unwrap() {
        safe(file);
        assert_eq!(
            *digest,
            hash(std::fs::read(lock_dir.join(file)).unwrap()),
            "bound lock proof drift {file}"
        );
    }
    let proof: Value = serde_json::from_slice(
        &std::fs::read(lock_dir.join("ai_usage_lock_reference.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(proof["metadata"]["total"], 291);
    assert_eq!(proof["cases"].as_array().unwrap().len(), 291);
    assert_eq!(m["lockProofCases"], 291);
    let records = root["records"].as_array().unwrap();
    assert!(records.len() > 180);
    assert_eq!(m["caseCount"].as_u64().unwrap() as usize, records.len());
    root
}
fn decode_hex(value: &str) -> Vec<u8> {
    assert_eq!(value.len() % 2, 0);
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).unwrap())
        .collect()
}
fn document(hex: &Value) -> Document {
    Document::from_reader(&mut Cursor::new(decode_hex(hex.as_str().unwrap()))).unwrap()
}
fn wire(doc: &Document) -> String {
    doc.to_vec()
        .unwrap()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn property<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value["$object"]
        .as_array()?
        .iter()
        .find(|v| v[0] == key)
        .map(|v| &v[1])
}
fn f64_value(value: &Value) -> f64 {
    f64::from_bits(u64::from_str_radix(value["$f64"].as_str().unwrap(), 16).unwrap())
}
fn fixture_string(value: &Value) -> JsString {
    JsString::from_units(
        value["$utf16"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u16)
            .collect(),
    )
}
fn fixture_value(value: &Value) -> JsonValue {
    if value.get("$f64").is_some() {
        return JsonValue::Number(f64_value(value));
    }
    if value.get("$utf16").is_some() {
        return JsonValue::String(fixture_string(value));
    }
    if let Some(v) = value.get("$object") {
        return JsonValue::Object(
            v.as_array()
                .unwrap()
                .iter()
                .filter(|p| p[1].get("$undefined").is_none())
                .map(|p| (p[0].as_str().unwrap().into(), fixture_value(&p[1])))
                .collect(),
        );
    }
    if let Some(v) = value.get("$array") {
        return JsonValue::Array(v.as_array().unwrap().iter().map(fixture_value).collect());
    }
    match value {
        Value::Null => JsonValue::Null,
        Value::Bool(v) => JsonValue::Bool(*v),
        _ => panic!("unexpected fixture plain value {value}"),
    }
}
fn fixture_date(value: &Value) -> JsDate {
    match &value["$date"] {
        Value::Null => JsDate::invalid(),
        Value::String(ms) => JsDate::from_millis(ms.parse().unwrap()),
        _ => panic!(),
    }
}
#[derive(Debug)]
struct ReplayError {
    name: &'static str,
    path: Option<&'static str>,
    code: Option<i64>,
}
impl From<AiUsagePersistenceError> for ReplayError {
    fn from(e: AiUsagePersistenceError) -> Self {
        Self {
            name: e.name(),
            path: e.path(),
            code: None,
        }
    }
}
fn call(
    calls: &mut Vec<Value>,
    record: &Value,
    kind: &'static str,
    args: Value,
) -> Result<(), ReplayError> {
    let mut args = args;
    args.as_object_mut()
        .unwrap()
        .insert("kind".into(), kind.into());
    calls.push(args);
    if record["fail"] == kind {
        Err(ReplayError {
            name: "MongoServerError",
            path: None,
            code: Some(12345),
        })
    } else {
        Ok(())
    }
}
#[allow(clippy::too_many_arguments)]
fn replay_rebuild(
    record: &Value,
    calls: &mut Vec<Value>,
    channel: &JsString,
    customer: &JsString,
    tier: RetentionTier,
    from: JsDate,
    to: JsDate,
    app: &CountClock,
    middleware: &CountClock,
) -> Result<(), ReplayError> {
    // Normalize before the application clock is sampled, as source evaluates
    // its first two statements before constructing aggregate expiresAt Date.
    policy::daily_rebuild_range(from, to)?;
    let query = policy::daily_rebuild_query(channel, customer, from, to, app.now())?;
    call(
        calls,
        record,
        "receipt.aggregate",
        json!({"pipelineHex":wire(&doc!{"pipeline":query.pipeline.iter().cloned().map(Bson::Document).collect::<Vec<_>>()}),"optionsHex":wire(&Document::new())}),
    )?;
    let groups = record["groupsHex"]
        .as_array()
        .unwrap()
        .iter()
        .map(document)
        .collect::<Vec<_>>();
    let rows = policy::reduce_daily_groups(&groups)?;
    let from = query.from.to_iso_string().map_err(|_| ReplayError {
        name: "RangeError",
        path: None,
        code: None,
    })?;
    let to = query.to.to_iso_string().map_err(|_| ReplayError {
        name: "RangeError",
        path: None,
        code: None,
    })?;
    let mut filter = query.delete_filter;
    filter.insert("date", doc! {"$gte":&from[..10],"$lte":&to[..10]});
    call(
        calls,
        record,
        "daily.deleteMany",
        json!({"filterHex":wire(&filter),"optionsHex":wire(&Document::new())}),
    )?;
    let documents = policy::prepare_daily_inserts(channel, customer, tier, &rows, middleware);
    if !documents.is_empty() {
        let hex = documents
            .into_iter()
            .map(|mut d| {
                d.remove("_id");
                wire(&d)
            })
            .collect::<Vec<_>>();
        call(
            calls,
            record,
            "daily.insertMany",
            json!({"documentsHex":hex,"optionsHex":wire(&doc!{"ordered":false})}),
        )?;
    }
    Ok(())
}
fn replay(
    record: &Value,
    calls: &mut Vec<Value>,
    app: &CountClock,
    middleware: &CountClock,
) -> Result<Option<&'static str>, ReplayError> {
    let input = &record["input"];
    if record["op"] == "rebuild" {
        let channel = fixture_string(property(input, "channelID").unwrap());
        let customer = fixture_string(property(input, "customerId").unwrap());
        let tier = RetentionTier::from_value(&fixture_value(property(input, "tier").unwrap()));
        replay_rebuild(
            record,
            calls,
            &channel,
            &customer,
            tier,
            fixture_date(property(input, "from").unwrap()),
            fixture_date(property(input, "to").unwrap()),
            app,
            middleware,
        )?;
        return Ok(None);
    }
    let row = fixture_value(property(input, "receipt").unwrap());
    let channel = match row.get("channelID").unwrap() {
        JsonValue::String(v) => v,
        _ => panic!(),
    };
    let customer = match row.get("customerId").unwrap() {
        JsonValue::String(v) => v,
        _ => panic!(),
    };
    let tier = RetentionTier::from_value(&fixture_value(property(input, "tier").unwrap()));
    call(
        calls,
        record,
        "dashboard.updateMany",
        json!({"filterHex":wire(&doc!{"channelID":channel.to_utf8_lossy(),"customerId":customer.to_utf8_lossy()}),"updateHex":wire(&doc!{"$set":{"dirty":true}}),"optionsHex":wire(&Document::new())}),
    )?;
    let document = policy::receipt_document(&row, tier)?;
    let now = app.now();
    if matches!((document.expires_at.timestamp_millis(),now.timestamp_millis()),(Some(exp),Some(now))if exp<=now)
    {
        return Ok(Some("expired"));
    }
    let upsert = policy::receipt_upsert(&row, &document, middleware.now())?;
    call(
        calls,
        record,
        "receipt.updateOne",
        json!({"filterHex":wire(&upsert.filter),"updateHex":wire(&upsert.update),"optionsHex":wire(&doc!{"upsert":true})}),
    )?;
    let occurred = match row.get("occurredAt").unwrap() {
        JsonValue::String(v) => v,
        _ => panic!(),
    };
    let mut slice = occurred.slice(0, 10).units();
    slice.extend("T00:00:00.000Z".encode_utf16());
    let ms = dima_rust::utils::js_date::parse_date_utf16(&slice);
    let from = ms.map_or(JsDate::invalid(), date);
    let to = JsDate::from_millis(
        from.timestamp_millis()
            .map_or(f64::NAN, |v| v as f64 + (DAY - 1) as f64),
    );
    replay_rebuild(
        record, calls, channel, customer, tier, from, to, app, middleware,
    )?;
    Ok(Some(if record["duplicate"] == true {
        "duplicate"
    } else {
        "inserted"
    }))
}

#[test]
#[ignore = "complete pinned external actual-source fixture required; never execute Node from Rust tests"]
fn complete_actual_source_replay() {
    let fixture = fixture();
    let mut seen = std::collections::HashSet::new();
    for record in fixture["records"].as_array().unwrap() {
        let id = record["id"].as_str().unwrap();
        assert!(seen.insert(id));
        let app = CountClock::new(JsDate::from_millis(f64_value(&record["now"])));
        let middleware = CountClock::new(JsDate::from_millis(f64_value(&record["middlewareNow"])));
        let mut calls = Vec::new();
        let outcome = replay(record, &mut calls, &app, &middleware);
        assert_eq!(json!(calls), record["calls"], "wire/order {id}");
        assert_eq!(
            app.reads(),
            record["appReads"].as_array().unwrap().len(),
            "app clock {id}"
        );
        assert_eq!(
            middleware.reads(),
            record["middlewareReads"].as_array().unwrap().len(),
            "middleware clock {id}"
        );
        match outcome {
            Ok(result) => {
                assert!(
                    record["error"].is_null(),
                    "expected source error {id}: {}",
                    record["error"]
                );
                match result {
                    Some(value) => assert_eq!(
                        fixture_string(&record["result"]).as_str(),
                        Some(value),
                        "outcome {id}"
                    ),
                    None => assert_eq!(record["result"], json!({"$undefined":true})),
                }
            }
            Err(e) => {
                assert_eq!(record["error"]["name"], e.name, "error class {id}");
                assert_eq!(record["error"]["path"], json!(e.path), "error path {id}");
                assert_eq!(record["error"]["code"], json!(e.code), "error code {id}");
            }
        }
    }
    assert_eq!(
        seen.len(),
        fixture["metadata"]["caseCount"].as_u64().unwrap() as usize
    );
}

fn guarded_resources() -> (String, String, String, String) {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").unwrap(),
        "dimabot-migration"
    );
    let mongo = std::env::var("DIMA_TEST_MONGO_URI").unwrap();
    assert_eq!(mongo, "mongodb://ai-ledger-persistence-mongo-fixture:27017");
    let redis = std::env::var("DIMA_TEST_REDIS_URI").unwrap();
    assert_eq!(redis, "redis://ai-ledger-persistence-redis-fixture:6379/");
    let token = std::env::var("DIMA_AI_LEDGER_PERSISTENCE_RESOURCE_TOKEN").unwrap();
    assert!(
        (8..=32).contains(&token.len())
            && token
                .bytes()
                .all(|v| v.is_ascii_lowercase() || v.is_ascii_digit())
    );
    let db = std::env::var("DIMA_AI_LEDGER_PERSISTENCE_TEST_DATABASE").unwrap();
    assert_eq!(db, format!("ai_ledger_persistence_test_{token}"));
    (mongo, redis, db, token)
}
async fn assert_owned(db: &Database, token: &str) {
    let marker = db
        .collection::<Document>("_persistence_owner")
        .find_one(doc! {"_id":"owner"})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(marker.get_str("owner").unwrap(), "dimabot-migration");
    assert_eq!(marker.get_str("token").unwrap(), token);
    assert_eq!(db.name(), format!("ai_ledger_persistence_test_{token}"));
}
async fn wait_event(events: &Arc<Mutex<Vec<(String, Document)>>>, start: usize, kind: &str) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if events.lock().unwrap()[start..]
                .iter()
                .any(|(n, _)| n == kind)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

async fn private_unsupported_expiry_sentinels(
    service: &MongoAiUsageLedgerPersistence,
    cache: &mut redis::aio::ConnectionManager,
    events: &Arc<Mutex<Vec<(String, Document)>>>,
    channel: &JsString,
    customer: &JsString,
    receipt: &JsonValue,
) {
    // The caller already validated the fresh server aliases, empty database,
    // Redis size and ownership marker. This helper uses only its supplied
    // task-owned collections and the same exact derived account lease key.
    let identity = doc! {"channelID":channel.to_utf8_lossy(),"customerId":customer.to_utf8_lossy()};
    let account_key = ai_usage_lock::account_key(channel, customer);
    let future = Bson::DateTime(DateTime::from_millis(NOW + 60 * DAY));
    let expression = Bson::RegularExpression(mongodb::bson::Regex {
        pattern: "a".into(),
        options: "i".into(),
    });
    let cases = [
        ("date", Bson::Array(vec![future.clone()])),
        // The top-level Date ensures this receipt really matches Mongo's
        // Date range, without assuming recursive query matching for [[Date]].
        // The first array element still exercises nested expiry projection.
        (
            "nested-date",
            Bson::Array(vec![Bson::Array(vec![future.clone()]), future.clone()]),
        ),
        (
            "regexp-date",
            Bson::Array(vec![expression.clone(), future.clone()]),
        ),
        ("date-regexp", Bson::Array(vec![future, expression])),
    ];
    for (label, expiry) in cases {
        let legacy_id = format!("guard-legacy-{label}");
        let new_id = format!("guard-insert-{label}");
        let mut legacy = identity.clone();
        legacy.extend(doc! {
            "entryId":&legacy_id,"occurredAt":DateTime::from_millis(NOW),
            "entryKind":"usage","category":"legacy-expiry-guard","credits":3,
            "expiresAt":expiry.clone()
        });
        // Bypass Mongoose/native schema casting so this remains a malformed
        // legacy BSON array; ordinary receipt creation would cast it to Date.
        service
            .receipt_collection()
            .insert_one(legacy)
            .await
            .unwrap();
        let query = policy::daily_rebuild_query(channel, customer, date(NOW), date(NOW), date(NOW))
            .unwrap();
        let groups = service
            .receipt_collection()
            .aggregate(query.pipeline)
            .await
            .unwrap()
            .try_collect::<Vec<_>>()
            .await
            .unwrap();
        let legacy_group = groups
            .iter()
            .find(|group| {
                group
                    .get_document("_id")
                    .ok()
                    .and_then(|id| id.get_str("category").ok())
                    == Some("legacy-expiry-guard")
            })
            .expect("raw legacy receipt must actually match the real aggregate");
        assert_eq!(
            legacy_group.get("expiresAt"),
            Some(&expiry),
            "Mongo $max preserves the legacy array: {label}"
        );

        let mut sentinel_filter = identity.clone();
        sentinel_filter.insert("date", "2026-10-29");
        assert_eq!(
            service
                .daily_collection()
                .update_one(sentinel_filter, doc! {"$set":{"guardSentinel":label}})
                .await
                .unwrap()
                .matched_count,
            1
        );
        let before = service
            .daily_collection()
            .find(identity.clone())
            .sort(doc! {"date":1})
            .await
            .unwrap()
            .try_collect::<Vec<_>>()
            .await
            .unwrap();
        let before_bytes = before.iter().map(wire).collect::<Vec<_>>();
        assert!(!before_bytes.is_empty());
        service
            .dashboard_collection()
            .update_many(identity.clone(), doc! {"$set":{"dirty":false}})
            .await
            .unwrap();
        let mut new_receipt = receipt.clone();
        set(
            &mut new_receipt,
            "id",
            JsonValue::String(new_id.as_str().into()),
        );
        let begin = events.lock().unwrap().len();
        let result = service.persist_value(&new_receipt, &JsonValue::Null).await;
        let commands = events.lock().unwrap()[begin..].to_vec();
        assert!(
            matches!(
                result,
                Err(AiUsageLockError::Callback(
                    AiUsagePersistenceError::UnsupportedLegacy {
                        path: "expiresAt",
                        ..
                    }
                ))
            ),
            "native support boundary: {label}"
        );
        assert_eq!(
            commands.iter().filter(|(name, _)| name == "update").count(),
            2,
            "dirtying and receipt upsert both precede the guard: {label}"
        );
        assert_eq!(
            commands
                .iter()
                .filter(|(name, _)| name == "aggregate")
                .count(),
            1
        );
        assert!(
            !commands
                .iter()
                .any(|(name, _)| name == "delete" || name == "insert"),
            "no destructive replacement after unsupported projection: {label}"
        );
        let mut new_filter = identity.clone();
        new_filter.insert("entryId", &new_id);
        assert_eq!(
            service
                .receipt_collection()
                .count_documents(new_filter)
                .await
                .unwrap(),
            1,
            "preceding upsert stays visible: {label}"
        );
        assert!(
            service
                .dashboard_collection()
                .find_one(identity.clone())
                .await
                .unwrap()
                .unwrap()
                .get_bool("dirty")
                .unwrap()
        );
        let after = service
            .daily_collection()
            .find(identity.clone())
            .sort(doc! {"date":1})
            .await
            .unwrap()
            .try_collect::<Vec<_>>()
            .await
            .unwrap();
        assert_eq!(
            after.iter().map(wire).collect::<Vec<_>>(),
            before_bytes,
            "all existing daily documents remain byte-identical: {label}"
        );
        let lease: Option<String> = redis::cmd("GET")
            .arg(&account_key)
            .query_async(cache)
            .await
            .unwrap();
        assert!(
            lease.is_none(),
            "callback rejection releases its real lease: {label}"
        );

        // The reusable rebuild entrypoint must reject the same real aggregate
        // before any daily mutation when called under an existing real lease.
        let begin = events.lock().unwrap().len();
        let result = AiUsageLock::new(cache.clone())
            .with(channel, customer, || {
                service.rebuild_utc_daily_aggregates(
                    channel,
                    customer,
                    RetentionTier::Free,
                    date(NOW),
                    date(NOW),
                )
            })
            .await;
        let commands = events.lock().unwrap()[begin..].to_vec();
        assert!(matches!(
            result,
            Err(AiUsageLockError::Callback(
                AiUsagePersistenceError::UnsupportedLegacy {
                    path: "expiresAt",
                    ..
                }
            ))
        ));
        assert_eq!(
            commands
                .iter()
                .filter(|(name, _)| name == "aggregate")
                .count(),
            1
        );
        assert!(
            !commands
                .iter()
                .any(|(name, _)| matches!(name.as_str(), "update" | "delete" | "insert"))
        );
        let after = service
            .daily_collection()
            .find(identity.clone())
            .sort(doc! {"date":1})
            .await
            .unwrap()
            .try_collect::<Vec<_>>()
            .await
            .unwrap();
        assert_eq!(after.iter().map(wire).collect::<Vec<_>>(), before_bytes);
        let lease: Option<String> = redis::cmd("GET")
            .arg(&account_key)
            .query_async(cache)
            .await
            .unwrap();
        assert!(lease.is_none());

        let mut cleanup = identity.clone();
        cleanup.insert("entryId", doc! {"$in":[legacy_id,new_id]});
        assert_eq!(
            service
                .receipt_collection()
                .delete_many(cleanup)
                .await
                .unwrap()
                .deleted_count,
            2
        );
    }
}

#[tokio::test]
#[ignore = "fresh owned Mongo enableTestCommands=1 + Dragonfly only; exact aliases and marker required"]
async fn private_mongo_and_real_redis_persistence_protocol() {
    use mongodb::{
        event::{EventHandler, cmap::CmapEvent, command::CommandEvent},
        options::ClientOptions,
    };
    use std::panic::AssertUnwindSafe;
    let (mongo_uri, redis_uri, name, token) = guarded_resources();
    let events = Arc::new(Mutex::new(Vec::<(String, Document)>::new()));
    let observed = events.clone();
    let pools = Arc::new(AtomicUsize::new(0));
    let observed_pools = pools.clone();
    let mut options = ClientOptions::parse(&mongo_uri).await.unwrap();
    options.direct_connection = Some(true);
    options.retry_writes = Some(false);
    options.retry_reads = Some(false);
    options.max_pool_size = Some(4);
    options.command_event_handler = Some(EventHandler::callback(move |e: CommandEvent| {
        if let CommandEvent::Started(e) = e {
            observed.lock().unwrap().push((e.command_name, e.command));
        }
    }));
    options.cmap_event_handler = Some(EventHandler::callback(move |e: CmapEvent| {
        if matches!(e, CmapEvent::PoolCreated(_)) {
            observed_pools.fetch_add(1, Ordering::SeqCst);
        }
    }));
    let client = Client::with_options(options).unwrap();
    let db = client.database(&name);
    let admin = client.database("admin");
    let existing = client.list_database_names().await.unwrap();
    assert!(
        existing
            .iter()
            .all(|name| matches!(name.as_str(), "admin" | "config" | "local")),
        "server-wide failCommand requires a fresh private Mongo server"
    );
    assert!(
        db.list_collection_names().await.unwrap().is_empty(),
        "fresh database only"
    );
    let redis_client = redis::Client::open(redis_uri).unwrap();
    let mut cache = redis_client.get_connection_manager().await.unwrap();
    let redis_size: i64 = redis::cmd("DBSIZE").query_async(&mut cache).await.unwrap();
    assert_eq!(redis_size, 0, "fresh private Redis server only");
    db.collection::<Document>("_persistence_owner")
        .insert_one(doc! {"_id":"owner","owner":"dimabot-migration","token":&token})
        .await
        .unwrap();
    let channel = JsString::from(format!("persistence_{token}"));
    let customer = JsString::from(format!("customer_{token}"));
    let key = ai_usage_lock::account_key(&channel, &customer);
    let test_key = ai_usage_lock::account_key(&JsString::from(format!("panic_{token}")), &customer);
    let result=AssertUnwindSafe(async{
        assert_owned(&db,&token).await;
        let app=CountClock::new(date(NOW));let middleware=CountClock::new(date(NOW+11));
        let service=MongoAiUsageLedgerPersistence::with_clocks(&db,cache.clone(),Arc::new(app.clone()),Arc::new(middleware.clone()));let sibling=service.clone();
        assert_eq!(app.reads(),0);assert_eq!(middleware.reads(),0);
        assert_eq!(db.list_collection_names().await.unwrap(),vec!["_persistence_owner"]);
        let mut row=receipt();set(&mut row,"channelID",JsonValue::String(channel.clone()));set(&mut row,"customerId",JsonValue::String(customer.clone()));
        // Test fixture creates exact source indexes explicitly. Constructor
        // never installs them; application adoption must own that operation.
        dima_rust::schemas::ai_usage_receipt::schema().install_indexes(&db).await.unwrap();
        dima_rust::schemas::ai_usage_daily::schema().install_indexes(&db).await.unwrap();
        let before=service.receipt_collection().list_indexes().await.unwrap().try_collect::<Vec<_>>().await.unwrap();
        service.dashboard_collection().insert_one(doc!{"channelID":channel.to_utf8_lossy(),"customerId":customer.to_utf8_lossy(),"dirty":false}).await.unwrap();
        assert_eq!(service.persist_value(&row,&JsonValue::Null).await.unwrap(),PersistAiUsageReceiptOutcome::Inserted);
        assert_eq!(sibling.persist_value(&row,&JsonValue::String("pro".into())).await.unwrap(),PersistAiUsageReceiptOutcome::Duplicate);
        assert_eq!(service.receipt_collection().count_documents(doc!{}).await.unwrap(),1);
        let stored=service.receipt_collection().find_one(doc!{}).await.unwrap().unwrap();assert_eq!(stored.get_str("retentionTier").unwrap(),"free");
        assert_eq!(stored.get_datetime("created_at").unwrap().timestamp_millis(),NOW+11);assert_eq!(stored.get("requestId"),Some(&Bson::Null));
        let daily=service.daily_collection().find_one(doc!{}).await.unwrap().unwrap();assert_eq!(numeric(&daily,"spentCredits"),2.0);
        // A prior crash can leave a receipt without its daily row. Duplicate
        // processing repairs it instead of early-returning on upsertCount=0.
        service.daily_collection().delete_many(doc!{}).await.unwrap();
        assert_eq!(sibling.persist_value(&row,&JsonValue::Null).await.unwrap(),PersistAiUsageReceiptOutcome::Duplicate);assert_eq!(service.daily_collection().count_documents(doc!{}).await.unwrap(),1);
        let mut expired=row.clone();set(&mut expired,"id",JsonValue::String("expired".into()));set(&mut expired,"occurredAt",JsonValue::String(date(NOW-30*DAY).to_iso_string().unwrap().as_str().into()));
        assert_eq!(service.persist_value(&expired,&JsonValue::Null).await.unwrap(),PersistAiUsageReceiptOutcome::Expired);assert_eq!(service.receipt_collection().count_documents(doc!{}).await.unwrap(),1);
        assert!(service.dashboard_collection().find_one(doc!{}).await.unwrap().unwrap().get_bool("dirty").unwrap());
        // Source day is occurredAt.slice(0,10), even when its explicit offset
        // puts the actual UTC occurrence on the preceding day.
        let mut offset=row.clone();set(&mut offset,"id",JsonValue::String("offset".into()));set(&mut offset,"occurredAt",JsonValue::String("2026-10-29T01:00:00+05:00".into()));
        assert_eq!(service.persist_value(&offset,&JsonValue::Null).await.unwrap(),PersistAiUsageReceiptOutcome::Inserted);
        assert!(service.daily_collection().find_one(doc!{"date":"2026-10-28"}).await.unwrap().is_none());
        service.rebuild_utc_daily_aggregates(&channel,&customer,RetentionTier::Free,date(NOW-DAY),date(NOW)).await.unwrap();
        assert_eq!(numeric(&service.daily_collection().find_one(doc!{"date":"2026-10-28"}).await.unwrap().unwrap(),"spentCredits"),2.0);
        // Actual source cases occurred-117/rebuild-boundary-199 accept this
        // sliced extended year/month. Check the real requested day range.
        let mut extended=row.clone();set(&mut extended,"id",JsonValue::String("extended".into()));set(&mut extended,"occurredAt",JsonValue::String("+010000-01-01T12:00:00.000Z".into()));
        let begin=events.lock().unwrap().len();
        assert_eq!(service.persist_value(&extended,&JsonValue::Null).await.unwrap(),PersistAiUsageReceiptOutcome::Inserted);
        let commands=events.lock().unwrap()[begin..].to_vec();
        let command=&commands.iter().find(|(name,_)|name=="aggregate").unwrap().1;
        let matching=command.get_array("pipeline").unwrap()[0].as_document().unwrap().get_document("$match").unwrap().get_document("occurredAt").unwrap();
        assert_eq!(matching.get_datetime("$gte").unwrap().timestamp_millis(),253_402_300_800_000);
        assert_eq!(matching.get_datetime("$lte").unwrap().timestamp_millis(),253_402_387_199_999);
        assert_eq!(service.receipt_collection().count_documents(doc!{"entryId":"extended"}).await.unwrap(),1);
        service.receipt_collection().delete_one(doc!{"entryId":"extended"}).await.unwrap();
        service.daily_collection().delete_many(doc!{"channelID":channel.to_utf8_lossy(),"customerId":customer.to_utf8_lossy(),"dayStart":{"$gte":DateTime::from_millis(253_402_300_800_000),"$lte":DateTime::from_millis(253_402_387_199_999)}}).await.unwrap();
        // An aggregate failure after a new receipt is saved leaves that write
        // intact. The next duplicate rebuild repairs it with no second receipt.
        let mut repair=row.clone();set(&mut repair,"id",JsonValue::String("repair".into()));
        admin.run_command(doc!{"configureFailPoint":"failCommand","mode":{"times":1},"data":{"failCommands":["aggregate"],"errorCode":12345}}).await.unwrap();
        assert!(service.persist_value(&repair,&JsonValue::Null).await.is_err());
        admin.run_command(doc!{"configureFailPoint":"failCommand","mode":"off"}).await.unwrap();
        assert_eq!(service.receipt_collection().count_documents(doc!{"entryId":"repair"}).await.unwrap(),1);
        assert_eq!(service.persist_value(&repair,&JsonValue::Null).await.unwrap(),PersistAiUsageReceiptOutcome::Duplicate);
        assert_eq!(numeric(&service.daily_collection().find_one(doc!{"date":"2026-10-29"}).await.unwrap().unwrap(),"spentCredits"),4.0);
        private_unsupported_expiry_sentinels(&service,&mut cache,&events,&channel,&customer,&row).await;
        // Concurrent sibling callers share Mongo pools and real owner leases.
        let(a,b)=tokio::join!(service.persist_value(&row,&JsonValue::Null),sibling.persist_value(&row,&JsonValue::Null));assert_eq!(a.unwrap(),PersistAiUsageReceiptOutcome::Duplicate);assert_eq!(b.unwrap(),PersistAiUsageReceiptOutcome::Duplicate);
        let remaining:Option<String>=redis::cmd("GET").arg(&key).query_async(&mut cache).await.unwrap();assert!(remaining.is_none());
        // Callback CastError is observable after dirtying and releases lease.
        let mut nan=row.clone();set(&mut nan,"quantity",JsonValue::Number(f64::NAN));
        assert!(matches!(service.persist_value(&nan,&JsonValue::Null).await,Err(AiUsageLockError::Callback(AiUsagePersistenceError::CastError{path:"quantity"}))));
        let remaining:Option<String>=redis::cmd("GET").arg(&key).query_async(&mut cache).await.unwrap();assert!(remaining.is_none());
        // failCommand is server-wide and is legal only on this fresh private
        // fixture. Stop after the selected write; no application retry occurs.
        for (command,skip) in [("update",0),("update",1),("aggregate",0),("delete",0),("insert",0)]{
            admin.run_command(doc!{"configureFailPoint":"failCommand","mode":{"skip":skip},"data":{"failCommands":[command],"errorCode":12345}}).await.unwrap();
            let begin=events.lock().unwrap().len();assert!(service.persist_value(&row,&JsonValue::Null).await.is_err());
            assert_eq!(events.lock().unwrap()[begin..].iter().filter(|(n,_)|n==command).count(),skip as usize+1);
            admin.run_command(doc!{"configureFailPoint":"failCommand","mode":"off"}).await.unwrap();
        }
        // Uncertain insert disconnect is surfaced without retry; receipt may
        // already exist and daily replacement may be incomplete.
        admin.run_command(doc!{"configureFailPoint":"failCommand","mode":{"times":1},"data":{"failCommands":["update"],"closeConnection":true}}).await.unwrap();
        let begin=events.lock().unwrap().len();assert!(service.persist_value(&row,&JsonValue::Null).await.is_err());assert_eq!(events.lock().unwrap()[begin..].iter().filter(|(n,_)|n=="update").count(),1);
        admin.run_command(doc!{"configureFailPoint":"failCommand","mode":"off"}).await.unwrap();
        // Cancellation while update is in flight retains the TTL, no unlock
        // that would permit an overlapping uncertain Mongo operation.
        admin.run_command(doc!{"configureFailPoint":"failCommand","mode":{"times":1},"data":{"failCommands":["update"],"blockConnection":true,"blockTimeMS":1200}}).await.unwrap();
        let begin=events.lock().unwrap().len();let pending={let service=service.clone();let row=row.clone();tokio::spawn(async move{service.persist_value(&row,&JsonValue::Null).await})};
        wait_event(&events,begin,"update").await;pending.abort();assert!(pending.await.unwrap_err().is_cancelled());
        let ttl:i64=redis::cmd("TTL").arg(&key).query_async(&mut cache).await.unwrap();assert!((1..=120).contains(&ttl));
        // Wait for the server-side blocked operation to settle before removing
        // this exact owned lease. This test wait is not application pacing.
        tokio::time::sleep(Duration::from_millis(1500)).await;
        admin.run_command(doc!{"configureFailPoint":"failCommand","mode":"off"}).await.unwrap();
        redis::cmd("DEL").arg(&key).query_async::<i64>(&mut cache).await.unwrap();
        let panic_channel=JsString::from(format!("panic_{token}"));
        let panic=AssertUnwindSafe(AiUsageLock::new(cache.clone()).with(&panic_channel,&customer,||async{panic!("fixture callback panic");#[allow(unreachable_code)]Ok::<(),std::io::Error>(())})).catch_unwind().await;
        assert!(panic.is_err());let ttl:i64=redis::cmd("TTL").arg(&test_key).query_async(&mut cache).await.unwrap();assert!((1..=120).contains(&ttl));
        let after=service.receipt_collection().list_indexes().await.unwrap().try_collect::<Vec<_>>().await.unwrap();assert_eq!(format!("{before:?}"),format!("{after:?}"));
        assert_eq!(pools.load(Ordering::SeqCst),1,"clones share the supplied Mongo pool");
    }).catch_unwind().await;
    // Cleanup also runs when assertions panic. Never broad Redis scan/delete,
    // dropDatabase or failpoint changes against any other named resource.
    assert_owned(&db, &token).await;
    admin
        .run_command(doc! {"configureFailPoint":"failCommand","mode":"off"})
        .await
        .unwrap();
    redis::cmd("DEL")
        .arg(&key)
        .arg(&test_key)
        .query_async::<i64>(&mut cache)
        .await
        .unwrap();
    assert_eq!(
        redis::cmd("DBSIZE")
            .query_async::<i64>(&mut cache)
            .await
            .unwrap(),
        redis_size
    );
    db.drop().await.unwrap();
    client.shutdown().await;
    if let Err(panic) = result {
        std::panic::resume_unwind(panic)
    }
}

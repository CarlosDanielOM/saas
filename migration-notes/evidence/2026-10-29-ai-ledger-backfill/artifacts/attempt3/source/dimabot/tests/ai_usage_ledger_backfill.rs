#![cfg(feature = "ai-usage-ledger-backfill")]
//! Author-only draft. Run only through the parent's capped isolated workflow.
use dima_rust::utils::{
    ai_usage_ledger_backfill::{
        self as backfill, AiUsageBackfillError, AiUsageLedgerBackfillInput,
        MongoAiUsageLedgerBackfill,
    },
    ai_usage_ledger_persistence::{self as policy, AiUsagePersistenceError},
    ai_usage_lock::{self, AiUsageLock, AiUsageLockError},
    ai_usage_producer::{FixedReceiptClock, ReceiptClock, build_queued_ai_usage_receipt_at},
    ai_usage_receipt_parser::RetentionTier,
    credit_policy::JsDate,
    js_string::JsString,
    lossless_json::JsonValue,
};
use futures_util::FutureExt;
use mongodb::{
    Client, Database,
    bson::{Bson, Document, doc},
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
        *v = value
    } else {
        fields.push((key.into(), value));
    }
}
fn input(rows: Vec<JsonValue>) -> AiUsageLedgerBackfillInput {
    AiUsageLedgerBackfillInput {
        channel_id: "channel".into(),
        customer_id: "customer".into(),
        plan_tier: JsonValue::Null,
        coverage_start: date(NOW - 10 * DAY),
        rebuild_start: None,
        transactions: rows,
        now: None,
    }
}
fn numeric(doc: &Document, key: &str) -> f64 {
    match doc.get(key).unwrap() {
        Bson::Int32(v) => f64::from(*v),
        Bson::Int64(v) => *v as f64,
        Bson::Double(v) => *v,
        _ => panic!("numeric {key}"),
    }
}
#[derive(Clone)]
struct CountClock {
    value: JsDate,
    count: Arc<AtomicUsize>,
    sequence: Arc<Vec<JsDate>>,
}
impl CountClock {
    fn new(value: JsDate) -> Self {
        Self {
            value,
            count: Arc::new(AtomicUsize::new(0)),
            sequence: Arc::new(vec![]),
        }
    }
    fn sequence(value: JsDate, sequence: Vec<JsDate>) -> Self {
        Self {
            value,
            count: Arc::new(AtomicUsize::new(0)),
            sequence: Arc::new(sequence),
        }
    }
    fn reads(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }
}
impl ReceiptClock for CountClock {
    fn now(&self) -> JsDate {
        let i = self.count.fetch_add(1, Ordering::SeqCst);
        self.sequence.get(i).copied().unwrap_or(self.value)
    }
}
fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn fixture() -> Value {
    let output = std::env::var("DIMA_AI_LEDGER_BACKFILL_REFERENCE_DIR")
        .expect("external source fixture directory");
    let output = Path::new(&output).canonicalize().unwrap();
    let base = Path::new(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    assert!(!output.starts_with(base.parent().unwrap()));
    let bytes = std::fs::read(output.join("ai_usage_ledger_backfill_reference.json")).unwrap();
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
    assert_eq!(m["driverBsonOptions"]["ignoreUndefined"], false);
    assert_eq!(m["driverUndefinedProbeHex"], "0c0000000a76616c75650000");
    let node = std::env::var("DIMA_AI_LEDGER_BACKFILL_NODE_BINARY")
        .expect("explicit pinned Node binary for hash only");
    assert_eq!(m["nodeSha256"], hash(std::fs::read(node).unwrap()));
    let dep = std::env::var("DIMA_AI_LEDGER_BACKFILL_NODE_DEPENDENCY_ROOT")
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
        ("extractedSha256", "ai_usage_ledger_backfill_extracted.ts"),
        ("typecheckSha256", "ai_usage_ledger_backfill_typecheck.ts"),
        ("compiledSha256", "ai_usage_ledger_backfill_compiled.cjs"),
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
        ("backfillAiUsageLedger", true),
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
    assert!(records.len() > 250);
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
    let selected_batch = kind != "receipt.bulkWrite"
        || calls.iter().filter(|call| call["kind"] == kind).count() - 1
            == record["failBatch"].as_u64().unwrap_or(0) as usize;
    if record["fail"] == kind && selected_batch {
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
) -> Result<(), ReplayError> {
    let raw = &record["input"];
    let get = |key| property(raw, key).unwrap();
    let optional_date = |key| {
        property(raw, key)
            .filter(|v| v.get("$undefined").is_none() && !v.is_null())
            .map(fixture_date)
    };
    let input = AiUsageLedgerBackfillInput {
        channel_id: fixture_string(get("channelID")),
        customer_id: fixture_string(get("customerId")),
        plan_tier: fixture_value(get("planTier")),
        coverage_start: fixture_date(get("coverageStart")),
        rebuild_start: optional_date("rebuildStart"),
        now: optional_date("now"),
        transactions: get("transactions")["$array"]
            .as_array()
            .unwrap()
            .iter()
            .map(fixture_value)
            .collect(),
    };
    let account = doc! {"channelID":input.channel_id.to_utf8_lossy(),"customerId":input.customer_id.to_utf8_lossy()};
    call(
        calls,
        record,
        "dashboard.updateMany",
        json!({"filterHex":wire(&account),"updateHex":wire(&doc!{"$set":{"dirty":true}}),"optionsHex":wire(&Document::new())}),
    )?;
    let now = input.now.unwrap_or_else(|| app.now());
    let tier = RetentionTier::from_value(&input.plan_tier);
    let rows = backfill::filter_backfill_receipts(&input, now)?;
    for rows in rows.chunks(backfill::BACKFILL_BATCH_SIZE) {
        let batch = backfill::prepare_backfill_batch(rows, tier, middleware)?;
        if !batch.operations.is_empty() {
            let operations = batch
                .operations
                .into_iter()
                .map(|op| {
                    wire(&doc! {"updateOne":{"filter":op.filter,"update":op.update,"upsert":true}})
                })
                .collect::<Vec<_>>();
            call(
                calls,
                record,
                "receipt.bulkWrite",
                json!({"operationsHex":operations,"optionsHex":wire(&doc!{"ordered":false})}),
            )?;
        }
    }
    replay_rebuild(
        record,
        calls,
        &input.channel_id,
        &input.customer_id,
        tier,
        input.rebuild_start.unwrap_or(input.coverage_start),
        now,
        app,
        middleware,
    )?;
    let state = backfill::backfill_state_upsert(&input, now, middleware.now())?;
    call(
        calls,
        record,
        "state.findOneAndUpdate",
        json!({"filterHex":wire(&state.filter),"updateHex":wire(&state.update),"optionsHex":wire(&doc!{"upsert":true})}),
    )?;
    Ok(())
}

#[test]
#[ignore = "complete pinned external actual-source corpus required; never execute Node from Rust tests"]
fn complete_actual_source_replay() {
    let fixture = fixture();
    let mut seen = std::collections::HashSet::new();
    for record in fixture["records"].as_array().unwrap() {
        let id = record["id"].as_str().unwrap();
        assert!(seen.insert(id));
        let app = CountClock::new(JsDate::from_millis(f64_value(&record["now"])));
        let sequence = record["middlewareSequence"]
            .as_array()
            .map(|v| {
                v.iter()
                    .map(|v| JsDate::from_millis(f64_value(v)))
                    .collect()
            })
            .unwrap_or_default();
        let middleware = CountClock::sequence(
            JsDate::from_millis(f64_value(&record["middlewareNow"])),
            sequence,
        );
        let mut calls = Vec::new();
        let outcome = replay(record, &mut calls, &app, &middleware);
        assert_eq!(json!(calls), record["calls"], "wire/order {id}");
        assert_eq!(
            app.reads(),
            record["appReads"].as_array().unwrap().len(),
            "application clock {id}"
        );
        assert_eq!(
            middleware.reads(),
            record["middlewareReads"].as_array().unwrap().len(),
            "middleware clock {id}"
        );
        assert_eq!(
            record["lockCalls"],
            json!({"$array":[{"$array":[get_encoded(&record["input"],"channelID"),get_encoded(&record["input"],"customerId")]}]}),
            "lossless lock boundary {id}"
        );
        match outcome {
            Ok(()) => {
                assert!(
                    record["error"].is_null(),
                    "source rejected {id}: {}",
                    record["error"]
                );
                assert_eq!(record["result"], json!({"$undefined":true}));
                assert_eq!(record["events"], json!(["resolved"]));
            }
            Err(e) => {
                assert_eq!(record["error"]["name"], e.name, "error name {id}");
                assert_eq!(record["error"]["path"], json!(e.path), "error path {id}");
                assert_eq!(record["error"]["code"], json!(e.code), "error code {id}");
                assert_eq!(record["events"], json!(["rejected"]));
            }
        }
    }
    assert_eq!(
        seen.len(),
        fixture["metadata"]["caseCount"].as_u64().unwrap() as usize
    );
}
fn get_encoded<'a>(value: &'a Value, key: &str) -> &'a Value {
    property(value, key).unwrap()
}

#[test]
fn floor_is_inclusive_and_account_overrides_stay_lossless_until_bson() {
    let mut rows = vec![];
    for offset in [-30 * DAY - 1, -30 * DAY, -30 * DAY + 1] {
        let mut row = receipt();
        set(
            &mut row,
            "occurredAt",
            JsonValue::String(date(NOW + offset).to_iso_string().unwrap().as_str().into()),
        );
        set(
            &mut row,
            "channelID",
            JsonValue::String("overridden".into()),
        );
        rows.push(row);
    }
    rows.extend([JsonValue::Null, JsonValue::Bool(false)]);
    let mut input = input(rows);
    input.channel_id = JsString::from_units(vec![0xd800]);
    let rows = backfill::filter_backfill_receipts(&input, date(NOW)).unwrap();
    assert_eq!(
        rows.iter().map(|r| r.transaction_index).collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(
        rows[0].value.get("channelID"),
        Some(&JsonValue::String(input.channel_id.clone()))
    );
    assert_ne!(
        ai_usage_lock::account_key(&input.channel_id, &input.customer_id),
        ai_usage_lock::account_key(&JsString::from_units(vec![0xdc00]), &input.customer_id)
    );
    let batch =
        backfill::prepare_backfill_batch(&rows, RetentionTier::Free, &FixedReceiptClock(date(NOW)))
            .unwrap();
    assert_eq!(
        batch.operations[0].filter.get_str("channelID").unwrap(),
        "�"
    );
    assert!(
        backfill::filter_backfill_receipts(&input, JsDate::invalid())
            .unwrap()
            .is_empty()
    );
}
#[test]
fn batches_bound_work_without_sleeping_and_invalid_ops_consume_their_clock() {
    for count in [0, 499, 500, 501, 1001] {
        let input = input((0..count).map(|_| receipt()).collect());
        let rows = backfill::filter_backfill_receipts(&input, date(NOW)).unwrap();
        assert_eq!(
            rows.chunks(500).map(|c| c.len()).collect::<Vec<_>>(),
            match count {
                0 => vec![],
                499 => vec![499],
                500 => vec![500],
                501 => vec![500, 1],
                1001 => vec![500, 500, 1],
                _ => unreachable!(),
            }
        );
    }
    let mut invalid = receipt();
    set(&mut invalid, "quantity", JsonValue::Number(f64::NAN));
    let rows =
        backfill::filter_backfill_receipts(&input(vec![invalid, receipt()]), date(NOW)).unwrap();
    let clock = CountClock::sequence(date(0), vec![date(NOW + 1), date(NOW + 2)]);
    let batch = backfill::prepare_backfill_batch(&rows, RetentionTier::Free, &clock).unwrap();
    assert_eq!(clock.reads(), 2);
    assert_eq!(
        batch.skipped,
        vec![backfill::BulkCastFailure {
            index: 0,
            path: "quantity"
        }]
    );
    assert_eq!(batch.transaction_indices, vec![1]);
    assert_eq!(
        batch.operations[0]
            .update
            .get_document("$set")
            .unwrap()
            .get_datetime("updated_at")
            .unwrap()
            .timestamp_millis(),
        NOW + 2
    );
}
#[test]
fn bulk_defaults_and_duplicate_mutable_fields_differ_from_single_receipt_updates() {
    let row = receipt();
    let rows = backfill::filter_backfill_receipts(&input(vec![row]), date(NOW)).unwrap();
    let batch =
        backfill::prepare_backfill_batch(&rows, RetentionTier::Free, &FixedReceiptClock(date(NOW)))
            .unwrap();
    let update = &batch.operations[0].update;
    let insert = update.get_document("$setOnInsert").unwrap();
    for name in [
        "requestId",
        "model",
        "unit",
        "resourceType",
        "resourceId",
        "source",
        "adjustmentType",
    ] {
        assert!(
            !insert.contains_key(name),
            "missing remains missing: {name}"
        );
    }
    let keys = insert.keys().map(String::as_str).collect::<Vec<_>>();
    assert_eq!(&keys[keys.len() - 2..], &["created_at", "__v"]);
    assert_eq!(
        update.get_document("$set").unwrap().get("source"),
        Some(&Bson::Null)
    );
    assert_eq!(
        update.get_document("$set").unwrap().get("adjustmentType"),
        Some(&Bson::Null)
    );
    assert_eq!(insert.get_str("retentionTier").unwrap(), "free");
}
#[test]
fn malformed_scalars_use_query_casting_and_required_enum_validators_do_not_run() {
    let mut row = receipt();
    set(&mut row, "id", JsonValue::Number(17.0));
    set(&mut row, "quantity", JsonValue::String(" 2.5 ".into()));
    set(&mut row, "itemized", JsonValue::String("yes".into()));
    set(&mut row, "entryKind", JsonValue::String("legacy".into()));
    set(&mut row, "operation", JsonValue::String("".into()));
    let rows = backfill::filter_backfill_receipts(&input(vec![row]), date(NOW)).unwrap();
    let batch =
        backfill::prepare_backfill_batch(&rows, RetentionTier::Free, &FixedReceiptClock(date(NOW)))
            .unwrap();
    assert!(batch.skipped.is_empty());
    assert_eq!(batch.operations[0].filter.get_str("entryId").unwrap(), "17");
    let insert = batch.operations[0]
        .update
        .get_document("$setOnInsert")
        .unwrap();
    assert_eq!(numeric(insert, "quantity"), 2.5);
    assert!(insert.get_bool("itemized").unwrap());
    assert_eq!(insert.get_str("operation").unwrap(), "");
}
#[test]
fn all_invalid_bulk_resolves_locally_and_state_keeps_min_coverage_and_version_three() {
    let mut row = receipt();
    set(&mut row, "credits", JsonValue::Number(f64::NAN));
    let mut input = input(vec![row]);
    let rows = backfill::filter_backfill_receipts(&input, date(NOW)).unwrap();
    let clock = CountClock::new(JsDate::invalid());
    let batch = backfill::prepare_backfill_batch(&rows, RetentionTier::Free, &clock).unwrap();
    assert!(batch.operations.is_empty());
    assert_eq!(batch.skipped[0].path, "updated_at");
    let state = backfill::backfill_state_upsert(&input, date(NOW), date(NOW + 7)).unwrap();
    assert_eq!(
        state
            .update
            .get_document("$set")
            .unwrap()
            .get_i32("reportVersion")
            .unwrap(),
        3
    );
    assert_eq!(
        state
            .update
            .get_document("$min")
            .unwrap()
            .get_datetime("coverageStart")
            .unwrap()
            .timestamp_millis(),
        NOW - 10 * DAY
    );
    input.coverage_start = JsDate::invalid();
    assert!(matches!(
        backfill::backfill_state_upsert(&input, date(NOW), date(NOW)),
        Err(AiUsagePersistenceError::CastError {
            path: "coverageStart"
        })
    ));
}
#[test]
fn direct_producer_nan_is_omitted_by_bulk_without_a_lossy_json_roundtrip() {
    let context = object(vec![
        ("entryId", JsonValue::String("producer".into())),
        ("entryKind", JsonValue::String("usage".into())),
        ("operation", JsonValue::String("synthesis".into())),
        ("provider", JsonValue::String("piper".into())),
        ("quantity", JsonValue::Number(f64::NAN)),
    ]);
    let receipt = build_queued_ai_usage_receipt_at(
        "channel".into(),
        "customer".into(),
        Some(date(NOW)),
        date(0),
        &context,
        2.0,
    )
    .unwrap();
    assert!(matches!(receipt.get("quantity"),Some(JsonValue::Number(v))if v.is_nan()));
    let input = input(vec![]).with_receipts(&[receipt]);
    let rows = backfill::filter_backfill_receipts(&input, date(NOW)).unwrap();
    let batch =
        backfill::prepare_backfill_batch(&rows, RetentionTier::Free, &FixedReceiptClock(date(NOW)))
            .unwrap();
    assert!(batch.operations.is_empty());
    assert_eq!(batch.skipped[0].path, "quantity");
}

fn guarded_resources() -> (String, String, String, String) {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").unwrap(),
        "dimabot-migration"
    );
    let mongo = std::env::var("DIMA_TEST_MONGO_URI").unwrap();
    assert_eq!(mongo, "mongodb://ai-ledger-backfill-mongo-fixture:27017");
    let redis = std::env::var("DIMA_TEST_REDIS_URI").unwrap();
    assert_eq!(redis, "redis://ai-ledger-backfill-redis-fixture:6379/");
    let token = std::env::var("DIMA_AI_LEDGER_BACKFILL_RESOURCE_TOKEN").unwrap();
    assert!(
        (8..=32).contains(&token.len())
            && token
                .bytes()
                .all(|v| v.is_ascii_lowercase() || v.is_ascii_digit())
    );
    let name = std::env::var("DIMA_AI_LEDGER_BACKFILL_TEST_DATABASE").unwrap();
    assert_eq!(name, format!("ai_ledger_backfill_test_{token}"));
    (mongo, redis, name, token)
}
async fn assert_owned(db: &Database, token: &str) {
    assert_eq!(db.name(), format!("ai_ledger_backfill_test_{token}"));
    let marker = db
        .collection::<Document>("_backfill_owner")
        .find_one(doc! {"_id":"owner"})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(marker.get_str("owner").unwrap(), "dimabot-migration");
    assert_eq!(marker.get_str("token").unwrap(), token);
}
async fn wait_event(events: &Arc<Mutex<Vec<(String, Document)>>>, start: usize, kind: &str) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if events.lock().unwrap()[start..]
                .iter()
                .any(|(name, _)| name == kind)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}
fn numbered_rows(prefix: &str, count: usize) -> Vec<JsonValue> {
    (0..count)
        .map(|i| {
            let mut row = receipt();
            set(
                &mut row,
                "id",
                JsonValue::String(format!("{prefix}-{i}").into()),
            );
            row
        })
        .collect()
}

#[tokio::test]
#[ignore = "fresh owned Mongo8+ enableTestCommands=1 and Redis only; exact aliases, unique namespace and marker required"]
async fn private_mongo_redis_backfill_protocol_partial_failures_and_cancellation() {
    use mongodb::{
        IndexModel,
        event::{EventHandler, cmap::CmapEvent, command::CommandEvent},
        options::{Acknowledgment, ClientOptions, IndexOptions, WriteConcern},
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
    options.command_event_handler = Some(EventHandler::callback(move |event: CommandEvent| {
        if let CommandEvent::Started(event) = event {
            observed
                .lock()
                .unwrap()
                .push((event.command_name, event.command));
        }
    }));
    options.cmap_event_handler = Some(EventHandler::callback(move |event: CmapEvent| {
        if matches!(event, CmapEvent::PoolCreated(_)) {
            observed_pools.fetch_add(1, Ordering::SeqCst);
        }
    }));
    let client = Client::with_options(options).unwrap();
    let admin = client.database("admin");
    let existing = client.list_database_names().await.unwrap();
    assert!(
        existing
            .iter()
            .all(|name| matches!(name.as_str(), "admin" | "config" | "local")),
        "failpoints require a fresh private Mongo server"
    );
    let info = admin.run_command(doc! {"buildInfo":1}).await.unwrap();
    assert!(
        info.get_array("versionArray").unwrap()[0].as_i32().unwrap() >= 8,
        "Client::bulk_write requires Mongo8+"
    );
    let concern = WriteConcern::builder()
        .w(Acknowledgment::Nodes(1))
        .journal(true)
        .build();
    let db = client.database_with_options(
        &name,
        mongodb::options::DatabaseOptions::builder()
            .write_concern(concern)
            .build(),
    );
    assert!(db.list_collection_names().await.unwrap().is_empty());
    let redis_client = redis::Client::open(redis_uri).unwrap();
    let mut cache = redis_client.get_connection_manager().await.unwrap();
    assert_eq!(
        redis::cmd("DBSIZE")
            .query_async::<i64>(&mut cache)
            .await
            .unwrap(),
        0,
        "fresh private Redis server only"
    );
    db.collection::<Document>("_backfill_owner")
        .insert_one(doc! {"_id":"owner","owner":"dimabot-migration","token":&token})
        .await
        .unwrap();
    let channel = JsString::from(format!("backfill_{token}"));
    let customer = JsString::from(format!("customer_{token}"));
    let key = ai_usage_lock::account_key(&channel, &customer);
    let panic_channel = JsString::from(format!("panic_{token}"));
    let panic_key = ai_usage_lock::account_key(&panic_channel, &customer);
    let result=AssertUnwindSafe(async {
        assert_owned(&db,&token).await;
        let app=CountClock::new(date(NOW));let middleware=CountClock::new(date(NOW+11));
        let service=MongoAiUsageLedgerBackfill::with_clocks(&db,cache.clone(),Arc::new(app.clone()),Arc::new(middleware.clone()));let sibling=service.clone();
        assert_eq!(app.reads(),0);assert_eq!(middleware.reads(),0);
        assert_eq!(db.list_collection_names().await.unwrap(),vec!["_backfill_owner"]);
        // Use source indexes except TTL so deliberate retention-boundary data
        // remains available for query-side assertions in this private fixture.
        for schema in [dima_rust::schemas::ai_usage_receipt::schema(),dima_rust::schemas::ai_usage_daily::schema(),dima_rust::schemas::ai_usage_ledger_state::schema()] {
            schema.native_collection(&db).create_indexes(schema.indexes.iter().filter(|index|index.ttl.is_none()).map(|index|index.model())).await.unwrap();
        }
        let p=service.persistence();let account=doc!{"channelID":channel.to_utf8_lossy(),"customerId":customer.to_utf8_lossy()};
        let mut dashboard=account.clone();dashboard.insert("dirty",false);p.dashboard_collection().insert_one(dashboard).await.unwrap();
        let mut request=input(numbered_rows("initial",1001));request.channel_id=channel.clone();request.customer_id=customer.clone();
        let begin=events.lock().unwrap().len();service.backfill_ai_usage_ledger(&request).await.unwrap();
        let commands=events.lock().unwrap()[begin..].to_vec();
        let sizes=commands.iter().filter(|(name,_)|name=="bulkWrite").map(|(_,command)|command.get_array("ops").unwrap().len()).collect::<Vec<_>>();assert_eq!(sizes,vec![500,500,1]);
        assert!(commands.iter().filter(|(name,_)|name=="bulkWrite").all(|(_,command)|command.get_bool("ordered").ok()==Some(false)));
        for (_,command) in commands.iter().filter(|(name,_)|matches!(name.as_str(),"update"|"bulkWrite"|"delete"|"insert"|"findAndModify")) {
            let wc=command.get_document("writeConcern").unwrap();assert!(wc.get_bool("j").unwrap());assert_eq!(wc.get_i32("w").unwrap(),1);
        }
        assert_eq!(p.receipt_collection().count_documents(account.clone()).await.unwrap(),1001);
        let daily=p.daily_collection().find_one(account.clone()).await.unwrap().unwrap();assert_eq!(numeric(&daily,"spentCredits"),2002.0);assert_eq!(numeric(&daily,"transactionCount"),1001.0);
        let state=service.state_collection().find_one(account.clone()).await.unwrap().unwrap();assert_eq!(numeric(&state,"reportVersion"),3.0);assert_eq!(state.get_datetime("coverageStart").unwrap().timestamp_millis(),NOW-10*DAY);assert_eq!(state.get_datetime("created_at").unwrap().timestamp_millis(),NOW+11);
        // Duplicate identity changes only the two mutable source paths and
        // repairs a daily row lost after a previous receipt commit.
        let mut duplicate=receipt();set(&mut duplicate,"id",JsonValue::String("initial-0".into()));set(&mut duplicate,"source",JsonValue::String("admin_credit_grant".into()));set(&mut duplicate,"adjustmentType",JsonValue::String("manual_grant".into()));set(&mut duplicate,"credits",JsonValue::Number(999.0));
        request.transactions=vec![duplicate];request.coverage_start=date(NOW-5*DAY);p.daily_collection().delete_many(account.clone()).await.unwrap();
        sibling.backfill_ai_usage_ledger(&request).await.unwrap();
        let row=p.receipt_collection().find_one(doc!{"entryId":"initial-0"}).await.unwrap().unwrap();assert_eq!(numeric(&row,"credits"),2.0);assert_eq!(row.get_str("source").unwrap(),"admin_credit_grant");assert_eq!(row.get_str("adjustmentType").unwrap(),"manual_grant");
        assert_eq!(numeric(&p.daily_collection().find_one(account.clone()).await.unwrap().unwrap(),"spentCredits"),2002.0);
        assert_eq!(service.state_collection().find_one(account.clone()).await.unwrap().unwrap().get_datetime("coverageStart").unwrap().timestamp_millis(),NOW-10*DAY);
        // Invalid per-op casts are omitted; repair and state still run when
        // every operation is invalid, without submitting an empty driver bulk.
        let mut invalid=receipt();set(&mut invalid,"quantity",JsonValue::Number(f64::NAN));request.transactions=vec![invalid.clone(),invalid.clone()];
        let begin=events.lock().unwrap().len();let reads=middleware.reads();service.backfill_ai_usage_ledger(&request).await.unwrap();
        assert!(!events.lock().unwrap()[begin..].iter().any(|(name,_)|name=="bulkWrite"));assert_eq!(middleware.reads()-reads,4,"two op stamps, one valid daily insert, one state stamp");
        // A unique partial index forces one duplicate error amid valid writes.
        // The invalid input before it must not shift original-index reporting.
        let unique=IndexModel::builder().keys(doc!{"resourceId":1}).options(IndexOptions::builder().name("backfill_owned_collision".to_owned()).unique(true).partial_filter_expression(doc!{"source":"collision"}).build()).build();
        p.receipt_collection().create_index(unique).await.unwrap();
        let mut partial=numbered_rows("partial",3);for (i,row) in partial.iter_mut().enumerate(){set(row,"source",JsonValue::String("collision".into()));set(row,"resourceId",JsonValue::String(if i<2{"same"}else{"other"}.into()));}
        partial.insert(1,invalid.clone());request.transactions=partial;let old_state=service.state_collection().find_one(account.clone()).await.unwrap().unwrap();
        let begin=events.lock().unwrap().len();let error=service.backfill_ai_usage_ledger(&request).await.unwrap_err();
        let AiUsageLockError::Callback(AiUsageBackfillError::Bulk(failure))=error else {panic!("expected concrete partial bulk failure")};
        assert_eq!(failure.transaction_indices,vec![0,2,3]);assert_eq!(failure.skipped[0].index,1);assert_eq!(failure.write_error_indices(),vec![(1,2)]);
        assert!(matches!(failure.source.kind.as_ref(),mongodb::error::ErrorKind::BulkWrite(error)if error.partial_result.is_some()));
        assert_eq!(p.receipt_collection().count_documents(doc!{"entryId":{"$in":["partial-0","partial-1","partial-2"]}}).await.unwrap(),2,"unordered valid operations survive the duplicate");
        assert!(!events.lock().unwrap()[begin..].iter().any(|(name,_)|matches!(name.as_str(),"aggregate"|"findAndModify")),"partial failure stops before repair and state");
        assert_eq!(service.state_collection().find_one(account.clone()).await.unwrap().unwrap(),old_state,"failed batch never advances state");
        assert!(redis::cmd("GET").arg(&key).query_async::<Option<String>>(&mut cache).await.unwrap().is_none());
        p.receipt_collection().drop_index("backfill_owned_collision").await.unwrap();
        // One source batch may exceed Mongo's message size while each receipt
        // remains below maxBsonObjectSize. The driver must split it safely and
        // retain global per-operation indices across its command boundaries.
        let mut large=numbered_rows("large",4);
        for row in &mut large {set(row,"model",JsonValue::String("x".repeat(13*1024*1024).into()));}
        request.transactions=large;
        let begin=events.lock().unwrap().len();service.backfill_ai_usage_ledger(&request).await.unwrap();
        let commands=events.lock().unwrap()[begin..].to_vec();
        let sizes=commands.iter().filter(|(name,_)|name=="bulkWrite").map(|(_,command)|command.get_array("ops").unwrap().len()).collect::<Vec<_>>();
        assert!(sizes.len()>=2,"driver size splitting required");assert_eq!(sizes.iter().sum::<usize>(),4);
        assert_eq!(p.receipt_collection().count_documents(doc!{"entryId":{"$in":["large-0","large-1","large-2","large-3"]}}).await.unwrap(),4);
        p.receipt_collection().delete_many(doc!{"entryId":{"$in":["large-0","large-1","large-2","large-3"]}}).await.unwrap();
        // Server failures stop at their exact phase and are never replayed.
        request.transactions=numbered_rows("failure",1);
        for command in ["update","bulkWrite","aggregate","delete","insert","findAndModify"] {
            admin.run_command(doc!{"configureFailPoint":"failCommand","mode":{"times":1},"data":{"failCommands":[command],"errorCode":12345}}).await.unwrap();
            let begin=events.lock().unwrap().len();assert!(service.backfill_ai_usage_ledger(&request).await.is_err());
            assert_eq!(events.lock().unwrap()[begin..].iter().filter(|(name,_)|name==command).count(),1,"no application retry {command}");
            admin.run_command(doc!{"configureFailPoint":"failCommand","mode":"off"}).await.unwrap();
        }
        admin.run_command(doc!{"configureFailPoint":"failCommand","mode":{"times":1},"data":{"failCommands":["bulkWrite"],"closeConnection":true}}).await.unwrap();
        let begin=events.lock().unwrap().len();assert!(service.backfill_ai_usage_ledger(&request).await.is_err());assert_eq!(events.lock().unwrap()[begin..].iter().filter(|(name,_)|name=="bulkWrite").count(),1);
        admin.run_command(doc!{"configureFailPoint":"failCommand","mode":"off"}).await.unwrap();
        // The Mongo operation can settle after the caller disappears. Retain
        // the lease TTL, then let only this fixture remove its exact owned key.
        admin.run_command(doc!{"configureFailPoint":"failCommand","mode":{"times":1},"data":{"failCommands":["bulkWrite"],"blockConnection":true,"blockTimeMS":1200}}).await.unwrap();
        let begin=events.lock().unwrap().len();let pending={let service=service.clone();let request=request.clone();tokio::spawn(async move{service.backfill_ai_usage_ledger(&request).await})};
        wait_event(&events,begin,"bulkWrite").await;pending.abort();assert!(pending.await.unwrap_err().is_cancelled());
        let ttl=redis::cmd("TTL").arg(&key).query_async::<i64>(&mut cache).await.unwrap();assert!((1..=120).contains(&ttl));
        tokio::time::sleep(Duration::from_millis(1500)).await;
        admin.run_command(doc!{"configureFailPoint":"failCommand","mode":"off"}).await.unwrap();
        redis::cmd("DEL").arg(&key).query_async::<i64>(&mut cache).await.unwrap();
        // Concurrent service clones use the original supplied pool and lease.
        let (a,b)=tokio::join!(service.backfill_ai_usage_ledger(&request),sibling.backfill_ai_usage_ledger(&request));a.unwrap();b.unwrap();
        assert_eq!(pools.load(Ordering::SeqCst),1,"service clones share the supplied Mongo pool");
        let panic=AssertUnwindSafe(AiUsageLock::new(cache.clone()).with(&panic_channel,&customer,||async{panic!("fixture callback panic");#[allow(unreachable_code)]Ok::<(),std::io::Error>(())})).catch_unwind().await;
        assert!(panic.is_err());assert!((1..=120).contains(&redis::cmd("TTL").arg(&panic_key).query_async::<i64>(&mut cache).await.unwrap()));
    }).catch_unwind().await;
    // Even a failing assertion reaches cleanup. Ownership and exact aliases
    // are checked before touching this task's database, failpoint or two keys.
    assert_owned(&db, &token).await;
    admin
        .run_command(doc! {"configureFailPoint":"failCommand","mode":"off"})
        .await
        .unwrap();
    redis::cmd("DEL")
        .arg(&key)
        .arg(&panic_key)
        .query_async::<i64>(&mut cache)
        .await
        .unwrap();
    assert_eq!(
        redis::cmd("DBSIZE")
            .query_async::<i64>(&mut cache)
            .await
            .unwrap(),
        0
    );
    db.drop().await.unwrap();
    client.shutdown().await;
    if let Err(panic) = result {
        std::panic::resume_unwind(panic)
    }
}

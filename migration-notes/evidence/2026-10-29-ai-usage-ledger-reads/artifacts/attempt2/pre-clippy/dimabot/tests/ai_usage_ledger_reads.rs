#![cfg(feature = "ai-usage-ledger-reads")]
//! Ordinary tests are self-contained. Actual-source and private-Mongo checks
//! are explicitly ignored and fail if their required setup is missing.
use dima_rust::utils::{
    ai_usage_ledger_reads::{
        self as reads, AiUsageLedgerCoverageInput, AiUsageLedgerReadError, AiUsageLedgerReadiness,
        AiUsageLedgerState, AiUsageLedgerStateInput, LedgerField, MongoAiUsageLedgerReads,
    },
    bson_compat::normalize_document,
    credit_policy::JsDate,
    js_string::JsString,
};
use futures_util::{FutureExt, TryStreamExt};
use mongodb::{
    Client, Database,
    bson::{Bson, DateTime, Document, doc},
    event::{EventHandler, cmap::CmapEvent, command::CommandEvent},
    options::ClientOptions,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::Cursor,
    panic::AssertUnwindSafe,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

fn state_input() -> AiUsageLedgerStateInput {
    AiUsageLedgerStateInput {
        channel_id: "channel".into(),
        customer_id: "customer".into(),
    }
}
fn input(millis: f64) -> AiUsageLedgerCoverageInput {
    AiUsageLedgerCoverageInput {
        channel_id: "channel".into(),
        customer_id: "customer".into(),
        starts_at: JsDate::from_millis(millis),
    }
}
fn state() -> Document {
    doc! {"coverageStart":DateTime::from_millis(0),"backfilledAt":DateTime::from_millis(123),"reportVersion":3}
}
fn ready(document: Document, requested: f64) -> bool {
    reads::decode_status(Some(document), JsDate::from_millis(requested))
        .unwrap()
        .status
        == AiUsageLedgerReadiness::Ready
}
fn exception(result: Result<reads::AiUsageLedgerStatus, AiUsageLedgerReadError>, wanted: &str) {
    assert_eq!(
        result.unwrap_err().javascript_exception_name(),
        Some(wanted)
    );
}

#[test]
fn exact_queries_preserve_filters_projection_and_utf16_boundary() {
    let mut key = state_input();
    key.channel_id = JsString::from_units(vec![0x61, 0xd800, 0x62]);
    key.customer_id = " customer ".into();
    let query = reads::state_query(&key);
    assert_eq!(
        query.filter,
        doc! {"channelID":"a�b","customerId":" customer "}
    );
    assert_eq!(
        query.projection,
        doc! {"coverageStart":1,"backfilledAt":1,"reportVersion":1}
    );
    assert!(
        !query.projection.contains_key("_id"),
        "Mongo includes _id by default"
    );
    assert_eq!(
        key.channel_id.units(),
        vec![0x61, 0xd800, 0x62],
        "input stays lossless"
    );
    let query = reads::coverage_query(&input(0.0)).unwrap();
    assert_eq!(
        query.filter,
        doc! {"channelID":"channel","customerId":"customer",
        "coverageStart":{"$lte":DateTime::from_millis(0)},"reportVersion":{"$gte":3}}
    );
    assert_eq!(query.projection, doc! {"_id":1});
    let error = reads::coverage_query(&input(f64::NAN)).unwrap_err();
    assert!(matches!(
        error,
        AiUsageLedgerReadError::CastError {
            path: "coverageStart"
        }
    ));
    assert_eq!(error.javascript_exception_name(), Some("CastError"));
}

#[test]
fn threshold_three_and_dates_are_ordered_without_cadence_or_clock() {
    assert!(reads::decode_state(None).is_none());
    let absent = reads::decode_status(None, JsDate::from_millis(0.0)).unwrap();
    assert_eq!(absent.status, AiUsageLedgerReadiness::Pending);
    assert_eq!(absent.coverage_start, None);
    assert_eq!(absent.last_synced_at, None);
    assert_eq!(absent.requested_coverage_start, "1970-01-01T00:00:00.000Z");
    for (coverage, requested, wanted) in [
        (-1, 0, true),
        (0, 0, true),
        (1, 0, false),
        (0, -1, false),
        (0, 1, true),
    ] {
        let mut s = state();
        s.insert("coverageStart", DateTime::from_millis(coverage));
        assert_eq!(ready(s, requested as f64), wanted);
    }
    for (version, wanted) in [
        (2.0, false),
        (2.9999999999999996, false),
        (3.0, true),
        (3.0000000000000004, true),
        (f64::NAN, false),
        (f64::NEG_INFINITY, false),
        (f64::INFINITY, true),
    ] {
        let mut s = state();
        s.insert("reportVersion", Bson::Double(version));
        assert_eq!(ready(s, 0.0), wanted);
    }
}

#[test]
fn lean_state_keeps_malformed_bson_and_missing_null_distinct() {
    let s = reads::decode_state(Some(
        doc! {"coverageStart":"legacy","backfilledAt":Bson::Null,
        "reportVersion":"3","ignored":true},
    ))
    .unwrap();
    assert_eq!(s.coverage_start, LedgerField::Value("legacy".into()));
    assert_eq!(s.backfilled_at, LedgerField::Value(Bson::Null));
    assert_eq!(s.report_version, LedgerField::Value("3".into()));
    let empty = reads::decode_state(Some(Document::new())).unwrap();
    assert_eq!(empty.coverage_start, LedgerField::Undefined);
    assert_eq!(empty.backfilled_at, LedgerField::Undefined);
    assert_eq!(empty.report_version, LedgerField::Value(Bson::Int32(0)));
    for falsy in [
        Bson::Null,
        Bson::Undefined,
        Bson::Boolean(false),
        Bson::Int32(0),
        Bson::Int64(0),
        Bson::Double(-0.0),
        Bson::Double(f64::NAN),
        Bson::String(String::new()),
    ] {
        let s = reads::decode_state(Some(doc! {"reportVersion":falsy})).unwrap();
        assert_eq!(s.report_version, LedgerField::Value(Bson::Int32(0)));
    }
    for truthy in [
        Bson::Boolean(true),
        Bson::String(" ".into()),
        Bson::Array(vec![]),
        Bson::Document(Document::new()),
        Bson::Int64(9_007_199_254_740_993),
        Bson::Decimal128("0".parse().unwrap()),
    ] {
        let s = reads::decode_state(Some(doc! {"reportVersion":truthy.clone()})).unwrap();
        assert_eq!(s.report_version, LedgerField::Value(truthy));
    }
}

#[test]
fn ordinary_legacy_version_coercion_reuses_the_existing_js_core() {
    for (version, wanted) in [
        (Bson::String("\u{feff} 0x3 \u{3000}".into()), true),
        (Bson::String("\u{0085}3".into()), false),
        (Bson::Array(vec![3.into()]), true),
        (Bson::Array(vec![Bson::Null]), false),
        (Bson::Array(vec![]), false),
        (Bson::Array(vec![3.into(), 4.into()]), false),
        (Bson::Document(doc! {"valueOf":3}), false),
        (Bson::Decimal128("3".parse().unwrap()), true),
        (Bson::Int64(9_007_199_254_740_993), true),
        (Bson::DateTime(DateTime::from_millis(3)), true),
    ] {
        let mut s = state();
        s.insert("reportVersion", version);
        assert_eq!(ready(s, 0.0), wanted);
    }
    let mut s = state();
    s.insert("reportVersion", doc! {"toString":Bson::Null});
    exception(
        reads::decode_status(Some(s.clone()), JsDate::from_millis(0.0)),
        "TypeError",
    );
    s.insert("coverageStart", DateTime::from_millis(1));
    assert!(
        !ready(s, 0.0),
        "future coverage short-circuits malformed version coercion"
    );
}

#[test]
fn nullish_iso_and_date_method_failures_preserve_evaluation_order() {
    for coverage in [
        None,
        Some(Bson::Null),
        Some("bad".into()),
        Some(0.into()),
        Some(doc! {"getTime":0}.into()),
    ] {
        let mut s = state();
        s.remove("coverageStart");
        if let Some(value) = coverage {
            s.insert("coverageStart", value);
        }
        let e = reads::decode_status(Some(s), JsDate::invalid()).unwrap_err();
        assert!(matches!(
            e,
            AiUsageLedgerReadError::TypeError {
                field: "coverageStart",
                method: "getTime"
            }
        ));
    }
    for sync in [None, Some(Bson::Null), Some(Bson::Undefined)] {
        let mut s = state();
        s.remove("backfilledAt");
        if let Some(v) = sync {
            s.insert("backfilledAt", v);
        }
        assert_eq!(
            reads::decode_status(Some(s), JsDate::from_millis(0.0))
                .unwrap()
                .last_synced_at,
            None
        );
    }
    let mut s = state();
    s.insert("backfilledAt", false);
    let e = reads::decode_status(Some(s), JsDate::invalid()).unwrap_err();
    assert!(matches!(
        e,
        AiUsageLedgerReadError::TypeError {
            field: "backfilledAt",
            method: "toISOString"
        }
    ));
    exception(reads::decode_status(None, JsDate::invalid()), "RangeError");
}

#[test]
fn extended_years_timeclip_and_raw_bson_dates_are_preserved() {
    for millis in [
        -8_640_000_000_000_000_i64,
        -62_167_219_200_000,
        253_402_300_800_000,
        8_640_000_000_000_000,
    ] {
        let mut s = state();
        s.insert("coverageStart", DateTime::from_millis(millis));
        let status = reads::decode_status(Some(s), JsDate::from_millis(millis as f64)).unwrap();
        assert_eq!(
            status.coverage_start,
            Some(status.requested_coverage_start.clone())
        );
    }
    for millis in [-8_640_000_000_000_001_i64, 8_640_000_000_000_001, i64::MAX] {
        let mut s = state();
        s.insert("coverageStart", DateTime::from_millis(millis));
        let raw = reads::decode_state(Some(s.clone())).unwrap();
        assert_eq!(
            raw.coverage_start,
            LedgerField::Value(Bson::DateTime(DateTime::from_millis(millis)))
        );
        let error = reads::decode_status(Some(s), JsDate::from_millis(0.0)).unwrap_err();
        assert!(matches!(
            error,
            AiUsageLedgerReadError::RangeError {
                field: "coverageStart"
            }
        ));
        let mut s = state();
        s.insert("backfilledAt", DateTime::from_millis(millis));
        let error = reads::decode_status(Some(s), JsDate::invalid()).unwrap_err();
        assert!(
            matches!(
                error,
                AiUsageLedgerReadError::RangeError {
                    field: "backfilledAt"
                }
            ),
            "sync ISO fails before requested ISO"
        );
    }
    let mut s = state();
    s.insert(
        "reportVersion",
        vec![Bson::Decimal128("3".parse().unwrap())],
    );
    assert!(
        ready(s, 0.0),
        "nested Decimal128 uses its numeric string form"
    );
    let mut s = state();
    s.insert(
        "reportVersion",
        vec![Bson::DateTime(DateTime::from_millis(3))],
    );
    assert!(
        !ready(s, 0.0),
        "Date string inside Array.join is nonnumeric"
    );
    let mut s = state();
    s.insert(
        "reportVersion",
        vec![
            Bson::DateTime(DateTime::from_millis(3)),
            Bson::Document(doc! {"toString":0}),
        ],
    );
    exception(
        reads::decode_status(Some(s), JsDate::from_millis(0.0)),
        "TypeError",
    );
}

fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn unhex(text: &str) -> Vec<u8> {
    assert_eq!(text.len() % 2, 0);
    text.as_bytes()
        .chunks_exact(2)
        .map(|c| u8::from_str_radix(std::str::from_utf8(c).unwrap(), 16).unwrap())
        .collect()
}
fn bson_document(hex: &str) -> Document {
    Document::from_reader(Cursor::new(unhex(hex))).unwrap()
}
fn fixture_property<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value["$object"]
        .as_array()
        .unwrap()
        .iter()
        .find_map(|row| (row[0] == key).then_some(&row[1]))
}
fn fixture_string(value: &Value) -> JsString {
    JsString::from_units(
        value["$utf16"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| u16::try_from(v.as_u64().unwrap()).unwrap())
            .collect(),
    )
}
fn fixture_date(value: &Value) -> JsDate {
    value["$date"].as_str().map_or(JsDate::invalid(), |v| {
        JsDate::from_millis(v.parse::<f64>().unwrap())
    })
}
fn encoded_string(value: &str) -> Value {
    json!({"$utf16":value.encode_utf16().collect::<Vec<_>>()})
}
fn encoded_number(value: f64) -> Value {
    json!({"$f64":format!("{:016x}",value.to_bits())})
}
fn encoded_bson_wrapper(value: &Bson) -> Value {
    // Compare the actual wrapper's BSON value bytes with the installed Node
    // codec; the optional extended-JSON feature is not enabled in this crate.
    let bytes = doc! {"value": value.clone()}.to_vec().unwrap();
    let wire = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    json!({"$bsonWire": wire})
}
fn encoded_bson(value: &Bson) -> Value {
    match value {
        Bson::Undefined => json!({"$undefined":true}),
        Bson::Null => Value::Null,
        Bson::Boolean(v) => json!(v),
        Bson::Int32(v) => encoded_number(f64::from(*v)),
        Bson::Double(v) => encoded_number(*v),
        Bson::Int64(v) => {
            let mut doc = doc! {"v":*v};
            normalize_document(&mut doc);
            match doc.get("v").unwrap() {
                Bson::Int64(_) => encoded_bson_wrapper(value),
                other => encoded_bson(other),
            }
        }
        Bson::String(v) | Bson::Symbol(v) => encoded_string(v),
        Bson::DateTime(v) => {
            json!({"$date":JsDate::from_millis(v.timestamp_millis() as f64).timestamp_millis().map(|v|v.to_string())})
        }
        Bson::Array(v) => json!({"$array":v.iter().map(encoded_bson).collect::<Vec<_>>()}),
        Bson::Document(v) => {
            json!({"$object":v.iter().map(|(k,v)|json!([k,encoded_bson(v)])).collect::<Vec<_>>()})
        }
        _ => encoded_bson_wrapper(value),
    }
}
fn encoded_field(value: &LedgerField) -> Value {
    value
        .as_bson()
        .map_or(json!({"$undefined":true}), encoded_bson)
}
fn encoded_state(state: Option<AiUsageLedgerState>) -> Value {
    state.map_or(Value::Null,|s|json!({"$object":[["coverageStart",encoded_field(&s.coverage_start)],
        ["backfilledAt",encoded_field(&s.backfilled_at)],["reportVersion",encoded_field(&s.report_version)]]}))
}
fn encoded_status(status: reads::AiUsageLedgerStatus) -> Value {
    json!({"$object":[["status",encoded_string(if status.status==AiUsageLedgerReadiness::Ready {"ready"}else{"pending"})],
        ["coverageStart",status.coverage_start.as_deref().map_or(Value::Null,encoded_string)],
        ["lastSyncedAt",status.last_synced_at.as_deref().map_or(Value::Null,encoded_string)],
        ["requestedCoverageStart",encoded_string(&status.requested_coverage_start)]]})
}

fn source_fixture() -> Value {
    let directory = std::env::var("DIMA_AI_LEDGER_READS_REFERENCE_DIR")
        .expect("explicit external source fixture directory");
    let directory = Path::new(&directory).canonicalize().unwrap();
    let base = Path::new(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    assert!(
        !directory.starts_with(&base),
        "fixture output must be external"
    );
    let bytes = std::fs::read(directory.join("ai_usage_ledger_reads_reference.json"))
        .expect("required source fixture");
    assert!(!bytes.is_empty());
    let root: Value = serde_json::from_slice(&bytes).unwrap();
    let metadata = &root["metadata"];
    assert_eq!(metadata["format"], 1);
    assert_eq!(metadata["node"], "v24.22.1");
    assert_eq!(metadata["v8"], "13.6.233.17-node.58");
    assert_eq!(metadata["typescript"], "5.9.3");
    assert_eq!(metadata["mongoose"], "8.24.2");
    assert_eq!(metadata["typeDiagnostics"], json!([]));
    let node =
        std::env::var("DIMA_AI_LEDGER_READS_NODE_BINARY").expect("exact pinned oracle Node binary");
    assert_eq!(metadata["nodeSha256"], hash(std::fs::read(node).unwrap()));
    // Node packages can be mounted read-only separately from the source copy.
    let dependency_root = std::env::var("DIMA_AI_LEDGER_READS_NODE_DEPENDENCY_ROOT")
        .expect("read-only root containing oracle node_modules");
    let dependency_root = Path::new(&dependency_root);
    for (name, wanted) in [
        ("typescript", "5.9.3"),
        ("mongoose", "8.24.2"),
        ("bson", "6.10.4"),
    ] {
        assert_eq!(metadata["packages"][name]["version"], wanted);
    }
    for package in metadata["packages"].as_object().unwrap().values() {
        for (file, digest) in [("entry", "entrySha256"), ("package", "packageSha256")] {
            let path = Path::new(package[file].as_str().unwrap());
            assert!(path.starts_with("node_modules"));
            assert_eq!(
                package[digest],
                hash(std::fs::read(dependency_root.join(path)).unwrap())
            );
        }
    }
    for (file, digest) in metadata["hashes"]
        .as_object()
        .expect("native/source hashes")
    {
        let path = if file.starts_with("node_modules/") {
            dependency_root.join(file)
        } else {
            base.join(file)
        };
        assert_eq!(
            *digest,
            hash(std::fs::read(path).unwrap()),
            "source/native drift {file}"
        );
    }
    assert!(metadata["dependencies"].as_object().unwrap().len() > 10);
    for (file, digest) in metadata["dependencies"].as_object().unwrap() {
        let relative = Path::new(file);
        assert!(
            relative.starts_with("node_modules"),
            "dependency path escapes explicit root"
        );
        assert_eq!(
            *digest,
            hash(std::fs::read(dependency_root.join(relative)).unwrap()),
            "dependency drift {file}"
        );
    }
    for (key, file) in [
        ("extractedSha256", "ai_usage_ledger_reads_extracted.ts"),
        ("typecheckSha256", "ai_usage_ledger_reads_typecheck.ts"),
        ("compiledSha256", "ai_usage_ledger_reads_compiled.cjs"),
    ] {
        let bytes = std::fs::read(directory.join(file)).unwrap();
        assert!(!bytes.is_empty());
        assert_eq!(metadata[key], hash(bytes));
    }
    let declarations = metadata["declarations"].as_array().unwrap();
    assert_eq!(declarations.len(), 6);
    for declaration in declarations {
        let source =
            std::fs::read_to_string(base.join(declaration["file"].as_str().unwrap())).unwrap();
        let from = declaration["startByte"].as_u64().unwrap() as usize;
        let to = declaration["endByte"].as_u64().unwrap() as usize;
        let text = format!("{}\n", &source[from..to]);
        assert_eq!(declaration["text"], text);
        assert_eq!(declaration["sha256"], hash(text));
    }
    for name in [
        "hasAiUsageLedgerCoverage",
        "getAiUsageLedgerStatus",
        "getAiUsageLedgerState",
    ] {
        let d = declarations.iter().find(|d| d["name"] == name).unwrap();
        assert_eq!(d["kind"], "FunctionDeclaration");
        assert_eq!(d["parameters"].as_array().unwrap().len(), 1);
        assert!(
            d["parameters"][0]["type"]
                .as_str()
                .unwrap()
                .contains("channelID: string")
        );
        assert!(
            d["parameters"][0]["type"]
                .as_str()
                .unwrap()
                .contains("customerId: string")
        );
        if name != "getAiUsageLedgerState" {
            assert!(
                d["parameters"][0]["type"]
                    .as_str()
                    .unwrap()
                    .contains("startsAt: Date")
            );
        }
    }
    assert_eq!(
        metadata["caseCount"].as_u64().unwrap() as usize,
        root["records"].as_array().unwrap().len()
    );
    assert!(root["records"].as_array().unwrap().len() > 150);
    root
}

#[test]
#[ignore = "requires fresh external actual-source fixtures and pinned read-only Node dependency hashes"]
fn actual_source_replay() {
    let root = source_fixture();
    let mut seen = [0usize; 3];
    for row in root["records"].as_array().unwrap() {
        let id = row["id"].as_str().unwrap();
        let op = row["op"].as_str().unwrap();
        let input = &row["input"];
        let channel = fixture_string(fixture_property(input, "channelID").unwrap());
        let customer = fixture_string(fixture_property(input, "customerId").unwrap());
        let starts = fixture_property(input, "startsAt").map_or(JsDate::invalid(), fixture_date);
        let reply = row["replyHex"].as_str().map(bson_document);
        let query = if op == "hasAiUsageLedgerCoverage" {
            reads::coverage_query(&AiUsageLedgerCoverageInput {
                channel_id: channel,
                customer_id: customer,
                starts_at: starts,
            })
        } else {
            Ok(reads::state_query(&AiUsageLedgerStateInput {
                channel_id: channel,
                customer_id: customer,
            }))
        };
        let calls = row["calls"].as_array().unwrap();
        let query = match query {
            Ok(query) => {
                assert_eq!(calls.len(), 1, "{id}");
                query
            }
            Err(error) => {
                assert_eq!(
                    error.javascript_exception_name(),
                    row["error"]["name"].as_str(),
                    "{id}"
                );
                assert!(calls.is_empty());
                continue;
            }
        };
        assert_eq!(
            query.filter,
            bson_document(calls[0]["filterHex"].as_str().unwrap()),
            "filter {id}"
        );
        assert_eq!(
            query.projection,
            bson_document(calls[0]["projectionHex"].as_str().unwrap()),
            "projection {id}"
        );
        if row["driverError"] == true {
            assert_eq!(row["error"]["name"], "MongoServerError");
            continue;
        }
        let actual = match op {
            "hasAiUsageLedgerCoverage" => {
                seen[0] += 1;
                Ok(json!(reply.is_some()))
            }
            "getAiUsageLedgerState" => {
                seen[1] += 1;
                Ok(encoded_state(reads::decode_state(reply)))
            }
            "getAiUsageLedgerStatus" => {
                seen[2] += 1;
                reads::decode_status(reply, starts).map(encoded_status)
            }
            _ => panic!("unexpected source export"),
        };
        match actual {
            Ok(actual) => {
                assert!(row["error"].is_null(), "source error {id}");
                assert_eq!(actual, row["result"], "{id}");
            }
            Err(error) => {
                assert!(
                    !row["error"].is_null(),
                    "unexpected native error {id}: {error}"
                );
                assert_eq!(
                    error
                        .javascript_exception_name()
                        .expect("defined source JS error category"),
                    row["error"]["name"]
                        .as_str()
                        .expect("source exception name"),
                    "{id}: {error}"
                );
            }
        }
    }
    assert!(seen[0] >= 10 && seen[1] >= 50 && seen[2] >= 50);
}

fn guarded_fixture_configuration() -> (String, String, String) {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").expect("explicit task resource owner"),
        "dimabot-migration"
    );
    let uri = std::env::var("DIMA_TEST_MONGO_URI").expect("explicit private fixture URI");
    assert_eq!(
        uri, "mongodb://ai-ledger-reads-mongo-fixture:27017",
        "only dedicated private-network fixture is allowlisted"
    );
    let token =
        std::env::var("DIMA_AI_LEDGER_READS_RESOURCE_TOKEN").expect("unique owned resource token");
    assert!(
        (8..=32).contains(&token.len())
            && token
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    );
    let database =
        std::env::var("DIMA_AI_LEDGER_READS_TEST_DATABASE").expect("explicit task database");
    assert_eq!(database, format!("ai_ledger_reads_test_{token}"));
    (uri, database, token)
}
async fn configure_failure(database: &Database, data: Document) {
    database
        .run_command(doc! {"configureFailPoint":"failCommand","mode":{"times":1},"data":data})
        .await
        .expect("disposable Mongo must enable test commands; never run against a shared server");
}
async fn assert_owned(database: &Database, token: &str) {
    assert_eq!(database.name(), format!("ai_ledger_reads_test_{token}"));
    let owner = database
        .collection::<Document>("_ledger_reads_test_owner")
        .find_one(doc! {"_id":"owner"})
        .await
        .unwrap()
        .expect("owned database marker");
    assert_eq!(owner.get_str("token").unwrap(), token);
    assert_eq!(owner.get_str("owner").unwrap(), "dimabot-migration");
}

#[tokio::test]
#[ignore = "requires an explicitly owned private Mongo fixture with enableTestCommands=1; never production"]
async fn private_mongo_adapter_behavior_pooling_errors_and_cancellation() {
    let (uri, database_name, token) = guarded_fixture_configuration();
    let commands = Arc::new(Mutex::new(Vec::<Document>::new()));
    let pools = Arc::new(AtomicUsize::new(0));
    let connections = Arc::new(AtomicUsize::new(0));
    let mut options = ClientOptions::parse(&uri).await.unwrap();
    options.direct_connection = Some(true);
    options.max_pool_size = Some(2);
    options.retry_reads = Some(false); // Fixture error must be observed exactly once.
    let recording = commands.clone();
    options.command_event_handler = Some(EventHandler::callback(move |event: CommandEvent| {
        if let CommandEvent::Started(event) = event {
            if event.command_name == "find" {
                recording.lock().unwrap().push(event.command);
            }
        }
    }));
    let pool_count = pools.clone();
    let connection_count = connections.clone();
    options.cmap_event_handler = Some(EventHandler::callback(
        move |event: CmapEvent| match event {
            CmapEvent::PoolCreated(_) => {
                pool_count.fetch_add(1, Ordering::SeqCst);
            }
            CmapEvent::ConnectionReady(_) => {
                connection_count.fetch_add(1, Ordering::SeqCst);
            }
            _ => {}
        },
    ));
    let client = Client::with_options(options).unwrap();
    let database = client.database(&database_name);
    assert!(
        database.list_collection_names().await.unwrap().is_empty(),
        "fresh task database required"
    );
    database
        .create_collection("_ledger_reads_test_owner")
        .await
        .unwrap();
    database
        .collection::<Document>("_ledger_reads_test_owner")
        .insert_one(doc! {
        "_id":"owner","owner":"dimabot-migration","token":token.clone()})
        .await
        .unwrap();
    let admin = client.database("admin");
    let result = AssertUnwindSafe(async {
        assert_owned(&database, &token).await;
        let before = commands.lock().unwrap().len();
        let adapter = MongoAiUsageLedgerReads::new(&database);
        let cloned = adapter.clone();
        assert_eq!(adapter.collection().name(), "ai_usage_ledger_states");
        assert_eq!(
            commands.lock().unwrap().len(),
            before,
            "constructor does not issue queries"
        );
        assert!(
            adapter
                .get_ai_usage_ledger_state(&state_input())
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            !adapter
                .has_ai_usage_ledger_coverage(&input(0.0))
                .await
                .unwrap()
        );
        assert_eq!(
            adapter
                .get_ai_usage_ledger_status(&input(0.0))
                .await
                .unwrap()
                .status,
            AiUsageLedgerReadiness::Pending
        );
        let raw = adapter.collection();
        let mut s = state();
        s.insert("channelID", "channel");
        s.insert("customerId", "customer");
        s.insert("noise", true);
        raw.insert_one(s).await.unwrap();
        assert!(
            cloned
                .has_ai_usage_ledger_coverage(&input(0.0))
                .await
                .unwrap()
        );
        assert_eq!(
            cloned
                .get_ai_usage_ledger_status(&input(0.0))
                .await
                .unwrap()
                .status,
            AiUsageLedgerReadiness::Ready
        );
        let baseline = connections.load(Ordering::SeqCst);
        for _ in 0..8 {
            assert!(
                cloned
                    .get_ai_usage_ledger_state(&state_input())
                    .await
                    .unwrap()
                    .is_some()
            );
        }
        assert_eq!(
            pools.load(Ordering::SeqCst),
            1,
            "clones reuse the supplied client pool"
        );
        assert_eq!(
            connections.load(Ordering::SeqCst),
            baseline,
            "serial reads reuse an established connection"
        );
        let find = commands.lock().unwrap().last().unwrap().clone();
        assert_eq!(
            find.get_document("filter").unwrap(),
            &reads::state_query(&state_input()).filter
        );
        assert_eq!(
            find.get_document("projection").unwrap(),
            &reads::state_query(&state_input()).projection
        );
        assert!(
            raw.list_indexes()
                .await
                .unwrap()
                .try_collect::<Vec<_>>()
                .await
                .unwrap()
                .iter()
                .all(|i| i.options.as_ref().and_then(|o| o.name.as_deref()) == Some("_id_")),
            "read adapter creates no schema indexes"
        );
        // Query BSON type bracketing differs from status's JavaScript >=.
        for (version, coverage) in [
            (
                Bson::String("3".into()),
                Bson::DateTime(DateTime::from_millis(0)),
            ),
            (Bson::Int32(3), Bson::String("1970-01-01".into())),
        ] {
            raw.update_one(
                doc! {"channelID":"channel"},
                doc! {"$set":{"reportVersion":version,"coverageStart":coverage}},
            )
            .await
            .unwrap();
            assert!(
                !adapter
                    .has_ai_usage_ledger_coverage(&input(0.0))
                    .await
                    .unwrap()
            );
            let status = adapter.get_ai_usage_ledger_status(&input(0.0)).await;
            if raw
                .find_one(doc! {"coverageStart":{"$type":"date"}})
                .await
                .unwrap()
                .is_some()
            {
                assert_eq!(status.unwrap().status, AiUsageLedgerReadiness::Ready);
            } else {
                assert_eq!(
                    status.unwrap_err().javascript_exception_name(),
                    Some("TypeError")
                );
            }
        }
        raw.update_one(doc! {"channelID":"channel"}, doc! {"$set":state()})
            .await
            .unwrap();
        assert!(
            !adapter
                .has_ai_usage_ledger_coverage(&input(-1.0))
                .await
                .unwrap()
        );
        assert!(
            !adapter
                .has_ai_usage_ledger_coverage(&AiUsageLedgerCoverageInput {
                    channel_id: "other".into(),
                    ..input(0.0)
                })
                .await
                .unwrap()
        );
        // Mongo's comparison query can match array elements; status calls a
        // Date method on the whole array and therefore throws.
        raw.update_one(
            doc! {"channelID":"channel"},
            doc! {"$set":{"coverageStart":[DateTime::from_millis(0)],"reportVersion":[3]}},
        )
        .await
        .unwrap();
        assert!(
            adapter
                .has_ai_usage_ledger_coverage(&input(0.0))
                .await
                .unwrap()
        );
        assert_eq!(
            adapter
                .get_ai_usage_ledger_status(&input(0.0))
                .await
                .unwrap_err()
                .javascript_exception_name(),
            Some("TypeError")
        );
        raw.update_one(doc! {"channelID":"channel"}, doc! {"$set":state()})
            .await
            .unwrap();
        for operation in 0..3 {
            configure_failure(&admin, doc! {"failCommands":["find"],"errorCode":12345}).await;
            let error = match operation {
                0 => adapter
                    .has_ai_usage_ledger_coverage(&input(0.0))
                    .await
                    .unwrap_err(),
                1 => adapter
                    .get_ai_usage_ledger_state(&state_input())
                    .await
                    .unwrap_err(),
                _ => adapter
                    .get_ai_usage_ledger_status(&input(0.0))
                    .await
                    .unwrap_err(),
            };
            let AiUsageLedgerReadError::Mongo(error) = error else {
                panic!("original Mongo error required")
            };
            assert!(
                matches!(error.kind.as_ref(),mongodb::error::ErrorKind::Command(e) if e.code==12345)
            );
        }
        let before = commands.lock().unwrap().len();
        assert!(matches!(
            adapter.has_ai_usage_ledger_coverage(&input(f64::NAN)).await,
            Err(AiUsageLedgerReadError::CastError { .. })
        ));
        assert_eq!(
            commands.lock().unwrap().len(),
            before,
            "invalid coverage Date fails before Mongo I/O"
        );
        // Drop an unpolled future: no command; then abort a real blocked driver
        // read. The fixture's waits bound observation only, not adapter policy.
        let key = state_input();
        drop(adapter.get_ai_usage_ledger_state(&key));
        assert_eq!(commands.lock().unwrap().len(), before);
        configure_failure(
            &admin,
            doc! {"failCommands":["find"],"blockConnection":true,"blockTimeMS":1000},
        )
        .await;
        let reading = cloned.clone();
        let pending =
            tokio::spawn(async move { reading.get_ai_usage_ledger_state(&state_input()).await });
        tokio::time::timeout(Duration::from_secs(5), async {
            while commands.lock().unwrap().len() == before {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("actual blocked read reached driver");
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());
        assert!(
            tokio::time::timeout(
                Duration::from_secs(5),
                adapter.get_ai_usage_ledger_state(&state_input())
            )
            .await
            .unwrap()
            .unwrap()
            .is_some(),
            "pool remains usable after caller cancellation"
        );
        let index_count = raw
            .list_indexes()
            .await
            .unwrap()
            .try_collect::<Vec<_>>()
            .await
            .unwrap()
            .len();
        assert_eq!(index_count, 1);
        assert_eq!(
            raw.count_documents(doc! {}).await.unwrap(),
            1,
            "reads add no documents"
        );
    })
    .catch_unwind()
    .await;
    // The fixture owns this whole Mongo server. Disable only its failCommand
    // point, then require the ownership marker before deleting the task DB.
    let failpoint_cleanup = admin
        .run_command(doc! {"configureFailPoint":"failCommand","mode":"off"})
        .await;
    let cleanup = AssertUnwindSafe(async {
        assert_owned(&database, &token).await;
        database.drop().await.unwrap();
    })
    .catch_unwind()
    .await;
    client.shutdown().await;
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
    failpoint_cleanup.expect("owned failpoint cleanup");
    if let Err(panic) = cleanup {
        std::panic::resume_unwind(panic);
    }
}

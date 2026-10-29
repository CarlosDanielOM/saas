#![cfg(feature = "ai-usage-ledger-queries")]
//! AUTHOR ONLY until parent isolated execution. Ordinary tests need no server;
//! ignored checks require a freshly generated source oracle / owned Mongo.
use dima_rust::utils::{
    ai_usage_ledger_queries::{
        self as queries, AiUsageLedgerTransactionsInput, AiUsagePacingHistoryInput,
        AiUsageTransaction, AiUsageWindow, MongoAiUsageLedgerQueries,
    },
    ai_usage_ledger_reads::{self as reads, AiUsageLedgerReadError, LedgerField},
    bson_compat::normalize_document,
    credit_policy::JsDate,
    js_string::JsString,
    lossless_json::JsonValue,
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

const DAY: i64 = 86_400_000;
const NOW: i64 = 1_793_275_200_000; // Exact fixture milliseconds, no wall clock.
fn date(value: i64) -> JsDate {
    JsDate::from_millis(value as f64)
}
fn pacing() -> AiUsagePacingHistoryInput {
    AiUsagePacingHistoryInput {
        channel_id: "channel".into(),
        customer_id: "customer".into(),
        plan_tier: JsonValue::String("free".into()),
        account_created_at: None,
        now: Some(date(NOW)),
    }
}
fn transaction_input() -> AiUsageLedgerTransactionsInput {
    AiUsageLedgerTransactionsInput {
        channel_id: "channel".into(),
        customer_id: "customer".into(),
        window: AiUsageWindow {
            from: "metadata unused".into(),
            to: "metadata unused".into(),
            time_zone: "UTC".into(),
            start_timestamp: date(NOW - DAY),
            end_timestamp_exclusive: date(NOW + DAY),
            days: vec![],
        },
    }
}
fn state() -> Document {
    doc! {"coverageStart":DateTime::from_millis(0),"backfilledAt":DateTime::from_millis(1),"reportVersion":0}
}
fn receipt() -> Document {
    doc! {"entryId":"receipt","requestId":Bson::Null,"occurredAt":DateTime::from_millis(NOW),
    "entryKind":"usage","category":"tts","operation":"synthesis","source":Bson::Null,
    "adjustmentType":Bson::Null,"provider":"piper","model":Bson::Null,"quantity":1,
    "unit":"characters","credits":2,"resourceType":"speech","resourceId":Bson::Null,"itemized":true}
}
fn pacing_query(input: &AiUsagePacingHistoryInput) -> queries::PacingHistoryQuery {
    let preparation = queries::prepare_pacing_history(input, date(NOW));
    queries::pacing_history_query(&preparation, reads::decode_state(Some(state())).as_ref())
        .unwrap()
        .unwrap()
}
fn value<'a>(transaction: &'a AiUsageTransaction, key: &str) -> &'a LedgerField {
    transaction.get(key).unwrap()
}

#[test]
fn pipeline_uses_daily_schema_identity_inclusive_dates_and_strict_expiry() {
    let mut input = pacing();
    input.channel_id = JsString::from_units(vec![0x61, 0xd800, 0x62]);
    input.customer_id = " customer ".into();
    let query = pacing_query(&input);
    assert_eq!(query.pipeline.len(), 2);
    assert_eq!(
        query.pipeline[0],
        doc! {"$match":{
        "channelID":"a�b","customerId":" customer ","date":{"$gte":query.from.clone(),"$lte":query.to.clone()},
        "expiresAt":{"$gt":DateTime::from_millis(NOW)}}}
    );
    assert_eq!(
        query.pipeline[1],
        doc! {"$group":{"_id":Bson::Null,"totalSpentCredits":{"$sum":"$spentCredits"}}}
    );
    assert_eq!(input.channel_id.units(), vec![0x61, 0xd800, 0x62]);
    assert!(
        queries::decode_pacing_history(&query, &[])
            .unwrap()
            .total_spent_credits
            == 0.0
    );
}

#[test]
fn retention_floor_account_age_fractional_days_and_optional_fields() {
    for (tier, days) in [("free", 30), ("premium", 60), ("pro", 90), ("PRO", 30)] {
        let mut input = pacing();
        input.plan_tier = JsonValue::String(tier.into());
        let preparation = queries::prepare_pacing_history(&input, JsDate::invalid());
        assert_eq!(preparation.retention_days, days);
        assert_eq!(
            preparation.history_start.timestamp_millis(),
            Some(NOW.div_euclid(DAY) * DAY - (days - 1) * DAY)
        );
    }
    let mut input = pacing();
    input.account_created_at = Some(date(NOW - 5 * DAY / 2));
    let query = pacing_query(&input);
    let result = queries::decode_pacing_history(&query, &[doc! {"totalSpentCredits":10}]).unwrap();
    assert_eq!(result.day_count, 2.5);
    assert_eq!(result.average_daily_credits, 4.0);
    assert_eq!(result.total_spent_credits, 10.0);
    assert_eq!(result.active_day_count, None);
    let JsonValue::Object(fields) = result.as_value() else {
        panic!()
    };
    assert_eq!(
        fields
            .iter()
            .map(|(k, _)| k.as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "averageDailyCredits",
            "totalSpentCredits",
            "dayCount",
            "from",
            "to"
        ]
    );
    for created in [NOW, NOW + DAY] {
        input.account_created_at = Some(date(created));
        assert_eq!(
            queries::decode_pacing_history(&pacing_query(&input), &[])
                .unwrap()
                .day_count,
            1.0
        );
    }
    input.account_created_at = Some(JsDate::invalid());
    assert_eq!(
        queries::prepare_pacing_history(&input, date(NOW)).history_start,
        queries::prepare_pacing_history(&pacing(), date(NOW)).history_start
    );
    input.now = None;
    assert_eq!(
        queries::prepare_pacing_history(&input, date(NOW + 1)).now,
        date(NOW + 1)
    );
}

#[test]
fn pacing_state_short_circuits_and_date_errors_follow_source_order() {
    let mut input = pacing();
    input.now = Some(JsDate::invalid());
    let preparation = queries::prepare_pacing_history(&input, date(NOW));
    assert!(
        queries::pacing_history_query(&preparation, None)
            .unwrap()
            .is_none()
    );
    let empty = reads::decode_state(Some(Document::new())).unwrap();
    assert!(matches!(
        queries::pacing_history_query(&preparation, Some(&empty)),
        Err(AiUsageLedgerReadError::TypeError {
            field: "coverageStart",
            method: "getTime"
        })
    ));
    let valid = reads::decode_state(Some(state())).unwrap();
    assert!(matches!(
        queries::pacing_history_query(&preparation, Some(&valid)),
        Err(AiUsageLedgerReadError::RangeError {
            field: "historyStart"
        })
    ));
    input.now = Some(date(NOW));
    let preparation = queries::prepare_pacing_history(&input, date(NOW));
    let late =
        reads::decode_state(Some(doc! {"coverageStart":DateTime::from_millis(NOW)})).unwrap();
    assert!(
        queries::pacing_history_query(&preparation, Some(&late))
            .unwrap()
            .is_none()
    );
    let invalid =
        reads::decode_state(Some(doc! {"coverageStart":DateTime::from_millis(i64::MAX)})).unwrap();
    assert!(
        queries::pacing_history_query(&preparation, Some(&invalid))
            .unwrap()
            .is_some(),
        "invalid Date > valid Date compares false; reportVersion is irrelevant"
    );
    input.now = Some(JsDate::from_millis(-8_640_000_000_000_000.0));
    assert!(
        queries::prepare_pacing_history(&input, date(NOW))
            .history_start
            .timestamp_millis()
            .is_none()
    );
}

#[test]
fn aggregate_number_fallback_nan_signed_zero_and_legacy_promotion() {
    let query = pacing_query(&pacing());
    for (input, wanted) in [
        (Bson::Null, 0.0_f64),
        (Bson::Boolean(false), 0.0),
        (Bson::Double(-0.0), 0.0),
        (Bson::Double(f64::NAN), 0.0),
        (Bson::Double(-5.0), 0.0),
        (Bson::String(" 0x10 ".into()), 16.0),
        (Bson::Array(vec![3.into()]), 3.0),
        (Bson::Decimal128("3.0000000000000001".parse().unwrap()), 3.0),
        (Bson::Int64(9_007_199_254_740_993), 9_007_199_254_740_992.0),
    ] {
        let got =
            queries::decode_pacing_history(&query, &[doc! {"totalSpentCredits":input}]).unwrap();
        assert_eq!(got.total_spent_credits.to_bits(), wanted.to_bits());
    }
    for input in [
        Bson::String("NaN".into()),
        Bson::Decimal128("NaN".parse().unwrap()),
        Bson::Document(Document::new()),
    ] {
        assert!(
            queries::decode_pacing_history(&query, &[doc! {"totalSpentCredits":input}])
                .unwrap()
                .total_spent_credits
                .is_nan()
        );
    }
    assert!(matches!(
        queries::decode_pacing_history(
            &query,
            &[doc! {"totalSpentCredits":{"toString":Bson::Null}}]
        ),
        Err(AiUsageLedgerReadError::CoercionTypeError(_))
    ));
    assert_eq!(
        queries::decode_pacing_history(
            &query,
            &[doc! {"totalSpentCredits":1}, doc! {"totalSpentCredits":999}]
        )
        .unwrap()
        .total_spent_credits,
        1.0
    );
}

#[test]
fn transaction_query_is_original_sort_and_half_open_window() {
    let mut input = transaction_input();
    input.customer_id = " customer ".into();
    let query = queries::ledger_transactions_query(&input, date(NOW)).unwrap();
    assert_eq!(
        query.filter,
        doc! {"channelID":"channel","customerId":" customer ",
        "occurredAt":{"$gte":DateTime::from_millis(NOW-DAY),"$lt":DateTime::from_millis(NOW+DAY)},
        "expiresAt":{"$gt":DateTime::from_millis(NOW)}}
    );
    assert_eq!(query.sort, doc! {"occurredAt":-1,"entryId":-1});
    input.window.start_timestamp = JsDate::invalid();
    input.window.end_timestamp_exclusive = JsDate::invalid();
    assert!(matches!(
        queries::ledger_transactions_query(&input, JsDate::invalid()),
        Err(AiUsageLedgerReadError::CastError { path: "expiresAt" })
    ));
    assert!(matches!(
        queries::ledger_transactions_query(&input, date(NOW)),
        Err(AiUsageLedgerReadError::CastError { path: "occurredAt" })
    ));
}

#[test]
fn transaction_mapping_keeps_sixteen_own_fields_and_raw_legacy_values() {
    let mut raw = receipt();
    raw.remove("requestId");
    raw.insert("credits", "legacy credits");
    raw.insert("category", vec!["tts"]);
    raw.insert("quantity", doc! {"legacy":1});
    raw.insert("source", Bson::Double(-0.0));
    let got = queries::decode_ledger_transaction(&raw).unwrap();
    assert_eq!(
        got.ordered_fields()
            .iter()
            .map(|(key, _)| *key)
            .collect::<Vec<_>>(),
        [
            "id",
            "requestId",
            "occurredAt",
            "entryKind",
            "category",
            "operation",
            "source",
            "adjustmentType",
            "provider",
            "model",
            "quantity",
            "unit",
            "credits",
            "resourceType",
            "resourceId",
            "itemized"
        ]
    );
    assert_eq!(value(&got, "requestId"), &LedgerField::Undefined);
    assert_eq!(value(&got, "model"), &LedgerField::Value(Bson::Null));
    assert_eq!(value(&got, "source"), &LedgerField::Value(Bson::Null));
    assert_eq!(
        value(&got, "category"),
        &LedgerField::Value("uncategorized".into())
    );
    assert_eq!(
        value(&got, "credits"),
        &LedgerField::Value("legacy credits".into())
    );
    assert_eq!(
        value(&got, "quantity"),
        &LedgerField::Value(doc! {"legacy":1}.into())
    );
    assert_eq!(
        raw.get_str("credits").unwrap(),
        "legacy credits",
        "decoder does not mutate lean input"
    );
}

#[test]
fn classification_short_circuits_and_uses_existing_policy_with_bson_coercion() {
    let mut raw = receipt();
    raw.insert("entryKind", "adjustment");
    for (source, operation, wanted) in [
        ("polar_meter_credit", "refund", "native_grant"),
        ("free_credit_reset_worker", "", "monthly_reset"),
        ("admin_credit_grant", "", "manual_grant"),
        ("credit_pack_purchase", "", "purchased_pack"),
        ("", "refund", "refund"),
        ("", "correction", "correction"),
        ("activation", "", "activation"),
    ] {
        raw.insert("source", source);
        raw.insert("operation", operation);
        assert_eq!(
            value(
                &queries::decode_ledger_transaction(&raw).unwrap(),
                "adjustmentType"
            ),
            &LedgerField::Value(wanted.into())
        );
    }
    raw.insert("source", doc! {"toString":Bson::Null});
    raw.insert("adjustmentType", "bogus");
    assert_eq!(
        value(
            &queries::decode_ledger_transaction(&raw).unwrap(),
            "adjustmentType"
        ),
        &LedgerField::Value("bogus".into()),
        "truthy adjustmentType returns unchanged, even if not a valid classification token"
    );
    raw.insert("adjustmentType", Bson::Null);
    assert!(matches!(
        queries::decode_ledger_transaction(&raw),
        Err(AiUsageLedgerReadError::CoercionTypeError(_))
    ));
    raw.insert("entryKind", "usage");
    assert_eq!(
        value(
            &queries::decode_ledger_transaction(&raw).unwrap(),
            "adjustmentType"
        ),
        &LedgerField::Value(Bson::Null)
    );
    raw.insert("entryKind", "adjustment");
    raw.insert(
        "source",
        Bson::Binary(mongodb::bson::Binary {
            subtype: mongodb::bson::spec::BinarySubtype::Generic,
            bytes: b"admin_credit_grant".to_vec(),
        }),
    );
    raw.insert("operation", "");
    assert_eq!(
        value(
            &queries::decode_ledger_transaction(&raw).unwrap(),
            "adjustmentType"
        ),
        &LedgerField::Value("manual_grant".into())
    );
    raw.insert("source", Bson::Null);
    raw.insert("reason", "Free benefits");
    assert_eq!(
        value(
            &queries::decode_ledger_transaction(&raw).unwrap(),
            "adjustmentType"
        ),
        &LedgerField::Value("activation".into())
    );
}

#[test]
fn transaction_iso_and_mapping_order_preserve_first_failure() {
    let mut raw = receipt();
    raw.insert("entryKind", "adjustment");
    raw.insert("source", doc! {"toString":Bson::Null});
    raw.remove("occurredAt");
    assert!(matches!(
        queries::decode_ledger_transaction(&raw),
        Err(AiUsageLedgerReadError::TypeError {
            field: "occurredAt",
            method: "toISOString"
        })
    ));
    raw.insert("occurredAt", DateTime::from_millis(i64::MAX));
    assert!(matches!(
        queries::decode_ledger_transaction(&raw),
        Err(AiUsageLedgerReadError::RangeError {
            field: "occurredAt"
        })
    ));
    let mut first = receipt();
    first.insert("occurredAt", Bson::Null);
    assert!(matches!(
        queries::decode_ledger_transactions(&[first, raw]),
        Err(AiUsageLedgerReadError::TypeError { .. })
    ));
}

fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn unhex(value: &str) -> Vec<u8> {
    assert_eq!(value.len() % 2, 0);
    value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|v| u8::from_str_radix(std::str::from_utf8(v).unwrap(), 16).unwrap())
        .collect()
}
fn bson_document(value: &str) -> Document {
    Document::from_reader(Cursor::new(unhex(value))).unwrap()
}
fn fixture_property<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value["$object"]
        .as_array()
        .unwrap()
        .iter()
        .find_map(|pair| (pair[0] == key).then_some(&pair[1]))
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
        JsDate::from_millis(v.parse().unwrap())
    })
}
fn fixture_json(value: &Value) -> JsonValue {
    if value.is_null() || value.get("$undefined").is_some() {
        return JsonValue::Null;
    }
    if let Some(value) = value.as_bool() {
        return JsonValue::Bool(value);
    }
    if let Some(value) = value.get("$f64") {
        return JsonValue::Number(f64::from_bits(
            u64::from_str_radix(value.as_str().unwrap(), 16).unwrap(),
        ));
    }
    if value.get("$utf16").is_some() {
        return JsonValue::String(fixture_string(value));
    }
    if let Some(values) = value.get("$array") {
        return JsonValue::Array(
            values
                .as_array()
                .unwrap()
                .iter()
                .map(fixture_json)
                .collect(),
        );
    }
    JsonValue::Object(
        value["$object"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pair| {
                (
                    JsString::from(pair[0].as_str().unwrap()),
                    fixture_json(&pair[1]),
                )
            })
            .collect(),
    )
}
fn encoded_string(value: &str) -> Value {
    json!({"$utf16":value.encode_utf16().collect::<Vec<_>>()})
}
fn encoded_number(value: f64) -> Value {
    json!({"$f64":format!("{:016x}",value.to_bits())})
}
fn encoded_json(value: &JsonValue) -> Value {
    match value {
        JsonValue::Null => Value::Null,
        JsonValue::Bool(v) => json!(v),
        JsonValue::Number(v) => encoded_number(*v),
        JsonValue::String(v) => json!({"$utf16":v.units()}),
        JsonValue::Array(v) => json!({"$array":v.iter().map(encoded_json).collect::<Vec<_>>()}),
        JsonValue::Object(v) => {
            json!({"$object":v.iter().map(|(k,v)|json!([k.as_str().unwrap(),encoded_json(v)])).collect::<Vec<_>>()})
        }
    }
}
fn encoded_wrapper(value: &Bson) -> Value {
    // BSON3.1's optional serde_json feature is disabled. Compare actual wrapper
    // bytes, never into_canonical_extjson or an assumed common wrapper class.
    let bytes = doc! {"value":value.clone()}.to_vec().unwrap();
    json!({"$bsonWire":bytes.iter().map(|b|format!("{b:02x}")).collect::<String>()})
}
fn encoded_bson(value: &Bson) -> Value {
    match value {
        Bson::Undefined => json!({"$undefined":true}),
        Bson::Null => Value::Null,
        Bson::Boolean(v) => json!(v),
        Bson::String(v) | Bson::Symbol(v) => encoded_string(v),
        Bson::Int32(v) => encoded_number(f64::from(*v)),
        Bson::Double(v) => encoded_number(*v),
        Bson::Int64(v) => {
            let mut promoted = doc! {"v":*v};
            normalize_document(&mut promoted);
            match promoted.get("v").unwrap() {
                Bson::Int64(_) => encoded_wrapper(value),
                other => encoded_bson(other),
            }
        }
        Bson::DateTime(v) => {
            json!({"$date":JsDate::from_millis(v.timestamp_millis() as f64).timestamp_millis().map(|v|v.to_string())})
        }
        Bson::Array(v) => json!({"$array":v.iter().map(encoded_bson).collect::<Vec<_>>()}),
        // Node promotes valid DBRef documents to the installed BSON wrapper;
        // these fixture documents already use its canonical field order.
        Bson::Document(v)
            if matches!(v.get("$ref"), Some(Bson::String(_))) && v.contains_key("$id") =>
        {
            encoded_wrapper(value)
        }
        Bson::Document(v) => {
            json!({"$object":v.iter().map(|(k,v)|json!([k,encoded_bson(v)])).collect::<Vec<_>>()})
        }
        Bson::DbPointer(_) => {
            // DbPointer's Rust fields are crate-private. Inspect this fixture
            // wrapper's actual serialized bytes, then compare Node's DBRef
            // promotion/rewrite rather than pretending its class stayed 0x0c.
            let wire = doc! {"value":value.clone()}.to_vec().unwrap();
            assert_eq!(wire[4], 12);
            assert_eq!(&wire[5..11], b"value\0");
            let length = i32::from_le_bytes(wire[11..15].try_into().unwrap()) as usize;
            let namespace = std::str::from_utf8(&wire[15..15 + length - 1]).unwrap();
            let oid = mongodb::bson::oid::ObjectId::from_bytes(
                wire[15 + length..27 + length].try_into().unwrap(),
            );
            let parts = namespace.split('.').collect::<Vec<_>>();
            let document = if parts.len() == 2 {
                doc! {"$ref":parts[1],"$id":oid,"$db":parts[0]}
            } else {
                doc! {"$ref":namespace,"$id":oid}
            };
            encoded_wrapper(&Bson::Document(document))
        }
        // Default Node BSON creates native RegExp, whose ordinary own-key
        // enumeration is empty; it is not a BSON wrapper at this boundary.
        Bson::RegularExpression(_) => json!({"$object":[]}),
        _ => encoded_wrapper(value),
    }
}
fn encoded_transaction(value: &AiUsageTransaction) -> Value {
    json!({"$object":value.ordered_fields().iter().map(|(key,value)|json!([key,
        value.as_bson().map_or(json!({"$undefined":true}),encoded_bson)])).collect::<Vec<_>>()})
}

fn source_fixture() -> Value {
    let directory = std::env::var("DIMA_AI_LEDGER_QUERIES_REFERENCE_DIR")
        .expect("explicit external source fixture directory");
    let directory = Path::new(&directory).canonicalize().unwrap();
    let base = Path::new(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    assert!(!directory.starts_with(&base));
    let bytes = std::fs::read(directory.join("ai_usage_ledger_queries_reference.json")).unwrap();
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
        std::env::var("DIMA_AI_LEDGER_QUERIES_NODE_BINARY").expect("pinned oracle Node binary");
    assert_eq!(metadata["nodeSha256"], hash(std::fs::read(node).unwrap()));
    let dependency = std::env::var("DIMA_AI_LEDGER_QUERIES_NODE_DEPENDENCY_ROOT")
        .expect("explicit read-only Node dependency root");
    let dependency = Path::new(&dependency);
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
            assert!(
                !path
                    .components()
                    .any(|p| matches!(p, std::path::Component::ParentDir))
            );
            assert_eq!(
                package[digest],
                hash(std::fs::read(dependency.join(path)).unwrap())
            );
        }
    }
    for (file, digest) in metadata["hashes"].as_object().unwrap() {
        let relative = Path::new(file);
        assert!(!relative.is_absolute());
        assert!(
            !relative
                .components()
                .any(|p| matches!(p, std::path::Component::ParentDir))
        );
        let path = if file.starts_with("node_modules/") {
            dependency.join(file)
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
        let path = Path::new(file);
        assert!(path.starts_with("node_modules"));
        assert!(
            !path
                .components()
                .any(|p| matches!(p, std::path::Component::ParentDir))
        );
        assert_eq!(
            *digest,
            hash(std::fs::read(dependency.join(path)).unwrap()),
            "dependency drift {file}"
        );
    }
    for (key, file) in [
        ("extractedSha256", "ai_usage_ledger_queries_extracted.ts"),
        ("typecheckSha256", "ai_usage_ledger_queries_typecheck.ts"),
        ("compiledSha256", "ai_usage_ledger_queries_compiled.cjs"),
    ] {
        let bytes = std::fs::read(directory.join(file)).unwrap();
        assert!(!bytes.is_empty());
        assert_eq!(metadata[key], hash(bytes));
    }
    let declarations = metadata["declarations"].as_array().unwrap();
    assert_eq!(declarations.len(), 22);
    for declaration in declarations {
        let source =
            std::fs::read_to_string(base.join(declaration["file"].as_str().unwrap())).unwrap();
        let from = declaration["startByte"].as_u64().unwrap() as usize;
        let to = declaration["endByte"].as_u64().unwrap() as usize;
        let text = format!("{}\n", &source[from..to]);
        assert_eq!(declaration["text"], text);
        assert_eq!(declaration["sha256"], hash(text));
    }
    for name in ["loadAiUsagePacingHistory", "loadAiUsageLedgerTransactions"] {
        let declaration = declarations.iter().find(|d| d["name"] == name).unwrap();
        assert_eq!(declaration["kind"], "FunctionDeclaration");
        assert_eq!(declaration["exported"], true);
        let parameters = declaration["parameters"].as_array().unwrap();
        assert_eq!(parameters.len(), 1);
        let input = parameters[0]["type"].as_str().unwrap();
        assert!(input.contains("channelID: string"));
        assert!(input.contains("customerId: string"));
        assert!(
            declaration["returnType"]
                .as_str()
                .unwrap()
                .starts_with("Promise<")
        );
    }
    let observed = metadata["observedImports"].as_array().unwrap();
    assert_eq!(observed.len(), 3);
    assert!(observed.iter().all(|i| i["name"] == "mongoose"));
    assert_eq!(metadata["schemaPaths"]["receipts"]["occurredAt"], "Date");
    assert_eq!(metadata["schemaPaths"]["daily"]["expiresAt"], "Date");
    assert_eq!(metadata["schemaPaths"]["state"]["coverageStart"], "Date");
    assert_eq!(
        metadata["caseCount"].as_u64().unwrap() as usize,
        root["records"].as_array().unwrap().len()
    );
    assert!(root["records"].as_array().unwrap().len() > 300);
    root
}

#[test]
#[ignore = "requires complete external actual-source oracle and pinned read-only Node dependency hashes"]
fn actual_source_complete_replay() {
    let root = source_fixture();
    let mut counts = [0usize; 2];
    for row in root["records"].as_array().unwrap() {
        let id = row["id"].as_str().unwrap();
        let input = &row["input"];
        let channel = fixture_string(fixture_property(input, "channelID").unwrap());
        let customer = fixture_string(fixture_property(input, "customerId").unwrap());
        let now = JsDate::from_millis(row["clock"].as_str().unwrap().parse().unwrap());
        let calls = row["calls"].as_array().unwrap();
        let is_pacing = row["op"] == "loadAiUsagePacingHistory";
        let result: Result<Value, AiUsageLedgerReadError> = if is_pacing {
            counts[0] += 1;
            let request = AiUsagePacingHistoryInput {
                channel_id: channel,
                customer_id: customer,
                plan_tier: fixture_json(fixture_property(input, "planTier").unwrap()),
                account_created_at: fixture_property(input, "accountCreatedAt")
                    .filter(|v| v.get("$date").is_some())
                    .map(fixture_date),
                now: fixture_property(input, "now").map(fixture_date),
            };
            let prepared = queries::prepare_pacing_history(&request, now);
            let state_query = reads::state_query(&prepared.state_input);
            assert!(!calls.is_empty(), "state call {id}");
            assert_eq!(calls[0]["kind"], "state.findOne");
            assert_eq!(
                state_query.filter,
                bson_document(calls[0]["filterHex"].as_str().unwrap()),
                "state filter {id}"
            );
            assert_eq!(
                state_query.projection,
                bson_document(calls[0]["projectionHex"].as_str().unwrap()),
                "state projection {id}"
            );
            assert_eq!(calls[0]["optionsKeys"], json!(["projection"]));
            assert_eq!(
                row["clockReads"],
                if request.now.is_none() { 1 } else { 0 },
                "clock {id}"
            );
            if row["fail"] == "state.findOne" {
                assert_eq!(calls.len(), 1);
                assert_eq!(row["error"]["name"], "MongoServerError");
                continue;
            }
            let state = reads::decode_state(row["stateHex"].as_str().map(bson_document));
            match queries::pacing_history_query(&prepared, state.as_ref()) {
                Ok(None) => {
                    assert_eq!(calls.len(), 1, "short circuit {id}");
                    Ok(Value::Null)
                }
                Err(error) => {
                    assert_eq!(calls.len(), 1, "ordered ISO error {id}");
                    Err(error)
                }
                Ok(Some(query)) => {
                    assert_eq!(calls.len(), 2, "aggregate call {id}");
                    assert_eq!(calls[1]["kind"], "daily.aggregate");
                    let pipeline = doc! {"pipeline":query.pipeline.clone()};
                    assert_eq!(
                        pipeline,
                        bson_document(calls[1]["pipelineHex"].as_str().unwrap()),
                        "pipeline {id}"
                    );
                    assert_eq!(calls[1]["optionsKeys"], json!([]));
                    if row["fail"] == "daily.aggregate" {
                        assert_eq!(row["error"]["name"], "MongoServerError");
                        continue;
                    }
                    let rows = row["replyHex"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| bson_document(v.as_str().unwrap()))
                        .collect::<Vec<_>>();
                    queries::decode_pacing_history(&query, &rows)
                        .map(|v| encoded_json(&v.as_value()))
                }
            }
        } else {
            assert_eq!(row["op"], "loadAiUsageLedgerTransactions");
            counts[1] += 1;
            let window = fixture_property(input, "window").unwrap();
            let request = AiUsageLedgerTransactionsInput {
                channel_id: channel,
                customer_id: customer,
                window: AiUsageWindow {
                    from: fixture_string(fixture_property(window, "from").unwrap()),
                    to: fixture_string(fixture_property(window, "to").unwrap()),
                    time_zone: fixture_string(fixture_property(window, "timeZone").unwrap()),
                    start_timestamp: fixture_date(
                        fixture_property(window, "startTimestamp").unwrap(),
                    ),
                    end_timestamp_exclusive: fixture_date(
                        fixture_property(window, "endTimestampExclusive").unwrap(),
                    ),
                    days: fixture_property(window, "days").unwrap()["$array"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(fixture_string)
                        .collect(),
                },
            };
            assert_eq!(row["clockReads"], 1, "clock {id}");
            match queries::ledger_transactions_query(&request, now) {
                Err(error) => {
                    assert!(calls.is_empty(), "cast error precedes driver {id}");
                    Err(error)
                }
                Ok(query) => {
                    assert_eq!(calls.len(), 1);
                    assert_eq!(calls[0]["kind"], "receipts.find");
                    assert_eq!(
                        query.filter,
                        bson_document(calls[0]["filterHex"].as_str().unwrap()),
                        "transaction filter {id}"
                    );
                    assert_eq!(
                        query.sort,
                        bson_document(calls[0]["sortHex"].as_str().unwrap()),
                        "sort {id}"
                    );
                    assert_eq!(calls[0]["optionsKeys"], json!(["sort"]));
                    if row["fail"] == "receipts.find" {
                        assert_eq!(row["error"]["name"], "MongoServerError");
                        continue;
                    }
                    let rows = row["replyHex"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| bson_document(v.as_str().unwrap()))
                        .collect::<Vec<_>>();
                    queries::decode_ledger_transactions(&rows).map(
                        |v| json!({"$array":v.iter().map(encoded_transaction).collect::<Vec<_>>()}),
                    )
                }
            }
        };
        match result {
            Ok(actual) => {
                assert!(
                    row["error"].is_null(),
                    "unexpected source error {id}: {}",
                    row["error"]
                );
                assert_eq!(actual, row["result"], "complete result {id}");
            }
            Err(error) => {
                assert_eq!(
                    error.javascript_exception_name(),
                    row["error"]["name"].as_str(),
                    "error category {id}: {error}"
                );
                if let AiUsageLedgerReadError::CastError { path } = error {
                    assert_eq!(row["error"]["path"], path, "cast path {id}");
                }
            }
        }
    }
    assert!(counts[0] > 80 && counts[1] > 200);
}

fn guarded_fixture_configuration() -> (String, String, String) {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").expect("explicit task owner"),
        "dimabot-migration"
    );
    let uri = std::env::var("DIMA_TEST_MONGO_URI").expect("explicit private URI");
    assert_eq!(
        uri, "mongodb://ai-ledger-queries-mongo-fixture:27017",
        "dedicated fixture alias only"
    );
    let token = std::env::var("DIMA_AI_LEDGER_QUERIES_RESOURCE_TOKEN")
        .expect("unique loweralnum task token");
    assert!(
        (8..=32).contains(&token.len())
            && token
                .bytes()
                .all(|v| v.is_ascii_lowercase() || v.is_ascii_digit())
    );
    let database = std::env::var("DIMA_AI_LEDGER_QUERIES_TEST_DATABASE").expect("owned database");
    assert_eq!(database, format!("ai_ledger_queries_test_{token}"));
    (uri, database, token)
}
async fn assert_owned(database: &Database, token: &str) {
    assert_eq!(database.name(), format!("ai_ledger_queries_test_{token}"));
    let owner = database
        .collection::<Document>("_ledger_queries_test_owner")
        .find_one(doc! {"_id":"owner"})
        .await
        .unwrap()
        .expect("ownership marker");
    assert_eq!(owner.get_str("owner").unwrap(), "dimabot-migration");
    assert_eq!(owner.get_str("token").unwrap(), token);
}
async fn configure_failure(admin: &Database, data: Document) {
    admin
        .run_command(doc! {"configureFailPoint":"failCommand","mode":{"times":1},"data":data})
        .await
        .expect("fresh owned Mongo must use enableTestCommands=1");
}

#[tokio::test]
#[ignore = "requires fresh privately owned Mongo with enableTestCommands=1; never production or a shared server"]
async fn private_mongo_adapters_data_pool_errors_and_cancellation() {
    let (uri, database_name, token) = guarded_fixture_configuration();
    let commands = Arc::new(Mutex::new(Vec::<(String, Document)>::new()));
    let pools = Arc::new(AtomicUsize::new(0));
    let connections = Arc::new(AtomicUsize::new(0));
    let mut options = ClientOptions::parse(&uri).await.unwrap();
    options.direct_connection = Some(true);
    options.max_pool_size = Some(2);
    options.retry_reads = Some(false);
    let recording = commands.clone();
    options.command_event_handler = Some(EventHandler::callback(move |event: CommandEvent| {
        if let CommandEvent::Started(event) = event {
            recording
                .lock()
                .unwrap()
                .push((event.command_name, event.command));
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
    let admin = client.database("admin");
    assert!(
        database.list_collection_names().await.unwrap().is_empty(),
        "fresh task database required"
    );
    database
        .create_collection("_ledger_queries_test_owner")
        .await
        .unwrap();
    database
        .collection::<Document>("_ledger_queries_test_owner")
        .insert_one(doc! {
        "_id":"owner","owner":"dimabot-migration","token":token.clone()})
        .await
        .unwrap();
    let result=AssertUnwindSafe(async {
        assert_owned(&database,&token).await;
        let before=commands.lock().unwrap().len();let adapter=MongoAiUsageLedgerQueries::new(&database);let cloned=adapter.clone();
        assert_eq!(commands.lock().unwrap().len(),before,"constructor and clone issue no commands");
        assert_eq!(adapter.daily_collection().name(),"ai_usage_dailies");
        assert_eq!(adapter.receipt_collection().name(),"ai_usage_receipts");
        assert!(adapter.load_ai_usage_pacing_history_at(&pacing(),date(NOW)).await.unwrap().is_none());
        assert!(adapter.load_ai_usage_ledger_transactions_at(&transaction_input(),date(NOW)).await.unwrap().is_empty());
        let states=adapter.state_reads().collection();let daily=adapter.daily_collection();let receipts=adapter.receipt_collection();
        let mut s=state();s.insert("channelID","channel");s.insert("customerId","customer");states.insert_one(s).await.unwrap();
        let history=pacing_query(&pacing());
        let valid_day=|key:&str,spent:Bson,expires:Bson|doc! {"channelID":"channel","customerId":"customer",
            "date":key,"spentCredits":spent,"expiresAt":expires};
        let future=Bson::DateTime(DateTime::from_millis(NOW+DAY));
        let expired=Bson::DateTime(DateTime::from_millis(NOW));
        let last=&history.to;let first=&history.from;
        daily.insert_many(vec![
            valid_day(first,2.into(),future.clone()),valid_day(last,3.into(),future.clone()),
            valid_day(last,100.into(),expired),valid_day("0000-01-01",100.into(),future.clone()),
            valid_day("9999-01-01",100.into(),future.clone()),
            valid_day(last,"200".into(),future.clone()), // $sum ignores nonnumeric legacy values.
            valid_day(last,100.into(),"9999-01-01".into()), // query Date type bracketing.
        ]).await.unwrap();
        let mut other=valid_day(last,100.into(),future.clone());other.insert("customerId","other");daily.insert_one(other).await.unwrap();
        let got=adapter.load_ai_usage_pacing_history_at(&pacing(),date(NOW)).await.unwrap().unwrap();
        assert_eq!(got.total_spent_credits,5.0,"inclusive date window, strict expiry, identity, Mongo $sum");
        let before=commands.lock().unwrap().iter().filter(|(name,_)|name=="aggregate").count();
        states.update_one(doc! {"channelID":"channel"},doc! {"$set":{"coverageStart":DateTime::from_millis(NOW)}}).await.unwrap();
        assert!(adapter.load_ai_usage_pacing_history_at(&pacing(),date(NOW)).await.unwrap().is_none());
        assert_eq!(commands.lock().unwrap().iter().filter(|(name,_)|name=="aggregate").count(),before,"coverage short circuit skips aggregate");
        states.update_one(doc! {"channelID":"channel"},doc! {"$set":{"coverageStart":"legacy"}}).await.unwrap();
        assert!(matches!(adapter.load_ai_usage_pacing_history_at(&pacing(),date(NOW)).await,
            Err(AiUsageLedgerReadError::TypeError{field:"coverageStart",method:"getTime"})));
        states.update_one(doc! {"channelID":"channel"},doc! {"$set":state()}).await.unwrap();
        let mut decimal=valid_day(last,Bson::Decimal128("2.5".parse().unwrap()),future.clone());decimal.insert("_id","decimal-fixture");
        daily.insert_one(decimal).await.unwrap();
        assert_eq!(adapter.load_ai_usage_pacing_history_at(&pacing(),date(NOW)).await.unwrap().unwrap().total_spent_credits,7.5);
        daily.delete_one(doc! {"_id":"decimal-fixture"}).await.unwrap();
        let mut input=transaction_input();
        let make_receipt=|id:&str,occurred:Bson,expiry:Bson|{
            let mut row=receipt();row.insert("entryId",id);row.insert("channelID","channel");row.insert("customerId","customer");
            row.insert("occurredAt",occurred);row.insert("expiresAt",expiry);row
        };
        receipts.insert_many(vec![
            make_receipt("a",Bson::DateTime(DateTime::from_millis(NOW)),future.clone()),
            make_receipt("z",Bson::DateTime(DateTime::from_millis(NOW)),future.clone()),
            make_receipt("start",Bson::DateTime(DateTime::from_millis(NOW-DAY)),future.clone()),
            make_receipt("end",Bson::DateTime(DateTime::from_millis(NOW+DAY)),future.clone()),
            make_receipt("old",Bson::DateTime(DateTime::from_millis(NOW-DAY-1)),future.clone()),
            make_receipt("expired",Bson::DateTime(DateTime::from_millis(NOW)),Bson::DateTime(DateTime::from_millis(NOW))),
            make_receipt("string-date","2026-10-29".into(),future.clone()),
            make_receipt("number-date",NOW.into(),future.clone()),
            make_receipt("string-expiry",Bson::DateTime(DateTime::from_millis(NOW)),"9999-01-01".into()),
        ]).await.unwrap();
        let result=cloned.load_ai_usage_ledger_transactions_at(&input,date(NOW)).await.unwrap();
        let ids=result.iter().map(|r|match value(r,"id") {LedgerField::Value(Bson::String(v))=>v.as_str(),_=>panic!()}).collect::<Vec<_>>();
        assert_eq!(ids,["z","a","start"]);
        let query=queries::ledger_transactions_query(&input,date(NOW)).unwrap();
        let find=commands.lock().unwrap().iter().rev().find(|(name,command)|name=="find" && command.get_str("find").ok()==Some("ai_usage_receipts")).unwrap().1.clone();
        assert_eq!(find.get_document("filter").unwrap(),&query.filter);assert_eq!(find.get_document("sort").unwrap(),&query.sort);
        let aggregate=commands.lock().unwrap().iter().rev().find(|(name,_)|name=="aggregate").unwrap().1.clone();
        assert_eq!(aggregate.get_array("pipeline").unwrap(),&history.pipeline.iter().cloned().map(Bson::Document).collect::<Vec<_>>());
        receipts.update_one(doc! {"entryId":"z"},doc! {"$unset":{"requestId":""},"$set":{"credits":"legacy","quantity":{"object":1}}}).await.unwrap();
        let result=adapter.load_ai_usage_ledger_transactions_at(&input,date(NOW)).await.unwrap();
        assert_eq!(value(&result[0],"requestId"),&LedgerField::Undefined);assert_eq!(value(&result[0],"credits"),&LedgerField::Value("legacy".into()));
        // Mongo array matching can return a non-Date whole field. Source lean
        // mapping calls toISOString on that whole array and must fail.
        receipts.insert_one(make_receipt("array-date",Bson::Array(vec![DateTime::from_millis(NOW).into()]),future.clone())).await.unwrap();
        assert!(matches!(adapter.load_ai_usage_ledger_transactions_at(&input,date(NOW)).await,
            Err(AiUsageLedgerReadError::TypeError{field:"occurredAt",method:"toISOString"})));
        receipts.delete_one(doc! {"entryId":"array-date"}).await.unwrap();
        // Force a subsequent getMore failure with a malformed lean Date in the
        // first batch. exec() must reject before docs.map sees that Date.
        let extra=(0..105).map(|index|make_receipt(&format!("late-fixture-{index:03}"),
            Bson::DateTime(DateTime::from_millis(NOW)),future.clone())).collect::<Vec<_>>();
        receipts.insert_many(extra).await.unwrap();
        receipts.insert_one(make_receipt("zz-array-date",Bson::Array(vec![DateTime::from_millis(NOW).into()]),future.clone())).await.unwrap();
        configure_failure(&admin,doc! {"failCommands":["getMore"],"errorCode":12345}).await;
        assert!(matches!(adapter.load_ai_usage_ledger_transactions_at(&input,date(NOW)).await,
            Err(AiUsageLedgerReadError::Mongo(_))),"late cursor failure wins over first-batch mapper error");
        receipts.delete_many(doc! {"$or":[{"entryId":{"$regex":"^late-fixture-"}},{"entryId":"zz-array-date"}]}).await.unwrap();
        let baseline=connections.load(Ordering::SeqCst);
        for _ in 0..6 {
            cloned.load_ai_usage_ledger_transactions_at(&input,date(NOW)).await.unwrap();
            cloned.load_ai_usage_pacing_history_at(&pacing(),date(NOW)).await.unwrap();
        }
        assert_eq!(pools.load(Ordering::SeqCst),1,"all three collections and clones reuse supplied pool");
        assert_eq!(connections.load(Ordering::SeqCst),baseline,"serial reads reuse existing connection");
        for target in ["find","aggregate"] {
            configure_failure(&admin,doc! {"failCommands":[target],"errorCode":12345}).await;
            let error=if target=="find" {
                adapter.load_ai_usage_ledger_transactions_at(&input,date(NOW)).await.unwrap_err()
            }else{adapter.load_ai_usage_pacing_history_at(&pacing(),date(NOW)).await.unwrap_err()};
            let AiUsageLedgerReadError::Mongo(error)=error else{panic!("original driver error")};
            assert!(matches!(error.kind.as_ref(),mongodb::error::ErrorKind::Command(error) if error.code==12345));
        }
        // A state read error must win over invalid date formatting.
        let mut invalid=pacing();invalid.now=Some(JsDate::invalid());
        configure_failure(&admin,doc! {"failCommands":["find"],"errorCode":12345}).await;
        assert!(matches!(adapter.load_ai_usage_pacing_history_at(&invalid,date(NOW)).await,Err(AiUsageLedgerReadError::Mongo(_))));
        let before=commands.lock().unwrap().len();input.window.end_timestamp_exclusive=JsDate::invalid();
        assert!(matches!(adapter.load_ai_usage_ledger_transactions_at(&input,date(NOW)).await,Err(AiUsageLedgerReadError::CastError{..})));
        assert_eq!(commands.lock().unwrap().len(),before,"cast failures precede commands");input=transaction_input();
        drop(adapter.load_ai_usage_ledger_transactions_at(&input,date(NOW)));
        drop(adapter.load_ai_usage_pacing_history_at(&pacing(),date(NOW)));
        assert_eq!(commands.lock().unwrap().len(),before,"dropping an unpolled future has no I/O");
        // Abort both transaction cursor and pacing aggregate futures after the
        // real command reached the fresh private Mongo failpoint. Observation
        // bounds are fixture safeguards, never adapter polling or retry policy.
        for target in ["find","aggregate"] {
            configure_failure(&admin,doc! {"failCommands":[target],"blockConnection":true,"blockTimeMS":1000}).await;
            let before=commands.lock().unwrap().iter().filter(|(name,_)|name==target).count();
            let reading=cloned.clone();
            let pending=tokio::spawn(async move {
                if target=="find" {reading.load_ai_usage_ledger_transactions_at(&transaction_input(),date(NOW)).await.map(|_|())}
                else {reading.load_ai_usage_pacing_history_at(&pacing(),date(NOW)).await.map(|_|())}
            });
            tokio::time::timeout(Duration::from_secs(5),async {
                while commands.lock().unwrap().iter().filter(|(name,_)|name==target).count()==before {tokio::task::yield_now().await;}
            }).await.expect("blocked real command reached driver");
            pending.abort();assert!(pending.await.unwrap_err().is_cancelled());
            tokio::time::timeout(Duration::from_secs(5),adapter.load_ai_usage_ledger_transactions_at(&input,date(NOW))).await.unwrap().unwrap();
            tokio::time::timeout(Duration::from_secs(5),adapter.load_ai_usage_pacing_history_at(&pacing(),date(NOW))).await.unwrap().unwrap();
        }
        for collection in [states,daily,receipts] {
            assert!(collection.list_indexes().await.unwrap().try_collect::<Vec<_>>().await.unwrap().iter()
                .all(|i|i.options.as_ref().and_then(|o|o.name.as_deref())==Some("_id_")),"read adapters install no schema indexes");
        }
        assert_eq!(states.count_documents(doc! {}).await.unwrap(),1);
        assert_eq!(daily.count_documents(doc! {}).await.unwrap(),8);
        assert_eq!(receipts.count_documents(doc! {}).await.unwrap(),9);
        let forbidden=["insert","update","delete","create","createIndexes","drop","findAndModify"];
        // Fixture setup/mutations are explicit above. Following a final marker,
        // the adapters must emit only their read commands.
        let before=commands.lock().unwrap().len();
        adapter.load_ai_usage_pacing_history_at(&pacing(),date(NOW)).await.unwrap();
        adapter.load_ai_usage_ledger_transactions_at(&input,date(NOW)).await.unwrap();
        assert!(commands.lock().unwrap()[before..].iter().all(|(name,_)|!forbidden.contains(&name.as_str())));
    }).catch_unwind().await;
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
        std::panic::resume_unwind(panic)
    }
    failpoint_cleanup.expect("owned failpoint cleanup");
    if let Err(panic) = cleanup {
        std::panic::resume_unwind(panic)
    }
}

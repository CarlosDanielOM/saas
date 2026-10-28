#![cfg(feature = "domain-event-runtime")]

use dima_rust::{
    domain_event_contracts::{DomainEventSubject, DomainEventSubjectKind, time::native_date_iso},
    domain_event_runtime::{
        self as runtime, DomainEventJournal, JournalConfig, NormalizedDomainEvent,
        identity::resolve_domain_event_owner,
        journal::prepare_journal_document,
        polar::NormalizePolarWebhookInput,
        telemetry::{JournalTelemetry, TraceContext, with_telemetry_context},
        wakeups::{DomainEventWakeupListener, DomainEventWakeups, WakeupConfig},
    },
};
use mongodb::{
    Client,
    bson::{Bson, DateTime, Document, doc, oid::ObjectId},
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

fn generic(receipt: &str) -> NormalizedDomainEvent {
    NormalizedDomainEvent {
        input: json!({"source":"migration-fixture","sourceEventId":receipt,"type":"fixture.event","topic":"domain","schemaVersion":1,"subject":{"provider":"fixture","kind":"resource","id":"resource"},"payload":{"bits":9_007_199_254_740_991_u64,"fraction":1.25},"retentionSeconds":1}),
        native_occurred_at: None,
    }
}

#[test]
fn native_document_preparation_preserves_mongoose_dates_numbers_and_expiry_floor() {
    let now = DateTime::from_millis(1_700_000_000_123);
    let event = generic("receipt");
    let document = prepare_journal_document(&event, now).unwrap();
    assert_eq!(document.get_datetime("occurredAt").unwrap(), &now);
    assert_eq!(document.get_datetime("journaledAt").unwrap(), &now);
    assert_eq!(
        document
            .get_datetime("expiresAt")
            .unwrap()
            .timestamp_millis(),
        now.timestamp_millis() + 60_000
    );
    assert!(document.get_bool("dispatchPending").unwrap());
    assert!(matches!(
        document.get("schemaVersion"),
        Some(Bson::Int32(1))
    ));
    assert!(matches!(
        document.get_document("payload").unwrap().get("bits"),
        Some(Bson::Double(_))
    ));
    assert!(!document.contains_key("ownerUserId"));
    let mut invalid = event.clone();
    invalid.input["schemaVersion"] = json!(1.5);
    assert!(prepare_journal_document(&invalid, now).is_err());
}

#[test]
fn twitch_normalizer_matches_all_frozen_source_provider_types() {
    let corpus: Value =
        serde_json::from_str(include_str!("fixtures/domain_contracts_cases.json")).unwrap();
    for case in corpus["cases"].as_array().unwrap().iter().filter(|case| {
        case["name"]
            .as_str()
            .unwrap_or("")
            .starts_with("all-twitch/")
    }) {
        let expected = &case["input"];
        let source = json!({"messageId":expected["sourceEventId"],"messageTimestamp":expected["metadata"]["messageTimestamp"],"source":expected["source"],"subscription":expected["payload"]["subscription"],"event":expected["payload"]["event"]});
        assert_eq!(
            runtime::twitch::normalize_twitch_eventsub_domain_event(&source)
                .unwrap()
                .unwrap()
                .input,
            *expected,
            "{}",
            case["name"]
        );
    }
    assert!(
        runtime::twitch::normalize_twitch_eventsub_domain_event(
            &json!({"subscription":{"type":"future.type"}})
        )
        .unwrap()
        .is_none()
    );
    assert!(runtime::twitch::normalize_twitch_eventsub_domain_event(&json!({"messageId":"notice","subscription":{"type":"channel.chat.notification"},"event":{"broadcaster_user_id":"receiver","source_broadcaster_user_id":"origin"}})).unwrap().is_none());
}

#[test]
fn polar_sdk_mapping_uses_native_dates_and_omits_private_fields() {
    let now = DateTime::from_millis(1_700_000_000_123);
    let input = NormalizePolarWebhookInput {
        webhook_id: "signed-receipt".into(),
        event_type: "order.paid".into(),
        timestamp: now,
        data: doc! {"id":"order","customerId":"customer","productId":"product","subscriptionId":"sub","paid":true,"status":"paid","totalAmount":600,
        "subscription":{"id":"sub","recurringInterval":"year","currentPeriodEnd":now},"customer":{"id":"customer","externalId":"0123456789abcdef01234567","email":"private@example.test","metadata":{"twitch_user_id":"channel"}},"billingName":"Private name"},
    };
    let event = runtime::polar::normalize_polar_domain_event(&input).unwrap();
    assert_eq!(event.native_occurred_at, Some(now));
    assert_eq!(event.input["payload"]["cadence"], "yearly");
    assert_eq!(
        event.input["payload"]["periodEnd"],
        native_date_iso(now.timestamp_millis())
    );
    assert_eq!(
        event.input["metadata"]["externalCustomerId"],
        "0123456789abcdef01234567"
    );
    assert_eq!(event.input["metadata"]["legacyTwitchChannelId"], "channel");
    assert!(event.input.get("channelID").is_none());
    assert!(!event.input.to_string().contains("private@example.test"));
    let mut invalid = input.clone();
    invalid
        .data
        .get_document_mut("subscription")
        .unwrap()
        .insert("currentPeriodEnd", native_date_iso(now.timestamp_millis()));
    assert!(runtime::polar::normalize_polar_domain_event(&invalid).is_err());
    let unknown = NormalizePolarWebhookInput {
        webhook_id: "unknown-receipt".into(),
        event_type: "product.created".into(),
        timestamp: now,
        data: doc! {"id":"product","createdAt":now,"missing":Bson::Undefined},
    };
    let event = runtime::polar::normalize_polar_domain_event(&unknown).unwrap();
    assert_eq!(event.input["metadata"]["unmapped"], true);
    assert_eq!(
        event.input["payload"]["providerData"]["createdAt"],
        native_date_iso(now.timestamp_millis())
    );
    assert!(
        event.input["payload"]["providerData"]
            .get("missing")
            .is_none()
    );
}

#[test]
fn frozen_typescript_runtime_normalizers_match_native_results() {
    fn bson(value: &Value) -> Bson {
        match value {
            Value::Null => Bson::Null,
            Value::Bool(b) => Bson::Boolean(*b),
            Value::String(s) => Bson::String(s.clone()),
            Value::Number(n) => dima_rust::utils::bson_compat::js_number(n.as_f64().unwrap()),
            Value::Array(items) => Bson::Array(items.iter().map(bson).collect()),
            Value::Object(fields) => Bson::Document(
                fields
                    .iter()
                    .map(|(key, value)| (key.clone(), bson(value)))
                    .collect(),
            ),
        }
    }
    fn set_date(value: &mut Bson, parts: &[&str]) {
        if parts.is_empty() {
            let timestamp = value
                .as_str()
                .and_then(dima_rust::domain_event_contracts::time::parse_contract_time)
                .unwrap();
            *value = Bson::DateTime(DateTime::from_millis(timestamp));
            return;
        };
        match value {
            Bson::Document(fields) => set_date(fields.get_mut(parts[0]).unwrap(), &parts[1..]),
            Bson::Array(items) => {
                set_date(&mut items[parts[0].parse::<usize>().unwrap()], &parts[1..])
            }
            _ => panic!("date path is not a container"),
        }
    }
    fn equal(left: &Value, right: &Value) -> bool {
        match (left, right) {
            (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
            (Value::Array(left), Value::Array(right)) => {
                left.len() == right.len()
                    && left
                        .iter()
                        .zip(right)
                        .all(|(left, right)| equal(left, right))
            }
            (Value::Object(left), Value::Object(right)) => {
                left.len() == right.len()
                    && left
                        .iter()
                        .all(|(key, value)| right.get(key).is_some_and(|right| equal(value, right)))
            }
            _ => left == right,
        }
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/domain_event_runtime_cases.json");
    let corpus: Value = serde_json::from_str(
        &std::fs::read_to_string(path)
            .expect("generate source runtime corpus in the owned Node fixture container first"),
    )
    .unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    assert!(cases.len() >= 25);
    for case in cases {
        let input = &case["input"];
        let result = if case["operation"] == "twitch" {
            runtime::twitch::normalize_twitch_eventsub_domain_event(input)
                .map(|event| event.map(|event| event.input).unwrap_or(Value::Null))
        } else {
            let mut data = bson(&input["data"]);
            for path in case["sdkDates"].as_array().unwrap() {
                set_date(
                    &mut data,
                    &path.as_str().unwrap().split('.').collect::<Vec<_>>(),
                );
            }
            let input = NormalizePolarWebhookInput {
                webhook_id: input["webhookId"].as_str().unwrap().into(),
                event_type: input["eventType"].as_str().unwrap().into(),
                timestamp: DateTime::from_millis(
                    dima_rust::domain_event_contracts::time::parse_contract_time(
                        input["timestamp"].as_str().unwrap(),
                    )
                    .unwrap(),
                ),
                data: data.as_document().unwrap().clone(),
            };
            runtime::polar::normalize_polar_domain_event(&input).map(|event| event.input)
        };
        let actual = match result {
            Ok(result) => json!({"ok":true,"result":result}),
            Err(error) => json!({"ok":false,"error":error.to_string()}),
        };
        assert!(
            equal(&actual, &case["expected"]),
            "{}\nactual: {}\nexpected: {}",
            case["name"],
            actual,
            case["expected"]
        );
    }
}

async fn fixture() -> (Client, mongodb::Database, redis::Client) {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER")
            .ok()
            .as_deref(),
        Some("dimabot-migration"),
        "requires explicitly owned disposable resources"
    );
    let mongo =
        Client::with_uri_str(std::env::var("DIMA_TEST_MONGO_URI").expect("isolated fixture URI"))
            .await
            .unwrap();
    let database = mongo.database(&format!("domain_events_{}", uuid::Uuid::new_v4().simple()));
    let redis =
        redis::Client::open(std::env::var("DIMA_TEST_REDIS_URL").expect("isolated Redis URL"))
            .unwrap();
    (mongo, database, redis)
}

#[tokio::test]
#[ignore = "lead-owned disposable MongoDB and Redis fixtures only"]
async fn native_journal_races_owner_resolution_durability_wakeups_and_telemetry() {
    let (client, database, redis) = fixture().await;
    let config = WakeupConfig {
        timeout: Duration::from_millis(300),
        retry: Duration::from_millis(50),
        idle: Duration::from_millis(50),
        ..Default::default()
    };
    let wakeups = Arc::new(DomainEventWakeups::new(redis.clone(), config.clone()));
    let received = Arc::new(AtomicUsize::new(0));
    let observed = received.clone();
    let mut listener = DomainEventWakeupListener::start(
        redis.clone(),
        config,
        Arc::new(move || {
            observed.fetch_add(1, Ordering::Relaxed);
        }),
    );
    let telemetry = JournalTelemetry::new(redis.clone(), "api", true);
    let mut telemetry_task = telemetry.start().unwrap();
    let journal = DomainEventJournal::new(
        database.clone(),
        JournalConfig {
            wakeups: Some(wakeups.clone()),
            telemetry: Some(telemetry.clone()),
        },
    );
    let users = database.collection::<Document>("users");
    let owner = ObjectId::new();
    let other = ObjectId::new();
    users.insert_many([doc!{"_id":owner,"accounts":[{"type":"twitch","id":"channel"}],"polar_sh_customer_id":"customer"},doc!{"_id":other,"accounts":[{"type":"twitch","id":"other-channel"}],"polar_sh_customer_id":"different-customer"}]).await.unwrap();
    let streaming = DomainEventSubject {
        provider: "twitch".into(),
        kind: DomainEventSubjectKind::StreamingAccount,
        id: "channel".into(),
    };
    assert_eq!(
        resolve_domain_event_owner(&database, &streaming, None, None)
            .await
            .unwrap(),
        Some(owner.to_hex())
    );
    let polar = DomainEventSubject {
        provider: "polar".into(),
        kind: DomainEventSubjectKind::Customer,
        id: "customer".into(),
    };
    assert_eq!(
        resolve_domain_event_owner(&database, &polar, Some(&other.to_hex()), None)
            .await
            .unwrap(),
        Some(owner.to_hex())
    );
    let unknown = DomainEventSubject {
        id: "unlinked-customer".into(),
        ..polar.clone()
    };
    assert_eq!(
        resolve_domain_event_owner(&database, &unknown, Some(&other.to_hex()), Some("channel"))
            .await
            .unwrap(),
        None
    );
    let unlinked = ObjectId::new();
    users
        .insert_one(doc! {"_id":unlinked,"accounts":[{"type":"twitch","id":"legacy-channel"}]})
        .await
        .unwrap();
    assert_eq!(
        resolve_domain_event_owner(&database, &unknown, None, Some("legacy-channel"))
            .await
            .unwrap(),
        Some(unlinked.to_hex())
    );
    let event = generic("concurrent-receipt");
    let mut tasks = Vec::new();
    for _ in 0..24 {
        let journal = journal.clone();
        let event = event.clone();
        tasks.push(tokio::spawn(async move {
            journal.journal(&event).await.unwrap()
        }));
    }
    let mut results = Vec::new();
    for task in tasks {
        results.push(task.await.unwrap());
    }
    assert_eq!(results.iter().filter(|result| result.inserted).count(), 1);
    assert!(results.iter().all(|r| r.event == results[0].event));
    assert_eq!(
        journal.collection().count_documents(doc! {}).await.unwrap(),
        1
    );
    let mut changed = event.clone();
    changed.input["payload"] = json!({"replacement":true});
    let duplicate = journal.journal(&changed).await.unwrap();
    assert!(!duplicate.inserted);
    assert_eq!(duplicate.event, results[0].event);
    let indexes: Vec<_> = {
        use futures_util::TryStreamExt;
        journal
            .collection()
            .list_indexes()
            .await
            .unwrap()
            .try_collect()
            .await
            .unwrap()
    };
    assert!(indexes.iter().any(|index| index.keys == doc! {"eventKey":1}
        && index.options.as_ref().and_then(|o| o.unique) == Some(true)));
    assert!(
        indexes
            .iter()
            .any(|index| index.keys == doc! {"expiresAt":1}
                && index.options.as_ref().and_then(|o| o.expire_after) == Some(Duration::ZERO))
    );
    let context = TraceContext {
        trace_id: "a".repeat(32),
        span_id: "b".repeat(16),
        sampled: true,
        channel: "channel".into(),
        outcome: None,
    };
    let stream = json!({"messageId":"stream","messageTimestamp":"2026-09-05T12:00:00.000Z","subscription":{"type":"stream.online"},"event":{"id":"stream-id","broadcaster_user_id":"channel","started_at":"2026-09-05T12:00:00.000Z"}});
    let started = with_telemetry_context(
        context,
        runtime::ingest_twitch_domain_event(&journal, &stream),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        started.event.get_str("ownerUserId").unwrap(),
        owner.to_hex()
    );
    assert_eq!(
        started
            .event
            .get_document("metadata")
            .unwrap()
            .get_document("observability")
            .unwrap()
            .get_str("traceId")
            .unwrap(),
        "a".repeat(32)
    );
    assert_eq!(telemetry.pending_metrics().len(), 1);
    telemetry.flush().await;
    let mut connection = redis.get_multiplexed_async_connection().await.unwrap();
    let inbox: Vec<String> = redis::cmd("LRANGE")
        .arg("observability:v1:inbox")
        .arg(0)
        .arg(-1)
        .query_async(&mut connection)
        .await
        .unwrap();
    assert!(
        inbox
            .iter()
            .any(|row| row.contains("stream.started") && row.contains("lifecycle"))
    );
    let malformed = json!({"messageId":"bad","subscription":{"type":"channel.follow"},"event":{"broadcaster_user_id":"channel"}});
    assert!(
        runtime::ingest_twitch_domain_event(&journal, &malformed)
            .await
            .is_err()
    );
    assert_eq!(
        journal.collection().count_documents(doc! {}).await.unwrap(),
        2
    );
    for _ in 0..20 {
        if received.load(Ordering::Relaxed) > 0 {
            break;
        };
        wakeups.publish();
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(received.load(Ordering::Relaxed) > 0);
    assert!(
        !database
            .list_collection_names()
            .await
            .unwrap()
            .iter()
            .any(|name| name.contains("deliver") || name.contains("checkpoint")),
        "journal does not claim the dispatcher's state ownership"
    );
    // A dead optional hint endpoint cannot fail a durable journal write.
    let failed = Arc::new(DomainEventWakeups::new(
        redis::Client::open("redis://127.0.0.1:1").unwrap(),
        WakeupConfig::default(),
    ));
    let without_cache = DomainEventJournal::new(
        database.clone(),
        JournalConfig {
            wakeups: Some(failed.clone()),
            telemetry: None,
        },
    );
    assert!(
        without_cache
            .journal(&generic("cache-down"))
            .await
            .unwrap()
            .inserted
    );
    failed.shutdown().await;
    wakeups.shutdown().await;
    listener.shutdown().await;
    telemetry_task.shutdown().await;
    database.drop().await.unwrap();
    client.shutdown().await;
}

#[tokio::test]
#[ignore = "explicit capped disposable benchmark only"]
async fn domain_event_durable_journal_benchmark() {
    let (client, database, _) = fixture().await;
    let journal = DomainEventJournal::new(database.clone(), JournalConfig::default());
    journal.initialize().await.unwrap();
    let iterations = std::env::var("DOMAIN_JOURNAL_BENCH_ITERATIONS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(1000);
    assert!(iterations > 0);
    let start = std::time::Instant::now();
    for i in 0..iterations {
        assert!(
            journal
                .journal(&generic(&format!("receipt-{i}")))
                .await
                .unwrap()
                .inserted
        )
    }
    let insert_ms = start.elapsed().as_secs_f64() * 1000.;
    let start = std::time::Instant::now();
    for i in 0..iterations {
        assert!(
            !journal
                .journal(&generic(&format!("receipt-{i}")))
                .await
                .unwrap()
                .inserted
        )
    }
    let duplicate_ms = start.elapsed().as_secs_f64() * 1000.;
    assert_eq!(
        journal.collection().count_documents(doc! {}).await.unwrap(),
        iterations
    );
    println!(
        "{}",
        json!({"implementation":"rust","workload":"domain-event-durable-journal","iterations":iterations,"inserted":iterations,"duplicates":iterations,"insertMs":insert_ms,"duplicateMs":duplicate_ms,"insertNsPerOperation":insert_ms*1e6/iterations as f64,"duplicateNsPerOperation":duplicate_ms*1e6/iterations as f64,"writeConcern":{"w":1,"j":true}})
    );
    database.drop().await.unwrap();
    client.shutdown().await;
}

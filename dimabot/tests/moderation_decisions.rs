#![cfg(feature = "moderation-decisions")]
use dima_rust::utils::{js_string::JsString, moderation::decisions::moderation_decision_id};

#[test]
fn identifier_uses_javascript_json_utf16_and_unambiguous_array_encoding() {
    assert_eq!(
        moderation_decision_id(&"a".into(), &"b".into(), &"c".into()),
        "fa1844c2988ad15ab7b49e0ece09684500fad94df916859fb9a43ff85f5bb477"
    );
    assert_eq!(
        moderation_decision_id(&"a|b".into(), &"c".into(), &"d".into()),
        "9180321629c560ce9e5d33930503de03b9f6ea357e1527faab1a742ec505be94"
    );
    assert_eq!(
        moderation_decision_id(&"a".into(), &"b|c".into(), &"d".into()),
        "3d2ec34f18bd6580cffbd10b4a29c4a204fc179c3564c681b4e9b206c53206e3"
    );
    assert_eq!(
        moderation_decision_id(
            &"😀".into(),
            &JsString::from_units(vec![0xd800]),
            &"x".into()
        ),
        "6db324c1c04581e36f58c65888a59df613e2c057cf46bcaa26453144652a74e3"
    );
}

#[test]
fn generated_undefined_uses_node_storage_policy_without_touching_unchanged_mixed_values() {
    use dima_rust::utils::{
        bson_json::compiler_bson_json,
        moderation::decisions::{prepare_creation, prepare_creation_for_storage},
    };
    use mongodb::bson::{Bson, DateTime, doc};
    use std::{collections::VecDeque, sync::Mutex};
    let input = doc! {"channelID":"c", "messageID":"m", "ruleID":"r", "mode":"literal", "deadline":DateTime::from_millis(1), "rule":{"variations":{"mode":"common", "allowSpaces":true, "entries":[
        {"term":"cat", "spellings":["cat"], "pattern":{"id":"p", "source":"cat", "boundary":"whole_word", "ignoreCase":true}, "version":"v", "unknownDate":DateTime::from_millis(77), "unknownUndefined":Bson::Undefined},
        {"term":"dog", "spellings":["dog"], "pattern":{"id":"q", "source":"dog", "boundary":"whole_word", "ignoreCase":true}, "version":"v", "allowSpaces":true, "unknownNan":Bson::Double(f64::NAN)},
        {"term":"bird", "spellings":["bird"], "symbolVersion":"old", "pattern":{"id":"r", "source":"bird", "boundary":"whole_word", "ignoreCase":true}, "version":"v"}
    ]}}};
    let raw = input.get("rule").unwrap().clone();
    let view = compiler_bson_json(&raw);
    let clock = source_reference::FixtureClock {
        values: Mutex::new(VecDeque::new()),
        last: Mutex::new(1),
    };
    let (filter, insert, now) = prepare_creation(
        input,
        "c".into(),
        "m".into(),
        "r".into(),
        raw,
        view.clone(),
        &clock,
    )
    .unwrap();
    let pre = insert
        .get_document("rule")
        .unwrap()
        .get_document("variations")
        .unwrap()
        .get_array("entries")
        .unwrap();
    let changed = pre[0].as_document().unwrap();
    assert!(matches!(
        changed.get("symbolVersion"),
        Some(Bson::Undefined)
    ));
    assert!(matches!(
        changed.get("unknownUndefined"),
        Some(Bson::Undefined)
    ));
    assert!(!pre[1].as_document().unwrap().contains_key("symbolVersion"));
    let storage = prepare_creation_for_storage(&filter, &insert, now, &view).unwrap();
    let entries = storage
        .get_document("rule")
        .unwrap()
        .get_document("variations")
        .unwrap()
        .get_array("entries")
        .unwrap();
    let first = entries[0].as_document().unwrap();
    let unchanged = entries[1].as_document().unwrap();
    let last = entries[2].as_document().unwrap();
    assert!(matches!(first.get("symbolVersion"), Some(Bson::Null)));
    assert!(matches!(
        first.get("unknownUndefined"),
        Some(Bson::Undefined)
    ));
    assert_eq!(
        first
            .get_datetime("unknownDate")
            .unwrap()
            .timestamp_millis(),
        77
    );
    assert!(!unchanged.contains_key("symbolVersion"));
    assert!(matches!(unchanged.get("unknownNan"),Some(Bson::Double(n)) if n.is_nan()));
    assert!(matches!(last.get("symbolVersion"), Some(Bson::Null)));
    let keys = last.keys().map(String::as_str).collect::<Vec<_>>();
    assert_eq!(
        keys,
        vec![
            "term",
            "spellings",
            "symbolVersion",
            "pattern",
            "version",
            "allowSpaces"
        ]
    );
}

#[tokio::test]
#[ignore = "requires task-owned keyword-mongo and a unique private namespace"]
async fn disposable_ready_backlog_deadline_fences_and_cancellation() {
    source_reference::guarded_cleanup(
        "ready",
        false,
        disposable_ready_backlog_deadline_fences_and_cancellation_body(),
    )
    .await;
}
async fn disposable_ready_backlog_deadline_fences_and_cancellation_body() {
    use dima_rust::utils::moderation::decisions::ModerationDecisions;
    use mongodb::{
        Client,
        bson::{Bson, DateTime, Document, doc},
    };
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    let (uri, namespace, base) = source_reference::owned_fixture();
    let client = Client::with_uri_str(uri).await.unwrap();
    let db = client.database(&format!("{base}_ready"));
    assert!(db.list_collection_names().await.unwrap().is_empty());
    db.collection::<Document>("_decision_owner")
        .insert_one(doc! {"_id":"owner", "owner":"dimabot-migration", "namespace": &namespace})
        .await
        .unwrap();
    let rows = db.collection::<Document>("moderation_decisions");
    let service = ModerationDecisions::new(db.clone());
    let input = doc! {"channelID":"channel", "userID":"u", "username":"name", "messageID":"message", "messageText":"hello", "ruleID":"rule", "rule":{"id":"rule", "semantic":{"thresholdPercent":Bson::Null, "unknown":mongodb::bson::DateTime::from_millis(77)}, "empty":{}}, "settingsVersion":1, "matches":[], "context":[], "mode":"semantic", "deadline":DateTime::from_millis(4_102_444_801_000_i64)};
    let (created, raced) =
        tokio::join!(service.create(input.clone()), service.create(input.clone()));
    let created = match (created, raced) {
        (Ok(Some(a)), Ok(Some(b))) => {
            assert_eq!(a, b);
            a
        }
        (Ok(Some(a)), Err(e)) | (Err(e), Ok(Some(a))) => {
            assert!(
                e.to_string().contains("E11000"),
                "unexpected concurrent upsert error: {e}"
            );
            a
        }
        pair => panic!("no durable winning upsert: {pair:?}"),
    };
    assert_eq!(created.get_str("state").unwrap(), "pending");
    assert_eq!(created.get_str("verdict").unwrap(), "uncertain");
    assert_eq!(created.get_str("model").unwrap(), "respan/span-01-lite");
    let rule = created.get_document("rule").unwrap();
    assert_eq!(
        rule.get_document("semantic")
            .unwrap()
            .get_i32("thresholdPercent")
            .unwrap(),
        85
    );
    assert_eq!(
        rule.get_document("semantic")
            .unwrap()
            .get_datetime("unknown")
            .unwrap()
            .timestamp_millis(),
        77
    );
    assert_eq!(rule.get_document("empty").unwrap().len(), 0);
    assert_eq!(created.get_str("reviewSource").unwrap(), "rule");
    let mut changed = input.clone();
    changed.insert("messageText", "changed");
    changed.insert("mode", "literal");
    assert_eq!(service.create(changed).await.unwrap().unwrap(), created);
    let clock = std::sync::Arc::new(source_reference::FixtureClock {
        values: std::sync::Mutex::new(std::collections::VecDeque::from([
            4_102_444_800_123,
            4_102_444_800_140,
        ])),
        last: std::sync::Mutex::new(4_102_444_800_123),
    });
    let timed = ModerationDecisions::new(db.clone()).with_clock(clock);
    let json = dima_rust::utils::lossless_json::parse_json(r#"{"channelID":"\ud800", "messageID":"emoji😀", "ruleID":"r", "rule":{"id":"r", "semantic":{"thresholdPercent":0}}, "mode":"semantic"}"#).unwrap();
    let lossless = timed
        .create_lossless(&json, DateTime::from_millis(4_102_444_801_000))
        .await
        .unwrap()
        .unwrap();
    let lossless_id = moderation_decision_id(
        &JsString::from_units(vec![0xd800]),
        &"emoji😀".into(),
        &"r".into(),
    );
    assert_eq!(lossless.get_str("_id").unwrap(), lossless_id);
    assert_eq!(lossless.get_str("channelID").unwrap(), "�");
    assert_eq!(
        lossless
            .get_datetime("createdAt")
            .unwrap()
            .timestamp_millis(),
        4_102_444_800_123
    );
    assert_eq!(
        lossless
            .get_datetime("expiresAt")
            .unwrap()
            .timestamp_millis(),
        4_102_444_800_140 + 180 * 86_400_000_i64
    );
    assert_eq!(
        lossless
            .get_document("rule")
            .unwrap()
            .get_document("semantic")
            .unwrap()
            .get_i32("thresholdPercent")
            .unwrap(),
        0
    );
    let compiled_input = doc! {"channelID":"channel", "messageID":"compiled", "ruleID":"r", "rule": {
    "id":"r", "variations":{"mode":"common", "allowSpaces":true, "entries":[
        {"term":"cat", "spellings":["cat"], "pattern":{"id":"p", "source":"cat", "boundary":"whole_word", "ignoreCase":true}, "version":"v", "marker":DateTime::from_millis(77)},
        {"term":"dog", "spellings":["dog"], "pattern":{"id":"q", "source":"dog", "boundary":"whole_word", "ignoreCase":true}, "version":"v", "allowSpaces":true, "marker":DateTime::from_millis(88)}
    ]}}, "mode":"literal", "deadline":DateTime::from_millis(4_102_444_801_000_i64)};
    let compiled = service.create(compiled_input).await.unwrap().unwrap();
    let entries = compiled
        .get_document("rule")
        .unwrap()
        .get_document("variations")
        .unwrap()
        .get_array("entries")
        .unwrap();
    let changed = entries[0].as_document().unwrap();
    let unchanged = entries[1].as_document().unwrap();
    assert!(matches!(changed.get("symbolVersion"), Some(Bson::Null)));
    assert!(!unchanged.contains_key("symbolVersion"));
    assert_eq!(
        changed.get_datetime("marker").unwrap().timestamp_millis(),
        77
    );
    assert_eq!(
        unchanged.get_datetime("marker").unwrap().timestamp_millis(),
        88
    );
    let now = || {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    };
    let deadline = || DateTime::from_millis(now() + 1_000);
    for i in 0..20 {
        rows.insert_one(doc! {"_id":format!("ready-{i}"), "state":"completed", "status":"matched"})
            .await
            .unwrap();
    }
    let start = Instant::now();
    for i in 0..20 {
        let row = service
            .await_semantic_decision(Bson::String(format!("ready-{i}")), deadline())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.get_str("status").unwrap(), "matched");
    }
    assert!(
        start.elapsed() < Duration::from_millis(1200),
        "ready backlog should not incur per-item polling sleeps"
    );
    for state in ["pending", "processing"] {
        rows.insert_one(
            doc! {"_id":state, "state":state, "consequence":{"status":"none", "kept":true}},
        )
        .await
        .unwrap();
        let start = Instant::now();
        let result = service
            .await_semantic_decision(
                Bson::String(state.into()),
                DateTime::from_millis(now() + 110),
            )
            .await
            .unwrap()
            .unwrap();
        assert!(start.elapsed() >= Duration::from_millis(90));
        assert!(start.elapsed() < Duration::from_millis(650));
        assert_eq!(result.get_str("status").unwrap(), "timeout");
        assert!(
            result
                .get_document("consequence")
                .unwrap()
                .get_bool("kept")
                .unwrap()
        );
        let late = rows
            .update_one(
                doc! {"_id":state, "state":"processing"},
                doc! {"$set":{"state":"completed", "status":"worker"}},
            )
            .await
            .unwrap();
        assert_eq!(late.modified_count, 0);
    }
    rows.insert_one(doc! {"_id":"done", "state":"completed", "status":"worker"})
        .await
        .unwrap();
    let done = service
        .await_semantic_decision("done".into(), DateTime::from_millis(now() - 1))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(done.get_str("status").unwrap(), "worker");
    assert!(
        service
            .await_semantic_decision("missing".into(), DateTime::from_millis(now() - 1))
            .await
            .unwrap()
            .is_none()
    );
    rows.insert_one(doc! {"_id":"cancel", "state":"pending"})
        .await
        .unwrap();
    let task = tokio::spawn(async move {
        service
            .await_semantic_decision("cancel".into(), DateTime::from_millis(now() + 120))
            .await
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    task.abort();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(
        rows.find_one(doc! {"_id":"cancel"})
            .await
            .unwrap()
            .unwrap()
            .get_str("state")
            .unwrap(),
        "pending"
    );
    let marker = db
        .collection::<Document>("_decision_owner")
        .find_one(doc! {"_id":"owner"})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(marker.get_str("namespace").unwrap(), namespace);
    db.drop().await.unwrap();
}

#[tokio::test]
#[ignore = "requires task-owned keyword-mongo with enableTestCommands=1 and private failpoints"]
async fn disposable_failure_order_and_no_application_retries() {
    source_reference::guarded_cleanup(
        "failures",
        true,
        disposable_failure_order_and_no_application_retries_body(),
    )
    .await;
}
async fn disposable_failure_order_and_no_application_retries_body() {
    use dima_rust::utils::moderation::decisions::ModerationDecisions;
    use mongodb::{
        Client,
        bson::{DateTime, Document, doc},
        event::{EventHandler, command::CommandEvent},
        options::ClientOptions,
    };
    use std::sync::{Arc, Mutex};
    let (uri, namespace, base) = source_reference::owned_fixture();
    assert_eq!(
        std::env::var("DIMA_VARIATION_JOBS_FAILPOINT_OWNER").unwrap(),
        namespace
    );
    let app = format!("{namespace}_failure");
    let calls = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut options = ClientOptions::parse(&uri).await.unwrap();
    options.direct_connection = Some(true);
    options.retry_reads = Some(false);
    options.retry_writes = Some(false);
    options.app_name = Some(app.clone());
    let seen = calls.clone();
    options.command_event_handler = Some(EventHandler::callback(move |event: CommandEvent| {
        if let CommandEvent::Started(event) = event
            && (event.command_name == "find" || event.command_name == "update")
        {
            seen.lock().unwrap().push(event.command_name);
        }
    }));
    let client = Client::with_options(options).unwrap();
    let db = client.database(&format!("{base}_failures"));
    assert!(db.list_collection_names().await.unwrap().is_empty());
    db.collection::<Document>("_decision_owner")
        .insert_one(doc! {"_id":"owner", "owner":"dimabot-migration", "namespace": &namespace})
        .await
        .unwrap();
    let service = ModerationDecisions::new(db.clone());
    let admin = client.database("admin");
    let enable = |command: &str, skip: i32| doc! {"configureFailPoint":"failCommand", "mode":{"skip":skip}, "data":{"failCommands":[command], "errorCode":12345, "appName":&app}};
    let disable = doc! {"configureFailPoint":"failCommand", "mode":"off"};
    calls.lock().unwrap().clear();
    admin.run_command(enable("find", 0)).await.unwrap();
    assert!(
        service
            .await_semantic_decision("x".into(), DateTime::from_millis(i64::MAX))
            .await
            .is_err()
    );
    admin.run_command(disable.clone()).await.unwrap();
    assert_eq!(*calls.lock().unwrap(), vec!["find"]);
    calls.lock().unwrap().clear();
    admin.run_command(enable("update", 0)).await.unwrap();
    assert!(
        service
            .await_semantic_decision("x".into(), DateTime::from_millis(0))
            .await
            .is_err()
    );
    admin.run_command(disable.clone()).await.unwrap();
    assert_eq!(*calls.lock().unwrap(), vec!["update"]);
    calls.lock().unwrap().clear();
    admin.run_command(enable("find", 0)).await.unwrap();
    assert!(
        service
            .await_semantic_decision("x".into(), DateTime::from_millis(0))
            .await
            .is_err()
    );
    admin.run_command(disable).await.unwrap();
    assert_eq!(*calls.lock().unwrap(), vec!["update", "find"]);
    let marker = db
        .collection::<Document>("_decision_owner")
        .find_one(doc! {"_id":"owner"})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(marker.get_str("namespace").unwrap(), namespace);
    db.drop().await.unwrap();
}

#[path = "support/moderation_decisions.rs"]
mod source_reference;

#[test]
#[ignore = "requires independently hashed actual-source fixture"]
fn source_reference_hash_and_pre_cast_creation_replay() {
    use dima_rust::utils::{
        bson_json::compiler_bson_json, moderation::decisions::prepare_creation,
    };
    use mongodb::bson::Bson;
    use std::{collections::VecDeque, sync::Mutex};
    let fixture = source_reference::reference();
    let cases = fixture["cases"].as_array().unwrap();
    let (mut hashes, mut creates) = (0, 0);
    for case in cases {
        let operation = case["operation"].as_str().unwrap();
        if operation != "moderationDecisionID" && operation != "createModerationDecision" {
            continue;
        }
        let args = case["args"]["items"].as_array().unwrap();
        if operation == "moderationDecisionID" {
            hashes += 1;
            let actual = moderation_decision_id(
                &source_reference::tagged_string(&args[0]),
                &source_reference::tagged_string(&args[1]),
                &source_reference::tagged_string(&args[2]),
            );
            assert_eq!(
                actual,
                source_reference::tagged_string(&case["outcome"]["value"]).to_utf8_lossy(),
                "{}",
                case["name"]
            );
            continue;
        }
        creates += 1;
        let input_tag = &args[0];
        let input = source_reference::decode(input_tag)
            .as_document()
            .unwrap()
            .clone();
        let channel =
            source_reference::tagged_string(source_reference::member(input_tag, "channelID"));
        let message =
            source_reference::tagged_string(source_reference::member(input_tag, "messageID"));
        let rule_id =
            source_reference::tagged_string(source_reference::member(input_tag, "ruleID"));
        let raw_rule = input.get("rule").unwrap().clone();
        let view = compiler_bson_json(&raw_rule);
        let values = case["options"]["clockReads"]
            .as_array()
            .map(|a| a.iter().map(|n| n.as_i64().unwrap()).collect())
            .unwrap_or_else(VecDeque::new);
        let clock = source_reference::FixtureClock {
            values: Mutex::new(values),
            last: Mutex::new(1_700_000_000_123),
        };
        let result = prepare_creation(input, channel, message, rule_id, raw_rule, view, &clock);
        let call = case["calls"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["method"] == "findOneAndUpdate");
        if let Some(call) = call {
            let (filter, insert, _) = result.unwrap_or_else(|e| panic!("{}: {e}", case["name"]));
            let actual_args = call["args"]["items"].as_array().unwrap();
            assert_eq!(
                Bson::Document(filter),
                source_reference::decode(&actual_args[0]),
                "{} filter",
                case["name"]
            );
            let expected_update = source_reference::decode(&actual_args[1]);
            assert_eq!(
                source_reference::stringify_projection(Bson::Document(insert)),
                source_reference::stringify_projection(
                    expected_update
                        .as_document()
                        .unwrap()
                        .get("$setOnInsert")
                        .unwrap()
                        .clone()
                ),
                "{} JSON.stringify insert projection",
                case["name"]
            );
        } else {
            assert!(result.is_err(), "{} should fail before Mongo", case["name"]);
        }
    }
    assert_eq!(hashes, 6);
    assert_eq!(creates, 19);
}

#[tokio::test]
#[ignore = "requires independently hashed source reference and task-owned keyword-mongo with failpoints"]
async fn source_reference_await_results_against_disposable_mongo() {
    source_reference::guarded_cleanup(
        "replay",
        true,
        source_reference_await_results_against_disposable_mongo_body(),
    )
    .await;
}
async fn source_reference_await_results_against_disposable_mongo_body() {
    use dima_rust::utils::moderation::decisions::ModerationDecisions;
    use mongodb::{
        Client,
        bson::{DateTime, Document, doc},
        options::ClientOptions,
    };
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    let (uri, namespace, base) = source_reference::owned_fixture();
    assert_eq!(
        std::env::var("DIMA_VARIATION_JOBS_FAILPOINT_OWNER").unwrap(),
        namespace
    );
    let app = format!("{base}_replay");
    let mut options = ClientOptions::parse(&uri).await.unwrap();
    options.direct_connection = Some(true);
    options.retry_reads = Some(false);
    options.retry_writes = Some(false);
    options.app_name = Some(app.clone());
    let client = Client::with_options(options).unwrap();
    let db = client.database(&format!("{base}_replay"));
    assert!(db.list_collection_names().await.unwrap().is_empty());
    db.collection::<Document>("_decision_owner")
        .insert_one(doc! {"_id":"owner", "owner":"dimabot-migration", "namespace":&namespace})
        .await
        .unwrap();
    let rows = db.collection::<Document>("moderation_decisions");
    let admin = client.database("admin");
    let service = ModerationDecisions::new(db.clone());
    let fixture = source_reference::reference();
    let now = || {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    };
    let mut checked = 0;
    for case in fixture["cases"].as_array().unwrap() {
        if case["operation"] != "awaitSemanticDecision" {
            continue;
        }
        checked += 1;
        let name = case["name"].as_str().unwrap();
        rows.delete_many(doc! {}).await.unwrap();
        let mut delay = 0_i64;
        let mut initial = None;
        let mut future = None;
        let mut fault = None;
        match name {
            "await-ready" => {
                delay = 1000;
                initial = Some(doc! {"state":"completed", "status":"violation"});
            }
            "await-pending-completed" => {
                delay = 1000;
                initial = Some(doc! {"state":"pending"});
                future = Some(doc! {"state":"completed", "status":"worker"});
            }
            "await-processing-completed" => {
                delay = 1000;
                initial = Some(doc! {"state":"processing"});
                future = Some(doc! {"state":"completed", "status":"worker"});
            }
            "await-missing-then-completed" => {
                delay = 1000;
                future = Some(doc! {"state":"completed"});
            }
            "await-at-deadline" => initial = Some(doc! {"state":"pending"}),
            "await-past-deadline" | "await-timeout-then-missing" => {}
            "await-near-deadline-pending" => {
                delay = 1;
                initial = Some(doc! {"state":"pending"});
            }
            "await-near-deadline-processing" => {
                delay = 79;
                initial = Some(doc! {"state":"processing"});
            }
            "await-fence-race-completed" => {
                initial = Some(doc! {"state":"completed", "status":"worker"})
            }
            "await-query-error" => {
                delay = 1000;
                fault = Some("find");
            }
            "await-update-error" | "await-uncertain-write-no-retry" => fault = Some("update"),
            "await-final-read-error" => fault = Some("find"),
            "await-read-crosses-deadline-completed" => {
                delay = 1000;
                initial = Some(doc! {"state":"completed", "status":"worker"});
            }
            "await-read-crosses-deadline-pending" => {
                delay = 1;
                initial = Some(doc! {"state":"pending"});
            }
            _ => panic!("unhandled source await case: {name}"),
        }
        if let Some(mut row) = initial {
            row.insert("_id", "decision-id");
            rows.insert_one(row).await.unwrap();
        }
        let task = future.map(|mut row| {
            let rows = rows.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                row.insert("_id", "decision-id");
                rows.replace_one(doc! {"_id":"decision-id"}, row)
                    .upsert(true)
                    .await
                    .unwrap();
            })
        });
        if let Some(command) = fault {
            admin.run_command(doc! {"configureFailPoint":"failCommand", "mode":{"times":1}, "data":{"failCommands":[command], "errorCode":12345, "appName":&app}}).await.unwrap();
        }
        let outcome = service
            .await_semantic_decision("decision-id".into(), DateTime::from_millis(now() + delay))
            .await;
        admin
            .run_command(doc! {"configureFailPoint":"failCommand", "mode":"off"})
            .await
            .unwrap();
        if let Some(task) = task {
            task.await.unwrap();
        }
        if case["outcome"]["ok"] == false {
            assert!(outcome.is_err(), "{name}");
            continue;
        }
        let expected = source_reference::decode(&case["outcome"]["value"]);
        match expected {
            mongodb::bson::Bson::Null => assert!(outcome.unwrap().is_none(), "{name}"),
            mongodb::bson::Bson::Document(expected) => {
                let actual = outcome
                    .unwrap()
                    .unwrap_or_else(|| panic!("{name}: missing row"));
                for (key, value) in expected {
                    assert_eq!(actual.get(&key), Some(&value), "{name}: {key}");
                }
            }
            other => panic!("unexpected source outcome for {name}: {other:?}"),
        }
    }
    assert_eq!(checked, 16);
    let marker = db
        .collection::<Document>("_decision_owner")
        .find_one(doc! {"_id":"owner"})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(marker.get_str("namespace").unwrap(), namespace);
    db.drop().await.unwrap();
}

#[tokio::test]
#[ignore = "requires task-owned keyword-mongo with enableTestCommands=1"]
async fn disposable_read_crossing_deadline_returns_ready_or_fences_pending() {
    source_reference::guarded_cleanup(
        "crossing",
        true,
        disposable_read_crossing_deadline_returns_ready_or_fences_pending_body(),
    )
    .await;
}
async fn disposable_read_crossing_deadline_returns_ready_or_fences_pending_body() {
    use dima_rust::utils::moderation::decisions::ModerationDecisions;
    use mongodb::{
        Client,
        bson::{DateTime, Document, doc},
        event::{EventHandler, command::CommandEvent},
        options::ClientOptions,
    };
    use std::{
        sync::{Arc, Mutex},
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };
    let (uri, namespace, base) = source_reference::owned_fixture();
    assert_eq!(
        std::env::var("DIMA_VARIATION_JOBS_FAILPOINT_OWNER").unwrap(),
        namespace
    );
    let app = format!("{base}_crossing");
    let mut options = ClientOptions::parse(&uri).await.unwrap();
    options.direct_connection = Some(true);
    options.retry_reads = Some(false);
    options.retry_writes = Some(false);
    options.app_name = Some(app.clone());
    let calls = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = calls.clone();
    options.command_event_handler = Some(EventHandler::callback(move |event: CommandEvent| {
        if let CommandEvent::Started(event) = event
            && (event.command_name == "find" || event.command_name == "update")
        {
            seen.lock().unwrap().push(event.command_name);
        }
    }));
    let client = Client::with_options(options).unwrap();
    let db = client.database(&format!("{base}_crossing"));
    assert!(db.list_collection_names().await.unwrap().is_empty());
    db.collection::<Document>("_decision_owner")
        .insert_one(doc! {"_id":"owner", "owner":"dimabot-migration", "namespace":&namespace})
        .await
        .unwrap();
    let rows = db.collection::<Document>("moderation_decisions");
    let admin = client.database("admin");
    let service = ModerationDecisions::new(db.clone());
    let now = || {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    };
    // Prime both operation and monitoring connections before installing each
    // app-scoped failpoint, so the find starts inside the deadline.
    rows.find_one(doc! {"_id":"warmup"}).await.unwrap();
    for state in ["completed", "pending"] {
        rows.insert_one(doc! {"_id":state, "state":state, "status":"worker"})
            .await
            .unwrap();
        admin.run_command(doc! {"configureFailPoint":"failCommand", "mode":{"times":1}, "data":{"failCommands":["find"], "blockConnection":true, "blockTimeMS":350, "appName":&app}}).await.unwrap();
        calls.lock().unwrap().clear();
        let deadline = DateTime::from_millis(now() + 150);
        let start = Instant::now();
        let row = service
            .await_semantic_decision(state.into(), deadline)
            .await
            .unwrap()
            .unwrap();
        admin
            .run_command(doc! {"configureFailPoint":"failCommand", "mode":"off"})
            .await
            .unwrap();
        assert!(
            start.elapsed() >= Duration::from_millis(300),
            "find did not cross deadline"
        );
        if state == "completed" {
            assert_eq!(row.get_str("status").unwrap(), "worker");
            assert_eq!(*calls.lock().unwrap(), vec!["find"]);
        } else {
            assert_eq!(row.get_str("status").unwrap(), "timeout");
            assert_eq!(row.get_str("verdict").unwrap(), "uncertain");
            assert_eq!(*calls.lock().unwrap(), vec!["find", "update", "find"]);
        }
    }
    let marker = db
        .collection::<Document>("_decision_owner")
        .find_one(doc! {"_id":"owner"})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(marker.get_str("namespace").unwrap(), namespace);
    db.drop().await.unwrap();
}

#[tokio::test]
#[ignore = "requires task-owned keyword-mongo and bounded loopback write-reply proxy"]
async fn disposable_applied_timeout_write_lost_reply_has_no_application_replay() {
    source_reference::guarded_cleanup(
        "lost_reply",
        false,
        disposable_applied_timeout_write_lost_reply_has_no_application_replay_body(),
    )
    .await;
}
async fn disposable_applied_timeout_write_lost_reply_has_no_application_replay_body() {
    use dima_rust::utils::moderation::decisions::ModerationDecisions;
    use mongodb::{
        Client,
        bson::{DateTime, Document, doc},
        options::{ClientOptions, ServerMonitoringMode},
    };
    use std::sync::atomic::Ordering;
    let (uri, namespace, base) = source_reference::owned_fixture();
    let control = Client::with_uri_str(uri).await.unwrap();
    let name = format!("{base}_lost_reply");
    let db = control.database(&name);
    assert!(db.list_collection_names().await.unwrap().is_empty());
    db.collection::<Document>("_decision_owner")
        .insert_one(doc! {"_id":"owner", "owner":"dimabot-migration", "namespace":&namespace})
        .await
        .unwrap();
    let rows = db.collection::<Document>("moderation_decisions");
    rows.insert_one(doc! {"_id":"lost", "state":"pending", "consequence":{"status":"none"}})
        .await
        .unwrap();
    let proxy = source_reference::LostReplyProxy::start(name.clone(), "update");
    let proxy_uri = format!("mongodb://{}/?directConnection=true", proxy.address);
    let mut options = ClientOptions::parse(&proxy_uri).await.unwrap();
    options.direct_connection = Some(true);
    options.retry_reads = Some(false);
    options.retry_writes = Some(false);
    options.server_monitoring_mode = Some(ServerMonitoringMode::Poll);
    let client = Client::with_options(options).unwrap();
    let service = ModerationDecisions::new(client.database(&name));
    assert!(
        service
            .await_semantic_decision("lost".into(), DateTime::from_millis(0))
            .await
            .is_err()
    );
    assert!(
        proxy.dropped.load(Ordering::SeqCst),
        "proxy never observed an acknowledged update"
    );
    assert_eq!(
        proxy.updates.load(Ordering::SeqCst),
        1,
        "application replayed an uncertain write"
    );
    let actual = rows.find_one(doc! {"_id":"lost"}).await.unwrap().unwrap();
    assert_eq!(actual.get_str("state").unwrap(), "completed");
    assert_eq!(actual.get_str("status").unwrap(), "timeout");
    assert_eq!(
        actual
            .get_document("consequence")
            .unwrap()
            .get_str("status")
            .unwrap(),
        "allowed_fallback"
    );
    drop(service);
    drop(client);
    proxy.shutdown();
    // A separately configured proxy loses the reply to a successful atomic
    // creation; a second driver is used so each command has an independent
    // connection and both write paths prove no application replay.
    let proxy = source_reference::LostReplyProxy::start(name.clone(), "findAndModify");
    let proxy_uri = format!("mongodb://{}/?directConnection=true", proxy.address);
    let mut options = ClientOptions::parse(&proxy_uri).await.unwrap();
    options.direct_connection = Some(true);
    options.retry_reads = Some(false);
    options.retry_writes = Some(false);
    options.server_monitoring_mode = Some(ServerMonitoringMode::Poll);
    let client = Client::with_options(options).unwrap();
    let service = ModerationDecisions::new(client.database(&name));
    let input = doc! {"channelID":"channel", "messageID":"lost-create", "ruleID":"rule", "rule":{"id":"rule"}, "mode":"literal", "deadline":DateTime::from_millis(4_102_444_800_000)};
    let id = moderation_decision_id(&"channel".into(), &"lost-create".into(), &"rule".into());
    assert!(service.create(input).await.is_err());
    assert!(
        proxy.dropped.load(Ordering::SeqCst),
        "proxy never observed an acknowledged upsert"
    );
    assert_eq!(
        proxy.updates.load(Ordering::SeqCst),
        1,
        "application replayed an uncertain upsert"
    );
    let created = rows.find_one(doc! {"_id":id}).await.unwrap().unwrap();
    assert_eq!(created.get_str("state").unwrap(), "completed");
    assert_eq!(created.get_str("status").unwrap(), "matched");
    drop(service);
    drop(client);
    proxy.shutdown();
    let marker = db
        .collection::<Document>("_decision_owner")
        .find_one(doc! {"_id":"owner"})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(marker.get_str("namespace").unwrap(), namespace);
    db.drop().await.unwrap();
}

#[test]
#[ignore = "requires independently hashed actual-source and Mongoose SDK fixture"]
fn source_mongoose_query_probe_compares_cast_insert_wire_shape() {
    use dima_rust::utils::{
        bson_json::compiler_bson_json,
        moderation::decisions::{prepare_creation, prepare_creation_for_storage},
    };
    use std::{collections::VecDeque, sync::Mutex};
    let fixture = source_reference::reference();
    let symbol = &fixture["queryProbe"]["capture"]["symbolVersion"];
    assert_eq!(symbol["queryOwn"], true);
    assert_eq!(symbol["queryValue"]["kind"], "undefined");
    assert_eq!(symbol["wireOwn"], true);
    assert_eq!(symbol["wireValue"]["kind"], "null");
    let case = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "create-compiled-common")
        .unwrap();
    let input_tag = &case["args"]["items"][0];
    let input = source_reference::decode(input_tag)
        .as_document()
        .unwrap()
        .clone();
    let channel = source_reference::tagged_string(source_reference::member(input_tag, "channelID"));
    let message = source_reference::tagged_string(source_reference::member(input_tag, "messageID"));
    let rule_id = source_reference::tagged_string(source_reference::member(input_tag, "ruleID"));
    let raw_rule = input.get("rule").unwrap().clone();
    let view = compiler_bson_json(&raw_rule);
    let clock = source_reference::FixtureClock {
        values: Mutex::new(VecDeque::new()),
        last: Mutex::new(1_700_000_000_123),
    };
    let (filter, insert, created) = prepare_creation(
        input,
        channel,
        message,
        rule_id,
        raw_rule,
        view.clone(),
        &clock,
    )
    .unwrap();
    let actual = prepare_creation_for_storage(&filter, &insert, created, &view).unwrap();
    let expected = source_reference::decode(&fixture["queryProbe"]["capture"]["decoded"]);
    let expected = expected
        .as_document()
        .unwrap()
        .get_document("$setOnInsert")
        .unwrap();
    // BSON bytes also compare object field order; the probe uses the actual
    // pinned Mongoose cast/default path and Node driver's resolved BSON options.
    assert_eq!(
        actual.to_vec().unwrap(),
        expected.to_vec().unwrap(),
        "Mongoose/Node insert shape differs"
    );
}

#[tokio::test]
#[ignore = "requires task-owned keyword-mongo with enableTestCommands=1"]
async fn disposable_worker_result_racing_timeout_is_fenced() {
    source_reference::guarded_cleanup(
        "worker_race",
        true,
        disposable_worker_result_racing_timeout_is_fenced_body(),
    )
    .await;
}
async fn disposable_worker_result_racing_timeout_is_fenced_body() {
    use dima_rust::utils::moderation::decisions::ModerationDecisions;
    use mongodb::{
        Client,
        bson::{DateTime, Document, doc},
        event::{EventHandler, command::CommandEvent},
        options::ClientOptions,
    };
    use std::{
        sync::{Arc, Mutex},
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    let (uri, namespace, base) = source_reference::owned_fixture();
    assert_eq!(
        std::env::var("DIMA_VARIATION_JOBS_FAILPOINT_OWNER").unwrap(),
        namespace
    );
    let control = Client::with_uri_str(&uri).await.unwrap();
    let db = control.database(&format!("{base}_worker_race"));
    assert!(db.list_collection_names().await.unwrap().is_empty());
    db.collection::<Document>("_decision_owner")
        .insert_one(doc! {"_id":"owner", "owner":"dimabot-migration", "namespace":&namespace})
        .await
        .unwrap();
    let admin = control.database("admin");
    let rows = db.collection::<Document>("moderation_decisions");
    let mut options = ClientOptions::parse(&uri).await.unwrap();
    options.direct_connection = Some(true);
    options.retry_reads = Some(false);
    options.retry_writes = Some(false);
    let worker_app = format!("{namespace}_worker_race");
    options.app_name = Some(worker_app.clone());
    let (send, recv) = tokio::sync::oneshot::channel::<()>();
    let signal = Arc::new(Mutex::new(Some(send)));
    options.command_event_handler = Some(EventHandler::callback(move |event: CommandEvent| {
        if let CommandEvent::Started(event) = event
            && event.command_name == "update"
            && let Some(send) = signal.lock().unwrap().take()
        {
            let _ = send.send(());
        }
    }));
    let worker = Client::with_options(options).unwrap();
    let worker_rows = worker
        .database(&format!("{base}_worker_race"))
        .collection::<Document>("moderation_decisions");
    worker_rows.find_one(doc! {"_id":"warmup"}).await.unwrap();
    let now = || {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    };
    let deadline = DateTime::from_millis(now() + 300);
    rows.insert_one(doc! {"_id":"racing", "state":"processing", "deadline":deadline, "consequence":{"status":"none"}}).await.unwrap();
    admin.run_command(doc! {"configureFailPoint":"failCommand", "mode":{"times":1}, "data":{"failCommands":["update"], "blockConnection":true, "blockTimeMS":1500, "appName":&worker_app}}).await.unwrap();
    let worker_at = DateTime::from_millis(now());
    let task = tokio::spawn(async move {
        worker_rows
            .update_one(
                doc! {"_id":"racing", "state":"processing", "deadline":{"$gt":worker_at}},
                doc! {"$set":{"state":"completed", "verdict":"violation", "status":"worker"}},
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), recv)
        .await
        .unwrap()
        .unwrap();
    let result = ModerationDecisions::new(db.clone())
        .await_semantic_decision("racing".into(), deadline)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.get_str("status").unwrap(), "timeout");
    let late = task.await.unwrap().unwrap();
    assert_eq!(late.modified_count, 0);
    admin
        .run_command(doc! {"configureFailPoint":"failCommand", "mode":"off"})
        .await
        .unwrap();
    let stored = rows.find_one(doc! {"_id":"racing"}).await.unwrap().unwrap();
    assert_eq!(stored.get_str("verdict").unwrap(), "uncertain");
    assert_eq!(stored.get_str("status").unwrap(), "timeout");
    let marker = db
        .collection::<Document>("_decision_owner")
        .find_one(doc! {"_id":"owner"})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(marker.get_str("namespace").unwrap(), namespace);
    db.drop().await.unwrap();
}

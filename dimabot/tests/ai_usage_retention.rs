#![cfg(feature = "ai-usage-retention")]

use dima_rust::utils::{
    ai_usage_receipt_parser::RetentionTier, ai_usage_retention::AiUsageRetention,
    js_string::JsString, lossless_json::JsonValue,
};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[test]
fn strict_policy_uses_existing_parser() {
    for (value, expected, days) in [
        (JsonValue::String("free".into()), "free", 30),
        (JsonValue::String("premium".into()), "premium", 60),
        (JsonValue::String("pro".into()), "pro", 90),
        (JsonValue::String("Pro".into()), "free", 30),
        (
            JsonValue::String(JsString::from_units(vec![0xd800])),
            "free",
            30,
        ),
        (JsonValue::Null, "free", 30),
        (JsonValue::Array(vec![]), "free", 30),
        (JsonValue::Bool(true), "free", 30),
    ] {
        let tier = RetentionTier::from_value(&value);
        assert_eq!(tier.as_str(), expected);
        assert_eq!(tier.days(), days);
    }
}

#[tokio::test]
async fn empty_input_neither_reads_clock_nor_connects() {
    // An empty seed list prevents even the driver's background monitor from
    // resolving or connecting to a local production Mongo instance.
    let options = mongodb::options::ClientOptions::builder()
        .hosts(Vec::new())
        .build();
    let client = mongodb::Client::with_options(options).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&calls);
    let service = AiUsageRetention::with_clock(
        client.database("unused"),
        Arc::new(move || {
            observed.fetch_add(1, Ordering::SeqCst);
            0
        }),
    );
    service.clone().adjust(&[], &JsonValue::Null).await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

// This integration test may only address a fresh, disposable, task-owned
// Mongo server with enableTestCommands=1. No dynamic URI or database is used.
#[tokio::test]
#[ignore = "fresh private retention fixture only; never production or shared Mongo"]
async fn private_mongo_mutations_and_partial_failures() {
    use futures_util::FutureExt;
    use mongodb::{
        Client, Database,
        bson::{DateTime, Document, doc},
        event::{EventHandler, cmap::CmapEvent, command::CommandEvent},
        options::ClientOptions,
    };
    use std::{panic::AssertUnwindSafe, sync::Mutex};
    const NOW: i64 = 1_700_000_000_000;
    let owner = std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").unwrap();
    assert_eq!(owner, "dimabot-migration");
    let uri = std::env::var("DIMA_TEST_MONGO_URI").unwrap();
    assert_eq!(uri, "mongodb://ai-usage-retention-mongo-fixture:27017");
    let token = std::env::var("DIMA_AI_USAGE_RETENTION_RESOURCE_TOKEN").unwrap();
    assert!(
        (8..=32).contains(&token.len())
            && token
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    );
    let name = std::env::var("DIMA_AI_USAGE_RETENTION_TEST_DATABASE").unwrap();
    assert_eq!(name, format!("ai_usage_retention_test_{token}"));
    let events = Arc::new(Mutex::new(Vec::<(String, Document)>::new()));
    let observed = events.clone();
    let started = Arc::new(Mutex::new(Vec::<(String, i32)>::new()));
    let observed_started = started.clone();
    let completed = Arc::new(Mutex::new(Vec::<i32>::new()));
    let observed_completed = completed.clone();
    let pools = Arc::new(AtomicUsize::new(0));
    let observed_pools = pools.clone();
    let mut options = ClientOptions::parse(&uri).await.unwrap();
    options.direct_connection = Some(true);
    options.retry_writes = Some(false);
    options.max_pool_size = Some(4);
    options.command_event_handler =
        Some(EventHandler::callback(
            move |event: CommandEvent| match event {
                CommandEvent::Started(event) => {
                    observed_started
                        .lock()
                        .unwrap()
                        .push((event.command_name.clone(), event.request_id));
                    observed
                        .lock()
                        .unwrap()
                        .push((event.command_name, event.command));
                }
                CommandEvent::Succeeded(event) => {
                    observed_completed.lock().unwrap().push(event.request_id)
                }
                CommandEvent::Failed(event) => {
                    observed_completed.lock().unwrap().push(event.request_id)
                }
                _ => {}
            },
        ));
    options.cmap_event_handler = Some(EventHandler::callback(move |event: CmapEvent| {
        if let CmapEvent::PoolCreated(_) = event {
            observed_pools.fetch_add(1, Ordering::SeqCst);
        }
    }));
    let client = Client::with_options(options).unwrap();
    let db = client.database(&name);
    let admin = client.database("admin");
    assert!(
        db.list_collection_names().await.unwrap().is_empty(),
        "fresh owned database only"
    );
    let marker = db.collection::<Document>("_retention_owner");
    marker
        .insert_one(doc! {"_id":"owner","owner":owner,"token":token.clone()})
        .await
        .unwrap();
    async fn owned(db: &Database, token: &str) {
        assert_eq!(db.name(), format!("ai_usage_retention_test_{token}"));
        let marker = db
            .collection::<Document>("_retention_owner")
            .find_one(doc! {"_id":"owner"})
            .await
            .unwrap()
            .unwrap();
        assert_eq!(marker.get_str("owner").unwrap(), "dimabot-migration");
        assert_eq!(marker.get_str("token").unwrap(), token);
    }
    let result=AssertUnwindSafe(async {
        owned(&db,&token).await;
        let before=events.lock().unwrap().len();
        let clock:Arc<dyn Fn()->i64+Send+Sync>=Arc::new(||NOW);
        let service=AiUsageRetention::with_clock(db.clone(),clock); let clone=service.clone();
        assert_eq!(events.lock().unwrap().len(),before,"construct and clone perform no I/O");
        let dash=db.collection::<Document>("ai_usage_dashboards");
        let state=db.collection::<Document>("ai_usage_ledger_states");
        let receipts=db.collection::<Document>("ai_usage_receipts");
        let daily=db.collection::<Document>("ai_usage_dailies");
        for tier in ["free","premium","pro"] {
            let days=RetentionTier::from_value(&JsonValue::String(tier.into())).days();
            for collection in [&dash,&state,&receipts,&daily] { collection.delete_many(doc! {}).await.unwrap(); }
            dash.insert_many([doc! {"channelID":"a"},doc! {"channelID":"other"}]).await.unwrap();
            state.insert_many([doc! {"channelID":"a","coverageStart":DateTime::from_millis(0)},doc! {"channelID":"other","coverageStart":DateTime::from_millis(0)}]).await.unwrap();
            receipts.insert_many([doc! {"channelID":"a","occurredAt":DateTime::from_millis(NOW),"expiresAt":DateTime::from_millis(0)},doc! {"channelID":"a","occurredAt":DateTime::from_millis(0),"expiresAt":DateTime::from_millis(NOW)},doc! {"channelID":"other","occurredAt":DateTime::from_millis(0),"expiresAt":DateTime::from_millis(0)}]).await.unwrap();
            daily.insert_many([doc! {"channelID":"a","dayStart":DateTime::from_millis(NOW),"expiresAt":DateTime::from_millis(0)},doc! {"channelID":"a","dayStart":DateTime::from_millis(0),"expiresAt":DateTime::from_millis(NOW)},doc! {"channelID":"other","dayStart":DateTime::from_millis(0),"expiresAt":DateTime::from_millis(0)}]).await.unwrap();
            receipts.insert_many([doc! {"channelID":"a","occurredAt":DateTime::from_millis(NOW-days*86_400_000)},doc! {"channelID":"a","occurredAt":DateTime::from_millis(NOW-days*86_400_000+1)}]).await.unwrap();
            daily.insert_many([doc! {"channelID":"a","dayStart":DateTime::from_millis(NOW-(days+1)*86_400_000)},doc! {"channelID":"a","dayStart":DateTime::from_millis(NOW-(days+1)*86_400_000+1)}]).await.unwrap();
            let begin=events.lock().unwrap().len();
            clone.adjust(&["a".into(),"a".into()],&JsonValue::String(tier.into())).await.unwrap();
            let commands=events.lock().unwrap()[begin..].to_vec();
            assert_eq!(commands.iter().filter(|(n,_)|n=="delete").count(),3);
            assert_eq!(commands.iter().filter(|(n,_)|n=="update").count(),3);
            assert_eq!(dash.count_documents(doc! {"channelID":"a"}).await.unwrap(),0);
            assert_eq!(dash.count_documents(doc! {"channelID":"other"}).await.unwrap(),1);
            let s=state.find_one(doc! {"channelID":"a"}).await.unwrap().unwrap();
            assert_eq!(s.get_datetime("coverageStart").unwrap().timestamp_millis(),NOW-days*86_400_000);
            assert_eq!(s.get_datetime("updated_at").unwrap().timestamp_millis(),NOW);
            assert!(!s.contains_key("created_at"));
            for (collection,extra) in [(&receipts,0),(&daily,1)] {
                assert_eq!(collection.count_documents(doc! {"channelID":"a"}).await.unwrap(),2);
                let row=collection.find_one(doc! {"channelID":"a","expiresAt":{"$gt":DateTime::from_millis(NOW+1)}}).await.unwrap().unwrap();
                assert_eq!(row.get_str("retentionTier").unwrap(),tier);
                assert_eq!(row.get_datetime("expiresAt").unwrap().timestamp_millis(),NOW+(days+extra)*86_400_000);
                assert_eq!(row.get_datetime("updated_at").unwrap().timestamp_millis(),NOW);
                assert_eq!(collection.count_documents(doc! {"channelID":"other"}).await.unwrap(),1);
            }
            // $max must never regress existing coverage.
            state.update_one(doc! {"channelID":"a"},doc! {"$set":{"coverageStart":DateTime::from_millis(NOW)}}).await.unwrap();
            service.adjust(&["a".into()],&JsonValue::String(tier.into())).await.unwrap();
            assert_eq!(state.find_one(doc! {"channelID":"a"}).await.unwrap().unwrap().get_datetime("coverageStart").unwrap().timestamp_millis(),NOW);
        }
        // Fail each sequential update at the server. Earlier mutations remain;
        // no application retry is allowed after an uncertain outcome.
        for skip in 0..3 {
            admin.run_command(doc! {"configureFailPoint":"failCommand","mode":{"skip":skip},"data":{"failCommands":["update"],"errorCode":12345}}).await.unwrap();
            let begin=events.lock().unwrap().len();
            assert!(service.adjust(&["a".into()],&JsonValue::Null).await.is_err());
            let commands=events.lock().unwrap()[begin..].to_vec();
            assert_eq!(commands.iter().filter(|(n,_)|n=="update").count(),skip as usize+1);
            admin.run_command(doc! {"configureFailPoint":"failCommand","mode":"off"}).await.unwrap();
        }
        admin.run_command(doc! {"configureFailPoint":"failCommand","mode":{"times":1},"data":{"failCommands":["delete"],"closeConnection":true}}).await.unwrap();
        let before=events.lock().unwrap().len();
        assert!(service.adjust(&["a".into()],&JsonValue::Null).await.is_err());
        assert_eq!(events.lock().unwrap()[before..].iter().filter(|(n,_)|n=="delete").count(),1,"disconnect is not retried by adapter");
        admin.run_command(doc! {"configureFailPoint":"failCommand","mode":"off"}).await.unwrap();
        for collection in [&dash,&state,&receipts,&daily] {
            assert_eq!(collection.list_index_names().await.unwrap(),vec!["_id_"],"adapter installs no indexes");
        }
        assert_eq!(pools.load(Ordering::SeqCst),1,"clones reuse the client pool");
        // Block both final deletes on the dedicated server. The command monitor
        // proves both were launched before cancellation, and the detached tasks
        // must finish after the parent future is dropped.
        admin.run_command(doc! {"configureFailPoint":"failCommand","mode":{"skip":1},"data":{"failCommands":["delete"],"blockConnection":true,"blockTimeMS":500}}).await.unwrap();
        let begin=events.lock().unwrap().len();
        let start_index=started.lock().unwrap().len();
        let pending=tokio::spawn(async move {clone.adjust(&["a".into()],&JsonValue::Null).await});
        tokio::time::timeout(std::time::Duration::from_secs(5),async {
            loop {if events.lock().unwrap()[begin..].iter().filter(|(n,_)|n=="delete").count()>=3 {break;} tokio::task::yield_now().await;}
        }).await.unwrap();
        pending.abort(); assert!(pending.await.unwrap_err().is_cancelled());
        let delete_ids:Vec<_>=started.lock().unwrap()[start_index..].iter().filter(|(name,_)|name=="delete").map(|(_,id)|*id).collect();
        assert_eq!(delete_ids.len(),3);
        // The fixture owns this whole server; turn the failpoint off after the
        // commands entered it, then observe both detached operations complete.
        admin.run_command(doc! {"configureFailPoint":"failCommand","mode":"off"}).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5),async {
            loop {if delete_ids.iter().all(|id|completed.lock().unwrap().contains(id)){break;} tokio::task::yield_now().await;}
        }).await.expect("detached deletes must complete");
        let commands=events.lock().unwrap()[begin..].iter().filter(|(n,_)|n=="delete").count();
        assert_eq!(commands,3,"cancellation must not retry final writes");
    }).catch_unwind().await;
    let disable = admin
        .run_command(doc! {"configureFailPoint":"failCommand","mode":"off"})
        .await;
    let cleanup = AssertUnwindSafe(async {
        owned(&db, &token).await;
        db.drop().await.unwrap();
    })
    .catch_unwind()
    .await;
    client.shutdown().await;
    if let Err(e) = result {
        std::panic::resume_unwind(e)
    }
    disable.unwrap();
    if let Err(e) = cleanup {
        std::panic::resume_unwind(e)
    }
}

#[tokio::test]
#[ignore = "requires generated actual-source oracle and fresh private Mongo fixture"]
async fn actual_source_wire_replay() {
    use futures_util::FutureExt;
    use mongodb::{
        Client, Database,
        bson::{Bson, Document, doc},
        event::{EventHandler, command::CommandEvent},
        options::ClientOptions,
    };
    use serde_json::Value;
    use sha2::{Digest, Sha256};
    use std::{
        collections::VecDeque, io::Cursor, panic::AssertUnwindSafe, path::Path, sync::Mutex,
        time::Duration,
    };
    fn unhex(s: &str) -> Vec<u8> {
        assert_eq!(s.len() % 2, 0);
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }
    fn wrapped(bytes: &str) -> Bson {
        Document::from_reader(&mut Cursor::new(unhex(bytes)))
            .unwrap()
            .remove("value")
            .unwrap()
    }
    fn value(b: Bson) -> JsonValue {
        match b {
            Bson::Null => JsonValue::Null,
            Bson::Boolean(v) => JsonValue::Bool(v),
            Bson::String(v) => JsonValue::String(v.into()),
            Bson::Int32(v) => JsonValue::Number(v as f64),
            Bson::Int64(v) => JsonValue::Number(v as f64),
            Bson::Double(v) => JsonValue::Number(v),
            Bson::Array(a) => JsonValue::Array(a.into_iter().map(value).collect()),
            Bson::Document(d) => {
                JsonValue::Object(d.into_iter().map(|(k, v)| (k.into(), value(v))).collect())
            }
            v => panic!("unsupported fixture tier {v:?}"),
        }
    }
    fn bytes(value: Bson) -> Vec<u8> {
        doc! {"value":value}.to_vec().unwrap()
    }
    let owner = std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").unwrap();
    assert_eq!(owner, "dimabot-migration");
    let uri = std::env::var("DIMA_TEST_MONGO_URI").unwrap();
    assert_eq!(uri, "mongodb://ai-usage-retention-mongo-fixture:27017");
    let token = std::env::var("DIMA_AI_USAGE_RETENTION_RESOURCE_TOKEN").unwrap();
    assert!(
        (8..=32).contains(&token.len())
            && token
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    );
    let name = std::env::var("DIMA_AI_USAGE_RETENTION_TEST_DATABASE").unwrap();
    assert_eq!(name, format!("ai_usage_retention_test_{token}"));
    let fixture = std::env::var("DIMA_AI_USAGE_RETENTION_ORACLE").unwrap();
    let oracle: Value = serde_json::from_slice(&std::fs::read(fixture).unwrap()).unwrap();
    assert_eq!(oracle["node"], "v24.22.1");
    assert_eq!(oracle["v8"], "13.6.233.17-node.58");
    assert_eq!(oracle["typescript"], "5.9.3");
    assert_eq!(oracle["mongoose"], "8.24.2");
    assert_eq!(oracle["bson"], "6.10.4");
    let node = std::env::var("DIMA_AI_USAGE_RETENTION_NODE_BINARY")
        .expect("exact pinned oracle Node executable mounted for independent hashing");
    let dependency_root = std::env::var("DIMA_AI_USAGE_RETENTION_NODE_DEPENDENCY_ROOT")
        .expect("read-only root containing the oracle's public node_modules files");
    let dependency_root = Path::new(&dependency_root);
    assert_eq!(
        format!("{:x}", Sha256::digest(std::fs::read(node).unwrap())),
        oracle["nodeHash"].as_str().unwrap()
    );
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    for (file, hash) in oracle["pins"].as_object().unwrap() {
        let path = if file.starts_with("node_modules/") {
            dependency_root.join(file)
        } else {
            crate_dir.join(file)
        };
        let actual = format!("{:x}", Sha256::digest(std::fs::read(path).unwrap()));
        assert_eq!(actual, hash.as_str().unwrap(), "source pin {file}");
    }
    for section in ["hashes", "dependencies"] {
        for (file, hash) in oracle[section].as_object().unwrap() {
            let path = if file.starts_with("node_modules/") {
                dependency_root.join(file)
            } else {
                crate_dir.join(file)
            };
            let actual = format!("{:x}", Sha256::digest(std::fs::read(path).unwrap()));
            assert_eq!(actual, hash.as_str().unwrap(), "{section} {file}");
        }
    }
    for (text, hash) in [
        ("extracted", "extractedHash"),
        ("typecheck", "typecheckHash"),
        ("compiled", "compiledHash"),
    ] {
        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest(oracle[text].as_str().unwrap().as_bytes())
            ),
            oracle[hash].as_str().unwrap()
        );
    }
    for declaration in oracle["declarations"].as_array().unwrap() {
        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest(declaration["text"].as_str().unwrap().as_bytes())
            ),
            declaration["sha256"].as_str().unwrap()
        );
    }
    // Independent fixed source pin: generated JSON cannot reassign provenance.
    assert_eq!(
        oracle["pins"]["src/utils/ai_usage_ledger.ts"],
        "3519b440d3d03a9415323f75f113f81627c6b07369ef43903a7b07116df5d4f5"
    );
    let events = Arc::new(Mutex::new(Vec::<(String, Document)>::new()));
    let observed = events.clone();
    let started = Arc::new(Mutex::new(Vec::<(String, i32)>::new()));
    let observed_started = started.clone();
    let completed = Arc::new(Mutex::new(Vec::<i32>::new()));
    let observed_completed = completed.clone();
    let mut options = ClientOptions::parse(&uri).await.unwrap();
    options.direct_connection = Some(true);
    options.retry_writes = Some(false);
    options.max_pool_size = Some(4);
    options.command_event_handler =
        Some(EventHandler::callback(
            move |event: CommandEvent| match event {
                CommandEvent::Started(event) => {
                    observed_started
                        .lock()
                        .unwrap()
                        .push((event.command_name.clone(), event.request_id));
                    observed
                        .lock()
                        .unwrap()
                        .push((event.command_name, event.command));
                }
                CommandEvent::Succeeded(event) => {
                    observed_completed.lock().unwrap().push(event.request_id)
                }
                CommandEvent::Failed(event) => {
                    observed_completed.lock().unwrap().push(event.request_id)
                }
                _ => {}
            },
        ));
    let client = Client::with_options(options).unwrap();
    let db = client.database(&name);
    let admin = client.database("admin");
    assert!(db.list_collection_names().await.unwrap().is_empty());
    db.collection::<Document>("_retention_owner")
        .insert_one(doc! {"_id":"owner","owner":"dimabot-migration","token":token.clone()})
        .await
        .unwrap();
    async fn owned(db: &Database, token: &str) {
        assert_eq!(db.name(), format!("ai_usage_retention_test_{token}"));
        let marker = db
            .collection::<Document>("_retention_owner")
            .find_one(doc! {"_id":"owner"})
            .await
            .unwrap()
            .unwrap();
        assert_eq!(marker.get_str("owner").unwrap(), "dimabot-migration");
        assert_eq!(marker.get_str("token").unwrap(), token);
    }
    let run=AssertUnwindSafe(async {
        for row in oracle["cases"].as_array().unwrap() {
            let id=row["id"].as_str().unwrap();
            let ids:Vec<JsString>=row["ids"].as_array().unwrap().iter().map(|v|JsString::from_units(v.as_array().unwrap().iter().map(|x|x.as_u64().unwrap() as u16).collect())).collect();
            let tier=value(wrapped(row["tier"].as_str().unwrap()));
            let mut ticks=VecDeque::new();
            if let Some(v)=row["clock"].as_array().unwrap().first() {ticks.push_back(v.as_i64().unwrap());}
            for v in row["middlewareClock"].as_array().unwrap() {ticks.push_back(v.as_i64().unwrap());}
            let clock=Arc::new(Mutex::new(ticks)); let clock_input=clock.clone();
            let service=AiUsageRetention::with_clock(db.clone(),Arc::new(move||clock_input.lock().unwrap().pop_front().expect("extra clock call")));
            if let Some(index)=id.strip_prefix("failure-") {
                let index:usize=index.parse().unwrap();
                let (command,skip)=if index==0 {("delete",0)} else if index<4 {("update",index-1)} else {("delete",index-3)};
                admin.run_command(doc! {"configureFailPoint":"failCommand","mode":{"skip":skip as i32},"data":{"failCommands":[command],"errorCode":12345}}).await.unwrap();
            }
            let begin=events.lock().unwrap().len(); let start_index=started.lock().unwrap().len(); let result=service.adjust(&ids,&tier).await;
            assert_eq!(result.is_err(),!row["error"].is_null(),"outcome {id}");
            if let Err(ref error)=result {
                match error {
                    dima_rust::utils::ai_usage_retention::RetentionError::InvalidDate {path} => {
                        assert_eq!(row["error"]["name"],"CastError","{id}");
                        assert_eq!(row["error"]["path"],*path,"cast path {id}");
                    }
                    dima_rust::utils::ai_usage_retention::RetentionError::Mongo(_) => {
                        assert_eq!(row["error"]["code"],12345,"driver error {id}");
                    }
                    e=>panic!("unexpected task failure {id}: {e}")
                }
            }
            assert!(clock.lock().unwrap().is_empty(),"unused clock reads {id}");
            // First-error return leaves the sibling running; wait for its command
            // before comparing, never cancel it and never issue an application retry.
            let expected=row["calls"].as_array().unwrap();
            tokio::time::timeout(Duration::from_secs(5),async {
                loop {if events.lock().unwrap()[begin..].iter().filter(|(n,_)|n=="delete"||n=="update").count()>=expected.len(){break;} tokio::task::yield_now().await;}
            }).await.unwrap_or_else(|_|panic!("missing command in {id}"));
            let request_ids:Vec<_>=started.lock().unwrap()[start_index..].iter().filter(|(n,_)|n=="delete"||n=="update").map(|(_,id)|*id).collect();
            tokio::time::timeout(Duration::from_secs(5),async {
                loop {if request_ids.iter().all(|id|completed.lock().unwrap().contains(id)){break;} tokio::task::yield_now().await;}
            }).await.unwrap_or_else(|_|panic!("incomplete command in {id}"));
            admin.run_command(doc! {"configureFailPoint":"failCommand","mode":"off"}).await.unwrap();
            let mut actual=Vec::new();
            for (kind,command) in &events.lock().unwrap()[begin..] {
                if kind=="delete" {
                    let entry=command.get_array("deletes").unwrap()[0].as_document().unwrap();
                    assert_eq!(entry.get_i32("limit").unwrap(),0,"deleteMany limit");
                    actual.push((command.get_str("delete").unwrap().to_owned(),"deleteMany".to_owned(),bytes(entry.get("q").unwrap().clone()),None));
                } else if kind=="update" {
                    let entry=command.get_array("updates").unwrap()[0].as_document().unwrap();
                    assert!(entry.get_bool("multi").unwrap(),"updateMany multi");
                    assert!(!entry.get_bool("upsert").unwrap_or(false),"updateMany must not upsert");
                    actual.push((command.get_str("update").unwrap().to_owned(),"updateMany".to_owned(),bytes(entry.get("q").unwrap().clone()),Some(bytes(entry.get("u").unwrap().clone()))));
                }
            }
            let mut want:Vec<_>=expected.iter().map(|c| {
                let args=c["args"].as_array().unwrap();
                let method=c["method"].as_str().unwrap().to_owned();
                let option_index=if method=="updateMany" {2} else {1};
                assert_eq!(wrapped(args[option_index].as_str().unwrap()),Bson::Document(Document::new()),"source options {id}");
                let second=if method=="updateMany" {Some(unhex(args[1].as_str().unwrap()))} else {None};
                (c["collection"].as_str().unwrap().to_owned(),method,unhex(args[0].as_str().unwrap()),second)
            }).collect();
            actual.sort(); want.sort(); assert_eq!(actual,want,"wire operations {id}");
        }
    }).catch_unwind().await;
    let disable = admin
        .run_command(doc! {"configureFailPoint":"failCommand","mode":"off"})
        .await;
    let cleanup = AssertUnwindSafe(async {
        owned(&db, &token).await;
        db.drop().await.unwrap();
    })
    .catch_unwind()
    .await;
    client.shutdown().await;
    if let Err(e) = run {
        std::panic::resume_unwind(e)
    }
    disable.unwrap();
    if let Err(e) = cleanup {
        std::panic::resume_unwind(e)
    }
}

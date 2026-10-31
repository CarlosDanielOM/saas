#![cfg(feature = "pet-schemas-wakeups")]
#[path = "support/pet_schemas_wakeups_support.rs"] mod support;
use dima_rust::schemas::{pet_runtime, pet_settings};
use mongodb::bson::{doc, Bson, DateTime, Document};
use serde_json::{json, Value};

fn normalize(v: &Bson) -> Value {
    match v {
        Bson::DateTime(v) => json!({"$date":v.timestamp_millis()}),
        Bson::ObjectId(v) => json!({"$oid":v.to_hex()}),
        Bson::Document(v) => Value::Object(v.iter().map(|(k,v)|(k.clone(),normalize(v))).collect()),
        Bson::Array(v) => Value::Array(v.iter().map(normalize).collect()),
        _ => serde_json::to_value(v).unwrap(),
    }
}
#[test]
#[ignore = "requires external pinned actual-source oracle fixture"]
fn source_schema_cases_and_indexes() {
    let reference = support::fixture();
    for case in reference["cases"].as_array().unwrap() {
        let model = case["model"].as_str().unwrap();
        let schema = match model { "request" => pet_runtime::request_schema(), "runtime" => pet_runtime::runtime_schema(), "settings" => pet_settings::schema(), _ => panic!("unknown model") };
        let input: Document = mongodb::bson::serialize_to_document(&case["input"]).unwrap();
        let actual = match schema.construct(&input, DateTime::from_millis(0)) {
            Ok(mut document) => { if model == "settings" { document.remove("_id"); } json!({"valid":true,"document":normalize(&Bson::Document(document))}) },
            Err(_) => json!({"valid":false}),
        };
        assert_eq!(actual, case["expected"], "{}:{}", model, case["label"]);
    }
    for (name, schema) in [("request",pet_runtime::request_schema()),("runtime",pet_runtime::runtime_schema()),("settings",pet_settings::schema())] {
        let actual: Vec<Value> = schema.indexes.iter().map(|idx| json!({"keys":normalize(&Bson::Document(idx.keys.clone())),"unique":idx.unique,"ttl":idx.ttl.map(|d|d.as_secs()),"partial":idx.partial.as_ref().map(|v|normalize(&Bson::Document(v.clone())))})).collect();
        assert_eq!(json!(actual),reference["indexes"][name],"{name} indexes");
    }
    let w=&reference["wakeups"];
    assert_eq!(w["cold"],0); assert_eq!(w["connecting"],1); assert_eq!(w["inFlight"],1); assert_eq!(w["coalesced"],2);
    assert_eq!(w["idleDestroyed"],1); assert_eq!(w["timeoutDestroyed"],1); assert_eq!(w["cooldownClients"],1); assert_eq!(w["latePublications"],0);
    assert_eq!(w["subscriberClients"],2); assert_eq!(w["afterReconnect"],1); assert_eq!(w["afterStop"],1);
    assert_eq!(w["channel"],json!(["domain-events:wakeup:v1","1"]));
}

#[tokio::test]
#[ignore = "requires exclusively task-owned disposable Mongo"]
async fn mongo_index_readback_and_uniqueness() {
    use futures_util::TryStreamExt;
    support::require_private_resources();
    let uri=std::env::var("DIMA_TEST_MONGO_URI").unwrap(); let dbname=std::env::var("DIMA_PET_SCHEMAS_TEST_DATABASE").unwrap();
    assert!(dbname.starts_with("rust_pet_schemas_fixture_"));
    let db=mongodb::Client::with_uri_str(uri).await.unwrap().database(&dbname);
    assert!(db.list_collection_names().await.unwrap().is_empty(), "fixture database must be new and empty");
    pet_runtime::install_indexes(&db).await.unwrap(); pet_settings::install_indexes(&db).await.unwrap();
    for schema in [pet_runtime::request_schema(),pet_runtime::runtime_schema(),pet_settings::schema()] {
        let indexes: Vec<_>=schema.native_collection(&db).list_indexes().await.unwrap().try_collect().await.unwrap();
        assert_eq!(indexes.len(),schema.indexes.len()+1,"unexpected indexes in {}",schema.collection);
        for expected in &schema.indexes {
            let got=indexes.iter().find(|i|i.keys==expected.keys).expect("declared index on server");
            let opts=got.options.as_ref().unwrap();
            assert_eq!(opts.unique.unwrap_or(false),expected.unique);
            assert_eq!(opts.expire_after,expected.ttl);
            assert_eq!(opts.partial_filter_expression,expected.partial);
        }
    }
    let requests=pet_runtime::request_collection(&db);
    requests.insert_one(doc! {"_id":"one","ownerId":"u","origin":{"kind":"chat-command","id":"a"},"actionKey":"x"}).await.unwrap();
    assert!(requests.insert_one(doc! {"_id":"two","ownerId":"u","origin":{"kind":"chat-command","id":"a"},"actionKey":"x"}).await.is_err());
    requests.insert_one(doc! {"_id":"three","ownerId":"u","origin":{"kind":"chat-command","id":"b"},"actionKey":"x"}).await.unwrap();
    let runtime=pet_runtime::runtime_collection(&db);
    runtime.insert_many([doc!{"_id":"null1","tokenHash":null},doc!{"_id":"null2","tokenHash":null},doc!{"_id":"missing"},doc!{"_id":"typed","tokenHash":7},doc!{"_id":"typed2","tokenHash":7},doc!{"_id":"string","tokenHash":"same"}]).await.unwrap();
    assert!(runtime.insert_one(doc!{"_id":"duplicate","tokenHash":"same"}).await.is_err());
    let settings=pet_settings::collection(&db); let id=mongodb::bson::oid::ObjectId::new();
    settings.insert_one(doc!{"userId":id}).await.unwrap(); assert!(settings.insert_one(doc!{"userId":id}).await.is_err());
    db.drop().await.unwrap();
}

fn wakeup_config() -> dima_rust::utils::domain_event_wakeups::WakeupConfig {
    use std::time::Duration;
    dima_rust::utils::domain_event_wakeups::WakeupConfig {enabled:true,timeout:Duration::from_millis(300),retry:Duration::from_millis(400),idle:Duration::from_millis(180)}
}

#[tokio::test]
async fn concrete_publisher_coalesces_and_releases_idle_socket() {
    use dima_rust::utils::domain_event_wakeups::DomainEventWakeups;
    use std::{sync::atomic::Ordering,time::Duration};
    let mut stub=support::Stub::start().await;
    stub.block_publish.store(true,Ordering::SeqCst);
    let publisher=DomainEventWakeups::new(redis::Client::open(stub.url.as_str()).unwrap(),wakeup_config());
    publisher.publish(); stub.command("PUBLISH").await;
    for _ in 0..1000 {publisher.publish();}
    stub.block_publish.store(false,Ordering::SeqCst);stub.release.notify_one();
    stub.command("PUBLISH").await;
    assert!(tokio::time::timeout(Duration::from_millis(100),async {loop {if let Some(support::Event::Command(cmd))=stub.events.recv().await {if cmd=="PUBLISH" {break}}}}).await.is_err(),"burst must coalesce into one follow-up");
    stub.closed().await;
    publisher.shutdown().await;
}

#[tokio::test]
async fn concrete_publisher_timeout_drops_hints_and_cools_down() {
    use dima_rust::utils::domain_event_wakeups::DomainEventWakeups;
    use std::{sync::atomic::Ordering,time::Duration};
    let mut stub=support::Stub::start().await;stub.block_publish.store(true,Ordering::SeqCst);
    let publisher=DomainEventWakeups::new(redis::Client::open(stub.url.as_str()).unwrap(),wakeup_config());
    publisher.publish();stub.command("PUBLISH").await;
    // Socket closure proves the underlying command was cancelled, not just its waiter.
    stub.closed().await;
    let connections=stub.connections.load(Ordering::SeqCst);
    for _ in 0..1000 {publisher.publish();}
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(stub.connections.load(Ordering::SeqCst),connections,"cooldown must drop new hints");
    tokio::time::sleep(Duration::from_millis(450)).await;
    assert_eq!(stub.connections.load(Ordering::SeqCst),connections,"publisher must not replay failed hints");
    stub.block_publish.store(false,Ordering::SeqCst);publisher.publish();stub.command("PUBLISH").await;
    publisher.shutdown().await;
}

#[tokio::test]
async fn concrete_listener_reconnects_and_stop_cancels_socket() {
    use dima_rust::utils::domain_event_wakeups::DomainEventWakeupListener;
    use std::{sync::{Arc,atomic::{AtomicUsize,Ordering}},time::Duration};
    let mut stub=support::Stub::start().await;let wakes=Arc::new(AtomicUsize::new(0));let count=wakes.clone();
    let mut listener=DomainEventWakeupListener::start(redis::Client::open(stub.url.as_str()).unwrap(),wakeup_config(),Arc::new(move || {count.fetch_add(1,Ordering::SeqCst);}));
    stub.command("SUBSCRIBE").await;let _=stub.close.send(());stub.closed().await;stub.command("SUBSCRIBE").await;
    listener.shutdown().await;stub.closed().await;
    let count=stub.connections.load(Ordering::SeqCst);tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(stub.connections.load(Ordering::SeqCst),count,"shutdown cancels retry");assert_eq!(wakes.load(Ordering::SeqCst),0);
}

#[tokio::test]
async fn concrete_shutdown_cancels_inflight_publication() {
    use dima_rust::utils::domain_event_wakeups::DomainEventWakeups;
    use std::sync::atomic::Ordering;
    let mut stub=support::Stub::start().await;stub.block_publish.store(true,Ordering::SeqCst);
    let publisher=DomainEventWakeups::new(redis::Client::open(stub.url.as_str()).unwrap(),wakeup_config());
    publisher.publish();stub.command("PUBLISH").await;publisher.shutdown().await;stub.closed().await;
    let connections=stub.connections.load(Ordering::SeqCst);publisher.publish();
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;assert_eq!(stub.connections.load(Ordering::SeqCst),connections);
}

#[tokio::test]
#[ignore = "requires exclusively task-owned disposable Redis"]
async fn redis_hint_is_not_durable_for_a_late_listener() {
    use dima_rust::utils::domain_event_wakeups::{DomainEventWakeupListener,DomainEventWakeups};
    use std::{sync::{Arc,atomic::{AtomicUsize,Ordering}},time::Duration};
    support::require_private_resources();let client=redis::Client::open(std::env::var("DIMA_TEST_REDIS_URL").unwrap()).unwrap();
    let publisher=DomainEventWakeups::new(client.clone(),wakeup_config());publisher.publish();tokio::time::sleep(Duration::from_millis(200)).await;publisher.shutdown().await;
    let wakes=Arc::new(AtomicUsize::new(0));let observed=wakes.clone();
    let mut listener=DomainEventWakeupListener::start(client,wakeup_config(),Arc::new(move || {observed.fetch_add(1,Ordering::SeqCst);}));
    tokio::time::sleep(Duration::from_millis(400)).await;assert_eq!(wakes.load(Ordering::SeqCst),0,"Redis pub/sub does not replay earlier hints");listener.shutdown().await;
}

#[tokio::test]
async fn poll_signal_contract_requires_retained_permit_and_fallback() {
    // This demonstrates the required consumer wiring; it is not the migrated
    // domain-event worker. Redis itself has no durable wakeup guarantee.
    use std::time::Duration;
    let signal=tokio::sync::Notify::new();
    signal.notify_one();
    tokio::time::timeout(Duration::from_millis(100),signal.notified()).await.expect("hint before wait must remain pending");
    assert!(tokio::time::timeout(Duration::from_millis(20),signal.notified()).await.is_err(),"hints coalesce to one permit");
    // A real consumer must perform its Mongo poll after this timer expires.
}

#[tokio::test]
async fn cold_connect_burst_is_one_hint() {
    use dima_rust::utils::domain_event_wakeups::DomainEventWakeups;
    use std::{sync::atomic::Ordering,time::Duration};
    let mut stub=support::Stub::start().await;stub.block_handshake.store(true,Ordering::SeqCst);
    let publisher=DomainEventWakeups::new(redis::Client::open(stub.url.as_str()).unwrap(),wakeup_config());
    publisher.publish();stub.command("CLIENT").await;
    for _ in 0..1000 {publisher.publish();}
    stub.block_handshake.store(false,Ordering::SeqCst);stub.release.notify_one();
    stub.command("PUBLISH").await;
    assert!(tokio::time::timeout(Duration::from_millis(120),async {loop {if let Some(support::Event::Command(cmd))=stub.events.recv().await {if cmd=="PUBLISH" {break}}}}).await.is_err(),"cold connection burst must coalesce");
    publisher.shutdown().await;
}

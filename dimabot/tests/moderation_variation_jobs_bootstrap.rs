#![cfg(feature = "moderation-variation-jobs")]
#[path = "ai_credit_projection_support/mod.rs"]
mod support;

use dima_rust::utils::{
    moderation::{
        types::VariationMode,
        variation_jobs::{VariationJobsService, variation_job_id},
        variations_provider::MuseVariationsProvider,
    },
    observability::{Telemetry, TraceContext, with_telemetry_context},
    redis_application_runtime,
};
use mongodb::bson::{Document, doc};
use redis::AsyncCommands;
use std::{
    process::{Command, Stdio},
    time::Duration,
};

#[test]
#[ignore = "requires task-owned keyword-mongo and private Dragonfly with unique namespace"]
fn isolated_bootstrap_probes() {
    let (_, host, port) = support::fixture_url();
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_MONGO_URI").unwrap(),
        "mongodb://keyword-mongo:27017"
    );
    let ns = std::env::var("KEYWORD_FIXTURE_NAMESPACE").unwrap();
    assert!(
        ns.starts_with("keyword-fixture-")
            && ns.ends_with(':')
            && (24..=50).contains(&ns.len())
            && ns
                .trim_end_matches(':')
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    );
    for (case, redis_host, redis_port) in
        [("offline", "127.0.0.1", 1), ("online", host.as_str(), port)]
    {
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "bootstrap_child", "--nocapture"])
            .env("VARIATION_BOOTSTRAP_CASE", case)
            .env("DRAGONFLY_HOST", redis_host)
            .env("DRAGONFLY_PORT", redis_port.to_string())
            .env("OBSERVABILITY_DISABLED", "true")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let output = support::child_output(child, Duration::from_secs(30));
        assert!(
            output.status.success(),
            "{case}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
#[ignore = "child-only, requires explicitly owned disposable fixtures"]
fn bootstrap_child() {
    let _ = support::fixture_url();
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_MONGO_URI").unwrap(),
        "mongodb://keyword-mongo:27017"
    );
    let ns = std::env::var("KEYWORD_FIXTURE_NAMESPACE").unwrap();
    assert!(
        ns.starts_with("keyword-fixture-")
            && ns.ends_with(':')
            && (24..=50).contains(&ns.len())
            && ns
                .trim_end_matches(':')
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    );
    let case = std::env::var("VARIATION_BOOTSTRAP_CASE").unwrap();
    assert!(case == "offline" || case == "online");
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let mongo = mongodb::Client::with_uri_str("mongodb://keyword-mongo:27017").await.unwrap();
        let db = mongo.database(&format!("{}_{}", ns.trim_end_matches(':').replace('-', "_"), case));
        assert!(db.list_collection_names().await.unwrap().is_empty());
        let provider = MuseVariationsProvider::new(reqwest::Client::new(), "http://127.0.0.1:1", None);
        let endpoint = support::Endpoint::new(|_| b"+OK\r\n".to_vec());
        let telemetry = Telemetry::new(redis::Client::open(endpoint.url.as_str()).unwrap(), "variation-test", true);
        let task = telemetry.start().unwrap();
        let service = VariationJobsService::from_application(db.clone(), provider).with_telemetry(telemetry.clone());
        let channel = format!("{ns}{case}");
        let channel_value = channel.as_str().into();
        let saved = doc! {"variations":{"mode":"broad","entries":[{"term":"cat","version":"spelling-variants-v1"}]}};
        assert_eq!(service.request_variation_job(&channel_value, &["cat".into()], &[saved]).await.unwrap().get_str("state").unwrap(), "completed");
        assert!(service.resolve_variations(&channel_value, &[], VariationMode::Off, &[], false).await.is_ok());
        assert!(!service.process_next_variation_job().await.unwrap());
        let terms = vec!["dog".into()];
        let id = variation_job_id(&channel_value, &terms);
        let jobs = db.collection::<Document>("moderation_variation_jobs");
        // Existing view must bypass Redis, even when it is inaccessible.
        jobs.insert_one(doc! {"_id":&id,"state":"pending","entries":[],"error":""}).await.unwrap();
        assert_eq!(service.request_variation_job(&channel_value, &terms, &[]).await.unwrap().get_str("state").unwrap(), "pending");
        jobs.delete_one(doc! {"_id":&id}).await.unwrap();
        if case == "online" {
            let (url, _, _) = support::fixture_url();
            let mut check = redis::aio::ConnectionManager::new(redis::Client::open(url).unwrap()).await.unwrap();
            let word_key = format!("moderation:{channel}:variation-words");
            let job_key = format!("moderation:{channel}:variation-jobs");
            assert!(!check.exists::<_, bool>(&word_key).await.unwrap());
            assert!(!check.exists::<_, bool>(&job_key).await.unwrap());
        }
        let parent = TraceContext { trace_id: "0123456789abcdef0123456789abcdef".into(), span_id: "0123456789abcdef".into(), sampled: true, channel: "channel".into(), outcome: None };
        let request = with_telemetry_context(parent.clone(), service.request_variation_job(&channel_value, &terms, &[])).await;
        if case == "offline" {
            assert!(request.is_err());
            assert!(telemetry.snapshot().spans.is_empty());
            assert_eq!(jobs.find_one(doc! {"_id":&id}).await.unwrap().unwrap().get_str("state").unwrap(), "reserved");
        } else {
            assert_eq!(request.unwrap().get_str("state").unwrap(), "pending");
            let (mut shared, _) = redis_application_runtime::acquire().await.unwrap();
            let (mut shared_again, _) = redis_application_runtime::acquire().await.unwrap();
            let first_id: i64 = redis::cmd("CLIENT").arg("ID").query_async(&mut shared).await.unwrap();
            let second_id: i64 = redis::cmd("CLIENT").arg("ID").query_async(&mut shared_again).await.unwrap();
            assert_eq!(first_id, second_id);
            let word_key = format!("moderation:{channel}:variation-words");
            let job_key = format!("moderation:{channel}:variation-jobs");
            assert_eq!(shared.get::<_, i64>(&word_key).await.unwrap(), 1);
            assert_eq!(shared.get::<_, i64>(&job_key).await.unwrap(), 1);
            assert_eq!(service.request_variation_job(&channel_value, &terms, &[]).await.unwrap().get_str("state").unwrap(), "pending");
            assert_eq!(shared.get::<_, i64>(&word_key).await.unwrap(), 1);
            assert_eq!(shared.get::<_, i64>(&job_key).await.unwrap(), 1);
            // Corrupt the word counter's type: EVAL fails before either increment.
            let _: () = shared.del(&word_key).await.unwrap();
            let _: i64 = shared.lpush(&word_key, "wrongtype").await.unwrap();
            let result = with_telemetry_context(parent, service.request_variation_job(&channel_value, &["fox".into()], &[])).await;
            assert!(result.is_err());
            assert_eq!(shared.get::<_, i64>(&job_key).await.unwrap(), 1);
            let spans = telemetry.snapshot().spans;
            assert!(spans.iter().any(|s| s.kind == "cache" && s.name == "eval" && s.outcome == "ok"));
            assert!(spans.iter().any(|s| s.kind == "cache" && s.name == "eval" && s.outcome == "error"));
            let _: usize = shared.del(&[word_key, job_key]).await.unwrap();
        }
        drop(task);
        db.drop().await.unwrap();
    });
}

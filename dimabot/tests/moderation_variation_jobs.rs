#![cfg(feature = "moderation-variation-jobs")]
use dima_rust::utils::{
    js_string::JsString,
    moderation::variation_jobs::{
        BUDGET_LUA, OrderedEntries, VariationJobsService, variation_job_id, variation_job_view,
    },
};
use mongodb::bson::{Bson, doc};

#[test]
fn javascript_sort_hash_map_and_view() {
    assert_eq!(
        variation_job_id(&"channel".into(), &["b".into(), "a".into()]),
        "a3bc089bd908cb607aa6071c36856a167e2d50f6018f848d32afdc081cdb3696"
    );
    assert_eq!(
        variation_job_id(
            &"c".into(),
            &["😀".into(), JsString::from_units(vec![0xd800])]
        ),
        "36e10bf539521a3ecc0c95441f66458b02141fae8bbd67fe6535a23865e124a8"
    );
    let mut values = OrderedEntries::default();
    values.insert("a".into(), 1.into());
    values.insert("b".into(), 2.into());
    values.insert("a".into(), 3.into());
    assert_eq!(
        values
            .iter()
            .map(|(k, v)| (k.to_utf8_lossy(), v.clone()))
            .collect::<Vec<_>>(),
        vec![("a".into(), 3.into()), ("b".into(), 2.into())]
    );
    let reserved = variation_job_view(
        &doc! {"_id":"x", "state":"reserved", "entries":[{"term":"a"}], "error":""},
    )
    .unwrap();
    assert_eq!(reserved.get_str("state").unwrap(), "pending");
    assert_eq!(reserved.get_array("entries").unwrap().len(), 0);
    let custom =
        variation_job_view(&doc! {"_id":"x", "state":"custom", "entries":[], "error":"reason"})
            .unwrap();
    assert_eq!(custom.get_str("state").unwrap(), "custom");
    let source = include_str!("../src/utils/moderation/variation_jobs.ts");
    let script = source
        .split("redis.eval(`")
        .nth(1)
        .unwrap()
        .split('`')
        .next()
        .unwrap();
    assert_eq!(BUDGET_LUA.as_bytes(), script.as_bytes());
}

#[tokio::test]
#[ignore = "requires task-owned keyword-mongo/keyword-redis and a private namespace"]
async fn disposable_storage_budget_claim_and_provider_failure() {
    use dima_rust::{
        schemas::moderation_variation,
        utils::moderation::variations_provider::MuseVariationsProvider,
    };
    use redis::AsyncCommands;
    let mongo_uri = std::env::var("KEYWORD_FIXTURE_MONGO_URI").unwrap();
    let redis_url = std::env::var("KEYWORD_FIXTURE_REDIS_URL").unwrap();
    assert_eq!(mongo_uri, "mongodb://keyword-mongo:27017");
    assert_eq!(redis_url, "redis://keyword-redis:6379/");
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
    let mongo = mongodb::Client::with_uri_str(mongo_uri).await.unwrap();
    let db = mongo.database(&ns.trim_end_matches(':').replace('-', "_"));
    assert!(db.list_collection_names().await.unwrap().is_empty());
    let mut redis = redis::aio::ConnectionManager::new(redis::Client::open(redis_url).unwrap())
        .await
        .unwrap();
    let channel = format!("{}channel", ns);
    let word_key = format!("moderation:{channel}:variation-words");
    let job_key = format!("moderation:{channel}:variation-jobs");
    assert!(!redis.exists::<_, bool>(&word_key).await.unwrap());
    assert!(!redis.exists::<_, bool>(&job_key).await.unwrap());
    let provider = MuseVariationsProvider::new(reqwest::Client::new(), "http://127.0.0.1:1", None);
    let service = VariationJobsService::new(db.clone(), redis.clone(), provider);
    let terms = vec!["cat".into()];
    let channel_value: JsString = channel.clone().into();
    let (first, raced) = tokio::join!(
        service.request_variation_job(&channel_value, &terms, &[]),
        service.request_variation_job(&channel_value, &terms, &[])
    );
    let first = first.unwrap();
    let raced = raced.unwrap();
    assert_eq!(first.get_str("id").unwrap(), raced.get_str("id").unwrap());
    assert_eq!(first.get_str("state").unwrap(), "pending");
    let id = first.get_str("id").unwrap();
    let same = service
        .request_variation_job(&channel.clone().into(), &terms, &[])
        .await
        .unwrap();
    assert_eq!(same.get_str("id").unwrap(), id);
    assert_eq!(redis.get::<_, i64>(&word_key).await.unwrap(), 1);
    assert_eq!(redis.get::<_, i64>(&job_key).await.unwrap(), 1);
    let ttl: i64 = redis.ttl(&word_key).await.unwrap();
    assert!(ttl > 86_390 && ttl <= 86_400);
    assert!(service.process_next_variation_job().await.unwrap());
    let jobs = moderation_variation::get_moderation_variation_job_model(&db);
    let failed = jobs
        .collection
        .find_one(doc! {"_id":id})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(failed.get_str("error").unwrap(), "plan_required");
    db.collection::<mongodb::bson::Document>("users")
        .insert_one(doc! {"accounts":[{"type":"twitch","id":&channel}],"plan_tier":"pro"})
        .await
        .unwrap();
    service
        .request_variation_job(&channel.clone().into(), &terms, &[])
        .await
        .unwrap();
    assert!(service.process_next_variation_job().await.unwrap());
    let failed = jobs
        .collection
        .find_one(doc! {"_id":id})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(failed.get_str("error").unwrap(), "generation_unavailable");
    assert_eq!(failed.get("creditsCharged"), Some(&Bson::Int32(0)));
    let _: () = redis.set(&word_key, 500).await.unwrap();
    let limited = service
        .request_variation_job(&channel.clone().into(), &["dog".into()], &[])
        .await
        .unwrap_err();
    assert!(
        limited
            .to_string()
            .contains("Daily variation-generation limit")
    );
    jobs.collection
        .update_one(
            doc! {"_id":id},
            doc! {"$set":{"state":"pending","deadline":mongodb::bson::DateTime::from_millis(1)}},
        )
        .await
        .unwrap();
    assert!(!service.process_next_variation_job().await.unwrap());
    let expired = jobs
        .collection
        .find_one(doc! {"_id":id})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(expired.get_str("error").unwrap(), "generation_timeout");
    let _: usize = redis.del(vec![word_key, job_key]).await.unwrap();
    db.drop().await.unwrap();
}

/// Real loopback OpenRouter-shaped responder. Each request describes its own
/// terms, so batches and the actual provider JSON parser are exercised.
fn loopback_provider(
    expected: usize,
) -> (
    String,
    std::sync::mpsc::Receiver<Vec<usize>>,
    std::thread::JoinHandle<()>,
) {
    use std::io::{BufRead, BufReader, Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let task = std::thread::spawn(move || {
        let mut sizes = Vec::new();
        for incoming in listener.incoming().take(expected) {
            let mut socket = incoming.unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut length = 0;
            loop {
                let mut line = String::new();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
                if let Some((key, value)) = line.split_once(':')
                    && key.eq_ignore_ascii_case("content-length")
                {
                    length = value.trim().parse().unwrap();
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let content: serde_json::Value =
                serde_json::from_str(request["messages"][1]["content"].as_str().unwrap()).unwrap();
            let terms = content["terms"].as_array().unwrap();
            sizes.push(terms.len());
            let entries = terms
                .iter()
                .map(|term| serde_json::json!({"term":term,"spellings":[]}))
                .collect::<Vec<_>>();
            let answer = serde_json::json!({"entries":entries}).to_string();
            let response = serde_json::json!({"choices":[{"finish_reason":"stop","message":{"content":answer}}],"model":"fixture-model","usage":{"input_tokens":7}}).to_string();
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
        }
        tx.send(sizes).unwrap();
    });
    (format!("http://{addr}/completions"), rx, task)
}

#[tokio::test]
#[ignore = "requires task-owned keyword-mongo/keyword-redis and a private namespace"]
async fn disposable_real_provider_batches_reuse_and_cache() {
    use dima_rust::{
        schemas::moderation_variation,
        utils::moderation::variations_provider::MuseVariationsProvider,
    };
    use redis::AsyncCommands;
    let mongo_uri = std::env::var("KEYWORD_FIXTURE_MONGO_URI").unwrap();
    let redis_url = std::env::var("KEYWORD_FIXTURE_REDIS_URL").unwrap();
    assert_eq!(mongo_uri, "mongodb://keyword-mongo:27017");
    assert_eq!(redis_url, "redis://keyword-redis:6379/");
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
    let mongo = mongodb::Client::with_uri_str(mongo_uri).await.unwrap();
    let db = mongo.database(&format!(
        "{}_provider",
        ns.trim_end_matches(':').replace('-', "_")
    ));
    assert!(db.list_collection_names().await.unwrap().is_empty());
    let mut redis = redis::aio::ConnectionManager::new(redis::Client::open(redis_url).unwrap())
        .await
        .unwrap();
    let channel = format!("{}provider", ns);
    let key1 = format!("moderation:{channel}:variation-words");
    let key2 = format!("moderation:{channel}:variation-jobs");
    assert!(
        !redis.exists::<_, bool>(&key1).await.unwrap()
            && !redis.exists::<_, bool>(&key2).await.unwrap()
    );
    db.collection::<mongodb::bson::Document>("users")
        .insert_one(doc! {"accounts":[{"type":"twitch","id":&channel}],"plan_tier":"premium"})
        .await
        .unwrap();
    let (url, calls, server) = loopback_provider(2);
    let provider =
        MuseVariationsProvider::new(reqwest::Client::new(), url, Some("fixture-key".into()));
    let service = VariationJobsService::new(db.clone(), redis.clone(), provider);
    let terms: Vec<JsString> = (0..21).map(|i| format!("term{i:02}").into()).collect();
    let requested = service
        .request_variation_job(&channel.clone().into(), &terms, &[])
        .await
        .unwrap();
    let id = requested.get_str("id").unwrap();
    assert!(service.process_next_variation_job().await.unwrap());
    assert_eq!(
        calls
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap(),
        vec![20, 1]
    );
    server.join().unwrap();
    let jobs = moderation_variation::get_moderation_variation_job_model(&db);
    let job = jobs
        .collection
        .find_one(doc! {"_id":id})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(job.get_str("state").unwrap(), "completed");
    assert_eq!(job.get_array("entries").unwrap().len(), 21);
    assert_eq!(job.get_array("providerUsage").unwrap().len(), 2);
    assert_eq!(job.get("creditsCharged"), Some(&Bson::Int32(0)));
    let cache = moderation_variation::get_moderation_variation_cache_model(&db);
    assert_eq!(cache.collection.count_documents(doc! {}).await.unwrap(), 21);
    let key =
        dima_rust::utils::moderation::variations::variation_key(&channel.clone().into(), &terms[0]);
    let cached = cache
        .collection
        .find_one(doc! {"_id":&key})
        .await
        .unwrap()
        .unwrap();
    let age = cached.get_datetime("expiresAt").unwrap().timestamp_millis()
        - mongodb::bson::DateTime::now().timestamp_millis();
    assert!(age > 179 * 86_400_000 && age <= 180 * 86_400_000);
    cache
        .collection
        .update_one(
            doc! {"_id":&key},
            doc! {"$set":{"entry.extra":{"sentinel":42},"entry.pattern.extra":"retained"}},
        )
        .await
        .unwrap();
    let resolved = service
        .resolve_variations(
            &channel.clone().into(),
            &terms[..1],
            dima_rust::utils::moderation::types::VariationMode::Broad,
            &[],
            true,
        )
        .await
        .unwrap();
    let entry = resolved.get_array("entries").unwrap()[0]
        .as_document()
        .unwrap();
    assert_eq!(
        entry
            .get_document("extra")
            .unwrap()
            .get_i32("sentinel")
            .unwrap(),
        42
    );
    assert_eq!(
        entry
            .get_document("pattern")
            .unwrap()
            .get_str("extra")
            .unwrap(),
        "retained"
    );
    let saved = service
        .request_variation_job(&channel.clone().into(), &terms, &[])
        .await
        .unwrap();
    assert_eq!(saved.get_str("id").unwrap(), "");
    assert_eq!(saved.get_str("state").unwrap(), "completed");
    assert_eq!(redis.get::<_, i64>(&key1).await.unwrap(), 21);
    assert_eq!(redis.get::<_, i64>(&key2).await.unwrap(), 1);
    let _: usize = redis.del(vec![key1, key2]).await.unwrap();
    db.drop().await.unwrap();
}

struct FixedClock(i64);
impl dima_rust::utils::moderation::variation_jobs::Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

#[tokio::test]
#[ignore = "requires task-owned keyword-mongo/keyword-redis and a private namespace"]
async fn disposable_provider_abort_and_expiry_claim() {
    use dima_rust::{
        schemas::moderation_variation,
        utils::moderation::variations_provider::MuseVariationsProvider,
    };
    use std::io::{Read, Write};
    let mongo_uri = std::env::var("KEYWORD_FIXTURE_MONGO_URI").unwrap();
    let redis_url = std::env::var("KEYWORD_FIXTURE_REDIS_URL").unwrap();
    assert_eq!(mongo_uri, "mongodb://keyword-mongo:27017");
    assert_eq!(redis_url, "redis://keyword-redis:6379/");
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
    let mongo = mongodb::Client::with_uri_str(mongo_uri).await.unwrap();
    let db = mongo.database(&format!(
        "{}_abort",
        ns.trim_end_matches(':').replace('-', "_")
    ));
    assert!(db.list_collection_names().await.unwrap().is_empty());
    let redis = redis::aio::ConnectionManager::new(redis::Client::open(redis_url).unwrap())
        .await
        .unwrap();
    let channel = format!("{}abort", ns);
    db.collection::<mongodb::bson::Document>("users")
        .insert_one(doc! {"accounts":[{"type":"twitch","id":&channel}],"plan_tier":"pro"})
        .await
        .unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let responder = std::thread::spawn(move || {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let (mut socket, _) = loop {
            match listener.accept() {
                Ok(pair) => break pair,
                Err(e)
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        && std::time::Instant::now() < until =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(5))
                }
                Err(e) => panic!("fixture listener: {e}"),
            }
        };
        socket
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        let mut buffer = [0; 4096];
        let _ = socket.read(&mut buffer);
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
    });
    let provider = MuseVariationsProvider::new(
        reqwest::Client::new(),
        format!("http://{address}"),
        Some("fixture".into()),
    );
    let service = VariationJobsService::new(db.clone(), redis, provider)
        .with_clock(std::sync::Arc::new(FixedClock(10_000)));
    let jobs = moderation_variation::get_moderation_variation_job_model(&db);
    let now = mongodb::bson::DateTime::from_millis(10_000);
    jobs.insert(doc! {"_id":"abort", "channelID":&channel, "terms":["cat"], "state":"pending", "createdAt":now, "deadline":mongodb::bson::DateTime::from_millis(10_100), "expiresAt":mongodb::bson::DateTime::from_millis(20_000),"model":"fixture","version":"spelling-variants-v1"},now).await.unwrap();
    assert!(service.process_next_variation_job().await.unwrap());
    let job = jobs
        .collection
        .find_one(doc! {"_id":"abort"})
        .await
        .unwrap()
        .unwrap();
    // AbortSignal's AbortError is not one of the three recognized messages.
    assert_eq!(job.get_str("error").unwrap(), "invalid_generation");
    responder.join().unwrap();
    db.drop().await.unwrap();
}

fn tagged_string(value: &serde_json::Value) -> String {
    let units = value["utf16"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_u64().unwrap() as u16)
        .collect::<Vec<_>>();
    String::from_utf16(&units).expect("oracle BSON strings must be valid UTF-16")
}
fn tagged_bson(value: &serde_json::Value) -> Bson {
    match value["kind"].as_str().unwrap() {
        "string" => Bson::String(tagged_string(value)),
        "null" => Bson::Null,
        "undefined" => Bson::Undefined,
        "boolean" => Bson::Boolean(value["value"].as_bool().unwrap()),
        "number" => Bson::Double(f64::from_bits(
            u64::from_str_radix(value["bits"].as_str().unwrap(), 16).unwrap(),
        )),
        "date" => match tagged_bson(&value["milliseconds"]) {
            Bson::Double(n) => Bson::DateTime(mongodb::bson::DateTime::from_millis(n as i64)),
            _ => unreachable!(),
        },
        "array" => Bson::Array(
            value["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(tagged_bson)
                .collect(),
        ),
        "object" => {
            let mut doc = mongodb::bson::Document::new();
            for pair in value["entries"].as_array().unwrap() {
                let units = pair[0]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| n.as_u64().unwrap() as u16)
                    .collect::<Vec<_>>();
                doc.insert(String::from_utf16(&units).unwrap(), tagged_bson(&pair[1]));
            }
            Bson::Document(doc)
        }
        other => panic!("unsupported oracle tag {other}"),
    }
}
#[test]
#[ignore = "requires independently generated, checksum-pinned actual-source oracle"]
fn source_oracle_job_views() {
    use sha2::{Digest, Sha256};
    let path = std::env::var("DIMA_VARIATION_JOBS_REFERENCE").expect("source oracle path");
    let expected =
        std::env::var("DIMA_VARIATION_JOBS_REFERENCE_SHA256").expect("independent oracle digest");
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), expected);
    let reference: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let cases = reference["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 38);
    let mut matched = 0;
    for case in cases
        .iter()
        .filter(|c| c["operation"] == "variationJobView")
    {
        let args = case["args"]["items"].as_array().unwrap();
        let input = tagged_bson(&args[0]).as_document().unwrap().clone();
        let expected = tagged_bson(&case["outcome"]["value"]);
        assert_eq!(
            Bson::Document(variation_job_view(&input).unwrap()),
            expected,
            "{}",
            case["name"]
        );
        matched += 1;
    }
    assert_eq!(matched, 5);
}

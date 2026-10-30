#![cfg(feature = "moderation-semantic-worker")]
//! Author-only fixture. Runs solely in the explicitly owned private environment.
use dima_rust::utils::{
    ai_credit_projection::AiCreditProjection,
    ai_credit_reader::AiCreditReader,
    ai_usage_producer::AiUsageProducer,
    moderation::{
        semantic::{SemanticClock, SemanticProvider},
        semantic_worker::SemanticWorker,
    },
    polar::{PolarClient, PolarConfig, PolarPolicy},
    polar_cache_usage::PolarCacheUsage,
    posthog_lossless::PosthogLosslessConfig,
    posthog_tracking::PosthogTracking,
};
use futures_util::FutureExt;
use mongodb::{
    Client,
    bson::{DateTime, Document, doc},
};
use std::{panic::AssertUnwindSafe, time::Duration};

struct Fixed(f64);
impl SemanticClock for Fixed {
    fn now_ms(&self) -> f64 {
        self.0
    }
}

#[tokio::test]
#[ignore = "private task-owned Mongo and Redis only; no production resources"]
async fn atomic_claim_expiry_and_ready_backlog() {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration")
    );
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_MONGO_URI").as_deref(),
        Ok("mongodb://keyword-mongo:27017")
    );
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_REDIS_URL").as_deref(),
        Ok("redis://keyword-redis:6379/")
    );
    let namespace = std::env::var("KEYWORD_FIXTURE_NAMESPACE").unwrap();
    let nonce = namespace
        .strip_prefix("keyword-fixture-")
        .and_then(|s| s.strip_suffix(':'))
        .unwrap();
    assert_eq!(nonce.len(), 12);
    assert!(
        nonce
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    let dbname = format!("semantic_worker_{nonce}");
    let mut options = mongodb::options::ClientOptions::parse("mongodb://keyword-mongo:27017")
        .await
        .unwrap();
    options.retry_reads = Some(false);
    options.retry_writes = Some(false);
    let mongo = Client::with_options(options).unwrap();
    let db = mongo.database(&dbname);
    assert!(
        mongo
            .list_database_names()
            .await
            .unwrap()
            .iter()
            .all(|n| n != &dbname),
        "fresh database required"
    );
    let markers = db.collection::<Document>("fixture_marker");
    markers
        .insert_one(doc! {"_id":&namespace,"owner":"dimabot-migration"})
        .await
        .unwrap();
    let work=AssertUnwindSafe(async {
        let redis=redis::aio::ConnectionManager::new(redis::Client::open("redis://keyword-redis:6379/").unwrap()).await.unwrap();
        let projection=AiCreditProjection::new(redis.clone(),Duration::from_secs(1));
        let polar=PolarClient::new(PolarConfig::new("http://127.0.0.1:9","fixture").unwrap(),PolarPolicy::Billing).unwrap();
        let reader=AiCreditReader::new(redis.clone(),db.clone(),polar,Duration::from_millis(750)).unwrap();
        let provider=SemanticProvider::new(reqwest::Client::new(),"http://127.0.0.1:9/decisions",Some("fixture".into()));
        let posthog=PosthogTracking::from_lossless_config(PosthogLosslessConfig::new("fixture","http://127.0.0.1:9/batch/")).unwrap();
        let usage=PolarCacheUsage::new(redis.clone(),projection.clone(),AiUsageProducer::new(redis),posthog);
        let worker=SemanticWorker::new(db.clone(),projection,reader,provider,usage);
        let decisions=db.collection::<Document>("moderation_decisions");
        let now=1_700_000_000_000_i64;
        for (id,created,deadline) in [("first",1,now+1000),("second",2,now+1000),("third",3,now+1000),("expired",0,now)] {
            decisions.insert_one(doc!{"_id":id,"state":"pending","deadline":DateTime::from_millis(deadline),"createdAt":DateTime::from_millis(created),"channelID":&namespace,"ruleID":"rule","settingsVersion":1,"consequence":{"status":"none"},"extra":{"untouched":true}}).await.unwrap();
        }
        // Oldest ready work wins even when an older expired item is present.
        assert!(worker.process_next_with_clock(&Fixed(now as f64)).await.unwrap());
        assert_eq!(decisions.find_one(doc!{"_id":"first"}).await.unwrap().unwrap().get_str("state").unwrap(),"completed");
        assert_eq!(decisions.find_one(doc!{"_id":"second"}).await.unwrap().unwrap().get_str("state").unwrap(),"pending");
        // Two independent claimers cannot claim the same document. Inactive
        // policy avoids all external traffic and produces safe fallback.
        let concurrent_clock = Fixed(now as f64);
        let (a,b)=tokio::join!(worker.process_next_with_clock(&concurrent_clock),worker.process_next_with_clock(&concurrent_clock));
        assert!(a.unwrap()&&b.unwrap());
        assert!(!worker.process_next_with_clock(&Fixed(now as f64)).await.unwrap());assert_source_outcome("empty",true,Some(false));
        for id in ["first","second","third"] {
            let d=decisions.find_one(doc!{"_id":id}).await.unwrap().unwrap();
            assert_eq!(d.get_str("state").unwrap(),"completed");
            assert_eq!(d.get_str("status").unwrap(),"policy_changed");
            assert!(d.get_document("extra").unwrap().get_bool("untouched").unwrap());
        }
        let expired=decisions.find_one(doc!{"_id":"expired"}).await.unwrap().unwrap();
        assert_eq!(expired.get_str("state").unwrap(),"pending");
        worker.maintain_with_clock(&Fixed(now as f64)).await.unwrap();assert_source_outcome("maintenance-empty",true,None);assert_source_ingests("maintenance-empty",0);
        let expired=decisions.find_one(doc!{"_id":"expired"}).await.unwrap().unwrap();
        assert_eq!(expired.get_str("status").unwrap(),"timeout");
        assert_eq!(expired.get_document("consequence").unwrap().get_str("status").unwrap(),"allowed_fallback");
    }).catch_unwind().await;
    // Even on panic, drop only a database with our exact ownership marker.
    let marker = markers
        .find_one(doc! {"_id":&namespace,"owner":"dimabot-migration"})
        .await
        .unwrap();
    assert!(marker.is_some(), "refusing to clean an unmarked database");
    db.drop().await.unwrap();
    if let Err(panic) = work {
        std::panic::resume_unwind(panic);
    }
}

/// The peer serves only loopback and advances a test clock before a reply when
/// asked. This exercises the real HTTP client and Mongo fences together.
struct Peer {
    address: String,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    advance: std::sync::Arc<std::sync::atomic::AtomicBool>,
    status: std::sync::Arc<std::sync::atomic::AtomicU16>,
    invalid: std::sync::Arc<std::sync::atomic::AtomicBool>,
    close: std::sync::Arc<std::sync::atomic::AtomicBool>,
    score: std::sync::Arc<std::sync::atomic::AtomicU64>,
    requests: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    hold: std::sync::Arc<std::sync::atomic::AtomicBool>,
    entered: std::sync::Arc<std::sync::atomic::AtomicBool>,
    clock: std::sync::Arc<std::sync::atomic::AtomicI64>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Peer {
    fn new(now: i64) -> Self {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, AtomicI64, AtomicU16, AtomicU64, Ordering},
        };
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = format!("http://{}/decisions", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let advance = Arc::new(AtomicBool::new(false));
        let status = Arc::new(AtomicU16::new(200));
        let invalid = Arc::new(AtomicBool::new(false));
        let close = Arc::new(AtomicBool::new(false));
        let score = Arc::new(AtomicU64::new(0.5f64.to_bits()));
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let hold = Arc::new(AtomicBool::new(false));
        let entered = Arc::new(AtomicBool::new(false));
        let clock = Arc::new(AtomicI64::new(now));
        let (s, a, c, st, bad, closed, prob, seen, held, entered_peer) = (
            stop.clone(),
            advance.clone(),
            clock.clone(),
            status.clone(),
            invalid.clone(),
            close.clone(),
            score.clone(),
            requests.clone(),
            hold.clone(),
            entered.clone(),
        );
        let thread = std::thread::spawn(move || {
            use std::io::{Read, Write};
            while !s.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(v) => v,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(e) => panic!("fixture listener: {e}"),
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut data = Vec::new();
                let mut block = [0; 4096];
                let body_start = loop {
                    let n = stream.read(&mut block).unwrap();
                    assert!(n > 0);
                    data.extend_from_slice(&block[..n]);
                    if let Some(i) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                };
                let headers = String::from_utf8_lossy(&data[..body_start]);
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        line.split_once(':').and_then(|(key, v)| {
                            key.eq_ignore_ascii_case("content-length")
                                .then(|| v.trim().parse().unwrap())
                        })
                    })
                    .unwrap();
                while data.len() - body_start < length {
                    let n = stream.read(&mut block).unwrap();
                    assert!(n > 0);
                    data.extend_from_slice(&block[..n]);
                }
                seen.lock().unwrap().push(
                    String::from_utf8(data[body_start..body_start + length].to_vec()).unwrap(),
                );
                if held.load(Ordering::SeqCst) {
                    entered_peer.store(true, Ordering::SeqCst);
                    let until = std::time::Instant::now() + Duration::from_secs(5);
                    while held.load(Ordering::SeqCst)
                        && !s.load(Ordering::SeqCst)
                        && std::time::Instant::now() < until
                    {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    assert!(!held.load(Ordering::SeqCst), "fixture HTTP hold timed out");
                }
                if a.swap(false, Ordering::SeqCst) {
                    c.fetch_add(1000, Ordering::SeqCst);
                }
                if closed.load(Ordering::SeqCst) {
                    continue;
                }
                let body = if bad.load(Ordering::SeqCst) {
                    "{}".to_owned()
                } else {
                    format!(
                        r#"{{"answers":{{"violation":{{"type":"noul","noul":{}}}}},"usage":{{"cost":0.01,"input_tokens":1000000}},"model":"fixture-model","provider":"openrouter","id":"provider-id"}}"#,
                        f64::from_bits(prob.load(Ordering::SeqCst))
                    )
                };
                write!(stream,"HTTP/1.1 {} fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",st.load(Ordering::SeqCst),body.len(),body).unwrap();
            }
        });
        Self {
            address,
            stop,
            advance,
            status,
            invalid,
            close,
            score,
            requests,
            hold,
            entered,
            clock,
            thread: Some(thread),
        }
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        self.hold.store(false, std::sync::atomic::Ordering::SeqCst);
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            t.join().unwrap();
        }
    }
}
#[derive(Clone)]
struct SharedClock(std::sync::Arc<std::sync::atomic::AtomicI64>);
impl SemanticClock for SharedClock {
    fn now_ms(&self) -> f64 {
        self.0.load(std::sync::atomic::Ordering::SeqCst) as f64
    }
}

#[tokio::test]
#[ignore = "private task-owned Mongo, Redis and loopback HTTP only"]
async fn paid_fences_recovery_and_bounded_charge_pass() {
    use std::sync::atomic::Ordering;
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration")
    );
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_MONGO_URI").as_deref(),
        Ok("mongodb://keyword-mongo:27017")
    );
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_REDIS_URL").as_deref(),
        Ok("redis://keyword-redis:6379/")
    );
    let namespace = std::env::var("KEYWORD_FIXTURE_NAMESPACE").unwrap();
    let nonce = namespace
        .strip_prefix("keyword-fixture-")
        .and_then(|s| s.strip_suffix(':'))
        .unwrap();
    assert_eq!(nonce.len(), 12);
    assert!(
        nonce
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    let mut options = mongodb::options::ClientOptions::parse("mongodb://keyword-mongo:27017")
        .await
        .unwrap();
    options.retry_reads = Some(false);
    options.retry_writes = Some(false);
    let mongo = Client::with_options(options).unwrap();
    let dbname = format!("semantic_paid_{nonce}");
    assert!(
        mongo
            .list_database_names()
            .await
            .unwrap()
            .iter()
            .all(|s| s != &dbname)
    );
    let db = mongo.database(&dbname);
    let markers = db.collection::<Document>("fixture_marker");
    markers
        .insert_one(doc! {"_id":&namespace,"owner":"dimabot-migration"})
        .await
        .unwrap();
    let mut cache = redis::aio::ConnectionManager::new(
        redis::Client::open("redis://keyword-redis:6379/").unwrap(),
    )
    .await
    .unwrap();
    let marker = format!("{namespace}semantic-worker-owner");
    let fresh: Option<String> = redis::cmd("SET")
        .arg(&marker)
        .arg("dimabot-migration")
        .arg("NX")
        .query_async(&mut cache)
        .await
        .unwrap();
    assert_eq!(fresh.as_deref(), Some("OK"));
    let receipt = "cron:ai-usage-receipts:queue";
    let peer = Peer::new(1_700_000_000_000);
    let clock = SharedClock(peer.clock.clone());
    let mut receipt_owned = false;
    let work=AssertUnwindSafe(async {
        let exists:i64=redis::cmd("EXISTS").arg(receipt).query_async(&mut cache).await.unwrap();assert_eq!(exists,0,"receipt queue must be private and empty");receipt_owned=true;
        let projection=AiCreditProjection::new(cache.clone(),Duration::from_secs(1));
        let polar=PolarClient::new(PolarConfig::new("http://127.0.0.1:9","fixture").unwrap(),PolarPolicy::Billing).unwrap();
        let reader=AiCreditReader::new(cache.clone(),db.clone(),polar,Duration::from_millis(750)).unwrap();
        let provider=SemanticProvider::new(reqwest::Client::new(),&peer.address,Some("fixture".into()));
        let mut config=PosthogLosslessConfig::new("fixture","http://127.0.0.1:9/batch/");config.flush_interval=Duration::from_secs(3600);config.flush_at=1000;
        let posthog=PosthogTracking::from_lossless_config(config).unwrap();
        let usage=PolarCacheUsage::new(cache.clone(),projection.clone(),AiUsageProducer::new(cache.clone()),posthog);
        let worker=SemanticWorker::new(db.clone(),projection.clone(),reader.clone(),provider,usage);
        let decisions=db.collection::<Document>("moderation_decisions");let channel=format!("{namespace}channel");
        db.collection::<Document>("users").insert_one(doc!{"accounts":[{"type":"twitch","id":&channel}],"plan_tier":"premium","polar_sh_customer_id":"fixture-customer"}).await.unwrap();
        db.collection::<Document>("channel_moderation_settings").insert_one(doc!{"channelID":&channel,"settingsVersion":1,"enabled":true,"rules":[{"id":"r","enabled":true}]}).await.unwrap();
        let credit_key=format!("twitch:{channel}:ai:credits");
        let _:()=redis::cmd("SET").arg(credit_key).arg(r#"{"version":3,"used":0,"limit":200000,"balance":200000,"available":true,"status":"available"}"#).query_async(&mut cache).await.unwrap();
        let decision=|id:&str,created:i64| doc!{"_id":id,"channelID":&channel,"messageID":"fixture-message","username":"fixture","messageText":"fixture text","ruleID":"r","rule":{"id":"r","semantic":{"policy":"p","examples":[],"thresholdPercent":85}},"settingsVersion":1,"reviewSource":"rule","context":[],"matches":[],"state":"pending","deadline":DateTime::from_millis(1_700_000_001_000),"createdAt":DateTime::from_millis(created),"consequence":{"status":"allowed"},"extra":{"preserve":true}};
        decisions.insert_one(decision("paid",1)).await.unwrap();
        assert!(worker.process_next_with_clock(&clock).await.unwrap());
        let paid=decisions.find_one(doc!{"_id":"paid"}).await.unwrap().unwrap();
        assert_eq!(paid.get_str("status").unwrap(),"uncertain");assert_eq!(paid.get_str("state").unwrap(),"completed");
        assert_eq!(paid.get_document("charge").unwrap().get_str("status").unwrap(),"pending");
        assert_eq!(paid.get_document("charge").unwrap().get_str("externalID").unwrap(),"moderation:paid");
        compare_source_result("paid-uncertain",&paid,false);
        let mut late=decision("late",2);late.insert("verdict","uncertain");late.insert("status","timeout");late.insert("charge",doc!{"status":"none","sentinel":true});decisions.insert_one(late).await.unwrap();
        peer.advance.store(true,Ordering::SeqCst);assert!(worker.process_next_with_clock(&clock).await.unwrap());
        let late=decisions.find_one(doc!{"_id":"late"}).await.unwrap().unwrap();
        assert_eq!(late.get_str("state").unwrap(),"processing");assert_eq!(late.get_str("status").unwrap(),"timeout");assert_eq!(late.get_str("model").unwrap(),"fixture-model");
        assert_eq!(late.get_document("charge").unwrap().get_str("status").unwrap(),"none");assert!(late.get_document("extra").unwrap().get_bool("preserve").unwrap());
        compare_source_result("late",&late,true);
        worker.maintain_with_clock(&clock).await.unwrap();
        let late=decisions.find_one(doc!{"_id":"late"}).await.unwrap().unwrap();assert_eq!(late.get_str("state").unwrap(),"completed");assert_eq!(late.get_str("status").unwrap(),"timeout");
        let paid=decisions.find_one(doc!{"_id":"paid"}).await.unwrap().unwrap();assert_eq!(paid.get_document("charge").unwrap().get_str("status").unwrap(),"recorded");
        let queue=format!("twitch:{channel}:ai:polarshevent");
        let events:Vec<String>=redis::cmd("LRANGE").arg(&queue).arg(0).arg(-1).query_async(&mut cache).await.unwrap();assert_eq!(events.len(),1);
        let wire:serde_json::Value=serde_json::from_str(&events[0]).unwrap();
        assert_eq!(wire["name"],"ai_usage");assert_eq!(wire["customerId"],"fixture-customer");assert_eq!(wire["externalId"],"moderation:paid");
        let metadata=&wire["metadata"];
        for (key,value) in [("entry_id","moderation:paid"),("request_id","paid"),("operation","contextual_moderation"),("category","other"),("usage_source","moderation"),("provider","openrouter"),("resource_type","llm_generation"),("resource_id","fixture-message"),("channel_id",channel.as_str())] {assert_eq!(metadata[key],value,"{key}");}
        assert_eq!(metadata["_llm"]["inputTokens"],1000000);assert_eq!(metadata["_llm"]["outputTokens"],0);assert_eq!(metadata["_llm"]["totalTokens"],1000000);
        assert_eq!(metadata["reason"],"contextual_moderation");assert_eq!(metadata["credits"],4200);
        // Missing semantic policy triggers catch recovery before provider I/O.
        peer.clock.store(1_700_000_000_000,Ordering::SeqCst);
        let mut malformed=decision("recovery",3);malformed.insert("rule",doc!{"id":"r"});decisions.insert_one(malformed).await.unwrap();
        assert!(worker.process_next_with_clock(&clock).await.unwrap());let recovered=decisions.find_one(doc!{"_id":"recovery"}).await.unwrap().unwrap();assert_eq!(recovered.get_str("status").unwrap(),"unavailable");assert_eq!(recovered.get_str("state").unwrap(),"completed");compare_source_result("missing-rule",&recovered,false);
        // Real HTTP failures and malformed provider output never create charges.
        for (id,http,invalid,expected) in [("rate-limit",429,false,"rate_limited"),("server-error",500,false,"unavailable"),("invalid-response",200,true,"invalid_response")] {
            peer.status.store(http,Ordering::SeqCst);peer.invalid.store(invalid,Ordering::SeqCst);
            decisions.insert_one(decision(id,4)).await.unwrap();assert!(worker.process_next_with_clock(&clock).await.unwrap());
            let d=decisions.find_one(doc!{"_id":id}).await.unwrap().unwrap();assert_eq!(d.get_str("status").unwrap(),expected);assert_eq!(d.get_document("charge").unwrap().get_str("status").unwrap(),"none");let source=match id {"rate-limit"=>"provider-429","server-error"=>"provider-500",_=>"provider-invalid"};compare_source_result(source,&d,false);
        }
        peer.status.store(200,Ordering::SeqCst);peer.invalid.store(false,Ordering::SeqCst);
        // While the oldest claim is held at real provider I/O, a second pass
        // must claim the next ready row, never the processing row.
        let mut first=decision("held-first",-2);first.insert("consequence",doc!{"status":"none"});
        let mut second=decision("held-second",-1);second.insert("settingsVersion",999);second.insert("consequence",doc!{"status":"none"});
        decisions.insert_many(vec![first,second]).await.unwrap();peer.entered.store(false,Ordering::SeqCst);peer.hold.store(true,Ordering::SeqCst);
        let w=worker.clone();let c=clock.clone();let running=tokio::spawn(async move {w.process_next_with_clock(&c).await});
        tokio::time::timeout(Duration::from_secs(3),async {while !peer.entered.load(Ordering::SeqCst) {tokio::time::sleep(Duration::from_millis(5)).await;}}).await.unwrap();
        assert_eq!(decisions.find_one(doc!{"_id":"held-first"}).await.unwrap().unwrap().get_str("state").unwrap(),"processing");
        assert!(worker.process_next_with_clock(&clock).await.unwrap());assert_eq!(decisions.find_one(doc!{"_id":"held-second"}).await.unwrap().unwrap().get_str("status").unwrap(),"policy_changed");
        peer.hold.store(false,Ordering::SeqCst);assert!(running.await.unwrap().unwrap());
        assert_eq!(decisions.find_one(doc!{"_id":"held-first"}).await.unwrap().unwrap().get_str("state").unwrap(),"completed");
        // Replay policy and plan branches against source captures with real
        // Mongo reads and a private Redis snapshot for each scenario.
        for id in ["policy-version","plan-free","plan-case-mismatch","missing-owner","plan-no-customer","spam-disabled","spam-empty-categories","spam-continuous-off","paid-exhausted","paid-unavailable","paid-exhausted-status","paid-no-balance"] {
            db.collection::<Document>("users").delete_many(doc!{}).await.unwrap();
            db.collection::<Document>("channel_moderation_settings").delete_many(doc!{}).await.unwrap();
            let _:i64=redis::cmd("DEL").arg(format!("twitch:{channel}:ai:exhaust")).arg(format!("{channel}:ai:exhaust")).arg(format!("twitch:{channel}:ai:credits")).query_async(&mut cache).await.unwrap();
            let tier=match id {"plan-free"=>"free","plan-case-mismatch"=>"Premium",_=>"premium"};
            if id!="missing-owner" {
                let mut owner=doc!{"accounts":[{"type":"twitch","id":&channel}],"plan_tier":tier};
                if !matches!(id,"plan-free"|"plan-no-customer") {owner.insert("polar_sh_customer_id","fixture-customer");}
                db.collection::<Document>("users").insert_one(owner).await.unwrap();
            }
            let mut settings=doc!{"channelID":&channel,"settingsVersion":if id=="policy-version" {2} else {1},"enabled":true,"rules":[{"id":"r","enabled":true}]};
            match id {"spam-disabled"=>{settings.insert("spamProtection",doc!{"enabled":false});},"spam-empty-categories"=>{settings.insert("spamProtection",doc!{"categories":[]});},"spam-continuous-off"=>{settings.insert("spamProtection",doc!{"reviewAllMessages":false});},_=>{}}
            db.collection::<Document>("channel_moderation_settings").insert_one(settings).await.unwrap();
            if id=="paid-exhausted" {let _:()=redis::cmd("SET").arg(format!("twitch:{channel}:ai:exhaust")).arg("true").query_async(&mut cache).await.unwrap();}
            if matches!(id,"paid-unavailable"|"paid-exhausted-status"|"paid-no-balance") {let value=match id {"paid-unavailable"=>r#"{"version":3,"used":0,"limit":200000,"balance":0,"available":false,"status":"unavailable"}"#,"paid-no-balance"=>r#"{"version":3,"used":200000,"limit":200000,"balance":true,"available":true,"status":"available","__polar_plan_version":""}"#,_=>r#"{"version":3,"used":200000,"limit":200000,"balance":0,"available":true,"status":"exhausted"}"#};let _:()=redis::cmd("SET").arg(format!("twitch:{channel}:ai:credits")).arg(value).query_async(&mut cache).await.unwrap();}
            if id=="paid-no-balance" {
                use dima_rust::utils::{ai_credit_projection::PlanTier, ai_credit_reader::CreditOwner, lossless_json::JsonValue};
                assert!(!projection.is_ai_credits_exhausted(&channel.as_str().into()).await.unwrap());
                let read=reader.get_ai_credits(&CreditOwner {tier:Some(PlanTier::Premium),customer_id:Some("fixture-customer".into())},&channel,true).await.unwrap();
                assert_eq!(read.get("available"),Some(&JsonValue::Bool(true)));
                assert_eq!(read.get("status"),Some(&JsonValue::String("available".into())));
                assert_eq!(read.get("balance"),Some(&JsonValue::Number(0.0)));
            }
            let mut row=decision(id,5);if id.starts_with("spam-") {row.insert("ruleID","builtin-spam-protection");row.insert("reviewSource",if id=="spam-continuous-off" {"spam_continuous"} else {"first_message"});row.insert("rule",doc!{"id":"builtin-spam-protection","semantic":{"policy":"test","examples":[]}});}
            decisions.insert_one(row).await.unwrap();assert!(worker.process_next_with_clock(&clock).await.unwrap());
            let actual=decisions.find_one(doc!{"_id":id}).await.unwrap().unwrap();compare_source_result(id,&actual,false);
        }
        // Paid/free/spam model selection and all successful verdict branches
        // use the actual semantic HTTP adapter and captured source results.
        for id in ["plan-pro","spam-free","spam-paid","spam-paid-exhausted","provider-allow","provider-violation","provider-error"] {
            db.collection::<Document>("users").delete_many(doc!{}).await.unwrap();db.collection::<Document>("channel_moderation_settings").delete_many(doc!{}).await.unwrap();
            let _:i64=redis::cmd("DEL").arg(format!("twitch:{channel}:ai:exhaust")).arg(format!("{channel}:ai:exhaust")).arg(format!("twitch:{channel}:ai:credits")).query_async(&mut cache).await.unwrap();
            let tier=match id {"plan-pro"=>"pro","spam-free"=>"free",_=>"premium"};
            let mut owner=doc!{"accounts":[{"type":"twitch","id":&channel}],"plan_tier":tier};if id!="spam-free" {owner.insert("polar_sh_customer_id","fixture-customer");}db.collection::<Document>("users").insert_one(owner).await.unwrap();
            let mut settings=doc!{"channelID":&channel,"settingsVersion":1,"enabled":true,"rules":[{"id":"r","enabled":true}]};if id.starts_with("spam-") {settings.insert("spamProtection",doc!{});}db.collection::<Document>("channel_moderation_settings").insert_one(settings).await.unwrap();
            if id=="spam-paid-exhausted" {let _:()=redis::cmd("SET").arg(format!("twitch:{channel}:ai:exhaust")).arg("true").query_async(&mut cache).await.unwrap();} else {let _:()=redis::cmd("SET").arg(format!("twitch:{channel}:ai:credits")).arg(r#"{"version":3,"used":0,"limit":200000,"balance":200000,"available":true,"status":"available"}"#).query_async(&mut cache).await.unwrap();}
            peer.score.store(match id {"provider-allow"=>0.05f64,"provider-violation"=>0.95,_=>0.5}.to_bits(),Ordering::SeqCst);peer.close.store(id=="provider-error",Ordering::SeqCst);
            let before=peer.requests.lock().unwrap().len();let mut row=decision(id,6);if id.starts_with("spam-") {row.insert("ruleID","builtin-spam-protection");row.insert("reviewSource","first_message");row.insert("rule",doc!{"id":"builtin-spam-protection","semantic":{"policy":"test","examples":[],"thresholdPercent":85}});}
            row.insert("consequence",doc!{"status":"none"});decisions.insert_one(row).await.unwrap();assert!(worker.process_next_with_clock(&clock).await.unwrap());
            let actual=decisions.find_one(doc!{"_id":id}).await.unwrap().unwrap();compare_source_result(id,&actual,false);
            let requests=peer.requests.lock().unwrap();assert_eq!(requests.len(),before+1);let request:serde_json::Value=serde_json::from_str(requests.last().unwrap()).unwrap();
            let expected=match id {"spam-free"=>"respan/span-01","spam-paid"=>"typesafe/jev-1.13",_=>"respan/span-01-lite"};assert_eq!(request["model"],expected,"{id}");
        }
        peer.close.store(false,Ordering::SeqCst);peer.score.store(0.5f64.to_bits(),Ordering::SeqCst);
        // A private RESP forwarding peer injects a rejection at the precise
        // exhaustion or credit-reader operation, without replacing services.
        for id in ["paid-exhaustion-error","paid-credit-error"] {
            use cache_proxy::{Fault,Proxy};
            let proxy=Proxy::new();let through=redis::aio::ConnectionManager::new(redis::Client::open(proxy.url()).unwrap()).await.unwrap();
            let _:i64=redis::cmd("DEL").arg(format!("twitch:{channel}:ai:exhaust")).arg(format!("{channel}:ai:exhaust")).query_async(&mut cache).await.unwrap();
            let key=format!("twitch:{channel}:ai:credits");let _:()=redis::cmd("SET").arg(&key).arg(r#"{"version":3,"used":0,"limit":200000,"balance":200000,"available":true,"status":"available"}"#).query_async(&mut cache).await.unwrap();
            let projection=AiCreditProjection::new(through.clone(),Duration::from_secs(1));
            let polar=PolarClient::new(PolarConfig::new("http://127.0.0.1:9","fixture").unwrap(),PolarPolicy::Billing).unwrap();
            let reader=AiCreditReader::new(through.clone(),db.clone(),polar,Duration::from_millis(750)).unwrap();
            let provider=SemanticProvider::new(reqwest::Client::new(),&peer.address,Some("fixture".into()));
            let posthog=PosthogTracking::from_lossless_config(PosthogLosslessConfig::new("fixture","http://127.0.0.1:9/batch/")).unwrap();
            let usage=PolarCacheUsage::new(through.clone(),projection.clone(),AiUsageProducer::new(through),posthog);
            let w=SemanticWorker::new(db.clone(),projection,reader,provider,usage);
            let mut row=decision(id,7);row.insert("consequence",doc!{"status":"none"});decisions.insert_one(row).await.unwrap();
            if id=="paid-exhaustion-error" {
                proxy.arm("EXISTS",&format!("twitch:{channel}:ai:exhaust"),Fault::Reject);
                assert!(w.process_next_with_clock(&clock).await.unwrap());
            } else {
                proxy.arm("GET",&key,Fault::Hold);
                let c=clock.clone();let task=tokio::spawn(async move {w.process_next_with_clock(&c).await});
                tokio::time::timeout(Duration::from_secs(5),proxy.applied()).await.unwrap();
                // The held exhaustion read sees the healthy cache; reject only
                // the next GET, which belongs to the concrete credit reader.
                proxy.arm("GET",&key,Fault::Reject);proxy.release();assert!(task.await.unwrap().unwrap());
            }
            let actual=decisions.find_one(doc!{"_id":id}).await.unwrap().unwrap();compare_source_result(id,&actual,false);
        }
        // Ten oldest eligible charges only; unsupported consequences stay pending.
        for i in 0..12 {let status=if i==0 {"none"} else {"allowed"};decisions.insert_one(doc!{"_id":format!("charge-{i}"),"channelID":&channel,"messageID":"fixture-message","model":"fixture-model","inputTokens":1000000,"state":"completed","createdAt":DateTime::from_millis(i),"consequence":{"status":status},"charge":{"status":"pending","customerID":"fixture-customer","externalID":format!("moderation:charge-{i}"),"billableCostUSD":0.042}}).await.unwrap();}
        worker.maintain_with_clock(&clock).await.unwrap();
        assert_eq!(decisions.count_documents(doc!{"_id":{"$regex":"^charge-"},"charge.status":"recorded"}).await.unwrap(),10);assert_source_outcome("maintenance-ten",true,None);assert_source_ingests("maintenance-ten",10);
        assert_eq!(decisions.find_one(doc!{"_id":"charge-0"}).await.unwrap().unwrap().get_document("charge").unwrap().get_str("status").unwrap(),"pending");
        assert_eq!(decisions.find_one(doc!{"_id":"charge-11"}).await.unwrap().unwrap().get_document("charge").unwrap().get_str("status").unwrap(),"pending");
        worker.maintain_with_clock(&clock).await.unwrap();assert_eq!(decisions.find_one(doc!{"_id":"charge-11"}).await.unwrap().unwrap().get_document("charge").unwrap().get_str("status").unwrap(),"recorded");
        let count:i64=redis::cmd("LLEN").arg(&queue).query_async(&mut cache).await.unwrap();assert_eq!(count,12);
        // One accounting rejection must leave that charge pending and must not
        // prevent a later eligible charge in the same maintenance pass.
        for (id,customer) in [("bad-customer",""),("after-error","fixture-customer")] {
            decisions.insert_one(doc!{"_id":id,"channelID":&channel,"messageID":"fixture-message","model":"fixture-model","inputTokens":1,"state":"completed","createdAt":DateTime::from_millis(if id=="bad-customer" {30} else {31}),"consequence":{"status":"allowed"},"charge":{"status":"pending","customerID":customer,"externalID":format!("moderation:{id}"),"billableCostUSD":0.042}}).await.unwrap();
        }
        worker.maintain_with_clock(&clock).await.unwrap();
        for (id,status) in [("bad-customer","pending"),("after-error","recorded")] {let d=decisions.find_one(doc!{"_id":id}).await.unwrap().unwrap();assert_eq!(d.get_document("charge").unwrap().get_str("status").unwrap(),status);}assert_source_ingests("maintenance-blank-customer",1);assert_source_outcome("maintenance-blank-customer",true,None);
        let count:i64=redis::cmd("LLEN").arg(&queue).query_async(&mut cache).await.unwrap();assert_eq!(count,13);
        // A Redis type error forces each concrete cache ingest to return an
        // error; every charge remains pending and processing continues.
        decisions.delete_one(doc!{"_id":"bad-customer"}).await.unwrap();
        let bad_channel=format!("{namespace}badqueue");let bad_queue=format!("twitch:{bad_channel}:ai:polarshevent");
        let _:i64=redis::cmd("HSET").arg(&bad_queue).arg("fixture").arg("wrongtype").query_async(&mut cache).await.unwrap();
        for i in 0..10 {decisions.insert_one(doc!{"_id":format!("bad-event-{i}"),"channelID":&bad_channel,"messageID":"fixture-message","model":"fixture-model","inputTokens":1,"state":"completed","createdAt":DateTime::from_millis(100+i),"consequence":{"status":"allowed"},"charge":{"status":"pending","customerID":"fixture-customer","externalID":format!("moderation:bad-event-{i}"),"billableCostUSD":0.042}}).await.unwrap();}
        worker.maintain_with_clock(&clock).await.unwrap();assert_eq!(decisions.count_documents(doc!{"_id":{"$regex":"^bad-event-"},"charge.status":"pending"}).await.unwrap(),10);assert_source_outcome("maintenance-charge-error",true,None);assert_source_ingests("maintenance-charge-error",10);
        assert!(!worker.process_next_with_clock(&clock).await.unwrap());
    }).catch_unwind().await;
    assert!(
        markers
            .find_one(doc! {"_id":&namespace,"owner":"dimabot-migration"})
            .await
            .unwrap()
            .is_some()
    );
    let owner: Option<String> = redis::cmd("GET")
        .arg(&marker)
        .query_async(&mut cache)
        .await
        .unwrap();
    assert_eq!(owner.as_deref(), Some("dimabot-migration"));
    // The dedicated Redis is fresh; delete only this namespace and its asserted
    // initially-empty global receipt queue, after verifying ownership marker.
    let mut cursor: u64 = 0;
    let mut keys = Vec::<String>::new();
    loop {
        let (next, found): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(format!("*{namespace}*"))
            .arg("COUNT")
            .arg(100)
            .query_async(&mut cache)
            .await
            .unwrap();
        keys.extend(found);
        cursor = next;
        if cursor == 0 {
            break;
        }
    }
    if receipt_owned {
        keys.push(receipt.to_owned());
    }
    if !keys.is_empty() {
        let _: i64 = redis::cmd("DEL")
            .arg(keys)
            .query_async(&mut cache)
            .await
            .unwrap();
    }
    db.drop().await.unwrap();
    drop(peer);
    if let Err(panic) = work {
        std::panic::resume_unwind(panic)
    }
}

#[path = "support/moderation_semantic.rs"]
mod semantic_reference_support;
/// Visits every captured call trace and checks the source's bounded work and
/// pricing contract using native code. This is a trace audit, not a substitute
/// for replaying each scripted storage fault through the concrete worker.
#[test]
#[ignore = "independently hashed actual-source worker fixture"]
fn audit_every_source_record() {
    use dima_rust::utils::{lossless_json::JsonValue, moderation::semantic::semantic_price};
    use semantic_reference_support::{decode, external_bytes};
    use std::collections::BTreeSet;
    let bytes = external_bytes(
        &std::env::var("DIMA_SEMANTIC_WORKER_REFERENCE").unwrap(),
        &std::env::var("DIMA_SEMANTIC_WORKER_REFERENCE_SHA256").unwrap(),
    );
    let fixture: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        fixture["metadata"]["sourceSha256"],
        "8c6161cace13a2be249b0a0005576ff522d45949eff6517426b26ebafbe62de1"
    );
    assert_eq!(fixture["metadata"]["versions"]["node"], "24.22.1");
    assert_eq!(fixture["metadata"]["versions"]["typescript"], "5.9.3");
    let records = fixture["records"].as_array().unwrap();
    assert_eq!(
        fixture["metadata"]["recordCount"].as_u64().unwrap(),
        records.len() as u64
    );
    assert!(records.len() >= 40);
    let mut ids = BTreeSet::new();
    // Each listed concrete case is exercised above through the real worker;
    // two scripted cases remain source-only evidence. The negative available
    // balance is not returned by the normal reader; unconditional ingest throw
    // still has unresolved source logging/telemetry failure semantics.
    let host_only = BTreeSet::from(["paid-negative-balance", "maintenance-ingest-throw"]);
    let concrete = BTreeSet::from([
        "empty",
        "policy-version",
        "plan-free",
        "plan-pro",
        "plan-no-customer",
        "plan-case-mismatch",
        "missing-owner",
        "paid-uncertain",
        "paid-exhausted",
        "paid-credit-error",
        "paid-exhaustion-error",
        "paid-unavailable",
        "paid-exhausted-status",
        "paid-no-balance",
        "spam-free",
        "spam-disabled",
        "spam-empty-categories",
        "spam-continuous-off",
        "spam-paid",
        "spam-paid-exhausted",
        "provider-429",
        "provider-500",
        "provider-invalid",
        "provider-allow",
        "provider-violation",
        "provider-error",
        "late",
        "owner-error",
        "settings-error",
        "result-update-error",
        "missing-rule",
        "claim-error",
        "maintenance-empty",
        "maintenance-ten",
        "maintenance-charge-error",
        "maintenance-blank-customer",
        "maintenance-update-fail",
        "maintenance-expire-fail",
        "maintenance-query-fail",
    ]);
    assert_eq!(concrete.len(), 39);
    assert_eq!(host_only.len(), 2);
    for record in records {
        let id = record["id"].as_str().unwrap();
        assert!(ids.insert(id), "duplicate record {id}");
        assert!(
            concrete.contains(id) || host_only.contains(id),
            "unclassified record {id}"
        );
        if host_only.contains(id) {
            let config = decode(&record["config"]).unwrap();
            if id == "maintenance-ingest-throw" {
                assert_eq!(
                    config.get("fail"),
                    Some(&JsonValue::String("ingest".into()))
                );
                assert_eq!(record["outcome"]["ok"], false);
            } else {
                let credits = config.get("credits").unwrap();
                assert_eq!(credits.get("available"), Some(&JsonValue::Bool(true)));
                assert_eq!(
                    credits.get("status"),
                    Some(&JsonValue::String("available".into()))
                );
                assert!(matches!(credits.get("balance"),Some(JsonValue::Number(n)) if *n<=0.0));
            }
        }
        let calls = decode(&record["calls"]).unwrap();
        let JsonValue::Array(calls) = calls else {
            panic!("call array {id}")
        };
        let names: Vec<_> = calls
            .iter()
            .map(|entry| {
                if let JsonValue::Array(parts) = entry {
                    if let JsonValue::String(name) = &parts[0] {
                        name.as_str().unwrap()
                    } else {
                        panic!("call name")
                    }
                } else {
                    panic!("call entry")
                }
            })
            .collect();
        let operation = record["operation"].as_str().unwrap();
        if operation == "processNextSemanticDecision" {
            assert_eq!(names.first(), Some(&"claim"), "{id}");
            assert_eq!(names.iter().filter(|x| **x == "claim").count(), 1, "{id}");
            if let Some(owner) = names.iter().position(|x| *x == "owner") {
                let settings = names.iter().position(|x| *x == "settings");
                if id != "owner-error" {
                    assert!(settings.is_some_and(|s| owner < s), "{id}");
                }
            }
            if let Some(i) = names.iter().position(|x| *x == "signalTimeout") {
                let JsonValue::Array(call) = &calls[i] else {
                    unreachable!()
                };
                assert_eq!(call[1], JsonValue::Number(750.0), "{id}");
                assert!(
                    names
                        .iter()
                        .position(|x| *x == "exhausted")
                        .is_some_and(|n| n < i),
                    "{id}"
                );
            }
            for call in &calls {
                let JsonValue::Array(parts) = call else {
                    unreachable!()
                };
                if !matches!(&parts[0],JsonValue::String(x) if x.as_str()==Some("updateOne")) {
                    continue;
                }
                let Some(fields) = parts.get(2).and_then(|v| v.get("$set")) else {
                    continue;
                };
                let Some(charge) = fields.get("charge") else {
                    continue;
                };
                let cost = if let Some(JsonValue::Number(n)) = charge.get("billableCostUSD") {
                    *n
                } else {
                    panic!("price {id}")
                };
                let credits = if let Some(JsonValue::Number(n)) = charge.get("credits") {
                    *n
                } else {
                    panic!("credits {id}")
                };
                let tokens = if let Some(JsonValue::Number(n)) = fields.get("inputTokens") {
                    *n
                } else {
                    panic!("tokens {id}")
                };
                let zero = semantic_price(0.0);
                let paid = semantic_price(tokens);
                assert!(
                    (cost.to_bits() == zero.billable_cost_usd.to_bits()
                        && credits.to_bits() == zero.credits.to_bits())
                        || (cost.to_bits() == paid.billable_cost_usd.to_bits()
                            && credits.to_bits() == paid.credits.to_bits()),
                    "{id}"
                );
                let status = charge.get("status");
                assert_eq!(
                    status,
                    Some(&JsonValue::String(
                        if credits > 0.0 { "pending" } else { "none" }.into()
                    )),
                    "{id}"
                );
            }
        } else {
            assert_eq!(operation, "maintainSemanticDecisions");
            assert_eq!(names.first(), Some(&"updateMany"), "{id}");
            assert!(
                names.iter().filter(|x| **x == "ingest").count() <= 10,
                "{id}"
            );
            if let Some(index) = names.iter().position(|x| *x == "limit") {
                let JsonValue::Array(call) = &calls[index] else {
                    unreachable!()
                };
                assert_eq!(call[1], JsonValue::Number(10.0), "{id}");
            }
        }
    }
    assert_eq!(ids.len(), records.len());
    assert_eq!(ids, concrete.union(&host_only).copied().collect());
}

#[tokio::test]
#[ignore = "serial private Mongo with enableTestCommands=1, app-scoped failpoints"]
async fn concrete_mongo_failures_respect_catch_boundaries() {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration")
    );
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_MONGO_URI").as_deref(),
        Ok("mongodb://keyword-mongo:27017")
    );
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_REDIS_URL").as_deref(),
        Ok("redis://keyword-redis:6379/")
    );
    let namespace = std::env::var("KEYWORD_FIXTURE_NAMESPACE").unwrap();
    assert_eq!(
        std::env::var("DIMA_VARIATION_JOBS_FAILPOINT_OWNER").as_deref(),
        Ok(namespace.as_str())
    );
    let nonce = namespace
        .strip_prefix("keyword-fixture-")
        .and_then(|s| s.strip_suffix(':'))
        .unwrap();
    assert_eq!(nonce.len(), 12);
    assert!(
        nonce
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    let control = Client::with_uri_str("mongodb://keyword-mongo:27017")
        .await
        .unwrap();
    let dbname = format!("semantic_fault_{nonce}");
    assert!(
        control
            .list_database_names()
            .await
            .unwrap()
            .iter()
            .all(|x| x != &dbname)
    );
    let admin = control.database("admin");
    let app = format!("semantic-worker-{nonce}");
    let mut options = mongodb::options::ClientOptions::parse("mongodb://keyword-mongo:27017")
        .await
        .unwrap();
    options.retry_reads = Some(false);
    options.retry_writes = Some(false);
    options.app_name = Some(app.clone());
    let client = Client::with_options(options).unwrap();
    let db = client.database(&dbname);
    let marker = db.collection::<Document>("fixture_marker");
    marker
        .insert_one(doc! {"_id":&namespace,"owner":"dimabot-migration"})
        .await
        .unwrap();
    let mut cleanup_cache = redis::aio::ConnectionManager::new(
        redis::Client::open("redis://keyword-redis:6379/").unwrap(),
    )
    .await
    .unwrap();
    let redis_marker = format!("{namespace}fault-owner");
    let mut owns_receipt = false;
    let mut owns_marker = false;
    let work=AssertUnwindSafe(async {
        let exists:i64=redis::cmd("EXISTS").arg("cron:ai-usage-receipts:queue").query_async(&mut cleanup_cache).await.unwrap();assert_eq!(exists,0);owns_receipt=true;
        let set:Option<String>=redis::cmd("SET").arg(&redis_marker).arg("dimabot-migration").arg("NX").query_async(&mut cleanup_cache).await.unwrap();assert_eq!(set.as_deref(),Some("OK"));owns_marker=true;
        let cache=cleanup_cache.clone();
        let projection=AiCreditProjection::new(cache.clone(),Duration::from_secs(1));
        let polar=PolarClient::new(PolarConfig::new("http://127.0.0.1:9","fixture").unwrap(),PolarPolicy::Billing).unwrap();
        let reader=AiCreditReader::new(cache.clone(),db.clone(),polar,Duration::from_millis(750)).unwrap();
        let provider=SemanticProvider::new(reqwest::Client::new(),"http://127.0.0.1:9/decisions",Some("fixture".into()));
        let posthog=PosthogTracking::from_lossless_config(PosthogLosslessConfig::new("fixture","http://127.0.0.1:9/batch/")).unwrap();
        let usage=PolarCacheUsage::new(cache.clone(),projection.clone(),AiUsageProducer::new(cache),posthog);
        let worker=SemanticWorker::new(db.clone(),projection,reader,provider,usage);
        let decisions=db.collection::<Document>("moderation_decisions");let now=1_700_000_000_000_i64;
        let make=|id:&str|doc!{"_id":id,"state":"pending","channelID":&namespace,"ruleID":"r","settingsVersion":1,"createdAt":DateTime::from_millis(0),"deadline":DateTime::from_millis(now+10000),"consequence":{"status":"none"}};
        // Claim failure precedes the source try/catch and propagates unchanged.
        decisions.insert_one(make("claim-fail")).await.unwrap();
        admin.run_command(doc!{"configureFailPoint":"failCommand","mode":{"times":1},"data":{"failCommands":["findAndModify"],"errorCode":12345,"appName":&app}}).await.unwrap();
        assert!(worker.process_next_with_clock(&Fixed(now as f64)).await.is_err());assert_source_outcome("claim-error",false,None);
        admin.run_command(doc!{"configureFailPoint":"failCommand","mode":"off"}).await.unwrap();
        assert_eq!(decisions.find_one(doc!{"_id":"claim-fail"}).await.unwrap().unwrap().get_str("state").unwrap(),"pending");
        // Owner read and settings read failures are caught after claiming.
        for (id,skip) in [("owner-fail",0),("settings-fail",1)] {
            decisions.delete_many(doc!{}).await.unwrap();decisions.insert_one(make(id)).await.unwrap();
            admin.run_command(doc!{"configureFailPoint":"failCommand","mode":{"skip":skip},"data":{"failCommands":["find"],"errorCode":12345,"appName":&app}}).await.unwrap();
            assert!(worker.process_next_with_clock(&Fixed(now as f64)).await.unwrap());
            admin.run_command(doc!{"configureFailPoint":"failCommand","mode":"off"}).await.unwrap();
            let d=decisions.find_one(doc!{"_id":id}).await.unwrap().unwrap();assert_eq!(d.get_str("state").unwrap(),"completed");assert_eq!(d.get_str("status").unwrap(),"unavailable");compare_source_result(if id=="owner-fail" {"owner-error"} else {"settings-error"},&d,false);
        }
        // An update failure is caught; the recovery update succeeds and is
        // fenced to processing. There is no application retry of the mutation.
        decisions.delete_many(doc!{}).await.unwrap();decisions.insert_one(make("result-fail")).await.unwrap();
        admin.run_command(doc!{"configureFailPoint":"failCommand","mode":{"times":1},"data":{"failCommands":["update"],"errorCode":12345,"appName":&app}}).await.unwrap();
        assert!(worker.process_next_with_clock(&Fixed(now as f64)).await.unwrap());
        admin.run_command(doc!{"configureFailPoint":"failCommand","mode":"off"}).await.unwrap();
        let d=decisions.find_one(doc!{"_id":"result-fail"}).await.unwrap().unwrap();assert_eq!(d.get_str("state").unwrap(),"completed");assert_eq!(d.get_str("status").unwrap(),"unavailable");
        // Source fixture fails both the result write and catch recovery write.
        decisions.delete_many(doc!{}).await.unwrap();decisions.insert_one(make("both-update-fail")).await.unwrap();
        admin.run_command(doc!{"configureFailPoint":"failCommand","mode":{"times":2},"data":{"failCommands":["update"],"errorCode":12345,"appName":&app}}).await.unwrap();
        assert!(worker.process_next_with_clock(&Fixed(now as f64)).await.is_err());assert_source_outcome("result-update-error",false,None);
        admin.run_command(doc!{"configureFailPoint":"failCommand","mode":"off"}).await.unwrap();
        assert_eq!(decisions.find_one(doc!{"_id":"both-update-fail"}).await.unwrap().unwrap().get_str("state").unwrap(),"processing");
        // Maintenance failure occurs outside catch: no ingestion follows.
        admin.run_command(doc!{"configureFailPoint":"failCommand","mode":{"times":1},"data":{"failCommands":["update"],"errorCode":12345,"appName":&app}}).await.unwrap();
        assert!(worker.maintain_with_clock(&Fixed(now as f64)).await.is_err());assert_source_outcome("maintenance-expire-fail",false,None);
        admin.run_command(doc!{"configureFailPoint":"failCommand","mode":"off"}).await.unwrap();
        admin.run_command(doc!{"configureFailPoint":"failCommand","mode":{"times":1},"data":{"failCommands":["find"],"errorCode":12345,"appName":&app}}).await.unwrap();
        assert!(worker.maintain_with_clock(&Fixed(now as f64)).await.is_err());assert_source_outcome("maintenance-query-fail",false,None);
        admin.run_command(doc!{"configureFailPoint":"failCommand","mode":"off"}).await.unwrap();
        // Successful ingest followed by an update failure leaves the charge
        // pending and propagates out of maintenance, as the source does.
        decisions.delete_many(doc!{}).await.unwrap();
        let channel=format!("{namespace}fault-channel");
        decisions.insert_one(doc!{"_id":"charge-fail","channelID":&channel,"messageID":"fixture-message","model":"fixture-model","inputTokens":1000000,"state":"completed","createdAt":DateTime::from_millis(1),"consequence":{"status":"allowed"},"charge":{"status":"pending","customerID":"fixture-customer","externalID":"moderation:charge-fail","billableCostUSD":0.042}}).await.unwrap();
        admin.run_command(doc!{"configureFailPoint":"failCommand","mode":{"skip":1},"data":{"failCommands":["update"],"errorCode":12345,"appName":&app}}).await.unwrap();
        assert!(worker.maintain_with_clock(&Fixed(now as f64)).await.is_err());assert_source_outcome("maintenance-update-fail",false,None);assert_source_ingests("maintenance-update-fail",1);
        admin.run_command(doc!{"configureFailPoint":"failCommand","mode":"off"}).await.unwrap();
        let d=decisions.find_one(doc!{"_id":"charge-fail"}).await.unwrap().unwrap();assert_eq!(d.get_document("charge").unwrap().get_str("status").unwrap(),"pending");
    }).catch_unwind().await;
    // The failpoint is server-wide even with appName targeting. Reset on panic
    // before any cleanup reads. Only the private fixture owner may run this.
    admin
        .run_command(doc! {"configureFailPoint":"failCommand","mode":"off"})
        .await
        .unwrap();
    assert!(
        marker
            .find_one(doc! {"_id":&namespace,"owner":"dimabot-migration"})
            .await
            .unwrap()
            .is_some()
    );
    if owns_marker {
        let owner: Option<String> = redis::cmd("GET")
            .arg(&redis_marker)
            .query_async(&mut cleanup_cache)
            .await
            .unwrap();
        assert_eq!(owner.as_deref(), Some("dimabot-migration"));
        let mut cursor = 0u64;
        let mut keys = Vec::<String>::new();
        loop {
            let (next, found): (u64, Vec<String>) = redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg(format!("*{namespace}*"))
                .arg("COUNT")
                .arg(100)
                .query_async(&mut cleanup_cache)
                .await
                .unwrap();
            keys.extend(found);
            cursor = next;
            if cursor == 0 {
                break;
            }
        }
        if owns_receipt {
            keys.push("cron:ai-usage-receipts:queue".to_owned());
        }
        if !keys.is_empty() {
            let _: i64 = redis::cmd("DEL")
                .arg(keys)
                .query_async(&mut cleanup_cache)
                .await
                .unwrap();
        }
    }
    db.drop().await.unwrap();
    if let Err(panic) = work {
        std::panic::resume_unwind(panic)
    }
}

/// Compare real Mongo readback with the independently captured worker's
/// `$set`, after excluding the fixture-specific identity and wall-clock data.
fn compare_source_result(id: &str, actual: &Document, late: bool) {
    use dima_rust::utils::{bson_json::json_bson, lossless_json::JsonValue};
    use semantic_reference_support::{decode, external_bytes};
    let bytes = external_bytes(
        &std::env::var("DIMA_SEMANTIC_WORKER_REFERENCE").unwrap(),
        &std::env::var("DIMA_SEMANTIC_WORKER_REFERENCE_SHA256").unwrap(),
    );
    let fixture: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        fixture["metadata"]["sourceSha256"],
        "8c6161cace13a2be249b0a0005576ff522d45949eff6517426b26ebafbe62de1"
    );
    let record = fixture["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == id)
        .unwrap();
    let JsonValue::Array(calls) = decode(&record["calls"]).unwrap() else {
        panic!("calls")
    };
    let sets:Vec<_>=calls.iter().filter_map(|v|if let JsonValue::Array(items)=v {if matches!(items.first(),Some(JsonValue::String(s)) if s.as_str()==Some("updateOne")) {items.get(2).and_then(|x|x.get("$set"))} else {None}} else {None}).collect();
    let expected = if late {
        sets.last().unwrap()
    } else {
        sets.first().unwrap()
    };
    // A failed construction recovers with only verdict/status/state. Normal
    // updates and late audits include whatever owned fields the source writes.
    for key in [
        "state",
        "verdict",
        "status",
        "scores",
        "model",
        "provider",
        "providerRequestID",
        "inputTokens",
        "cost",
    ] {
        if let Some(value) = expected.get(key) {
            assert_eq!(
                actual.get(key),
                Some(&json_bson(value)),
                "source case {id}, {key}"
            );
        }
    }
    if let Some(charge) = expected.get("charge") {
        let actual = actual.get_document("charge").unwrap();
        for key in [
            "status",
            "credits",
            "billableCostUSD",
            "pricingVersion",
            "usdPerMillionInputTokens",
        ] {
            if let Some(value) = charge.get(key) {
                assert_eq!(
                    actual.get(key),
                    Some(&json_bson(value)),
                    "source case {id}, charge.{key}"
                );
            }
        }
    }
}

fn assert_source_outcome(id: &str, ok: bool, boolean: Option<bool>) {
    use semantic_reference_support::external_bytes;
    let bytes = external_bytes(
        &std::env::var("DIMA_SEMANTIC_WORKER_REFERENCE").unwrap(),
        &std::env::var("DIMA_SEMANTIC_WORKER_REFERENCE_SHA256").unwrap(),
    );
    let fixture: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let record = fixture["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == id)
        .unwrap();
    assert_eq!(record["outcome"]["ok"], ok, "{id}");
    if let Some(value) = boolean {
        assert_eq!(record["outcome"]["value"]["kind"], "boolean");
        assert_eq!(record["outcome"]["value"]["value"], value, "{id}");
    }
}

#[path = "support/polar_cache_usage.rs"]
#[allow(dead_code)] // This fixture reuses only the shared Redis fault proxy.
mod cache_proxy;

fn assert_source_ingests(id: &str, count: usize) {
    use dima_rust::utils::lossless_json::JsonValue;
    use semantic_reference_support::{decode, external_bytes};
    let bytes = external_bytes(
        &std::env::var("DIMA_SEMANTIC_WORKER_REFERENCE").unwrap(),
        &std::env::var("DIMA_SEMANTIC_WORKER_REFERENCE_SHA256").unwrap(),
    );
    let fixture: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let record = fixture["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == id)
        .unwrap();
    let JsonValue::Array(calls) = decode(&record["calls"]).unwrap() else {
        panic!("calls")
    };
    assert_eq!(calls.iter().filter(|call|matches!(call,JsonValue::Array(parts) if matches!(parts.first(),Some(JsonValue::String(s)) if s.as_str()==Some("ingest")))).count(),count,"{id}");
}

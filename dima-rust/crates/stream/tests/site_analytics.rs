mod support;
use anyhow::{Context, Result, ensure};
use dima_core::ManualClock;
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Hooks};
use dima_stream::site_analytics::*;
use futures_util::FutureExt;
use serde_json::{Value, json};
use std::{panic::AssertUnwindSafe, sync::Arc};
fn recording() -> Result<Value> {
    Ok(serde_json::from_str(include_str!(
        "site-analytics-reference.json"
    ))?)
}
async fn cache() -> Result<Option<Dragonfly>> {
    let address = match std::env::var("DIMA_TEST_DRAGONFLY") {
        Ok(v) => v,
        Err(e) if std::env::var("DIMA_TEST_REQUIRE_STORES").as_deref() == Ok("1") => {
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("skipped: local cache absent");
            return Ok(None);
        }
    };
    let (host, port) = address.rsplit_once(':').context("host:port")?;
    Ok(Some(
        Dragonfly::connect(
            DragonflyConfig::from_env_values(Some(host), Some(&format!("{port}/7")), "site-tests"),
            Hooks::default(),
        )
        .await?,
    ))
}
async fn state(cache: &Dragonfly, prefix: &str) -> Result<Value> {
    let mut keys = Vec::new();
    let mut scan = cache.scan(&format!("{prefix}site:analytics:*"), Some(100));
    while let Some(page) = scan.next_page().await? {
        keys.extend(page);
    }
    keys.sort();
    let mut result = Vec::new();
    for k in keys {
        let k = String::from_utf8(k)?;
        let kind: String = cache.query(redis::cmd("TYPE").arg(&k)).await?;
        let ttl: i64 = cache.query(redis::cmd("TTL").arg(&k)).await?;
        let value = if kind == "hash" {
            json!(
                cache
                    .hgetall(&k)
                    .await?
                    .into_iter()
                    .collect::<std::collections::BTreeMap<_, _>>()
            )
        } else {
            json!(cache.query::<String>(redis::cmd("GET").arg(&k)).await?)
        };
        result.push(json!({"key":k.strip_prefix(prefix).context("prefix")?,"type":kind,"value":value,"ttl":ttl}));
    }
    Ok(json!(result))
}
#[tokio::test]
async fn recorded_counters_unknown_empty_aliases_negative_and_concurrent() -> Result<()> {
    let Some(cache) = cache().await? else {
        return Ok(());
    };
    let prefix = format!("dima_test_stream_{}:", uuid::Uuid::new_v4());
    let result = AssertUnwindSafe(async {
        let site = SiteAnalytics::new(
            cache.clone(),
            Arc::new(ManualClock::new(1794355200000)),
            Config {
                key_prefix: prefix.clone(),
                ..Default::default()
            },
        );
        for case in recording()?["counters"].as_array().context("cases")? {
            let op = case["op"].as_str().context("op")?;
            let filter = case["filter"].as_str();
            let value = case["value"].as_i64().unwrap_or(1);
            let result = match op {
                "get" => site.get_site_analytics(filter).await?,
                "inc" => {
                    site.increment_site_analytics(filter.context("filter")?, value)
                        .await?;
                    Value::Null
                }
                "dec" => {
                    site.decrement_site_analytics(filter.context("filter")?, value)
                        .await?;
                    Value::Null
                }
                _ => {
                    futures_util::future::try_join_all(
                        case["operations"]
                            .as_array()
                            .context("ops")?
                            .iter()
                            .map(|op| async {
                                let filter = op["filter"].as_str().context("filter")?;
                                let value = op["value"].as_i64().context("value")?;
                                if op["op"] == "inc" {
                                    site.increment_site_analytics(filter, value).await?
                                } else {
                                    site.decrement_site_analytics(filter, value).await?
                                }
                                Ok::<_, anyhow::Error>(())
                            }),
                    )
                    .await?;
                    Value::Null
                }
            };
            ensure!(result == case["result"], "return {case}");
            ensure!(
                state(&cache, &prefix).await? == case["state"],
                "cache {case}"
            );
        }
        Ok(())
    })
    .catch_unwind()
    .await;
    support::cleanup(&cache, &prefix).await?;
    ensure!(state(&cache, &prefix).await? == json!([]));
    match result {
        Ok(r) => r,
        Err(p) => std::panic::resume_unwind(p),
    }
}

use bson::{Bson, doc};
use dima_core::{SecretString, Shutdown, SystemRandom};
use dima_http::{
    HttpClient,
    testing::{MockResponse, MockServer},
};
use dima_store::mongo::MongoStore;
use dima_twitch::{KeySpace, Twitch, TwitchConfig, TwitchDeps};
use futures_util::TryStreamExt;
use std::{sync::Mutex, time::Duration};
fn twitch(
    server: &MockServer,
    store: MongoStore,
    cache: Dragonfly,
    prefix: &str,
    clock: Arc<ManualClock>,
) -> Result<Twitch> {
    let mut config = TwitchConfig::new("site-client", SecretString::from("site-secret"));
    config.keys = KeySpace::prefixed(prefix);
    Ok(Twitch::new(
        config,
        TwitchDeps {
            http: HttpClient::builder().build()?,
            exchange_http: dima_twitch::exchange_client(HttpClient::builder())?,
            helix: server.provider(dima_twitch::helix_provider("site-client"))?,
            oauth: server.provider(dima_twitch::oauth_provider())?,
            mongo: store,
            dragonfly: cache,
            cipher: dima_core::crypto::CredentialCipher::new("site-test-only")?,
            clock,
            random: Arc::new(SystemRandom),
            events: Arc::new(dima_twitch::NoopEvents),
            shutdown: Shutdown::new(),
        },
    ))
}
fn equal_json(actual: &Value, expected: &Value) -> bool {
    // JSON numbers have a single JavaScript type; object enumeration order is not an API value.
    fn normalize(v: &Value) -> Value {
        match v {
            Value::Number(_) => {
                serde_json::from_str(&dima_text::to_js_json(v)).unwrap_or(Value::Null)
            }
            Value::Object(o) => {
                Value::Object(o.iter().map(|(k, v)| (k.clone(), normalize(v))).collect())
            }
            Value::Array(a) => Value::Array(a.iter().map(normalize).collect()),
            _ => v.clone(),
        }
    }
    normalize(actual) == normalize(expected)
}
fn same_state(actual: &Value, expected: &Value) -> Result<()> {
    let mut actual = actual.clone();
    let mut expected = expected.clone();
    let a = actual.as_array_mut().context("actual state")?;
    let e = expected.as_array_mut().context("expected state")?;
    ensure!(a.len() == e.len(), "key count {} != {}", json!(a), json!(e));
    for (a, e) in a.iter_mut().zip(e) {
        let at = a["ttl"].as_i64().context("ttl")?;
        let et = e["ttl"].as_i64().context("ttl")?;
        ensure!(
            if at < 0 || et < 0 {
                at == et
            } else {
                (at - et).abs() <= 2
            },
            "TTL: {a} != {e}"
        );
        a["ttl"] = Value::Null;
        e["ttl"] = Value::Null;
        if a["key"].as_str().is_some_and(|k| k == LIVE_CHANNELS_KEY) {
            a["value"] = serde_json::from_str(a["value"].as_str().context("board")?)?;
            e["value"] = serde_json::from_str(e["value"].as_str().context("board")?)?;
        }
    }
    ensure!(
        equal_json(&actual, &expected),
        "cache state {} != {}",
        actual,
        expected
    );
    Ok(())
}
// Client-owned cache differences are explicit: the accepted Twitch client seals tokens;
// these tests supply NoopEvents, so its diagnostic logger/OAuth cache is absent. Every other
// key must belong to site analytics. The actual Bearer value is checked on each Helix request.
async fn compare_client_cache(cache: &Dragonfly, prefix: &str, expected: &Value) -> Result<()> {
    for key in expected.as_array().context("all cache keys")? {
        let name = key["key"].as_str().context("key")?;
        if name.starts_with("site:analytics:") {
            continue;
        }
        if name == "app:twitch:token" {
            let actual = cache
                .get(&format!("{prefix}{name}"))
                .await?
                .context("sealed app token")?;
            ensure!(
                actual
                    != key["value"]
                        .as_str()
                        .context("plain reference token")?
                        .as_bytes(),
                "app cache must be sealed"
            );
            let ttl: i64 = cache
                .query(redis::cmd("TTL").arg(format!("{prefix}{name}")))
                .await?;
            ensure!(
                (ttl - key["ttl"].as_i64().context("ttl")?).abs() <= 2,
                "app token TTL"
            );
        } else {
            ensure!(
                name.starts_with("logger:") || name.starts_with("oauth:failures:"),
                "unclassified reference effect {name}"
            );
            ensure!(
                cache.get(&format!("{prefix}{name}")).await?.is_none(),
                "NoopEvents diagnostic cache"
            );
        }
    }
    let mut scan = cache.scan(&format!("{prefix}*"), Some(100));
    while let Some(page) = scan.next_page().await? {
        for key in page {
            let key = String::from_utf8(key)?;
            let key = key.strip_prefix(prefix).context("prefix")?;
            ensure!(
                key.starts_with("site:analytics:") || key == "app:twitch:token",
                "unclassified Rust effect {key}"
            );
        }
    }
    Ok(())
}
async fn documents(store: &MongoStore) -> Result<Value> {
    let mut result = serde_json::Map::new();
    for name in ["users", "commands", "site_analytics"] {
        let mut values = Vec::new();
        let docs = store
            .documents(name)
            .find(doc! {})
            .sort(doc! {"_id":1})
            .await?
            .try_collect::<Vec<_>>()
            .await?;
        for doc in docs {
            let mut value = Bson::Document(doc).into_canonical_extjson();
            if name == "site_analytics" {
                ensure!(value["_id"]["$oid"].is_string());
                value["_id"] = json!({"$oid":"generated"});
            }
            values.push(value);
        }
        result.insert(name.into(), json!(values));
    }
    Ok(Value::Object(result))
}
async fn seed_documents(store: &MongoStore, docs: &Value) -> Result<()> {
    for name in ["users", "commands", "site_analytics"] {
        store.documents(name).delete_many(doc! {}).await?;
        for doc in docs[name].as_array().context("seed docs")? {
            let bson: Bson = serde_json::from_value(doc.clone())?;
            let Bson::Document(doc) = bson else {
                anyhow::bail!("document")
            };
            store.documents(name).insert_one(doc).await?;
        }
    }
    Ok(())
}
#[tokio::test]
async fn recorded_live_board_batches_freshness_failures_and_cache_state() -> Result<()> {
    support::with_store(|store|async move{
 let Some(cache)=cache().await?else{return Ok(())};let prefix=format!("dima_test_stream_{}:",uuid::Uuid::new_v4());
 let result=AssertUnwindSafe(async{
 let fixture=recording()?;let mut now=fixture["now"].as_i64().context("now")?;
 for case in fixture["boards"].as_array().context("boards")?{
  support::cleanup(&cache,&prefix).await?;seed_documents(&store,&case["documents"]).await?;
  let clock=Arc::new(ManualClock::new(now));let server=MockServer::start().await?;
  let replies=Arc::new(Mutex::new(std::collections::VecDeque::from(case["responses"].as_array().context("responses")?.clone())));let handler=replies.clone();
  server.fallback(move|request|{
   if request.path()=="/oauth2/token"{return MockResponse::json(200,r#"{"access_token":"mock-token","expires_in":3600}"#);}
   let reply=handler.lock().ok().and_then(|mut r|r.pop_front()).unwrap_or(json!({"status":598,"body":{}}));
   let body=reply["body"].as_str().map(str::to_owned).unwrap_or_else(||reply["body"].to_string());
   let response=MockResponse::json(reply["status"].as_u64().unwrap_or(200) as u16,&body);
   if reply["timeout"]==true{response.delay(Duration::from_millis(200))}else{response}
  });
  let twitch=twitch(&server,store.clone(),cache.clone(),&prefix,clock.clone())?;ensure!(twitch.app_token().await.is_some(),"app token");
  if !case["seed"].is_null(){cache.set(&format!("{prefix}{LIVE_CHANNELS_KEY}"),dima_text::to_js_json(&case["seed"]).as_bytes(),dima_store::dragonfly::SetOptions::ex(60)).await?;cache.hset(&format!("{prefix}{SITE_ANALYTICS_KEY}"),&[("live_users",b"1"),("live",b"1"),("total_live_viewers",b"9")]).await?;}
  let site=SiteAnalytics::new(cache.clone(),clock.clone(),Config{key_prefix:prefix.clone(),request_deadline:if case["name"]=="timeout"{Duration::from_millis(50)}else{Duration::from_secs(60)},..Default::default()});
  let mut observed=server.requests().len();
  for step in case["steps"].as_array().context("steps")?{
   let op=&step["op"];now+=op["advance"].as_i64().unwrap_or(0);clock.set(now);
   let result:Result<Value,dima_stream::Error>=match op["kind"].as_str(){
    Some("refresh")=>site.refresh_live_channels_board(&store,&twitch).await.and_then(|v|serde_json::to_value(v).map_err(Into::into)),
    Some("board")=>site.get_live_channels_board(BoardOptions{require_fresh:op["options"]["requireFresh"].as_bool().unwrap_or(false),max_age_ms:op["options"]["maxAgeMs"].as_f64()}).await.and_then(|v|serde_json::to_value(v).map_err(Into::into)),
    Some("map")=>site.get_live_channels_by_channel_id_map().await.and_then(|v|serde_json::to_value(v).map_err(Into::into)),
    _=>site.get_cached_live_status(&op["channel"]).await.and_then(|v|serde_json::to_value(v).map_err(Into::into)),
   };let result=result.unwrap_or(json!({"threw":true}));ensure!(equal_json(&result,&step["result"]),"{}: result {} != {}",case["name"],result,step["result"]);
   let requests=server.requests();let actual:Vec<_>=requests.iter().skip(observed).filter(|r|r.path().starts_with("/helix/")).map(|r|json!({"method":r.method,"target":r.target,"clientId":r.header("client-id"),"contentType":r.header("content-type"),"authorization":r.header("authorization")})).collect();observed=requests.len();
   ensure!(json!(actual)==step["requests"],"{}: requests {} != {}",case["name"],json!(actual),step["requests"]);
   same_state(&state(&cache,&prefix).await?,&step["state"]).with_context(||format!("board {}",case["name"]))?;
   compare_client_cache(&cache,&prefix,&step["allCacheKeys"]).await?;
  }
  ensure!(replies.lock().map(|r|r.is_empty()).unwrap_or(false),"unused responses");ensure!(documents(&store).await?==case["documents"],"Mongo writes during board refresh");twitch.shutdown().await;
 }
 Ok(())}).catch_unwind().await;support::cleanup(&cache,&prefix).await?;ensure!(state(&cache,&prefix).await?==json!([]));match result{Ok(r)=>r,Err(p)=>std::panic::resume_unwind(p)}
 }).await
}

#[tokio::test]
async fn overlapping_refreshes_single_flight_and_expired_partial_writer_is_fenced() -> Result<()> {
    support::with_store(|store| async move {
        let Some(cache) = cache().await? else {
            return Ok(());
        };
        let prefix = format!("dima_test_stream_{}:", uuid::Uuid::new_v4());
        let result = AssertUnwindSafe(async {
            let case = &recording()?["race"];
            seed_documents(&store, &case["documents"]).await?;
            // The real reference publishes its slower partial board after the complete board.
            let results = case["results"].as_array().context("race results")?;
            ensure!(
                results[0].as_array().context("partial")?.len() == 1
                    && results[1].as_array().context("complete")?.len() == 2
            );
            let final_board: Value = serde_json::from_str(
                case["state"]
                    .as_array()
                    .context("state")?
                    .iter()
                    .find(|x| x["key"] == LIVE_CHANNELS_KEY)
                    .context("board")?["value"]
                    .as_str()
                    .context("json")?,
            )?;
            ensure!(final_board.as_array().context("final")?.len() == 1);
            let server = MockServer::start().await?;
            let replies = Arc::new(Mutex::new(std::collections::VecDeque::from(
                case["responses"].as_array().context("responses")?.clone(),
            )));
            let handler = replies.clone();
            server.fallback(move |request| {
                if request.path() == "/oauth2/token" {
                    return MockResponse::json(
                        200,
                        r#"{"access_token":"mock-token","expires_in":3600}"#,
                    );
                }
                let reply = handler
                    .lock()
                    .ok()
                    .and_then(|mut r| r.pop_front())
                    .unwrap_or(json!({"status":598,"body":{}}));
                let response = MockResponse::json(
                    reply["status"].as_u64().unwrap_or(200) as u16,
                    &reply["body"].to_string(),
                );
                response.delay(Duration::from_millis(reply["delay"].as_u64().unwrap_or(0)))
            });
            let clock = Arc::new(ManualClock::new(case["now"].as_i64().context("now")?));
            let twitch = twitch(
                &server,
                store.clone(),
                cache.clone(),
                &prefix,
                clock.clone(),
            )?;
            ensure!(twitch.app_token().await.is_some());
            let first_site = SiteAnalytics::new(
                cache.clone(),
                clock.clone(),
                Config {
                    key_prefix: prefix.clone(),
                    ..Default::default()
                },
            );
            let second_site = SiteAnalytics::new(
                cache.clone(),
                clock,
                Config {
                    key_prefix: prefix.clone(),
                    ..Default::default()
                },
            );
            let first = {
                let store = store.clone();
                let twitch = twitch.clone();
                tokio::spawn(async move {
                    first_site
                        .refresh_live_channels_board(&store, &twitch)
                        .await
                })
            };
            tokio::time::timeout(Duration::from_secs(3), async {
                while server
                    .requests()
                    .iter()
                    .filter(|r| r.path().starts_with("/helix/"))
                    .count()
                    == 0
                {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            })
            .await?;
            ensure!(
                second_site
                    .refresh_live_channels_board(&store, &twitch)
                    .await?
                    .is_empty(),
                "busy refresher reads current board"
            );
            ensure!(
                server
                    .requests()
                    .iter()
                    .filter(|r| r.path().starts_with("/helix/"))
                    .count()
                    == 1,
                "no duplicated batch"
            );
            // Simulate expiration of the first process's lease before its delayed response arrives.
            cache.del(&[&format!("{prefix}{REFRESH_LOCK_KEY}")]).await?;
            let complete = second_site
                .refresh_live_channels_board(&store, &twitch)
                .await?;
            ensure!(complete.len() == 2);
            let old = first.await?;
            ensure!(old.is_err(), "old owner must not publish");
            let board = second_site
                .get_live_channels_board(BoardOptions::default())
                .await?;
            ensure!(board.len() == 2 && equal_json(&serde_json::to_value(board)?, &results[1]));
            ensure!(replies.lock().map(|r| r.is_empty()).unwrap_or(false));
            ensure!(
                cache
                    .get(&format!("{prefix}{REFRESH_LOCK_KEY}"))
                    .await?
                    .is_none()
            );
            twitch.shutdown().await;
            Ok(())
        })
        .catch_unwind()
        .await;
        support::cleanup(&cache, &prefix).await?;
        match result {
            Ok(r) => r,
            Err(p) => std::panic::resume_unwind(p),
        }
    })
    .await
}

#[tokio::test]
async fn recorded_snapshots_repeated_persistence_overlap_start_and_restore() -> Result<()> {
    support::with_store(|store|async move{
 let Some(cache)=cache().await?else{return Ok(())};let prefix=format!("dima_test_stream_{}:",uuid::Uuid::new_v4());
 let result=AssertUnwindSafe(async{
 let fixture=recording()?;seed_documents(&store,&fixture["snapshotInitial"]).await?;
 let report=dima_model::ensure_indexes(&store,&dima_model::site_analytics::INFO,dima_model::startup_policy(&dima_model::site_analytics::INFO).context("policy")?,Duration::from_secs(30)).await;
 let steps=fixture["snapshots"].as_array().context("snapshots")?;let clock=Arc::new(ManualClock::new(steps[0]["now"].as_i64().context("now")?));
 cache.hset(&format!("{prefix}{SITE_ANALYTICS_KEY}"),&[("registered",b"12"),("live",b"7"),("active",b"3"),("total_messages",b"123tail"),("total_commands",b"9")]).await?;
 let server=MockServer::start().await?;let handler_requests=Arc::new(std::sync::atomic::AtomicUsize::new(0));let calls=handler_requests.clone();
 server.fallback(move|request|{
 if request.path()=="/oauth2/token"{return MockResponse::json(200,r#"{"access_token":"mock-token","expires_in":3600}"#);}
 calls.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
 let values=if request.path()=="/helix/streams"{json!([{"id":"stream-1","user_id":"1","user_login":"login-1","user_name":"שם👋é-1","title":"عنوان 1","game_name":"ゲーム","viewer_count":1,"started_at":"2026-11-10T23:00:00Z"},{"id":"stream-2","user_id":"2","user_login":"login-2","user_name":"שם👋é-2","title":"عنوان 2","game_name":"ゲーム","viewer_count":2,"started_at":"2026-11-10T23:00:00Z"}])}else{json!([{"id":"1","profile_image_url":"https://images.invalid/1.png"},{"id":"2","profile_image_url":"https://images.invalid/2.png"}])};
 MockResponse::json(200,&json!({"data":values,"pagination":{"cursor":"ignored-cursor"}}).to_string())
 });
 let twitch=twitch(&server,store.clone(),cache.clone(),&prefix,clock.clone())?;ensure!(twitch.app_token().await.is_some());
 let site=SiteAnalytics::new(cache.clone(),clock.clone(),Config{key_prefix:prefix.clone(),..Default::default()});let mut observed=server.requests().len();
 for step in steps {
  clock.set(step["now"].as_i64().context("now")?);
  let result=match step["op"]["kind"].as_str(){
   Some("snapshot")=>serde_json::to_value(site.get_site_analytics_snapshot().await?)?,
   Some("refresh-snapshot")=>serde_json::to_value(site.refresh_site_analytics_snapshot(&store).await?)?,
   Some("persist")=>{site.site_analytics_persistence_tick(&store,&report).await?;Value::Null},
   Some("concurrent-persist")=>{let other=SiteAnalytics::new(cache.clone(),clock.clone(),Config{key_prefix:prefix.clone(),..Default::default()});let one=(0..4).map(|_|site.site_analytics_persistence_tick(&store,&report));let two=(0..4).map(|_|other.site_analytics_persistence_tick(&store,&report));futures_util::future::try_join_all(one.chain(two)).await?;Value::Null},
   Some("clear")=>{support::cleanup(&cache,&format!("{prefix}site:analytics:")).await?;Value::Null},
   _=>json!(site.start_site_analytics(&store,&twitch,&report).await?),
  };
  ensure!(equal_json(&result,&step["result"]),"snapshot return {} != {}",result,step["result"]);
  same_state(&state(&cache,&prefix).await?,&step["state"]).with_context(||format!("snapshot op {}",step["op"]))?;
  compare_client_cache(&cache,&prefix,&step["allCacheKeys"]).await?;
  ensure!(documents(&store).await?==step["documents"],"BSON documents op {}: {} != {}",step["op"],documents(&store).await?,step["documents"]);
  let requests=server.requests();let actual:Vec<_>=requests.iter().skip(observed).filter(|r|r.path().starts_with("/helix/")).map(|r|json!({"method":r.method,"target":r.target,"clientId":r.header("client-id"),"contentType":r.header("content-type"),"authorization":r.header("authorization")})).collect();observed=requests.len();ensure!(json!(actual)==step["requests"],"startup requests");
 }
 ensure!(fixture["intervals"]==json!([PERSISTENCE_INTERVAL.as_millis(),LIVE_REFRESH_INTERVAL.as_millis()]));
 ensure!(handler_requests.load(std::sync::atomic::Ordering::SeqCst)==3);twitch.shutdown().await;Ok(())
 }).catch_unwind().await;support::cleanup(&cache,&prefix).await?;ensure!(state(&cache,&prefix).await?==json!([]));match result{Ok(r)=>r,Err(p)=>std::panic::resume_unwind(p)}
 }).await
}

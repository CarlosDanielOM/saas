mod support;
use anyhow::{Context, Result};
use bson::{Bson, Document, doc};
use dima_core::ManualClock;
use dima_http::{
    HttpClient, Path, Provider,
    testing::{MockResponse, MockServer},
};
use dima_stream::{Error, follow_ledger::*};
use futures_util::{TryStreamExt, future::BoxFuture};
use serde_json::{Value, json};
use std::sync::Arc;

struct Scripted {
    client: HttpClient,
    provider: Provider,
}
impl Source for Scripted {
    fn login<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<String, Error>> {
        Box::pin(async { Ok("streamer".into()) })
    }
    fn page<'a>(
        &'a self,
        _: &'a str,
        direction: Direction,
        cursor: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Page, Error>> {
        Box::pin(async move {
            let path = if direction == Direction::Incoming {
                "/followers"
            } else {
                "/followed"
            };
            let value: Value = self
                .client
                .get(&self.provider, Path::fixed(path))
                .query(&[("after", cursor.unwrap_or("0"))])
                .send()
                .await
                .map_err(|e| Error::Invalid(e.to_string()))?
                .json()
                .await
                .map_err(|e| Error::Invalid(e.to_string()))?;
            if value["error"] == true {
                return Err(Error::Invalid("scripted page failure".into()));
            }
            let prefix = if direction == Direction::Incoming {
                "user"
            } else {
                "broadcaster"
            };
            let items = value["data"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|i| Follow {
                    id: i[format!("{prefix}_id")]
                        .as_str()
                        .unwrap_or_default()
                        .into(),
                    login: i[format!("{prefix}_login")]
                        .as_str()
                        .unwrap_or_default()
                        .into(),
                    name: i[format!("{prefix}_name")]
                        .as_str()
                        .unwrap_or_default()
                        .into(),
                    followed_at: i["followed_at"].as_str().unwrap_or_default().into(),
                })
                .collect();
            Ok(Page {
                items,
                total: value["total"].as_u64().unwrap_or(0),
                cursor: value["cursor"].as_str().map(str::to_owned),
            })
        })
    }
}
fn source(server: &MockServer) -> Result<Scripted> {
    Ok(Scripted {
        client: HttpClient::builder().build()?,
        provider: server.provider(Provider::builder("stream-test", "https://api.twitch.tv"))?,
    })
}
async fn indexes(store: &dima_store::mongo::MongoStore) -> Result<()> {
    store
        .documents("follow_relationship_ledgers")
        .create_index(
            mongodb::IndexModel::builder()
                .keys(doc! { "platform": 1, "follower_id": 1, "followed_id": 1, "status": 1 })
                .options(
                    mongodb::options::IndexOptions::builder()
                        .unique(true)
                        .partial_filter_expression(doc! { "status": "active" })
                        .build(),
                )
                .build(),
        )
        .await?;
    Ok(())
}
async fn documents(store: &dima_store::mongo::MongoStore) -> Result<Vec<Value>> {
    let docs: Vec<Document> = store
        .documents("follow_relationship_ledgers")
        .find(doc! {})
        .sort(doc! { "follower_id": 1, "followed_id": 1, "followed_at": 1, "status": 1 })
        .await?
        .try_collect()
        .await?;
    docs.into_iter()
        .map(|mut doc| {
            doc.remove("_id");
            for key in [
                "followed_at",
                "last_event_at",
                "ended_at",
                "created_at",
                "updated_at",
            ] {
                if let Some(Bson::DateTime(date)) = doc.get(key) {
                    let text = dima_text::to_iso_string(date.timestamp_millis()).context("date")?;
                    doc.insert(key, text);
                }
            }
            Ok(serde_json::from_str(
                &dima_store::mongo::json::to_json_string(&doc),
            )?)
        })
        .collect()
}
#[tokio::test]
async fn recorded_reference_documents_and_decisions() -> Result<()> {
    support::with_store(|store| async move {
        indexes(&store).await?;
        let recording: Value = serde_json::from_str(include_str!("reference.json"))?;
        let now = recording["now"].as_i64().context("now")?;
        let ledger = Ledger::new(store.clone(), Arc::new(ManualClock::new(now)), Config::default())?;
        let mut total = 0;
        let mut ids = std::collections::HashMap::<String,String>::new();
        for snapshot in recording["snapshots"].as_array().context("steps")? {
            let name = snapshot["name"].as_str().context("name")?;
            if name.ends_with("event") {
                let at = if name == "follow-event" { "2026-10-04T00:00:00Z" } else { "2026-10-05T00:00:00Z" };
                ledger.record_follow_ledger_start(&FollowStart { follower_id: "event".into(), followed_id: "channel".into(), follower_name: if name == "follow-event" { " 👋שם ".into() } else { String::new() }, followed_at: dima_text::parse_date(at), ..FollowStart::default() }).await?;
            } else {
                let server = MockServer::start().await?;
                let snapshot = snapshot.clone();
                server.fallback(move |r| {
                    let incoming = r.path() == "/followers";
                    let start: usize = r.query().and_then(|q| q.strip_prefix("after=")).and_then(|s| s.parse().ok()).unwrap_or(0);
                    if incoming && snapshot["failPage"].as_i64() == Some(start as i64) { return MockResponse::json(500, r#"{"error":true,"message":"scripted page failure"}"#); }
                    let all = snapshot[if incoming { "followers" } else { "following" }].as_array().cloned().unwrap_or_default();
                    MockResponse::json(200, &json!({ "data": all.iter().skip(start).take(100).collect::<Vec<_>>(), "total": all.len(), "cursor": (start+100 < all.len()).then(|| (start+100).to_string()) }).to_string())
                });
                let result = ledger.sync_follow_ledger_for_channel("channel", &source(&server)?).await;
                assert_eq!(serde_json::to_value(result)?, recording["snapshots"].as_array().context("steps")?.iter().find(|s| s["name"] == name).context("snapshot")?["result"], "result {name}");
            }
            let raw: Vec<Document> = store.documents("follow_relationship_ledgers").find(doc!{}).sort(doc! { "follower_id": 1, "followed_id": 1, "followed_at": 1, "status": 1 }).await?.try_collect().await?;
            let canonical: Vec<Value> = raw.into_iter().map(|d| {
                let id = d.get_object_id("_id").map(|id| id.to_hex()).unwrap_or_default();
                let token = format!("generated-{}",ids.len()+1);
                let token = ids.entry(id).or_insert(token).clone();
                let mut value = Bson::Document(d).into_canonical_extjson();
                value["_id"] = json!({"$oid":token});
                value
            }).collect();
            assert_eq!(canonical, snapshot["bsonDocuments"].as_array().context("canonical BSON")?.clone(), "BSON types {name}");
            let actual = documents(&store).await?;
            assert_eq!(actual, snapshot["documents"].as_array().context("docs")?.clone(), "documents {name}");
            total += actual.len();
        }
        eprintln!("recording: 11 steps, {total} exact documents");
        Ok(())
    }).await
}

#[tokio::test]
async fn every_real_ledger_document_decodes() -> Result<()> {
    let Some(store) = support::mongo("domdimabot").await? else {
        return Ok(());
    };
    let mut cursor = store
        .documents("follow_relationship_ledgers")
        .find(doc! {})
        .batch_size(250)
        .await?;
    let mut count = 0;
    while let Some(row) = cursor.try_next().await? {
        let _: dima_model::follow_relationship_ledgers::FollowRelationshipLedger =
            dima_model::decode_document(&row)?;
        count += 1;
    }
    anyhow::ensure!(count > 0, "production copy empty");
    eprintln!("real ledger documents decoded: {count}");
    Ok(())
}

async fn fixed_source(
    followers: Vec<Value>,
    following: Vec<Value>,
    failure: Option<(Direction, usize)>,
) -> Result<(MockServer, Scripted)> {
    let server = MockServer::start().await?;
    server.fallback(move |request| {
        let direction = if request.path() == "/followers" { Direction::Incoming } else { Direction::Outgoing };
        let offset: usize = request.query().and_then(|q| q.strip_prefix("after=")).and_then(|s| s.parse().ok()).unwrap_or(0);
        if failure == Some((direction, offset / 100)) { return MockResponse::json(500, r#"{"error":true,"message":"scripted page failure"}"#); }
        let all = if direction == Direction::Incoming { &followers } else { &following };
        MockResponse::json(200, &json!({"data": all.iter().skip(offset).take(100).collect::<Vec<_>>(), "total":all.len(), "cursor": (offset+100<all.len()).then(||(offset+100).to_string())}).to_string())
    });
    let source = source(&server)?;
    Ok((server, source))
}
fn follower(id: &str) -> Value {
    json!({"user_id":id,"user_login":id,"user_name":id,"followed_at":"2026-10-01T00:00:00Z"})
}

#[tokio::test]
async fn cancellation_after_every_reconciliation_write_is_repaired_by_next_pass() -> Result<()> {
    support::with_store(|store| async move {
        indexes(&store).await?;
        let ledger = Ledger::new(
            store.clone(),
            Arc::new(ManualClock::new(1_794_355_200_000)),
            Config::default(),
        )?;
        let (_old, old) = fixed_source(vec![follower("old")], vec![json!({"broadcaster_id":"old", "broadcaster_login":"old", "broadcaster_name":"old", "followed_at":"2026-10-01T00:00:00Z"})], None).await?;
        let (_new, new) = fixed_source(vec![follower("new")], vec![json!({"broadcaster_id":"new", "broadcaster_login":"new", "broadcaster_name":"new", "followed_at":"2026-10-01T00:00:00Z"})], None).await?;
        assert!(
            !ledger
                .sync_follow_ledger_for_channel("channel", &old)
                .await
                .error
        );
        let seed: Vec<Document> = store
            .documents("follow_relationship_ledgers")
            .find(doc! {})
            .await?
            .try_collect()
            .await?;
        assert!(
            !ledger
                .sync_follow_ledger_for_channel("channel", &new)
                .await
                .error
        );
        let expected = documents(&store).await?;
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        // Count the successful pass, then interrupt after each confirmed write in turn.
        let count = counter.clone();
        let counted = ledger.clone().with_fault(Arc::new(move || {
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async {})
        }));
        store
            .documents("follow_relationship_ledgers")
            .delete_many(doc! {})
            .await?;
        store
            .documents("follow_relationship_ledgers")
            .insert_many(seed.clone())
            .await?;
        assert!(
            !counted
                .sync_follow_ledger_for_channel("channel", &new)
                .await
                .error
        );
        let writes = counter.load(std::sync::atomic::Ordering::SeqCst);
        assert!(writes >= 3);
        for stop in 1..=writes {
            store
                .documents("follow_relationship_ledgers")
                .delete_many(doc! {})
                .await?;
            store
                .documents("follow_relationship_ledgers")
                .insert_many(seed.clone())
                .await?;
            let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let notify = Arc::new(tokio::sync::Notify::new());
            let reached = notify.clone();
            let broken = ledger.clone().with_fault(Arc::new(move || {
                let n = count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                let reached = reached.clone();
                Box::pin(async move {
                    if n == stop {
                        reached.notify_one();
                        std::future::pending::<()>().await;
                    }
                })
            }));
            let (_server, script) = fixed_source(vec![follower("new")], vec![json!({"broadcaster_id":"new", "broadcaster_login":"new", "broadcaster_name":"new", "followed_at":"2026-10-01T00:00:00Z"})], None).await?;
            let task = tokio::spawn(async move {
                broken
                    .sync_follow_ledger_for_channel("channel", &script)
                    .await
            });
            tokio::time::timeout(std::time::Duration::from_secs(10), notify.notified()).await?;
            task.abort();
            assert!(task.await.is_err());
            assert!(
                !ledger
                    .sync_follow_ledger_for_channel("channel", &new)
                    .await
                    .error
            );
            assert_eq!(documents(&store).await?, expected, "write boundary {stop}");
        }
        eprintln!("reconciliation cancellation boundaries verified: {writes}");
        Ok(())
    })
    .await
}

#[tokio::test]
async fn paging_failure_at_each_page_and_two_concurrent_passes_converge() -> Result<()> {
    support::with_store(|store| async move {
        indexes(&store).await?;
        let ledger = Ledger::new(store.clone(), Arc::new(ManualClock::new(1_794_355_200_000)), Config::default())?;
        let followers: Vec<Value> = (0..205).map(|i| follower(&format!("f{i}"))).collect();
        let following: Vec<Value> = (0..205).map(|i| json!({"broadcaster_id":format!("d{i}"), "broadcaster_login":"login", "broadcaster_name":"name", "followed_at":"2026-10-01T00:00:00Z"})).collect();
        for direction in [Direction::Incoming, Direction::Outgoing] {
            for page in 0..3 {
                store.documents("follow_relationship_ledgers").delete_many(doc!{}).await?;
                let (_server, script) = fixed_source(followers.clone(), following.clone(), Some((direction, page))).await?;
                assert!(ledger.sync_follow_ledger_for_channel("channel", &script).await.error);
                assert_eq!(store.documents("follow_relationship_ledgers").count_documents(doc! {"status":"ended"}).await?, 0);
                let (_server, script) = fixed_source(followers.clone(), following.clone(), None).await?;
                assert!(!ledger.sync_follow_ledger_for_channel("channel", &script).await.error);
                assert_eq!(store.documents("follow_relationship_ledgers").count_documents(doc!{}).await?, 410);
            }
        }
        store.documents("follow_relationship_ledgers").delete_many(doc!{}).await?;
        let (_server, script) = fixed_source(followers, following, None).await?;
        let _ = tokio::join!(ledger.sync_follow_ledger_for_channel("channel", &script), ledger.sync_follow_ledger_for_channel("channel", &script));
        assert!(!ledger.sync_follow_ledger_for_channel("channel", &script).await.error);
        assert_eq!(store.documents("follow_relationship_ledgers").count_documents(doc!{}).await?, 410);
        Ok(())
    }).await
}

#[tokio::test]
async fn twitch_adapter_uses_streamer_headers_pagination_and_request_deadlines() -> Result<()> {
    support::with_store(|store| async move {
        use dima_core::{SecretString, Shutdown, SystemRandom};
        use dima_twitch::{KeySpace, Twitch, TwitchConfig, TwitchDeps};
        let Some(cache) = support::cache().await? else {
            return Ok(());
        };
        let prefix = format!("dima_test_stream_{}:", uuid::Uuid::new_v4().simple());
        let clock = Arc::new(ManualClock::new(1_794_355_200_000));
        let result: Result<()> = async {
            let server = MockServer::start().await?;
            server
                .fallback(|_| MockResponse::json(200, r#"{"data":[],"total":0,"pagination":{}}"#));
            let mut config =
                TwitchConfig::new("stream-client", SecretString::from("stream-secret"));
            config.keys = KeySpace::prefixed(&prefix);
            cache
                .hset(
                    &config.keys.account("channel"),
                    &[
                        ("id", b"channel"),
                        ("name", b"streamer"),
                        ("has_permissions", b"true"),
                        ("access_token", b"mock-token"),
                        ("expires_at", b"1794358800"),
                    ],
                )
                .await?;
            let twitch = Twitch::new(
                config,
                TwitchDeps {
                    http: HttpClient::builder().build()?,
                    helix: server.provider(dima_twitch::helix_provider("stream-client"))?,
                    oauth: server.provider(dima_twitch::oauth_provider())?,
                    mongo: store.clone(),
                    dragonfly: cache.clone(),
                    cipher: dima_core::crypto::CredentialCipher::new("test-key")?,
                    clock: clock.clone(),
                    random: Arc::new(SystemRandom),
                    events: Arc::new(dima_twitch::NoopEvents),
                    shutdown: Shutdown::new(),
                },
            );
            let source = TwitchSource {
                twitch: twitch.clone(),
                pacer: None,
            };
            assert_eq!(source.login("channel").await?, "streamer");
            source
                .page("channel", Direction::Incoming, Some("cursor with space"))
                .await?;
            source.page("channel", Direction::Outgoing, None).await?;
            let requests = server.requests();
            assert_eq!(requests.len(), 2);
            assert_eq!(
                requests[0].target,
                "/helix/channels/followers?broadcaster_id=channel&first=100&after=cursor+with+space"
            );
            assert_eq!(
                requests[1].target,
                "/helix/channels/followed?user_id=channel&first=100"
            );
            assert_eq!(
                requests[0].header("authorization"),
                Some("Bearer mock-token")
            );
            assert_eq!(requests[0].header("client-id"), Some("stream-client"));
            let ledger = Ledger::new(
                store.clone(),
                clock,
                Config {
                    page_deadline: std::time::Duration::from_millis(30),
                    ..Config::default()
                },
            )?;
            server.fallback(|_| MockResponse::new(200).stall_after_headers());
            let failure = ledger
                .sync_follow_ledger_for_channel("channel", &source)
                .await;
            assert!(failure.error);
            assert_eq!(
                store
                    .documents("follow_relationship_ledgers")
                    .count_documents(doc! {})
                    .await?,
                0
            );
            server
                .fallback(|_| MockResponse::json(200, r#"{"data":[],"total":0,"pagination":{}}"#));
            assert!(
                !ledger
                    .sync_follow_ledger_for_channel("channel", &source)
                    .await
                    .error
            );
            twitch.shutdown().await;
            Ok(())
        }
        .await;
        support::cleanup(&cache, &prefix).await?;
        result
    })
    .await
}

#[tokio::test]
async fn channel_discovery_requires_active_permitted_twitch_refresh_token_and_deduplicates()
-> Result<()> {
    support::with_store(|store| async move {
        let now = 1_794_355_200_000;
        let accounts = vec![
            doc! { "type":"twitch", "id":" channel ", "actived":true, "has_permissions":true, "refresh_token": { "iv":"iv", "content":"token" } },
            doc! { "type":"twitch", "id":"channel", "actived":true, "has_permissions":true, "refresh_token": { "iv":"iv", "content":"token" } },
            doc! { "type":"twitch", "id":"inactive", "actived":false, "has_permissions":true, "refresh_token": { "iv":"iv", "content":"token" } },
            doc! { "type":"twitch", "id":"unpermitted", "actived":true, "has_permissions":false, "refresh_token": { "iv":"iv", "content":"token" } },
            doc! { "type":"twitch", "id":"no-refresh", "actived":true, "has_permissions":true },
        ];
        let prepared = dima_model::users::INFO.prepare_create(&doc! { "accounts":accounts }, &mut dima_store::mongo::WriteContext::new(now))?;
        store.writes("users").insert_one(&prepared).await?;
        let ledger = Ledger::new(store, Arc::new(ManualClock::new(now)), Config::default())?;
        assert_eq!(ledger.get_follow_ledger_sync_channel_ids().await?,vec!["channel"]);
        Ok(())
    }).await
}

/// The same test binary is the child; the parent alone owns database and spool cleanup.
#[tokio::test]
async fn actual_process_death_at_each_reconciliation_write_recovers() -> Result<()> {
    use futures_util::FutureExt;
    use std::sync::atomic::{AtomicUsize, Ordering};
    const CHILD_DB: &str = "DIMA_STREAM_FAULT_CHILD_DB";
    if let Ok(database) = std::env::var(CHILD_DB) {
        anyhow::ensure!(
            database.starts_with("dima_test_stream_"),
            "scratch database required"
        );
        let store = support::mongo(&database).await?.context("child store")?;
        let stop: usize = std::env::var("DIMA_STREAM_FAULT_WRITE")?.parse()?;
        let spool = std::env::var("DIMA_STREAM_FAULT_SPOOL")?;
        let counter = Arc::new(AtomicUsize::new(0));
        let ledger = Ledger::new(
            store,
            Arc::new(ManualClock::new(1_794_355_200_000)),
            Config {
                spool_directory: spool.into(),
                ..Config::default()
            },
        )?
        .with_fault(Arc::new(move || {
            let n = counter.fetch_add(1, Ordering::SeqCst) + 1;
            Box::pin(async move {
                if n == stop {
                    use std::io::Write;
                    println!("STREAM_WRITE_COMMITTED");
                    let _ = std::io::stdout().flush();
                    std::future::pending::<()>().await;
                }
            })
        }));
        let (_server, source) = fixed_source(vec![follower("new")], vec![json!({"broadcaster_id":"new-out","broadcaster_login":"new-out","broadcaster_name":"new-out","followed_at":"2026-10-01T00:00:00Z"})], None).await?;
        let result = ledger
            .sync_follow_ledger_for_channel("channel", &source)
            .await;
        anyhow::bail!("child completed before write boundary {stop}: {result:?}");
    }
    let spool = std::path::PathBuf::from("/tmp").join(format!(
        "dima_test_stream_spool_{}",
        uuid::Uuid::new_v4().simple()
    ));
    tokio::fs::create_dir(&spool).await?;
    let cleanup_spool = spool.clone();
    let result = std::panic::AssertUnwindSafe(support::with_store(|store| async move {
        use tokio::io::AsyncBufReadExt;
        indexes(&store).await?;
        let ledger = Ledger::new(store.clone(),Arc::new(ManualClock::new(1_794_355_200_000)),Config::default())?;
        let (_old_server, old) = fixed_source(vec![follower("old")],vec![json!({"broadcaster_id":"old-out","broadcaster_login":"old-out","broadcaster_name":"old-out","followed_at":"2026-10-01T00:00:00Z"})],None).await?;
        let (_new_server, new) = fixed_source(vec![follower("new")],vec![json!({"broadcaster_id":"new-out","broadcaster_login":"new-out","broadcaster_name":"new-out","followed_at":"2026-10-01T00:00:00Z"})],None).await?;
        assert!(!ledger.sync_follow_ledger_for_channel("channel",&old).await.error);
        let seed: Vec<Document> = store.documents("follow_relationship_ledgers").find(doc!{}).await?.try_collect().await?;
        let counter = Arc::new(AtomicUsize::new(0)); let count = counter.clone();
        let counted = ledger.clone().with_fault(Arc::new(move || { count.fetch_add(1,Ordering::SeqCst); Box::pin(async {}) }));
        assert!(!counted.sync_follow_ledger_for_channel("channel",&new).await.error);
        let expected = documents(&store).await?;
        let writes = counter.load(Ordering::SeqCst);
        for stop in 1..=writes {
            store.documents("follow_relationship_ledgers").delete_many(doc!{}).await?;
            store.documents("follow_relationship_ledgers").insert_many(seed.clone()).await?;
            let mut child = tokio::process::Command::new(std::env::current_exe()?)
                .args(["--exact","actual_process_death_at_each_reconciliation_write_recovers","--nocapture"])
                .env(CHILD_DB,store.database().name()).env("DIMA_STREAM_FAULT_WRITE",stop.to_string()).env("DIMA_STREAM_FAULT_SPOOL",&spool)
                .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::inherit()).kill_on_drop(true).spawn()?;
            let mut output = tokio::io::BufReader::new(child.stdout.take().context("child stdout")?).lines();
            let reached = tokio::time::timeout(std::time::Duration::from_secs(15),async {
                while let Some(line) = output.next_line().await? { if line.contains("STREAM_WRITE_COMMITTED") { return Ok(()); } }
                anyhow::bail!("child exited before boundary {stop}")
            }).await;
            child.start_kill()?; let status = child.wait().await?;
            reached.context("child boundary deadline")??; assert!(!status.success());
            assert!(!ledger.sync_follow_ledger_for_channel("channel",&new).await.error);
            assert_eq!(documents(&store).await?,expected,"OS kill boundary {stop}");
        }
        ledger.shutdown().await;
        eprintln!("actual process kills verified: {writes}");
        Ok(())
    })).catch_unwind().await;
    tokio::fs::remove_dir_all(cleanup_spool).await?;
    match result {
        Ok(result) => result,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

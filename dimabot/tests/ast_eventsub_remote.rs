#![cfg(all(feature = "eventsub", feature = "twitch-functions", feature = "ordinary-application-schemas"))]
//! Source-contract fixtures. Loopback and private-service tests require an execution lease.
use dima_rust::{functions::users::get_scopes::get_scopes, schemas::eventsub::ICondition, utils::{eventsub::remote::{self, EventsubDirectory, EventsubStore, RemoteFuture}, twitch::{AccessToken, TokenFuture, TokenSource, TokenSourceError, TwitchAuth, TwitchClient, TwitchEndpoints}}};
use mongodb::bson::{doc, Bson, Document};
use serde_json::{json, Value};
use std::{cell::RefCell, io::{Read, Write}, net::TcpListener, thread, time::Duration};

struct Tokens { app: bool, streamer: bool }
impl TokenSource for Tokens {
    fn token<'a>(&'a self, auth: &'a TwitchAuth) -> TokenFuture<'a> {
        Box::pin(async move { match auth {
            TwitchAuth::App if self.app => Ok(AccessToken::app("app-token")),
            TwitchAuth::Streamer(id) if self.streamer => Ok(AccessToken::user("streamer-token", id)),
            _ => Err(TokenSourceError::Missing),
        } })
    }
}
struct Directory(bool);
impl EventsubDirectory for Directory {
    fn name<'a>(&'a self, _: &'a str) -> RemoteFuture<'a, Option<String>> { Box::pin(async move { Ok(self.0.then(|| "channel-name".to_owned())) }) }
    fn header_error<'a>(&'a self, _: &'a str) -> RemoteFuture<'a, Option<String>> { Box::pin(async { Ok(None) }) }
}
#[derive(Default)]
struct HeaderFailure;
impl EventsubDirectory for HeaderFailure {
    fn name<'a>(&'a self, _: &'a str) -> RemoteFuture<'a, Option<String>> { Box::pin(async { Ok(Some("channel-name".into())) }) }
    fn header_error<'a>(&'a self, _: &'a str) -> RemoteFuture<'a, Option<String>> { Box::pin(async { Ok(Some("header unavailable".into())) }) }
}
#[derive(Default)]
struct Store { docs: RefCell<Vec<Document>>, reads: RefCell<usize>, deletes: RefCell<Vec<String>>, source_ids: RefCell<Vec<Option<Bson>>> }
impl EventsubStore for Store {
    fn candidates<'a>(&'a self, _: &'a str, _: &'a str, _: &'a str) -> RemoteFuture<'a, Vec<Document>> { Box::pin(async move { *self.reads.borrow_mut() += 1; Ok(self.docs.borrow().clone()) }) }
    fn upsert<'a>(&'a self, document: Document) -> RemoteFuture<'a, Document> { Box::pin(async move { self.docs.borrow_mut().push(document.clone()); Ok(document) }) }
    fn upsert_with_source_id<'a>(&'a self, source_id: Option<Bson>, document: Document) -> RemoteFuture<'a, Document> {
        self.source_ids.borrow_mut().push(source_id);
        self.upsert(document)
    }
    fn delete<'a>(&'a self, id: &'a str) -> RemoteFuture<'a, ()> { Box::pin(async move { self.deletes.borrow_mut().push(id.to_owned()); Ok(()) }) }
}
fn condition() -> ICondition { ICondition { broadcaster_user_id: Some("channel".into()), user_id: None, moderator_user_id: None, from_broadcaster_user_id: None, to_broadcaster_user_id: None } }
fn fixture() -> Document { doc! {"id":"existing", "status":"enabled", "type":"channel.poll.begin", "version":"1", "condition":{"broadcaster_user_id":"channel"}, "created_at":"now", "transport":{"method":"webhook","callback":"callback"}, "cost":1, "channel":"channel-name", "channelID":"channel", "enabled":true, "message":""} }

#[tokio::test]
async fn credentials_and_existing_short_circuit() {
    let tokens = Tokens { app: false, streamer: true }; let store = Store::default();
    // Keep the condition alive across each future.
    let cond = condition();
    let no_secret = remote::subscribe_twitch_event(&tokens, None, &Directory(true), &store, None, "channel", "channel.poll.begin", "1", &cond, None, false).await.expect("response");
    assert_eq!(no_secret, json!({"error":"EventSub secret is not configured","message":"TWITCH_EVENTSUB_SECRET is not set","status":500}));
    let missing = remote::subscribe_twitch_event(&tokens, None, &Directory(false), &store, Some("secret"), "channel", "channel.poll.begin", "1", &cond, None, false).await.expect("response");
    assert_eq!(missing["error"], "Streamer not found"); assert_eq!(missing["status"], 404);
    let failed_header = remote::subscribe_twitch_event(&tokens, None, &HeaderFailure, &store, Some("secret"), "channel", "channel.poll.begin", "1", &cond, None, true).await.expect("response");
    assert_eq!(failed_header, json!({"error":"Failed to get streamer header","message":"header unavailable","status":500}));
    store.docs.borrow_mut().push(fixture());
    let found = remote::subscribe_twitch_event(&tokens, None, &Directory(true), &store, Some("secret"), "channel", "channel.poll.begin", "1", &cond, None, false).await.expect("response");
    assert_eq!(found["id"], "existing");
    let ignored = remote::subscribe_twitch_event(&tokens, None, &Directory(true), &store, Some("secret"), "channel", "channel.poll.begin", "1", &cond, None, true).await.expect("response");
    assert_eq!(ignored["error"], "Error getting Twitch app credentials"); assert_eq!(*store.reads.borrow(), 1);
    let endpoints = TwitchEndpoints::new("http://127.0.0.1:1/", "http://127.0.0.1:1/").expect("endpoints");
    let client = TwitchClient::new("fixture-client", endpoints, Some(Duration::from_secs(1))).expect("client");
    assert_eq!(get_scopes(&tokens, &client, "channel").await, json!({"error":true,"message":"Failed to get app access token","status":500}));
    let list = remote::get_eventsubs(&tokens, None).await.expect("response");
    assert_eq!(list, json!({"error":"Twitch app credentials are not configured","message":"Unable to list EventSub subscriptions without an app token and client ID","status":500}));
}

#[tokio::test]
async fn existing_record_comparison_uses_every_populated_condition_key() {
    let tokens = Tokens { app: false, streamer: true };
    let requested = condition();
    let store = Store::default();
    let mut matching = fixture();
    matching.insert("status", 12);
    matching.insert("enabled", "false");
    matching.insert("cost", "4");
    matching.insert("transport", "webhook");
    matching.insert("cheerTiers", "nope");
    matching.insert("endEnabled", 1);
    matching.insert("clipEnabled", 0);
    matching.insert("watchStreakEnabled", true);
    matching.insert("__v", 3);
    matching.insert("remote_missing_since", Bson::Null);
    matching.insert("condition", doc! {"broadcaster_user_id": "channel", "reward_id": "", "user_id": Bson::Null});
    store.docs.borrow_mut().push(matching);
    let found = remote::subscribe_twitch_event(&tokens, None, &Directory(true), &store, Some("secret"), "channel", "channel.poll.begin", "1", &requested, None, false).await.expect("response");
    assert_eq!(found["id"], "existing");
    assert_eq!(found["status"], "12");
    assert_eq!(found["enabled"], true);
    assert_eq!(found["cost"], 4);
    assert_eq!(found["transport"], "webhook");
    assert_eq!(found["cheerTiers"], json!([]));
    assert_eq!(found["endEnabled"], true);
    assert_eq!(found["clipEnabled"], false);
    assert_eq!(found["minViewers"], 0);
    assert!(found.get("todayFollows").is_none());
    assert!(found.get("watchStreakEnabled").is_none());
    assert!(found.get("__v").is_none());
    assert!(found.get("remote_missing_since").is_none());
    assert_eq!(found["condition"]["reward_id"], "");
    assert!(found["condition"].get("user_id").is_some_and(Value::is_null));

    let follows = Store::default();
    let mut present = fixture();
    present.insert("id", "follows");
    present.insert("todayFollows", false);
    follows.docs.borrow_mut().push(present);
    let kept_false = remote::subscribe_twitch_event(&tokens, None, &Directory(true), &follows, Some("secret"), "channel", "channel.poll.begin", "1", &requested, None, false).await.expect("response");
    assert_eq!(kept_false["todayFollows"], false);
    let null_follows = Store::default();
    let mut present_null = fixture();
    present_null.insert("id", "follows-null");
    present_null.insert("todayFollows", Bson::Null);
    null_follows.docs.borrow_mut().push(present_null);
    let kept_null = remote::subscribe_twitch_event(&tokens, None, &Directory(true), &null_follows, Some("secret"), "channel", "channel.poll.begin", "1", &requested, None, false).await.expect("response");
    assert!(kept_null.get("todayFollows").is_some_and(Value::is_null));

    let extra = Store::default();
    let mut different = fixture();
    different.insert("id", "extra");
    different.insert("condition", doc! {"broadcaster_user_id": "channel", "reward_id": "abc", "flag": false, "n": 0, "nested": {"z": 1, "a": true}});
    extra.docs.borrow_mut().push(different);
    let missed = remote::subscribe_twitch_event(&tokens, None, &Directory(true), &extra, Some("secret"), "channel", "channel.poll.begin", "1", &requested, None, false).await.expect("response");
    assert_eq!(missed["error"], "Error getting Twitch app credentials");
    assert!(missed.get("id").is_none());
    for condition in [
        doc! {"broadcaster_user_id": "channel", "flag": false},
        doc! {"broadcaster_user_id": "channel", "n": 0},
        doc! {"broadcaster_user_id": "channel", "extra": {}},
        doc! {"broadcaster_user_id": "channel", "extra": []},
    ] {
        let populated = Store::default();
        populated.docs.borrow_mut().push(doc! {"id": "populated", "condition": condition});
        let rejected = remote::subscribe_twitch_event(&tokens, None, &Directory(true), &populated, Some("secret"), "channel", "channel.poll.begin", "1", &requested, None, false).await.expect("response");
        assert_eq!(rejected["error"], "Error getting Twitch app credentials");
        assert!(rejected.get("id").is_none());
    }

    let blank = Store::default();
    blank.docs.borrow_mut().push(doc! {"id": "", "condition": {"broadcaster_user_id": "channel"}});
    blank.docs.borrow_mut().push(doc! {"id": "later", "condition": {"broadcaster_user_id": "channel"}});
    let skipped = remote::subscribe_twitch_event(&tokens, None, &Directory(true), &blank, Some("secret"), "channel", "channel.poll.begin", "1", &requested, None, false).await.expect("response");
    assert_eq!(skipped["error"], "Error getting Twitch app credentials");
    assert!(skipped.get("id").is_none());

    let ordered = Store::default();
    let both = ICondition { broadcaster_user_id: Some("channel".into()), user_id: Some("mod".into()), moderator_user_id: None, from_broadcaster_user_id: None, to_broadcaster_user_id: None };
    ordered.docs.borrow_mut().push(doc! {"id": 1, "condition": {"user_id": "mod", "broadcaster_user_id": "channel"}});
    let numeric_id = remote::subscribe_twitch_event(&tokens, None, &Directory(true), &ordered, Some("secret"), "channel", "channel.poll.begin", "1", &both, None, false).await.expect("response");
    assert_eq!(numeric_id["id"], "1");

    let raids = Store::default();
    let raid_requested = ICondition { broadcaster_user_id: None, user_id: None, moderator_user_id: None, from_broadcaster_user_id: Some("channel".into()), to_broadcaster_user_id: None };
    raids.docs.borrow_mut().push(doc! {"id": "raid", "type": "channel.raid", "condition": {"to_broadcaster_user_id": "", "from_broadcaster_user_id": "channel"}});
    let raid = remote::subscribe_twitch_event(&tokens, None, &Directory(true), &raids, Some("secret"), "channel", "channel.raid", "1", &raid_requested, None, false).await.expect("response");
    assert_eq!(raid["id"], "raid");
    assert_eq!(raid["type"], "channel.raid.outgoing");
}

#[test]
fn subscription_upsert_casts_and_applies_schema_defaults_on_insert() {
    let (filter, update) = remote::prepare_subscription_upsert(doc! {
        "id": "new",
        "status": "enabled",
        "type": "channel.poll.begin",
        "version": "1",
        "condition": {"broadcaster_user_id": "channel", "reward_id": "abc"},
        "created_at": "now",
        "transport": {"method": "webhook", "callback": "https://subscriptions.domdimabot.com/eventsub"},
        "cost": "1",
        "channel": "channel-name",
        "channelID": "channel",
        "message": "hello",
        "enabled": false,
        "notAField": "drop me",
    }).expect("update");
    assert_eq!(filter.get_str("id").expect("id"), "new");
    let set = update.get_document("$set").expect("$set");
    let insert = update.get_document("$setOnInsert").expect("$setOnInsert");
    assert!(set.get("notAField").is_none());
    assert!(insert.get("notAField").is_none());
    assert_eq!(set.get_str("message").expect("message"), "hello");
    assert_eq!(set.get_bool("enabled").expect("enabled"), false);
    assert!(insert.get("message").is_none());
    assert!(insert.get("enabled").is_none());
    assert!(insert.get("id").is_none());
    assert_eq!(set.get_document("condition").expect("condition").get_str("reward_id").expect("reward"), "abc");
    assert_eq!(set.get("cost"), Some(&Bson::Int32(1)));
    assert_eq!(insert.get_bool("todayFollows").expect("today"), false);
    assert_eq!(insert.get_bool("watchStreakEnabled").expect("streak"), true);
    assert_eq!(insert.get_bool("modiversaryEnabled").expect("modiversary"), true);
    assert_eq!(insert.get_bool("endEnabled").expect("end"), false);
    assert_eq!(insert.get_bool("clipEnabled").expect("clip"), false);
    assert_eq!(insert.get_str("modiversaryMessage").expect("mod message"), "");
    assert_eq!(insert.get_str("endMessage").expect("end message"), "");
    assert_eq!(insert.get_str("temporalBanMessage").expect("ban"), "");
    assert_eq!(insert.get_i32("minViewers").expect("viewers"), 2);
    assert_eq!(insert.get_i32("delay").expect("delay"), 0);
    assert_eq!(insert.get_i32("__v").expect("version"), 0);
    assert_eq!(insert.get("remote_missing_since"), Some(&Bson::Null));
    assert!(insert.get_array("cheerTiers").expect("tiers").is_empty());
}

#[tokio::test]
async fn app_token_failures_use_the_null_token_envelope() {
    let endpoints = TwitchEndpoints::new("http://127.0.0.1:1/", "http://127.0.0.1:1/").expect("endpoints");
    let client = TwitchClient::new("fixture-client", endpoints, Some(Duration::from_secs(1))).expect("client");
    let expected = json!({"error": true, "message": "Failed to get app access token", "status": 500});
    struct Unavailable;
    impl TokenSource for Unavailable {
        fn token<'a>(&'a self, _: &'a TwitchAuth) -> TokenFuture<'a> { Box::pin(async { Err(TokenSourceError::Unavailable) }) }
    }
    struct Denied;
    impl TokenSource for Denied {
        fn token<'a>(&'a self, _: &'a TwitchAuth) -> TokenFuture<'a> { Box::pin(async { Err(TokenSourceError::PermissionsDenied) }) }
    }
    struct Empty;
    impl TokenSource for Empty {
        fn token<'a>(&'a self, _: &'a TwitchAuth) -> TokenFuture<'a> { Box::pin(async { Ok(AccessToken::app("")) }) }
    }
    struct Mismatch;
    impl TokenSource for Mismatch {
        fn token<'a>(&'a self, _: &'a TwitchAuth) -> TokenFuture<'a> { Box::pin(async { Err(TokenSourceError::IdentityMismatch) }) }
    }
    assert_eq!(get_scopes(&Unavailable, &client, "channel").await, expected);
    assert_eq!(get_scopes(&Denied, &client, "channel").await, expected);
    assert_eq!(get_scopes(&Empty, &client, "channel").await, expected);
    assert_eq!(get_scopes(&Mismatch, &client, "channel").await, expected);
}

fn fixture_server(replies: Vec<(u16, &'static str)>) -> (TwitchClient, thread::JoinHandle<Vec<(String, Value)>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("loopback");
    let address = format!("http://{}/", listener.local_addr().expect("address"));
    let client = TwitchClient::new("client-id", TwitchEndpoints::new(&address, &address).expect("endpoints"), Some(Duration::from_secs(3))).expect("client");
    let handle = thread::spawn(move || {
        let mut requests = Vec::new();
        for (status, body) in replies {
            let (mut stream, _) = listener.accept().expect("accept"); stream.set_read_timeout(Some(Duration::from_secs(3))).expect("timeout");
            let mut bytes = Vec::new(); let mut buf = [0; 2048];
            let end = loop { let n = stream.read(&mut buf).expect("read"); assert!(n > 0); bytes.extend_from_slice(&buf[..n]); if let Some(p) = bytes.windows(4).position(|v| v == b"\r\n\r\n") { break p + 4; } };
            let headers = String::from_utf8(bytes[..end].to_vec()).expect("headers");
            let length = headers.lines().find_map(|l| { let (k,v) = l.split_once(':')?; k.eq_ignore_ascii_case("content-length").then(|| v.trim().parse::<usize>().expect("length")) }).unwrap_or(0);
            while bytes.len() < end + length { let n = stream.read(&mut buf).expect("body"); assert!(n > 0); bytes.extend_from_slice(&buf[..n]); }
            let parsed = if length == 0 { Value::Null } else { serde_json::from_slice(&bytes[end..end+length]).expect("json") };
            let response = format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            stream.write_all(response.as_bytes()).expect("response"); requests.push((headers, parsed));
        }
        requests
    });
    (client, handle)
}
fn assert_headers(headers: &str) { assert!(headers.to_ascii_lowercase().contains("authorization: bearer app-token")); assert!(headers.to_ascii_lowercase().contains("client-id: client-id")); }

#[tokio::test]
#[ignore = "requires loopback execution lease"]
async fn remote_requests_use_app_token_and_page_cursors() {
    let tokens = Tokens { app: true, streamer: true }; let store = Store::default(); let cond = condition();
    let (client, server) = fixture_server(vec![(200, r#"{"data":[{"id":"one"}],"pagination":{"cursor":"next"},"total":9}"#), (200, r#"{"data":[{"id":"two"}],"pagination":{},"total":9}"#)]);
    let list = remote::get_eventsubs(&tokens, Some(&client)).await.expect("list"); assert_eq!(list["total"], 2); assert_eq!(list["complete"], true); assert_eq!(list["data"].as_array().expect("data").len(), 2);
    let calls = server.join().expect("server"); assert!(calls[0].0.starts_with("GET /eventsub/subscriptions?first=100 ")); assert!(calls[1].0.starts_with("GET /eventsub/subscriptions?first=100&after=next ")); assert_headers(&calls[0].0);
    let (client, server) = fixture_server(vec![(202, r#"{"data":[{"id":"new","status":"enabled","type":"channel.poll.begin","version":"1","condition":{"broadcaster_user_id":"channel"},"created_at":"now","transport":{"method":"webhook","callback":"https://subscriptions.domdimabot.com/eventsub"},"cost":1}]}"#)]);
    let created = remote::subscribe_twitch_event(&tokens, Some(&client), &Directory(true), &store, Some("secret"), "channel", "channel.poll.begin", "1", &cond, None, true).await.expect("subscribe"); assert_eq!(created["id"], "new");
    let calls = server.join().expect("server"); assert!(calls[0].0.starts_with("POST /eventsub/subscriptions ")); assert_headers(&calls[0].0); assert_eq!(calls[0].1, json!({"type":"channel.poll.begin","version":"1","condition":{"broadcaster_user_id":"channel"},"transport":{"method":"webhook","callback":"https://subscriptions.domdimabot.com/eventsub","secret":"secret"}}));
    for status in [204, 404] {
        let (client, server) = fixture_server(vec![(status, "")]);
        let result = remote::unsubscribe_twitch_event(&tokens, Some(&client), &store, "id 1").await.expect("delete"); assert_eq!(result["status"], status);
        let calls = server.join().expect("server"); assert!(calls[0].0.starts_with("DELETE /eventsub/subscriptions?id=id%201 ")); assert_headers(&calls[0].0);
    }
    assert_eq!(*store.deletes.borrow(), vec!["id 1", "id 1"]);
}

#[tokio::test]
#[ignore = "requires loopback execution lease"]
async fn scopes_success_error_and_internal() {
    let tokens = Tokens { app: true, streamer: true };
    for (status, body, expected) in [(200, r#"{"data":[{"user_id":"u","scopes":["scope"]}]}"#, false), (401, r#"{"error":"Unauthorized","message":"bad token","status":401}"#, true), (200, "not-json", true)] {
        let (client, server) = fixture_server(vec![(status, body)]);
        let response = get_scopes(&tokens, &client, "u").await;
        let calls = server.join().expect("server"); assert!(calls[0].0.starts_with("GET /authorization/users?user_id=u ")); assert_headers(&calls[0].0); assert_eq!(response["error"], expected);
        if status == 401 { assert_eq!(response["message"], "bad token"); assert_eq!(response["status"], 401); }
        if body == "not-json" { assert_eq!(response["message"], "Internal server error"); }
    }
    let (client, server) = fixture_server(vec![(200, r#"{"error":0,"data":[{"user_id":"u","scopes":["scope"]}]}"#)]);
    let response = get_scopes(&tokens, &client, "u").await;
    server.join().expect("server");
    assert_eq!(response["error"], false);
    assert_eq!(response["data"][0]["user_id"], "u");
}

#[tokio::test]
#[ignore = "requires loopback execution lease"]
async fn remote_error_values_follow_source_truthiness() {
    let tokens = Tokens { app: true, streamer: true };
    let store = Store::default();
    let cond = condition();
    let (client, server) = fixture_server(vec![(200, r#"{"error":0,"data":[{"id":"page"}],"pagination":{"cursor":2}}"#), (200, r#"{"data":[{"id":"next"}],"pagination":{}}"#)]);
    let list = remote::get_eventsubs(&tokens, Some(&client)).await.expect("list");
    let calls = server.join().expect("server");
    assert_eq!(list["complete"], true);
    assert_eq!(list["total"], 2);
    assert!(calls[1].0.starts_with("GET /eventsub/subscriptions?first=100&after=2 "));
    let (client, server) = fixture_server(vec![(400, r#"{"error":401,"message":12}"#)]);
    let failed = remote::subscribe_twitch_event(&tokens, Some(&client), &Directory(true), &store, Some("secret"), "channel", "channel.poll.begin", "1", &cond, None, true).await.expect("subscribe");
    server.join().expect("server");
    assert_eq!(failed, json!({"error":"401","message":"12","status":400}));
    let (client, server) = fixture_server(vec![(200, r#"{"error":true,"data":[{"id":"hidden"}]}"#)]);
    let boolean_error = remote::subscribe_twitch_event(&tokens, Some(&client), &Directory(true), &store, Some("secret"), "channel", "channel.poll.begin", "1", &cond, None, true).await.expect("subscribe");
    server.join().expect("server");
    assert_eq!(boolean_error["error"], "true");
    let (client, server) = fixture_server(vec![(200, r#"{"data":[0]}"#)]);
    let falsy = remote::subscribe_twitch_event(&tokens, Some(&client), &Directory(true), &store, Some("secret"), "channel", "channel.poll.begin", "1", &cond, None, true).await.expect("subscribe");
    server.join().expect("server");
    assert_eq!(falsy["error"], "Twitch returned HTTP 200");
    let (client, server) = fixture_server(vec![(200, r#"{"error":0,"data":[{"id":"zero","status":"enabled","type":"channel.poll.begin","version":"1","condition":{"broadcaster_user_id":"channel"},"created_at":"now","transport":{"method":"webhook","callback":"https://subscriptions.domdimabot.com/eventsub"},"cost":1}]}"#)]);
    let created = remote::subscribe_twitch_event(&tokens, Some(&client), &Directory(true), &store, Some("secret"), "channel", "channel.poll.begin", "1", &cond, None, true).await.expect("subscribe");
    server.join().expect("server");
    assert_eq!(created["id"], "zero");
    let (client, server) = fixture_server(vec![(403, r#"{"message":7}"#)]);
    let unsubscribed = remote::unsubscribe_twitch_event(&tokens, Some(&client), &store, "gone").await.expect("delete");
    server.join().expect("server");
    assert_eq!(unsubscribed, json!({"error":"Failed to unsubscribe EventSub","message":"7","status":403}));
    assert!(store.deletes.borrow().is_empty());
    let (client, server) = fixture_server(vec![(403, r#"{"error":{"code":1},"message":""}"#)]);
    let object_error = remote::unsubscribe_twitch_event(&tokens, Some(&client), &store, "gone").await.expect("delete");
    server.join().expect("server");
    assert_eq!(object_error["error"], "[object Object]");
    assert_eq!(object_error["message"], "[object Object]");
}

#[tokio::test]
#[ignore = "requires isolated private MongoDB and execution lease"]
async fn private_eventsub_mongo_upsert_and_delete() {
    let uri = std::env::var("MONGO_URI").expect("private MONGO_URI required");
    assert!(uri.starts_with("mongodb://127.0.0.1:") || uri.starts_with("mongodb://localhost:"), "loopback MongoDB required");
    let name = std::env::var("AST_EVENTSUB_TEST_DB").expect("task-owned database required");
    assert!(name.starts_with("ast_eventsub_test_") && name.len() > "ast_eventsub_test_".len());
    let client = mongodb::Client::with_uri_str(&uri).await.expect("private MongoDB");
    let collection = client.database(&name).collection::<Document>("eventsubs");
    assert_eq!(collection.count_documents(doc! {}).await.expect("count"), 0);
    let saved = EventsubStore::upsert(&collection, doc! {
        "id": "existing", "status": "enabled", "type": "channel.poll.begin", "version": "1",
        "condition": {"broadcaster_user_id": "channel", "reward_id": "abc"}, "created_at": "now",
        "transport": {"method": "webhook", "callback": "callback"}, "cost": "1", "channel": "channel-name",
        "channelID": "channel", "notAField": "drop",
    }).await.expect("upsert");
    assert_eq!(saved.get_str("id"), Ok("existing"));
    assert!(saved.get("notAField").is_none());
    assert_eq!(saved.get_str("reward_id").ok(), None);
    assert_eq!(saved.get_document("condition").expect("condition").get_str("reward_id"), Ok("abc"));
    assert_eq!(saved.get_bool("enabled"), Ok(true));
    assert_eq!(saved.get_bool("todayFollows"), Ok(false));
    assert_eq!(saved.get_i32("minViewers"), Ok(2));
    assert_eq!(saved.get_i32("__v"), Ok(0));
    assert_eq!(saved.get("remote_missing_since"), Some(&Bson::Null));
    assert!(saved.get_object_id("_id").is_ok());
    assert_eq!(saved.get("cost"), Some(&Bson::Int32(1)));
    collection.update_one(doc! {"id": "existing"}, doc! {"$set": {"enabled": false}}).await.expect("preserve");
    EventsubStore::upsert(&collection, doc! {
        "id": "existing", "status": "enabled", "type": "channel.poll.begin", "version": "1",
        "condition": {"broadcaster_user_id": "channel", "reward_id": "abc"}, "created_at": "now",
        "transport": {"method": "webhook", "callback": "callback"}, "cost": 1, "channel": "channel-name",
        "channelID": "channel", "message": "changed",
    }).await.expect("update");
    let stored = collection.find_one(doc! {"id": "existing"}).await.expect("read").expect("document");
    assert_eq!(stored.get_bool("enabled"), Ok(false));
    assert_eq!(stored.get_str("message"), Ok("changed"));
    assert_eq!(stored.get_i32("minViewers"), Ok(2));
    assert_eq!(collection.count_documents(doc! {"id": "existing"}).await.expect("count"), 1);
    EventsubStore::delete(&collection, "existing").await.expect("delete");
    assert_eq!(collection.count_documents(doc! {}).await.expect("count"), 0);
}

// Generate this artifact with the actual-source oracle in a disposable directory;
// its path is supplied explicitly so no fixture is silently stale.
#[tokio::test]
#[ignore = "requires isolated actual-TypeScript oracle artifact"]
async fn raw_conditions_compare_against_actual_source_oracle() {
    let path = std::env::var("AST_EVENTSUB_ORACLE").expect("oracle artifact path");
    let oracle: Value = serde_json::from_slice(&std::fs::read(path).expect("oracle artifact")).expect("json");
    assert_eq!(oracle["implementation"], "actual-typescript-ast");
    let tokens = Tokens { app: false, streamer: true };
    for case in oracle["matches"].as_array().expect("cases") {
        let store = Store::default();
        let stored = mongodb::bson::to_bson(&case["stored"]).expect("stored bson");
        let requested = mongodb::bson::to_bson(&case["requested"]).expect("requested bson");
        store.docs.borrow_mut().push(doc! {"id":"existing", "condition":stored});
        let result = remote::subscribe_twitch_event_raw(&tokens, None, &Directory(true), &store, Some("secret"), "channel", "type", "1", &requested, None, false).await.expect("response");
        assert_eq!(result.get("id").is_some_and(|id| id == "existing"), case["matched"].as_bool().expect("match"), "case {case}");
    }
}

#[tokio::test]
#[ignore = "requires loopback execution lease"]
async fn raw_condition_and_primitive_response_reach_real_http_adapter() {
    let tokens = Tokens { app: true, streamer: true };
    let store = Store::default();
    let requested = Bson::Document(doc! {"broadcaster_user_id":"channel", "reward_id":"abc", "extra":{"flag":false}});
    let (client, server) = fixture_server(vec![(200, r#"{"data":[true]}"#)]);
    let result = remote::subscribe_twitch_event_raw(&tokens, Some(&client), &Directory(true), &store, Some("secret"), "channel", "type", "1", &requested, None, true).await.expect("primitive result");
    let calls = server.join().expect("server");
    assert_eq!(calls[0].1["condition"], json!({"broadcaster_user_id":"channel","reward_id":"abc","extra":{"flag":false}}));
    assert_eq!(result["id"], "");
    assert!(store.docs.borrow()[0].get("id").is_none());
    let (client, server) = fixture_server(vec![(404, "")]);
    let result = remote::unsubscribe_twitch_event(&tokens, Some(&client), &store, "a&other=b#fragment").await.expect("delete");
    let calls = server.join().expect("server");
    assert!(calls[0].0.starts_with("DELETE /eventsub/subscriptions?id=a&other=b "));
    assert_eq!(result, json!({"status":404,"ok":false}));
    assert_eq!(store.deletes.borrow().last().map(String::as_str), Some("a&other=b#fragment"));
    let (client, server) = fixture_server(vec![(200, "null")]);
    let scopes = get_scopes(&tokens, &client, "u").await;
    server.join().expect("server");
    assert_eq!(scopes, json!({"error":true,"message":"Internal server error"}));
}

#[tokio::test]
#[ignore = "requires isolated private MongoDB, loopback and execution lease"]
async fn primitive_response_uses_real_collection_adapter() {
    let uri = std::env::var("MONGO_URI").expect("private MONGO_URI required");
    assert!(uri.starts_with("mongodb://127.0.0.1:") || uri.starts_with("mongodb://localhost:"));
    let name = std::env::var("AST_EVENTSUB_TEST_DB").expect("task-owned database required");
    assert!(name.starts_with("ast_eventsub_test_") && name.len() > "ast_eventsub_test_".len());
    let mongo = mongodb::Client::with_uri_str(&uri).await.expect("private MongoDB");
    let collection = mongo.database(&name).collection::<Document>("primitive_eventsubs");
    assert_eq!(collection.count_documents(doc! {}).await.expect("count"), 0);
    let (client, server) = fixture_server(vec![(200, r#"{"data":[true]}"#)]);
    let result = remote::subscribe_twitch_event_raw(&Tokens { app:true, streamer:true }, Some(&client), &Directory(true), &collection, Some("secret"), "channel", "type", "1", &Bson::Document(doc! {}), None, true).await.expect("upsert");
    server.join().expect("server");
    assert_eq!(result["id"], "");
    let saved = collection.find_one(doc! {}).await.expect("read").expect("document");
    assert_eq!(saved.get("id"), Some(&Bson::Null));
    assert_eq!(saved.get_str("channelID"), Ok("channel"));
}

#[tokio::test]
#[ignore = "requires isolated actual-TypeScript oracle artifact and loopback execution lease"]
async fn remote_primitive_and_scopes_compare_against_source_oracle() {
    let path = std::env::var("AST_EVENTSUB_ORACLE").expect("oracle artifact path");
    let oracle: Value = serde_json::from_slice(&std::fs::read(path).expect("artifact")).expect("json");
    let tokens = Tokens { app:true, streamer:true };
    let store = Store::default();
    let (client, server) = fixture_server(vec![(202, r#"{"data":[true]}"#)]);
    let result = remote::subscribe_twitch_event_raw(&tokens, Some(&client), &Directory(true), &store, Some("secret"), "channel", "type", "1", &Bson::Document(doc! {"extra":{"nested":true}}), None, true).await.expect("subscribe");
    let calls = server.join().expect("server");
    assert_eq!(result, oracle["primitive"]["result"]);
    assert_eq!(calls[0].1, oracle["primitive"]["calls"][0]["body"]);
    let (client, server) = fixture_server(vec![(404, "")]);
    let result = remote::unsubscribe_twitch_event(&tokens, Some(&client), &store, "a&other=b#fragment").await.expect("unsubscribe");
    let calls = server.join().expect("server");
    assert_eq!(result["status"], oracle["unsubscribe"]["status"]);
    assert_eq!(result["ok"], oracle["unsubscribe"]["ok"]);
    assert!(calls[0].0.starts_with("DELETE /eventsub/subscriptions?id=a&other=b "));
    let (client, server) = fixture_server(vec![(200, "null")]);
    let result = get_scopes(&tokens, &client, "u").await;
    server.join().expect("server");
    assert_eq!(result, oracle["scopesNull"]);
}

// Compares actual TypeScript call inputs after installed Mongoose's query casting,
// defaults, and BSON serialization with the native prepared Mongo operation.
#[test]
#[ignore = "requires isolated actual-TypeScript and Mongoose oracle artifact"]
fn subscription_upsert_compares_mongoose_wire_oracle() {
    let path = std::env::var("AST_EVENTSUB_ORACLE").expect("oracle artifact path");
    let oracle: Value = serde_json::from_slice(&std::fs::read(path).expect("artifact")).expect("json");
    for case in oracle["upserts"].as_array().expect("upsert cases") {
        let name = case["name"].as_str().expect("case name");
        let (source_id, updated_id) = match name {
            "absent" => (None, None),
            "null" => (Some(Bson::Null), Some(Bson::Null)),
            "overridden" => (Some(Bson::String("source".into())), Some(Bson::String("override".into()))),
            "normal" => (Some(Bson::String("normal".into())), Some(Bson::String("normal".into()))),
            _ => panic!("unexpected case {name}"),
        };
        let mut document = doc! {"channel":"channel-name", "channelID":"channel"};
        if let Some(id) = updated_id { document.insert("id", id); }
        let (filter, update) = remote::prepare_subscription_upsert_with_source_id(source_id, document).expect("native operation");
        assert_eq!(serde_json::to_value(filter).expect("filter JSON"), case["filter"], "filter: {name}");
        assert_eq!(serde_json::to_value(update).expect("update JSON"), case["update"], "update: {name}");
        assert_eq!(case["queryIdUndefined"], name == "absent", "query filter before BSON: {name}");
    }
}

#[tokio::test]
#[ignore = "requires isolated private MongoDB, loopback and execution lease"]
async fn source_filter_survives_config_override_and_missing_id() {
    let uri = std::env::var("MONGO_URI").expect("private MONGO_URI required");
    assert!(uri.starts_with("mongodb://127.0.0.1:") || uri.starts_with("mongodb://localhost:"));
    let name = std::env::var("AST_EVENTSUB_TEST_DB").expect("task-owned database required");
    assert!(name.starts_with("ast_eventsub_test_") && name.len() > "ast_eventsub_test_".len());
    let mongo = mongodb::Client::with_uri_str(&uri).await.expect("private MongoDB");
    let collection = mongo.database(&name).collection::<Document>("source_filter_eventsubs");
    assert_eq!(collection.count_documents(doc! {}).await.expect("count"), 0);
    collection.insert_one(doc! {"id":"source", "marker":"source"}).await.expect("source");
    collection.insert_one(doc! {"id":"override", "marker":"override"}).await.expect("override");
    let tokens = Tokens { app:true, streamer:true };
    let (client, server) = fixture_server(vec![(200, r#"{"data":[{"id":"source"}]}"#)]);
    let config = doc! {"id":"override"};
    remote::subscribe_twitch_event_raw(&tokens, Some(&client), &Directory(true), &collection, Some("secret"), "channel", "type", "1", &Bson::Document(doc! {}), Some(&config), true).await.expect("upsert");
    server.join().expect("server");
    let source = collection.find_one(doc! {"marker":"source"}).await.expect("read").expect("source");
    let other = collection.find_one(doc! {"marker":"override"}).await.expect("read").expect("override");
    assert_eq!(source.get_str("id"), Ok("override"));
    assert!(source.contains_key("channelID"));
    assert!(!other.contains_key("channelID"));
    collection.insert_one(doc! {"marker":"missing"}).await.expect("missing");
    let (client, server) = fixture_server(vec![(200, r#"{"data":[true]}"#)]);
    remote::subscribe_twitch_event_raw(&tokens, Some(&client), &Directory(true), &collection, Some("secret"), "channel", "type", "1", &Bson::Document(doc! {}), None, true).await.expect("missing ID upsert");
    server.join().expect("server");
    let missing = collection.find_one(doc! {"marker":"missing"}).await.expect("read").expect("missing");
    assert_eq!(missing.get_str("channelID"), Ok("channel"));
    assert_eq!(collection.count_documents(doc! {}).await.expect("count"), 3);
}

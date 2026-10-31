#![cfg(feature = "site-analytics-api")]
//! Site analytics checks. Pure cases need no service.
//!
//! The ignored test requires a task-owned private network, not host networking:
//! `SITE_ANALYTICS_TEST_MONGO_URI=mongodb://keyword-mongo:27017`,
//! `SITE_ANALYTICS_TEST_MONGO_DATABASE=rust_site_analytics_fixture_<unique>`,
//! `SITE_ANALYTICS_TEST_MONGO_ACK=disposable`,
//! `SITE_ANALYTICS_TEST_REDIS_URI=redis://keyword-redis:6379/0`,
//! `SITE_ANALYTICS_TEST_REDIS_ACK=disposable`, and
//! `SITE_ANALYTICS_TEST_OWNER=<unique nonempty marker>`, and the external
//! `DIMA_SITE_ANALYTICS_FIXTURE_DIR=<absolute path outside workspace>` and
//! `DIMA_SITE_ANALYTICS_FIXTURE_SHA256=<lowercase SHA-256>` source fixture.
//! The isolated harness must preseed Mongo `fixture_identity` with
//! `{_id: "owner", token: <marker>}` and Redis key
//! `site:analytics:fixture:owner` with the same marker. The database must have
//! no other collections and the analytics hash must be absent. The test uses
//! only loopback for its local HTTP server and removes only its event documents
//! and analytics hash. Isolation must be established independently by the harness;
//! DNS names and acknowledgements alone cannot prove resource ownership.

use dima_rust::utils::siteanalytics::{
    SITE_ANALYTICS_KEY, authorized_accounts_pipeline, legacy_analytics_field, profile_cache_key,
    resolve_analytics_field,
};
use mongodb::bson::doc;

#[test]
fn source_counter_aliases_and_profile_key() {
    assert_eq!(SITE_ANALYTICS_KEY, "site:analytics:channels");
    for (input, resolved, legacy) in [
        ("registered", "registered_users", Some("registered")),
        ("live", "live_users", Some("live")),
        ("active", "authorized_accounts", Some("active")),
        ("total_messages", "total_messages", None),
        ("other", "other", None),
    ] {
        assert_eq!(resolve_analytics_field(input), resolved);
        assert_eq!(legacy_analytics_field(resolved), legacy);
    }
    assert_eq!(profile_cache_key("42"), "site:analytics:profile:42");
}

#[test]
fn authorization_count_pipeline_matches_source() {
    assert_eq!(
        authorized_accounts_pipeline(),
        vec![
            doc! {"$unwind": "$accounts"},
            doc! {"$match": {"accounts.actived": true}},
            doc! {"$count": "count"},
        ]
    );
}

#[test]
fn configuration_floor_and_default() {
    use dima_rust::utils::siteanalytics::{
        LIVE_CHANNELS_REFRESH_MS, PROFILE_CACHE_TTL_SECONDS, configured_floor,
    };
    assert_eq!(configured_floor(None, 60, 30), 60);
    assert_eq!(configured_floor(Some("10"), 60, 30), 30);
    assert_eq!(configured_floor(Some("-1"), 60, 30), 30);
    assert_eq!(configured_floor(Some(" "), 60, 30), 30);
    assert_eq!(configured_floor(Some("120"), 60, 30), 120);
    assert_eq!(
        configured_floor(Some("100"), 60_000, LIVE_CHANNELS_REFRESH_MS * 2),
        30_000
    );
    assert_eq!(PROFILE_CACHE_TTL_SECONDS, 86_400);
}

#[test]
fn normalizes_live_channels_and_snapshot_field_order() {
    use dima_rust::utils::siteanalytics::{SiteAnalyticsSnapshot, normalize_live_channel};
    let channel = normalize_live_channel(&serde_json::json!({"channelID": "42", "viewers": "-3", "botPlatforms": ["TWITCH", "other", "kick"], "planTier": "gold"})).unwrap();
    assert_eq!(
        serde_json::to_string(&channel).unwrap(),
        r#"{"channelID":"42","channel":"42","streamId":"","title":"","gameName":"","viewers":0,"profileImageUrl":"","startedAt":"","fetchedAt":"","botPlatforms":["twitch","kick"],"planTier":"free"}"#
    );
    assert!(normalize_live_channel(&serde_json::json!({})).is_none());
    let snapshot = SiteAnalyticsSnapshot {
        registered_users: 1,
        live_users: 0,
        total_live_viewers: 0,
        authorized_accounts: 2,
        total_messages: 3,
        total_commands: 4,
        live_channels: vec![],
    };
    assert_eq!(
        serde_json::to_string(&snapshot).unwrap(),
        r#"{"registeredUsers":1,"liveUsers":0,"totalLiveViewers":0,"authorizedAccounts":2,"totalMessages":3,"totalCommands":4,"liveChannels":[]}"#
    );
}

#[test]
fn event_schema_contract_and_builtin_types() {
    use dima_rust::{
        schemas::event,
        utils::chat_event_catalog::{get_builtin_chat_event, with_builtin_chat_events},
    };
    let schema = event::schema();
    assert_eq!(schema.model, "Event");
    assert_eq!(schema.collection, "events");
    assert_eq!(
        schema
            .fields
            .iter()
            .map(|field| field.name)
            .collect::<Vec<_>>(),
        vec![
            "name",
            "type",
            "version",
            "condition",
            "icon",
            "color",
            "textColor",
            "releaseStage",
            "enabled",
            "plan_tier",
            "description",
            "config",
            "tierLimits",
            "createdAt",
            "updatedAt"
        ]
    );
    assert!(schema.indexes.is_empty());
    let all = with_builtin_chat_events(&[]);
    let types: Vec<_> = all
        .iter()
        .map(|entry| entry.get_str("type").unwrap())
        .collect();
    assert_eq!(
        types,
        vec![
            "channel.chat.notification",
            "channel.shoutout.receive",
            "channel.raid",
            "channel.raid.outgoing",
            "channel.subscribe",
            "channel.subscription.gift",
            "channel.subscription.message",
            "channel.subscription.end"
        ]
    );
    assert!(get_builtin_chat_event("unknown").is_none());
    assert_eq!(with_builtin_chat_events(&all).len(), all.len());
}

#[test]
fn site_route_alias_and_response_shapes() {
    use dima_rust::site_route::{
        CreatedBody, DataBody, ErrorBody, canonicalize_eventsub_type,
        get_equivalent_eventsub_types, validate_event_body,
    };
    use dima_rust::utils::eventsub::{CANONICAL_BITS_EVENT_TYPE, LEGACY_BITS_EVENT_TYPES};
    for legacy in LEGACY_BITS_EVENT_TYPES {
        assert_eq!(
            canonicalize_eventsub_type(legacy),
            CANONICAL_BITS_EVENT_TYPE
        );
    }
    assert_eq!(
        get_equivalent_eventsub_types(CANONICAL_BITS_EVENT_TYPE),
        vec![
            CANONICAL_BITS_EVENT_TYPE,
            LEGACY_BITS_EVENT_TYPES[0],
            LEGACY_BITS_EVENT_TYPES[1]
        ]
    );
    assert_eq!(get_equivalent_eventsub_types("other"), vec!["other"]);
    assert_eq!(
        validate_event_body(&serde_json::json!({})).as_deref(),
        Some("Missing required field: name")
    );
    assert_eq!(
        serde_json::to_string(&ErrorBody {
            error: true,
            message: "Event not found",
            status: 404
        })
        .unwrap(),
        r#"{"error":true,"message":"Event not found","status":404}"#
    );
    assert_eq!(
        serde_json::to_string(&DataBody {
            error: false,
            data: Vec::<String>::new()
        })
        .unwrap(),
        r#"{"error":false,"data":[]}"#
    );
    assert_eq!(
        serde_json::to_string(&CreatedBody {
            error: false,
            message: "Event created successfully",
            data: 1
        })
        .unwrap(),
        r#"{"error":false,"message":"Event created successfully","data":1}"#
    );
}

#[test]
fn event_schema_required_defaults_and_nested_types() {
    use dima_rust::schemas::{FieldDefault, FieldType, event};
    let schema = event::schema();
    let field = |name| {
        schema
            .fields
            .iter()
            .find(|field| field.name == name)
            .unwrap()
    };
    assert!(field("name").required && field("name").trim);
    assert!(matches!(&field("condition").kind, FieldType::Mixed));
    assert!(field("condition").required);
    assert!(matches!(
        &field("version").default,
        FieldDefault::String("1")
    ));
    assert!(matches!(
        &field("enabled").default,
        FieldDefault::Boolean(false)
    ));
    assert!(matches!(
        &field("plan_tier").default,
        FieldDefault::String("free")
    ));
    assert!(matches!(&field("createdAt").default, FieldDefault::Now));
    assert_eq!(schema.save_clock_field, Some("updatedAt"));
    match &field("config").kind {
        FieldType::Array(element) => match element.as_ref() {
            FieldType::Subdocument {
                fields,
                generate_id,
            } => {
                assert!(*generate_id);
                assert!(
                    fields
                        .iter()
                        .find(|field| field.name == "value")
                        .unwrap()
                        .required
                );
                let show_if = fields.iter().find(|field| field.name == "showIf").unwrap();
                assert!(matches!(
                    &show_if.kind,
                    FieldType::Subdocument {
                        generate_id: false,
                        ..
                    }
                ));
            }
            _ => panic!("config must contain subdocuments"),
        },
        _ => panic!("config must be an array"),
    }
}

#[test]
fn event_update_id_and_body_preparation() {
    use dima_rust::site_route::{parse_event_id, prepare_event_update};
    use dima_rust::utils::eventsub::{CANONICAL_BITS_EVENT_TYPE, LEGACY_BITS_EVENT_TYPES};
    for value in ["507f1f77bcf86cd799439011", "507F1F77BCF86CD799439011"] {
        assert!(parse_event_id(value).is_some());
    }
    for value in [
        "",
        "507f1f77bcf86cd79943901",
        "507f1f77bcf86cd79943901z",
        "abcdefghijkl",
    ] {
        assert!(parse_event_id(value).is_none());
    }
    let update = prepare_event_update(serde_json::json!({
        "_id": "507f1f77bcf86cd799439011", "__v": 3,
        "type": LEGACY_BITS_EVENT_TYPES[0], "name": "new name"
    }))
    .unwrap();
    assert_eq!(
        update,
        doc! {"$set": {"_id": mongodb::bson::oid::ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap(), "__v": 3, "name": "new name", "type": CANONICAL_BITS_EVENT_TYPE}}
    );
    let body = prepare_event_update(serde_json::json!({"type": 7})).unwrap();
    assert_eq!(body, doc! {"$set": {"type": "7"}});
    assert!(prepare_event_update(serde_json::json!({"updatedAt":"kept"})).is_err());
}

#[test]
fn event_update_response_envelopes_keep_source_order() {
    use dima_rust::site_route::{ErrorBody, updated_event_body};
    assert_eq!(
        updated_event_body(doc! {"name": "new name"}).unwrap(),
        r#"{"error":false,"message":"Event updated successfully","data":{"name":"new name"}}"#
    );
    for (message, status, expected) in [
        (
            "Invalid ID",
            400,
            r#"{"error":true,"message":"Invalid ID","status":400}"#,
        ),
        (
            "Event not found",
            404,
            r#"{"error":true,"message":"Event not found","status":404}"#,
        ),
        (
            "Internal server error",
            500,
            r#"{"error":true,"message":"Internal server error","status":500}"#,
        ),
    ] {
        assert_eq!(
            serde_json::to_string(&ErrorBody {
                error: true,
                message,
                status
            })
            .unwrap(),
            expected
        );
    }
}

#[test]
fn bson_projection_uses_node_reader_json_shapes() {
    use dima_rust::utils::bson_js_json::bson_js_json_string;
    use mongodb::bson::{Binary, Bson, Decimal128, spec::BinarySubtype};
    use std::str::FromStr;
    let binary = Bson::Binary(Binary {
        subtype: BinarySubtype::Generic,
        bytes: vec![1, 2, 3],
    });
    let decimal = Bson::Decimal128(Decimal128::from_str("1.25").unwrap());
    let input =
        Bson::Document(doc! {"bin": binary, "decimal": decimal, "nested": {"array": [true, "x"]}});
    assert_eq!(
        bson_js_json_string(&input).unwrap(),
        r#"{"bin":"AQID","decimal":{"$numberDecimal":"1.25"},"nested":{"array":[true,"x"]}}"#
    );
}

#[test]
fn failure_payloads_preserve_safe_context() {
    use dima_rust::{
        site_route::failure_log_payload,
        utils::siteanalytics::{SiteAnalyticsError, collector_failure_payload},
    };
    let payload = failure_log_payload(
        "database unavailable",
        Some("id1"),
        Some(&serde_json::json!({"name": "test"})),
        "2026-01-01T00:00:00.000Z",
    );
    assert_eq!(payload["error"], "database unavailable");
    assert!(payload.get("stack").is_none());
    assert_eq!(payload["id"], "id1");
    assert_eq!(payload["body"]["name"], "test");
    assert_eq!(payload["timestamp"], "2026-01-01T00:00:00.000Z");
    let collector = collector_failure_payload(
        "startSiteAnalytics",
        &SiteAnalyticsError::RuntimeDetail("fixture redis unavailable".into()),
    );
    assert_eq!(collector["function"], "startSiteAnalytics");
    assert_eq!(collector["phase"], "cache-warmup");
    assert_eq!(collector["error"], "fixture redis unavailable");
    assert!(collector.get("stack").is_none());
}

#[path = "support/api_auth_support.rs"]
mod api_auth_support;
#[path = "support/site_analytics_support.rs"]
mod site_analytics_support;

#[tokio::test]
async fn structured_error_is_delivered_to_capture_sinks() {
    let (logger, console, cache) = api_auth_support::capture_logger();
    let body = serde_json::json!({"name": "fixture"});
    dima_rust::site_route::emit_site_failure(
        &logger,
        "database unavailable",
        Some("id1"),
        Some(&body),
    )
    .await;
    let records = console.records();
    assert!(records.iter().any(|r| r["level"] == "error"
        && r["data"]["error"] == "database unavailable"
        && r["data"]["id"] == "id1"
        && r["data"]["body"] == body
        && r["data"].get("stack").is_none()));
    assert!(cache.sets.load(std::sync::atomic::Ordering::SeqCst) > 0);
}

#[tokio::test]
#[ignore = "requires independently isolated task-owned MongoDB and Redis fixtures"]
async fn disposable_store_routes_and_collector() {
    use dima_rust::{
        site_route::SiteRouteService,
        utils::siteanalytics::{SITE_ANALYTICS_KEY, SiteAnalyticsService, SiteAnalyticsValue},
    };
    use mongodb::bson::Document;
    use redis::AsyncCommands;
    use std::net::Ipv4Addr;

    // The native Twitch client can inherit proxy configuration. Refuse all
    // proxy environment settings so the loopback recorder cannot be bypassed.
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        assert!(
            std::env::var_os(key).is_none(),
            "fixture requires proxy environment to be cleared"
        );
    }
    let mongo_uri = std::env::var("SITE_ANALYTICS_TEST_MONGO_URI").expect("fixture Mongo URI");
    let redis_uri = std::env::var("SITE_ANALYTICS_TEST_REDIS_URI").expect("fixture Redis URI");
    let name = std::env::var("SITE_ANALYTICS_TEST_MONGO_DATABASE").expect("fixture database");
    let owner = std::env::var("SITE_ANALYTICS_TEST_OWNER").expect("fixture marker");
    assert!(
        owner.len() >= 16
            && owner
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    );
    assert!(
        name.starts_with("rust_site_analytics_fixture_")
            && name.len() > "rust_site_analytics_fixture_".len()
    );
    assert_eq!(
        std::env::var("SITE_ANALYTICS_TEST_MONGO_ACK").as_deref(),
        Ok("disposable")
    );
    assert_eq!(
        std::env::var("SITE_ANALYTICS_TEST_REDIS_ACK").as_deref(),
        Ok("disposable")
    );
    assert_eq!(mongo_uri, "mongodb://keyword-mongo:27017");
    assert_eq!(redis_uri, "redis://keyword-redis:6379/0");
    let mongo = mongodb::Client::with_uri_str(&mongo_uri)
        .await
        .expect("fixture client");
    let database = mongo.database(&name);
    let names = database
        .list_collection_names()
        .await
        .expect("fixture collection names");
    assert!(names.is_empty(), "task-owned database must start empty");
    database
        .collection::<Document>("fixture_identity")
        .insert_one(doc! {"_id": "owner", "token": &owner})
        .await
        .unwrap();
    let identity = database
        .collection::<Document>("fixture_identity")
        .find_one(doc! {"_id": "owner", "token": &owner})
        .await
        .expect("fixture identity");
    assert!(
        identity.is_some(),
        "Mongo fixture ownership marker mismatch"
    );
    let redis_client = redis::Client::open(redis_uri.as_str()).expect("fixture Redis client");
    let mut cache = redis_client
        .get_connection_manager()
        .await
        .expect("fixture Redis manager");
    let marker_exists: bool = cache.exists("site:analytics:fixture:owner").await.unwrap();
    assert!(!marker_exists);
    let _: () = cache
        .set("site:analytics:fixture:owner", &owner)
        .await
        .unwrap();
    let marker: Option<String> = cache
        .get("site:analytics:fixture:owner")
        .await
        .expect("fixture marker read");
    assert_eq!(
        marker.as_deref(),
        Some(owner.as_str()),
        "Redis fixture ownership marker mismatch"
    );
    let exists: bool = cache
        .exists(SITE_ANALYTICS_KEY)
        .await
        .expect("fixture hash check");
    assert!(!exists, "fixture analytics hash must be absent");

    let (logger, _, _) = api_auth_support::capture_logger();
    let redis_recorder =
        api_auth_support::RedisStub::start(api_auth_support::StubFailure::None, false).await;
    let recorded_collector = SiteAnalyticsService::new(
        redis_recorder.connection().await,
        database.clone(),
        logger.clone(),
    );
    recorded_collector
        .get_site_analytics(Some("registered"))
        .await
        .unwrap();
    recorded_collector.get_site_analytics(None).await.unwrap();
    assert_eq!(redis_recorder.command_names(), vec!["HGET", "HGETALL"]);
    let collector = SiteAnalyticsService::new(cache.clone(), database.clone(), logger.clone());
    collector
        .increment_site_analytics("registered", 3)
        .await
        .expect("increment");
    collector
        .decrement_site_analytics("registered", 1)
        .await
        .expect("decrement");
    assert_eq!(
        collector
            .get_site_analytics(Some("registered"))
            .await
            .unwrap(),
        SiteAnalyticsValue::Field(Some("2".into()))
    );
    let SiteAnalyticsValue::All(fields) = collector.get_site_analytics(None).await.unwrap() else {
        panic!("expected hash")
    };
    assert_eq!(fields.get("registered").map(String::as_str), Some("2"));
    assert_eq!(
        fields.get("registered_users").map(String::as_str),
        Some("2")
    );

    let app = api_auth_support::serve_app(
        SiteRouteService::new(cache.clone(), database.clone(), logger.clone()).router(),
        "fixture",
    )
    .await;
    assert_eq!(app.addr.ip(), std::net::IpAddr::V4(Ipv4Addr::LOCALHOST));
    let url = |path: &str| api_auth_support::app_url(app.addr, path);
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    // Replay every source-oracle route case against the native app. IDs and
    // dates are normalized because each database owns its generated values.
    let fixture = site_analytics_support::fixture();
    let mut normalized_fixture = fixture.clone();
    for case in normalized_fixture["cases"]
        .as_array_mut()
        .expect("oracle cases")
    {
        normalize_oracle_value(&mut case["expected"]["body"]);
    }
    let mut replay_id: Option<String> = None;
    for case in fixture["cases"].as_array().expect("oracle cases") {
        let name = case["name"].as_str().unwrap();
        let method = case["request"]["method"].as_str().unwrap();
        let mut path = case["request"]["path"].as_str().unwrap().to_owned();
        if matches!(name, "patch" | "patch-malformed") {
            path = format!("/events/{}", replay_id.as_ref().expect("created replay id"));
        }
        let mut request = http.request(method.parse::<reqwest::Method>().unwrap(), url(&path));
        if let Some(raw) = case["request"]["rawBody"].as_str() {
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(raw.to_owned());
        } else if method == "POST" || method == "PATCH" {
            request = request.json(&case["request"]["body"]);
        }
        let response = request.send().await.expect("native replay response");
        let status = response.status().as_u16();
        let mut actual: serde_json::Value = response.json().await.expect("native JSON response");
        if name == "create" {
            replay_id = actual["data"]["_id"].as_str().map(str::to_owned);
        }
        if name == "patch-malformed" {
            assert_eq!(actual["message"], "Invalid JSON body");
            // Express default handler returns HTML; the oracle records only its status.
            site_analytics_support::assert_case(
                &normalized_fixture,
                name,
                status,
                &serde_json::Value::Null,
            );
        } else {
            normalize_oracle_value(&mut actual);
            site_analytics_support::assert_case(&normalized_fixture, name, status, &actual);
        }
    }
    let replay_id =
        mongodb::bson::oid::ObjectId::parse_str(replay_id.expect("source replay ID")).unwrap();
    database
        .collection::<Document>("events")
        .delete_one(doc! {"_id": replay_id})
        .await
        .unwrap();
    let input = serde_json::json!({"name":"Fixture","type":"fixture.event","version":"1","condition":{"broadcaster_user_id":"user"},"icon":"Star","color":"#fff","textColor":"#000","plan_tier":"free","description":{"EN":"English","ES":"Español"},"config":[{"id":"message","label":{"EN":"Message","ES":"Mensaje"},"type":"text","value":"hi"}]});
    let root = http.get(url("/")).send().await.unwrap();
    assert_eq!(root.status().as_u16(), 200);
    assert_eq!(
        root.json::<serde_json::Value>().await.unwrap(),
        serde_json::json!({})
    );
    let created = http.post(url("/events")).json(&input).send().await.unwrap();
    assert_eq!(created.status().as_u16(), 201);
    let created: serde_json::Value = created.json().await.unwrap();
    assert_eq!(created["error"], false);
    assert_eq!(created["message"], "Event created successfully");
    let id = created["data"]["_id"]
        .as_str()
        .expect("created id")
        .to_owned();
    let duplicate = http.post(url("/events")).json(&input).send().await.unwrap();
    assert_eq!(duplicate.status().as_u16(), 409);
    assert_eq!(
        duplicate.json::<serde_json::Value>().await.unwrap()["message"],
        "Event with type 'fixture.event' already exists"
    );
    let missing = http
        .post(url("/events"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status().as_u16(), 400);
    assert_eq!(
        missing.json::<serde_json::Value>().await.unwrap()["message"],
        "Missing required field: name"
    );
    let list = http.get(url("/events")).send().await.unwrap();
    assert_eq!(list.status().as_u16(), 200);
    assert_eq!(
        list.json::<serde_json::Value>().await.unwrap()["error"],
        false
    );
    let found = http.get(url("/events/fixture.event")).send().await.unwrap();
    assert_eq!(found.status().as_u16(), 200);
    assert_eq!(
        found.json::<serde_json::Value>().await.unwrap()["data"]["type"],
        "fixture.event"
    );
    let not_found = http
        .get(url("/events/fixture.no-such-event"))
        .send()
        .await
        .unwrap();
    assert_eq!(not_found.status().as_u16(), 404);
    assert_eq!(
        not_found.json::<serde_json::Value>().await.unwrap(),
        serde_json::json!({"error": true, "message": "Event not found", "status": 404})
    );
    let patched = http
        .patch(url(&format!("/events/{id}")))
        .json(&serde_json::json!({"name":"Updated"}))
        .send()
        .await
        .unwrap();
    assert_eq!(patched.status().as_u16(), 200);
    assert_eq!(
        patched.json::<serde_json::Value>().await.unwrap()["message"],
        "Event updated successfully"
    );
    let invalid = http
        .patch(url("/events/not-an-id"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status().as_u16(), 400);
    assert_eq!(
        invalid.json::<serde_json::Value>().await.unwrap(),
        serde_json::json!({"error": true, "message": "Invalid ID", "status": 400})
    );
    let absent = http
        .patch(url("/events/000000000000000000000000"))
        .json(&serde_json::json!({"name":"none"}))
        .send()
        .await
        .unwrap();
    assert_eq!(absent.status().as_u16(), 404);
    assert_eq!(
        absent.json::<serde_json::Value>().await.unwrap(),
        serde_json::json!({"error": true, "message": "Event not found", "status": 404})
    );
    let malformed = http
        .post(url("/events"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body("{")
        .send()
        .await
        .unwrap();
    assert_eq!(malformed.status().as_u16(), 400);
    assert_eq!(
        malformed.json::<serde_json::Value>().await.unwrap()["message"],
        "Invalid JSON body"
    );

    // Authentication is checked with task-owned cached identity and a loopback
    // provider; the warm activity marker prevents a write to unrelated users.
    let provider = api_auth_support::Provider::start(vec![]).await;
    let token = format!("site-fixture-{owner}");
    let user_id = format!("site-fixture-user-{owner}");
    let token_key = format!("token:{token}");
    let touch_key = format!("twitch:{user_id}:last_app_activity_touch");
    let existing: bool = cache.exists(&token_key).await.unwrap();
    assert!(!existing);
    let existing: bool = cache.exists(&touch_key).await.unwrap();
    assert!(!existing);
    let _: i64 = redis::cmd("HSET")
        .arg(&token_key)
        .arg("id")
        .arg(&user_id)
        .arg("login")
        .arg("fixture")
        .arg("display_name")
        .arg("Fixture")
        .arg("profile_image_url")
        .arg("")
        .query_async(&mut cache)
        .await
        .unwrap();
    let _: () = cache.set(&touch_key, "1").await.unwrap();
    let config =
        dima_rust::api_auth::AuthConfig::new(provider.validate_url(), provider.users_url())
            .with_client_id("fixture");
    let auth = dima_rust::api_auth::AuthService::new(
        config,
        http.clone(),
        cache.clone(),
        dima_rust::schemas::users::schema().native_collection(&database),
        Some(logger.clone()),
    );
    let auth = auth.expect("fixture auth");
    let protected = api_auth_support::serve_app(
        SiteRouteService::new(cache.clone(), database.clone(), logger.clone())
            .protected_router(&auth),
        "fixture",
    )
    .await;
    let (status, denied) = api_auth_support::get_with_token(
        &http,
        api_auth_support::app_url(protected.addr, "/").as_str(),
        &[],
    )
    .await;
    assert_eq!(status, 401);
    assert_eq!(
        denied,
        serde_json::json!({"error": true, "message": "No token provided", "status": 401, "type": "no_token"})
    );
    let authorization = format!("Bearer {token}");
    let (status, body) = api_auth_support::get_with_token(
        &http,
        api_auth_support::app_url(protected.addr, "/").as_str(),
        &[("authorization", &authorization)],
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body, serde_json::json!({}));

    // Board refresh uses a fixed app token and a recorder bound to loopback.
    let live_key = dima_rust::utils::siteanalytics::SITE_ANALYTICS_LIVE_CHANNELS_KEY;
    let profile_key = dima_rust::utils::siteanalytics::profile_cache_key("1001");
    let existing: bool = cache.exists(live_key).await.unwrap();
    assert!(!existing);
    let existing: bool = cache.exists(&profile_key).await.unwrap();
    assert!(!existing);
    database.collection::<Document>("users").insert_one(doc! {"_id": "site-fixture-user", "accounts": [{"type": "twitch", "id": "1001", "name": "fixture", "chat_enabled": true}], "plan_tier": "free"}).await.unwrap();
    let recorder = site_analytics_support::HelixRecorder::start(vec![
        site_analytics_support::HelixReply {status:200,body:serde_json::json!({"access_token":"fixture-app-token","expires_in":3600,"token_type":"bearer"})},
        site_analytics_support::HelixReply { status: 200, body: serde_json::json!({"data":[{"id":"stream1","user_id":"1001","user_login":"fixture","user_name":"Fixture","title":"Live","game_name":"Game","viewer_count":7,"started_at":"2026-01-01T00:00:00Z"}]}) },
        site_analytics_support::HelixReply { status: 200, body: serde_json::json!({"data":[{"id":"1001","profile_image_url":"https://example.invalid/profile.png"}]}) },
    ]).await;
    let endpoints = dima_rust::utils::twitch::TwitchEndpoints::new(
        &recorder.base_url(),
        &format!("http://{}/oauth/", recorder.addr),
    )
    .unwrap();
    let twitch = dima_rust::utils::twitch::TwitchClient::new(
        "fixture-client",
        endpoints.clone(),
        Some(std::time::Duration::from_secs(3)),
    )
    .unwrap();
    use dima_rust::utils::{
        credential_crypto::CredentialCipher,
        twitch::{TwitchCredentials, TwitchOAuthClient},
        twitch_tokens::{
            MongoCredentialStore, RedisTokenCache, SystemTokenClock, TwitchTokenStorage,
        },
    };
    use std::{sync::Arc, time::Duration};
    let tokens = Arc::new(TwitchTokenStorage::new(
        Arc::new(MongoCredentialStore::new(&database)),
        Arc::new(RedisTokenCache::new(cache.clone())),
        Arc::new(
            TwitchOAuthClient::new(
                TwitchCredentials::new("fixture-client", "fixture-secret").unwrap(),
                endpoints.clone(),
                Some(Duration::from_secs(3)),
            )
            .unwrap(),
        ),
        Arc::new(SystemTokenClock::default()),
        CredentialCipher::new("fixture-only-cipher-secret").unwrap(),
    ));
    let board = collector
        .refresh_live_channels_board(&twitch, tokens.as_ref())
        .await
        .unwrap();
    assert_eq!(board.len(), 1);
    assert_eq!(board[0].channel_id, "1001");
    assert_eq!(board[0].viewers, 7);
    assert_eq!(recorder.requests().len(), 3);
    assert_eq!(recorder.requests()[0], "/oauth/token");
    assert!(
        recorder.requests()[1].contains("type=live")
            && recorder.requests()[1].contains("user_id=1001")
    );
    assert!(recorder.requests()[2].contains("id=1001"));
    let cached_app: String = cache.get("app:twitch:token").await.unwrap();
    assert_eq!(cached_app, "fixture-app-token");
    let ttl: i64 = cache.ttl("app:twitch:token").await.unwrap();
    assert!((1..=3600).contains(&ttl));
    let cached_board = collector.get_live_channels_board(true, None).await.unwrap();
    assert_eq!(cached_board, board);
    let cached_profile: String = cache.get(&profile_key).await.unwrap();
    assert_eq!(cached_profile, "https://example.invalid/profile.png");
    assert!(
        collector
            .get_cached_live_status("1001")
            .await
            .unwrap()
            .is_live
    );
    assert!(
        !collector
            .get_cached_live_status("missing")
            .await
            .unwrap()
            .is_live
    );
    let snapshot = collector.refresh_site_analytics_snapshot().await.unwrap();
    assert_eq!(snapshot.registered_users, 1);
    assert_eq!(snapshot.live_users, 1);
    assert_eq!(snapshot.total_live_viewers, 7);
    collector.persist_site_analytics_snapshot().await.unwrap();
    let stored = collector
        .site_analytics_collection()
        .find_one(doc! {"singletonKey":"global"})
        .await
        .unwrap()
        .unwrap();
    assert!(stored.get("created_at").is_some() && stored.get("updated_at").is_some());
    assert_eq!(
        mongodb::bson::deserialize_from_document::<
            dima_rust::utils::siteanalytics::SiteAnalyticsSnapshot,
        >(stored)
        .unwrap(),
        snapshot
    );
    // All protected methods reject an absent bearer before performing writes.
    for (method, path) in [
        (reqwest::Method::GET, "/events"),
        (reqwest::Method::GET, "/events/fixture.event"),
        (reqwest::Method::POST, "/events"),
        (reqwest::Method::PATCH, "/events/000000000000000000000000"),
    ] {
        let response = http
            .request(method, api_auth_support::app_url(protected.addr, path))
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 401);
    }
    assert!(
        provider.requests().is_empty(),
        "cached bearer uses no provider request"
    );
    // Ready Helix ID batches progress without pacing; 101 IDs require two reads.
    let extra_users:Vec<Document>=(0..100).map(|i|doc! {"_id":format!("batch-{i}"),"accounts":[{"type":"twitch","id":format!("batch-{i}")}]}).collect();
    database
        .collection::<Document>("users")
        .insert_many(extra_users)
        .await
        .unwrap();
    let batches = site_analytics_support::HelixRecorder::start(vec![
        site_analytics_support::HelixReply {
            status: 200,
            body: serde_json::json!({"data":[]}),
        },
        site_analytics_support::HelixReply {
            status: 200,
            body: serde_json::json!({"data":[]}),
        },
    ])
    .await;
    let client = dima_rust::utils::twitch::TwitchClient::new(
        "fixture-client",
        dima_rust::utils::twitch::TwitchEndpoints::new(
            &batches.base_url(),
            &format!("http://{}/oauth/", batches.addr),
        )
        .unwrap(),
        Some(Duration::from_secs(3)),
    )
    .unwrap();
    assert!(
        collector
            .refresh_live_channels_board(&client, tokens.as_ref())
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(batches.requests().len(), 2);
    assert_eq!(
        batches
            .requests()
            .iter()
            .map(|r| r.matches("user_id=").count())
            .collect::<Vec<_>>(),
        vec![100, 1]
    );
    database
        .collection::<Document>("users")
        .delete_many(doc! {"_id":{"$regex":"^batch-"}})
        .await
        .unwrap();
    // Failed read batches are skipped once; no write or uncertain request replay.
    let failed =
        site_analytics_support::HelixRecorder::start(vec![site_analytics_support::HelixReply {
            status: 503,
            body: serde_json::json!({}),
        }])
        .await;
    let client = dima_rust::utils::twitch::TwitchClient::new(
        "fixture-client",
        dima_rust::utils::twitch::TwitchEndpoints::new(
            &failed.base_url(),
            &format!("http://{}/oauth/", failed.addr),
        )
        .unwrap(),
        Some(Duration::from_secs(3)),
    )
    .unwrap();
    assert!(
        collector
            .refresh_live_channels_board(&client, tokens.as_ref())
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(failed.requests().len(), 1);
    let _: i64 = cache.del(SITE_ANALYTICS_KEY).await.unwrap();
    let _: () = cache.set(SITE_ANALYTICS_KEY, "wrong-type").await.unwrap();
    assert!(
        collector
            .start_site_analytics(client, tokens.clone())
            .await
            .is_err()
    );
    let unchanged: String = cache.get(SITE_ANALYTICS_KEY).await.unwrap();
    assert_eq!(unchanged, "wrong-type");
    let _: i64 = cache.del(SITE_ANALYTICS_KEY).await.unwrap();

    database
        .collection::<Document>("users")
        .delete_one(doc! {"_id": "site-fixture-user"})
        .await
        .unwrap();
    let _: i64 = redis::cmd("DEL")
        .arg(&token_key)
        .arg(&touch_key)
        .arg(live_key)
        .arg(&profile_key)
        .query_async(&mut cache)
        .await
        .unwrap();

    // Warm startup restores the persisted counters and starts native refresh
    // loops. No accounts remain, so startup cannot contact a real provider.
    collector
        .site_analytics_collection()
        .update_one(
            doc! {"singletonKey":"global"},
            doc! {"$set":{"totalMessages":42}},
        )
        .await
        .unwrap();
    let idle = site_analytics_support::HelixRecorder::start(vec![]).await;
    let idle_client = dima_rust::utils::twitch::TwitchClient::new(
        "fixture-client",
        dima_rust::utils::twitch::TwitchEndpoints::new(
            &idle.base_url(),
            &format!("http://{}/oauth/", idle.addr),
        )
        .unwrap(),
        Some(Duration::from_secs(3)),
    )
    .unwrap();
    assert!(
        collector
            .start_site_analytics(idle_client, tokens)
            .await
            .unwrap()
    );
    let started: String = cache
        .get(dima_rust::utils::siteanalytics::SITE_ANALYTICS_START_KEY)
        .await
        .unwrap();
    assert_eq!(started, "1");
    assert_eq!(
        collector
            .get_site_analytics_snapshot()
            .await
            .unwrap()
            .total_messages,
        42
    );
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(idle.requests().is_empty(), "idle startup has no Helix work");
    collector.stop_site_analytics().await;
    collector.stop_site_analytics().await; // terminal stop is idempotent
    // Every operator case uses the actual HTTP adapter and private Mongo store,
    // independently seeded, including failures and strict-empty reads.
    let events = database.collection::<Document>("events");
    for case in fixture["operatorCases"].as_array().unwrap() {
        events.delete_many(doc! {}).await.unwrap();
        let seed = site_analytics_support::seed_document(&case["seed"]);
        events.insert_one(seed).await.unwrap();
        let response = http
            .patch(url("/events/507f1f77bcf86cd799439011"))
            .json(&case["input"])
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status().as_u16() as u64,
            case["expected"]["status"].as_u64().unwrap(),
            "{} status",
            case["name"]
        );
        assert_eq!(
            response.headers()["content-type"]
                .to_str()
                .unwrap()
                .split(';')
                .next()
                .unwrap(),
            case["expected"]["contentType"].as_str().unwrap(),
            "{} header",
            case["name"]
        );
        let mut body: serde_json::Value = response.json().await.unwrap();
        site_analytics_support::normalize_operator_value(&mut body, case);
        assert_eq!(body, case["expected"]["body"], "{} HTTP body", case["name"]);
        let stored=events.find_one(doc! {"_id":mongodb::bson::oid::ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap()}).await.unwrap().unwrap();
        let mut stored: serde_json::Value = serde_json::from_str(
            &dima_rust::utils::bson_js_json::bson_js_json_string(&mongodb::bson::Bson::Document(
                stored,
            ))
            .unwrap(),
        )
        .unwrap();
        site_analytics_support::normalize_operator_value(&mut stored, case);
        assert_eq!(
            stored, case["expected"]["persisted"],
            "{} persisted readback",
            case["name"]
        );
    }
    events.delete_many(doc! {}).await.unwrap();
    let object_id = mongodb::bson::oid::ObjectId::parse_str(id).unwrap();
    database
        .collection::<Document>("events")
        .delete_one(doc! {"_id": object_id})
        .await
        .expect("owned event cleanup");
    let _: i64 = cache
        .del(SITE_ANALYTICS_KEY)
        .await
        .expect("owned hash cleanup");
}

#[test]
#[ignore = "requires the external source oracle fixture"]
fn source_oracle_lists_the_expected_cases() {
    let fixture = site_analytics_support::fixture();
    assert_eq!(
        site_analytics_support::fixture_case_names(&fixture),
        vec![
            "root",
            "create",
            "duplicate",
            "missing",
            "bad-tier",
            "bad-label",
            "list",
            "get",
            "get-missing",
            "patch",
            "patch-invalid",
            "patch-missing",
            "patch-malformed",
        ]
    );
    let root = site_analytics_support::fixture_case(&fixture, "root");
    assert_eq!(root["status"], 200);
    site_analytics_support::assert_case(&fixture, "root", 200, &serde_json::json!({}));
}

/// Mongo assigns IDs and timestamps independently in each fixture run.
fn normalize_oracle_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(text) => {
            if text.len() == 24 && text.bytes().all(|b| b.is_ascii_hexdigit()) {
                *text = "<object-id>".into();
            } else if text.len() >= 20
                && text.as_bytes().get(10) == Some(&b'T')
                && text.ends_with('Z')
            {
                *text = "<date>".into();
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                normalize_oracle_value(value);
            }
        }
        serde_json::Value::Object(values) => {
            for value in values.values_mut() {
                normalize_oracle_value(value);
            }
        }
        _ => {}
    }
}

#[test]
#[ignore = "requires the external source oracle fixture"]
fn source_mongoose_constructor_and_update_oracle() {
    use dima_rust::{
        schemas::event, site_route::prepare_event_update, utils::bson_js_json::bson_js_json_string,
    };
    use mongodb::bson::{Bson, DateTime, Document};
    let fixture = site_analytics_support::fixture();
    assert_eq!(fixture["schemaCases"].as_array().unwrap().len(), 9);
    for case in fixture["schemaCases"].as_array().unwrap() {
        let input: Document = mongodb::bson::serialize_to_document(&case["input"]).unwrap();
        let result = event::schema().construct(&input, DateTime::now());
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "schema {}",
            case["name"]
        );
        if let Ok(document) = result {
            let mut actual: serde_json::Value =
                serde_json::from_str(&bson_js_json_string(&Bson::Document(document)).unwrap())
                    .unwrap();
            normalize_oracle_value(&mut actual);
            assert_eq!(actual, case["expected"], "schema {}", case["name"]);
        }
    }
    assert_eq!(
        fixture["patchCases"].as_array().unwrap().len(),
        site_analytics_support::PATCH_CASES.len()
    );
    for case in fixture["patchCases"].as_array().unwrap() {
        let result = prepare_event_update(case["input"].clone());
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "patch {}",
            case["name"]
        );
        if let Ok(document) = result {
            let mut actual: serde_json::Value =
                serde_json::from_str(&bson_js_json_string(&Bson::Document(document)).unwrap())
                    .unwrap();
            normalize_oracle_value(&mut actual);
            assert_eq!(actual, case["expected"], "patch {}", case["name"]);
        }
    }
}

#[tokio::test]
async fn fixed_future_deadlines_skip_missed_ticks_and_stop_orderly() {
    use dima_rust::utils::siteanalytics::{analytics_interval, wait_for_analytics_tick};
    use std::time::Duration;
    use tokio::time::{sleep, timeout};
    let (stop, mut stopped) = tokio::sync::watch::channel(false);
    let mut live = analytics_interval(Duration::from_millis(100), true);
    assert!(
        timeout(
            Duration::from_millis(50),
            wait_for_analytics_tick(&mut live, &mut stopped)
        )
        .await
        .unwrap()
    );
    // Slow sequential refresh crosses two fixed deadlines. Due work starts
    // immediately on completion; it does not incur another full 100ms delay.
    sleep(Duration::from_millis(250)).await;
    assert!(
        timeout(
            Duration::from_millis(30),
            wait_for_analytics_tick(&mut live, &mut stopped)
        )
        .await
        .unwrap()
    );
    assert!(
        timeout(
            Duration::from_millis(10),
            wait_for_analytics_tick(&mut live, &mut stopped)
        )
        .await
        .is_err(),
        "no burst catchup"
    );
    let mut future = analytics_interval(Duration::from_millis(100), false);
    assert!(
        timeout(
            Duration::from_millis(30),
            wait_for_analytics_tick(&mut future, &mut stopped)
        )
        .await
        .is_err(),
        "first persistence is future due"
    );
    assert!(
        timeout(
            Duration::from_millis(120),
            wait_for_analytics_tick(&mut future, &mut stopped)
        )
        .await
        .unwrap()
    );
    stop.send_replace(true);
    assert!(!wait_for_analytics_tick(&mut live, &mut stopped).await);
    assert!(!wait_for_analytics_tick(&mut future, &mut stopped).await);
}

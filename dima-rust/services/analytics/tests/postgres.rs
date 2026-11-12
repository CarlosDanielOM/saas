#![forbid(unsafe_code)]
use dima_analytics::{Config, build, store::Store};
use dima_core::{Clock, Shutdown, SystemClock};
use futures_util::FutureExt;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::{panic::AssertUnwindSafe, sync::Arc};
#[tokio::test]
async fn real_postgres_persistence_replay_permissions_and_redis_ingestion() -> anyhow::Result<()> {
    let uri = match std::env::var("DIMA_TEST_POSTGRES_URI") {
        Ok(uri) => uri,
        Err(e) => {
            if std::env::var_os("DIMA_TEST_REQUIRE_STORES").is_some() {
                return Err(e.into());
            }
            return Ok(());
        }
    };
    let admin = Store::connect(&uri).await?;
    let name = format!("dima_test_analytics_{}", uuid::Uuid::new_v4().simple());
    let mongo_uri = std::env::var("DIMA_TEST_MONGO_URI")
        .unwrap_or_else(|_| "mongodb://127.0.0.1:27017/?directConnection=true".into());
    let mut mongo_url = url::Url::parse(&mongo_uri)?;
    mongo_url.set_path(&name);
    let mongo_uri = mongo_url.to_string();
    let fixture_mongo = dima_store::mongo::MongoStore::connect(
        &dima_store::mongo::MongoConfig::new(&mongo_uri),
        None,
    )
    .await?;
    admin
        .execute(&format!("CREATE DATABASE {name}"), &[])
        .await?;
    let mut url = url::Url::parse(&uri)?;
    url.set_path(&name);
    let database_url = url.to_string();
    let redis_url = format!(
        "redis://{}/4",
        std::env::var("DIMA_TEST_DRAGONFLY").unwrap_or_else(|_| "127.0.0.1:6379".into())
    );
    let token = format!("analytics-{}", uuid::Uuid::new_v4().simple());
    let result = AssertUnwindSafe(async {
        let stop = Shutdown::new();
        let app = build(
            Config {
                database_url: database_url.clone(),
                key_prefix: format!("{name}:"),
                redis_url,
                owner_id: "1".into(),
                mongo_url: Some(mongo_uri.clone()),
                qdrant_url: None,
                qdrant_key: None,
                hoststats_url: None,
                collectors: false,
            },
            Arc::new(SystemClock),
            stop.clone(),
        )
        .await?;
        let s = app.state();
        let _: i64 = s
            .redis
            .query(
                redis::cmd("HSET")
                    .arg(s.key(&format!("token:{token}")))
                    .arg("id")
                    .arg("1")
                    .arg("login")
                    .arg("owner"),
            )
            .await?;
        let checks = AssertUnwindSafe(async {
            fixture_mongo.documents("users").insert_one(bson::doc!{"accounts":[{"type":"twitch","id":"allowed","name":"mongo_streamer","access_token":"SECRET_TOKEN","email":"SECRET_EMAIL"}]}).await?;

            let now = SystemClock.now_ms();
            for fixture in [
                include_str!("../../../crates/telemetry/tests/fixtures/analytics/0-api.json"),
                include_str!("../../../crates/telemetry/tests/fixtures/analytics/1-cron.json"),
            ] {
                let mut b: Value = serde_json::from_str(fixture)?;
                b["id"] = json!(uuid::Uuid::new_v4().to_string());
                for key in ["metrics", "spans", "logs"] {
                    for row in b[key].as_array_mut().into_iter().flatten() {
                        row["at"] = json!(now);
                    }
                }
                assert!(s.store.ingest(&b, now).await?);
                assert!(!s.store.ingest(&b, now).await?);
            }
            exercise_queue_and_grants(&app, &token).await?;
            for path in [
                "/health",
                "/api/session",
                "/api/overview",
                "/api/resources",
                "/api/traces",
                "/api/logs",
                "/api/grants",
            ] {
                let r = app
                    .handle(
                        http::Request::builder()
                            .uri(path)
                            .header("authorization", format!("Bearer {token}"))
                            .body(dima_web::Body::empty())?,
                    )
                    .await;
                let status = r.status();
                let bytes = r.into_body().collect().await?.to_bytes();
                assert_eq!(status, 200, "{path}: {}", String::from_utf8_lossy(&bytes));
                let _: Value = serde_json::from_slice(&bytes)?;
            }
            for (path, status) in [
                ("/api/traces/invalid", 400),
                ("/api/traces/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 404),
                ("/api/overview?minutes=1", 400),
                ("/missing", 404),
            ] {
                let r = app
                    .handle(
                        http::Request::builder()
                            .uri(path)
                            .header("authorization", format!("Bearer {token}"))
                            .body(dima_web::Body::empty())?,
                    )
                    .await;
                assert_eq!(r.status(), status, "{path}");
            }
            let r = app
                .handle(
                    http::Request::builder()
                        .uri("/api/session")
                        .body(dima_web::Body::empty())?,
                )
                .await;
            assert_eq!(r.status(), 401);
            let tables = s
                .store
                .query(
                    "SELECT tablename FROM pg_tables WHERE schemaname='public'",
                    &[],
                )
                .await?;
            assert_eq!(tables.len(), 23);
            Ok::<_, anyhow::Error>(())
        })
        .catch_unwind()
        .await;
        let mut cursor = 0u64;
        loop {
            let (next, keys): (u64, Vec<String>) = s
                .redis
                .query(
                    redis::cmd("SCAN")
                        .arg(cursor)
                        .arg("MATCH")
                        .arg(format!("{name}:*"))
                        .arg("COUNT")
                        .arg(100),
                )
                .await?;
            for key in keys {
                let _: i64 = s.redis.query(redis::cmd("DEL").arg(key)).await?;
            }
            cursor = next;
            if cursor == 0 {
                break;
            }
        }
        stop.trigger();
        drop(app);
        match checks {
            Ok(result) => result,
            Err(p) => std::panic::resume_unwind(p),
        }
    })
    .catch_unwind()
    .await;
    admin
        .execute(&format!("DROP DATABASE {name} WITH (FORCE)"), &[])
        .await?;
    fixture_mongo.database().drop().await?;
    fixture_mongo.shutdown().await;
    assert!(
        admin
            .query("SELECT datname FROM pg_database WHERE datname=$1", &[&name])
            .await?
            .is_empty()
    );
    match result {
        Ok(result) => result,
        Err(p) => std::panic::resume_unwind(p),
    }
}
async fn call(
    app: &dima_web::App<dima_analytics::State>,
    token: &str,
    method: &str,
    path: &str,
    body: Value,
) -> anyhow::Result<(u16, Value)> {
    let r = app
        .handle(
            http::Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .header("content-length", body.to_string().len())
                .body(dima_web::Body::from(body.to_string()))?,
        )
        .await;
    let status = r.status().as_u16();
    Ok((
        status,
        serde_json::from_slice(&r.into_body().collect().await?.to_bytes())?,
    ))
}
async fn exercise_queue_and_grants(
    app: &dima_web::App<dima_analytics::State>,
    owner: &str,
) -> anyhow::Result<()> {
    let s = app.state();
    let now = SystemClock.now_ms();
    s.store.execute("INSERT INTO analytics_resources VALUES(now(),'host','docker_up',1),(now(),'host','cpu_pct',20),(now(),'container:test','cpu_pct',4)",&[]).await?;
    let infra = call(app, owner, "GET", "/api/resources?include=infra", json!({})).await?;
    assert_eq!(infra.0, 200);
    assert!(
        !infra.1["infrastructure"]["series"]
            .as_array()
            .is_none_or(Vec::is_empty)
    );
    let resources = call(app, owner, "GET", "/api/resources", json!({})).await?;
    assert!(resources.1["samples"].as_array().is_some_and(Vec::is_empty));
    dima_analytics::collectors::sample(s).await?;
    assert!(
        !s.store
            .query(
                "SELECT 1 FROM analytics_resources WHERE service='analytics'",
                &[]
            )
            .await?
            .is_empty()
    );

    let trace = "12345678901234567890123456789012";
    let b = json!({"version":1,"id":uuid::Uuid::new_v4().to_string(),"service":"queued","instance":"fixture","metrics":[{"at":now,"kind":"chat","name":"message","channel":"allowed","outcome":"ok","count":1,"sum":10,"max":10,"histogram":[0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0]}],"spans":[{"at":now,"traceId":trace,"spanId":"1234567890123456","parentId":null,"channel":"allowed","kind":"chat","name":"message","outcome":"ok","duration":10,"partial":false}],"logs":[{"at":now,"level":"error","name":"fixture","channel":"allowed","traceId":trace,"fields":{"code":"test"}}]});
    let raw = dima_text::to_js_json(&b);
    let _: i64 = s
        .redis
        .query(
            redis::cmd("LPUSH")
                .arg(s.key("observability:v1:inbox"))
                .arg(&raw),
        )
        .await?;
    s.drain().await?;
    assert_eq!(
        s.store
            .query(
                "SELECT count(*) FROM analytics_metrics WHERE service='queued'",
                &[]
            )
            .await?[0]
            .get::<_, i64>(0),
        3
    );
    let _: i64 = s
        .redis
        .query(
            redis::cmd("LPUSH")
                .arg(s.key("observability:v1:processing"))
                .arg(&raw),
        )
        .await?;
    s.drain().await?;
    assert_eq!(
        s.store
            .query(
                "SELECT count FROM analytics_metrics WHERE service='queued' AND resolution=10",
                &[]
            )
            .await?[0]
            .get::<_, i64>(0),
        1
    );
    let _: i64 = s
        .redis
        .query(
            redis::cmd("LPUSH")
                .arg(s.key("observability:v1:inbox"))
                .arg("{broken"),
        )
        .await?;
    s.drain().await?;
    assert_eq!(s.health.lock().await["invalidBatches"], 1);
    let mut bad = b.clone();
    bad["id"] = json!(uuid::Uuid::new_v4().to_string());
    if let Some(span) = bad["spans"][0].as_object_mut() {
        span.remove("partial");
    }
    assert!(s.store.ingest(&bad, now).await.is_err());
    assert!(
        s.store
            .query(
                "SELECT id FROM analytics_batches WHERE id=$1::text::uuid",
                &[&bad["id"].as_str()]
            )
            .await?
            .is_empty()
    );
    for (token, id) in [("viewer", "2"), ("investigator", "3"), ("stranger", "4")] {
        let _: i64 = s
            .redis
            .query(
                redis::cmd("HSET")
                    .arg(s.key(&format!("token:{token}")))
                    .arg("id")
                    .arg(id)
                    .arg("login")
                    .arg(token),
            )
            .await?;
    }
    for (id, role) in [("2", "viewer"), ("3", "investigator")] {
        assert_eq!(
            call(
                app,
                owner,
                "PUT",
                &format!("/api/grants/{id}"),
                json!({"role":role,"channels":["allowed"],"services":[],"expiresAt":null})
            )
            .await?
            .0,
            200
        );
    }
    for (path, token, status) in [
        ("/api/session", "stranger", 403),
        ("/api/resources", "viewer", 403),
        ("/api/traces", "viewer", 403),
        ("/api/logs", "viewer", 403),
        ("/api/grants", "viewer", 403),
        ("/api/traces/invalid", "investigator", 400),
    ] {
        assert_eq!(call(app, token, "GET", path, json!({})).await?.0, status);
    }
    let detail = call(
        app,
        "investigator",
        "GET",
        &format!("/api/traces/{trace}"),
        json!({}),
    )
    .await?;
    assert_eq!(detail.0, 200);
    assert_eq!(detail.1["partial"], true);
    assert_eq!(detail.1["channelNames"]["allowed"], "mongo_streamer");
    assert!(!detail.1.to_string().contains("SECRET"));
    assert_eq!(detail.1["spans"].as_array().map(Vec::len), Some(1));
    for body in [
        json!({}),
        json!({"role":"owner","channels":[],"services":[],"expiresAt":null}),
        json!({"role":"viewer","channels":["bad space"],"services":[],"expiresAt":null}),
        json!({"role":"viewer","channels":[],"services":[],"expiresAt":"2000-01-01"}),
    ] {
        assert_eq!(call(app, owner, "PUT", "/api/grants/9", body).await?.0, 400);
    }
    let overview = call(
        app,
        "viewer",
        "GET",
        "/api/overview?channel=forbidden",
        json!({}),
    )
    .await?;
    assert_eq!(overview.1["chat"]["count"], 0.);
    assert_eq!(
        call(app, owner, "DELETE", "/api/grants/2", json!({}))
            .await?
            .0,
        200
    );
    assert_eq!(
        call(app, "viewer", "GET", "/api/session", json!({}))
            .await?
            .0,
        403
    );
    Ok(())
}

#![cfg(feature = "email-auth-route")]
use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
use axum::{routing::get, Router};
use dima_rust::{email_auth_route::{EmailAuthRoute, INVALID}, utils::jwt::{ActivationTokenService, sign_activation_token_at}};
use mongodb::bson::{doc, oid::ObjectId, Bson};
#[path = "support/email_auth_route_support.rs"] mod support;
#[path = "support/api_auth_support.rs"] mod api_auth_support;
const SECRET: &[u8] = b"fixture-secret";
const ID: &str = "507f1f77bcf86cd799439011";
fn token() -> String { ActivationTokenService::new(SECRET).unwrap().sign(ID, "fallback").unwrap() }
fn service(name: &str, calls: Arc<AtomicUsize>) -> EmailAuthRoute {
    use mongodb::bson::Bson;
    let value = match name {
        "database-error" => Err(()), "missing-user" => Ok(None),
        "missing-twitch" => Ok(Some(doc! {"accounts": [{"type":"youtube"}]})),
        "active" => Ok(Some(doc! {"accounts": [{"type":"twitch", "actived":true}]})),
        "account-null" => Ok(Some(doc! {"accounts": [Bson::Null, {"type":"twitch"}]})),
        "accounts-object" => Ok(Some(doc! {"accounts": {"type":"twitch"}})),
        _ => { let name = match name {
            "fallback" => Bson::String("".into()), "name-number" => Bson::Int32(42), "name-zero" => Bson::Int32(0), "name-boolean" => Bson::Boolean(true),
            "name-array" => Bson::Array(vec![Bson::String("one".into()), Bson::Null, Bson::Int32(42), Bson::Array(vec!["x".into(),"y".into()])]),
            "name-object" => Bson::Document(doc! {"x":1}), "name-shadowed" => Bson::Document(doc! {"toString":"not callable"}), "name-object-id" => Bson::ObjectId(ObjectId::parse_str("507f1f77bcf86cd799439012").unwrap()),
            "name-empty-array" => Bson::Array(vec![]), "name-null" => Bson::Null, _ => Bson::String("A +/ñ".into()) };
            Ok(Some(doc! {"accounts": [{"type":"twitch", "actived":false, "name":name}]})) }
    };
    let (logger,_,_) = api_auth_support::capture_logger();
    EmailAuthRoute::with_users(ActivationTokenService::new(SECRET).unwrap(), Arc::new(support::Users {value,calls}), logger)
}
#[tokio::test]
async fn verifier_runs_before_lookup_and_rejects_expired_or_wrong_signature() {
    let calls = Arc::new(AtomicUsize::new(0)); let route = service("inactive", calls.clone());
    for value in ["".to_owned(), "bad".to_owned(), sign_activation_token_at(SECRET, ID, "fallback", 1).unwrap(), ActivationTokenService::new(b"wrong-secret").unwrap().sign(ID, "fallback").unwrap()] {
        assert_eq!(route.location(Some(&format!("token={value}")), None).await, INVALID);
    }
    assert_eq!(route.location(Some(&format!("token={}&token={}",token(),token())), None).await, INVALID);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(route.location(Some(&format!("token={}",token())), Some("localhost:9000")).await, "http://localhost:9000/auth/authorize?state=A+%2B%2F%C3%B1&action=activate");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn failure_logging_is_redacted_and_only_for_failures() {
    let (logger, console, _) = api_auth_support::capture_logger();
    let calls = Arc::new(AtomicUsize::new(0));
    let route = EmailAuthRoute::with_users(ActivationTokenService::new(SECRET).unwrap(), Arc::new(support::Users { value: Err(()), calls }), logger);
    assert_eq!(route.location(Some("token=bad"), None).await, INVALID);
    assert!(console.records().is_empty());
    let signed = token(); assert_eq!(route.location(Some(&format!("token={signed}")), None).await, INVALID);
    let records = console.records(); assert_eq!(records.len(),1); let text = records[0].to_string();
    assert!(text.contains("[EMAIL-AUTH] Error processing activation token:")); assert!(!text.contains(ID)); assert!(!text.contains(&signed)); assert!(!text.contains("fixture-secret"));
}
#[tokio::test]
#[ignore = "requires externally generated source fixture and loopback HTTP"]
async fn replay_actual_source_route() {
    let fixture = support::fixture(); let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    let names: Vec<_> = cases.iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["missing","empty","bad","expired","wrong-signature","duplicate","missing-user","missing-twitch","active","inactive","fallback","database-error","account-null","accounts-object","name-number","name-zero","name-boolean","name-array","name-object","name-shadowed","name-object-id","name-empty-array","name-null","localhost","host-escaped","host-case","accept-html","accept-html-high","accept-plain-high","accept-tie-order","accept-tie-wildcard","accept-zero","accept-specific-zero","accept-none","accept-repeat","accept-param","accept-quoted","head-html"]);
    for case in cases {
        let name = case["name"].as_str().unwrap(); let calls = Arc::new(AtomicUsize::new(0)); let route = service(name, calls.clone());
        let app = api_auth_support::serve_app(Router::new().nest("/email",route.router()), "fixture").await;
        let signed = token(); let expired = sign_activation_token_at(SECRET, ID, "fallback", 1).unwrap(); let wrong = ActivationTokenService::new(b"wrong-secret").unwrap().sign(ID, "fallback").unwrap();
        let request = &case["request"];
        let query = match request["query"].as_str().unwrap() { "missing" => String::new(), "empty" => "?token=".into(), "bad" => "?token=bad".into(), "expired" => format!("?token={expired}"), "wrong" => format!("?token={wrong}"), "duplicate" => format!("?token={signed}&token={signed}"), _ => format!("?token={signed}") };
        let method = reqwest::Method::from_bytes(request["method"].as_str().unwrap().as_bytes()).unwrap();
        let mut call = http.request(method,api_auth_support::app_url(app.addr,&format!("/email/auth{query}"))).header("host",request["host"].as_str().unwrap());
        if let Some(accept) = request["accept"].as_str() { call = call.header("accept",accept); }
        let response = call.send().await.unwrap();
        let expected = &case["expected"]; assert_eq!(response.status().as_u16(), expected["status"].as_u64().unwrap() as u16, "{name}");
        for (header, key) in [("location","location"),("content-type","contentType"),("content-length","contentLength"),("vary","vary")] {
            assert_eq!(response.headers().get(header).and_then(|v| v.to_str().ok()), expected[key].as_str(), "{name}: {header}");
        }
        assert_eq!(response.text().await.unwrap(), expected["body"].as_str().unwrap(), "{name}"); assert_eq!(calls.load(Ordering::SeqCst), expected["lookups"].as_u64().unwrap() as usize, "{name}");
    }
}
#[tokio::test]
#[ignore = "requires task-owned private Mongo database and loopback HTTP; never use production"]
async fn mongo_adapter_and_public_mount_next_to_protected_route() {
    let uri = std::env::var("DIMA_EMAIL_AUTH_TEST_MONGO_URI").expect("private Mongo URI");
    let db_name = std::env::var("DIMA_EMAIL_AUTH_TEST_DB").expect("unique task-owned database");
    assert!(db_name.starts_with("test_email_auth_") && db_name.len() > "test_email_auth_".len());
    let client = mongodb::Client::with_uri_str(uri).await.unwrap(); let db = client.database(&db_name); let users = dima_rust::schemas::users::schema().native_collection(&db);
    let id = ObjectId::new(); let mongo_token = ActivationTokenService::new(SECRET).unwrap().sign(&id.to_hex(), "fallback").unwrap(); users.insert_one(doc! {"_id":id,"accounts":[{"type":"youtube"},{"type":"twitch","name":"mongo name","actived":false}]}).await.unwrap();
    let (route_logger,_,_) = api_auth_support::capture_logger();
    let route = EmailAuthRoute::new(db.clone(), ActivationTokenService::new(SECRET).unwrap(), route_logger);
    assert_eq!(route.location(Some(&format!("token={}",mongo_token)),Some("api.test")).await,"https://api.test/auth/authorize?state=mongo+name&action=activate");
    users.update_one(doc! {"_id":id},doc! {"$set":{"accounts.1.name":["one", Bson::Null, 42]}}).await.unwrap();
    assert_eq!(route.location(Some(&format!("token={}",mongo_token)),Some("api.test")).await,"https://api.test/auth/authorize?state=one%2C%2C42&action=activate");
    users.update_one(doc! {"_id":id},doc! {"$set":{"accounts.1.actived":true}}).await.unwrap();
    assert_eq!(route.location(Some(&format!("token={}",mongo_token)),None).await,dima_rust::email_auth_route::ACTIVE);
    users.delete_one(doc! {"_id":id}).await.unwrap(); assert_eq!(route.location(Some(&format!("token={}",mongo_token)),None).await,INVALID);
    let stub = api_auth_support::RedisStub::start(api_auth_support::StubFailure::None, true).await;
    let provider = api_auth_support::Provider::start(vec![]).await; let (logger,_,_) = api_auth_support::capture_logger();
    let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    let auth = dima_rust::api_auth::AuthService::new(dima_rust::api_auth::AuthConfig::new(provider.validate_url(),provider.users_url()).with_client_id("fixture"),http.clone(),stub.connection().await,users,Some(logger)).unwrap();
    let protected = auth.protect(Router::new().route("/private",get(|| async { "private" })));
    let app = api_auth_support::serve_app(Router::new().nest("/email",route.router()).merge(protected),"fixture").await;
    let public = http.get(api_auth_support::app_url(app.addr,"/email/auth")).send().await.unwrap(); assert_eq!(public.status(),302); assert_eq!(public.headers()["location"],INVALID);
    let private = http.get(api_auth_support::app_url(app.addr,"/private")).send().await.unwrap(); assert_eq!(private.status(),401); assert_eq!(private.json::<serde_json::Value>().await.unwrap()["type"],"no_token");
}

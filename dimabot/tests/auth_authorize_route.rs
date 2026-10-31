#![cfg(feature = "auth-authorize-route")]
use axum::{http::StatusCode, middleware::{self, Next}, response::IntoResponse, routing::get, Router};
use dima_rust::auth_authorize_route::AuthorizeRoute;
#[path = "support/auth_authorize_route_support.rs"] mod support;

#[test]
fn location_covers_email_activation_and_absent_client_id() {
    let route = AuthorizeRoute::new(None);
    assert!(route.location(Some("state="), None).unwrap().is_none());
    let url = route.location(Some("state=A+%2B%2F%C3%B1&action=activate"), Some("localhost:9000")).unwrap().unwrap();
    let parsed = reqwest::Url::parse(&url).unwrap(); let pairs: std::collections::HashMap<_,_> = parsed.query_pairs().into_owned().collect();
    assert!(route.location(Some("state[toString]=x"), None).is_err());
    assert_eq!(pairs["client_id"], "undefined"); assert_eq!(pairs["state"], "A +/ñ"); assert_eq!(pairs["redirect_uri"], "http://localhost:9000/auth/register");
}
#[tokio::test]
#[ignore = "requires externally generated fixture and loopback HTTP"]
async fn replay_actual_source_and_public_mount() {
    let fixture = support::fixture();
    let names: Vec<_> = fixture["cases"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["missing","empty","activate","reauth","duplicate","duplicate-empty","empty-array","array-repeat","indexed","sparse","index-repeat","overflow","safe-max","two53","rounded-odd","two53-shift","u64-max","u64-rounded","above-u64","above-u64-merge","scientific","scientific-large","decimal-key","leading-zero","object","mixed","mixed-reverse","array-object","nested-array","nested-object","deep","proto","encoded-brackets","malformed-percent","bad-percent","invalid-utf8","malformed-key","equals-key","action-case","action-array","action-mixed","limit","localhost","host-case","html","none","head","shadow","nested-shadow"]);
    let protected = Router::new().route("/private",get(|| async { "private" })).layer(middleware::from_fn(|_req: axum::extract::Request, _next: Next| async { StatusCode::UNAUTHORIZED.into_response() }));
    let app = Router::new().nest("/auth", AuthorizeRoute::new(Some("fixture + id".into())).router()).merge(protected);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(); let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    assert_eq!(client.get(format!("http://{addr}/private")).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    for case in fixture["cases"].as_array().unwrap() {
        let req = &case["request"]; let name = case["name"].as_str().unwrap();
        let mut call = client.request(reqwest::Method::from_bytes(req["method"].as_str().unwrap().as_bytes()).unwrap(), format!("http://{addr}/auth/authorize{}",req["query"].as_str().unwrap())).header("host",req["host"].as_str().unwrap());
        if let Some(accept) = req["accept"].as_str() { call = call.header("accept",accept); }
        let response = call.send().await.unwrap(); let expected = &case["expected"];
        if expected["kind"] == "rejected" {
            assert_eq!(expected["errorName"], "TypeError", "{name}");
            assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR, "{name}: bounded native outcome");
            continue;
        }
        assert_eq!(expected["kind"], "response");
        assert_eq!(response.status().as_u16(),expected["status"].as_u64().unwrap() as u16,"{name}");
        for (header,key) in [("location","location"),("content-type","contentType"),("content-length","contentLength"),("vary","vary")] { assert_eq!(response.headers().get(header).and_then(|v| v.to_str().ok()),expected[key].as_str(),"{name}: {header}"); }
        assert_eq!(response.text().await.unwrap(),expected["body"].as_str().unwrap(),"{name}");
    }
    task.abort();
}

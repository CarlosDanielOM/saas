//! `{:?}` of every public type, loaded with marker secrets, shows none of them.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use bytes::Bytes;
use dima_core::{SecretString, Shutdown};
use dima_http::guard::{BoxFuture, GuardPolicy, GuardedClient};
use dima_http::testing::{MockResponse, MockServer};
use dima_http::{
    Credential, HeaderValue, HttpClient, Path, Provider, ProviderRegistry, Refresh, header,
};
use std::sync::Arc;

/// Every marker contains this, so one search finds any of them.
const MARK: &str = "MARKER";

fn assert_clean(what: &str, printed: &str) {
    assert!(
        !printed.contains(MARK),
        "{what} printed a secret: {printed}"
    );
}

#[derive(Debug)]
struct NoRefresh;

impl Credential for NoRefresh {
    fn refresh<'a>(&'a self, _attempt: u32, _rejected: &'a HeaderValue) -> BoxFuture<'a, Refresh> {
        Box::pin(async { Refresh::Stop })
    }
}

fn provider_builder() -> dima_http::ProviderBuilder {
    Provider::builder("polar", "https://user:MARKER-userinfo@api.polar.sh/v1")
        .secret_header(
            "authorization",
            &SecretString::from("Bearer MARKER-provider"),
        )
        .secret_header("x-custom-key", &SecretString::from("MARKER-custom"))
        .header("x-plain-but-unknown", "MARKER-plain")
}

#[tokio::test]
async fn debug_output_never_shows_secrets() {
    let builder = provider_builder();
    assert_clean("ProviderBuilder", &format!("{builder:?}"));
    let printed = format!("{builder:?}");
    assert!(
        printed.contains("polar") && printed.contains("x-custom-key"),
        "{printed}"
    );

    let server = MockServer::start().await.unwrap();
    let provider = Provider::builder("polar", &format!("{}/v1", server.url()))
        .secret_header(
            "authorization",
            &SecretString::from("Bearer MARKER-provider"),
        )
        .header("x-plain-but-unknown", "MARKER-plain")
        .secret_query_params(&["sig"])
        .build()
        .unwrap();
    assert_clean("Provider", &format!("{provider:?}"));
    let registry = ProviderRegistry::builder().provider(provider_builder());
    assert_clean("RegistryBuilder", &format!("{registry:?}"));

    let path = Path::template("/checkouts/client/{}/confirm", &["cs_MARKER-path"]).unwrap();
    assert_clean("Path", &format!("{path:?}"));
    assert!(format!("{path:?}").contains("/checkouts/client/{}/confirm"));

    let refresh = Refresh::Rotated(HeaderValue::from_static("Bearer MARKER-rotated"));
    assert_clean("Refresh", &format!("{refresh:?}"));

    let client = HttpClient::builder().build().unwrap();
    let request = client
        .post(&provider, path.clone())
        .query(&[("sig", "MARKER-query"), ("page", "MARKER-page")])
        .bearer(&SecretString::from("MARKER-bearer"))
        .secret_header("x-api-key", &SecretString::from("MARKER-secret-header"))
        .header("x-unknown", "MARKER-header")
        .credential(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer MARKER-credential"),
            Arc::new(NoRefresh),
        )
        .json(&serde_json::json!({ "api_key": "MARKER-body" }));
    let printed = format!("{request:?}");
    assert_clean("RequestBuilder", &printed);
    for shown in [
        "polar",
        "POST",
        "/checkouts/client/{}/confirm",
        "x-unknown",
        "bytes",
    ] {
        assert!(printed.contains(shown), "{shown} missing: {printed}");
    }
    let streamed = client
        .post(&provider, "/upload")
        .body_stream(dima_http::StreamBody::from(Bytes::from_static(
            b"MARKER-stream",
        )));
    assert_clean("RequestBuilder (stream)", &format!("{streamed:?}"));

    server.push(MockResponse::new(200).body("MARKER-response"));
    let response = request.send().await.unwrap();
    assert_clean("Response", &format!("{response:?}"));
    let stream = response.sse();
    assert_clean("SseStream", &format!("{stream:?}"));
    assert_clean("HttpClient", &format!("{client:?}"));

    let guarded = GuardedClient::new(GuardPolicy::any_public_host(), Shutdown::new()).unwrap();
    let request = guarded
        .request(
            dima_http::Method::POST,
            "https://cdn.example.com/MARKER-url-path?q=MARKER-url-query",
        )
        .header("x-user", "MARKER-guarded-header")
        .body("MARKER-guarded-body");
    let printed = format!("{request:?}");
    assert_clean("GuardedRequest", &printed);
    assert!(
        printed.contains("POST") && printed.contains("x-user"),
        "{printed}"
    );
    assert_clean("GuardedClient", &format!("{guarded:?}"));
}

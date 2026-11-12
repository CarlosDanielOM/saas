use dima_ai::search::*;
use dima_http::{
    HttpClient, Provider,
    testing::{MockResponse, MockServer},
};
use serde_json::{Value, json};
#[tokio::test]
async fn reference_search_requests_and_results() -> anyhow::Result<()> {
    let cases: Vec<Value> = serde_json::from_str(include_str!("search_reference.json"))?;
    for c in cases {
        let server = MockServer::start().await?;
        let p = server.provider(Provider::builder("search", "https://search.myhomelab.wtf"))?;
        server.push(MockResponse::json(200, &c["reply"].to_string()));
        let client = Client {
            http: HttpClient::builder().build()?,
            provider: p,
        };
        let actual = json!(client.execute(c["query"].as_str().unwrap()).await);
        assert_eq!(
            dima_text::to_js_json(&actual),
            dima_text::to_js_json(&c["expected"])
        );
        if let Some(target) = c["target"].as_str() {
            assert_eq!(server.next_request().await.unwrap().target, target);
        }
    }
    Ok(())
}

use dima_ai::embeddings::*;
use dima_http::{
    HttpClient,
    testing::{MockResponse, MockServer},
};
use serde_json::{Value, json};
use std::time::Duration;
#[tokio::test]
async fn reference_embedding_requests_and_results() -> anyhow::Result<()> {
    let cases: Vec<Value> = serde_json::from_str(include_str!("embeddings_reference.json"))?;
    let mut security_changes = 0;
    for (index, c) in cases.iter().enumerate() {
        let server = MockServer::start().await?;
        let service = if c["service"] == "lfm2" {
            Service::Lfm2
        } else {
            Service::OpenRouter
        };
        let mut config = if c["service"] == "lfm2" {
            Config::lfm2()
        } else {
            Config::openrouter(dima_core::SecretString::from("test-only"))
        };
        config.retries = if c["reply"]["rateLimit"] == true || c["reply"]["timeout"] == true {
            1
        } else {
            0
        };
        config.timeout = Duration::from_millis(100);
        let provider = server.provider(config.builder(service))?;
        let reply = &c["reply"];
        if reply["rateLimit"] == true {
            server.push(MockResponse::json(429, "{}"));
        }
        server.push(if reply["timeout"] == true {
            MockResponse::new(200).delay(Duration::from_secs(1))
        } else {
            MockResponse::json(
                reply["status"].as_u64().unwrap_or(200) as u16,
                &reply["body"].to_string(),
            )
        });
        if reply["timeout"] == true {
            server.push(MockResponse::new(200).delay(Duration::from_secs(1)));
        }
        let client = Client {
            http: HttpClient::builder().build()?,
            provider,
            service,
        };
        let actual = json!(
            client
                .generate_embeddings(
                    &serde_json::from_value::<Vec<String>>(c["texts"].clone())?,
                    c["model"].as_str().unwrap(),
                    Kind::Document,
                    Some("c")
                )
                .await
        );
        if c["reply"]["body"].get("error").is_some() && c["reply"].get("status").is_none() {
            assert_eq!(actual["message"], "Embedding service returned an error");
            security_changes += 1;
        } else {
            assert_eq!(
                dima_text::to_js_json(&actual),
                dima_text::to_js_json(&c["expected"]),
                "case {index}"
            );
        }
        assert_eq!(
            server.requests().len(),
            c["requests"].as_array().unwrap().len()
        );
        for (request, expected) in server
            .requests()
            .into_iter()
            .zip(c["requests"].as_array().unwrap())
        {
            assert_eq!(request.method, expected["method"].as_str().unwrap());
            assert_eq!(request.target, expected["target"].as_str().unwrap());
            assert_eq!(request.body_text(), expected["body"].as_str().unwrap());
            for (k, v) in expected["headers"].as_object().unwrap() {
                assert_eq!(request.header(k), v.as_str(), "header {k}");
            }
        }
    }
    assert_eq!(security_changes, 2);
    Ok(())
}

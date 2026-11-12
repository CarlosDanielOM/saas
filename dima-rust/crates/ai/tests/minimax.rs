use dima_ai::minimax::*;
use dima_core::{ManualClock, Shutdown};
use dima_http::{
    HttpClient,
    testing::{MockResponse, MockServer},
};
use serde_json::{Value, json};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
struct NoTools;
impl Tools for NoTools {
    fn run<'a>(
        &'a self,
        _: &'a str,
        _: Value,
        _: &'a Shutdown,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>> {
        Box::pin(async { Ok(json!({"ok":true})) })
    }
}
#[derive(Default)]
struct Capture(Mutex<Vec<String>>);
impl Handlers for Capture {
    fn text(&self, t: &str) {
        if let Ok(mut v) = self.0.lock() {
            v.push(t.into());
        }
    }
}
#[tokio::test]
async fn recorded_minimax_streams() -> anyhow::Result<()> {
    let cases: Vec<Value> = serde_json::from_str(include_str!("minimax_reference.json"))?;
    for c in cases {
        let server = MockServer::start().await?;
        let config = Config {
            base_url: "https://api.minimax.io/anthropic".into(),
            key: dima_core::SecretString::from("test-only"),
        };
        let provider = server.provider(config.builder())?;
        for attempt in 0..3 {
            server.push(if c["mode"] == "timeout" {
                MockResponse::new(200).delay(Duration::from_secs(1))
            } else {
                MockResponse::new(c["status"].as_u64().unwrap() as u16)
                    .header(
                        "content-type",
                        if c["status"] == 200 {
                            "text/event-stream"
                        } else {
                            "application/json"
                        },
                    )
                    .header("retry-after-ms", "1")
                    .body(if c["mode"] == "tools" && attempt == 0 {
                        c["toolBody"].as_str().unwrap().to_string()
                    } else {
                        c["body"].as_str().unwrap().to_string()
                    })
            });
        }
        let client = Client {
            http: HttpClient::builder().build()?,
            provider,
            clock: Arc::new(ManualClock::new(1)),
        };
        let handlers = Capture::default();
        let p = Params {
            messages: serde_json::from_value(c["params"]["messages"].clone())?,
            system: Some(c["params"]["system"].clone()),
            effort: Some(Effort::High),
            idle_timeout: Some(if c["mode"] == "timeout" {
                Duration::from_millis(30)
            } else {
                Duration::from_secs(120)
            }),
            tools: c["params"]["tools"]
                .as_array()
                .map(|a| a.iter().map(|t| t["definition"].clone()).collect())
                .unwrap_or_default(),
            max_tool_rounds: c["params"]["maxToolRounds"].as_u64().map(|n| n as usize),
            ..Default::default()
        };
        let result = client.chat(p, &NoTools, &handlers, &Shutdown::new()).await;
        if c.get("error").is_some() {
            assert_eq!(json!(result.unwrap_err().kind), c["error"]["kind"]);
        } else {
            let mut v = json!(result?);
            v.as_object_mut().unwrap().shift_remove("durationMs");
            assert_eq!(
                dima_text::to_js_json(&v),
                dima_text::to_js_json(&c["expected"])
            );
        }
        assert_eq!(
            server.requests().len(),
            c["requests"].as_array().unwrap().len()
        );
        for (r, expected) in server
            .requests()
            .into_iter()
            .zip(c["requests"].as_array().unwrap())
        {
            assert_eq!(r.target, expected["target"].as_str().unwrap());
            assert_eq!(r.body_text(), expected["body"].as_str().unwrap());
            for (k, v) in expected["headers"].as_object().unwrap() {
                assert_eq!(r.header(k), v.as_str());
            }
        }
    }
    Ok(())
}

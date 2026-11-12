//! Fixed-host search client. Query encoding is form encoding. Keep first three results.
//! Reference has no deadline; we use a generous 60s bound and no retries, 8 MiB body.
//! HTTP error status alone does not fail: the reference parses its JSON regardless.
use dima_http::{HttpClient, Provider};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
pub fn provider() -> Result<Provider, dima_http::ConfigError> {
    Provider::builder("search", "https://search.myhomelab.wtf")
        .timeout(Duration::from_secs(60))
        .build()
}
#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub content: String,
    pub score: f64,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub results: Option<Vec<SearchResult>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
pub struct Client {
    pub http: HttpClient,
    pub provider: Provider,
}
impl Client {
    pub async fn execute(&self, query: &str) -> SearchResponse {
        let fail = |s: &str| SearchResponse {
            success: false,
            results: None,
            error: Some(s.into()),
        };
        if dima_text::trim(query).is_empty() {
            return fail("Search query is required");
        }
        let Ok(r) = self
            .http
            .get(&self.provider, "/search")
            .query(&[("q", query), ("format", "json")])
            .send()
            .await
        else {
            return fail("Search request failed");
        };
        let Ok(v) = r.json::<Value>().await else {
            return fail("Invalid search response");
        };
        if dima_text::js_truthy(&v["error"]) {
            return fail(&format!(
                "Search failed: {}",
                dima_text::js_string(&v["error"])
            ));
        }
        let results = v["results"]
            .as_array()
            .map(|a| {
                a.iter()
                    .take(3)
                    .map(|r| SearchResult {
                        title: r["title"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .unwrap_or("Untitled")
                            .into(),
                        url: r["url"].as_str().unwrap_or("").into(),
                        content: r["content"].as_str().unwrap_or("").into(),
                        score: r["score"].as_f64().unwrap_or(0.0),
                    })
                    .collect()
            })
            .unwrap_or_default();
        SearchResponse {
            success: true,
            results: Some(results),
            error: None,
        }
    }
}

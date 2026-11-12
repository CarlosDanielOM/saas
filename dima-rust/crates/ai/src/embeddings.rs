//! Thin LFM2 and OpenRouter embedding clients on the shared HTTP stack.
//!
//! Provider limits: input count capped at 500, 8 MiB response bound; configured retries
//! cap at 16 to bound malformed startup configuration. No input text
//! is truncated. Dimensions (1024) are a provider contract. Usage is retained as
//! received JSON numbers, with no integer conversion or rounding. Request key order
//! follows the reference. Full-body deadlines strengthen reference header-only timers.
//! No error includes provider response text or a credential. No environment reads.
use dima_http::{HttpClient, Provider, ProviderBuilder, RetryPolicy};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Query,
    Document,
}
pub struct Config {
    pub base_url: String,
    pub timeout: Duration,
    pub retries: usize,
    pub api_key: Option<dima_core::SecretString>,
}
impl Config {
    pub fn lfm2() -> Self {
        Self {
            base_url: "http://lfm2.5-embeddings:8080/v1".into(),
            timeout: Duration::from_secs(10),
            retries: 2,
            api_key: None,
        }
    }
    pub fn openrouter(key: dima_core::SecretString) -> Self {
        Self {
            base_url: "https://openrouter.ai/api/v1".into(),
            timeout: Duration::from_secs(30),
            retries: 3,
            api_key: Some(key),
        }
    }
    pub fn provider(&self, service: Service) -> Result<Provider, dima_http::ConfigError> {
        self.builder(service).build()
    }
    pub fn builder(&self, service: Service) -> ProviderBuilder {
        let schedule = [
            Duration::from_secs(1),
            Duration::from_secs(3),
            Duration::from_secs(5),
        ];
        let delays: Vec<_> = (0..self.retries.min(16))
            .map(|i| schedule[i.min(2)])
            .collect();
        let p = Provider::builder(
            match service {
                Service::Lfm2 => "lfm2",
                Service::OpenRouter => "openrouter",
            },
            &self.base_url,
        )
        .internal(matches!(service, Service::Lfm2))
        .header("content-type", "application/json")
        .timeout(self.timeout)
        .headers_timeout(self.timeout)
        .retry(RetryPolicy::fetch_with_retry(&delays));
        if matches!(service, Service::OpenRouter) {
            let p = attribution(p);
            if let Some(key) = &self.api_key {
                p.secret_header(
                    "authorization",
                    &dima_core::SecretString::new(format!("Bearer {}", key.expose())),
                )
            } else {
                p
            }
        } else {
            p
        }
    }
}
pub fn attribution(p: ProviderBuilder) -> ProviderBuilder {
    p.header("HTTP-Referer", "https://domdimabot.com")
        .header("X-OpenRouter-Title", "DomDimaBot")
        .header(
            "X-OpenRouter-Description",
            "DomDimaBot is a Twitch chat bot that helps make streams more engaging and fun.",
        )
        .header("X-OpenRouter-Categories", "general-chat, roleplay")
}
#[derive(Clone, Copy)]
pub enum Service {
    Lfm2,
    OpenRouter,
}
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct EmbeddingResult {
    pub error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedding: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embeddings: Option<Vec<Vec<f64>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<serde_json::Number>,
}
impl EmbeddingResult {
    fn fail(message: impl Into<String>) -> Self {
        Self {
            error: true,
            message: Some(message.into()),
            ..Self::default()
        }
    }
}
pub struct Client {
    pub http: HttpClient,
    pub provider: Provider,
    pub service: Service,
}
impl Client {
    pub async fn generate_embedding(
        &self,
        text: &str,
        model: &str,
        kind: Kind,
        channel: Option<&str>,
    ) -> EmbeddingResult {
        self.generate(&[text.into()], model, kind, channel, false)
            .await
    }
    pub async fn generate_embeddings(
        &self,
        texts: &[String],
        model: &str,
        kind: Kind,
        channel: Option<&str>,
    ) -> EmbeddingResult {
        self.generate(texts, model, kind, channel, true).await
    }
    async fn generate(
        &self,
        texts: &[String],
        model: &str,
        kind: Kind,
        channel: Option<&str>,
        batch: bool,
    ) -> EmbeddingResult {
        if matches!(self.service, Service::OpenRouter)
            && channel.is_none_or(|s| dima_text::trim(s).is_empty())
        {
            return EmbeddingResult::fail("Channel context required for OpenRouter embeddings");
        }
        if texts.is_empty() {
            return EmbeddingResult::fail("No texts provided");
        }
        if texts.len() > 500 {
            return EmbeddingResult::fail("Embedding batch capacity exceeded");
        }
        let input = if texts.len() == 1 {
            json!(texts[0])
        } else {
            json!(texts)
        };
        let body = match self.service {
            Service::Lfm2 => json!({"input":input,"model":model,"kind":kind}),
            Service::OpenRouter => {
                let mut b = json!({"model":model,"user":channel,"input":input});
                if model == "lfm2.5-embedding-350m" {
                    b["dimensions"] = json!(1024);
                }
                b
            }
        };
        let fallback = if batch && texts.len() > 1 {
            "Failed to generate batch embeddings"
        } else {
            "Failed to generate embedding"
        };
        let Ok(response) = self
            .http
            .post(&self.provider, "/embeddings")
            .json_js(&body)
            .send()
            .await
        else {
            return EmbeddingResult::fail(fallback);
        };
        let status = response.status();
        if !status.is_success() {
            return EmbeddingResult::fail(format!(
                "{} API error: {} {}",
                if matches!(self.service, Service::Lfm2) {
                    "LFM2"
                } else {
                    "OpenRouter"
                },
                status.as_u16(),
                status.canonical_reason().unwrap_or("")
            ));
        }
        let Ok(v) = response.json::<Value>().await else {
            return EmbeddingResult::fail(fallback);
        };
        // Never surface untrusted upstream diagnostics: they may echo credentials.
        if v.get("error").is_some() {
            return EmbeddingResult::fail("Embedding service returned an error");
        }
        let Some(data) = v["data"].as_array() else {
            return EmbeddingResult::fail(fallback);
        };
        let mut data: Vec<_> = data.iter().collect();
        if matches!(self.service, Service::Lfm2) && texts.len() > 1 {
            data.sort_by(|a, b| {
                a["index"]
                    .as_f64()
                    .unwrap_or(0.0)
                    .total_cmp(&b["index"].as_f64().unwrap_or(0.0))
            });
        }
        if texts.len() == 1 && matches!(self.service, Service::Lfm2) {
            let embedding = data.first().and_then(|d| d.get("embedding"));
            let message = if embedding.is_none_or(|v| !dima_text::js_truthy(v)) {
                Some("Empty embedding returned from LFM2 service")
            } else if embedding
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty)
            {
                Some("Invalid embedding shape")
            } else {
                None
            };
            if let Some(message) = message {
                let mut result = EmbeddingResult::fail(message);
                result.model = Some(model.into());
                return result;
            }
        }
        let vectors: Result<Vec<Vec<f64>>, _> = data
            .iter()
            .map(|d| serde_json::from_value(d["embedding"].clone()))
            .collect();
        let Ok(vectors) = vectors else {
            return EmbeddingResult::fail(fallback);
        };
        if texts.len() == 1
            && matches!(self.service, Service::Lfm2)
            && vectors.first().is_none_or(Vec::is_empty)
        {
            let mut r = EmbeddingResult::fail(if vectors.is_empty() {
                "Empty embedding returned from LFM2 service"
            } else {
                "Invalid embedding shape"
            });
            r.model = Some(model.into());
            return r;
        }
        if texts.len() > 1 && matches!(self.service, Service::Lfm2) && texts.len() != vectors.len()
        {
            return EmbeddingResult::fail(format!(
                "LFM2 returned {} embeddings for {} inputs",
                vectors.len(),
                texts.len()
            ));
        }
        if texts.len() == 1 && vectors.is_empty() {
            return EmbeddingResult::fail(fallback);
        }
        EmbeddingResult {
            error: false,
            embedding: if batch {
                None
            } else {
                vectors.first().cloned()
            },
            embeddings: batch.then_some(vectors),
            model: Some(model.into()),
            tokens: v["usage"]["total_tokens"].as_number().cloned(),
            message: None,
        }
    }
}

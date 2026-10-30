//! OpenRouter embeddings with a pooled client and header-scoped retries.
use crate::utils::{
    ai_constants::embedding_dimensions,
    ai_fetch_retry::{FetchWithRetry, RetryOptions},
    js_compat,
    logger::{
        Destination, Level, LogOptions, Logger, LoggerConfig, SinkHandles, StdConsole, SystemClock,
        UuidSource,
    },
    openrouter_attribution::OPENROUTER_APP_HEADERS,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

pub const EMBEDDING_API_URL: &str = "https://openrouter.ai/api/v1/embeddings";
pub const DEFAULT_EMBEDDING_MODEL: &str = "qwen/qwen3-embedding-8b";
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum EmbeddingInput {
    Single(String),
    Batch(Vec<String>),
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct IOpenRouterEmbeddingRequest {
    pub model: String,
    pub input: EmbeddingInput,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<u32>,
    pub user: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct EmbeddingItem {
    pub embedding: Vec<f64>,
    pub index: f64,
    pub object: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct EmbeddingUsage {
    pub prompt_tokens: f64,
    pub total_tokens: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct IOpenRouterEmbeddingResponse {
    pub data: Vec<EmbeddingItem>,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<EmbeddingUsage>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct EmbeddingErrorDetails {
    pub message: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub code: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct IOpenRouterEmbeddingError {
    pub error: EmbeddingErrorDetails,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct IEmbeddingResult {
    pub error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedding: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<f64>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct IBatchEmbeddingResult {
    pub error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedding: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embeddings: Option<Vec<Option<Vec<f64>>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<f64>,
}
#[derive(Clone, Debug)]
pub enum ApiKey {
    Environment,
    Fixed(String),
}
#[derive(Clone, Debug)]
pub struct EmbeddingConfig {
    pub endpoint: String,
    pub retry: RetryOptions,
    pub api_key: ApiKey,
}
impl Default for EmbeddingConfig {
    fn default() -> Self {
        Self {
            endpoint: EMBEDDING_API_URL.into(),
            retry: RetryOptions {
                timeout: Duration::from_secs(20),
                ..Default::default()
            },
            api_key: ApiKey::Environment,
        }
    }
}
#[derive(Clone)]
pub struct EmbeddingService {
    endpoint: reqwest::Url,
    fetch: FetchWithRetry,
    api_key: ApiKey,
    logger: Arc<Logger>,
}
impl EmbeddingService {
    pub fn new(config: EmbeddingConfig) -> Result<Self, String> {
        let endpoint = reqwest::Url::parse(&config.endpoint).map_err(|e| e.to_string())?;
        let fetch = FetchWithRetry::new(config.retry).map_err(|e| e.to_string())?;
        let logger = Arc::new(
            Logger::new(
                LoggerConfig::default(),
                SinkHandles {
                    console: Some(Arc::new(StdConsole)),
                    ..Default::default()
                },
                Arc::new(SystemClock),
                Arc::new(UuidSource),
            )
            .map_err(|e| e.to_string())?,
        );
        Ok(Self {
            endpoint,
            fetch,
            api_key: config.api_key,
            logger,
        })
    }
    pub fn with_logger(mut self, logger: Arc<Logger>) -> Self {
        self.logger = logger;
        self
    }
    fn report(&self, mut payload: Value) {
        if payload.get("batchSize").is_some_and(Value::is_null) {
            payload
                .as_object_mut()
                .expect("diagnostic object")
                .remove("batchSize");
        }
        let logger = self.logger.clone();
        tokio::spawn(async move {
            let _ = logger
                .log(
                    Level::Error,
                    payload,
                    LogOptions {
                        destination: Destination::Console,
                        ..Default::default()
                    },
                )
                .await;
        });
    }
    fn key(&self) -> String {
        match &self.api_key {
            ApiKey::Environment => {
                std::env::var("OPENROUTER_API_KEY").unwrap_or_else(|_| "undefined".into())
            }
            ApiKey::Fixed(value) => value.clone(),
        }
    }
    fn context(channel: Option<&str>) -> bool {
        channel.is_some_and(|v| !js_compat::trim(v).is_empty())
    }
    pub async fn generate_embedding(
        &self,
        text: &str,
        model: Option<&str>,
        channel: Option<&str>,
    ) -> IEmbeddingResult {
        let model = model.unwrap_or(DEFAULT_EMBEDDING_MODEL);
        if !Self::context(channel) {
            return IEmbeddingResult {
                error: true,
                message: Some("Channel context required for OpenRouter embeddings".into()),
                ..Default::default()
            };
        }
        let result = self
            .request(
                EmbeddingInput::Single(text.into()),
                model,
                channel.unwrap(),
                false,
            )
            .await;
        match result {
            Ok((data, tokens)) => IEmbeddingResult {
                error: false,
                embedding: data.into_iter().next().flatten(),
                model: Some(model.into()),
                tokens,
                ..Default::default()
            },
            Err(message) => IEmbeddingResult {
                error: true,
                message,
                ..Default::default()
            },
        }
    }
    pub async fn generate_embeddings(
        &self,
        texts: &[String],
        model: Option<&str>,
        channel: Option<&str>,
    ) -> IBatchEmbeddingResult {
        let model = model.unwrap_or(DEFAULT_EMBEDDING_MODEL);
        if !Self::context(channel) {
            return IBatchEmbeddingResult {
                error: true,
                message: Some("Channel context required for OpenRouter embeddings".into()),
                ..Default::default()
            };
        }
        if texts.is_empty() {
            return IBatchEmbeddingResult {
                error: true,
                message: Some("No texts provided".into()),
                ..Default::default()
            };
        }
        if texts.len() == 1 {
            let single = self
                .generate_embedding(&texts[0], Some(model), channel)
                .await;
            return if !single.error && single.embedding.is_some() {
                IBatchEmbeddingResult {
                    error: false,
                    embeddings: single.embedding.map(|v| vec![Some(v)]),
                    model: single.model,
                    tokens: single.tokens,
                    ..Default::default()
                }
            } else {
                IBatchEmbeddingResult {
                    error: single.error,
                    message: single.message,
                    embedding: single.embedding,
                    model: single.model,
                    tokens: single.tokens,
                    ..Default::default()
                }
            };
        }
        match self
            .request(
                EmbeddingInput::Batch(texts.to_vec()),
                model,
                channel.unwrap(),
                true,
            )
            .await
        {
            Ok((embeddings, tokens)) => IBatchEmbeddingResult {
                error: false,
                embeddings: Some(embeddings),
                model: Some(model.into()),
                tokens,
                ..Default::default()
            },
            Err(message) => IBatchEmbeddingResult {
                error: true,
                message,
                ..Default::default()
            },
        }
    }
    async fn request(
        &self,
        input: EmbeddingInput,
        model: &str,
        channel: &str,
        batch: bool,
    ) -> Result<(Vec<Option<Vec<f64>>>, Option<f64>), Option<String>> {
        let size = match &input {
            EmbeddingInput::Single(_) => 1,
            EmbeddingInput::Batch(v) => v.len(),
        };
        let start = Instant::now();
        let failure = if batch {
            "Failed to generate batch embeddings"
        } else {
            "Failed to generate embedding"
        };
        let result=async {
   let body=IOpenRouterEmbeddingRequest{model:model.into(),input,dimensions:embedding_dimensions(model),user:channel.into()};
   let mut builder=self.fetch.client().post(self.endpoint.clone()).header("Authorization",format!("Bearer {}",self.key())).header("Content-Type","application/json");
   for &(key,value) in OPENROUTER_APP_HEADERS{builder=builder.header(key,value);}
   let request=builder.json(&body).build().map_err(|e|e.to_string())?;
   let response=self.fetch.execute(request).await.map_err(|e|e.to_string())?;let status=response.status();let duration=start.elapsed().as_millis();
   if !status.is_success(){let error=response.text().await.map_err(|e|e.to_string())?;let status_text=status.canonical_reason().unwrap_or("");self.report(json!({"message":if batch{"OpenRouter batch embedding API error"}else{"OpenRouter embedding API error"},"status":status.as_u16(),"statusText":status_text,"error":error,"model":model,"duration":duration,"batchSize":if batch{Some(size)}else{None}}));return Ok(Err(Some(format!("OpenRouter API error: {} {}",status.as_u16(),status_text))))}
   let data:Value=response.json().await.map_err(|e|e.to_string())?;
   if let Some(error)=data.get("error") {if error.is_null(){return Err("null error".to_owned())}self.report(json!({"message":if batch{"OpenRouter batch embedding returned error"}else{"OpenRouter embedding returned error"},"error":error,"model":model,"duration":duration,"batchSize":if batch{Some(size)}else{None}}));return Ok(Err(error.get("message").and_then(Value::as_str).map(str::to_owned)))}
   let rows=data.get("data").and_then(Value::as_array).ok_or("missing data")?;
   if !batch&&rows.is_empty(){return Err("missing first embedding".to_owned())}
   let rows=if batch{rows.as_slice()}else{&rows[..1]};
   let embeddings=rows.iter().map(|v|if v.is_null(){Err("null embedding item")}else{match v.get("embedding") { None=>Ok(None),Some(Value::Array(a))=>a.iter().map(|x|x.as_f64().ok_or("non-numeric embedding")).collect::<Result<Vec<_>,_>>().map(Some),_=>Err("non-array embedding") }}).collect::<Result<Vec<_>,_>>().map_err(str::to_owned)?;
   let tokens=data.get("usage").and_then(|v|v.get("total_tokens")).and_then(Value::as_f64);
   Ok(Ok((embeddings,tokens)))
  }.await;
        match result {
            Ok(value) => value,
            Err(error) => {
                self.report(json!({"message":if batch{"Error generating batch embeddings"}else{"Error generating embedding"},"error":error,"model":model,"batchSize":if batch{Some(size)}else{None}}));
                Err(Some(failure.into()))
            }
        }
    }
}

/// Shared module-default pool. The environment key is read on each request.
pub fn default_embedding_service() -> &'static EmbeddingService {
    static SERVICE: std::sync::OnceLock<EmbeddingService> = std::sync::OnceLock::new();
    SERVICE.get_or_init(|| {
        EmbeddingService::new(EmbeddingConfig::default())
            .expect("default embedding client construction")
    })
}
pub async fn generate_embedding(
    text: &str,
    model: Option<&str>,
    channel: Option<&str>,
) -> IEmbeddingResult {
    default_embedding_service()
        .generate_embedding(text, model, channel)
        .await
}
pub async fn generate_embeddings(
    texts: &[String],
    model: Option<&str>,
    channel: Option<&str>,
) -> IBatchEmbeddingResult {
    default_embedding_service()
        .generate_embeddings(texts, model, channel)
        .await
}
pub use crate::utils::ai_embedding_language::{LanguageDetector, detect_language};

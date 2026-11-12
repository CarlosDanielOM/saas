//! The call to OpenRouter's chat completions: `callOpenRouter` and `extractOpenRouterError` of
//! `utils/ai/openrouter/ai.ts` (lines 196–254 and 465–537), with the retry wrapper of
//! `utils/ai/fetch.utils.ts`.
//!
//! # The request (contract: what the provider sees decides the answer and the cost)
//!
//! `POST {base}/chat/completions` with the headers of the reference: `Content-Type:
//! application/json`, `Authorization: Bearer <key>`, the app attribution
//! ([`dima_ai::embeddings::attribution`]: `HTTP-Referer`, `X-OpenRouter-Title`,
//! `X-OpenRouter-Description`, `X-OpenRouter-Categories`) and `X-Trace-ID: <trace id>`. The body
//! is [`CompletionRequest::body`]: `model`, `messages`, `tools`, `max_tokens` (left out when
//! there is none, as `JSON.stringify` drops `undefined`), `user` (the channel id), `usage:
//! {include: true}`, `session_id`, `trace: {trace_id}`, then the caller's extra options spread
//! over it (a key already present keeps its place and takes the new value, as `{...a, ...b}`
//! does). It is written with [`dima_text::to_js_json`], so numbers and escapes are the bytes
//! `JSON.stringify` writes.
//!
//! # Timeouts and retries
//!
//! [`Transport::Retrying`] is `fetchWithRetry` (`timeout: 30000, retries: 3`): up to four
//! attempts; a thrown failure (no connection, a reset, a timeout) and the statuses 429, 500, 502,
//! 503 and 504 are retried after 1 s, 3 s and 5 s; the last response is returned whatever its
//! status. [`Transport::SingleAttempt`] is the reference's `singleAttempt` (one attempt,
//! `AbortSignal.timeout(30_000)`, which also bounds the body): the caller cancels it by dropping
//! the future, which is what its `AbortSignal` did.
//!
//! The reference's 30 s covers the response headers only (`clearTimeout` runs once `fetch`
//! resolves; the body read has no timeout). Here the headers keep that 30 s and the body gets
//! two bounds the reference lacks (listed in the package report): at most
//! [`BODY_IDLE_TIMEOUT`] between body chunks and [`ATTEMPT_DEADLINE`] for the whole attempt,
//! both generous enough for the longest non-streamed answer (`max_tokens` 25 000), which
//! OpenRouter keeps alive with whitespace. The answer is read up to [`MAX_ANSWER_BYTES`].
//!
//! # The answer
//!
//! [`OpenRouter::complete`] answers the JSON the reference's `callOpenRouter` resolves to: the
//! provider's object for a 2xx, or, for any other final status, the reference's own object
//! `{error: true, message: "OpenRouter API error: <status> <statusText>", status}` (the status
//! text is the standard reason phrase: Node's `fetch` reads it from the HTTP/1.1 status line,
//! and OpenRouter sends the standard ones). What `callOpenRouter` throws is [`CallError`].
//!
//! # Logging
//!
//! Prompts, answers and provider error bodies are viewers' and streamers' text: nothing here
//! logs them. [`CompletionRequest`]'s `Debug` prints the model, the counts and the ids only.

use dima_core::SecretString;
use dima_http::{FailureClass, HttpClient, Provider, ProviderBuilder, RetryPolicy, StatusCode};
use serde_json::{Map, Value, json};
use std::time::Duration;

/// `https://openrouter.ai/api/v1`, the base every chat completion is sent to.
pub const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";

/// The path of a chat completion.
pub const COMPLETIONS_PATH: &str = "/chat/completions";

/// `OPENROUTER_TIMEOUT` (30 s): until the response headers, per attempt.
pub const OPENROUTER_TIMEOUT: Duration = Duration::from_secs(30);

/// `fetchWithRetry`'s waits before the second, third and fourth attempts.
pub const RETRY_DELAYS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(3),
    Duration::from_secs(5),
];

/// Added bound (none in the reference): the longest wait between two chunks of the answer's
/// body once its headers arrived.
pub const BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(120);

/// Added bound (none in the reference): one attempt, headers and body.
pub const ATTEMPT_DEADLINE: Duration = Duration::from_secs(600);

/// Added bound: the largest answer read (a completion is a few kilobytes; a bigger body is an
/// error, never cut).
pub const MAX_ANSWER_BYTES: u64 = 8 * 1024 * 1024;

/// The provider declaration of the chat completions: the reference's headers, its timeout and
/// its retry policy. The binary registers it (and the rig points it at a mock).
///
/// `key` is `OPENROUTER_API_KEY`. Without one the reference sent `Bearer undefined` and got
/// OpenRouter's 401; here no `Authorization` header is sent and the answer is the same 401.
pub fn provider(key: Option<&SecretString>) -> ProviderBuilder {
    let builder = dima_ai::embeddings::attribution(
        Provider::builder("openrouter", OPENROUTER_BASE_URL)
            .header("content-type", "application/json"),
    )
    .headers_timeout(OPENROUTER_TIMEOUT)
    .idle_timeout(BODY_IDLE_TIMEOUT)
    .timeout(ATTEMPT_DEADLINE)
    .max_bytes(MAX_ANSWER_BYTES)
    .retry(retrying());
    match key {
        Some(key) => builder.secret_header(
            "authorization",
            &SecretString::new(format!("Bearer {}", key.expose())),
        ),
        None => builder,
    }
}

fn retrying() -> RetryPolicy {
    RetryPolicy::fetch_with_retry(&RETRY_DELAYS)
}

/// How the call is made (`transport` of `callOpenRouter`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Transport {
    /// `fetchWithRetry`: four attempts (see the module docs).
    #[default]
    Retrying,
    /// `singleAttempt`: one attempt with a 30 s timeout, cancelled by dropping the future
    /// (the reference's `AbortSignal`).
    SingleAttempt,
}

/// One chat completion request: the arguments of `callOpenRouter` that shape the body.
#[derive(Clone, Copy)]
pub struct CompletionRequest<'a> {
    /// `model`.
    pub model: &'a str,
    /// `messages`, as the caller built them (any JSON: a provider's assistant message is sent
    /// back with every field it had).
    pub messages: &'a [Value],
    /// `tools` (sent even when empty, as the reference sends `[]`).
    pub tools: &'a [Value],
    /// `max_tokens` (`None`: left out, the provider's own limit).
    pub max_tokens: Option<u32>,
    /// The channel id, sent as `user`.
    pub channel_id: &'a str,
    /// `session_id`.
    pub session_id: &'a str,
    /// `trace.trace_id` and the `X-Trace-ID` header.
    pub trace_id: &'a str,
    /// `extraOptions`, spread over the body.
    pub extra: Option<&'a Map<String, Value>>,
}

/// Counts and ids only: the messages are viewers' and streamers' text.
impl std::fmt::Debug for CompletionRequest<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CompletionRequest")
            .field("model", &self.model)
            .field("messages", &self.messages.len())
            .field("tools", &self.tools.len())
            .field("max_tokens", &self.max_tokens)
            .field("channel_id", &self.channel_id)
            .field("session_id", &self.session_id)
            .field("trace_id", &self.trace_id)
            .field(
                "extra_keys",
                &self.extra.map(|extra| extra.keys().collect::<Vec<_>>()),
            )
            .finish()
    }
}

impl CompletionRequest<'_> {
    /// The body as `callOpenRouter` builds it, keys in its order.
    pub fn body(&self) -> Map<String, Value> {
        let mut body = Map::new();
        body.insert("model".into(), Value::from(self.model));
        body.insert("messages".into(), Value::Array(self.messages.to_vec()));
        body.insert("tools".into(), Value::Array(self.tools.to_vec()));
        if let Some(max_tokens) = self.max_tokens {
            body.insert("max_tokens".into(), Value::from(max_tokens));
        }
        body.insert("user".into(), Value::from(self.channel_id));
        body.insert("usage".into(), json!({ "include": true }));
        body.insert("session_id".into(), Value::from(self.session_id));
        body.insert("trace".into(), json!({ "trace_id": self.trace_id }));
        if let Some(extra) = self.extra {
            for (key, value) in extra {
                // `{...body, ...extra}`: an existing key keeps its position (preserve_order's
                // `insert` replaces in place), a new one is appended.
                body.insert(key.clone(), value.clone());
            }
        }
        body
    }

    /// The body's bytes, as `JSON.stringify(body)` writes them.
    pub fn body_text(&self) -> String {
        dima_text::to_js_json(&Value::Object(self.body()))
    }
}

/// What `callOpenRouter` threw (the callers catch it: `generateStandaloneText` answers "AI
/// generation unavailable", `executeAiCommand` "[AI: Connection error]").
#[derive(Debug, thiserror::Error)]
pub enum CallError {
    /// No usable response: every attempt failed before a status (connection, reset, timeout),
    /// or the request could not be sent. `may_have_generated` is false only when the provider
    /// certainly never received a complete request (the connection could not be opened, or
    /// the request was refused before it was sent).
    #[error("OpenRouter request failed ({class})")]
    Transport {
        /// The failure's class, for logs (never a URL, header or body).
        class: &'static str,
        /// Whether the provider may have generated (and billed) an answer.
        may_have_generated: bool,
    },
    /// A 2xx answer whose body is not JSON (`response.json()` threw), or larger than
    /// [`MAX_ANSWER_BYTES`]. The provider generated and billed it; its usage is unknown.
    #[error("OpenRouter answer could not be read")]
    Unreadable,
}

impl CallError {
    /// Whether the provider may have produced (and billed) an answer we do not know the usage
    /// of: the money we cannot charge.
    pub fn may_have_generated(&self) -> bool {
        match self {
            Self::Transport {
                may_have_generated, ..
            } => *may_have_generated,
            Self::Unreadable => true,
        }
    }
}

fn transport_error(error: &dima_http::Error) -> CallError {
    let class = error.class();
    CallError::Transport {
        class: class.as_str(),
        may_have_generated: !matches!(
            class,
            FailureClass::Connect
                | FailureClass::Invalid
                | FailureClass::Blocked
                | FailureClass::RequestTooLarge
                | FailureClass::Redirect
        ),
    }
}

/// The client of the chat completions.
#[derive(Clone, Debug)]
pub struct OpenRouter {
    http: HttpClient,
    provider: Provider,
}

impl OpenRouter {
    /// Over the process's HTTP client and the provider built from [`provider`].
    pub fn new(http: HttpClient, provider: Provider) -> Self {
        Self { http, provider }
    }

    /// `callOpenRouter(...)`: the answer as JSON (see the module docs), or what it threw.
    pub async fn complete(
        &self,
        request: &CompletionRequest<'_>,
        transport: Transport,
    ) -> Result<Value, CallError> {
        let builder = self
            .http
            .post(&self.provider, COMPLETIONS_PATH)
            .header("x-trace-id", request.trace_id)
            .body(request.body_text());
        let builder = match transport {
            Transport::Retrying => builder.retry(retrying()),
            // `AbortSignal.timeout(30_000)` stays on the response, so it bounds the body too.
            Transport::SingleAttempt => builder
                .retry(RetryPolicy::none())
                .headers_timeout(OPENROUTER_TIMEOUT)
                .timeout(OPENROUTER_TIMEOUT),
        };
        let response = builder
            .send()
            .await
            .map_err(|error| transport_error(&error))?;
        let status = response.status();
        if !status.is_success() {
            // `await response.text()` is read and logged by the reference; the body is not
            // kept here (it can echo the request), so it is not read either.
            return Ok(http_error(status));
        }
        let bytes = response.bytes().await.map_err(|error| match error.class() {
            FailureClass::TooLarge | FailureClass::Decode => CallError::Unreadable,
            _ => transport_error(&error),
        })?;
        let text = String::from_utf8_lossy(&bytes);
        dima_text::parse_js_json(
            &text,
            dima_text::JsonLimits {
                max_depth: 512,
                max_bytes: usize::try_from(MAX_ANSWER_BYTES).unwrap_or(usize::MAX),
            },
        )
        .map_err(|_| CallError::Unreadable)
    }
}

/// The reference's object for a final non-2xx status.
pub fn http_error(status: StatusCode) -> Value {
    let text = status.canonical_reason().unwrap_or("");
    json!({
        "error": true,
        "message": format!("OpenRouter API error: {} {text}", status.as_u16()),
        "status": status.as_u16(),
    })
}

/// `data.error` is truthy: the provider (or the HTTP status) said the call failed.
pub fn is_error(answer: &Value) -> bool {
    answer.get("error").is_some_and(dima_text::js_truthy)
}

/// What [`extract_open_router_error`] found.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ExtractedError {
    /// The message (`"Unknown error"` when none).
    pub message: String,
    /// `error.type`.
    pub kind: Option<String>,
    /// `error.code` (text only, as the reference keeps it).
    pub code: Option<String>,
    /// `status`.
    pub status: Option<f64>,
}

/// `extractOpenRouterError(data)`: the three shapes an OpenRouter error comes in.
///
/// 1. `{error: true, message, status}` (the object [`http_error`] builds);
/// 2. `{error: {message, type, code}}`, OpenRouter's own;
/// 3. `{message, status}`.
pub fn extract_open_router_error(data: &Value) -> ExtractedError {
    let mut result = ExtractedError {
        message: "Unknown error".into(),
        ..ExtractedError::default()
    };
    let Value::Object(d) = data else {
        return result;
    };
    let text = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_owned);
    let number = |value: Option<&Value>| value.and_then(Value::as_f64);
    if d.get("error") == Some(&Value::Bool(true))
        && let Some(message) = text(d.get("message"))
    {
        result.message = message;
        result.status = number(d.get("status"));
        return result;
    }
    // `d.error && typeof d.error === "object"`: an object or an array (truthy, an object to
    // `typeof`); an array has no `message`, `type` or `code`.
    match d.get("error") {
        Some(Value::Object(error)) => {
            if let Some(message) = text(error.get("message")) {
                result.message = message;
            }
            result.kind = text(error.get("type"));
            result.code = text(error.get("code"));
            return result;
        }
        Some(Value::Array(_)) => return result,
        _ => {}
    }
    if let Some(message) = text(d.get("message")) {
        result.message = message;
        result.status = number(d.get("status"));
    }
    result
}

/// `data.choices?.[0]?.message`, when it is an object.
pub fn first_message(answer: &Value) -> Option<&Map<String, Value>> {
    answer
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(Value::as_object)
}

/// `data.usage`, when it is truthy (the reference's `if (data.usage)`).
pub fn usage_of(answer: &Value) -> Option<&Value> {
    answer.get("usage").filter(|usage| dima_text::js_truthy(*usage))
}

//! MiniMax Anthropic-compatible streaming transport and bounded tool rounds.
//!
//! Usage and cost keep reference doubles, without rounding. max_tokens 524288 is a
//! provider budget; held preamble 240 counts scalars (our UI buffering rule). Up to
//! 32 tool rounds plus one final retry, 64 tools, 1024 blocks, 8 MiB responses and
//! a 30 minute overall call deadline bound reference-unbounded buffers and loops.
//! Header wait 60s, idle 120s, SDK retry policy 2 retries before streaming starts.
//! The caller owns tool execution; it receives the cancellation token and 120s deadline.
//! SDK platform telemetry headers are omitted; semantic auth/version headers remain.
use dima_core::{Clock, Shutdown};
use dima_http::retry::{Jitter, OverCap, ServerDelay, StatusSet};
use dima_http::{HttpClient, Provider, ProviderBuilder, RetryPolicy};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{future::Future, pin::Pin, sync::Arc, time::Duration};
pub const MODEL: &str = "MiniMax-M3.1-Flash";
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}
pub struct Config {
    pub base_url: String,
    pub key: dima_core::SecretString,
}
impl Config {
    pub fn builder(&self) -> ProviderBuilder {
        Provider::builder("minimax", &self.base_url)
            .secret_header("x-api-key", &self.key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .headers_timeout(Duration::from_secs(60))
            .timeout(Duration::from_secs(1800))
            .idle_timeout(Duration::from_secs(120))
            .retry(
                RetryPolicy::exponential(
                    3,
                    Duration::from_millis(500),
                    2.0,
                    Duration::from_secs(8),
                )
                .retry_statuses(
                    StatusSet::new()
                        .with(408)
                        .with(409)
                        .with(429)
                        .with_range(500, 599),
                )
                .retry_failures(true, true, true)
                .retry_non_idempotent(true)
                .jitter(Jitter::Scale {
                    low: 0.75,
                    high: 1.0,
                })
                .should_retry_header(true)
                .server_delay(ServerDelay {
                    retry_after_ms: true,
                    over_cap: OverCap::Backoff,
                    ..ServerDelay::retry_after(Duration::from_secs(60))
                }),
            )
    }
    pub fn provider(&self) -> Result<Provider, dima_http::ConfigError> {
        self.builder().build()
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Message {
    pub role: String,
    pub content: Value,
}
#[derive(Default)]
pub struct Params {
    pub messages: Vec<Message>,
    pub system: Option<Value>,
    pub effort: Option<Effort>,
    pub max_tokens: Option<f64>,
    pub tools: Vec<Value>,
    pub max_tool_rounds: Option<usize>,
    pub idle_timeout: Option<Duration>,
}
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Config,
    Aborted,
    Timeout,
    RateLimited,
    Overloaded,
    BadRequest,
    Upstream,
}
#[derive(Debug, thiserror::Error)]
#[error("MiniMax request failed: {kind:?}")]
pub struct Error {
    pub kind: ErrorKind,
    pub status: Option<u16>,
}
fn failure(kind: ErrorKind) -> Error {
    Error { kind, status: None }
}
fn http_error(e: dima_http::Error, cancel: &Shutdown) -> Error {
    if cancel.is_triggered() {
        failure(ErrorKind::Aborted)
    } else if matches!(e, dima_http::Error::Timeout { .. }) {
        failure(ErrorKind::Timeout)
    } else {
        failure(ErrorKind::Upstream)
    }
}
/// Tools come from the integration package. Results are JSON-quoted into tool_result.
pub trait Tools: Send + Sync {
    fn run<'a>(
        &'a self,
        name: &'a str,
        input: Value,
        cancel: &'a Shutdown,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;
}
pub trait Handlers: Send + Sync {
    fn text(&self, _delta: &str) {}
    fn thinking(&self, _delta: &str) {}
    fn tool_call(&self, _name: &str, _input: &Value) {}
    fn discard_text(&self) {}
}
impl Handlers for () {}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultData {
    pub content: String,
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cache_read_tokens: f64,
    pub thinking_tokens: f64,
    pub cost: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    pub duration_ms: i64,
    pub model: String,
    pub rounds: usize,
    pub tool_calls: Vec<Value>,
}
pub fn calculate_minimax_cost(input: f64, output: f64, cache: f64) -> f64 {
    (input * 0.15 + cache * 0.015 + output * 0.6) / 1000000.0
}
pub struct Client {
    pub http: HttpClient,
    pub provider: Provider,
    pub clock: Arc<dyn Clock>,
}
impl Client {
    pub async fn chat(
        &self,
        p: Params,
        tools: &dyn Tools,
        handlers: &dyn Handlers,
        cancel: &Shutdown,
    ) -> Result<ResultData, Error> {
        tokio::time::timeout(
            Duration::from_secs(1800),
            self.chat_inner(p, tools, handlers, cancel),
        )
        .await
        .map_err(|_| failure(ErrorKind::Timeout))?
    }
    async fn chat_inner(
        &self,
        p: Params,
        tools: &dyn Tools,
        handlers: &dyn Handlers,
        cancel: &Shutdown,
    ) -> Result<ResultData, Error> {
        if p.messages.len() > 1000 || p.tools.len() > 64 {
            return Err(failure(ErrorKind::BadRequest));
        }
        let started = self.clock.now_ms();
        let mut conversation: Vec<_> = p
            .messages
            .into_iter()
            .filter(|m| m.role != "system")
            .collect();
        let has_tools = !p.tools.is_empty();
        let max_rounds = if has_tools {
            p.max_tool_rounds.unwrap_or(5).clamp(1, 32)
        } else {
            1
        };
        let idle = p.idle_timeout.unwrap_or(Duration::from_secs(120));
        let mut drop_tools = false;
        let mut totals = [0.0; 4];
        let mut calls = Vec::new();
        for round in 1..=max_rounds + 1 {
            let last = round >= max_rounds;
            if last
                && round > 1
                && let Some(m) = conversation.last_mut()
                && m.role == "user"
                && let Some(blocks) = m.content.as_array_mut()
                && !blocks.iter().any(|b| b["type"] == "text")
            {
                blocks.push(json!({"type":"text","text":"You have no more tool calls. Answer the user now, using what you already found."}));
            }
            let mut body = json!({"model":MODEL,"messages":conversation});
            if let Some(system) = &p.system {
                body["system"] = system.clone();
            }
            body["max_tokens"] = json!(p.max_tokens.unwrap_or(524288.0));
            if let Some(e) = p.effort {
                body["output_config"] = json!({"effort":e});
            }
            if has_tools && !drop_tools {
                body["tools"] = json!(p.tools);
                body["tool_choice"] = json!({"type":if last {"none"} else {"auto"}});
            }
            body["stream"] = json!(true);
            let response = tokio::time::timeout(
                idle,
                self.http
                    .post(&self.provider, "/v1/messages")
                    .header("x-stainless-helper-method", "stream")
                    .json_js(&body)
                    .idle_timeout(idle)
                    .cancel_on(cancel)
                    .send(),
            )
            .await
            .map_err(|_| failure(ErrorKind::Timeout))?
            .map_err(|e| http_error(e, cancel))?;
            let status = response.status().as_u16();
            if status >= 400 {
                return Err(Error {
                    kind: if status == 429 {
                        ErrorKind::RateLimited
                    } else if status >= 500 {
                        ErrorKind::Overloaded
                    } else {
                        ErrorKind::BadRequest
                    },
                    status: Some(status),
                });
            }
            let mut sse = response.sse();
            let mut blocks: Vec<Value> = Vec::new();
            let mut usage = [0.0; 4];
            let mut stop = None;
            let mut held = String::new();
            let mut flushed = !has_tools;
            let mut complete = false;
            while let Some(event) = sse.next_event().await {
                let event = event.map_err(|e| http_error(e, cancel))?;
                let v: Value =
                    serde_json::from_str(&event.data).map_err(|_| failure(ErrorKind::Upstream))?;
                match v["type"].as_str().unwrap_or("") {
                    "message_start" => merge_usage(&mut usage, &v["message"]["usage"]),
                    "message_delta" => {
                        merge_usage(&mut usage, &v["usage"]);
                        stop = v["delta"]["stop_reason"].as_str().map(str::to_owned);
                    }
                    "message_stop" => {
                        complete = true;
                        break;
                    }
                    "content_block_start" => {
                        let index = v["index"]
                            .as_u64()
                            .ok_or_else(|| failure(ErrorKind::Upstream))?
                            as usize;
                        if index >= 1024 {
                            return Err(failure(ErrorKind::Upstream));
                        }
                        if blocks.len() <= index {
                            blocks.resize(index + 1, Value::Null);
                        }
                        blocks[index] = v["content_block"].clone();
                    }
                    "content_block_delta" => {
                        let index = v["index"]
                            .as_u64()
                            .ok_or_else(|| failure(ErrorKind::Upstream))?
                            as usize;
                        let block = blocks
                            .get_mut(index)
                            .ok_or_else(|| failure(ErrorKind::Upstream))?;
                        let d = &v["delta"];
                        match d["type"].as_str().unwrap_or("") {
                            "text_delta" => {
                                let text = d["text"].as_str().unwrap_or("");
                                append(block, "text", text);
                                if flushed {
                                    handlers.text(text);
                                } else {
                                    held.push_str(text);
                                    if held.chars().count() >= 240 {
                                        flushed = true;
                                        handlers.text(&held);
                                        held.clear();
                                    }
                                }
                            }
                            "thinking_delta" => {
                                let text = d["thinking"].as_str().unwrap_or("");
                                append(block, "thinking", text);
                                handlers.thinking(text);
                            }
                            "signature_delta" => {
                                append(block, "signature", d["signature"].as_str().unwrap_or(""))
                            }
                            "input_json_delta" => append(
                                block,
                                "_partial_json",
                                d["partial_json"].as_str().unwrap_or(""),
                            ),
                            _ => {}
                        }
                    }
                    "error" => {
                        return Err(failure(match v["error"]["type"].as_str() {
                            Some("overloaded_error") => ErrorKind::Overloaded,
                            Some("rate_limit_error") => ErrorKind::RateLimited,
                            _ => ErrorKind::Upstream,
                        }));
                    }
                    _ => {}
                }
            }
            if !complete {
                return Err(failure(ErrorKind::Upstream));
            }
            for (total, n) in totals.iter_mut().zip(usage) {
                *total += n;
            }
            for b in &mut blocks {
                if let Some(partial) = b.as_object_mut().and_then(|o| o.remove("_partial_json")) {
                    b["input"] = serde_json::from_str(partial.as_str().unwrap_or(""))
                        .map_err(|_| failure(ErrorKind::Upstream))?;
                }
            }
            let text = blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<String>();
            let uses: Vec<_> = blocks
                .iter()
                .filter(|b| b["type"] == "tool_use")
                .cloned()
                .collect();
            if stop.as_deref() != Some("tool_use") || uses.is_empty() || last {
                if has_tools && dima_text::trim(&text).is_empty() {
                    if !drop_tools {
                        drop_tools = true;
                        continue;
                    }
                    return Err(failure(ErrorKind::Upstream));
                }
                if !held.is_empty() {
                    handlers.text(&held);
                }
                return Ok(ResultData {
                    content: text,
                    input_tokens: totals[0],
                    output_tokens: totals[1],
                    cache_read_tokens: totals[2],
                    thinking_tokens: totals[3],
                    cost: calculate_minimax_cost(totals[0], totals[1], totals[2]),
                    stop_reason: stop,
                    duration_ms: self.clock.now_ms() - started,
                    model: MODEL.into(),
                    rounds: round,
                    tool_calls: calls,
                });
            }
            if flushed {
                handlers.discard_text();
            }
            conversation.push(Message {
                role: "assistant".into(),
                content: json!(blocks),
            });
            let mut results = Vec::new();
            for use_ in uses {
                let name = use_["name"].as_str().unwrap_or("");
                handlers.tool_call(name, &use_["input"]);
                calls.push(json!({"name":name,"input":use_["input"]}));
                let result = if p.tools.iter().any(|t| t["name"] == name) {
                    tokio::select! { _=cancel.wait()=>return Err(failure(ErrorKind::Aborted)), r=tokio::time::timeout(idle,tools.run(name,use_["input"].clone(),cancel))=>r.map_err(|_|failure(ErrorKind::Timeout))? }
                } else {
                    Err(format!("Unknown tool: {name}"))
                };
                let mut value = json!({"type":"tool_result","tool_use_id":use_["id"]});
                match result {
                    Ok(v) => value["content"] = json!(dima_text::to_js_json(&v)),
                    Err(e) => {
                        value["is_error"] = json!(true);
                        value["content"] = json!(e);
                    }
                }
                results.push(value);
            }
            conversation.push(Message {
                role: "user".into(),
                content: json!(results),
            });
        }
        Err(failure(ErrorKind::Upstream))
    }
}
fn append(v: &mut Value, key: &str, text: &str) {
    let mut s = v[key].as_str().unwrap_or("").to_owned();
    s.push_str(text);
    v[key] = json!(s);
}
fn merge_usage(totals: &mut [f64; 4], v: &Value) {
    for (i, key) in ["input_tokens", "output_tokens", "cache_read_input_tokens"]
        .into_iter()
        .enumerate()
    {
        if let Some(n) = v[key].as_f64().filter(|n| *n > 0.0) {
            totals[i] = n;
        }
    }
    if let Some(n) = v["output_tokens_details"]["thinking_tokens"]
        .as_f64()
        .filter(|n| *n != 0.0)
    {
        totals[3] = n;
    }
}

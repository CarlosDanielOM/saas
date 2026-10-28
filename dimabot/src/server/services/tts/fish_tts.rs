//! Native implementation of the two HTTP routes used by FishTtsService.
//!
//! One deadline covers headers, SDK retries and the entire response body. Caller
//! cancellation also interrupts backoff and prevents another provider attempt.
use std::{
    fmt,
    hash::{BuildHasher, Hasher},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use reqwest::{Client, Response};

use super::{
    http_support::{abort_reason, cancellation, new_client, read_audio, transport_error},
    speech_paths::{SpeechPaths, node_join},
    tts_provider::{TtsSynthesisRequest, TtsSynthesisResult},
};
use crate::utils::{js_string::JsString, openrouter_attribution::OPENROUTER_APP_HEADERS};

#[path = "fish_protocol.rs"]
mod protocol;

/// The narrow three-field MessagePack request used by the installed SDK.
#[doc(hidden)]
pub use protocol::encode_fish_msgpack;

pub const FISH_OPENROUTER_MODEL: &str = "fish-audio/drama-3";
pub const DEFAULT_FISH_TTS_REFERENCE_ID: &str = "7b5626abdaa044babfc3829ec15acf31";
pub const FISH_VOICES: &[(&str, &str)] = &[
    ("gojo", DEFAULT_FISH_TTS_REFERENCE_ID),
    ("rias_gremory", "a5711996953b4cfda57cb516e26fe1e0"),
    ("toji_fushiguro", "51504afe0e93445c9c507451d6ace486"),
    ("carlos_bodoque", "0a6d2732710f466aafa67cdb8db3bf0e"),
];
pub const FISH_VOICE_NAMES: &[&str] = &["gojo", "rias_gremory", "toji_fushiguro", "carlos_bodoque"];
pub const FISH_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(20);
const TIMEOUT_MESSAGE: &str = "Fish Audio TTS timed out";
// Error responses must not allocate without a bound while the provider fails.
const MAX_ERROR_BODY_BYTES: usize = 1024 * 1024;

/// Callers supply the deployed public/speech directory and credentials explicitly.
#[derive(Clone)]
pub struct FishConfig {
    pub paths: SpeechPaths,
    pub openrouter_api_key: Option<String>,
    pub fish_api_key: Option<String>,
    pub openrouter_url: String,
    pub fish_url: String,
    pub attempt_timeout: Duration,
}

impl fmt::Debug for FishConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FishConfig")
            .field("paths", &self.paths)
            .field(
                "openrouter_api_key",
                &self.openrouter_api_key.as_ref().map(|_| "[REDACTED]"),
            )
            .field(
                "fish_api_key",
                &self.fish_api_key.as_ref().map(|_| "[REDACTED]"),
            )
            // Configurable URLs may themselves contain credentials or query secrets.
            .field("openrouter_url", &"[REDACTED]")
            .field("fish_url", &"[REDACTED]")
            .field("attempt_timeout", &self.attempt_timeout)
            .finish()
    }
}

impl FishConfig {
    pub fn new(
        paths: SpeechPaths,
        openrouter_api_key: Option<String>,
        fish_api_key: Option<String>,
    ) -> Self {
        Self {
            paths,
            openrouter_api_key,
            fish_api_key,
            openrouter_url: "https://openrouter.ai/api/v1/audio/speech".into(),
            fish_url: "https://api.fish.audio/v1/tts".into(),
            attempt_timeout: FISH_ATTEMPT_TIMEOUT,
        }
    }
}

#[derive(Clone)]
pub struct FishTtsService {
    client: Client,
    pub config: FishConfig,
}

impl FishTtsService {
    pub fn new(config: FishConfig) -> Self {
        let client = new_client();
        Self { client, config }
    }

    /// An injected client owns its own redirect, proxy, TLS and pooling policy.
    pub fn with_client(config: FishConfig, client: Client) -> Self {
        Self { client, config }
    }
    pub fn name(&self) -> &'static str {
        "fish"
    }

    pub async fn synthesize(&self, request: &TtsSynthesisRequest) -> TtsSynthesisResult {
        if let Some(reason) = abort_reason(&request.signal) {
            return self.failure(reason);
        }
        let output_dir = if request.private_output {
            request
                .output_path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or_else(|| std::path::Path::new("."))
                .to_path_buf()
        } else {
            self.config.paths.output_dir(&request.channel_id)
        };
        if let Err(error) = tokio::fs::create_dir_all(&output_dir).await {
            return self.failure(error.to_string());
        }
        let output_path = if request.private_output {
            request.output_path.clone()
        } else {
            node_join(&output_dir, &format!("{}.mp3", request.speech_id))
        };
        let reference = request.voice.trim();
        let mut failures = Vec::new();
        for backend in [FISH_OPENROUTER_MODEL, "s2.1-pro"]
            .into_iter()
            .take(if request.single_attempt { 1 } else { 2 })
        {
            // Abort may arrive while making the output directory or between attempts.
            if abort_reason(&request.signal).is_some() {
                failures.push(format!("{backend}: {TIMEOUT_MESSAGE}"));
                break;
            }
            let mut signal = request.signal.clone();
            let result = tokio::select! {
                biased;
                _ = cancellation(&mut signal) => Err(TIMEOUT_MESSAGE.to_owned()),
                result = tokio::time::timeout(self.config.attempt_timeout, self.attempt(request, &reference, backend)) => {
                    result.unwrap_or_else(|_| Err(TIMEOUT_MESSAGE.to_owned()))
                },
            };
            match result {
                Ok(audio) => {
                    if let Err(error) = tokio::fs::write(&output_path, audio).await {
                        return self.failure(error.to_string());
                    }
                    return TtsSynthesisResult {
                        error: false,
                        message: format!("Speech synthesized with Fish Audio ({backend})"),
                        output_path: Some(output_path),
                        public_path: (!request.private_output).then(|| {
                            self.config
                                .paths
                                .public_path(&request.channel_id, &request.speech_id)
                        }),
                        mime_type: Some("audio/mpeg"),
                    };
                }
                Err(error) => failures.push(format!("{backend}: {error}")),
            }
            if abort_reason(&request.signal).is_some() {
                break;
            }
        }
        self.failure(format!(
            "Fish Audio TTS failed on all enabled backends: {}",
            failures.join("; ")
        ))
    }

    fn failure(&self, message: String) -> TtsSynthesisResult {
        TtsSynthesisResult::failure(message)
    }

    async fn attempt(
        &self,
        request: &TtsSynthesisRequest,
        reference: &JsString,
        backend: &str,
    ) -> Result<Vec<u8>, String> {
        let mut response = if backend == FISH_OPENROUTER_MODEL {
            let api_key = key(
                &self.config.openrouter_api_key,
                "OpenRouter API key is not configured",
            )?;
            let body = format!(
                "{{\"model\":{},\"input\":{},\"voice\":{},\"response_format\":\"mp3\",\"user\":{}}}",
                json(FISH_OPENROUTER_MODEL),
                request.text.to_json_string(),
                reference.to_json_string(),
                json(&request.channel_id),
            );
            let mut builder = self
                .client
                .post(&self.config.openrouter_url)
                .bearer_auth(api_key)
                .header("Content-Type", "application/json")
                .body(body);
            for (name, value) in OPENROUTER_APP_HEADERS {
                builder = builder.header(*name, *value);
            }
            let response = builder.send().await.map_err(transport_error)?;
            if !response.status().is_success() {
                return Err(format!(
                    "OpenRouter Fish synthesis failed (HTTP {})",
                    response.status().as_u16()
                ));
            }
            if no_body(&response)
                || !response
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|v| v.to_ascii_lowercase().starts_with("audio/mpeg"))
            {
                return Err("OpenRouter Fish returned an unexpected audio format".into());
            }
            response
        } else {
            let api_key = key(
                &self.config.fish_api_key,
                "Fish Audio API key is not configured",
            )?;
            let text = protocol::reinforce_js(&request.text);
            let body = encode_fish_msgpack(&text, reference);
            // Body::from(Vec) owns shared immutable bytes; try_clone below is
            // cheap even when retrying a large synthesis request.
            let template = self
                .client
                .post(&self.config.fish_url)
                .bearer_auth(api_key)
                .header("Content-Type", "application/msgpack")
                .header("model", backend)
                .header("User-Agent", "fish-audio")
                .body(body);
            let mut retry = 0;
            loop {
                let response = template
                    .try_clone()
                    .expect("buffered Fish request is cloneable")
                    .send()
                    .await
                    .map_err(transport_error)?;
                let status = response.status().as_u16();
                if (status == 408 || status == 429 || status >= 500) && retry < 2 {
                    let delay = retry_delay(&response, retry);
                    // Release the failed body before waiting. The outer select
                    // interrupts genuine rate-limit/error backoff on cancellation.
                    drop(response);
                    tokio::time::sleep(delay).await;
                    retry += 1;
                    continue;
                }
                if !(200..400).contains(&status) {
                    return Err(fish_error(response, api_key).await);
                }
                if no_body(&response) {
                    // The SDK returns undefined for a null Fetch body, then the
                    // source readAudioStream tries to acquire its reader.
                    return Err("Cannot read properties of undefined (reading 'getReader')".into());
                }
                break response;
            }
        };
        let result = read_audio(&mut response, request.max_audio_bytes).await?;
        if result.is_empty() {
            return Err(format!(
                "Fish Audio TTS returned empty audio from '{backend}'"
            ));
        }
        Ok(result)
    }
}

fn json(value: &str) -> String {
    JsString::from(value).to_json_string()
}
fn key<'a>(key: &'a Option<String>, missing: &str) -> Result<&'a str, String> {
    key.as_deref()
        .map(crate::utils::js_compat::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| missing.to_owned())
}
fn no_body(response: &Response) -> bool {
    matches!(response.status().as_u16(), 204 | 205 | 304)
}
fn retry_delay(response: &Response, retry: u32) -> Duration {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64;
    let random = std::collections::hash_map::RandomState::new();
    let mut hasher = random.build_hasher();
    hasher.write_u64(now.to_bits());
    // A 53-bit fraction in [0, 1), like Math.random's observable range.
    let unit = (hasher.finish() >> 11) as f64 / (1_u64 << 53) as f64;
    let header = |name| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
    };
    Duration::from_millis(protocol::retry_delay_millis(
        header("retry-after"),
        header("x-ratelimit-reset"),
        retry,
        now,
        unit,
    ))
}
async fn fish_error(mut response: Response, api_key: &str) -> String {
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if chunk.len() > MAX_ERROR_BODY_BYTES.saturating_sub(bytes.len()) {
                    return "Fish Audio error response exceeds byte limit".into();
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(error) => return transport_error(error),
        }
    }
    let message = protocol::fish_error_message(status, content_type.as_deref(), &bytes);
    redact_remote_error_body(message, api_key)
}

fn redact_remote_error_body(message: String, api_key: &str) -> String {
    // Only upstream body content can echo a credential. Redacting the complete
    // diagnostic also changes stable labels when a key is a common word.
    let Some((prefix, body)) = message.split_once("\nBody: ") else {
        return message;
    };
    let mut body = body.to_owned();
    if !api_key.is_empty() {
        body = body.replace(api_key, "[REDACTED]");
        let quoted = JsString::from(api_key).to_json_string();
        body = body.replace(&quoted[1..quoted.len() - 1], "[REDACTED]");
    }
    format!("{prefix}\nBody: {body}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_key_redaction_keeps_diagnostic_labels() {
        assert_eq!(
            redact_remote_error_body("Status code: 400\nBody: \"fish\"".into(), "fish"),
            "Status code: 400\nBody: \"[REDACTED]\""
        );
        let message = "Fish Audio API key is not configured";
        assert_eq!(redact_remote_error_body(message.into(), "Fish"), message);
    }

    #[test]
    fn debug_redacts_keys_and_custom_urls() {
        let mut config = FishConfig::new(
            SpeechPaths::new("/speech".into(), None, false),
            Some("secret-one".into()),
            Some("secret-two".into()),
        );
        config.fish_url = "https://secret-url.test?token=secret-three".into();
        let debug = format!("{config:?}");
        for secret in ["secret-one", "secret-two", "secret-three", "secret-url"] {
            assert!(!debug.contains(secret));
        }
        assert!(debug.contains("[REDACTED]"));
        assert_eq!(FISH_ATTEMPT_TIMEOUT, Duration::from_secs(20));
    }
}

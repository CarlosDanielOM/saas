//! Kokoro's single OpenRouter DeepInfra synthesis route.
use std::{fmt, path::Path, time::Duration};

use reqwest::Client;

use super::{
    http_support::{abort_reason, cancellation, new_client, read_audio, transport_error},
    speech_paths::{SpeechPaths, node_join},
    tts_provider::{TtsSynthesisRequest, TtsSynthesisResult},
};
use crate::utils::{
    js_compat, js_string::JsString, openrouter_attribution::OPENROUTER_APP_HEADERS,
    tts::resolve_kokoro_voice_str,
};

pub const KOKORO_MODEL: &str = "hexgrad/kokoro-82m";
pub const KOKORO_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(20);
const TIMEOUT_MESSAGE: &str = "Kokoro TTS timed out";

#[derive(Clone)]
pub struct KokoroConfig {
    pub paths: SpeechPaths,
    pub openrouter_api_key: Option<String>,
    pub openrouter_url: String,
    pub attempt_timeout: Duration,
}

impl KokoroConfig {
    pub fn new(paths: SpeechPaths, openrouter_api_key: Option<String>) -> Self {
        Self {
            paths,
            openrouter_api_key,
            openrouter_url: "https://openrouter.ai/api/v1/audio/speech".into(),
            attempt_timeout: KOKORO_ATTEMPT_TIMEOUT,
        }
    }
}

impl fmt::Debug for KokoroConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KokoroConfig")
            .field("paths", &self.paths)
            .field(
                "openrouter_api_key",
                &self.openrouter_api_key.as_ref().map(|_| "[REDACTED]"),
            )
            .field("openrouter_url", &"[REDACTED]")
            .field("attempt_timeout", &self.attempt_timeout)
            .finish()
    }
}

#[derive(Clone)]
pub struct KokoroTtsService {
    client: Client,
    pub config: KokoroConfig,
}

impl KokoroTtsService {
    pub fn new(config: KokoroConfig) -> Self {
        Self {
            client: new_client(),
            config,
        }
    }

    /// An injected client owns its redirect, proxy, TLS and pooling policy.
    pub fn with_client(config: KokoroConfig, client: Client) -> Self {
        Self { client, config }
    }

    pub fn name(&self) -> &'static str {
        "kokoro"
    }

    pub async fn synthesize(&self, request: &TtsSynthesisRequest) -> TtsSynthesisResult {
        let Some(key) = self
            .config
            .openrouter_api_key
            .as_deref()
            .map(js_compat::trim)
            .filter(|key| !key.is_empty())
        else {
            return TtsSynthesisResult::failure("OpenRouter API key is not configured".into());
        };
        let voice = request.voice.as_str().and_then(resolve_kokoro_voice_str);
        let Some(voice) = voice else {
            return TtsSynthesisResult::failure("Invalid Kokoro preset voice".into());
        };
        if request.text.trim().is_empty() {
            return TtsSynthesisResult::failure("No text provided".into());
        }
        if let Some(reason) = abort_reason(&request.signal) {
            return TtsSynthesisResult::failure(reason);
        }

        let mut signal = request.signal.clone();
        let audio = tokio::select! {
            biased;
            _ = cancellation(&mut signal) => Err(abort_reason(&request.signal).unwrap_or_else(|| "Kokoro TTS aborted".into())),
            result = tokio::time::timeout(self.config.attempt_timeout, self.attempt(request, key, &voice)) => {
                result.unwrap_or_else(|_| Err(TIMEOUT_MESSAGE.into()))
            }
        };
        let audio = match audio {
            Ok(audio) => audio,
            Err(error) => return TtsSynthesisResult::failure(error),
        };
        let output_dir = if request.private_output {
            request
                .output_path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."))
                .to_path_buf()
        } else {
            self.config.paths.output_dir(&request.channel_id)
        };
        if let Err(error) = tokio::fs::create_dir_all(&output_dir).await {
            return TtsSynthesisResult::failure(error.to_string());
        }
        let output_path = if request.private_output {
            request.output_path.clone()
        } else {
            node_join(&output_dir, &format!("{}.mp3", request.speech_id))
        };
        if let Err(error) = tokio::fs::write(&output_path, audio).await {
            return TtsSynthesisResult::failure(error.to_string());
        }
        TtsSynthesisResult {
            error: false,
            message: "Speech synthesized with Kokoro (DeepInfra)".into(),
            output_path: Some(output_path),
            public_path: (!request.private_output).then(|| {
                self.config
                    .paths
                    .public_path(&request.channel_id, &request.speech_id)
            }),
            mime_type: Some("audio/mpeg"),
        }
    }

    async fn attempt(
        &self,
        request: &TtsSynthesisRequest,
        key: &str,
        voice: &str,
    ) -> Result<Vec<u8>, String> {
        let body = format!(
            "{{\"model\":{},\"input\":{},\"voice\":{},\"response_format\":\"mp3\",\"user\":{},\"provider\":{{\"only\":[\"deepinfra\"],\"order\":[\"deepinfra\"],\"allow_fallbacks\":false}}}}",
            JsString::from(KOKORO_MODEL).to_json_string(),
            request.text.to_json_string(),
            JsString::from(voice).to_json_string(),
            JsString::from(request.channel_id.as_str()).to_json_string(),
        );
        let mut builder = self
            .client
            .post(&self.config.openrouter_url)
            .bearer_auth(key)
            .header("Content-Type", "application/json")
            .body(body);
        for (name, value) in OPENROUTER_APP_HEADERS {
            builder = builder.header(*name, *value);
        }
        let mut response = builder.send().await.map_err(transport_error)?;
        if !response.status().is_success() {
            return Err(format!(
                "Kokoro DeepInfra synthesis failed (HTTP {})",
                response.status().as_u16()
            ));
        }
        if !response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.to_ascii_lowercase().starts_with("audio/mpeg"))
        {
            return Err("Kokoro returned an unexpected audio format".into());
        }
        let audio = read_audio(&mut response, request.max_audio_bytes).await?;
        if audio.is_empty() {
            return Err("Kokoro returned empty audio".into());
        }
        Ok(audio)
    }
}

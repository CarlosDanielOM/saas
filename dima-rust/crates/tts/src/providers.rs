//! Thin HTTP clients: Piper HTTP (30s), OpenRouter (20s), direct Fish (20s total,
//! including its SDK retry policy). Audio is streamed as bounded chunks, never written here.
//! A caller must consume `Audio::chunk` to completion before treating synthesis as successful.
//! Fish failover after a partially consumed stream is owned by `synthesize_buffered`.
//! Keys are secret headers; upstream error bodies are never surfaced for paid providers.
use bytes::Bytes;
use dima_core::{SecretString, Shutdown};
use dima_http::{HttpClient, Provider, ProviderBuilder, Response, RetryPolicy};
use serde_json::json;
use std::time::Duration;

pub const FISH_MODEL: &str = "fish-audio/drama-3";
pub const KOKORO_MODEL: &str = "hexgrad/kokoro-82m";
pub const DEFAULT_MAX_AUDIO_BYTES: u64 = 32 * 1024 * 1024;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Http(#[from] dima_http::Error),
}
#[derive(Clone, Debug)]
pub struct Config {
    pub openrouter_key: Option<SecretString>,
    pub fish_key: Option<SecretString>,
    pub piper_url: String,
}
fn authorized(name: &'static str, url: &str, key: Option<&SecretString>) -> ProviderBuilder {
    let mut builder = Provider::builder(name, url);
    if let Some(key) = key {
        builder = builder.secret_header(
            "authorization",
            &SecretString::new(format!("Bearer {}", dima_text::trim(key.expose()))),
        );
    }
    builder
        .max_bytes(DEFAULT_MAX_AUDIO_BYTES)
        .max_concurrency(16)
}
impl Config {
    pub fn openrouter(&self) -> ProviderBuilder {
        authorized(
            "openrouter",
            "https://openrouter.ai/api/v1",
            self.openrouter_key.as_ref(),
        )
        .header("http-referer", "https://domdimabot.com")
        .header("x-openrouter-title", "DomDimaBot")
        .header(
            "x-openrouter-description",
            "DomDimaBot is a Twitch chat bot that helps make streams more engaging and fun.",
        )
        .header("x-openrouter-categories", "general-chat, roleplay")
        .timeout(Duration::from_secs(20))
    }
    pub fn fish(&self) -> ProviderBuilder {
        authorized("fish", "https://api.fish.audio", self.fish_key.as_ref())
            .timeout(Duration::from_secs(20))
    }
    pub fn piper(&self) -> ProviderBuilder {
        Provider::builder("piper", self.piper_url.trim_end_matches('/'))
            .internal(true)
            .timeout(Duration::from_secs(30))
            .max_bytes(DEFAULT_MAX_AUDIO_BYTES)
            .max_concurrency(16)
    }
}
#[derive(Clone, Debug)]
pub struct Request {
    pub channel_id: String,
    pub text: String,
    pub voice: String,
    pub max_audio_bytes: u64,
    pub single_attempt: bool,
    pub private_output: bool,
    pub cancel: Shutdown,
}
pub struct Audio {
    response: Response,
    pub mime_type: &'static str,
    pub backend: &'static str,
    seen: bool,
    deadline: tokio::time::Instant,
}
impl Audio {
    pub async fn chunk(&mut self) -> Result<Option<Bytes>, Error> {
        let chunk = tokio::time::timeout_at(self.deadline, self.response.chunk())
            .await
            .map_err(|_| Error::Message("Fish Audio TTS timed out".into()))??;
        if chunk.as_ref().is_some_and(|b| !b.is_empty()) {
            self.seen = true;
        }
        if chunk.is_none() && !self.seen && self.backend != "piper" {
            return Err(Error::Message(if self.backend == KOKORO_MODEL {
                "Kokoro returned empty audio".into()
            } else {
                format!(
                    "Fish Audio TTS returned empty audio from '{}'",
                    self.backend
                )
            }));
        }
        Ok(chunk)
    }
    pub async fn bytes(mut self) -> Result<Bytes, Error> {
        let mut out = bytes::BytesMut::new();
        while let Some(chunk) = self.chunk().await? {
            out.extend_from_slice(&chunk);
        }
        Ok(out.freeze())
    }
}
pub trait SpeechProvider: Send + Sync {
    fn synthesize(
        &self,
        request: &Request,
    ) -> impl std::future::Future<Output = Result<Audio, Error>> + Send;
}
#[derive(Clone)]
pub struct Clients {
    pub http: HttpClient,
    pub openrouter: Provider,
    pub fish: Provider,
    pub piper: Provider,
    pub config: Config,
}
impl Clients {
    async fn openrouter_audio(&self, r: &Request, kokoro: bool) -> Result<Audio, Error> {
        if self
            .config
            .openrouter_key
            .as_ref()
            .is_none_or(|k| dima_text::trim(k.expose()).is_empty())
        {
            return Err(Error::Message(
                "OpenRouter API key is not configured".into(),
            ));
        }
        let voice = if kokoro {
            crate::credit_fallback::kokoro_voice(&r.voice)
                .ok_or_else(|| Error::Message("Invalid Kokoro preset voice".into()))?
        } else {
            dima_text::trim(&r.voice).into()
        };
        if kokoro && dima_text::trim(&r.text).is_empty() {
            return Err(Error::Message("No text provided".into()));
        }
        let mut body = json!({"model":if kokoro {KOKORO_MODEL} else {FISH_MODEL},"input":r.text,"voice":voice,"response_format":"mp3","user":r.channel_id});
        if kokoro {
            body["provider"] =
                json!({"only":["deepinfra"],"order":["deepinfra"],"allow_fallbacks":false});
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        let response = self
            .http
            .post(&self.openrouter, "/audio/speech")
            .json(&body)
            .timeout(Duration::from_secs(20))
            .max_bytes(r.max_audio_bytes.min(DEFAULT_MAX_AUDIO_BYTES))
            .cancel_on(&r.cancel)
            .send()
            .await?;
        let name = if kokoro {
            "Kokoro DeepInfra"
        } else {
            "OpenRouter Fish"
        };
        if !response.status().is_success() {
            return Err(Error::Message(format!(
                "{name} synthesis failed (HTTP {})",
                response.status().as_u16()
            )));
        }
        if !response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.to_ascii_lowercase().starts_with("audio/mpeg"))
        {
            return Err(Error::Message(format!(
                "{} returned an unexpected audio format",
                if kokoro { "Kokoro" } else { "OpenRouter Fish" }
            )));
        }
        Ok(Audio {
            response,
            mime_type: "audio/mpeg",
            backend: if kokoro { KOKORO_MODEL } else { FISH_MODEL },
            seen: false,
            deadline,
        })
    }
    pub async fn kokoro(&self, r: &Request) -> Result<Audio, Error> {
        self.openrouter_audio(r, true).await
    }
    pub async fn fish_primary(&self, r: &Request) -> Result<Audio, Error> {
        self.openrouter_audio(r, false).await
    }
    pub async fn fish_direct(&self, r: &Request) -> Result<Audio, Error> {
        if self
            .config
            .fish_key
            .as_ref()
            .is_none_or(|k| dima_text::trim(k.expose()).is_empty())
        {
            return Err(Error::Message(
                "Fish Audio API key is not configured".into(),
            ));
        }
        let body = msgpack(&crate::tags::reinforce(&r.text), dima_text::trim(&r.voice))?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        let response = tokio::time::timeout_at(
            deadline,
            self.http
                .post(&self.fish, "/v1/tts")
                .header("model", "s2.1-pro")
                .header("content-type", "application/msgpack")
                .body(body)
                .retry(
                    RetryPolicy::exponential(
                        3,
                        Duration::from_secs(1),
                        2.0,
                        Duration::from_secs(60),
                    )
                    .retry_statuses(
                        dima_http::retry::StatusSet::new()
                            .with(408)
                            .with(429)
                            .with_range(500, 599),
                    )
                    .retry_failures(false, false, false)
                    .retry_non_idempotent(true)
                    .jitter(dima_http::retry::Jitter::Scale {
                        low: 0.9,
                        high: 1.1,
                    })
                    .server_delay(dima_http::retry::ServerDelay::retry_after(
                        Duration::from_secs(60),
                    )),
                )
                .timeout(Duration::from_secs(20))
                .max_bytes(r.max_audio_bytes.min(DEFAULT_MAX_AUDIO_BYTES))
                .cancel_on(&r.cancel)
                .send(),
        )
        .await
        .map_err(|_| Error::Message("Fish Audio TTS timed out".into()))??;
        if !response.status().is_success() {
            return Err(Error::Message(format!(
                "Fish Audio synthesis failed (HTTP {})",
                response.status().as_u16()
            )));
        }
        Ok(Audio {
            response,
            mime_type: "audio/mpeg",
            backend: "s2.1-pro",
            seen: false,
            deadline,
        })
    }
    pub async fn piper(&self, r: &Request) -> Result<Audio, Error> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        let response = self
            .http
            .post(&self.piper, "/synthesize")
            .json(&json!({"text":r.text,"voice":r.voice}))
            .timeout(Duration::from_secs(30))
            .max_bytes(r.max_audio_bytes.min(DEFAULT_MAX_AUDIO_BYTES))
            .cancel_on(&r.cancel)
            .send()
            .await?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = if r.private_output {
                String::new()
            } else {
                response.max_bytes(65536).text().await?
            };
            return Err(Error::Message(if body.is_empty() {
                format!("Piper HTTP synthesis failed with {status}")
            } else {
                body
            }));
        }
        Ok(Audio {
            response,
            mime_type: "audio/wav",
            backend: "piper",
            seen: false,
            deadline,
        })
    }
    /// Preserve failover even when primary fails during body consumption. Bounded memory, no files.
    pub async fn synthesize_buffered(
        &self,
        r: &Request,
        provider: &str,
    ) -> Result<(Bytes, &'static str), Error> {
        match provider {
            "piper" => Ok((self.piper(r).await?.bytes().await?, "audio/wav")),
            "kokoro" => Ok((self.kokoro(r).await?.bytes().await?, "audio/mpeg")),
            _ => {
                let first = match self.fish_primary(r).await {
                    Ok(a) => a.bytes().await,
                    Err(e) => Err(e),
                };
                match first {
                    Ok(b) => Ok((b, "audio/mpeg")),
                    Err(e) if r.single_attempt => Err(Error::Message(format!(
                        "Fish Audio TTS failed on all enabled backends: {FISH_MODEL}: {e}"
                    ))),
                    Err(first) => {
                        let second = match self.fish_direct(r).await {
                            Ok(a) => a.bytes().await,
                            Err(e) => Err(e),
                        };
                        second.map(|b|(b,"audio/mpeg")).map_err(|e|Error::Message(format!("Fish Audio TTS failed on all enabled backends: {FISH_MODEL}: {first}; s2.1-pro: {e}")))
                    }
                }
            }
        }
    }
}
/// Local MessagePack encoder: the shared HTTP crate has no MessagePack codec. Only a fixed
/// three-string map is needed; field order matches @msgpack/msgpack. Lengths here are wire bytes.
fn msgpack(text: &str, voice: &str) -> Result<Vec<u8>, Error> {
    fn string(out: &mut Vec<u8>, s: &str) -> Result<(), Error> {
        let n = s.len();
        if n < 32 {
            out.push(0xa0 | n as u8);
        } else if n <= 255 {
            out.extend_from_slice(&[0xd9, n as u8]);
        } else if n <= 65535 {
            out.push(0xda);
            out.extend_from_slice(&(n as u16).to_be_bytes());
        } else {
            let n = u32::try_from(n)
                .map_err(|_| Error::Message("Fish text exceeds wire limit".into()))?;
            out.push(0xdb);
            out.extend_from_slice(&n.to_be_bytes());
        }
        out.extend_from_slice(s.as_bytes());
        Ok(())
    }
    let mut out = vec![0x83];
    for s in ["text", text, "reference_id", voice, "format", "mp3"] {
        string(&mut out, s)?;
    }
    Ok(out)
}

pub struct Piper<'a>(pub &'a Clients);
pub struct Kokoro<'a>(pub &'a Clients);
impl SpeechProvider for Piper<'_> {
    async fn synthesize(&self, r: &Request) -> Result<Audio, Error> {
        self.0.piper(r).await
    }
}
impl SpeechProvider for Kokoro<'_> {
    async fn synthesize(&self, r: &Request) -> Result<Audio, Error> {
        self.0.kokoro(r).await
    }
}
/// Streaming Fish primary. Use `Clients::synthesize_buffered` when automatic failover is needed.
pub struct Fish<'a>(pub &'a Clients);
impl SpeechProvider for Fish<'_> {
    async fn synthesize(&self, r: &Request) -> Result<Audio, Error> {
        self.0.fish_primary(r).await
    }
}

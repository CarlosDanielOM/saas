//! Prepare the default speech payload and hand it to the later overlay queue package.
//! Settings are supplied through dima-model's read type: no parallel Mongo model or writer.
//! Usage accounting belongs to the queue consumer; it must call `billable_characters` on the
//! final text as the reference does, before provider-only Fish cue reinforcement.
use crate::{normalize, tags};
use dima_model::channel_tts_settings::ChannelTtsSettings;
use serde_json::{Value, json};
#[derive(Clone, Debug)]
pub struct Input {
    pub channel_id: String,
    pub raw_message: String,
    pub source: String,
    pub preferred_mode: Option<String>,
    pub clone_name: Option<String>,
    pub language: Option<String>,
    pub user_id: Option<String>,
    pub user_login: Option<String>,
    pub user_name: Option<String>,
    pub user_level: Option<f64>,
    pub emote_names: Option<Vec<String>>,
    pub emote_ranges: Option<Vec<String>>,
}
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct Rejected {
    pub status: u16,
    pub message: String,
}
/// Later overlay package implements only submission; it owns admission, ids and accounting.
pub trait SpeechQueue: Send + Sync {
    fn request(
        &self,
        channel: &str,
        payload: Value,
    ) -> impl std::future::Future<Output = Result<Value, Rejected>> + Send;
}
/// The settings service implements this with the shared channel_tts_settings read model.
pub trait Settings: Send + Sync {
    fn get(
        &self,
        channel: &str,
    ) -> impl std::future::Future<Output = Result<ChannelTtsSettings, Rejected>> + Send;
}
/// Emote lookup is supplied by `emote_names::EmoteNames` or another test implementation.
pub trait EmoteNames: Send + Sync {
    fn names(&self, channel: &str) -> impl std::future::Future<Output = Vec<String>> + Send;
}
fn reject(status: u16, message: &str) -> Rejected {
    Rejected {
        status,
        message: message.into(),
    }
}
async fn queue_inner(
    input: &Input,
    settings: &impl Settings,
    emotes: &impl EmoteNames,
    queue: &impl SpeechQueue,
) -> Result<Value, Rejected> {
    let raw = dima_text::trim(&input.raw_message);
    if raw.is_empty() {
        return Err(reject(400, "No message provided"));
    }
    let settings = settings.get(&input.channel_id).await?;
    if !settings.enabled {
        return Err(reject(403, "TTS is disabled for this channel"));
    }
    let names = if let Some(names) = &input.emote_names {
        names.clone()
    } else if let Some(ranges) = &input.emote_ranges {
        normalize::extract_emote_names(raw, ranges)
    } else if settings.filters.skip_emotes {
        emotes.names(&input.channel_id).await
    } else {
        Vec::new()
    };
    let (mode, provider) = match input.preferred_mode.as_deref().unwrap_or("default") {
        "clone" => ("clone", "fish"),
        "kokoro" => ("speak", "kokoro"),
        "speak" => ("speak", "piper"),
        _ => (
            if settings.provider.as_str() == "fish" {
                "clone"
            } else {
                "speak"
            },
            settings.provider.as_str(),
        ),
    };
    let stored = &settings.filters.expressive_tags;
    let mut flags = serde_json::Map::new();
    for (tag, on) in &stored.stored {
        flags.insert(tag.clone(), json!(on));
    }
    if let Some(inline) = &stored.legacy_inline {
        flags.insert(
            "inline".into(),
            serde_json::to_value(inline).unwrap_or(Value::Null),
        );
    }
    if let Some(wrapping) = &stored.legacy_wrapping {
        flags.insert(
            "wrapping".into(),
            serde_json::to_value(wrapping).unwrap_or(Value::Null),
        );
    }
    let enabled = tags::normalize_settings(&Value::Object(flags));
    let filtered = tags::filter(raw, provider, &enabled);
    let normalized = normalize::normalize(
        &filtered,
        &normalize::Options {
            skip_emotes: settings.filters.skip_emotes,
            strip_links: settings.filters.strip_links,
            normalize_whitespace: settings.filters.normalize_whitespace,
            max_length: settings.filters.max_length.0.max(0.0) as usize,
            emote_names: names,
        },
    );
    if normalized.error {
        return Err(reject(400, &normalized.message));
    }
    let language = input
        .language
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(settings.default_language.as_str());
    let name = dima_text::trim(
        input
            .user_name
            .as_deref()
            .filter(|s| !s.is_empty())
            .or(input.user_login.as_deref())
            .unwrap_or_default(),
    );
    let spoken = normalize::spoken_user_message(name, &normalized.text, language, &input.source);
    let mut by = json!({"userName":name});
    if let Some(id) = &input.user_id {
        by["userID"] = json!(id);
    }
    if let Some(login) = &input.user_login {
        by["userLogin"] = json!(login);
    }
    if let Some(level) = input.user_level {
        by["userLevel"] = json!(level);
    }
    let mut payload = json!({"mode":mode,"provider":provider,"text":spoken,"language":language,"requestedBy":by,"meta":{"source":input.source,"originalText":raw,"skipEmotes":settings.filters.skip_emotes,"stripLinks":settings.filters.strip_links}});
    if let Some(clone) = input.clone_name.as_deref().filter(|s| !s.is_empty()) {
        payload[if provider == "kokoro" {
            "voice"
        } else {
            "cloneName"
        }] = json!(clone);
    }
    queue.request(&input.channel_id, payload).await
}

/// Bound the composed operation as well as the store/HTTP calls made by its dependencies.
pub async fn queue(
    input: &Input,
    settings: &impl Settings,
    emotes: &impl EmoteNames,
    queue: &impl SpeechQueue,
) -> Result<Value, Rejected> {
    tokio::time::timeout(
        std::time::Duration::from_secs(60),
        queue_inner(input, settings, emotes, queue),
    )
    .await
    .map_err(|_| reject(503, "TTS request timed out"))?
}

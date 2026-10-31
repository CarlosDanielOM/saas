//! Default TTS queue decision logic and its wiring.
//!
//! Ported from `dimabot/src/utils/tts/queue_default_tts.util.ts`.
//!
//! Operational rules preserved:
//!
//! * Mode/provider resolution: `clone` selects Fish in clone mode, `kokoro`
//!   selects Kokoro in speak mode, `speak` forces Piper, and the default mode
//!   maps a Fish channel setting to clone/Fish and every other provider to
//!   speak.
//! * The display name is `userName || userLogin || ""`, trimmed.
//! * Emote names are the explicit input when supplied, otherwise extracted from
//!   the request's emote ranges, otherwise the channel catalog when emotes are
//!   skipped, otherwise empty.
//! * Disabled expressive cues are removed **before** truncation so a partially
//!   removed tag cannot be spoken.
//! * An empty raw message and a fully filtered message both answer 400, and a
//!   disabled channel answers 403, without calling the speech API.
//!
//! Text normalization, tag filtering and emote extraction are reused from
//! [`crate::utils::tts`]; this module never re-implements them. Settings come
//! from the shared `channel_tts_settings` schema and emote names from the
//! shared Twitch emote catalog. Construction performs no I/O: the database,
//! emote runtime and speech client are injected.

use super::tts_client::{
    RequestedBy, SpeechClient, SpeechFuture, SpeechResponse, TtsMeta, TtsRequestBody,
};
use crate::schemas::channel_tts_settings::{bson_to_settings_json, get_channel_tts_settings};
use crate::utils::{
    js_string::JsString,
    lossless_json::{JsonValue, truthy},
    tts::{
        NormalizeTtsMessageOptions, SpeechSource, TtsLanguage, TtsMode, TtsProvider,
        build_spoken_user_message_js, extract_emote_names_js, filter_expressive_tts_tags_js,
        normalize_tts_message_js,
        settings::normalize_channel_tts_settings,
    },
    tts_defaults::{PIPER_VOICE_EN, PIPER_VOICE_ES},
    twitch_emotes::TwitchEmoteRuntime,
};
use mongodb::{
    Database,
    bson::Bson,
};
use std::{
    collections::BTreeMap,
    fmt,
    sync::Arc,
};

/// `preferredMode` of the source input.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PreferredTtsMode {
    #[default]
    Default,
    Speak,
    Clone,
    Kokoro,
}

impl PreferredTtsMode {
    /// Parse the source's string union; absent and unknown values are
    /// `default`, matching `input.preferredMode || 'default'`.
    pub fn from_name(name: Option<&str>) -> Self {
        match name {
            Some("speak") => Self::Speak,
            Some("clone") => Self::Clone,
            Some("kokoro") => Self::Kokoro,
            _ => Self::Default,
        }
    }
}

/// A resolved request mode and provider pair.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResolvedTtsMode {
    pub mode: TtsMode,
    pub provider: TtsProvider,
}

/// `resolveTtsMode`.
pub fn resolve_tts_mode(
    preferred: PreferredTtsMode,
    settings_provider: TtsProvider,
) -> ResolvedTtsMode {
    match preferred {
        PreferredTtsMode::Clone => ResolvedTtsMode {
            mode: TtsMode::Clone,
            provider: TtsProvider::Fish,
        },
        PreferredTtsMode::Kokoro => ResolvedTtsMode {
            mode: TtsMode::Speak,
            provider: TtsProvider::Kokoro,
        },
        PreferredTtsMode::Speak => ResolvedTtsMode {
            mode: TtsMode::Speak,
            provider: TtsProvider::Piper,
        },
        PreferredTtsMode::Default => {
            if settings_provider == TtsProvider::Fish {
                ResolvedTtsMode {
                    mode: TtsMode::Clone,
                    provider: TtsProvider::Fish,
                }
            } else {
                ResolvedTtsMode {
                    mode: TtsMode::Speak,
                    provider: settings_provider,
                }
            }
        }
    }
}

/// `String(userName || userLogin || '').trim()`. An empty user name is falsy in
/// JavaScript, so it falls through to the login.
pub fn resolve_display_name(
    user_name: Option<&JsString>,
    user_login: Option<&JsString>,
) -> JsString {
    user_name
        .filter(|value| !value.is_empty())
        .or_else(|| user_login.filter(|value| !value.is_empty()))
        .cloned()
        .unwrap_or_else(|| JsString::from(""))
        .trim()
}

/// Where the emote-name list comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EmoteNamesPlan {
    Explicit,
    ExtractEmotes,
    LoadCatalog,
    Empty,
}

/// `input.emoteNames ?? (input.emotes ? … : skipEmotes ? … : [])`.
pub fn plan_emote_names(has_explicit: bool, has_emotes: bool, skip_emotes: bool) -> EmoteNamesPlan {
    if has_explicit {
        EmoteNamesPlan::Explicit
    } else if has_emotes {
        EmoteNamesPlan::ExtractEmotes
    } else if skip_emotes {
        EmoteNamesPlan::LoadCatalog
    } else {
        EmoteNamesPlan::Empty
    }
}

fn provider_from_json(value: Option<&JsonValue>) -> TtsProvider {
    match value {
        Some(JsonValue::String(value)) => match value.as_str() {
            Some("fish") => TtsProvider::Fish,
            Some("kokoro") => TtsProvider::Kokoro,
            // The source's sanitizeProvider fallback is Piper.
            _ => TtsProvider::Piper,
        },
        _ => TtsProvider::Piper,
    }
}

fn language_from_json(value: Option<&JsonValue>, fallback: TtsLanguage) -> TtsLanguage {
    match value {
        Some(JsonValue::String(value)) => match value.as_str() {
            Some("en") => TtsLanguage::En,
            Some("es") => TtsLanguage::Es,
            _ => fallback,
        },
        _ => fallback,
    }
}

fn text_or(value: Option<&JsonValue>, fallback: &str) -> JsString {
    match value {
        Some(JsonValue::String(value)) if !value.is_empty() => value.clone(),
        _ => JsString::from(fallback),
    }
}

fn boolean_or(value: Option<&JsonValue>, fallback: bool) -> bool {
    match value {
        Some(JsonValue::Bool(value)) => *value,
        _ => fallback,
    }
}

fn number_or(value: Option<&JsonValue>, fallback: f64) -> f64 {
    match value {
        Some(JsonValue::Number(value)) => *value,
        _ => fallback,
    }
}

/// The `filters` members the source reads.
#[derive(Clone, Debug, PartialEq)]
pub struct QueueDefaultTtsFilters {
    pub skip_emotes: bool,
    pub strip_links: bool,
    pub normalize_whitespace: bool,
    pub max_length: f64,
    /// Only a literal `true` enables a canonical expressive tag, which is
    /// exactly what [`filter_expressive_tts_tags_js`] requires.
    pub expressive_tags: BTreeMap<String, bool>,
}

/// The `voices` members the source reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueueDefaultTtsVoices {
    pub en: JsString,
    pub es: JsString,
    pub clone_default: JsString,
    pub kokoro_default: JsString,
}

impl QueueDefaultTtsVoices {
    pub fn for_language(&self, language: TtsLanguage) -> &JsString {
        match language {
            TtsLanguage::En => &self.en,
            TtsLanguage::Es => &self.es,
        }
    }
}

/// The `ChannelTtsSettingsData` members this port needs. `enabled` stays a JSON
/// value because the source tests it for JavaScript truthiness.
#[derive(Clone, Debug, PartialEq)]
pub struct QueueDefaultTtsSettings {
    pub enabled: JsonValue,
    pub provider: TtsProvider,
    pub default_language: TtsLanguage,
    pub voices: QueueDefaultTtsVoices,
    pub filters: QueueDefaultTtsFilters,
}

impl QueueDefaultTtsSettings {
    pub fn is_enabled(&self) -> bool {
        truthy(&self.enabled)
    }
}

/// Read the normalized settings tree. This accepts the output of the schema's
/// own boundary — [`crate::schemas::channel_tts_settings::bson_to_settings_json`]
/// followed by
/// [`crate::utils::tts::settings::normalize_channel_tts_settings`] — which is
/// exactly what [`crate::schemas::channel_tts_settings::get_channel_tts_settings`]
/// returns. Raw documents go through [`settings_from_bson`] instead.
pub fn settings_from_json(
    value: &JsonValue,
) -> Result<QueueDefaultTtsSettings, QueueDefaultTtsError> {
    let JsonValue::Object(_) = value else {
        return Err(QueueDefaultTtsError::settings(
            "normalized channel TTS settings must be an object",
        ));
    };
    let voices = value.get("voices");
    let filters = value.get("filters");
    let mut expressive_tags = BTreeMap::new();
    if let Some(JsonValue::Object(entries)) = filters.and_then(|value| value.get("expressiveTags"))
    {
        for (tag, enabled) in entries {
            if let Some(tag) = tag.as_str() {
                expressive_tags.insert(tag.to_owned(), boolean_or(Some(enabled), false));
            }
        }
    }
    Ok(QueueDefaultTtsSettings {
        enabled: value.get("enabled").cloned().unwrap_or(JsonValue::Bool(true)),
        provider: provider_from_json(value.get("provider")),
        default_language: language_from_json(
            value.get("defaultLanguage"),
            TtsLanguage::Es,
        ),
        voices: QueueDefaultTtsVoices {
            en: text_or(voices.and_then(|value| value.get("en")), PIPER_VOICE_EN),
            es: text_or(voices.and_then(|value| value.get("es")), PIPER_VOICE_ES),
            clone_default: text_or(
                voices.and_then(|value| value.get("cloneDefault")),
                "gojo",
            ),
            kokoro_default: text_or(
                voices.and_then(|value| value.get("kokoroDefault")),
                crate::utils::tts::DEFAULT_KOKORO_VOICE_ES,
            ),
        },
        filters: QueueDefaultTtsFilters {
            skip_emotes: boolean_or(filters.and_then(|value| value.get("skipEmotes")), true),
            strip_links: boolean_or(filters.and_then(|value| value.get("stripLinks")), true),
            normalize_whitespace: boolean_or(
                filters.and_then(|value| value.get("normalizeWhitespace")),
                true,
            ),
            max_length: number_or(filters.and_then(|value| value.get("maxLength")), 280.0),
            expressive_tags,
        },
    })
}

/// Decode a raw settings document through the repository's own boundary, then
/// read the normalized tree. A legacy or hand-written document is therefore
/// handled by `bson_to_settings_json` and `normalize_channel_tts_settings`
/// rather than by a private guess about its shape.
pub fn settings_from_bson(
    document: &Bson,
    channel_id: &JsString,
    channel: &JsString,
) -> Result<QueueDefaultTtsSettings, QueueDefaultTtsError> {
    let decoded = bson_to_settings_json(document)
        .map_err(|error| QueueDefaultTtsError::settings(error.to_string()))?;
    let normalized = normalize_channel_tts_settings(Some(&decoded), channel_id, channel)
        .map_err(|error| QueueDefaultTtsError::settings(error.to_string()))?;
    settings_from_json(&normalized)
}

/// A `queueDefaultTts` input. Every optional member mirrors the source.
#[derive(Clone, Debug, PartialEq)]
pub struct QueueDefaultTtsInput {
    pub channel_id: JsString,
    pub raw_message: JsString,
    pub source: SpeechSource,
    pub preferred_mode: PreferredTtsMode,
    pub clone_name: Option<JsString>,
    pub user_id: Option<JsString>,
    pub user_login: Option<JsString>,
    pub user_name: Option<JsString>,
    pub user_level: Option<f64>,
    pub language: Option<TtsLanguage>,
    pub emotes: Option<Vec<Vec<JsString>>>,
    pub emote_names: Option<Vec<JsString>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueueDefaultTtsError {
    pub operation: &'static str,
    pub message: String,
}

impl QueueDefaultTtsError {
    pub fn settings(message: impl Into<String>) -> Self {
        Self {
            operation: "getChannelTtsSettings",
            message: message.into(),
        }
    }

    pub fn emotes(message: impl Into<String>) -> Self {
        Self {
            operation: "getTtsEmoteNames",
            message: message.into(),
        }
    }
}

impl fmt::Display for QueueDefaultTtsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} failed: {}", self.operation, self.message)
    }
}

impl std::error::Error for QueueDefaultTtsError {}

/// Channel settings loader seam.
pub trait TtsSettingsSource: Send + Sync {
    fn settings<'a>(
        &'a self,
        channel_id: &'a JsString,
    ) -> SpeechFuture<'a, Result<QueueDefaultTtsSettings, QueueDefaultTtsError>>;
}

/// Concrete MongoDB adapter over the shared `channel_tts_settings` schema. The
/// source calls `getChannelTtsSettings(channelID)` with the empty channel name
/// default.
pub struct MongoTtsSettingsSource {
    database: Database,
}

impl MongoTtsSettingsSource {
    pub fn new(database: Database) -> Self {
        Self { database }
    }
}

impl TtsSettingsSource for MongoTtsSettingsSource {
    fn settings<'a>(
        &'a self,
        channel_id: &'a JsString,
    ) -> SpeechFuture<'a, Result<QueueDefaultTtsSettings, QueueDefaultTtsError>> {
        Box::pin(async move {
            let channel = JsString::from("");
            let value = get_channel_tts_settings(&self.database, channel_id, &channel)
                .await
                .map_err(|error| QueueDefaultTtsError::settings(error.to_string()))?;
            settings_from_json(&value)
        })
    }
}

/// Channel emote-name seam.
pub trait TtsEmoteSource: Send + Sync {
    fn emote_names<'a>(
        &'a self,
        channel_id: &'a JsString,
    ) -> SpeechFuture<'a, Result<Vec<JsString>, QueueDefaultTtsError>>;
}

/// Concrete adapter over the shared Twitch emote catalog, which already ports
/// `getTtsEmoteNames`: global names precede channel names with Set order.
pub struct TwitchEmoteNamesSource {
    runtime: Arc<TwitchEmoteRuntime>,
}

impl TwitchEmoteNamesSource {
    pub fn new(runtime: Arc<TwitchEmoteRuntime>) -> Self {
        Self { runtime }
    }
}

impl TtsEmoteSource for TwitchEmoteNamesSource {
    fn emote_names<'a>(
        &'a self,
        channel_id: &'a JsString,
    ) -> SpeechFuture<'a, Result<Vec<JsString>, QueueDefaultTtsError>> {
        Box::pin(async move { Ok(self.runtime.get_tts_emote_names(channel_id).await) })
    }
}

/// Speech request seam.
pub trait TtsRequester: Send + Sync {
    fn request<'a>(
        &'a self,
        channel_id: &'a JsString,
        payload: &'a TtsRequestBody,
    ) -> SpeechFuture<'a, SpeechResponse>;
}

/// Concrete adapter over [`SpeechClient`], which owns the single-attempt HTTP
/// call and the source's response mapping.
pub struct SpeechApiRequester {
    client: SpeechClient,
}

impl SpeechApiRequester {
    pub fn new(client: SpeechClient) -> Self {
        Self { client }
    }
}

impl TtsRequester for SpeechApiRequester {
    fn request<'a>(
        &'a self,
        channel_id: &'a JsString,
        payload: &'a TtsRequestBody,
    ) -> SpeechFuture<'a, SpeechResponse> {
        Box::pin(async move {
            let channel = channel_id.to_utf8_lossy();
            self.client.request_tts(&channel, payload).await
        })
    }
}

/// Build the `TtsRequestBody` of `queueDefaultTts`. `cloneName` becomes `voice`
/// for Kokoro and stays `cloneName` for every other provider; an empty clone
/// name is falsy and adds neither member.
pub fn build_tts_request(
    input: &QueueDefaultTtsInput,
    resolved: ResolvedTtsMode,
    settings: &QueueDefaultTtsSettings,
    spoken: JsString,
    language: TtsLanguage,
) -> TtsRequestBody {
    let clone_name = input
        .clone_name
        .as_ref()
        .filter(|value| !value.is_empty());
    let (voice, clone_name) = match (clone_name, resolved.provider) {
        (Some(name), TtsProvider::Kokoro) => (Some(name.clone()), None),
        (Some(name), _) => (None, Some(name.clone())),
        (None, _) => (None, None),
    };
    TtsRequestBody {
        mode: resolved.mode,
        provider: Some(resolved.provider),
        text: spoken,
        language: Some(language),
        voice,
        clone_name,
        requested_by: Some(RequestedBy {
            user_id: input.user_id.clone(),
            user_login: input.user_login.clone(),
            user_name: Some(resolve_display_name(
                input.user_name.as_ref(),
                input.user_login.as_ref(),
            )),
            user_level: input.user_level,
        }),
        meta: Some(TtsMeta {
            source: Some(input.source),
            original_text: Some(input.raw_message.trim()),
            skip_emotes: Some(settings.filters.skip_emotes),
            strip_links: Some(settings.filters.strip_links),
        }),
    }
}

fn error_response(message: &str, status: u16) -> SpeechResponse {
    SpeechResponse {
        error: true,
        message: Some(JsonValue::String(message.into())),
        status: Some(JsonValue::Number(f64::from(status))),
        kind: Some("error"),
        data: None,
    }
}

fn no_message_response() -> SpeechResponse {
    error_response("No message provided", 400)
}

/// The injectable `queueDefaultTts` orchestrator.
#[derive(Clone)]
pub struct DefaultTtsQueue {
    settings: Arc<dyn TtsSettingsSource>,
    emotes: Arc<dyn TtsEmoteSource>,
    speech: Arc<dyn TtsRequester>,
}

impl DefaultTtsQueue {
    /// Isolated construction for fixtures and alternate adapters.
    pub fn with_adapters(
        settings: Arc<dyn TtsSettingsSource>,
        emotes: Arc<dyn TtsEmoteSource>,
        speech: Arc<dyn TtsRequester>,
    ) -> Self {
        Self {
            settings,
            emotes,
            speech,
        }
    }

    /// Complete application wiring: the shared schema, the shared emote
    /// catalog and the speech API client.
    pub fn native(
        database: Database,
        emote_runtime: Arc<TwitchEmoteRuntime>,
        speech: SpeechClient,
    ) -> Self {
        Self::with_adapters(
            Arc::new(MongoTtsSettingsSource::new(database)),
            Arc::new(TwitchEmoteNamesSource::new(emote_runtime)),
            Arc::new(SpeechApiRequester::new(speech)),
        )
    }

    /// Port of `queueDefaultTts`. Adapter failures propagate as typed errors;
    /// the source's own rejections do the same.
    pub async fn queue(
        &self,
        input: &QueueDefaultTtsInput,
    ) -> Result<SpeechResponse, QueueDefaultTtsError> {
        let raw_message = input.raw_message.trim();
        if raw_message.is_empty() {
            return Ok(no_message_response());
        }
        let settings = self.settings.settings(&input.channel_id).await?;
        if !settings.is_enabled() {
            return Ok(error_response("TTS is disabled for this channel", 403));
        }
        let plan = plan_emote_names(
            input.emote_names.is_some(),
            input.emotes.is_some(),
            settings.filters.skip_emotes,
        );
        let emote_names = match plan {
            EmoteNamesPlan::Explicit => input.emote_names.clone().unwrap_or_default(),
            EmoteNamesPlan::ExtractEmotes => input
                .emotes
                .as_deref()
                .map(|emotes| extract_emote_names_js(&raw_message, emotes))
                .unwrap_or_default(),
            EmoteNamesPlan::LoadCatalog => self.emotes.emote_names(&input.channel_id).await?,
            EmoteNamesPlan::Empty => Vec::new(),
        };
        let resolved = resolve_tts_mode(input.preferred_mode, settings.provider);
        // Disabled cues are removed before truncation so a partial tag cannot
        // be spoken.
        let filtered = filter_expressive_tts_tags_js(
            &raw_message,
            resolved.provider,
            Some(&settings.filters.expressive_tags),
        );
        let normalized = normalize_tts_message_js(
            &filtered,
            &NormalizeTtsMessageOptions {
                skip_emotes: settings.filters.skip_emotes,
                strip_links: settings.filters.strip_links,
                normalize_whitespace: settings.filters.normalize_whitespace,
                max_length: settings.filters.max_length,
                emote_names: &emote_names,
            },
        );
        if normalized.error {
            return Ok(error_response(normalized.message, 400));
        }
        let language = input.language.unwrap_or(settings.default_language);
        let spoken = build_spoken_user_message_js(
            &resolve_display_name(input.user_name.as_ref(), input.user_login.as_ref()),
            &normalized.text,
            language,
            input.source,
        );
        if spoken.trim().is_empty() {
            return Ok(no_message_response());
        }
        let payload = build_tts_request(input, resolved, &settings, spoken, language);
        Ok(self.speech.request(&input.channel_id, &payload).await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn text(value: &str) -> JsString {
        JsString::from(value)
    }

    #[test]
    fn default_mode_follows_the_channel_provider() {
        assert_eq!(
            resolve_tts_mode(PreferredTtsMode::Default, TtsProvider::Piper),
            ResolvedTtsMode {
                mode: TtsMode::Speak,
                provider: TtsProvider::Piper
            }
        );
        assert_eq!(
            resolve_tts_mode(PreferredTtsMode::Default, TtsProvider::Fish),
            ResolvedTtsMode {
                mode: TtsMode::Clone,
                provider: TtsProvider::Fish
            }
        );
        assert_eq!(
            resolve_tts_mode(PreferredTtsMode::Default, TtsProvider::Kokoro),
            ResolvedTtsMode {
                mode: TtsMode::Speak,
                provider: TtsProvider::Kokoro
            }
        );
    }

    #[test]
    fn explicit_modes_override_the_channel_provider() {
        assert_eq!(
            resolve_tts_mode(PreferredTtsMode::Clone, TtsProvider::Piper),
            ResolvedTtsMode {
                mode: TtsMode::Clone,
                provider: TtsProvider::Fish
            }
        );
        assert_eq!(
            resolve_tts_mode(PreferredTtsMode::Kokoro, TtsProvider::Fish),
            ResolvedTtsMode {
                mode: TtsMode::Speak,
                provider: TtsProvider::Kokoro
            }
        );
        assert_eq!(
            resolve_tts_mode(PreferredTtsMode::Speak, TtsProvider::Fish),
            ResolvedTtsMode {
                mode: TtsMode::Speak,
                provider: TtsProvider::Piper
            }
        );
    }

    #[test]
    fn preferred_mode_names_match_the_source_union() {
        assert_eq!(
            PreferredTtsMode::from_name(Some("kokoro")),
            PreferredTtsMode::Kokoro
        );
        assert_eq!(
            PreferredTtsMode::from_name(Some("unknown")),
            PreferredTtsMode::Default
        );
        assert_eq!(PreferredTtsMode::from_name(None), PreferredTtsMode::Default);
    }

    #[test]
    fn display_name_prefers_a_non_empty_user_name() {
        assert_eq!(
            resolve_display_name(Some(&text(" Dima ")), Some(&text("login"))),
            text("Dima")
        );
        assert_eq!(
            resolve_display_name(Some(&text("")), Some(&text(" login "))),
            text("login")
        );
        assert_eq!(resolve_display_name(None, None), text(""));
    }

    #[test]
    fn emote_plan_follows_the_nullish_chain() {
        assert_eq!(plan_emote_names(true, true, true), EmoteNamesPlan::Explicit);
        assert_eq!(
            plan_emote_names(false, true, true),
            EmoteNamesPlan::ExtractEmotes
        );
        assert_eq!(
            plan_emote_names(false, false, true),
            EmoteNamesPlan::LoadCatalog
        );
        assert_eq!(plan_emote_names(false, false, false), EmoteNamesPlan::Empty);
    }

    #[test]
    fn settings_reader_applies_source_fallbacks() {
        let settings = settings_from_json(&JsonValue::Object(vec![(
            "provider".into(),
            JsonValue::String(text("kokoro")),
        )]))
        .expect("fixture settings");
        assert!(settings.is_enabled());
        assert_eq!(settings.provider, TtsProvider::Kokoro);
        assert_eq!(settings.default_language, TtsLanguage::Es);
        assert_eq!(settings.voices.en, text(PIPER_VOICE_EN));
        assert_eq!(settings.filters.max_length, 280.0);
        assert!(settings.filters.skip_emotes);
    }

    #[test]
    fn raw_documents_are_decoded_through_the_schema_boundary() {
        let document = Bson::Document(mongodb::bson::doc! {
            "provider": "fish",
            "filters": {"maxLength": 120.0, "skipEmotes": false},
            "voices": {"en": "custom-en"},
            "unknownField": 1,
        });
        let settings =
            settings_from_bson(&document, &text("123"), &text("")).expect("fixture settings");
        assert_eq!(settings.provider, TtsProvider::Fish);
        assert_eq!(settings.default_language, TtsLanguage::Es);
        assert_eq!(settings.voices.en, text("custom-en"));
        assert_eq!(settings.filters.max_length, 120.0);
        assert!(!settings.filters.skip_emotes);
        assert_eq!(settings.voices.clone_default, text("gojo"));
    }

    #[test]
    fn clone_name_targets_voice_only_for_kokoro() {
        let settings = settings_from_json(&JsonValue::Object(Vec::new())).expect("settings");
        let base = QueueDefaultTtsInput {
            channel_id: text("123"),
            raw_message: text("hola"),
            source: SpeechSource::ChatCommand,
            preferred_mode: PreferredTtsMode::Default,
            clone_name: Some(text("af_heart")),
            user_id: None,
            user_login: None,
            user_name: None,
            user_level: None,
            language: Some(TtsLanguage::Es),
            emotes: None,
            emote_names: None,
        };
        let kokoro = build_tts_request(
            &base,
            ResolvedTtsMode {
                mode: TtsMode::Speak,
                provider: TtsProvider::Kokoro,
            },
            &settings,
            text("hola"),
            TtsLanguage::Es,
        );
        assert_eq!(kokoro.voice, Some(text("af_heart")));
        assert_eq!(kokoro.clone_name, None);
        let fish = build_tts_request(
            &base,
            ResolvedTtsMode {
                mode: TtsMode::Clone,
                provider: TtsProvider::Fish,
            },
            &settings,
            text("hola"),
            TtsLanguage::Es,
        );
        assert_eq!(fish.voice, None);
        assert_eq!(fish.clone_name, Some(text("af_heart")));
    }

    struct FixtureSettings {
        settings: Result<QueueDefaultTtsSettings, QueueDefaultTtsError>,
    }

    impl TtsSettingsSource for FixtureSettings {
        fn settings<'a>(
            &'a self,
            _: &'a JsString,
        ) -> SpeechFuture<'a, Result<QueueDefaultTtsSettings, QueueDefaultTtsError>> {
            let settings = self.settings.clone();
            Box::pin(async move { settings })
        }
    }

    struct FixtureEmotes {
        names: Vec<JsString>,
        calls: Mutex<u32>,
    }

    impl TtsEmoteSource for FixtureEmotes {
        fn emote_names<'a>(
            &'a self,
            _: &'a JsString,
        ) -> SpeechFuture<'a, Result<Vec<JsString>, QueueDefaultTtsError>> {
            Box::pin(async move {
                *self.calls.lock().expect("fixture lock") += 1;
                Ok(self.names.clone())
            })
        }
    }

    struct FixtureSpeech {
        payload: Mutex<Option<TtsRequestBody>>,
    }

    impl TtsRequester for FixtureSpeech {
        fn request<'a>(
            &'a self,
            _: &'a JsString,
            payload: &'a TtsRequestBody,
        ) -> SpeechFuture<'a, SpeechResponse> {
            *self.payload.lock().expect("fixture lock") = Some(payload.clone());
            Box::pin(async move {
                SpeechResponse {
                    error: false,
                    message: Some(JsonValue::String("Speech sent successfully".into())),
                    status: None,
                    kind: None,
                    data: None,
                }
            })
        }
    }

    fn fixture_settings(provider: TtsProvider, enabled: bool) -> QueueDefaultTtsSettings {
        QueueDefaultTtsSettings {
            enabled: JsonValue::Bool(enabled),
            provider,
            default_language: TtsLanguage::Es,
            voices: QueueDefaultTtsVoices {
                en: text(PIPER_VOICE_EN),
                es: text(PIPER_VOICE_ES),
                clone_default: text("gojo"),
                kokoro_default: text("ef_dora"),
            },
            filters: QueueDefaultTtsFilters {
                skip_emotes: true,
                strip_links: true,
                normalize_whitespace: true,
                max_length: 280.0,
                expressive_tags: BTreeMap::new(),
            },
        }
    }

    fn input(raw: &str) -> QueueDefaultTtsInput {
        QueueDefaultTtsInput {
            channel_id: text("123"),
            raw_message: text(raw),
            source: SpeechSource::ChatCommand,
            preferred_mode: PreferredTtsMode::Default,
            clone_name: None,
            user_id: Some(text("42")),
            user_login: Some(text("viewer")),
            user_name: Some(text("Viewer")),
            user_level: None,
            language: None,
            emotes: None,
            emote_names: None,
        }
    }

    #[tokio::test]
    async fn empty_message_short_circuits_without_loading_settings() {
        let queue = DefaultTtsQueue::with_adapters(
            Arc::new(FixtureSettings {
                settings: Err(QueueDefaultTtsError::settings("must not be read")),
            }),
            Arc::new(FixtureEmotes {
                names: Vec::new(),
                calls: Mutex::new(0),
            }),
            Arc::new(FixtureSpeech {
                payload: Mutex::new(None),
            }),
        );
        let response = queue.queue(&input("   ")).await.expect("response");
        assert_eq!(
            response.to_json_string(),
            r#"{"error":true,"message":"No message provided","status":400,"type":"error"}"#
        );
    }

    #[tokio::test]
    async fn disabled_channel_answers_403() {
        let queue = DefaultTtsQueue::with_adapters(
            Arc::new(FixtureSettings {
                settings: Ok(fixture_settings(TtsProvider::Piper, false)),
            }),
            Arc::new(FixtureEmotes {
                names: Vec::new(),
                calls: Mutex::new(0),
            }),
            Arc::new(FixtureSpeech {
                payload: Mutex::new(None),
            }),
        );
        let response = queue.queue(&input("hola")).await.expect("response");
        assert_eq!(
            response.to_json_string(),
            r#"{"error":true,"message":"TTS is disabled for this channel","status":403,"type":"error"}"#
        );
    }

    #[tokio::test]
    async fn queue_builds_the_source_payload_from_explicit_emote_names() {
        let speech = Arc::new(FixtureSpeech {
            payload: Mutex::new(None),
        });
        let emotes = Arc::new(FixtureEmotes {
            names: vec![text("catJAM")],
            calls: Mutex::new(0),
        });
        let queue = DefaultTtsQueue::with_adapters(
            Arc::new(FixtureSettings {
                settings: Ok(fixture_settings(TtsProvider::Piper, true)),
            }),
            emotes.clone(),
            speech.clone(),
        );
        let mut request = input("Hola Kappa");
        request.emote_names = Some(vec![text("Kappa")]);
        let response = queue.queue(&request).await.expect("response");
        assert!(!response.error);
        assert_eq!(*emotes.calls.lock().expect("calls"), 0);
        let payload = speech
            .payload
            .lock()
            .expect("payload")
            .clone()
            .expect("payload");
        assert_eq!(payload.mode, TtsMode::Speak);
        assert_eq!(payload.provider, Some(TtsProvider::Piper));
        assert_eq!(payload.text, text("Viewer dice: Hola"));
        assert_eq!(payload.language, Some(TtsLanguage::Es));
        assert_eq!(
            payload.to_json_string(),
            r#"{"mode":"speak","provider":"piper","text":"Viewer dice: Hola","language":"es","requestedBy":{"userID":"42","userLogin":"viewer","userName":"Viewer"},"meta":{"source":"chat-command","originalText":"Hola Kappa","skipEmotes":true,"stripLinks":true}}"#
        );
    }

    #[tokio::test]
    async fn queue_loads_the_catalog_when_no_emotes_are_supplied() {
        let speech = Arc::new(FixtureSpeech {
            payload: Mutex::new(None),
        });
        let emotes = Arc::new(FixtureEmotes {
            names: vec![text("catJAM")],
            calls: Mutex::new(0),
        });
        let queue = DefaultTtsQueue::with_adapters(
            Arc::new(FixtureSettings {
                settings: Ok(fixture_settings(TtsProvider::Piper, true)),
            }),
            emotes.clone(),
            speech.clone(),
        );
        queue.queue(&input("Hola catJAM")).await.expect("response");
        assert_eq!(*emotes.calls.lock().expect("calls"), 1);
        let payload = speech
            .payload
            .lock()
            .expect("payload")
            .clone()
            .expect("payload");
        assert_eq!(payload.text, text("Viewer dice: Hola"));
    }
}

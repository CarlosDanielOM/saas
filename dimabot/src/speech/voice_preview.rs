//! Voice preview: phrase selection, request validation, concurrency control,
//! the synthesis and audio-delivery path, ticket authentication and billing.
//!
//! Ported from `dimabot/src/server/services/tts/voice_preview.service.ts`.
//!
//! Operational rules preserved:
//!
//! * Five phrases per language and a `PREVIEW_MAX_CREDITS` of 150. Fish counts
//!   JavaScript `text.length` (UTF-16 units) while every other provider counts
//!   `Array.from(text).length` (code points).
//! * Request validation: a non-empty string `voiceId`, `en`/`es`, and a
//!   `piper`/`kokoro`/`fish` provider defaulting to `fish` when the member is
//!   absent. Kokoro presets must resolve, Fish ids must be 32 hex characters,
//!   and a Piper id must equal the channel's voice or the shipped default.
//! * One preview per channel: `SET tts:preview:lock:<channel> <lockId> NX EX
//!   120`, a 30 s compare-and-expire renewal, an 8 s
//!   `SET tts:preview:cooldown:<channel> 1 NX EX 8`, and a
//!   compare-and-delete release. Busy answers 429, an unavailable cache 503.
//! * Clients authenticate with a 64-character lowercase hex ticket stored by
//!   `SET tts:preview:ticket:<ticket> <channelId> EX 30` and consumed with
//!   `GETDEL`. A shape or claim mismatch is `Unauthorized preview`; a cache
//!   failure is `Preview connection unavailable`.
//! * Fish voices are checked for existence before synthesis and a missing voice
//!   is `400 invalid_voice`.
//! * Non-Piper providers require an available balance covering the preview;
//!   Piper may run past zero like ordinary Piper speech. Billing records one
//!   `source: "voice_preview"` usage entry per successful generation, after the
//!   audio has been read.
//!
//! Synthesis reuses the already-ported `TtsRuntime` through the
//! [`PreviewSynthesis`] adapter; nothing here re-creates a provider. The source
//! passes `outputPath: ''`, which resolves to `private_output: false`: every
//! provider then writes `<speech_root>/<channelID>/<speechID>.<wav|mp3>` and the
//! produced file is read and removed immediately, exactly like the source's
//! `fs.readFile` + `fs.rm(outputPath, { force: true })`.
//!
//! Construction performs no I/O. The Redis manager, Mongo database and runtime
//! are injected, and only [`create_preview_ticket`] acquires the process cache
//! inside its async body, matching the source's per-call client acquisition.

use super::{
    default_queue::TtsSettingsSource,
    tts_client::SpeechCancellation,
};
use crate::utils::{
    ai_credit_projection::PlanTier,
    ai_credit_reader::{CreditOwner, get_ai_credits_default},
    js_string::JsString,
    lossless_json::{JsonValue, truthy},
    tts::{TtsLanguage, TtsMode, TtsProvider, calculate_tts_usage, resolve_kokoro_voice_str},
    tts_defaults::{PIPER_VOICE_EN, PIPER_VOICE_ES},
    tts_usage::{TtsUsageContext, TtsUsageStreamer, TtsUsageTrackOptions, track_tts_usage},
};
use crate::tts_services::{
    runtime::TtsRuntime,
    tts_provider::{TtsSynthesisRequest, TtsSynthesisResult},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use mongodb::{
    Database,
    bson::{Document, doc},
};
use redis::aio::ConnectionManager;
use std::{
    fmt,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::Duration,
};
use tokio::sync::{Mutex, watch};

pub type PreviewFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Credit ceiling of a single preview.
pub const PREVIEW_MAX_CREDITS: f64 = 150.0;
/// Ticket lifetime, matching `SET … EX 30`.
pub const PREVIEW_TICKET_TTL_SECONDS: u64 = 30;
/// Preview lock lifetime.
pub const PREVIEW_LOCK_TTL_SECONDS: u64 = 120;
/// Lock renewal cadence, the source's 30 s interval.
pub const PREVIEW_LOCK_RENEWAL_SECONDS: u64 = 30;
/// Per-channel cooldown between previews.
pub const PREVIEW_COOLDOWN_SECONDS: u64 = 8;
/// Socket lifetime, the source's five-minute disconnect timer.
pub const PREVIEW_DISCONNECT_SECONDS: u64 = 300;
/// Namespace prefix of the preview socket.
pub const PREVIEW_NAMESPACE_PREFIX: &str = "/speech-preview/";
/// Feature-provided DragonFly namespace route.
pub const PREVIEW_NAMESPACE_ROUTE: &str = "/speech-preview/{channel}";
pub const TICKET_KEY_PREFIX: &str = "tts:preview:ticket:";
pub const LOCK_KEY_PREFIX: &str = "tts:preview:lock:";
pub const COOLDOWN_KEY_PREFIX: &str = "tts:preview:cooldown:";
/// Bound for the shared credit read. The source has no explicit deadline.
pub const PREVIEW_CREDIT_TIMEOUT: Duration = Duration::from_secs(3);

pub const CODE_INVALID_VOICE: &str = "invalid_voice";
pub const CODE_PREVIEW_BUSY: &str = "preview_busy";
pub const CODE_INSUFFICIENT_CREDITS: &str = "insufficient_credits";
pub const CODE_PREVIEW_UNAVAILABLE: &str = "preview_unavailable";
pub const CODE_SYNTHESIS_FAILED: &str = "synthesis_failed";

pub const MESSAGE_PREVIEW_CONNECTION_UNAVAILABLE: &str = "Preview connection unavailable";
pub const MESSAGE_UNAUTHORIZED_PREVIEW: &str = "Unauthorized preview";
pub const MESSAGE_PREVIEW_LOCK_BUSY: &str = "A preview is already running";
pub const MESSAGE_PREVIEW_COOLDOWN_BUSY: &str = "Please wait before another preview";
pub const MESSAGE_SYNTHESIS_FAILED: &str = "This voice could not be previewed";
pub const MESSAGE_EMPTY_PREVIEW_AUDIO: &str = "Empty preview audio";

/// Compare-and-expire, the script the source renews with.
const RENEW_LOCK: &str = r#"-- DIMA_SPEECH_PREVIEW_RENEW
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) end return 0"#;
/// Compare-and-delete, the script the source releases with.
const RELEASE_LOCK: &str = r#"-- DIMA_SPEECH_PREVIEW_RELEASE
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0"#;

/// English preview phrases, in source order.
pub const PREVIEW_PHRASES_EN: [&str; 5] = [
    "Welcome to the stream! Make yourself comfortable and enjoy the show.",
    "Hello, chat! What adventure should we try together today?",
    "That was amazing! Thank you for sharing this moment with us.",
    "A new adventure begins. Ready, everyone? Let us get started!",
    "Thanks for stopping by. Your next favorite moment is just around the corner.",
];
/// Spanish preview phrases, in source order.
pub const PREVIEW_PHRASES_ES: [&str; 5] = [
    "¡Bienvenidos al directo! Pónganse cómodos y disfruten del espectáculo.",
    "¡Hola, chat! ¿Qué aventura deberíamos intentar juntos hoy?",
    "¡Eso fue increíble! Gracias por compartir este momento con nosotros.",
    "Una nueva aventura comienza. ¿Están listos? ¡Vamos a empezar!",
    "Gracias por venir. Tu próximo momento favorito está a punto de llegar.",
];

/// `VoiceRequestError`: the `code` the client receives plus its HTTP status.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VoicePreviewError {
    pub status: u16,
    /// `preview_unavailable` when the source's catch-all handled the error.
    pub code: &'static str,
    pub message: String,
}

impl VoicePreviewError {
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
    pub fn invalid_voice(message: impl Into<String>) -> Self {
        Self::new(400, CODE_INVALID_VOICE, message)
    }
    pub fn busy(message: impl Into<String>) -> Self {
        Self::new(429, CODE_PREVIEW_BUSY, message)
    }
    pub fn insufficient_credits(message: impl Into<String>) -> Self {
        Self::new(402, CODE_INSUFFICIENT_CREDITS, message)
    }
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(503, CODE_PREVIEW_UNAVAILABLE, message)
    }
    pub fn synthesis_failed(message: impl Into<String>) -> Self {
        Self::new(502, CODE_SYNTHESIS_FAILED, message)
    }
}

impl fmt::Display for VoicePreviewError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for VoicePreviewError {}

/// Opaque cache failure. No key material or payload is attached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreviewCacheError;

impl fmt::Display for PreviewCacheError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("preview cache operation failed")
    }
}

impl std::error::Error for PreviewCacheError {}

pub fn ticket_key(ticket: &str) -> String {
    format!("{TICKET_KEY_PREFIX}{ticket}")
}
pub fn lock_key(channel: &str) -> String {
    format!("{LOCK_KEY_PREFIX}{channel}")
}
pub fn cooldown_key(channel: &str) -> String {
    format!("{COOLDOWN_KEY_PREFIX}{channel}")
}

fn provider_name(provider: TtsProvider) -> &'static str {
    match provider {
        TtsProvider::Piper => "piper",
        TtsProvider::Fish => "fish",
        TtsProvider::Kokoro => "kokoro",
    }
}

pub fn preview_phrases(language: TtsLanguage) -> &'static [&'static str] {
    match language {
        TtsLanguage::En => &PREVIEW_PHRASES_EN,
        TtsLanguage::Es => &PREVIEW_PHRASES_ES,
    }
}

/// `provider === 'fish' ? text.length : Array.from(text).length`.
pub fn preview_character_count(provider: TtsProvider, text: &str) -> f64 {
    let count = if provider == TtsProvider::Fish {
        text.encode_utf16().count()
    } else {
        text.chars().count()
    };
    count as f64
}

/// Priced credit cost of a preview text under the shared pricing policy.
pub fn preview_credit_cost(provider: TtsProvider, text: &str) -> f64 {
    calculate_tts_usage(provider_name(provider), preview_character_count(provider, text))
        .credits_consumed
}

/// The source's only credit-limit rejection.
pub fn ensure_preview_within_limit(credits: f64) -> Result<f64, VoicePreviewError> {
    if credits > PREVIEW_MAX_CREDITS {
        return Err(VoicePreviewError::unavailable(
            "Preview exceeds credit limit",
        ));
    }
    Ok(credits)
}

/// A chosen phrase and its priced cost.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PreviewPhrase {
    pub text: &'static str,
    pub credits: f64,
}

/// `choosePreviewPhrase` with the source's `randomInt(5)` made an explicit
/// index so every branch is testable.
pub fn choose_preview_phrase(
    language: TtsLanguage,
    provider: TtsProvider,
    index: usize,
) -> Result<PreviewPhrase, VoicePreviewError> {
    let text = *preview_phrases(language)
        .get(index)
        .ok_or_else(|| VoicePreviewError::unavailable("Preview phrase index out of range"))?;
    let credits = ensure_preview_within_limit(preview_credit_cost(provider, text))?;
    Ok(PreviewPhrase { text, credits })
}

/// A uniform-enough index in `0..5`, derived from a fresh seeded hasher exactly
/// like [`crate::utils::tts::generate_speech_id`] derives random digits.
pub fn random_preview_index() -> usize {
    use std::{
        collections::hash_map::RandomState,
        hash::{BuildHasher, Hasher},
    };
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u8(0);
    (hasher.finish() % PREVIEW_PHRASES_EN.len() as u64) as usize
}

/// A validated preview request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewRequest {
    pub voice_id: JsString,
    pub language: TtsLanguage,
    pub provider: TtsProvider,
}

fn string_member<'a>(body: &'a JsonValue, key: &str) -> Option<&'a str> {
    match body.get(key) {
        Some(JsonValue::String(value)) => value.as_str(),
        _ => None,
    }
}

/// Parse and structurally validate a preview request body. Missing `provider`
/// defaults to `fish`; an explicit `null` or unknown value is rejected, exactly
/// like the source's destructuring default.
pub fn parse_preview_request(body: &JsonValue) -> Result<PreviewRequest, VoicePreviewError> {
    let JsonValue::Object(_) = body else {
        return Err(VoicePreviewError::invalid_voice("Invalid preview"));
    };
    let Some(JsonValue::String(voice_id)) = body.get("voiceId") else {
        return Err(VoicePreviewError::invalid_voice(
            "Invalid voice or language",
        ));
    };
    if voice_id.is_empty() {
        return Err(VoicePreviewError::invalid_voice(
            "Invalid voice or language",
        ));
    }
    let language = match string_member(body, "language") {
        Some("en") => TtsLanguage::En,
        Some("es") => TtsLanguage::Es,
        _ => {
            return Err(VoicePreviewError::invalid_voice(
                "Invalid voice or language",
            ))
        }
    };
    let provider = match body.get("provider") {
        None => TtsProvider::Fish,
        Some(value) => match value {
            JsonValue::String(value) => match value.as_str() {
                Some("piper") => TtsProvider::Piper,
                Some("kokoro") => TtsProvider::Kokoro,
                Some("fish") => TtsProvider::Fish,
                _ => {
                    return Err(VoicePreviewError::invalid_voice(
                        "Invalid voice or language",
                    ))
                }
            },
            _ => {
                return Err(VoicePreviewError::invalid_voice(
                    "Invalid voice or language",
                ))
            }
        },
    };
    Ok(PreviewRequest {
        voice_id: voice_id.clone(),
        language,
        provider,
    })
}

/// `[a-f\d]` ASCII hex with an optional uppercase class (`/i`).
fn ascii_hex(value: &JsString, length: usize, allow_uppercase: bool) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    value.len() == length
        && value.bytes().all(|byte| {
            byte.is_ascii_digit()
                || matches!(byte, b'a'..=b'f')
                || (allow_uppercase && matches!(byte, b'A'..=b'F'))
        })
}

/// `^[a-f\d]{32}$/i`: a Fish voice id.
pub fn valid_fish_voice_id(value: &JsString) -> bool {
    ascii_hex(value, 32, true)
}

/// `^[a-f\d]{64}$`: a preview ticket (lowercase only, as the source tests it).
pub fn valid_ticket_format(ticket: &str) -> bool {
    ascii_hex(&JsString::from(ticket), 64, false)
}

/// A Piper voice id must be the shipped default for the language or the
/// channel's configured voice.
pub fn piper_voice_allowed(
    voice_id: &JsString,
    language: TtsLanguage,
    channel_voice: Option<&JsString>,
) -> bool {
    let default = match language {
        TtsLanguage::En => PIPER_VOICE_EN,
        TtsLanguage::Es => PIPER_VOICE_ES,
    };
    *voice_id == JsString::from(default) || channel_voice.is_some_and(|value| value == voice_id)
}

/// Provider-specific validation after the structural checks.
pub fn validate_preview_voice(
    request: &PreviewRequest,
    channel_piper_voice: Option<&JsString>,
) -> Result<(), VoicePreviewError> {
    match request.provider {
        TtsProvider::Kokoro => {
            let resolved = request
                .voice_id
                .as_str()
                .and_then(resolve_kokoro_voice_str);
            if resolved.is_none() {
                return Err(VoicePreviewError::invalid_voice(
                    "Invalid Kokoro preset",
                ));
            }
            Ok(())
        }
        TtsProvider::Fish => {
            if !valid_fish_voice_id(&request.voice_id) {
                return Err(VoicePreviewError::invalid_voice("Invalid Fish voice"));
            }
            Ok(())
        }
        TtsProvider::Piper => {
            if !piper_voice_allowed(&request.voice_id, request.language, channel_piper_voice) {
                return Err(VoicePreviewError::invalid_voice("Invalid Piper voice"));
            }
            Ok(())
        }
    }
}

/// `socket.nsp.name.split('/')[2]` of a canonical preview namespace.
pub fn preview_namespace_channel(namespace: &str) -> Option<&str> {
    let mut segments = namespace.split('/');
    segments.next()?;
    segments.next()?;
    segments.next().filter(|segment| !segment.is_empty())
}

/// The source's namespace regex requires a numeric channel segment.
pub fn valid_preview_channel(channel: &str) -> bool {
    !channel.is_empty() && channel.bytes().all(|byte| byte.is_ascii_digit())
}

/// What the ticket lookup produced. `NotPerformed` models a ticket rejected on
/// shape, where the source never touches the cache.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TicketLookup {
    NotPerformed,
    Stored(Option<String>),
    Failed,
}

/// The source's three handshake outcomes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TicketDecision {
    Authorized,
    Unauthorized,
    Unavailable,
}

impl TicketDecision {
    /// The `Error` message the source passes to `next`.
    pub fn error_message(self) -> Option<&'static str> {
        match self {
            Self::Authorized => None,
            Self::Unauthorized => Some(MESSAGE_UNAUTHORIZED_PREVIEW),
            Self::Unavailable => Some(MESSAGE_PREVIEW_CONNECTION_UNAVAILABLE),
        }
    }

    pub fn is_authorized(self) -> bool {
        self == Self::Authorized
    }
}

/// The handshake decision: format first, then the consumed claim, then the
/// namespace channel.
pub fn authenticate_preview_ticket(
    ticket: Option<&str>,
    lookup: TicketLookup,
    namespace_channel: &str,
) -> TicketDecision {
    if !ticket.is_some_and(valid_ticket_format) {
        return TicketDecision::Unauthorized;
    }
    match lookup {
        TicketLookup::Failed => TicketDecision::Unavailable,
        TicketLookup::Stored(Some(channel)) if channel == namespace_channel => {
            TicketDecision::Authorized
        }
        // A consumed-but-mismatched claim and a never-performed lookup are both
        // unauthorized: the source never authorizes without a matching claim.
        TicketLookup::Stored(_) | TicketLookup::NotPerformed => TicketDecision::Unauthorized,
    }
}

/// The preview cache seam: tickets, lock, renewal, release and cooldown.
pub trait PreviewCache: Send + Sync {
    fn store_ticket<'a>(
        &'a self,
        ticket: &'a str,
        channel_id: &'a str,
        ttl_seconds: u64,
    ) -> PreviewFuture<'a, Result<(), PreviewCacheError>>;
    /// `GETDEL`; `None` means the ticket was absent or already consumed.
    fn consume_ticket<'a>(
        &'a self,
        ticket: &'a str,
    ) -> PreviewFuture<'a, Result<Option<String>, PreviewCacheError>>;
    /// `SET … NX EX`; `true` when this caller acquired the lock.
    fn acquire_lock<'a>(
        &'a self,
        channel_id: &'a str,
        lock_id: &'a str,
        ttl_seconds: u64,
    ) -> PreviewFuture<'a, Result<bool, PreviewCacheError>>;
    fn renew_lock<'a>(
        &'a self,
        channel_id: &'a str,
        lock_id: &'a str,
        ttl_seconds: u64,
    ) -> PreviewFuture<'a, Result<bool, PreviewCacheError>>;
    fn release_lock<'a>(
        &'a self,
        channel_id: &'a str,
        lock_id: &'a str,
    ) -> PreviewFuture<'a, Result<bool, PreviewCacheError>>;
    /// `SET … NX EX` on the cooldown key.
    fn acquire_cooldown<'a>(
        &'a self,
        channel_id: &'a str,
        seconds: u64,
    ) -> PreviewFuture<'a, Result<bool, PreviewCacheError>>;
}

/// Concrete Dragonfly/Redis adapter over a shared connection manager. Cheap
/// clones share one multiplexed connection.
#[derive(Clone)]
pub struct RedisPreviewCache {
    cache: ConnectionManager,
}

impl RedisPreviewCache {
    pub fn new(cache: ConnectionManager) -> Self {
        Self { cache }
    }

    fn connection(&self) -> ConnectionManager {
        self.cache.clone()
    }
}

impl PreviewCache for RedisPreviewCache {
    fn store_ticket<'a>(
        &'a self,
        ticket: &'a str,
        channel_id: &'a str,
        ttl_seconds: u64,
    ) -> PreviewFuture<'a, Result<(), PreviewCacheError>> {
        Box::pin(async move {
            let mut connection = self.connection();
            let _: Option<String> = redis::cmd("SET")
                .arg(ticket_key(ticket))
                .arg(channel_id)
                .arg("EX")
                .arg(ttl_seconds)
                .query_async(&mut connection)
                .await
                .map_err(|_| PreviewCacheError)?;
            Ok(())
        })
    }

    fn consume_ticket<'a>(
        &'a self,
        ticket: &'a str,
    ) -> PreviewFuture<'a, Result<Option<String>, PreviewCacheError>> {
        Box::pin(async move {
            let mut connection = self.connection();
            redis::cmd("GETDEL")
                .arg(ticket_key(ticket))
                .query_async(&mut connection)
                .await
                .map_err(|_| PreviewCacheError)
        })
    }

    fn acquire_lock<'a>(
        &'a self,
        channel_id: &'a str,
        lock_id: &'a str,
        ttl_seconds: u64,
    ) -> PreviewFuture<'a, Result<bool, PreviewCacheError>> {
        Box::pin(async move {
            let mut connection = self.connection();
            let stored: Option<String> = redis::cmd("SET")
                .arg(lock_key(channel_id))
                .arg(lock_id)
                .arg("NX")
                .arg("EX")
                .arg(ttl_seconds)
                .query_async(&mut connection)
                .await
                .map_err(|_| PreviewCacheError)?;
            Ok(stored.is_some())
        })
    }

    fn renew_lock<'a>(
        &'a self,
        channel_id: &'a str,
        lock_id: &'a str,
        ttl_seconds: u64,
    ) -> PreviewFuture<'a, Result<bool, PreviewCacheError>> {
        Box::pin(async move {
            let mut connection = self.connection();
            let renewed: i64 = redis::Script::new(RENEW_LOCK)
                .key(lock_key(channel_id))
                .arg(lock_id)
                .arg(ttl_seconds)
                .invoke_async(&mut connection)
                .await
                .map_err(|_| PreviewCacheError)?;
            Ok(renewed == 1)
        })
    }

    fn release_lock<'a>(
        &'a self,
        channel_id: &'a str,
        lock_id: &'a str,
    ) -> PreviewFuture<'a, Result<bool, PreviewCacheError>> {
        Box::pin(async move {
            let mut connection = self.connection();
            let released: i64 = redis::Script::new(RELEASE_LOCK)
                .key(lock_key(channel_id))
                .arg(lock_id)
                .invoke_async(&mut connection)
                .await
                .map_err(|_| PreviewCacheError)?;
            Ok(released == 1)
        })
    }

    fn acquire_cooldown<'a>(
        &'a self,
        channel_id: &'a str,
        seconds: u64,
    ) -> PreviewFuture<'a, Result<bool, PreviewCacheError>> {
        Box::pin(async move {
            let mut connection = self.connection();
            let stored: Option<String> = redis::cmd("SET")
                .arg(cooldown_key(channel_id))
                .arg("1")
                .arg("NX")
                .arg("EX")
                .arg(seconds)
                .query_async(&mut connection)
                .await
                .map_err(|_| PreviewCacheError)?;
            Ok(stored.is_some())
        })
    }
}

/// Ticket handshake: shape first (no cache call), then `GETDEL`, then the claim.
pub async fn authenticate_ticket(
    cache: &dyn PreviewCache,
    ticket: Option<&str>,
    namespace_channel: &str,
) -> TicketDecision {
    let Some(ticket) = ticket.filter(|value| valid_ticket_format(*value)) else {
        return authenticate_preview_ticket(ticket, TicketLookup::NotPerformed, namespace_channel);
    };
    let lookup = match cache.consume_ticket(ticket).await {
        Ok(value) => TicketLookup::Stored(value),
        Err(_) => TicketLookup::Failed,
    };
    authenticate_preview_ticket(Some(ticket), lookup, namespace_channel)
}

/// Acquire the per-channel lock, then the cooldown. A failed cooldown releases
/// the lock before answering, mirroring the source's `finally`.
pub async fn admit_preview(
    cache: &dyn PreviewCache,
    channel_id: &str,
    lock_id: &str,
) -> Result<(), VoicePreviewError> {
    let locked = cache
        .acquire_lock(channel_id, lock_id, PREVIEW_LOCK_TTL_SECONDS)
        .await
        .map_err(|_| VoicePreviewError::unavailable(MESSAGE_PREVIEW_CONNECTION_UNAVAILABLE))?;
    if !locked {
        return Err(VoicePreviewError::busy(MESSAGE_PREVIEW_LOCK_BUSY));
    }
    match cache
        .acquire_cooldown(channel_id, PREVIEW_COOLDOWN_SECONDS)
        .await
    {
        Ok(true) => Ok(()),
        Ok(false) => {
            let _ = cache.release_lock(channel_id, lock_id).await;
            Err(VoicePreviewError::busy(MESSAGE_PREVIEW_COOLDOWN_BUSY))
        }
        Err(_) => {
            let _ = cache.release_lock(channel_id, lock_id).await;
            Err(VoicePreviewError::unavailable(
                MESSAGE_PREVIEW_CONNECTION_UNAVAILABLE,
            ))
        }
    }
}

/// Best-effort lock release; a lost lock or cache error is not fatal.
pub async fn release_preview(cache: &dyn PreviewCache, channel_id: &str, lock_id: &str) {
    let _ = cache.release_lock(channel_id, lock_id).await;
}

/// One renewal tick of the source's 30 s interval.
pub async fn renew_preview_lock(
    cache: &dyn PreviewCache,
    channel_id: &str,
    lock_id: &str,
) -> Result<bool, VoicePreviewError> {
    cache
        .renew_lock(channel_id, lock_id, PREVIEW_LOCK_TTL_SECONDS)
        .await
        .map_err(|_| VoicePreviewError::unavailable(MESSAGE_PREVIEW_CONNECTION_UNAVAILABLE))
}

/// The credit shape the billing reader returns.
#[derive(Clone, Debug, PartialEq)]
pub struct PreviewCreditAvailability {
    pub available: bool,
    pub status: Option<JsString>,
    pub balance: f64,
}

/// `balance.available && balance.status === 'available' && balance.balance >=
/// credits`.
pub fn credits_cover_preview(availability: &PreviewCreditAvailability, cost: f64) -> bool {
    availability.available
        && availability.status.as_ref().and_then(JsString::as_str) == Some("available")
        && availability.balance >= cost
}

/// Read the shared credit payload as the source's comparison shape.
pub fn credit_availability(value: &JsonValue) -> PreviewCreditAvailability {
    PreviewCreditAvailability {
        available: value.get("available").is_some_and(truthy),
        status: match value.get("status") {
            Some(JsonValue::String(status)) => Some(status.clone()),
            _ => None,
        },
        balance: match value.get("balance") {
            Some(JsonValue::Number(balance)) => *balance,
            _ => 0.0,
        },
    }
}

/// The preview owner: the shared usage streamer view plus the credit owner.
#[derive(Clone, Debug)]
pub struct PreviewStreamerAccount {
    pub streamer: TtsUsageStreamer,
    pub owner: CreditOwner,
}

/// Streamer lookup seam.
pub trait PreviewAccountSource: Send + Sync {
    fn account<'a>(
        &'a self,
        channel_id: &'a str,
    ) -> PreviewFuture<'a, Result<Option<PreviewStreamerAccount>, VoicePreviewError>>;
}

/// Concrete MongoDB adapter over the `users` collection, projecting the two
/// plan fields the preview needs. `plan_tier` mapping follows
/// `ai_credit_reader::current_owner`.
pub struct MongoPreviewAccountSource {
    database: Database,
}

impl MongoPreviewAccountSource {
    pub fn new(database: Database) -> Self {
        Self { database }
    }
}

impl PreviewAccountSource for MongoPreviewAccountSource {
    fn account<'a>(
        &'a self,
        channel_id: &'a str,
    ) -> PreviewFuture<'a, Result<Option<PreviewStreamerAccount>, VoicePreviewError>> {
        Box::pin(async move {
            let user = self
                .database
                .collection::<Document>("users")
                .find_one(doc! {"accounts": {"$elemMatch": {"type": "twitch", "id": channel_id}}})
                .projection(doc! {"_id": 0, "plan_tier": 1, "polar_sh_customer_id": 1})
                .await
                .map_err(|_| {
                    VoicePreviewError::unavailable(MESSAGE_PREVIEW_CONNECTION_UNAVAILABLE)
                })?;
            let Some(user) = user else {
                return Ok(None);
            };
            let tier = match user.get_str("plan_tier").ok() {
                Some("premium") => PlanTier::Premium,
                Some("pro") => PlanTier::Pro,
                _ => PlanTier::Free,
            };
            let plan_tier = user.get_str("plan_tier").ok().unwrap_or("free").to_owned();
            let customer = user.get_str("polar_sh_customer_id").ok().unwrap_or("");
            let customer_id = (!customer.is_empty()).then(|| customer.to_owned());
            Ok(Some(PreviewStreamerAccount {
                streamer: TtsUsageStreamer {
                    polar_sh_customer_id: customer_id.as_deref().map(JsString::from),
                    plan_tier: Some(JsString::from(plan_tier)),
                },
                owner: CreditOwner {
                    tier: Some(tier),
                    customer_id,
                },
            }))
        })
    }
}

/// Credit balance seam.
pub trait PreviewCreditSource: Send + Sync {
    fn credits<'a>(
        &'a self,
        channel_id: &'a str,
        account: &'a PreviewStreamerAccount,
    ) -> PreviewFuture<'a, Result<PreviewCreditAvailability, VoicePreviewError>>;
}

/// Concrete adapter over the shared credit reader, always requiring a verified
/// available balance like the source.
pub struct NativePreviewCreditSource {
    provider_timeout: Duration,
}

impl NativePreviewCreditSource {
    pub fn new(provider_timeout: Duration) -> Self {
        Self { provider_timeout }
    }
}

impl PreviewCreditSource for NativePreviewCreditSource {
    fn credits<'a>(
        &'a self,
        channel_id: &'a str,
        account: &'a PreviewStreamerAccount,
    ) -> PreviewFuture<'a, Result<PreviewCreditAvailability, VoicePreviewError>> {
        Box::pin(async move {
            let value =
                get_ai_credits_default(&account.owner, channel_id, true, self.provider_timeout)
                    .await
                    .map_err(|_| {
                        VoicePreviewError::unavailable(MESSAGE_PREVIEW_CONNECTION_UNAVAILABLE)
                    })?;
            Ok(credit_availability(&value))
        })
    }
}

/// The `trackTtsUsage` options of one successful preview.
pub fn preview_usage_options(
    channel_id: &JsString,
    streamer: &TtsUsageStreamer,
    provider: TtsProvider,
    text: &JsString,
    entry_id: &JsString,
    request_id: &JsString,
    resource_id: &JsString,
) -> TtsUsageTrackOptions {
    let characters = preview_character_count(provider, &text.to_utf8_lossy());
    TtsUsageTrackOptions {
        channel_id: channel_id.clone(),
        streamer: streamer.clone(),
        provider: JsString::from(provider_name(provider)),
        characters,
        text: text.clone(),
        require_durable_usage: false,
        usage: Some(TtsUsageContext {
            entry_id: Some(entry_id.clone()),
            request_id: Some(request_id.clone()),
            source: Some(JsString::from("voice_preview")),
            resource_type: Some(JsString::from("voice_preview")),
            resource_id: Some(resource_id.clone()),
        }),
    }
}

/// Billing seam for the once-per-generation usage entry.
pub trait PreviewBilling: Send + Sync {
    fn track<'a>(
        &'a self,
        options: TtsUsageTrackOptions,
    ) -> PreviewFuture<'a, Result<(), VoicePreviewError>>;
}

/// Concrete adapter over the shared TTS usage tracker.
#[derive(Clone, Copy, Debug, Default)]
pub struct NativePreviewBilling;

impl PreviewBilling for NativePreviewBilling {
    fn track<'a>(
        &'a self,
        options: TtsUsageTrackOptions,
    ) -> PreviewFuture<'a, Result<(), VoicePreviewError>> {
        Box::pin(async move {
            track_tts_usage(&options).await.map(|_| ()).map_err(|_| {
                VoicePreviewError::unavailable(MESSAGE_PREVIEW_CONNECTION_UNAVAILABLE)
            })
        })
    }
}

/// Record the preview's usage exactly once, through the shared tracker.
pub async fn track_preview_usage(
    options: &TtsUsageTrackOptions,
) -> Result<(), VoicePreviewError> {
    track_tts_usage(options).await.map(|_| ()).map_err(|_| {
        VoicePreviewError::unavailable(MESSAGE_PREVIEW_CONNECTION_UNAVAILABLE)
    })
}

/// Two lowercase hex characters per byte.
fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

/// A 32-byte ticket. The ticket is the socket's bearer credential, so it uses
/// the OS CSPRNG rather than a time-seeded hasher.
pub fn random_ticket() -> Result<String, VoicePreviewError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| VoicePreviewError::unavailable("Preview ticket entropy unavailable"))?;
    Ok(hex_lower(&bytes))
}

/// `createPreviewTicket`: acquire the process cache inside the async body and
/// store the ticket for 30 seconds.
pub async fn create_preview_ticket(channel_id: &str) -> Result<String, VoicePreviewError> {
    let ticket = random_ticket()?;
    let mut cache = crate::utils::redis::get_redis_client()
        .await
        .map_err(|_| VoicePreviewError::unavailable(MESSAGE_PREVIEW_CONNECTION_UNAVAILABLE))?;
    let _: Option<String> = redis::cmd("SET")
        .arg(ticket_key(&ticket))
        .arg(channel_id)
        .arg("EX")
        .arg(PREVIEW_TICKET_TTL_SECONDS)
        .query_async(&mut cache)
        .await
        .map_err(|_| VoicePreviewError::unavailable(MESSAGE_PREVIEW_CONNECTION_UNAVAILABLE))?;
    Ok(ticket)
}

/// Synthesized preview audio and its wire MIME type.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewAudio {
    pub bytes: Vec<u8>,
    pub mime_type: &'static str,
}

/// The source's `service.synthesize({...})` arguments.
///
/// Not `Debug`: `tokio::sync::watch::Receiver` has no `Debug` implementation,
/// and the request carries user voice data.
#[derive(Clone)]
pub struct PreviewSynthesisJob<'a> {
    pub channel_id: &'a str,
    pub speech_id: &'a str,
    pub provider: TtsProvider,
    pub language: TtsLanguage,
    pub text: JsString,
    pub voice: JsString,
    /// Typed cancellation; `Some` aborts synthesis mid-flight.
    pub signal: watch::Receiver<Option<String>>,
}

/// Synthesis seam. The concrete adapter ([`TtsRuntimeSynthesis`]) calls the
/// already-ported [`TtsRuntime`]; fixtures inject audio without a provider.
pub trait PreviewSynthesis: Send + Sync {
    fn synthesize<'a>(
        &'a self,
        job: PreviewSynthesisJob<'a>,
    ) -> PreviewFuture<'a, Result<PreviewAudio, VoicePreviewError>>;
}

/// `result.error || !result.outputPath` → 502, plus the source's MIME fallback:
/// `audio/wav` for Piper and `audio/mpeg` otherwise.
pub fn map_synthesis_result(
    result: &TtsSynthesisResult,
    provider: TtsProvider,
) -> Result<(PathBuf, &'static str), VoicePreviewError> {
    if result.error {
        return Err(VoicePreviewError::synthesis_failed(
            MESSAGE_SYNTHESIS_FAILED,
        ));
    }
    let Some(path) = &result.output_path else {
        return Err(VoicePreviewError::synthesis_failed(
            MESSAGE_SYNTHESIS_FAILED,
        ));
    };
    let mime_type = result.mime_type.unwrap_or(if provider == TtsProvider::Piper {
        "audio/wav"
    } else {
        "audio/mpeg"
    });
    Ok((path.clone(), mime_type))
}

/// Read the produced file and remove it in every outcome, matching the source's
/// `fs.readFile` followed by `fs.rm(path, { force: true })` in `finally`.
/// A read failure is the source's catch-all `preview_unavailable`; an empty file
/// is the source's `synthesis_failed`.
pub async fn read_preview_audio(path: &Path) -> Result<Vec<u8>, VoicePreviewError> {
    let read = tokio::fs::read(path).await;
    let _ = tokio::fs::remove_file(path).await;
    let bytes = read.map_err(|_| {
        VoicePreviewError::unavailable(MESSAGE_PREVIEW_CONNECTION_UNAVAILABLE)
    })?;
    if bytes.is_empty() {
        return Err(VoicePreviewError::synthesis_failed(
            MESSAGE_EMPTY_PREVIEW_AUDIO,
        ));
    }
    Ok(bytes)
}

/// Concrete adapter over [`TtsRuntime`]. The source passes `outputPath: ''`;
/// the providers ignore that field when `private_output` is false and write
/// `<speech_root>/<channelID>/<speechID>.<ext>`, which is exactly the source's
/// resolved location. `private_output: false` also keeps the source's
/// `public_path` derivation, although a preview never publishes the URL.
pub struct TtsRuntimeSynthesis {
    runtime: Arc<TtsRuntime>,
}

impl TtsRuntimeSynthesis {
    pub fn new(runtime: Arc<TtsRuntime>) -> Self {
        Self { runtime }
    }
}

impl PreviewSynthesis for TtsRuntimeSynthesis {
    fn synthesize<'a>(
        &'a self,
        job: PreviewSynthesisJob<'a>,
    ) -> PreviewFuture<'a, Result<PreviewAudio, VoicePreviewError>> {
        Box::pin(async move {
            let request = TtsSynthesisRequest {
                channel_id: job.channel_id.to_owned(),
                speech_id: job.speech_id.to_owned(),
                // The source's `provider === 'fish' ? 'clone' : 'speak'`.
                mode: if job.provider == TtsProvider::Fish {
                    TtsMode::Clone
                } else {
                    TtsMode::Speak
                },
                provider: job.provider,
                model: None,
                text: job.text,
                language: job.language,
                voice: job.voice,
                output_path: PathBuf::new(),
                clone_name: None,
                private_output: false,
                signal: Some(job.signal),
                max_audio_bytes: None,
                single_attempt: false,
            };
            let result = self.runtime.synthesize(Some(job.provider), &request).await;
            let (path, mime_type) = map_synthesis_result(&result, job.provider)?;
            let bytes = read_preview_audio(&path).await?;
            Ok(PreviewAudio { bytes, mime_type })
        })
    }
}

/// Fish voice existence seam: the source's `await getFishVoice(voiceId)`.
pub trait PreviewVoiceCatalog: Send + Sync {
    fn fish_voice_exists<'a>(
        &'a self,
        voice_id: &'a str,
    ) -> PreviewFuture<'a, Result<bool, VoicePreviewError>>;
}

/// Concrete adapter over [`TtsRuntime::get_fish_voice`]. Any catalog failure is
/// the source's `400 invalid_voice` rejection.
pub struct TtsRuntimeVoiceCatalog {
    runtime: Arc<TtsRuntime>,
}

impl TtsRuntimeVoiceCatalog {
    pub fn new(runtime: Arc<TtsRuntime>) -> Self {
        Self { runtime }
    }
}

impl PreviewVoiceCatalog for TtsRuntimeVoiceCatalog {
    fn fish_voice_exists<'a>(
        &'a self,
        voice_id: &'a str,
    ) -> PreviewFuture<'a, Result<bool, VoicePreviewError>> {
        Box::pin(async move {
            self.runtime
                .get_fish_voice(voice_id)
                .await
                .map(|_| true)
                .map_err(|_| VoicePreviewError::invalid_voice("Invalid Fish voice"))
        })
    }
}

/// `{error:false, data:{provider,voiceId,text,credits,mimeType,audio}}`.
pub fn preview_success_ack(
    request: &PreviewRequest,
    phrase: &PreviewPhrase,
    audio: &PreviewAudio,
) -> JsonValue {
    JsonValue::Object(vec![
        ("error".into(), JsonValue::Bool(false)),
        (
            "data".into(),
            JsonValue::Object(vec![
                (
                    "provider".into(),
                    JsonValue::String(provider_name(request.provider).into()),
                ),
                (
                    "voiceId".into(),
                    JsonValue::String(request.voice_id.clone()),
                ),
                (
                    "text".into(),
                    JsonValue::String(JsString::from(phrase.text)),
                ),
                ("credits".into(), JsonValue::Number(phrase.credits)),
                ("mimeType".into(), JsonValue::String(audio.mime_type.into())),
                (
                    "audio".into(),
                    JsonValue::String(STANDARD.encode(&audio.bytes).into()),
                ),
            ]),
        ),
    ])
}

/// `{error:true, code}` — the ack the source sends for every failure, including
/// `preview_busy`. The HTTP status and message stay server-side.
pub fn preview_failure_ack(code: &str) -> JsonValue {
    JsonValue::Object(vec![
        ("error".into(), JsonValue::Bool(true)),
        ("code".into(), JsonValue::String(code.into())),
    ])
}

/// Convert the lossless ack into the transport's serializer type. `NaN` and
/// infinities have no JSON representation and become `null`; preview payloads
/// never contain them.
pub fn wire_value(value: &JsonValue) -> serde_json::Value {
    match value {
        JsonValue::Null => serde_json::Value::Null,
        JsonValue::Bool(value) => serde_json::Value::Bool(*value),
        JsonValue::Number(value) => serde_json::Number::from_f64(*value)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        JsonValue::String(value) => serde_json::Value::String(value.to_utf8_lossy()),
        JsonValue::Array(values) => {
            serde_json::Value::Array(values.iter().map(wire_value).collect())
        }
        JsonValue::Object(entries) => serde_json::Value::Object(
            entries
                .iter()
                .map(|(key, value)| (key.to_utf8_lossy(), wire_value(value)))
                .collect(),
        ),
    }
}

/// Per-connection preview state: the `busy` flag, the lock, the five-minute
/// socket deadline and the 30 s renewal cadence.
///
/// Timestamps are caller-supplied monotonic offsets, so the whole machine is
/// unit-testable without a live socket or clock.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewSession {
    channel_id: String,
    started_at: Duration,
    last_renewal_at: Duration,
    lock_id: Option<String>,
}

/// The outcome of starting a preview on a connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionBegin {
    Started,
    Busy,
}

impl PreviewSession {
    pub fn new(channel_id: impl Into<String>, now: Duration) -> Self {
        Self {
            channel_id: channel_id.into(),
            started_at: now,
            last_renewal_at: now,
            lock_id: None,
        }
    }

    pub fn channel_id(&self) -> &str {
        &self.channel_id
    }

    /// The source's `setTimeout(() => socket.disconnect(true), 5 * 60 * 1000)`.
    pub fn expiry_deadline(&self) -> Duration {
        self.started_at + Duration::from_secs(PREVIEW_DISCONNECT_SECONDS)
    }

    pub fn expired_at(&self, now: Duration) -> bool {
        now >= self.expiry_deadline()
    }

    pub fn is_busy(&self) -> bool {
        self.lock_id.is_some()
    }

    pub fn lock_id(&self) -> Option<&str> {
        self.lock_id.as_deref()
    }

    /// Start a preview on this connection. A second concurrent preview is the
    /// source's `busy` flag and is rejected without touching the cache.
    pub fn begin(&mut self, now: Duration, lock_id: impl Into<String>) -> SessionBegin {
        if self.lock_id.is_some() {
            return SessionBegin::Busy;
        }
        self.lock_id = Some(lock_id.into());
        self.last_renewal_at = now;
        SessionBegin::Started
    }

    /// Clear the busy flag and hand back the lock id still to be released.
    pub fn finish(&mut self) -> Option<String> {
        self.lock_id.take()
    }

    /// The lock id due for renewal at `now`, if any.
    pub fn renewal_due(&self, now: Duration) -> Option<&str> {
        self.lock_id.as_deref().filter(|_| {
            now.saturating_sub(self.last_renewal_at)
                >= Duration::from_secs(PREVIEW_LOCK_RENEWAL_SECONDS)
        })
    }

    pub fn mark_renewed(&mut self, now: Duration) {
        self.last_renewal_at = now;
    }
}

/// One renewal tick: the same compare-and-expire the source runs on its 30 s
/// interval. `Ok(false)` means nothing was due; a lost lock returns `Ok(false)`
/// from the cache and is not retried.
pub async fn renew_preview_session(
    cache: &dyn PreviewCache,
    session: &mut PreviewSession,
    now: Duration,
) -> Result<bool, VoicePreviewError> {
    let Some(lock_id) = session.renewal_due(now).map(str::to_owned) else {
        return Ok(false);
    };
    let channel = session.channel_id().to_owned();
    let renewed = cache
        .renew_lock(&channel, &lock_id, PREVIEW_LOCK_TTL_SECONDS)
        .await
        .map_err(|_| VoicePreviewError::unavailable(MESSAGE_PREVIEW_CONNECTION_UNAVAILABLE))?;
    if renewed {
        session.mark_renewed(now);
    }
    Ok(renewed)
}

/// Everything the preview flow needs, with a concrete production adapter for
/// each port.
pub struct PreviewContext {
    pub cache: Arc<dyn PreviewCache>,
    pub settings: Arc<dyn TtsSettingsSource>,
    pub accounts: Arc<dyn PreviewAccountSource>,
    pub credits: Arc<dyn PreviewCreditSource>,
    pub voice_catalog: Arc<dyn PreviewVoiceCatalog>,
    pub synthesis: Arc<dyn PreviewSynthesis>,
    pub billing: Arc<dyn PreviewBilling>,
}

impl PreviewContext {
    /// Isolated construction for fixtures and alternate adapters.
    pub fn with_adapters(
        cache: Arc<dyn PreviewCache>,
        settings: Arc<dyn TtsSettingsSource>,
        accounts: Arc<dyn PreviewAccountSource>,
        credits: Arc<dyn PreviewCreditSource>,
        voice_catalog: Arc<dyn PreviewVoiceCatalog>,
        synthesis: Arc<dyn PreviewSynthesis>,
        billing: Arc<dyn PreviewBilling>,
    ) -> Self {
        Self {
            cache,
            settings,
            accounts,
            credits,
            voice_catalog,
            synthesis,
            billing,
        }
    }

    /// Complete application wiring: the shared settings schema, the users plan
    /// fields, the shared credit reader and usage tracker, and the application
    /// `TtsRuntime`.
    pub fn native(
        runtime: Arc<TtsRuntime>,
        cache: Arc<dyn PreviewCache>,
        database: Database,
    ) -> Self {
        Self::with_adapters(
            cache,
            Arc::new(super::default_queue::MongoTtsSettingsSource::new(
                database.clone(),
            )),
            Arc::new(MongoPreviewAccountSource::new(database)),
            Arc::new(NativePreviewCreditSource::new(PREVIEW_CREDIT_TIMEOUT)),
            Arc::new(TtsRuntimeVoiceCatalog::new(runtime.clone())),
            Arc::new(TtsRuntimeSynthesis::new(runtime)),
            Arc::new(NativePreviewBilling),
        )
    }
}

/// One `preview` event.
pub struct PreviewCall<'a> {
    pub body: &'a JsonValue,
    pub session: &'a Mutex<PreviewSession>,
    pub cancellation: &'a SpeechCancellation,
    pub phrase_index: usize,
    pub now: Duration,
}

/// Port of the source's `socket.on('preview', …)` body: busy check, validation,
/// admission, voices, credits, synthesis, billing and the acknowledgement.
/// Every failure answers the source's `{ error: true, code }` shape.
pub async fn handle_preview(context: &PreviewContext, call: PreviewCall<'_>) -> JsonValue {
    let channel = {
        let session = call.session.lock().await;
        session.channel_id().to_owned()
    };
    let lock_id = uuid::Uuid::new_v4().to_string();
    {
        let mut session = call.session.lock().await;
        if session.begin(call.now, lock_id.clone()) == SessionBegin::Busy {
            return preview_failure_ack(CODE_PREVIEW_BUSY);
        }
    }
    let ack = run_preview(context, &channel, &lock_id, &call).await;
    let released = {
        let mut session = call.session.lock().await;
        session.finish()
    };
    if let Some(lock_id) = released {
        release_preview(context.cache.as_ref(), &channel, &lock_id).await;
    }
    ack
}

async fn run_preview(
    context: &PreviewContext,
    channel: &str,
    lock_id: &str,
    call: &PreviewCall<'_>,
) -> JsonValue {
    let request = match parse_preview_request(call.body) {
        Ok(request) => request,
        Err(error) => return preview_failure_ack(error.code),
    };
    let channel_id = JsString::from(channel);
    // Piper validation reads the channel's configured voice through the shared
    // settings schema. The source loads settings only on this branch.
    let channel_voice = if request.provider == TtsProvider::Piper {
        match context.settings.settings(&channel_id).await {
            Ok(settings) => Some(settings.voices.for_language(request.language).clone()),
            Err(_) => return preview_failure_ack(CODE_PREVIEW_UNAVAILABLE),
        }
    } else {
        None
    };
    if let Err(error) = validate_preview_voice(&request, channel_voice.as_ref()) {
        return preview_failure_ack(error.code);
    }
    if let Err(error) = admit_preview(context.cache.as_ref(), channel, lock_id).await {
        return preview_failure_ack(error.code);
    }
    if request.provider == TtsProvider::Fish {
        let Some(voice_id) = request.voice_id.as_str() else {
            return preview_failure_ack(CODE_INVALID_VOICE);
        };
        match context.voice_catalog.fish_voice_exists(voice_id).await {
            Ok(true) => {}
            Ok(false) | Err(_) => return preview_failure_ack(CODE_INVALID_VOICE),
        }
    }
    let account = match context.accounts.account(channel).await {
        Ok(Some(account)) => account,
        // The source's `404 preview_unavailable 'Account not found'`.
        Ok(None) | Err(_) => return preview_failure_ack(CODE_PREVIEW_UNAVAILABLE),
    };
    let phrase = match choose_preview_phrase(
        request.language,
        request.provider,
        call.phrase_index,
    ) {
        Ok(phrase) => phrase,
        Err(error) => return preview_failure_ack(error.code),
    };
    // Piper can continue consuming credits past zero, like ordinary speech.
    if request.provider != TtsProvider::Piper {
        let availability = match context.credits.credits(channel, &account).await {
            Ok(availability) => availability,
            Err(_) => return preview_failure_ack(CODE_PREVIEW_UNAVAILABLE),
        };
        if !credits_cover_preview(&availability, phrase.credits) {
            return preview_failure_ack(CODE_INSUFFICIENT_CREDITS);
        }
    }
    let speech_id = format!("preview-{}", uuid::Uuid::new_v4());
    let usage_request_id = JsString::from(uuid::Uuid::new_v4().to_string());
    let text = JsString::from(phrase.text);
    let audio = match context
        .synthesis
        .synthesize(PreviewSynthesisJob {
            channel_id: channel,
            speech_id: &speech_id,
            provider: request.provider,
            language: request.language,
            text: text.clone(),
            voice: request.voice_id.clone(),
            signal: call.cancellation.signal(),
        })
        .await
    {
        Ok(audio) => audio,
        Err(error) => return preview_failure_ack(error.code),
    };
    // One usage entry per successful generation, after the audio was read.
    let options = preview_usage_options(
        &channel_id,
        &account.streamer,
        request.provider,
        &text,
        &JsString::from(uuid::Uuid::new_v4().to_string()),
        &usage_request_id,
        &JsString::from(speech_id.as_str()),
    );
    if context.billing.track(options).await.is_err() {
        return preview_failure_ack(CODE_PREVIEW_UNAVAILABLE);
    }
    preview_success_ack(&request, &phrase, &audio)
}

/// The namespace handshake error. Its `Display` is the exact message the
/// source passes to `next(new Error(…))`, and socketioxide sends it as the
/// `connect_error` payload.
#[cfg(feature = "socketio")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviewAuthError {
    Unauthorized,
    Unavailable,
}

#[cfg(feature = "socketio")]
impl fmt::Display for PreviewAuthError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unauthorized => formatter.write_str(MESSAGE_UNAUTHORIZED_PREVIEW),
            Self::Unavailable => formatter.write_str(MESSAGE_PREVIEW_CONNECTION_UNAVAILABLE),
        }
    }
}

#[cfg(feature = "socketio")]
impl std::error::Error for PreviewAuthError {}

/// The source's namespace middleware: `ticket` from the handshake auth, the
/// namespace's channel segment, and `GETDEL tts:preview:ticket:<ticket>`.
#[cfg(feature = "socketio")]
pub async fn authorize_preview(
    cache: &dyn PreviewCache,
    namespace: &str,
    auth: Option<&serde_json::Value>,
) -> Result<(), PreviewAuthError> {
    let channel = preview_namespace_channel(namespace).unwrap_or_default();
    if !valid_preview_channel(channel) {
        return Err(PreviewAuthError::Unauthorized);
    }
    let ticket = auth
        .and_then(|auth| auth.get("ticket"))
        .and_then(|ticket| ticket.as_str());
    match authenticate_ticket(cache, ticket, channel).await {
        TicketDecision::Authorized => Ok(()),
        TicketDecision::Unauthorized => Err(PreviewAuthError::Unauthorized),
        TicketDecision::Unavailable => Err(PreviewAuthError::Unavailable),
    }
}

/// Registers `/speech-preview/{channel}` with the ticket middleware, the
/// `preview` event handler, the five-minute socket expiry and the 30 s lock
/// renewal.
///
/// The source uses `io.of(/^\/speech-preview\/\d+$/)` plus `namespace.use(...)`.
/// Here the numeric namespace is a `dyn_ns` route and the middleware is
/// `ConnectHandler::with`, which socketioxide runs before the socket joins the
/// namespace; a rejection sends `connect_error` with the error's `Display` and
/// the connection handler never runs — the same observable behavior as
/// `next(new Error(message))`.
#[cfg(feature = "socketio")]
pub fn register_voice_preview(
    io: &socketioxide::SocketIo,
    context: Arc<PreviewContext>,
) -> Result<(), socketioxide::NsInsertError> {
    use socketioxide::extract::{SocketRef, TryData};
    use socketioxide::handler::ConnectHandler as _;

    let authorization = context.clone();
    let middleware = async move |socket: SocketRef, TryData(auth): TryData<serde_json::Value>| {
        authorize_preview(authorization.cache.as_ref(), socket.ns(), auth.as_ref().ok()).await
    };
    let handler = async move |socket: SocketRef| preview_connect(context.clone(), socket).await;
    io.dyn_ns(PREVIEW_NAMESPACE_ROUTE, handler.with(middleware))
}

#[cfg(feature = "socketio")]
async fn preview_connect(context: Arc<PreviewContext>, socket: socketioxide::extract::SocketRef) {
    use socketioxide::extract::{AckSender, SocketRef, TryData};
    use socketioxide::socket::DisconnectReason;
    use std::sync::Mutex as StdMutex;

    let Some(channel) = preview_namespace_channel(socket.ns()).map(str::to_owned) else {
        let _ = socket.disconnect();
        return;
    };
    let started = std::time::Instant::now();
    let session = Arc::new(Mutex::new(PreviewSession::new(
        channel,
        Duration::ZERO,
    )));
    let active = Arc::new(Mutex::new(Option::<SpeechCancellation>::None));
    let tasks = Arc::new(StdMutex::new(Vec::<tokio::task::JoinHandle<()>>::new()));

    // The source's five-minute socket expiry.
    let expiry_socket = socket.clone();
    let expiry = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(PREVIEW_DISCONNECT_SECONDS)).await;
        let _ = expiry_socket.disconnect();
    });
    if let Ok(mut tasks) = tasks.lock() {
        tasks.push(expiry);
    }

    // The source's 30 s lock renewal interval; a renewal failure disconnects.
    let renewal_context = context.clone();
    let renewal_session = session.clone();
    let renewal_socket = socket.clone();
    let renewal = tokio::spawn(async move {
        let mut ticker =
            tokio::time::interval(Duration::from_secs(PREVIEW_LOCK_RENEWAL_SECONDS));
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let now = started.elapsed();
            let mut session = renewal_session.lock().await;
            if renew_preview_session(renewal_context.cache.as_ref(), &mut session, now)
                .await
                .is_err()
            {
                drop(session);
                let _ = renewal_socket.disconnect();
                return;
            }
        }
    });
    if let Ok(mut tasks) = tasks.lock() {
        tasks.push(renewal);
    }

    let event_context = context.clone();
    let event_session = session.clone();
    let event_active = active.clone();
    socket.on(
        "preview",
        async move |socket: SocketRef,
                    TryData(body): TryData<serde_json::Value>,
                    ack: AckSender| {
            if !socket.connected() {
                return;
            }
            let cancellation = SpeechCancellation::new();
            {
                let mut active = event_active.lock().await;
                *active = Some(cancellation.clone());
            }
            // The source parses the raw body, so an unparsable payload becomes
            // `Invalid preview` through the ordinary body validation.
            let body = body
                .ok()
                .and_then(|body| {
                    crate::utils::lossless_json::parse_json(&body.to_string()).ok()
                })
                .unwrap_or(JsonValue::Null);
            let payload = handle_preview(
                event_context.as_ref(),
                PreviewCall {
                    body: &body,
                    session: event_session.as_ref(),
                    cancellation: &cancellation,
                    phrase_index: random_preview_index(),
                    now: started.elapsed(),
                },
            )
            .await;
            {
                let mut active = event_active.lock().await;
                *active = None;
            }
            let _ = ack.send(&wire_value(&payload));
        },
    );

    let cleanup_context = context.clone();
    let cleanup_session = session.clone();
    let cleanup_active = active.clone();
    let cleanup_tasks = tasks.clone();
    socket.on_disconnect(
        async move |socket: SocketRef, _reason: DisconnectReason| {
            {
                let mut active = cleanup_active.lock().await;
                if let Some(cancellation) = active.take() {
                    cancellation.cancel_with("Preview disconnected");
                }
            }
            let released = {
                let mut state = cleanup_session.lock().await;
                state.finish()
            };
            if let Ok(tasks) = cleanup_tasks.lock() {
                for task in tasks.iter() {
                    task.abort();
                }
            }
            if let Some(lock_id) = released
                && let Some(channel) = preview_namespace_channel(socket.ns())
            {
                release_preview(cleanup_context.cache.as_ref(), channel, &lock_id).await;
            }
        },
    );
}

#[cfg(test)]
mod tests {
    use super::super::default_queue::{
        QueueDefaultTtsError, QueueDefaultTtsFilters, QueueDefaultTtsSettings,
        QueueDefaultTtsVoices,
    };
    // Explicit imports keep the tests independent of the module's own glob.
    use crate::utils::{
        ai_credit_projection::PlanTier,
        ai_credit_reader::CreditOwner,
        js_string::JsString,
        lossless_json::{JsonValue, parse_json},
        tts::{TtsLanguage, TtsProvider},
        tts_defaults::{PIPER_VOICE_EN, PIPER_VOICE_ES},
        tts_usage::{TtsUsageStreamer, TtsUsageTrackOptions},
    };
    use std::{
        collections::BTreeMap,
        sync::{Arc, Mutex as StdMutex},
        time::Duration,
    };
    use tokio::sync::Mutex;

    use super::super::tts_client::{SpeechCancellation, SpeechFuture};
    use super::*;

    fn text(value: &str) -> JsString {
        JsString::from(value)
    }

    #[test]
    fn phrase_tables_match_the_source() {
        assert_eq!(PREVIEW_PHRASES_EN.len(), 5);
        assert_eq!(PREVIEW_PHRASES_ES.len(), 5);
        assert!(PREVIEW_PHRASES_EN[0].starts_with("Welcome to the stream!"));
        assert!(PREVIEW_PHRASES_ES[0].starts_with("¡Bienvenidos al directo!"));
        assert_eq!(PREVIEW_MAX_CREDITS, 150.0);
    }

    #[test]
    fn fish_counts_utf16_units_and_others_count_code_points() {
        assert_eq!(preview_character_count(TtsProvider::Fish, "a😀"), 3.0);
        assert_eq!(preview_character_count(TtsProvider::Kokoro, "a😀"), 2.0);
        assert_eq!(
            preview_credit_cost(TtsProvider::Fish, &"a".repeat(100)),
            150.0
        );
        assert_eq!(
            preview_credit_cost(TtsProvider::Piper, &"a".repeat(100)),
            2.0
        );
    }

    #[test]
    fn credit_limit_rejects_only_above_the_ceiling() {
        assert!(ensure_preview_within_limit(150.0).is_ok());
        let error = ensure_preview_within_limit(151.0).expect_err("over the limit");
        assert_eq!(error.status, 503);
        assert_eq!(error.code, CODE_PREVIEW_UNAVAILABLE);
        assert_eq!(error.message, "Preview exceeds credit limit");
    }

    #[test]
    fn chosen_phrase_reports_its_priced_cost() {
        let phrase =
            choose_preview_phrase(TtsLanguage::Es, TtsProvider::Fish, 2).expect("fixture phrase");
        assert_eq!(phrase.text, PREVIEW_PHRASES_ES[2]);
        assert!(phrase.credits > 0.0 && phrase.credits <= PREVIEW_MAX_CREDITS);
        assert!(choose_preview_phrase(TtsLanguage::En, TtsProvider::Piper, 5).is_err());
    }

    #[test]
    fn random_index_stays_inside_the_table() {
        for _ in 0..16 {
            assert!(random_preview_index() < PREVIEW_PHRASES_EN.len());
        }
    }

    #[test]
    fn request_validation_matches_the_destructuring_default() {
        let body = JsonValue::Object(vec![
            ("voiceId".into(), JsonValue::String(text(&"a".repeat(32)))),
            ("language".into(), JsonValue::String(text("en"))),
        ]);
        let request = parse_preview_request(&body).expect("valid request");
        assert_eq!(request.provider, TtsProvider::Fish);
        assert_eq!(request.language, TtsLanguage::En);

        let null_provider = JsonValue::Object(vec![
            ("voiceId".into(), JsonValue::String(text("af_heart"))),
            ("language".into(), JsonValue::String(text("en"))),
            ("provider".into(), JsonValue::Null),
        ]);
        assert_eq!(
            parse_preview_request(&null_provider)
                .expect_err("null provider")
                .code,
            CODE_INVALID_VOICE
        );

        let bad_language = JsonValue::Object(vec![
            ("voiceId".into(), JsonValue::String(text("af_heart"))),
            ("language".into(), JsonValue::String(text("fr"))),
        ]);
        assert!(parse_preview_request(&bad_language).is_err());

        assert!(parse_preview_request(&JsonValue::String(text("x"))).is_err());
    }

    #[test]
    fn provider_specific_voice_validation() {
        let kokoro = PreviewRequest {
            voice_id: text("af_heart"),
            language: TtsLanguage::En,
            provider: TtsProvider::Kokoro,
        };
        assert!(validate_preview_voice(&kokoro, None).is_ok());
        let bad_kokoro = PreviewRequest {
            voice_id: text("nope"),
            ..kokoro
        };
        assert!(validate_preview_voice(&bad_kokoro, None).is_err());

        let fish = PreviewRequest {
            voice_id: text(&"A".repeat(32)),
            language: TtsLanguage::Es,
            provider: TtsProvider::Fish,
        };
        assert!(validate_preview_voice(&fish, None).is_ok());
        let short_fish = PreviewRequest {
            voice_id: text(&"a".repeat(31)),
            ..fish
        };
        assert!(validate_preview_voice(&short_fish, None).is_err());

        let piper = PreviewRequest {
            voice_id: text(PIPER_VOICE_EN),
            language: TtsLanguage::En,
            provider: TtsProvider::Piper,
        };
        assert!(validate_preview_voice(&piper, None).is_ok());
        let channel_voice = PreviewRequest {
            voice_id: text("custom-voice"),
            ..piper.clone()
        };
        assert!(validate_preview_voice(&channel_voice, None).is_err());
        assert!(validate_preview_voice(&channel_voice, Some(&text("custom-voice"))).is_ok());
    }

    #[test]
    fn ticket_format_and_numeric_namespace() {
        assert!(valid_ticket_format(&"a".repeat(64)));
        assert!(!valid_ticket_format(&"A".repeat(64)));
        assert!(!valid_ticket_format(&"a".repeat(63)));
        assert_eq!(
            preview_namespace_channel("/speech-preview/123"),
            Some("123")
        );
        assert_eq!(preview_namespace_channel("/speech-preview/"), None);
        assert_eq!(preview_namespace_channel("speech-preview/123"), None);
        assert!(valid_preview_channel("123"));
        assert!(!valid_preview_channel("12a"));
        assert!(!valid_preview_channel(""));
        assert!(
            valid_fish_voice_id(&text(&"F".repeat(32))),
            "the Fish pattern is case-insensitive"
        );
    }

    #[test]
    fn handshake_decisions() {
        let ticket = "a".repeat(64);
        let ticket = ticket.as_str();
        assert_eq!(
            authenticate_preview_ticket(
                Some(ticket),
                TicketLookup::Stored(Some("123".into())),
                "123"
            ),
            TicketDecision::Authorized
        );
        assert_eq!(
            authenticate_preview_ticket(
                Some(ticket),
                TicketLookup::Stored(Some("456".into())),
                "123"
            ),
            TicketDecision::Unauthorized
        );
        assert_eq!(
            authenticate_preview_ticket(Some(ticket), TicketLookup::Stored(None), "123"),
            TicketDecision::Unauthorized
        );
        assert_eq!(
            authenticate_preview_ticket(Some(ticket), TicketLookup::Failed, "123"),
            TicketDecision::Unavailable
        );
        assert_eq!(
            authenticate_preview_ticket(Some("short"), TicketLookup::Failed, "123"),
            TicketDecision::Unauthorized,
            "the shape check happens before the cache is touched"
        );
        assert_eq!(
            TicketDecision::Unavailable.error_message(),
            Some(MESSAGE_PREVIEW_CONNECTION_UNAVAILABLE)
        );
        assert_eq!(
            TicketDecision::Unauthorized.error_message(),
            Some(MESSAGE_UNAUTHORIZED_PREVIEW)
        );
    }

    #[test]
    fn credits_must_be_available_and_cover_the_cost() {
        let available = PreviewCreditAvailability {
            available: true,
            status: Some(text("available")),
            balance: 100.0,
        };
        assert!(credits_cover_preview(&available, 100.0));
        assert!(!credits_cover_preview(&available, 101.0));
        let unavailable = PreviewCreditAvailability {
            available: false,
            ..available.clone()
        };
        assert!(!credits_cover_preview(&unavailable, 1.0));
        let unavailable_status = PreviewCreditAvailability {
            status: Some(text("unavailable")),
            ..available
        };
        assert!(!credits_cover_preview(&unavailable_status, 1.0));
    }

    #[test]
    fn credit_payload_is_read_as_the_source_comparison() {
        let value =
            parse_json(r#"{"available":true,"status":"available","balance":12.5}"#)
                .expect("fixture JSON");
        assert_eq!(
            credit_availability(&value),
            PreviewCreditAvailability {
                available: true,
                status: Some(text("available")),
                balance: 12.5,
            }
        );
    }

    #[test]
    fn preview_usage_options_carry_the_preview_receipt() {
        let options = preview_usage_options(
            &text("123"),
            &TtsUsageStreamer {
                polar_sh_customer_id: Some(text("cus")),
                plan_tier: Some(text("pro")),
            },
            TtsProvider::Fish,
            &text("hola"),
            &text("entry"),
            &text("request"),
            &text("preview-1"),
        );
        assert_eq!(options.characters, 4.0);
        assert_eq!(options.provider, text("fish"));
        let usage = options.usage.expect("usage context");
        assert_eq!(usage.source, Some(text("voice_preview")));
        assert_eq!(usage.resource_type, Some(text("voice_preview")));
        assert_eq!(usage.resource_id, Some(text("preview-1")));
    }

    #[test]
    fn preview_keys_match_the_source_layout() {
        assert_eq!(ticket_key("abc"), "tts:preview:ticket:abc");
        assert_eq!(lock_key("123"), "tts:preview:lock:123");
        assert_eq!(cooldown_key("123"), "tts:preview:cooldown:123");
    }

    fn result(
        error: bool,
        output_path: Option<&str>,
        mime_type: Option<&'static str>,
    ) -> TtsSynthesisResult {
        TtsSynthesisResult {
            error,
            message: "fixture".into(),
            output_path: output_path.map(PathBuf::from),
            public_path: None,
            mime_type,
        }
    }

    #[test]
    fn synthesis_result_mapping_uses_the_source_rules() {
        let failed = map_synthesis_result(&result(true, None, None), TtsProvider::Piper)
            .expect_err("provider error");
        assert_eq!(failed.status, 502);
        assert_eq!(failed.code, CODE_SYNTHESIS_FAILED);
        assert_eq!(failed.message, MESSAGE_SYNTHESIS_FAILED);

        let missing = map_synthesis_result(&result(false, None, None), TtsProvider::Fish)
            .expect_err("missing output path");
        assert_eq!(missing.code, CODE_SYNTHESIS_FAILED);

        let (path, mime) = map_synthesis_result(
            &result(false, Some("/speech/123/preview-a.wav"), None),
            TtsProvider::Piper,
        )
        .expect("piper result");
        assert_eq!(path, PathBuf::from("/speech/123/preview-a.wav"));
        assert_eq!(mime, "audio/wav");

        let (_, mime) = map_synthesis_result(
            &result(false, Some("/speech/123/preview-a.mp3"), None),
            TtsProvider::Fish,
        )
        .expect("fish result");
        assert_eq!(mime, "audio/mpeg");

        let (_, mime) = map_synthesis_result(
            &result(
                false,
                Some("/speech/123/preview-a.bin"),
                Some("audio/ogg"),
            ),
            TtsProvider::Kokoro,
        )
        .expect("kokoro result");
        assert_eq!(mime, "audio/ogg", "a provider MIME type wins");
    }

    #[tokio::test]
    async fn preview_audio_is_read_and_always_removed() {
        let directory = std::env::temp_dir().join(format!("dima-preview-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&directory)
            .await
            .expect("create fixture directory");
        let path = directory.join("preview.wav");
        tokio::fs::write(&path, b"audio-bytes")
            .await
            .expect("write fixture audio");
        let bytes = read_preview_audio(&path).await.expect("audio");
        assert_eq!(bytes, b"audio-bytes");
        assert!(!path.exists(), "the source removes the file in finally");

        let empty = directory.join("empty.wav");
        tokio::fs::write(&empty, b"")
            .await
            .expect("write empty fixture");
        let error = read_preview_audio(&empty).await.expect_err("empty audio");
        assert_eq!(error.code, CODE_SYNTHESIS_FAILED);
        assert_eq!(error.message, MESSAGE_EMPTY_PREVIEW_AUDIO);
        assert!(!empty.exists());

        let missing = directory.join("missing.wav");
        let error = read_preview_audio(&missing).await.expect_err("missing audio");
        assert_eq!(error.code, CODE_PREVIEW_UNAVAILABLE);
        let _ = tokio::fs::remove_dir_all(&directory).await;
    }

    #[test]
    fn success_ack_matches_the_source_payload() {
        let request = PreviewRequest {
            voice_id: text("af_heart"),
            language: TtsLanguage::En,
            provider: TtsProvider::Kokoro,
        };
        let phrase = PreviewPhrase {
            text: "Hello, chat!",
            credits: 3.0,
        };
        let audio = PreviewAudio {
            bytes: b"audio".to_vec(),
            mime_type: "audio/mpeg",
        };
        assert_eq!(
            preview_success_ack(&request, &phrase, &audio).to_json_string(),
            r#"{"error":false,"data":{"provider":"kokoro","voiceId":"af_heart","text":"Hello, chat!","credits":3,"mimeType":"audio/mpeg","audio":"YXVkaW8="}}"#
        );
        assert_eq!(
            preview_failure_ack(CODE_PREVIEW_BUSY).to_json_string(),
            r#"{"error":true,"code":"preview_busy"}"#
        );
    }

    #[test]
    fn wire_value_keeps_the_ack_shape_for_the_transport() {
        let ack = preview_failure_ack(CODE_SYNTHESIS_FAILED);
        let wire = wire_value(&ack);
        assert_eq!(wire["error"], serde_json::Value::Bool(true));
        assert_eq!(wire["code"], serde_json::Value::String("synthesis_failed".into()));
        let success = preview_success_ack(
            &PreviewRequest {
                voice_id: text("es_MX-ald-medium"),
                language: TtsLanguage::Es,
                provider: TtsProvider::Piper,
            },
            &PreviewPhrase {
                text: "hola",
                credits: 1.0,
            },
            &PreviewAudio {
                bytes: b"x".to_vec(),
                mime_type: "audio/wav",
            },
        );
        let wire = wire_value(&success);
        assert_eq!(wire["data"]["credits"], serde_json::json!(1.0));
        assert_eq!(wire["data"]["audio"], serde_json::json!("eA=="));
    }

    #[test]
    fn session_rejects_a_second_preview_while_busy() {
        let mut session = PreviewSession::new("123", Duration::ZERO);
        assert_eq!(session.begin(Duration::ZERO, "lock-a"), SessionBegin::Started);
        assert!(session.is_busy());
        assert_eq!(
            session.begin(Duration::from_secs(1), "lock-b"),
            SessionBegin::Busy
        );
        assert_eq!(
            preview_failure_ack(CODE_PREVIEW_BUSY).to_json_string(),
            r#"{"error":true,"code":"preview_busy"}"#
        );
        assert_eq!(session.finish(), Some("lock-a".into()));
        assert!(!session.is_busy());
        assert_eq!(session.begin(Duration::from_secs(2), "lock-c"), SessionBegin::Started);
    }

    #[test]
    fn session_expires_the_socket_at_five_minutes() {
        let session = PreviewSession::new("123", Duration::from_secs(10));
        assert_eq!(
            session.expiry_deadline(),
            Duration::from_secs(10 + PREVIEW_DISCONNECT_SECONDS)
        );
        assert!(!session.expired_at(Duration::from_secs(309)));
        assert!(session.expired_at(Duration::from_secs(310)));
    }

    #[test]
    fn session_arms_the_renewal_cadence() {
        let mut session = PreviewSession::new("123", Duration::ZERO);
        session.begin(Duration::ZERO, "lock-a");
        assert_eq!(session.renewal_due(Duration::from_secs(29)), None);
        assert_eq!(
            session.renewal_due(Duration::from_secs(30)),
            Some("lock-a")
        );
        session.mark_renewed(Duration::from_secs(30));
        assert_eq!(session.renewal_due(Duration::from_secs(59)), None);
        assert_eq!(
            session.renewal_due(Duration::from_secs(60)),
            Some("lock-a")
        );
    }

    #[derive(Default)]
    struct FixtureCacheState {
        tickets: BTreeMap<String, String>,
        lock: Option<String>,
        cooldown: bool,
        renewals: Vec<(String, u64)>,
        releases: Vec<String>,
    }

    struct FixtureCache {
        state: StdMutex<FixtureCacheState>,
        fail: bool,
    }

    impl FixtureCache {
        fn new() -> Self {
            Self {
                state: StdMutex::new(FixtureCacheState::default()),
                fail: false,
            }
        }

        fn failing() -> Self {
            Self {
                state: StdMutex::new(FixtureCacheState::default()),
                fail: true,
            }
        }

        fn with_ticket(ticket: &str, channel: &str) -> Self {
            let cache = Self::new();
            cache
                .state
                .lock()
                .expect("cache")
                .tickets
                .insert(ticket.to_owned(), channel.to_owned());
            cache
        }

        fn renewals(&self) -> Vec<(String, u64)> {
            self.state.lock().expect("cache").renewals.clone()
        }
    }

    impl PreviewCache for FixtureCache {
        fn store_ticket<'a>(
            &'a self,
            ticket: &'a str,
            channel_id: &'a str,
            _: u64,
        ) -> PreviewFuture<'a, Result<(), PreviewCacheError>> {
            Box::pin(async move {
                if self.fail {
                    return Err(PreviewCacheError);
                }
                self.state
                    .lock()
                    .expect("cache")
                    .tickets
                    .insert(ticket.to_owned(), channel_id.to_owned());
                Ok(())
            })
        }

        fn consume_ticket<'a>(
            &'a self,
            ticket: &'a str,
        ) -> PreviewFuture<'a, Result<Option<String>, PreviewCacheError>> {
            Box::pin(async move {
                if self.fail {
                    return Err(PreviewCacheError);
                }
                Ok(self
                    .state
                    .lock()
                    .expect("cache")
                    .tickets
                    .remove(ticket))
            })
        }

        fn acquire_lock<'a>(
            &'a self,
            _: &'a str,
            lock_id: &'a str,
            _: u64,
        ) -> PreviewFuture<'a, Result<bool, PreviewCacheError>> {
            Box::pin(async move {
                if self.fail {
                    return Err(PreviewCacheError);
                }
                let mut state = self.state.lock().expect("cache");
                if state.lock.is_some() {
                    return Ok(false);
                }
                state.lock = Some(lock_id.to_owned());
                Ok(true)
            })
        }

        fn renew_lock<'a>(
            &'a self,
            channel_id: &'a str,
            lock_id: &'a str,
            ttl_seconds: u64,
        ) -> PreviewFuture<'a, Result<bool, PreviewCacheError>> {
            Box::pin(async move {
                if self.fail {
                    return Err(PreviewCacheError);
                }
                let mut state = self.state.lock().expect("cache");
                if state.lock.as_deref() != Some(lock_id) {
                    return Ok(false);
                }
                state.renewals.push((channel_id.to_owned(), ttl_seconds));
                Ok(true)
            })
        }

        fn release_lock<'a>(
            &'a self,
            _: &'a str,
            lock_id: &'a str,
        ) -> PreviewFuture<'a, Result<bool, PreviewCacheError>> {
            Box::pin(async move {
                let mut state = self.state.lock().expect("cache");
                if state.lock.as_deref() != Some(lock_id) {
                    return Ok(false);
                }
                state.lock = None;
                state.releases.push(lock_id.to_owned());
                Ok(true)
            })
        }

        fn acquire_cooldown<'a>(
            &'a self,
            _: &'a str,
            _: u64,
        ) -> PreviewFuture<'a, Result<bool, PreviewCacheError>> {
            Box::pin(async move {
                if self.fail {
                    return Err(PreviewCacheError);
                }
                let mut state = self.state.lock().expect("cache");
                if state.cooldown {
                    return Ok(false);
                }
                state.cooldown = true;
                Ok(true)
            })
        }
    }

    #[tokio::test]
    async fn renewal_advances_the_lock_ttl_on_the_source_cadence() {
        let cache = FixtureCache::new();
        let mut session = PreviewSession::new("123", Duration::ZERO);
        session.begin(Duration::ZERO, "lock-a");

        assert!(!renew_preview_session(&cache, &mut session, Duration::from_secs(29))
            .await
            .expect("not due"));
        assert!(cache.renewals().is_empty());

        assert!(renew_preview_session(&cache, &mut session, Duration::from_secs(30))
            .await
            .expect("renewed"));
        assert_eq!(
            cache.renewals(),
            vec![("123".to_owned(), PREVIEW_LOCK_TTL_SECONDS)]
        );
        assert!(
            !renew_preview_session(&cache, &mut session, Duration::from_secs(59))
                .await
                .expect("not due again")
        );

        let failing = FixtureCache::failing();
        let error = renew_preview_session(&failing, &mut session, Duration::from_secs(60))
            .await
            .expect_err("cache failure");
        assert_eq!(error.code, CODE_PREVIEW_UNAVAILABLE);
    }

    #[tokio::test]
    async fn ticket_handshake_outcomes() {
        let ticket = "b".repeat(64);
        let cache = FixtureCache::with_ticket(&ticket, "123");
        assert_eq!(
            authenticate_ticket(&cache, Some(&ticket), "123").await,
            TicketDecision::Authorized
        );
        assert_eq!(
            authenticate_ticket(&cache, Some(&ticket), "123").await,
            TicketDecision::Unauthorized,
            "GETDEL consumes the ticket"
        );

        let cache = FixtureCache::with_ticket(&ticket, "456");
        assert_eq!(
            authenticate_ticket(&cache, Some(&ticket), "123").await,
            TicketDecision::Unauthorized
        );

        let cache = FixtureCache::failing();
        assert_eq!(
            authenticate_ticket(&cache, Some(&ticket), "123").await,
            TicketDecision::Unavailable
        );
        assert_eq!(
            TicketDecision::Unavailable.error_message(),
            Some("Preview connection unavailable")
        );

        let cache = FixtureCache::new();
        assert_eq!(
            authenticate_ticket(&cache, Some("short"), "123").await,
            TicketDecision::Unauthorized
        );
    }

    struct FixtureSettings {
        settings: QueueDefaultTtsSettings,
    }

    impl TtsSettingsSource for FixtureSettings {
        fn settings<'a>(
            &'a self,
            _: &'a JsString,
        ) -> SpeechFuture<'a, Result<QueueDefaultTtsSettings, QueueDefaultTtsError>> {
            let settings = self.settings.clone();
            Box::pin(async move { Ok(settings) })
        }
    }

    struct FixtureAccounts;

    impl PreviewAccountSource for FixtureAccounts {
        fn account<'a>(
            &'a self,
            _: &'a str,
        ) -> PreviewFuture<'a, Result<Option<PreviewStreamerAccount>, VoicePreviewError>> {
            Box::pin(async move {
                Ok(Some(PreviewStreamerAccount {
                    streamer: TtsUsageStreamer {
                        polar_sh_customer_id: Some(text("cus")),
                        plan_tier: Some(text("pro")),
                    },
                    owner: CreditOwner {
                        tier: Some(PlanTier::Pro),
                        customer_id: Some("cus".into()),
                    },
                }))
            })
        }
    }

    struct FixtureCredits {
        availability: PreviewCreditAvailability,
    }

    impl PreviewCreditSource for FixtureCredits {
        fn credits<'a>(
            &'a self,
            _: &'a str,
            _: &'a PreviewStreamerAccount,
        ) -> PreviewFuture<'a, Result<PreviewCreditAvailability, VoicePreviewError>> {
            let availability = self.availability.clone();
            Box::pin(async move { Ok(availability) })
        }
    }

    struct FixtureCatalog {
        exists: Result<bool, VoicePreviewError>,
    }

    impl PreviewVoiceCatalog for FixtureCatalog {
        fn fish_voice_exists<'a>(
            &'a self,
            _: &'a str,
        ) -> PreviewFuture<'a, Result<bool, VoicePreviewError>> {
            let exists = self.exists.clone();
            Box::pin(async move { exists })
        }
    }

    struct FixtureSynthesis {
        audio: Result<PreviewAudio, VoicePreviewError>,
        jobs: StdMutex<Vec<PreviewSynthesisJob<'static>>>,
    }

    impl PreviewSynthesis for FixtureSynthesis {
        fn synthesize<'a>(
            &'a self,
            job: PreviewSynthesisJob<'a>,
        ) -> PreviewFuture<'a, Result<PreviewAudio, VoicePreviewError>> {
            self.jobs
                .lock()
                .expect("synthesis")
                .push(PreviewSynthesisJob {
                    channel_id: "123",
                    speech_id: "preview-fixed",
                    provider: job.provider,
                    language: job.language,
                    text: job.text,
                    voice: job.voice,
                    signal: job.signal,
                });
            let audio = self.audio.clone();
            Box::pin(async move { audio })
        }
    }

    struct FixtureBilling {
        calls: StdMutex<usize>,
        fail: bool,
    }

    impl PreviewBilling for FixtureBilling {
        fn track<'a>(
            &'a self,
            _: TtsUsageTrackOptions,
        ) -> PreviewFuture<'a, Result<(), VoicePreviewError>> {
            Box::pin(async move {
                *self.calls.lock().expect("billing") += 1;
                if self.fail {
                    return Err(VoicePreviewError::unavailable("billing unavailable"));
                }
                Ok(())
            })
        }
    }

    fn fixture_settings() -> QueueDefaultTtsSettings {
        QueueDefaultTtsSettings {
            enabled: JsonValue::Bool(true),
            provider: TtsProvider::Piper,
            default_language: TtsLanguage::En,
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

    struct FixtureWorld {
        cache: Arc<FixtureCache>,
        billing: Arc<FixtureBilling>,
        synthesis: Arc<FixtureSynthesis>,
        context: PreviewContext,
    }

    fn fixture_world(
        catalog: Result<bool, VoicePreviewError>,
        audio: Result<PreviewAudio, VoicePreviewError>,
        availability: PreviewCreditAvailability,
        billing_failure: bool,
    ) -> FixtureWorld {
        let cache = Arc::new(FixtureCache::new());
        let billing = Arc::new(FixtureBilling {
            calls: StdMutex::new(0),
            fail: billing_failure,
        });
        let synthesis = Arc::new(FixtureSynthesis {
            audio,
            jobs: StdMutex::new(Vec::new()),
        });
        let context = PreviewContext::with_adapters(
            cache.clone(),
            Arc::new(FixtureSettings {
                settings: fixture_settings(),
            }),
            Arc::new(FixtureAccounts),
            Arc::new(FixtureCredits { availability }),
            Arc::new(FixtureCatalog { exists: catalog }),
            synthesis.clone(),
            billing.clone(),
        );
        FixtureWorld {
            cache,
            billing,
            synthesis,
            context,
        }
    }

    fn preview_body(provider: &str, voice: &str, language: &str) -> JsonValue {
        JsonValue::Object(vec![
            ("voiceId".into(), JsonValue::String(text(voice))),
            ("language".into(), JsonValue::String(text(language))),
            ("provider".into(), JsonValue::String(text(provider))),
        ])
    }

    fn available_credits() -> PreviewCreditAvailability {
        PreviewCreditAvailability {
            available: true,
            status: Some(text("available")),
            balance: 10_000.0,
        }
    }

    #[tokio::test]
    async fn preview_delivers_audio_and_bills_once() {
        let world = fixture_world(
            Ok(true),
            Ok(PreviewAudio {
                bytes: b"audio".to_vec(),
                mime_type: "audio/wav",
            }),
            available_credits(),
            false,
        );
        let session = Mutex::new(PreviewSession::new("123", Duration::ZERO));
        let cancellation = SpeechCancellation::new();
        let body = preview_body("piper", PIPER_VOICE_EN, "en");
        let ack = handle_preview(
            &world.context,
            PreviewCall {
                body: &body,
                session: &session,
                cancellation: &cancellation,
                phrase_index: 0,
                now: Duration::ZERO,
            },
        )
        .await;
        assert_eq!(
            ack.to_json_string(),
            format!(
                r#"{{"error":false,"data":{{"provider":"piper","voiceId":"{PIPER_VOICE_EN}","text":"{}","credits":{},"mimeType":"audio/wav","audio":"YXVkaW8="}}}}"#,
                PREVIEW_PHRASES_EN[0],
                choose_preview_phrase(TtsLanguage::En, TtsProvider::Piper, 0)
                    .expect("phrase")
                    .credits
            )
        );
        assert_eq!(*world.billing.calls.lock().expect("billing"), 1);
        let jobs = world.synthesis.jobs.lock().expect("synthesis");
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].provider, TtsProvider::Piper);
        assert_eq!(jobs[0].voice, text(PIPER_VOICE_EN));
        assert_eq!(jobs[0].language, TtsLanguage::En);
        drop(jobs);
        assert!(
            world.cache.state.lock().expect("cache").lock.is_none(),
            "the lock is released after the preview"
        );
        assert!(!session.lock().await.is_busy());
    }

    #[tokio::test]
    async fn synthesis_failure_answers_synthesis_failed() {
        let world = fixture_world(
            Ok(true),
            Err(VoicePreviewError::synthesis_failed(
                MESSAGE_SYNTHESIS_FAILED,
            )),
            available_credits(),
            false,
        );
        let session = Mutex::new(PreviewSession::new("123", Duration::ZERO));
        let cancellation = SpeechCancellation::new();
        let body = preview_body("piper", PIPER_VOICE_EN, "en");
        let ack = handle_preview(
            &world.context,
            PreviewCall {
                body: &body,
                session: &session,
                cancellation: &cancellation,
                phrase_index: 0,
                now: Duration::ZERO,
            },
        )
        .await;
        assert_eq!(
            ack.to_json_string(),
            r#"{"error":true,"code":"synthesis_failed"}"#
        );
        assert_eq!(*world.billing.calls.lock().expect("billing"), 0);
    }

    #[tokio::test]
    async fn a_second_preview_on_the_same_socket_is_busy() {
        let world = fixture_world(
            Ok(true),
            Ok(PreviewAudio {
                bytes: b"audio".to_vec(),
                mime_type: "audio/wav",
            }),
            available_credits(),
            false,
        );
        let session = Mutex::new(PreviewSession::new("123", Duration::ZERO));
        {
            let mut busy = session.lock().await;
            assert_eq!(busy.begin(Duration::ZERO, "other"), SessionBegin::Started);
        }
        let cancellation = SpeechCancellation::new();
        let body = preview_body("piper", PIPER_VOICE_EN, "en");
        let ack = handle_preview(
            &world.context,
            PreviewCall {
                body: &body,
                session: &session,
                cancellation: &cancellation,
                phrase_index: 0,
                now: Duration::from_secs(1),
            },
        )
        .await;
        assert_eq!(
            ack.to_json_string(),
            r#"{"error":true,"code":"preview_busy"}"#
        );
        assert_eq!(*world.billing.calls.lock().expect("billing"), 0);
        assert_eq!(session.lock().await.lock_id(), Some("other"));
    }

    #[tokio::test]
    async fn a_missing_fish_voice_is_invalid_before_synthesis() {
        let world = fixture_world(
            Err(VoicePreviewError::invalid_voice("Invalid Fish voice")),
            Err(VoicePreviewError::synthesis_failed("unused")),
            available_credits(),
            false,
        );
        let session = Mutex::new(PreviewSession::new("123", Duration::ZERO));
        let cancellation = SpeechCancellation::new();
        let voice = "a".repeat(32);
        let body = preview_body("fish", &voice, "en");
        let ack = handle_preview(
            &world.context,
            PreviewCall {
                body: &body,
                session: &session,
                cancellation: &cancellation,
                phrase_index: 0,
                now: Duration::ZERO,
            },
        )
        .await;
        assert_eq!(
            ack.to_json_string(),
            r#"{"error":true,"code":"invalid_voice"}"#
        );
        assert_eq!(*world.billing.calls.lock().expect("billing"), 0);
        assert!(session.lock().await.lock_id().is_none());
    }

    #[tokio::test]
    async fn a_short_fish_voice_never_reaches_the_catalog() {
        let world = fixture_world(
            Ok(true),
            Err(VoicePreviewError::synthesis_failed("unused")),
            available_credits(),
            false,
        );
        let session = Mutex::new(PreviewSession::new("123", Duration::ZERO));
        let cancellation = SpeechCancellation::new();
        let body = preview_body("fish", "abc", "en");
        let ack = handle_preview(
            &world.context,
            PreviewCall {
                body: &body,
                session: &session,
                cancellation: &cancellation,
                phrase_index: 0,
                now: Duration::ZERO,
            },
        )
        .await;
        assert_eq!(
            ack.to_json_string(),
            r#"{"error":true,"code":"invalid_voice"}"#
        );
    }

    #[tokio::test]
    async fn insufficient_credits_answer_402_code() {
        let world = fixture_world(
            Ok(true),
            Err(VoicePreviewError::synthesis_failed("unused")),
            PreviewCreditAvailability {
                available: true,
                status: Some(text("available")),
                balance: 0.0,
            },
            false,
        );
        let session = Mutex::new(PreviewSession::new("123", Duration::ZERO));
        let cancellation = SpeechCancellation::new();
        let body = preview_body("kokoro", "af_heart", "en");
        let ack = handle_preview(
            &world.context,
            PreviewCall {
                body: &body,
                session: &session,
                cancellation: &cancellation,
                phrase_index: 0,
                now: Duration::ZERO,
            },
        )
        .await;
        assert_eq!(
            ack.to_json_string(),
            r#"{"error":true,"code":"insufficient_credits"}"#
        );
    }

    #[cfg(feature = "socketio")]
    #[tokio::test]
    async fn authorization_messages_match_the_source() {
        let ticket = "c".repeat(64);
        let cache = FixtureCache::with_ticket(&ticket, "123");
        let auth = serde_json::json!({ "ticket": ticket.as_str() });
        assert_eq!(
            authorize_preview(&cache, "/speech-preview/123", Some(&auth))
                .await
                .map_err(|error| error.to_string()),
            Ok(())
        );

        let cache = FixtureCache::new();
        let error = authorize_preview(&cache, "/speech-preview/123", Some(&auth))
            .await
            .expect_err("consumed ticket");
        assert_eq!(error.to_string(), "Unauthorized preview");

        let cache = FixtureCache::failing();
        let error = authorize_preview(&cache, "/speech-preview/123", Some(&auth))
            .await
            .expect_err("cache failure");
        assert_eq!(error.to_string(), "Preview connection unavailable");

        let cache = FixtureCache::with_ticket(&ticket, "123");
        let error = authorize_preview(&cache, "/speech-preview/12a", Some(&auth))
            .await
            .expect_err("non numeric namespace");
        assert_eq!(error.to_string(), "Unauthorized preview");
    }

    #[cfg(feature = "socketio")]
    #[test]
    fn the_preview_namespace_registers() {
        let (_layer, io) = socketioxide::SocketIo::new_layer();
        let world = fixture_world(
            Ok(true),
            Err(VoicePreviewError::synthesis_failed("unused")),
            available_credits(),
            false,
        );
        assert!(register_voice_preview(&io, Arc::new(world.context)).is_ok());
    }
}

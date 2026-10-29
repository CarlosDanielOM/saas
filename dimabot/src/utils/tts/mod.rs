//! TTS text policies, session queues, and bounded audio-file helpers.

pub mod credit_fallback;
pub mod playback_timeout;
#[cfg(feature = "redis")]
pub mod session;
pub mod settings;

pub const EMOTIONS: &[&str] = &[
    "happy",
    "sad",
    "angry",
    "excited",
    "calm",
    "nervous",
    "confident",
    "surprised",
    "scared",
    "worried",
    "disappointed",
    "curious",
    "sarcastic",
    "satisfied",
    "delighted",
    "upset",
    "frustrated",
    "depressed",
    "empathetic",
    "embarrassed",
    "disgusted",
    "moved",
    "proud",
    "relaxed",
    "grateful",
    "disdainful",
    "unhappy",
    "anxious",
    "hysterical",
    "indifferent",
    "uncertain",
    "doubtful",
    "confused",
    "regretful",
    "guilty",
    "ashamed",
    "jealous",
    "envious",
    "hopeful",
    "optimistic",
    "pessimistic",
    "nostalgic",
    "lonely",
    "bored",
    "contemptuous",
    "sympathetic",
    "compassionate",
    "determined",
    "resigned",
];
pub const DELIVERY: &[&str] = &[
    "whisper",
    "shouting",
    "soft",
    "singing",
    "slow",
    "fast",
    "emphasis",
    "screaming",
];
pub const SOUNDS: &[&str] = &[
    "laugh",
    "chuckle",
    "giggle",
    "cry",
    "sigh",
    "gasp",
    "inhale",
    "exhale",
    "sobbing",
    "groaning",
    "panting",
    "yawning",
    "snoring",
    "clear throat",
];
pub const EFFECTS: &[&str] = &[
    "pause",
    "long-pause",
    "audience laughing",
    "background laughter",
];
pub const KOKORO_VOICES: &[&str] = &[
    "af_alloy",
    "af_aoede",
    "af_bella",
    "af_heart",
    "af_jessica",
    "af_kore",
    "af_nicole",
    "af_nova",
    "af_river",
    "af_sarah",
    "af_sky",
    "am_adam",
    "am_echo",
    "am_eric",
    "am_fenrir",
    "am_liam",
    "am_michael",
    "am_onyx",
    "am_puck",
    "am_santa",
    "bf_alice",
    "bf_emma",
    "bf_isabella",
    "bf_lily",
    "bm_daniel",
    "bm_fable",
    "bm_george",
    "bm_lewis",
    "ef_dora",
    "em_alex",
    "em_santa",
    "ff_siwis",
    "hf_alpha",
    "hf_beta",
    "hm_omega",
    "hm_psi",
    "if_sara",
    "im_nicola",
    "jf_alpha",
    "jf_gongitsune",
    "jf_nezumi",
    "jf_tebukuro",
    "jm_kumo",
    "pf_dora",
    "pm_alex",
    "pm_santa",
    "zf_xiaobei",
    "zf_xiaoni",
    "zf_xiaoxiao",
    "zf_xiaoyi",
    "zm_yunjian",
    "zm_yunxi",
    "zm_yunxia",
    "zm_yunyang",
];

use crate::utils::js_compat::{is_whitespace, trim};
use regex::Regex;
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    sync::OnceLock,
};

pub const DEFAULT_KOKORO_VOICE_EN: &str = "af_heart";
pub const DEFAULT_KOKORO_VOICE_ES: &str = "ef_dora";
pub const DEFAULT_SPEECH_TEMPLATE: &str = "$(tts $(user) dice: &t)";

pub fn expressive_tags() -> impl Iterator<Item = &'static str> {
    EMOTIONS
        .iter()
        .chain(DELIVERY)
        .chain(SOUNDS)
        .chain(EFFECTS)
        .copied()
}
pub fn resolve_kokoro_voice(value: &Value) -> Option<String> {
    resolve_kokoro_voice_str(value.as_str()?)
}
pub fn resolve_kokoro_voice_str(value: &str) -> Option<String> {
    let voice = trim(value).to_lowercase();
    KOKORO_VOICES.contains(&voice.as_str()).then_some(voice)
}
pub fn normalize_expressive_tags(input: &Value) -> BTreeMap<String, bool> {
    expressive_tags()
        .map(|tag| {
            let key = if tag == "long-pause" {
                "longPause"
            } else {
                tag
            };
            (
                tag.to_owned(),
                expressive_tag_value(
                    [
                        input.get(tag),
                        input.get("inline").and_then(|v| v.get(key)),
                        input.get("wrapping").and_then(|v| v.get(key)),
                    ],
                    Value::is_null,
                    Value::as_bool,
                ),
            )
        })
        .collect()
}

/// The nullish chain chooses a value before checking its type. A present
/// non-boolean therefore masks a legacy boolean rather than falling through.
fn expressive_tag_value<T>(
    candidates: [Option<&T>; 3],
    is_null: impl Fn(&T) -> bool,
    as_bool: impl Fn(&T) -> Option<bool>,
) -> bool {
    candidates
        .into_iter()
        .flatten()
        .find(|value| !is_null(value))
        .and_then(as_bool)
        .unwrap_or(true)
}
fn alias(tag: &str) -> &str {
    match tag {
        "anger" => "angry",
        "whispering" => "whisper",
        "laughing" => "laugh",
        "crying" | "crying loudly" => "cry",
        "sighing" => "sigh",
        "loud" => "shouting",
        "chuckling" => "chuckle",
        "gasping" => "gasp",
        "soft tone" => "soft",
        "in a hurry tone" => "fast",
        "break" => "pause",
        "long-break" => "long-pause",
        "crowd laughing" => "audience laughing",
        _ => tag,
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TtsProvider {
    Piper,
    Fish,
    Kokoro,
}
const JS_WS: &str = r"[\x09-\x0d\x20\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]";

fn expressive_tag_regex() -> &'static Regex {
    static TAGS: OnceLock<Regex> = OnceLock::new();
    TAGS.get_or_init(|| {
        Regex::new(&format!(
            r"<{JS_WS}*(/?){JS_WS}*((?i-u:[a-z][a-z -]*?)){JS_WS}*>|\[([^\[\]]*)\]"
        ))
        .unwrap()
    })
}

pub fn filter_expressive_tts_tags(
    text: &str,
    provider: TtsProvider,
    enabled: Option<&BTreeMap<String, bool>>,
) -> String {
    static HYPHEN: OnceLock<Regex> = OnceLock::new();
    static SPACES: OnceLock<Regex> = OnceLock::new();
    let tags = expressive_tag_regex();
    let hyphen = HYPHEN.get_or_init(|| Regex::new(&format!(r"{JS_WS}*-{JS_WS}*")).unwrap());
    let replaced = tags.replace_all(text, |captures: &regex::Captures<'_>| {
        let angle = captures.get(2);
        let raw = angle.or_else(|| captures.get(3)).unwrap().as_str();
        let normalized = if angle.is_some() {
            hyphen.replace_all(raw, "-").into_owned()
        } else {
            raw.to_owned()
        };
        let lower = trim(&normalized).to_lowercase();
        let tag = alias(&lower);
        if provider == TtsProvider::Fish
            && expressive_tags().any(|t| t == tag)
            && enabled.and_then(|v| v.get(tag)).copied() == Some(true)
        {
            if angle.is_some() {
                format!("<{}{tag}>", captures.get(1).map_or("", |v| v.as_str()))
            } else {
                format!("[{tag}]")
            }
        } else if angle.is_some() {
            String::new()
        } else {
            " ".to_owned()
        }
    });
    let spaces = SPACES.get_or_init(|| Regex::new(" {2,}").unwrap());
    trim(&spaces.replace_all(&replaced, " ")).to_owned()
}

pub fn reinforce_fish_tts_tags(text: &str) -> String {
    static CUE: OnceLock<Regex> = OnceLock::new();
    let cue = CUE.get_or_init(|| Regex::new(r"\[([a-z -]+)\]").unwrap());
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(c) = cue.captures(&text[cursor..]) {
        let m = c.get(0).unwrap();
        let start = cursor + m.start();
        let end = cursor + m.end();
        let tag = c.get(1).unwrap().as_str();
        out.push_str(&text[cursor..end]);
        let mut end_group = end;
        loop {
            let tail = &text[end_group..];
            let whitespace_len = tail
                .chars()
                .take_while(|c| is_whitespace(*c))
                .map(char::len_utf8)
                .sum::<usize>();
            if tail[whitespace_len..].starts_with(&text[start..end]) {
                end_group += whitespace_len + end - start;
            } else {
                break;
            }
        }
        if end_group == end && expressive_tags().any(|candidate| candidate == tag) {
            out.push(' ');
            out.push_str(&text[start..end]);
        } else {
            out.push_str(&text[end..end_group]);
        }
        cursor = end_group;
    }
    out.push_str(&text[cursor..]);
    out
}

pub fn migrate_legacy_speech_template(message: Option<&str>) -> String {
    let Some(message) = message else {
        return DEFAULT_SPEECH_TEMPLATE.to_owned();
    };
    let body = trim(message);
    if body.is_empty() || body == "$(tts &t)" {
        return DEFAULT_SPEECH_TEMPLATE.to_owned();
    }
    if body.match_indices("$(tts").any(|(index, _)| {
        body[index + 5..]
            .chars()
            .next()
            .is_some_and(|c| c == '.' || c == ')' || is_whitespace(c))
    }) {
        message.to_owned()
    } else {
        format!("$(tts {message})")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TtsStatusData {
    pub connected: bool,
    pub playing: bool,
    pub preparing: bool,
    pub queue_length: u64,
}
pub fn parse_tts_status(value: &Value) -> Option<TtsStatusData> {
    let number = value.get("queueLength")?.as_f64()?;
    if !number.is_finite()
        || number < 0.0
        || number > 9_007_199_254_740_991.0
        || number.fract() != 0.0
    {
        return None;
    }
    Some(TtsStatusData {
        connected: value.get("connected")?.as_bool()?,
        playing: value.get("playing")?.as_bool()?,
        preparing: value.get("preparing")?.as_bool()?,
        queue_length: number as u64,
    })
}
pub fn format_tts_status(data: &TtsStatusData) -> String {
    let activity = if data.playing {
        "playing"
    } else if data.preparing {
        "preparing"
    } else if data.queue_length > 0 {
        "waiting"
    } else {
        "idle"
    };
    format!(
        "TTS: {} · {activity} · {} queued",
        if data.connected {
            "connected"
        } else {
            "disconnected"
        },
        data.queue_length
    )
}

/// A namespace identifier, not a cryptographic token. Each factory has an
/// independently seeded hash state; the JS source likewise uses Math.random.
pub fn generate_speech_id(length: usize) -> String {
    use std::{
        collections::hash_map::RandomState,
        hash::{BuildHasher, Hasher},
    };
    let random = RandomState::new();
    let mut output = String::with_capacity(length);
    for index in 0..length {
        let mut h = random.build_hasher();
        h.write_usize(index);
        output.push(b"0123456789ABCDEF"[(h.finish() & 15) as usize] as char);
    }
    output
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TtsMode {
    Speak,
    Ai,
    Clone,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TtsLanguage {
    En,
    Es,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpeechSource {
    ChatCommand,
    Ast,
    Redemption,
}
pub fn build_spoken_user_message(
    user: &str,
    message: &str,
    language: TtsLanguage,
    source: SpeechSource,
) -> String {
    let user = trim(user);
    if source == SpeechSource::Ast || user.is_empty() {
        return message.to_owned();
    }
    format!(
        "{user} {}: {message}",
        if language == TtsLanguage::En {
            "say"
        } else {
            "dice"
        }
    )
}
#[derive(Clone, Debug)]
pub struct NormalizeTtsMessageOptions<'a> {
    pub skip_emotes: bool,
    pub strip_links: bool,
    pub normalize_whitespace: bool,
    pub max_length: f64,
    pub emote_names: &'a [super::js_string::JsString],
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NormalizeTtsMessageResult {
    pub error: bool,
    pub message: &'static str,
    pub text: super::js_string::JsString,
    pub original_text: String,
}
pub fn normalize_tts_message(
    text: &str,
    options: &NormalizeTtsMessageOptions<'_>,
) -> NormalizeTtsMessageResult {
    static LINKS: OnceLock<Regex> = OnceLock::new();
    let mut normalized = text.to_owned();
    if options.skip_emotes {
        let emotes: HashSet<&str> = options
            .emote_names
            .iter()
            .filter_map(|s| s.as_str())
            .map(trim)
            .filter(|s| !s.is_empty())
            .collect();
        if !emotes.is_empty() {
            let mut output = String::new();
            let mut start = 0;
            let mut whitespace = None;
            for (index, c) in normalized.char_indices() {
                let is_ws = is_whitespace(c);
                if whitespace.is_some_and(|previous| previous != is_ws) {
                    let part = &normalized[start..index];
                    if whitespace == Some(true) || !emotes.contains(trim(part)) {
                        output.push_str(part);
                    }
                    start = index;
                }
                whitespace = Some(is_ws);
            }
            let part = &normalized[start..];
            if whitespace == Some(true) || !emotes.contains(trim(part)) {
                output.push_str(part);
            }
            normalized = output;
        }
    }
    if options.strip_links {
        let links = LINKS.get_or_init(|| Regex::new(r"(?i-u:((http|https)://)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]{2,})+(:[0-9]+)?)(/[^\x09-\x0d\x20\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*)?(\?[^\x09-\x0d\x20\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+)?").unwrap());
        normalized = links.replace_all(&normalized, "[link]").into_owned();
    }
    normalized = normalized.chars().map(|c| if matches!(c, '\u{0000}'..='\u{0008}' | '\u{000b}' | '\u{000c}' | '\u{000e}'..='\u{001f}' | '\u{007f}') { ' ' } else { c }).collect();
    if options.normalize_whitespace {
        let mut output = String::with_capacity(normalized.len());
        let mut in_whitespace = false;
        for c in normalized.chars() {
            if is_whitespace(c) {
                if !in_whitespace {
                    output.push(' ');
                }
                in_whitespace = true;
            } else {
                output.push(c);
                in_whitespace = false;
            }
        }
        normalized = trim(&output).to_owned();
    } else {
        normalized = trim(&normalized).to_owned();
    }
    let mut normalized = super::js_string::JsString::from(normalized);
    if options.max_length > 0.0 && normalized.len() as f64 > options.max_length {
        normalized = normalized.slice(0, options.max_length as i64).trim();
    }
    let error = normalized.is_empty();
    NormalizeTtsMessageResult {
        error,
        message: if error {
            "No speakable text remained after filtering"
        } else {
            "TTS message normalized"
        },
        text: normalized,
        original_text: text.to_owned(),
    }
}

fn parse_js_integer(text: &str) -> Option<f64> {
    let text = text.trim_start_matches(is_whitespace);
    let (negative, rest) = if let Some(rest) = text.strip_prefix('-') {
        (true, rest)
    } else if let Some(rest) = text.strip_prefix('+') {
        (false, rest)
    } else {
        (false, text)
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let number = digits.parse::<f64>().ok()?;
    let number = if negative { -number } else { number };
    number.is_finite().then_some(number)
}
fn slice_index(index: f64, length: usize) -> usize {
    if index < 0.0 {
        ((length as f64 + index).max(0.0)) as usize
    } else {
        index.min(length as f64) as usize
    }
}
/// `emotes` preserves the caller's property order and per-property entry order.
pub fn extract_emote_names(
    message: &str,
    emotes: &[Vec<String>],
) -> Vec<super::js_string::JsString> {
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    let message = super::js_string::JsString::from(message);
    let length = message.len();
    for entry in emotes.iter().flatten() {
        let mut parts = entry.split('-');
        let (Some(start), Some(end)) = (
            parts.next().and_then(parse_js_integer),
            parts.next().and_then(parse_js_integer),
        ) else {
            continue;
        };
        let start = slice_index(start, length);
        let end = slice_index(end + 1.0, length).max(start);
        let emote = message.slice(start as i64, end as i64).trim();
        if !emote.is_empty() && seen.insert(emote.clone()) {
            output.push(emote);
        }
    }
    output
}

/// A timeout leaves the spawned operation running, just as Promise.race does.
/// Dropping its JoinHandle detaches it, so a later error is observed by Tokio.
#[derive(Debug)]
pub enum DeadlineError<E> {
    Timeout(String),
    Work(E),
    Task(tokio::task::JoinError),
}
pub async fn promise_with_timeout<F, T, E>(
    work: F,
    timeout: std::time::Duration,
    message: &str,
) -> Result<T, DeadlineError<E>>
where
    F: std::future::Future<Output = Result<T, E>> + Send + 'static,
    T: Send + 'static,
    E: Send + 'static,
{
    let mut task = tokio::spawn(work);
    match tokio::time::timeout(timeout, &mut task).await {
        Ok(Ok(Ok(value))) => Ok(value),
        Ok(Ok(Err(error))) => Err(DeadlineError::Work(error)),
        Ok(Err(error)) => Err(DeadlineError::Task(error)),
        Err(_) => Err(DeadlineError::Timeout(message.to_owned())),
    }
}

/// An owned stream channel, including a cancellation notification to its
/// producer. A dropped data sender denotes the source stream's normal EOF.
pub struct AudioStream {
    chunks: tokio::sync::mpsc::Receiver<Result<Vec<u8>, String>>,
    cancel: Option<tokio::sync::oneshot::Sender<Option<String>>>,
}
pub type AudioChunkSender = tokio::sync::mpsc::Sender<Result<Vec<u8>, String>>;
pub type AudioCancellation = tokio::sync::oneshot::Receiver<Option<String>>;
impl AudioStream {
    pub fn channel(capacity: usize) -> (AudioChunkSender, AudioCancellation, Self) {
        let (sender, chunks) = tokio::sync::mpsc::channel(capacity);
        let (cancel, cancellation) = tokio::sync::oneshot::channel();
        (
            sender,
            cancellation,
            Self {
                chunks,
                cancel: Some(cancel),
            },
        )
    }
    fn cancel(&mut self, reason: Option<String>) {
        self.chunks.close();
        if let Some(cancel) = self.cancel.take() {
            let _ = cancel.send(reason);
        }
    }
}
#[derive(Debug, PartialEq, Eq)]
pub enum AudioReadError {
    Timeout,
    Limit,
    Source(String),
}
/// The watch value is `None` until aborted, then contains the abort reason.
/// Normal completion releases the channel; every unfinished exit cancels it.
pub async fn read_audio_stream(
    mut stream: AudioStream,
    mut signal: tokio::sync::watch::Receiver<Option<String>>,
    max_bytes: usize,
) -> Result<Vec<u8>, AudioReadError> {
    let mut bytes = Vec::new();
    let mut signal_open = true;
    loop {
        let reason = signal.borrow().clone();
        if let Some(reason) = reason {
            stream.cancel(Some(reason));
            return Err(AudioReadError::Timeout);
        }
        tokio::select! {
            biased;
            changed = signal.changed(), if signal_open => {
                if changed.is_err() { signal_open = false; }
            }
            chunk = stream.chunks.recv() => match chunk {
                None => return Ok(bytes),
                Some(Err(error)) => { stream.cancel(signal.borrow().clone()); return Err(AudioReadError::Source(error)); }
                Some(Ok(chunk)) => {
                    if chunk.len() > max_bytes.saturating_sub(bytes.len()) {
                        stream.cancel(signal.borrow().clone());
                        return Err(AudioReadError::Limit);
                    }
                    bytes.extend_from_slice(&chunk);
                }
            }
        }
    }
}

/// JavaScript's loop emits ceil(length) characters for positive finite
/// fractional lengths. Infinity cannot terminate and is rejected explicitly.
pub fn generate_speech_id_with_length(length: f64) -> Result<String, &'static str> {
    if length.is_nan() || length <= 0.0 {
        return Ok(String::new());
    }
    if !length.is_finite() || length.ceil() > usize::MAX as f64 {
        return Err("speech ID length is not finite or representable");
    }
    Ok(generate_speech_id(length.ceil() as usize))
}
pub fn generate_default_speech_id() -> String {
    generate_speech_id(8)
}

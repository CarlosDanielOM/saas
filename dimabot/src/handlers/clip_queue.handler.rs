//! Clip request queue consumer, ported from `src/handlers/clip_queue.handler.ts`.
//!
//! The handler owns the per-channel clip request subscription, the Redis FIFO
//! queue (`twitch:<channel>:clips:queue` plus its `:data:<clipID>` payloads),
//! the `twitch:<channel>:clip:processing` lease flag, the per-clip safety timer,
//! the studio media publication and the `/clip/<channel>` socket broadcast.
//!
//! Operational rules preserved from the source:
//!
//! - One subscription per channel; a failed subscription is forgotten so the
//!   next call retries, and concurrent callers share the in-flight attempt.
//! - A request is added to the sorted set only when `ZRANK` is missing **or
//!   zero**; JavaScript treats rank `0` as falsy, so the queue head is re-added.
//! - The `processing` flag, not in-process state, decides whether a request
//!   starts playback. There is no local mutual exclusion, exactly as in the
//!   source: concurrent deliveries can both observe a missing flag.
//! - Neither `ZADD`+`SET` nor "check processing then process" is atomic. No
//!   transaction or compare-and-set behavior is added here.
//! - `ZPOPMIN` removes the clip before its data is read. A missing or malformed
//!   data key leaves the member popped, sets no lease and starts no playback.
//! - The safety timer is armed before the download, keeps running after a
//!   successful delivery, and is cleared by the normal end path or by cleanup.
//! - A timeout logs, cleans up and advances the queue. The timer entry is
//!   removed before cleanup so cleanup cannot abort the task that is running it
//!   (the source's `clearTimeout` after firing is a no-op).
//!
//! `init()`/`getIO()`/`getDragonflyClient()` have no native equivalent: the
//! constructor takes already-built adapters, every adapter is injected, and
//! module loading performs no I/O. `native(...)` replaces `init()`; it only
//! stores supplied handles. Redis Pub/Sub needs its own connection, so the
//! caller supplies a `redis::Client` in addition to the shared connection
//! manager used for queue commands.
//!
//! Deliberate, documented differences:
//!
//! - The downloader invokes `yt-dlp` without a shell and passes the URL as one
//!   argument; the source builds a shell command line by interpolation.
//! - Log payloads omit clip titles, URLs and descriptions; the source logs the
//!   whole `clipData`. Log timestamps are epoch milliseconds, not ISO strings.
//! - A subscription payload whose `clipID` is not a string is rejected at the
//!   boundary instead of being coerced by template interpolation.
//! - Unknown keys in a queued payload are not retained when the payload is
//!   re-serialized from the parsed message; the source retains them in storage
//!   but never reads them.

use std::{
    collections::BTreeMap,
    fmt,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use futures_util::StreamExt;
use redis::{aio::ConnectionManager, aio::PubSub};
use socketioxide::SocketIo;

use crate::{
    overlays_runtime::bridge::{BridgeHandle, MediaPublication},
    utils::{
        js_compat::trim,
        js_string::JsString,
        logger::{Destination, Level, LogOptions, Logger},
        lossless_json::{parse_json, truthy, JsonValue},
        observability::Telemetry,
    },
};

/// Source default before the download buffer is added (`timeoutSeconds = 60`).
const DEFAULT_TIMEOUT_SECONDS: f64 = 60.0;
/// Source buffer for download time (`timeoutSeconds += 65`).
const TIMEOUT_DOWNLOAD_BUFFER_SECONDS: f64 = 65.0;
/// TTL threshold in `cleanupOldQueueData` (`ttl > 86400`).
pub const CLEANUP_TTL_SECONDS: i64 = 86_400;
/// Node's `setTimeout` ceiling in milliseconds.
const NODE_TIMEOUT_MAX_MS: f64 = 2_147_483_647.0;
/// First retry delay for a dropped Pub/Sub connection.
const REQUEST_RECONNECT_START: Duration = Duration::from_millis(250);
/// Maximum retry delay for a dropped Pub/Sub connection.
const REQUEST_RECONNECT_MAX: Duration = Duration::from_secs(5);
/// `yt-dlp` execution bound in `downloadClip`.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);

/// A boxed, sendable future borrowed for `'a`.
pub type ClipFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
/// A boxed store result.
pub type ClipStoreFuture<'a, T> = ClipFuture<'a, Result<T, ClipQueueError>>;
/// The callback a subscription invokes for each decoded request. The concrete
/// Redis adapter spawns the returned future; the source ignores the promise
/// returned by its Pub/Sub handler, so deliveries stay concurrent.
pub type ClipRequestCallback =
    Arc<dyn Fn(ClipRequestData) -> ClipRequestFuture + Send + Sync>;
/// One decoded request handler run.
pub type ClipRequestFuture = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

/// Typed handler error with the source operation that produced it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClipQueueError {
    /// Source function name or adapter boundary.
    pub operation: String,
    /// Human-readable reason.
    pub message: String,
}

impl ClipQueueError {
    /// Build an error for `operation`.
    pub fn new(operation: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            operation: operation.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for ClipQueueError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.operation, self.message)
    }
}

impl std::error::Error for ClipQueueError {}

/// One decoded clip request. `fields` is the parsed Pub/Sub message and keeps
/// JSON property order and binary64 values, so re-serialization matches
/// `JSON.stringify(clipData)` for every understood value.
#[derive(Clone, Debug, PartialEq)]
pub struct ClipRequestData {
    /// `clipID`, required to be a string.
    pub clip_id: String,
    /// The complete parsed request object.
    pub fields: JsonValue,
}

impl ClipRequestData {
    /// Decode a parsed `ClipRequestData` message.
    ///
    /// The source interpolates `clipData.clipID` into Redis keys, coercing any
    /// value; this boundary requires the declared string type and rejects
    /// anything else instead of inventing JavaScript coercion.
    pub fn from_json(fields: JsonValue) -> Result<Self, ClipQueueError> {
        let clip_id = match fields.get("clipID") {
            Some(JsonValue::String(value)) => value
                .as_str()
                .ok_or_else(|| {
                    ClipQueueError::new(
                        "clip request",
                        "clipID contains an unpaired UTF-16 code unit",
                    )
                })?
                .to_owned(),
            _ => {
                return Err(ClipQueueError::new(
                    "clip request",
                    "clipID must be a string",
                ));
            }
        };
        Ok(Self { clip_id, fields })
    }

    /// Build a request from a clip ID and an explicit payload object.
    pub fn from_parts(clip_id: impl Into<String>, fields: JsonValue) -> Self {
        Self {
            clip_id: clip_id.into(),
            fields,
        }
    }

    /// `JSON.stringify(clipData)` used for the `:data:<clipID>` value.
    pub fn queue_json(&self) -> String {
        self.fields.to_json_string()
    }

    /// `clipData.timestamp` when it is a number or a numeric string.
    ///
    /// The source passes the raw value to `ZADD`; node-redis accepts numbers
    /// and numeric strings and throws for everything else.
    pub fn timestamp(&self) -> Option<f64> {
        match self.fields.get("timestamp") {
            Some(JsonValue::Number(value)) if value.is_finite() => Some(*value),
            Some(JsonValue::String(value)) => {
                let number = js_string_to_number(value.as_str()?);
                number.is_finite().then_some(number)
            }
            _ => None,
        }
    }

    /// The sorted-set score, or the source's `ZADD` failure for a non-numeric
    /// timestamp.
    pub fn score(&self) -> Result<f64, ClipQueueError> {
        self.timestamp().ok_or_else(|| {
            ClipQueueError::new(
                "handleClipRequest",
                "clip timestamp is not a numeric sorted-set score",
            )
        })
    }
}

/// Result shape of `downloadClip`.
#[derive(Clone, Debug, PartialEq)]
pub enum ClipDownloadOutcome {
    /// `{ error: false, message: 'Success', filePath }`.
    Success {
        /// Absolute destination path.
        file_path: PathBuf,
    },
    /// `{ error: true, message }`.
    Failure {
        /// Source-compatible failure text.
        message: String,
    },
}

impl ClipDownloadOutcome {
    /// Whether the outcome is the source's `error: true` branch.
    pub fn is_failure(&self) -> bool {
        matches!(self, Self::Failure { .. })
    }
}

/// Redis operations used by the queue lifecycle.
///
/// Each method maps to exactly one source command; the trait exists so the
/// lifecycle can be exercised without a live Dragonfly instance.
pub trait ClipQueueStore: Send + Sync {
    /// `ZCARD`.
    fn zcard<'a>(&'a self, key: &'a str) -> ClipStoreFuture<'a, u64>;
    /// `EXISTS`.
    fn exists<'a>(&'a self, key: &'a str) -> ClipStoreFuture<'a, bool>;
    /// `ZRANK`.
    fn zrank<'a>(&'a self, key: &'a str, member: &'a str) -> ClipStoreFuture<'a, Option<u64>>;
    /// `ZADD`.
    fn zadd<'a>(&'a self, key: &'a str, score: f64, member: &'a str)
        -> ClipStoreFuture<'a, ()>;
    /// `SET`.
    fn set<'a>(&'a self, key: &'a str, value: &'a str) -> ClipStoreFuture<'a, ()>;
    /// `GET`.
    fn get<'a>(&'a self, key: &'a str) -> ClipStoreFuture<'a, Option<String>>;
    /// `ZPOPMIN`.
    fn zpopmin<'a>(&'a self, key: &'a str) -> ClipStoreFuture<'a, Option<(String, f64)>>;
    /// `ZREM`.
    fn zrem<'a>(&'a self, key: &'a str, member: &'a str) -> ClipStoreFuture<'a, ()>;
    /// `DEL` for one key.
    fn del<'a>(&'a self, key: &'a str) -> ClipStoreFuture<'a, ()>;
    /// `KEYS`.
    fn keys<'a>(&'a self, pattern: &'a str) -> ClipStoreFuture<'a, Vec<String>>;
    /// `TTL`.
    fn ttl<'a>(&'a self, key: &'a str) -> ClipStoreFuture<'a, i64>;
}

/// Source `publishStudioMedia(channelID, 'clip', …)` dispatch.
pub trait StudioClipPublisher: Send + Sync {
    /// Publish the clip media into the studio queue.
    fn publish<'a>(
        &'a self,
        channel: &'a str,
        publication: &'a StudioClipPublication,
    ) -> ClipFuture<'a, ()>;
}

/// The already-built studio media publication fields.
#[derive(Clone, Debug, PartialEq)]
pub struct StudioClipPublication {
    /// `{ type: 'video', title, volume, duration, clip }`.
    pub media: JsonValue,
    /// `dist/server/routes/public/downloads/<channel>-clip.mp4`.
    pub file: String,
    /// Always `video/mp4`.
    pub mime: String,
}

/// `/clip/<channel>` broadcast and socket count.
pub trait ClipSocketSink: Send + Sync {
    /// Emit `play-clip` and return the namespace socket count observed after
    /// the emit, matching `io.of(...).sockets.size`.
    fn emit_play_clip<'a>(
        &'a self,
        channel: &'a str,
        payload: &'a JsonValue,
    ) -> ClipFuture<'a, Result<usize, ClipQueueError>>;
}

/// `downloadClip` and `deleteOldClip`.
pub trait ClipDownloader: Send + Sync {
    /// Remove an existing `video` output before downloading.
    fn delete_old_clip<'a>(&'a self, file_path: &'a Path) -> ClipFuture<'a, Result<(), String>>;
    /// Run the download into `file_path`.
    fn download_clip<'a>(
        &'a self,
        url: &'a str,
        file_path: &'a Path,
    ) -> ClipFuture<'a, ClipDownloadOutcome>;
}

/// `observe('queue_wait', …)` and `traced('queue_run', 'clips.download', …)`.
pub trait ClipTelemetry: Send + Sync {
    /// Record the queue wait in milliseconds; a non-finite wait is ignored by
    /// the concrete adapter, exactly like the source `observe`.
    fn queue_wait(&self, channel: &str, wait_ms: f64, at_ms: i64);
    /// Run the download inside the source span and end it with `ok`/`error`.
    fn trace_download<'a>(
        &'a self,
        channel: &'a str,
        run: ClipFuture<'a, ClipDownloadOutcome>,
    ) -> ClipFuture<'a, ClipDownloadOutcome>;
}

/// Structured logging seam; the source uses `console.error`/`console.log`.
pub trait ClipLog: Send + Sync {
    /// Write one metadata payload.
    fn log<'a>(
        &'a self,
        level: Level,
        payload: JsonValue,
        channel: Option<&'a str>,
    ) -> ClipFuture<'a, ()>;
}

/// Cancellation handle for one scheduled safety timeout.
#[derive(Clone)]
pub struct ClipTimerHandle {
    abort: Arc<dyn Fn() + Send + Sync>,
}

impl ClipTimerHandle {
    /// Wrap an abort callback.
    pub fn new(abort: Arc<dyn Fn() + Send + Sync>) -> Self {
        Self { abort }
    }

    /// Cancel the scheduled callback, matching `clearTimeout`.
    pub fn abort(&self) {
        (self.abort)();
    }
}

/// One-shot scheduling seam for the safety timeout.
pub trait ClipTimer: Send + Sync {
    /// Run `callback` after `delay`, returning a cancellation handle.
    fn schedule(
        &self,
        delay: Duration,
        callback: Arc<dyn Fn() + Send + Sync>,
    ) -> ClipTimerHandle;
}

/// Wall-clock seam for `Date.now()`.
pub trait ClipClock: Send + Sync {
    /// Epoch milliseconds.
    fn now_ms(&self) -> i64;
}

/// Pub/Sub subscription seam for `pubSubManager.subscribeToClipRequests`.
pub trait ClipRequestSource: Send + Sync {
    /// Subscribe to `twitch:<channel>:clip:request` and invoke `handler` for
    /// each decoded message. Returns only after the subscription exists.
    fn subscribe<'a>(
        &'a self,
        channel: &'a str,
        handler: ClipRequestCallback,
    ) -> ClipFuture<'a, Result<(), ClipQueueError>>;
}

/// Handler configuration.
#[derive(Clone, Debug)]
pub struct ClipQueueConfig {
    /// `process.cwd()/dist/server/routes/public/downloads`.
    pub download_dir: PathBuf,
}

impl ClipQueueConfig {
    /// Build a configuration with an explicit download directory.
    pub fn new(download_dir: impl Into<PathBuf>) -> Self {
        Self {
            download_dir: download_dir.into(),
        }
    }
}

/// The source `process.cwd()` download directory.
pub fn node_download_dir() -> Result<PathBuf, ClipQueueError> {
    std::env::current_dir()
        .map(|dir| dir.join("dist").join("server").join("routes").join("public").join("downloads"))
        .map_err(|error| ClipQueueError::new("process.cwd", error.to_string()))
}

/// `twitch:<channel>:clip:request`.
pub fn clip_request_topic(channel: &str) -> String {
    format!("twitch:{channel}:clip:request")
}

/// `twitch:<channel>:clips:queue`.
pub fn clips_queue_key(channel: &str) -> String {
    format!("twitch:{channel}:clips:queue")
}

/// `twitch:<channel>:clip:processing`.
pub fn clip_processing_key(channel: &str) -> String {
    format!("twitch:{channel}:clip:processing")
}

/// `twitch:<channel>:clips:queue:data:<clipID>`.
pub fn clip_queue_data_key(channel: &str, clip_id: &str) -> String {
    format!("twitch:{channel}:clips:queue:data:{clip_id}")
}

/// `twitch:<channel>:clips:timeouts:default`.
pub fn clip_timeout_setting_key(channel: &str) -> String {
    format!("twitch:{channel}:clips:timeouts:default")
}

/// `<channel>:<clipID>`.
pub fn clip_timeout_key(channel: &str, clip_id: &str) -> String {
    format!("{channel}:{clip_id}")
}

/// The file the downloader writes and the studio bridge reads.
pub fn clip_file_path(download_dir: &Path, channel: &str) -> PathBuf {
    download_dir.join(format!("{channel}-clip.mp4"))
}

/// JavaScript `parseInt(value)` with the default radix rules.
///
/// The source uses `parseInt(timeoutSetting)`, so a `0x` prefix means radix 16,
/// parsing stops at the first invalid character, and a value without digits is
/// `NaN`.
fn js_parse_int(text: &str) -> f64 {
    let text = trim(text);
    let (negative, rest) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let (radix, digits) = if let Some(hex) = rest
        .strip_prefix("0x")
        .or_else(|| rest.strip_prefix("0X"))
    {
        (16_u32, hex)
    } else {
        (10_u32, rest)
    };
    let mut value = 0_f64;
    let mut found = false;
    for character in digits.chars() {
        let Some(digit) = character.to_digit(radix) else {
            break;
        };
        found = true;
        value = value * f64::from(radix) + f64::from(digit);
    }
    if !found {
        return f64::NAN;
    }
    if negative { -value } else { value }
}

/// Node's `setTimeout` delay normalization in milliseconds.
///
/// A delay that is `NaN`, below one millisecond or above `TIMEOUT_MAX` is
/// replaced with one millisecond, matching Node's timer implementation.
fn node_timeout_delay_ms(seconds: f64) -> u64 {
    let milliseconds = seconds * 1000.0;
    if !(1.0..=NODE_TIMEOUT_MAX_MS).contains(&milliseconds) {
        1
    } else {
        milliseconds as u64
    }
}

/// JavaScript `Number(value)` for the values a clip payload can carry.
fn js_number(value: Option<&JsonValue>) -> f64 {
    match value {
        None | Some(JsonValue::Null) => 0.0,
        Some(JsonValue::Bool(value)) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        Some(JsonValue::Number(value)) => *value,
        Some(JsonValue::String(value)) => value
            .as_str()
            .map(js_string_to_number)
            .unwrap_or(f64::NAN),
        Some(JsonValue::Array(_) | JsonValue::Object(_)) => f64::NAN,
    }
}

/// JavaScript `Number(string)` for decimal, hexadecimal, binary, octal and
/// `Infinity` forms. Other spellings are `NaN`.
fn js_string_to_number(text: &str) -> f64 {
    let text = trim(text);
    if text.is_empty() {
        return 0.0;
    }
    if text == "Infinity" || text == "+Infinity" {
        return f64::INFINITY;
    }
    if text == "-Infinity" {
        return f64::NEG_INFINITY;
    }
    for (prefix, radix) in [("0x", 16_u32), ("0X", 16), ("0b", 2), ("0B", 2), ("0o", 8), ("0O", 8)] {
        if let Some(rest) = text.strip_prefix(prefix) {
            return u128::from_str_radix(rest, radix)
                .map(|value| value as f64)
                .unwrap_or(f64::NAN);
        }
    }
    if !js_decimal_grammar(text) {
        return f64::NAN;
    }
    text.parse::<f64>().unwrap_or(f64::NAN)
}

/// `[+-]? (digits ['.' digits?]? | '.' digits) ([eE] [+-]? digits)?`
fn js_decimal_grammar(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut index = 0;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        index += 1;
    }
    let mut digits = 0;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
        digits += 1;
    }
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return false;
    }
    if matches!(bytes.get(index), Some(b'e' | b'E')) {
        index += 1;
        if matches!(bytes.get(index), Some(b'+' | b'-')) {
            index += 1;
        }
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == start {
            return false;
        }
    }
    index == bytes.len()
}

/// `Math.min(30, Number(duration) || 30)`.
fn studio_duration(value: Option<&JsonValue>) -> f64 {
    let number = js_number(value);
    let number = if number == 0.0 || number.is_nan() {
        30.0
    } else {
        number
    };
    number.min(30.0)
}

/// `value || ''` as a JSON value.
fn or_empty(value: Option<&JsonValue>) -> JsonValue {
    match value {
        Some(value) if truthy(value) => value.clone(),
        _ => JsonValue::String(JsString::from_static("")),
    }
}

/// `first || second || ''`.
fn first_truthy(first: Option<&JsonValue>, second: Option<&JsonValue>) -> JsonValue {
    match (first, second) {
        (Some(first), _) if truthy(first) => first.clone(),
        (_, Some(second)) if truthy(second) => second.clone(),
        _ => JsonValue::String(JsString::from_static("")),
    }
}

/// The studio media object built by `publishStudioMedia`.
fn studio_media(data: &ClipRequestData) -> JsonValue {
    let mut clip = vec![
        (
            JsString::from_static("streamer"),
            first_truthy(data.fields.get("streamer"), data.fields.get("streamerLogin")),
        ),
        (
            JsString::from_static("game"),
            or_empty(data.fields.get("game")),
        ),
        (
            JsString::from_static("description"),
            or_empty(data.fields.get("description")),
        ),
    ];
    if let Some(value) = data.fields.get("profileImage") {
        clip.push((JsString::from_static("profileImage"), value.clone()));
    }
    if let Some(value) = data.fields.get("streamerColor") {
        clip.push((JsString::from_static("streamerColor"), value.clone()));
    }
    JsonValue::Object(vec![
        (
            JsString::from_static("type"),
            JsonValue::String(JsString::from_static("video")),
        ),
        (
            JsString::from_static("title"),
            or_empty(data.fields.get("title")),
        ),
        (
            JsString::from_static("volume"),
            JsonValue::Number(1.0),
        ),
        (
            JsString::from_static("duration"),
            JsonValue::Number(studio_duration(data.fields.get("duration"))),
        ),
        (JsString::from_static("clip"), JsonValue::Object(clip)),
    ])
}

/// The `play-clip` payload object; absent values are omitted like `undefined`
/// properties are by the socket encoder.
fn clip_payload(data: &ClipRequestData) -> JsonValue {
    const FIELDS: [&str; 10] = [
        "clipID",
        "clipUrl",
        "duration",
        "title",
        "game",
        "streamer",
        "streamerLogin",
        "profileImage",
        "description",
        "streamerColor",
    ];
    let fields = FIELDS
        .iter()
        .filter_map(|key| {
            data.fields
                .get(key)
                .map(|value| (JsString::from(*key), value.clone()))
        })
        .collect();
    JsonValue::Object(fields)
}

/// `JSON.stringify`-compatible conversion for logger and socket payloads.
fn json_to_serde(value: &JsonValue) -> serde_json::Value {
    match value {
        JsonValue::Null => serde_json::Value::Null,
        JsonValue::Bool(value) => serde_json::Value::Bool(*value),
        JsonValue::Number(value) => serde_json::Number::from_f64(*value)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        JsonValue::String(value) => serde_json::Value::String(value.to_utf8_lossy()),
        JsonValue::Array(items) => {
            serde_json::Value::Array(items.iter().map(json_to_serde).collect())
        }
        JsonValue::Object(fields) => serde_json::Value::Object(
            fields
                .iter()
                .map(|(key, value)| (key.to_utf8_lossy(), json_to_serde(value)))
                .collect(),
        ),
    }
}

/// Decode one `ZPOPMIN` reply without losing the empty-set case.
fn decode_zpop(reply: redis::Value) -> Result<Option<(String, f64)>, String> {
    match reply {
        redis::Value::Nil => Ok(None),
        redis::Value::Array(items) => {
            if items.is_empty() {
                return Ok(None);
            }
            if items.len() != 2 {
                return Err("ZPOPMIN returned an unexpected array shape".into());
            }
            Ok(Some((
                redis_string(&items[0])?,
                redis_number(&items[1])?,
            )))
        }
        redis::Value::Map(entries) => {
            if entries.is_empty() {
                return Ok(None);
            }
            if entries.len() != 1 {
                return Err("ZPOPMIN returned an unexpected map shape".into());
            }
            let (member, score) = &entries[0];
            Ok(Some((redis_string(member)?, redis_number(score)?)))
        }
        other => Err(format!("ZPOPMIN returned {other:?}")),
    }
}

fn redis_string(value: &redis::Value) -> Result<String, String> {
    match value {
        redis::Value::BulkString(bytes) => String::from_utf8(bytes.clone())
            .map_err(|_| "ZPOPMIN member is not UTF-8".to_owned()),
        redis::Value::SimpleString(text) => Ok(text.clone()),
        other => Err(format!("unexpected ZPOPMIN member {other:?}")),
    }
}

fn redis_number(value: &redis::Value) -> Result<f64, String> {
    match value {
        redis::Value::Double(value) => Ok(*value),
        redis::Value::Int(value) => Ok(*value as f64),
        redis::Value::BulkString(bytes) => String::from_utf8_lossy(bytes)
            .parse::<f64>()
            .map_err(|_| "ZPOPMIN score is not numeric".to_owned()),
        other => Err(format!("unexpected ZPOPMIN score {other:?}")),
    }
}

/// Concrete `ClipQueueStore` over the shared Dragonfly connection manager.
#[derive(Clone)]
pub struct RedisClipQueueStore {
    connection: ConnectionManager,
}

impl RedisClipQueueStore {
    /// Store the shared connection manager; construction performs no I/O.
    pub fn new(connection: ConnectionManager) -> Self {
        Self { connection }
    }

    fn command<'a, T>(
        &'a self,
        build: impl FnOnce(&mut redis::Cmd) + Send + 'a,
        operation: &'static str,
    ) -> ClipStoreFuture<'a, T>
    where
        T: redis::FromRedisValue + Send + 'a,
    {
        Box::pin(async move {
            let mut connection = self.connection.clone();
            let mut command = redis::cmd(operation);
            build(&mut command);
            command
                .query_async::<T>(&mut connection)
                .await
                .map_err(|error| ClipQueueError::new(operation, error.to_string()))
        })
    }
}

impl ClipQueueStore for RedisClipQueueStore {
    fn zcard<'a>(&'a self, key: &'a str) -> ClipStoreFuture<'a, u64> {
        self.command(|command| {
            command.arg("ZCARD").arg(key);
        }, "ZCARD")
    }

    fn exists<'a>(&'a self, key: &'a str) -> ClipStoreFuture<'a, bool> {
        self.command(|command| {
            command.arg("EXISTS").arg(key);
        }, "EXISTS")
    }

    fn zrank<'a>(&'a self, key: &'a str, member: &'a str) -> ClipStoreFuture<'a, Option<u64>> {
        self.command(|command| {
            command.arg("ZRANK").arg(key).arg(member);
        }, "ZRANK")
    }

    fn zadd<'a>(
        &'a self,
        key: &'a str,
        score: f64,
        member: &'a str,
    ) -> ClipStoreFuture<'a, ()> {
        self.command(|command| {
            command.arg("ZADD").arg(key).arg(score).arg(member);
        }, "ZADD")
    }

    fn set<'a>(&'a self, key: &'a str, value: &'a str) -> ClipStoreFuture<'a, ()> {
        self.command(|command| {
            command.arg("SET").arg(key).arg(value);
        }, "SET")
    }

    fn get<'a>(&'a self, key: &'a str) -> ClipStoreFuture<'a, Option<String>> {
        self.command(|command| {
            command.arg("GET").arg(key);
        }, "GET")
    }

    fn zpopmin<'a>(&'a self, key: &'a str) -> ClipStoreFuture<'a, Option<(String, f64)>> {
        Box::pin(async move {
            let mut connection = self.connection.clone();
            let reply = redis::cmd("ZPOPMIN")
                .arg(key)
                .query_async::<redis::Value>(&mut connection)
                .await
                .map_err(|error| ClipQueueError::new("ZPOPMIN", error.to_string()))?;
            decode_zpop(reply).map_err(|message| ClipQueueError::new("ZPOPMIN", message))
        })
    }

    fn zrem<'a>(&'a self, key: &'a str, member: &'a str) -> ClipStoreFuture<'a, ()> {
        self.command(|command| {
            command.arg("ZREM").arg(key).arg(member);
        }, "ZREM")
    }

    fn del<'a>(&'a self, key: &'a str) -> ClipStoreFuture<'a, ()> {
        self.command(|command| {
            command.arg("DEL").arg(key);
        }, "DEL")
    }

    fn keys<'a>(&'a self, pattern: &'a str) -> ClipStoreFuture<'a, Vec<String>> {
        Box::pin(async move {
            let mut connection = self.connection.clone();
            redis::cmd("KEYS")
                .arg(pattern)
                .query_async::<Vec<String>>(&mut connection)
                .await
                .map_err(|error| ClipQueueError::new("KEYS", error.to_string()))
        })
    }

    fn ttl<'a>(&'a self, key: &'a str) -> ClipStoreFuture<'a, i64> {
        self.command(|command| {
            command.arg("TTL").arg(key);
        }, "TTL")
    }
}

/// `publishStudioMedia` over the registered overlay studio bridge.
pub struct OverlayStudioClipPublisher {
    bridge: BridgeHandle,
}

impl OverlayStudioClipPublisher {
    /// Retain the bridge slot; construction performs no I/O.
    pub fn new(bridge: BridgeHandle) -> Self {
        Self { bridge }
    }
}

impl StudioClipPublisher for OverlayStudioClipPublisher {
    fn publish<'a>(
        &'a self,
        channel: &'a str,
        publication: &'a StudioClipPublication,
    ) -> ClipFuture<'a, ()> {
        Box::pin(async move {
            self.bridge
                .publish_studio_media(
                    channel,
                    MediaPublication {
                        kind: "clip".to_owned(),
                        media: publication.media.clone(),
                        file: publication.file.clone(),
                        mime: publication.mime.clone(),
                        text: None,
                        platform: None,
                        speech_id: None,
                    },
                )
                .await;
        })
    }
}

/// `io.of('/clip/<channel>').emit('play-clip', payload)`.
///
/// socketioxide creates the concrete namespace when a client connects, so an
/// unconnected channel reports `None` and therefore zero sockets; the source
/// emits into an empty namespace with the same observable result.
pub struct SocketIoClipSink {
    io: SocketIo,
}

impl SocketIoClipSink {
    /// Retain the server handle; construction performs no I/O.
    pub fn new(io: SocketIo) -> Self {
        Self { io }
    }
}

impl ClipSocketSink for SocketIoClipSink {
    fn emit_play_clip<'a>(
        &'a self,
        channel: &'a str,
        payload: &'a JsonValue,
    ) -> ClipFuture<'a, Result<usize, ClipQueueError>> {
        Box::pin(async move {
            let path = format!("/clip/{channel}");
            let Some(namespace) = self.io.of(&path) else {
                return Ok(0);
            };
            let data = json_to_serde(payload);
            namespace
                .emit("play-clip", &data)
                .await
                .map_err(|error| ClipQueueError::new("play-clip", error.to_string()))?;
            Ok(self
                .io
                .of(&path)
                .map(|namespace| namespace.sockets().len())
                .unwrap_or(0))
        })
    }
}

/// `downloadClip` and `deleteOldClip` over `yt-dlp` and the local filesystem.
pub struct YtDlpClipDownloader {
    program: String,
    timeout: Duration,
}

impl Default for YtDlpClipDownloader {
    fn default() -> Self {
        Self::new()
    }
}

impl YtDlpClipDownloader {
    /// Use `yt-dlp` from `PATH` with the source's 60-second bound.
    pub fn new() -> Self {
        Self {
            program: "yt-dlp".to_owned(),
            timeout: DOWNLOAD_TIMEOUT,
        }
    }

    /// Override the executable and timeout for wiring and tests.
    pub fn with_program(program: impl Into<String>, timeout: Duration) -> Self {
        Self {
            program: program.into(),
            timeout,
        }
    }
}

impl ClipDownloader for YtDlpClipDownloader {
    fn delete_old_clip<'a>(&'a self, file_path: &'a Path) -> ClipFuture<'a, Result<(), String>> {
        Box::pin(async move {
            match tokio::fs::remove_file(file_path).await {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error.to_string()),
            }
        })
    }

    fn download_clip<'a>(
        &'a self,
        url: &'a str,
        file_path: &'a Path,
    ) -> ClipFuture<'a, ClipDownloadOutcome> {
        Box::pin(async move {
            if let Some(parent) = file_path.parent() {
                if let Err(error) = tokio::fs::create_dir_all(parent).await {
                    return ClipDownloadOutcome::Failure {
                        message: format!("Clip download failed to create the output directory: {error}"),
                    };
                }
            }
            let mut command = tokio::process::Command::new(&self.program);
            command
                .arg("--no-progress")
                .arg("-S")
                .arg("res:480")
                .arg("-o")
                .arg(file_path)
                .arg(url)
                .kill_on_drop(true)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let output = match tokio::time::timeout(self.timeout, command.output()).await {
                Ok(Ok(output)) => output,
                Ok(Err(error)) => {
                    return ClipDownloadOutcome::Failure {
                        message: format!("Clip download failed to start or run: {error}"),
                    };
                }
                Err(_) => {
                    return ClipDownloadOutcome::Failure {
                        message: format!(
                            "Download timeout after {} seconds for URL: {url}",
                            self.timeout.as_secs()
                        ),
                    };
                }
            };
            if output.status.success() {
                if tokio::fs::metadata(file_path).await.is_ok() {
                    ClipDownloadOutcome::Success {
                        file_path: file_path.to_path_buf(),
                    }
                } else {
                    ClipDownloadOutcome::Failure {
                        message: format!(
                            "Download completed but file not found at: {}",
                            file_path.display()
                        ),
                    }
                }
            } else {
                let code = output
                    .status
                    .code()
                    .map_or_else(|| "unknown".to_owned(), |code| code.to_string());
                let stderr = String::from_utf8_lossy(&output.stderr);
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = if stderr.is_empty() {
                    "No stderr output."
                } else {
                    stderr.as_ref()
                };
                let stdout = if stdout.is_empty() {
                    "No stdout output."
                } else {
                    stdout.as_ref()
                };
                ClipDownloadOutcome::Failure {
                    message: format!(
                        "Clip download failed with exit code: {code}. Stderr: {stderr} Stdout: {stdout}"
                    ),
                }
            }
        })
    }
}

/// `observe` and `traced` over the shared native telemetry.
pub struct NativeClipTelemetry {
    telemetry: Telemetry,
}

impl NativeClipTelemetry {
    /// Retain the telemetry handle; construction performs no I/O.
    pub fn new(telemetry: Telemetry) -> Self {
        Self { telemetry }
    }
}

impl ClipTelemetry for NativeClipTelemetry {
    fn queue_wait(&self, channel: &str, wait_ms: f64, at_ms: i64) {
        self.telemetry
            .observe("queue_wait", "clips", wait_ms, "ok", Some(channel), at_ms);
    }

    fn trace_download<'a>(
        &'a self,
        channel: &'a str,
        run: ClipFuture<'a, ClipDownloadOutcome>,
    ) -> ClipFuture<'a, ClipDownloadOutcome> {
        Box::pin(async move {
            let span = self
                .telemetry
                .begin_span("queue_run", "clips.download", Some(channel));
            let outcome = span.run(run).await;
            span.end(if outcome.is_failure() { "error" } else { "ok" }, None);
            outcome
        })
    }
}

/// `console.error`/`console.log` through the shared native logger.
pub struct LoggerClipLog {
    logger: Arc<Logger>,
}

impl LoggerClipLog {
    /// Retain the application logger; construction performs no I/O.
    pub fn new(logger: Arc<Logger>) -> Self {
        Self { logger }
    }
}

impl ClipLog for LoggerClipLog {
    fn log<'a>(
        &'a self,
        level: Level,
        payload: JsonValue,
        channel: Option<&'a str>,
    ) -> ClipFuture<'a, ()> {
        Box::pin(async move {
            let _ = self
                .logger
                .log(
                    level,
                    json_to_serde(&payload),
                    LogOptions {
                        destination: Destination::Both,
                        platform: None,
                        channel_id: channel.map(str::to_owned),
                        context: None,
                    },
                )
                .await;
        })
    }
}

/// `setTimeout` through Tokio.
#[derive(Clone, Default)]
pub struct TokioClipTimer;

impl ClipTimer for TokioClipTimer {
    fn schedule(
        &self,
        delay: Duration,
        callback: Arc<dyn Fn() + Send + Sync>,
    ) -> ClipTimerHandle {
        let task = tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            callback();
        });
        ClipTimerHandle::new(Arc::new(move || task.abort()))
    }
}

/// `Date.now()`.
#[derive(Clone, Default)]
pub struct SystemClipClock;

impl ClipClock for SystemClipClock {
    fn now_ms(&self) -> i64 {
        match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(duration) => i64::try_from(duration.as_millis()).unwrap_or(i64::MAX),
            Err(error) => -i64::try_from(error.duration().as_millis()).unwrap_or(i64::MAX),
        }
    }
}

/// `pubSubManager.subscribeToClipRequests` over a dedicated Redis connection.
pub struct RedisClipRequestSource {
    client: redis::Client,
    log: Arc<dyn ClipLog>,
}

impl RedisClipRequestSource {
    /// Retain the Pub/Sub client and diagnostics sink; no connection is opened.
    pub fn new(client: redis::Client, log: Arc<dyn ClipLog>) -> Self {
        Self { client, log }
    }
}

impl ClipRequestSource for RedisClipRequestSource {
    fn subscribe<'a>(
        &'a self,
        channel: &'a str,
        handler: ClipRequestCallback,
    ) -> ClipFuture<'a, Result<(), ClipQueueError>> {
        Box::pin(async move {
            let topic = clip_request_topic(channel);
            let mut pubsub = self
                .client
                .get_async_pubsub()
                .await
                .map_err(|error| ClipQueueError::new("subscribeToChannel", error.to_string()))?;
            pubsub
                .subscribe(&topic)
                .await
                .map_err(|error| ClipQueueError::new("subscribeToChannel", error.to_string()))?;
            let client = self.client.clone();
            let log = Arc::clone(&self.log);
            tokio::spawn(run_clip_subscriber(pubsub, client, topic, handler, log));
            Ok(())
        })
    }
}

async fn run_clip_subscriber(
    mut pubsub: PubSub,
    client: redis::Client,
    topic: String,
    handler: ClipRequestCallback,
    log: Arc<dyn ClipLog>,
) {
    let mut delay = REQUEST_RECONNECT_START;
    loop {
        {
            let mut messages = pubsub.on_message();
            while let Some(message) = messages.next().await {
                if message.get_channel_name() != topic {
                    continue;
                }
                let Ok(payload) = message.get_payload::<String>() else {
                    continue;
                };
                let request = parse_json(&payload)
                    .map_err(|error| ClipQueueError::new("clip message", error))
                    .and_then(ClipRequestData::from_json);
                match request {
                    Ok(request) => {
                        let future = handler(request);
                        tokio::spawn(future);
                    }
                    Err(error) => {
                        log.log(
                            Level::Error,
                            log_payload(
                                "PubSubManager.handleMessage",
                                None,
                                None,
                                &error.to_string(),
                                None,
                            ),
                            None,
                        )
                        .await;
                    }
                }
            }
        }
        log.log(
            Level::Error,
            log_payload(
                "PubSubManager.subscriber",
                None,
                None,
                "Clip request subscriber disconnected",
                None,
            ),
            None,
        )
        .await;
        // node-redis resubscribes after a reconnect; this loop supplies the
        // same recovery with the repository's existing 250 ms..5 s cadence.
        pubsub = loop {
            tokio::time::sleep(delay).await;
            let connected = match client.get_async_pubsub().await {
                Ok(mut next) => match next.subscribe(&topic).await {
                    Ok(()) => Some(next),
                    Err(_) => None,
                },
                Err(_) => None,
            };
            if let Some(connected) = connected {
                break connected;
            }
            delay = (delay * 2).min(REQUEST_RECONNECT_MAX);
        };
        delay = REQUEST_RECONNECT_START;
    }
}

fn log_payload(
    function: &str,
    channel: Option<&str>,
    clip_id: Option<&str>,
    message: &str,
    at_ms: Option<i64>,
) -> JsonValue {
    let mut fields = vec![
        (
            JsString::from_static("function"),
            JsonValue::String(JsString::from(function)),
        ),
        (
            JsString::from_static("message"),
            JsonValue::String(JsString::from(message)),
        ),
    ];
    if let Some(channel) = channel {
        fields.push((
            JsString::from_static("channelID"),
            JsonValue::String(JsString::from(channel)),
        ));
    }
    if let Some(clip_id) = clip_id {
        fields.push((
            JsString::from_static("clipID"),
            JsonValue::String(JsString::from(clip_id)),
        ));
    }
    if let Some(at_ms) = at_ms {
        fields.push((
            JsString::from_static("timestamp"),
            JsonValue::Number(at_ms as f64),
        ));
    }
    JsonValue::Object(fields)
}

#[derive(Clone)]
enum SubscriptionState {
    Pending(tokio::sync::watch::Receiver<Option<Result<(), ClipQueueError>>>),
    Ready,
}

enum SubscriptionAction {
    Ready,
    Wait(tokio::sync::watch::Receiver<Option<Result<(), ClipQueueError>>>),
    Start,
}

type SubscriptionMap = Arc<Mutex<BTreeMap<String, SubscriptionState>>>;

struct SubscriptionFlight {
    subscriptions: SubscriptionMap,
    channel: String,
    sender: tokio::sync::watch::Sender<Option<Result<(), ClipQueueError>>>,
    finished: bool,
}

impl Drop for SubscriptionFlight {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        if let Ok(mut subscriptions) = self.subscriptions.lock() {
            subscriptions.remove(&self.channel);
        }
        self.sender.send_replace(Some(Err(ClipQueueError::new(
            "subscribeToChannel",
            "clip request subscription was cancelled",
        ))));
    }
}

/// Adapters required by [`ClipQueueHandler`].
pub struct ClipQueueAdapters {
    /// Queue commands; `None` reproduces a handler used before `init()`.
    pub store: Option<Arc<dyn ClipQueueStore>>,
    /// Clip request Pub/Sub source.
    pub requests: Arc<dyn ClipRequestSource>,
    /// `/clip/<channel>` broadcast; `None` reproduces `getIO() === null`.
    pub sockets: Option<Arc<dyn ClipSocketSink>>,
    /// Studio media publication.
    pub publisher: Arc<dyn StudioClipPublisher>,
    /// Clip download and old-file removal.
    pub downloader: Arc<dyn ClipDownloader>,
    /// Queue wait and download span telemetry.
    pub telemetry: Arc<dyn ClipTelemetry>,
    /// Structured diagnostics.
    pub log: Arc<dyn ClipLog>,
    /// Safety timeout scheduling.
    pub timer: Arc<dyn ClipTimer>,
    /// Wall clock.
    pub clock: Arc<dyn ClipClock>,
}

/// Clip request queue consumer.
pub struct ClipQueueHandler {
    store: Option<Arc<dyn ClipQueueStore>>,
    requests: Arc<dyn ClipRequestSource>,
    sockets: Option<Arc<dyn ClipSocketSink>>,
    publisher: Arc<dyn StudioClipPublisher>,
    downloader: Arc<dyn ClipDownloader>,
    telemetry: Arc<dyn ClipTelemetry>,
    log: Arc<dyn ClipLog>,
    timer: Arc<dyn ClipTimer>,
    clock: Arc<dyn ClipClock>,
    config: ClipQueueConfig,
    subscriptions: SubscriptionMap,
    timeouts: Mutex<BTreeMap<String, ClipTimerHandle>>,
    active_clip_ids: Mutex<BTreeMap<String, String>>,
}

impl ClipQueueHandler {
    /// Build a handler from injected adapters. Performs no I/O.
    pub fn with_adapters(adapters: ClipQueueAdapters, config: ClipQueueConfig) -> Self {
        Self {
            store: adapters.store,
            requests: adapters.requests,
            sockets: adapters.sockets,
            publisher: adapters.publisher,
            downloader: adapters.downloader,
            telemetry: adapters.telemetry,
            log: adapters.log,
            timer: adapters.timer,
            clock: adapters.clock,
            config,
            subscriptions: Arc::new(Mutex::new(BTreeMap::new())),
            timeouts: Mutex::new(BTreeMap::new()),
            active_clip_ids: Mutex::new(BTreeMap::new()),
        }
    }

    /// Full production wiring, replacing the source `init()`. No I/O occurs
    /// here: the caller has already built the Redis handles and the server.
    #[allow(clippy::too_many_arguments)]
    pub fn native(
        connection: ConnectionManager,
        subscriber_client: redis::Client,
        sockets: Option<SocketIo>,
        publisher: Arc<dyn StudioClipPublisher>,
        logger: Arc<Logger>,
        telemetry: Telemetry,
        download_dir: PathBuf,
    ) -> Self {
        let log: Arc<dyn ClipLog> = Arc::new(LoggerClipLog::new(Arc::clone(&logger)));
        Self::with_adapters(
            ClipQueueAdapters {
                store: Some(Arc::new(RedisClipQueueStore::new(connection))),
                requests: Arc::new(RedisClipRequestSource::new(
                    subscriber_client,
                    Arc::clone(&log),
                )),
                sockets: sockets.map(|io| {
                    let sink: Arc<dyn ClipSocketSink> = Arc::new(SocketIoClipSink::new(io));
                    sink
                }),
                publisher,
                downloader: Arc::new(YtDlpClipDownloader::new()),
                telemetry: Arc::new(NativeClipTelemetry::new(telemetry)),
                log,
                timer: Arc::new(TokioClipTimer),
                clock: Arc::new(SystemClipClock),
            },
            ClipQueueConfig::new(download_dir),
        )
    }

    /// `subscribeToChannel`.
    ///
    /// A channel subscribes once. A failed attempt is forgotten so the next
    /// call retries; simultaneous callers await the first attempt.
    pub async fn subscribe_to_channel(
        self: &Arc<Self>,
        channel: &str,
    ) -> Result<(), ClipQueueError> {
        if self.store.is_none() {
            return Err(ClipQueueError::new(
                "subscribeToChannel",
                "ClipQueueHandler not initialized",
            ));
        }
        let (sender, receiver) = tokio::sync::watch::channel(None);
        let action = {
            let mut subscriptions = self
                .subscriptions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match subscriptions.get(channel) {
                Some(SubscriptionState::Ready) => SubscriptionAction::Ready,
                Some(SubscriptionState::Pending(receiver)) => {
                    SubscriptionAction::Wait(receiver.clone())
                }
                None => {
                    subscriptions
                        .insert(channel.to_owned(), SubscriptionState::Pending(receiver));
                    SubscriptionAction::Start
                }
            }
        };
        let mut waiting = match action {
            SubscriptionAction::Ready => return Ok(()),
            SubscriptionAction::Wait(receiver) => receiver,
            SubscriptionAction::Start => {
                let weak = Arc::downgrade(self);
                let callback_channel = channel.to_owned();
                let callback: ClipRequestCallback = Arc::new(move |request: ClipRequestData| {
                    let weak = weak.clone();
                    let channel = callback_channel.clone();
                    let future: ClipRequestFuture = Box::pin(async move {
                        if let Some(handler) = weak.upgrade() {
                            handler.handle_clip_request(&channel, request).await;
                        }
                    });
                    future
                });
                let mut flight = SubscriptionFlight {
                    subscriptions: Arc::clone(&self.subscriptions),
                    channel: channel.to_owned(),
                    sender: sender.clone(),
                    finished: false,
                };
                match self.requests.subscribe(channel, callback).await {
                    Ok(()) => {
                        let mut subscriptions = self
                            .subscriptions
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        subscriptions.insert(channel.to_owned(), SubscriptionState::Ready);
                        drop(subscriptions);
                        flight.finished = true;
                        sender.send_replace(Some(Ok(())));
                        return Ok(());
                    }
                    Err(error) => {
                        let mut subscriptions = self
                            .subscriptions
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        subscriptions.remove(channel);
                        drop(subscriptions);
                        flight.finished = true;
                        sender.send_replace(Some(Err(error.clone())));
                        return Err(error);
                    }
                }
            }
        };
        wait_for_subscription(&mut waiting).await
    }

    async fn handle_clip_request(self: &Arc<Self>, channel: &str, request: ClipRequestData) {
        if self.store.is_none() {
            self.log_error(
                "handleClipRequest",
                Some(channel),
                Some(&request.clip_id),
                "Cache not initialized in handleClipRequest",
            )
            .await;
            return;
        }
        if let Err(error) = self.try_handle_clip_request(channel, &request).await {
            self.log_error(
                "handleClipRequest",
                Some(channel),
                Some(&request.clip_id),
                &error.to_string(),
            )
            .await;
        }
    }

    async fn try_handle_clip_request(
        self: &Arc<Self>,
        channel: &str,
        request: &ClipRequestData,
    ) -> Result<(), ClipQueueError> {
        let store = self.store()?;
        let queue_key = clips_queue_key(channel);
        let processing_key = clip_processing_key(channel);
        // Three independent reads, in source order; no transaction is added.
        let queue_length_before = store.zcard(&queue_key).await?;
        let is_processing = store.exists(&processing_key).await?;
        let rank = store.zrank(&queue_key, &request.clip_id).await?;
        let was_queue_empty = queue_length_before == 0;
        // `!idExists` is true for a missing rank and for rank 0.
        let clip_was_added = !rank.is_some_and(|rank| rank > 0);
        if clip_was_added {
            let score = request.score()?;
            store.zadd(&queue_key, score, &request.clip_id).await?;
            store
                .set(
                    &clip_queue_data_key(channel, &request.clip_id),
                    &request.queue_json(),
                )
                .await?;
        }
        if !is_processing {
            if was_queue_empty && clip_was_added {
                store.set(&processing_key, "true").await?;
                store.zrem(&queue_key, &request.clip_id).await?;
                self.download_and_send_to_obs(channel, request).await;
            } else {
                self.process_next_clip(channel).await;
            }
        }
        Ok(())
    }

    /// `processNextClip`.
    pub async fn process_next_clip(self: &Arc<Self>, channel: &str) {
        if self.store.is_none() {
            self.log_error(
                "processNextClip",
                Some(channel),
                None,
                "Cache not initialized in processNextClip",
            )
            .await;
            return;
        }
        if let Err(error) = self.try_process_next_clip(channel).await {
            self.log_error("processNextClip", Some(channel), None, &error.to_string())
                .await;
        }
    }

    async fn try_process_next_clip(
        self: &Arc<Self>,
        channel: &str,
    ) -> Result<(), ClipQueueError> {
        let store = self.store()?;
        let queue_key = clips_queue_key(channel);
        let Some((next_id, _score)) = store.zpopmin(&queue_key).await? else {
            return Ok(());
        };
        if next_id.is_empty() {
            return Ok(());
        }
        let Some(raw) = store
            .get(&clip_queue_data_key(channel, &next_id))
            .await?
        else {
            self.log_error(
                "processNextClip",
                Some(channel),
                Some(&next_id),
                &format!("Clip data not found for ID {next_id} in channel {channel}"),
            )
            .await;
            return Ok(());
        };
        let request = parse_json(&raw)
            .map_err(|error| ClipQueueError::new("processNextClip", error))
            .and_then(ClipRequestData::from_json)?;
        store.set(&clip_processing_key(channel), "true").await?;
        self.download_and_send_to_obs(channel, &request).await;
        Ok(())
    }

    async fn download_and_send_to_obs(
        self: &Arc<Self>,
        channel: &str,
        request: &ClipRequestData,
    ) {
        if self.store.is_none() {
            self.log_error(
                "downloadAndSendToOBS",
                Some(channel),
                Some(&request.clip_id),
                "Cache not initialized in downloadAndSendToOBS",
            )
            .await;
            return;
        }
        let now = self.clock.now_ms();
        let wait_ms = match request.timestamp() {
            Some(timestamp) => (now as f64 - timestamp).max(0.0),
            None => f64::NAN,
        };
        self.telemetry.queue_wait(channel, wait_ms, now);
        let timeout_key = clip_timeout_key(channel, &request.clip_id);
        self.active_clip_ids
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(channel.to_owned(), request.clip_id.clone());
        if let Err(error) = self
            .run_download_and_send(channel, request, &timeout_key)
            .await
        {
            self.log_error(
                "downloadAndSendToOBS",
                Some(channel),
                Some(&request.clip_id),
                &error.to_string(),
            )
            .await;
            self.abort_timeout(&timeout_key);
            self.cleanup_clip(channel, &request.clip_id).await;
            self.process_next_clip(channel).await;
        }
    }

    async fn run_download_and_send(
        self: &Arc<Self>,
        channel: &str,
        request: &ClipRequestData,
        timeout_key: &str,
    ) -> Result<(), ClipQueueError> {
        let store = self.store()?;
        let mut timeout_seconds = DEFAULT_TIMEOUT_SECONDS;
        if let Some(setting) = store.get(&clip_timeout_setting_key(channel)).await? {
            if !setting.is_empty() {
                timeout_seconds = js_parse_int(&setting);
            }
        }
        timeout_seconds += TIMEOUT_DOWNLOAD_BUFFER_SECONDS;
        let delay = Duration::from_millis(node_timeout_delay_ms(timeout_seconds));
        self.arm_timeout(channel, &request.clip_id, timeout_key, timeout_seconds, delay);
        let file_path = clip_file_path(&self.config.download_dir, channel);
        if let Err(error) = self.downloader.delete_old_clip(&file_path).await {
            self.log_error(
                "deleteOldClip",
                Some(channel),
                Some(&request.clip_id),
                &error,
            )
            .await;
        }
        let url = match request.fields.get("clipUrl") {
            Some(JsonValue::String(value)) => value.to_utf8_lossy(),
            _ => String::new(),
        };
        let download = self.downloader.download_clip(&url, &file_path);
        let outcome = self.telemetry.trace_download(channel, download).await;
        if let ClipDownloadOutcome::Failure { message } = outcome {
            self.log_error(
                "downloadAndSendToOBS",
                Some(channel),
                Some(&request.clip_id),
                &format!(
                    "Download failed for channel {channel}, clipID: {}: {message}",
                    request.clip_id
                ),
            )
            .await;
            self.abort_timeout(timeout_key);
            self.cleanup_clip(channel, &request.clip_id).await;
            self.process_next_clip(channel).await;
            return Ok(());
        }
        let Some(sockets) = &self.sockets else {
            self.log_error(
                "downloadAndSendToOBS",
                Some(channel),
                Some(&request.clip_id),
                "Socket.IO not initialized",
            )
            .await;
            self.cleanup_clip(channel, &request.clip_id).await;
            self.process_next_clip(channel).await;
            return Ok(());
        };
        self.publisher
            .publish(
                channel,
                &StudioClipPublication {
                    media: studio_media(request),
                    file: file_path.to_string_lossy().into_owned(),
                    mime: "video/mp4".to_owned(),
                },
            )
            .await;
        let payload = clip_payload(request);
        let count = sockets.emit_play_clip(channel, &payload).await?;
        if count == 0 {
            self.handle_clip_ended(channel, Some(&request.clip_id)).await;
        }
        Ok(())
    }

    fn arm_timeout(
        self: &Arc<Self>,
        channel: &str,
        clip_id: &str,
        timeout_key: &str,
        timeout_seconds: f64,
        delay: Duration,
    ) {
        let handler = Arc::clone(self);
        let runtime = tokio::runtime::Handle::current();
        let channel = channel.to_owned();
        let clip_id = clip_id.to_owned();
        let key = timeout_key.to_owned();
        let callback: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            let handler = Arc::clone(&handler);
            let runtime = runtime.clone();
            let channel = channel.clone();
            let clip_id = clip_id.clone();
            let key = key.clone();
            runtime.spawn(async move {
                // The timer already fired; remove its handle instead of
                // aborting the task that is running this callback.
                handler.take_timeout(&key);
                handler
                    .on_clip_timeout(&channel, &clip_id, timeout_seconds)
                    .await;
            });
        });
        let handle = self.timer.schedule(delay, callback);
        self.timeouts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(timeout_key.to_owned(), handle);
    }

    fn take_timeout(&self, key: &str) -> Option<ClipTimerHandle> {
        self.timeouts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(key)
    }

    fn abort_timeout(&self, key: &str) {
        if let Some(handle) = self.take_timeout(key) {
            handle.abort();
        }
    }

    /// The fired safety timeout: log, clean up, advance the queue.
    pub async fn on_clip_timeout(
        self: &Arc<Self>,
        channel: &str,
        clip_id: &str,
        timeout_seconds: f64,
    ) {
        self.log_error(
            "downloadAndSendToOBS",
            Some(channel),
            Some(clip_id),
            &format!("Clip timeout for {channel}, clipID: {clip_id} after {timeout_seconds} seconds"),
        )
        .await;
        self.cleanup_clip(channel, clip_id).await;
        self.process_next_clip(channel).await;
    }

    async fn cleanup_clip(&self, channel: &str, clip_id: &str) {
        if self.store.is_none() {
            return;
        }
        if let Err(error) = self.try_cleanup_clip(channel, clip_id).await {
            self.log_error(
                "cleanupClip",
                Some(channel),
                Some(clip_id),
                &error.to_string(),
            )
            .await;
        }
    }

    async fn try_cleanup_clip(&self, channel: &str, clip_id: &str) -> Result<(), ClipQueueError> {
        let store = self.store()?;
        {
            let mut active = self
                .active_clip_ids
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if active.get(channel).is_some_and(|value| value == clip_id) {
                active.remove(channel);
            }
        }
        store.del(&clip_processing_key(channel)).await?;
        store
            .del(&clip_queue_data_key(channel, clip_id))
            .await?;
        self.abort_timeout(&clip_timeout_key(channel, clip_id));
        Ok(())
    }

    /// `handleClipEnded`. An absent or mismatched clip ID is ignored.
    pub async fn handle_clip_ended(self: &Arc<Self>, channel: &str, clip_id: Option<&str>) {
        if self.store.is_none() {
            self.log_error(
                "handleClipEnded",
                Some(channel),
                clip_id,
                "Cache not initialized in handleClipEnded",
            )
            .await;
            return;
        }
        let Some(clip_id) = clip_id.filter(|clip_id| !clip_id.is_empty()) else {
            return;
        };
        let matches = self
            .active_clip_ids
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(channel)
            .is_some_and(|value| value == clip_id);
        if !matches {
            return;
        }
        self.active_clip_ids
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(channel);
        self.cleanup_clip(channel, clip_id).await;
        self.process_next_clip(channel).await;
    }

    /// `cleanupOldQueueData`.
    pub async fn cleanup_old_queue_data(&self, channel: &str) {
        if self.store.is_none() {
            return;
        }
        if let Err(error) = self.try_cleanup_old_queue_data(channel).await {
            self.log_error(
                "cleanupOldQueueData",
                Some(channel),
                None,
                &error.to_string(),
            )
            .await;
        }
    }

    async fn try_cleanup_old_queue_data(&self, channel: &str) -> Result<(), ClipQueueError> {
        let store = self.store()?;
        let pattern = format!("twitch:{channel}:clips:queue:data:*");
        for key in store.keys(&pattern).await? {
            let ttl = store.ttl(&key).await?;
            if ttl == -1 || ttl > CLEANUP_TTL_SECONDS {
                store.del(&key).await?;
                self.log_info("cleanupOldQueueData", None, &format!("Deleted old queue data key: {key}"))
                    .await;
            }
        }
        Ok(())
    }

    /// `startupCleanup`.
    ///
    /// The source deletes the literal wildcard key `twitch:*:clip:processing`
    /// and then scans `twitch:*:clips:queue:data:*`; both quirks are preserved.
    pub async fn startup_cleanup(&self) {
        if self.store.is_none() {
            self.log_error(
                "startupCleanup",
                None,
                None,
                "Cache not initialized in startupCleanup",
            )
            .await;
            return;
        }
        self.log_info("startupCleanup", None, "Running startup cleanup for clip queue...")
            .await;
        match self.store() {
            Ok(store) => match store.del("twitch:*:clip:processing").await {
                Ok(()) => {
                    self.cleanup_old_queue_data("*").await;
                    self.log_info("startupCleanup", None, "Startup cleanup completed")
                        .await;
                }
                Err(error) => {
                    self.log_error("startupCleanup", None, None, &error.to_string())
                        .await;
                }
            },
            Err(error) => {
                self.log_error("startupCleanup", None, None, &error.to_string())
                    .await;
            }
        }
    }

    fn store(&self) -> Result<&Arc<dyn ClipQueueStore>, ClipQueueError> {
        self.store.as_ref().ok_or_else(|| {
            ClipQueueError::new("ClipQueueHandler", "ClipQueueHandler not initialized")
        })
    }

    async fn log_error(
        &self,
        function: &str,
        channel: Option<&str>,
        clip_id: Option<&str>,
        message: &str,
    ) {
        self.log
            .log(
                Level::Error,
                log_payload(function, channel, clip_id, message, Some(self.clock.now_ms())),
                channel,
            )
            .await;
    }

    async fn log_info(&self, function: &str, channel: Option<&str>, message: &str) {
        self.log
            .log(
                Level::Info,
                log_payload(function, channel, None, message, Some(self.clock.now_ms())),
                channel,
            )
            .await;
    }
}

async fn wait_for_subscription(
    receiver: &mut tokio::sync::watch::Receiver<Option<Result<(), ClipQueueError>>>,
) -> Result<(), ClipQueueError> {
    loop {
        let current = receiver.borrow().clone();
        if let Some(result) = current {
            return result;
        }
        if receiver.changed().await.is_err() {
            return Err(ClipQueueError::new(
                "subscribeToChannel",
                "clip request subscription ended without a result",
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> JsonValue {
        parse_json(text).expect("valid test JSON")
    }

    #[test]
    fn parse_int_matches_javascript_prefix_and_radix_rules() {
        assert_eq!(js_parse_int("30"), 30.0);
        assert_eq!(js_parse_int(" 30"), 30.0);
        assert_eq!(js_parse_int("+30"), 30.0);
        assert_eq!(js_parse_int("-5"), -5.0);
        assert_eq!(js_parse_int("30abc"), 30.0);
        assert_eq!(js_parse_int("1e3"), 1.0);
        assert_eq!(js_parse_int("0x10"), 16.0);
        assert_eq!(js_parse_int("0X1f"), 31.0);
        assert_eq!(js_parse_int("00012"), 12.0);
        assert!(js_parse_int("abc").is_nan());
        assert!(js_parse_int("").is_nan());
        assert!(js_parse_int("0x").is_nan());
        assert!(js_parse_int("+").is_nan());
    }

    #[test]
    fn timeout_delay_matches_node_clamping() {
        assert_eq!(node_timeout_delay_ms(125.0), 125_000);
        assert_eq!(node_timeout_delay_ms(95.0), 95_000);
        assert_eq!(node_timeout_delay_ms(0.5), 500);
        // NaN, below one millisecond and above TIMEOUT_MAX all become 1 ms.
        assert_eq!(node_timeout_delay_ms(f64::NAN), 1);
        assert_eq!(node_timeout_delay_ms(-10.0), 1);
        assert_eq!(node_timeout_delay_ms(3_000_000.0), 1);
    }

    #[test]
    fn number_conversion_covers_source_forms() {
        assert_eq!(js_string_to_number(""), 0.0);
        assert_eq!(js_string_to_number(" 12 "), 12.0);
        assert_eq!(js_string_to_number("0x10"), 16.0);
        assert_eq!(js_string_to_number("0b10"), 2.0);
        assert_eq!(js_string_to_number("0o10"), 8.0);
        assert_eq!(js_string_to_number("+1.5e2"), 150.0);
        assert_eq!(js_string_to_number("Infinity"), f64::INFINITY);
        assert_eq!(js_string_to_number("-Infinity"), f64::NEG_INFINITY);
        assert!(js_string_to_number("nope").is_nan());
        assert!(js_string_to_number("-0x10").is_nan());
        assert!(js_string_to_number("1e").is_nan());
        assert!(js_string_to_number("inf").is_nan());
        assert_eq!(js_number(None), 0.0);
        assert_eq!(js_number(Some(&JsonValue::Bool(true))), 1.0);
        assert_eq!(js_number(Some(&json("\"12\""))), 12.0);
        assert!(js_number(Some(&json("{}"))).is_nan());
    }

    #[test]
    fn studio_duration_uses_number_or_thirty_then_caps() {
        assert_eq!(studio_duration(None), 30.0);
        assert_eq!(studio_duration(Some(&json("0"))), 30.0);
        assert_eq!(studio_duration(Some(&json("42"))), 30.0);
        assert_eq!(studio_duration(Some(&json("12.5"))), 12.5);
        assert_eq!(studio_duration(Some(&json("-5"))), -5.0);
        assert_eq!(studio_duration(Some(&json("\"12\""))), 12.0);
        assert_eq!(studio_duration(Some(&json("\"abc\""))), 30.0);
    }

    #[test]
    fn media_object_matches_source_fallbacks_and_omissions() {
        let request = ClipRequestData::from_json(json(
            r#"{"clipID":"C1","streamerLogin":"login","title":"","game":"Chess"}"#,
        ))
        .expect("valid request");
        let media = studio_media(&request);
        let wire = media.to_json_string();
        assert_eq!(
            wire,
            r#"{"type":"video","title":"","volume":1,"duration":30,"clip":{"streamer":"login","game":"Chess","description":""}}"#
        );
        assert_eq!(
            media
                .get("clip")
                .and_then(|clip| clip.get("profileImage")),
            None
        );

        let request = ClipRequestData::from_json(json(
            r#"{"clipID":"C1","streamer":"display","streamerLogin":"login","title":"T","duration":42,"profileImage":"p.png","streamerColor":"#fff"}"#,
        ))
        .expect("valid request");
        assert_eq!(
            studio_media(&request).to_json_string(),
            r#"{"type":"video","title":"T","volume":1,"duration":30,"clip":{"streamer":"display","game":"","description":"","profileImage":"p.png","streamerColor":"#fff"}}"#
        );
    }

    #[test]
    fn play_payload_keeps_present_fields_in_source_order() {
        let request = ClipRequestData::from_json(json(
            r#"{"clipID":"C1","clipUrl":"u","duration":12,"title":"T","game":"G","streamer":"S","streamerLogin":"L","description":null,"timestamp":100,"extra":"ignored"}"#,
        ))
        .expect("valid request");
        assert_eq!(
            clip_payload(&request).to_json_string(),
            r#"{"clipID":"C1","clipUrl":"u","duration":12,"title":"T","game":"G","streamer":"S","streamerLogin":"L","description":null}"#
        );
    }

    #[test]
    fn queued_payload_round_trips_property_order() {
        let request =
            ClipRequestData::from_json(json(r#"{"timestamp":100,"clipID":"C1","title":"a"}"#))
                .expect("valid request");
        assert_eq!(request.queue_json(), r#"{"timestamp":100,"clipID":"C1","title":"a"}"#);
        let decoded =
            ClipRequestData::from_json(parse_json(&request.queue_json()).expect("valid JSON"))
                .expect("valid request");
        assert_eq!(decoded, request);
    }

    #[test]
    fn timestamp_accepts_numbers_and_numeric_strings_only() {
        let numeric = ClipRequestData::from_json(json(r#"{"clipID":"C","timestamp":123}"#))
            .expect("valid request");
        assert_eq!(numeric.timestamp(), Some(123.0));
        assert_eq!(numeric.score(), Ok(123.0));
        let string = ClipRequestData::from_json(json(r#"{"clipID":"C","timestamp":"456"}"#))
            .expect("valid request");
        assert_eq!(string.timestamp(), Some(456.0));
        for raw in [
            r#"{"clipID":"C"}"#,
            r#"{"clipID":"C","timestamp":null}"#,
            r#"{"clipID":"C","timestamp":"abc"}"#,
            r#"{"clipID":"C","timestamp":true}"#,
        ] {
            let request = ClipRequestData::from_json(json(raw)).expect("valid request");
            assert_eq!(request.timestamp(), None, "{raw}");
            assert!(request.score().is_err(), "{raw}");
        }
    }

    #[test]
    fn request_requires_a_string_clip_id() {
        assert!(ClipRequestData::from_json(json(r#"{"clipID":"C1"}"#)).is_ok());
        assert!(ClipRequestData::from_json(json(r#"{"clipID":5}"#)).is_err());
        assert!(ClipRequestData::from_json(json(r#"{}"#)).is_err());
    }

    #[test]
    fn key_builders_match_source_templates() {
        assert_eq!(clip_request_topic("42"), "twitch:42:clip:request");
        assert_eq!(clips_queue_key("42"), "twitch:42:clips:queue");
        assert_eq!(clip_processing_key("42"), "twitch:42:clip:processing");
        assert_eq!(
            clip_queue_data_key("42", "AB"),
            "twitch:42:clips:queue:data:AB"
        );
        assert_eq!(
            clip_timeout_setting_key("42"),
            "twitch:42:clips:timeouts:default"
        );
        assert_eq!(clip_timeout_key("42", "AB"), "42:AB");
    }

    #[test]
    fn zpopmin_reply_decoding_handles_empty_and_invalid_shapes() {
        use redis::Value;
        assert_eq!(decode_zpop(Value::Nil), Ok(None));
        assert_eq!(decode_zpop(Value::Array(vec![])), Ok(None));
        assert_eq!(
            decode_zpop(Value::Array(vec![
                Value::BulkString(b"ABC".to_vec()),
                Value::BulkString(b"123.5".to_vec()),
            ])),
            Ok(Some(("ABC".to_owned(), 123.5)))
        );
        assert_eq!(
            decode_zpop(Value::Array(vec![Value::BulkString(b"ABC".to_vec())])),
            Err("ZPOPMIN returned an unexpected array shape".to_owned())
        );
        assert_eq!(
            decode_zpop(Value::Map(vec![(
                Value::BulkString(b"ABC".to_vec()),
                Value::Double(1.5),
            )])),
            Ok(Some(("ABC".to_owned(), 1.5)))
        );
    }

    #[test]
    fn json_to_serde_preserves_nested_values() {
        let value = json(r#"{"a":[1,true,null,"x"],"b":{"c":2}}"#);
        assert_eq!(
            json_to_serde(&value),
            serde_json::json!({"a":[1.0,true,null,"x"],"b":{"c":2.0}})
        );
    }
}

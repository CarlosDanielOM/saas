//! Overlay Studio validation and persistence from `store.ts`.
//! Untrusted drafts are rebuilt field by field so unrecognized client data is
//! never stored, and writes use the source's revision compare-and-set. The
//! Mongo adapter is concrete; the persistence seam exists only to exercise the
//! same compare-and-set and starter-creation paths without a database.

use std::{
    collections::HashSet,
    fmt,
    future::Future,
    pin::Pin,
    sync::{Arc, OnceLock},
};
use mongodb::{
    bson::{doc, Bson, Document},
    Collection, Database,
};
use crate::{
    schemas::{Field, FieldType, SchemaDefinition, SchemaIndex},
    utils::{
        bson_compat::js_number,
        bson_json::json_bson,
        js_compat,
        js_string::JsString,
        json_number::number_string,
        lossless_json::{truthy, JsonValue},
    },
};
use super::{
    ast::parse_template,
    keyframes::valid_keyframes,
    model::{make_design, make_scene, ALERT_EVENTS, ALERT_LOOPS, ALERT_TRANSITIONS, CLIP_DESIGN_VARIANTS, EVENT_KINDS},
    widget_contract::{parse_widget_module_config, WidgetPlacement},
};

/// Mongo collection used by Overlay Studio.
pub const STUDIO_COLLECTION: &str = "overlay_studios";
/// Largest scene list accepted by a draft.
pub const MAX_SCENES: usize = 25;
/// Largest design list accepted by a draft.
pub const MAX_DESIGNS: usize = 50;
/// Largest widget list accepted in one scene or alert layout.
pub const MAX_WIDGETS: usize = 60;
/// Largest serialized draft accepted by the source's 4 MiB storage guard.
pub const MAX_STATE_BYTES: usize = 4 * 1024 * 1024;

/// Schema metadata for the original collection and its unique multikey index.
pub fn schema() -> &'static SchemaDefinition {
    static SCHEMA: OnceLock<SchemaDefinition> = OnceLock::new();
    SCHEMA.get_or_init(|| SchemaDefinition {
        model: "OverlayStudio",
        collection: STUDIO_COLLECTION,
        string_id: true,
        version_key: false,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        indexes: vec![SchemaIndex::new(doc! { "scenes.publicId": 1 }).unique()],
        fields: vec![
            Field::new("_id", FieldType::String),
            Field::new("schemaVersion", FieldType::Number),
            Field::new("revision", FieldType::Number),
            Field::new("scenes", FieldType::Array(Box::new(FieldType::Mixed))),
            Field::new("designs", FieldType::Array(Box::new(FieldType::Mixed))),
            Field::new("controls", FieldType::Mixed),
        ],
    })
}

/// Install the source's unique scene public-ID index explicitly.
pub async fn install_indexes(database: &Database) -> mongodb::error::Result<()> {
    schema().install_indexes(database).await
}

/// Source-compatible public error with HTTP status.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OverlayError {
    /// Public error message.
    pub message: String,
    /// HTTP status.
    pub status: u16,
}

impl fmt::Display for OverlayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for OverlayError {}

fn error(message: &str, status: u16) -> OverlayError {
    OverlayError { message: message.into(), status }
}
fn invalid_text() -> OverlayError {
    error("Invalid text", 400)
}
fn stale() -> OverlayError {
    error("The draft changed. Reload before saving.", 409)
}

/// The source's persisted draft view.
#[derive(Clone, Debug, PartialEq)]
pub struct StudioState {
    /// Wire schema version. Reads always report the source's version 1.
    pub schema_version: u8,
    /// Optimistic concurrency revision.
    pub revision: f64,
    /// Validated scenes.
    pub scenes: Vec<JsonValue>,
    /// Validated alert designs.
    pub designs: Vec<JsonValue>,
}

impl StudioState {
    /// The empty draft used as prior state for recovery validation.
    pub fn empty() -> Self {
        Self { schema_version: 1, revision: 0.0, scenes: Vec::new(), designs: Vec::new() }
    }
}

/// Boxed future used by the injected persistence adapter.
pub type StudioFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The application-specific persistence operations used by `load`, `change`,
/// and `public_state`. The production implementation is
/// [`MongoStudioPersistence`]; tests can supply a disposable in-memory adapter.
pub trait StudioPersistence: Send + Sync {
    /// Require an existing Twitch account for the channel.
    fn require_account<'a>(&'a self, channel: &'a str) -> StudioFuture<'a, Result<(), OverlayError>>;
    /// Find a stored draft.
    fn find_studio<'a>(&'a self, channel: &'a str) -> StudioFuture<'a, Result<Option<Document>, OverlayError>>;
    /// Insert a starter draft. A duplicate `_id` is not an error.
    fn insert_studio<'a>(&'a self, document: Document) -> StudioFuture<'a, Result<(), OverlayError>>;
    /// Compare the stored revision and replace both draft arrays in one write.
    fn compare_and_set<'a>(
        &'a self,
        channel: &'a str,
        revision: f64,
        scenes: Vec<Bson>,
        designs: Vec<Bson>,
    ) -> StudioFuture<'a, Result<bool, OverlayError>>;
    /// Find the draft owning a scene public ID.
    fn find_public<'a>(&'a self, public_id: &'a str) -> StudioFuture<'a, Result<Option<Document>, OverlayError>>;
}

/// Concrete Mongo persistence for `overlay_studios` and its owning `users`.
#[derive(Clone)]
pub struct MongoStudioPersistence {
    database: Database,
}

impl MongoStudioPersistence {
    /// Construct from an existing database without I/O.
    pub fn new(database: Database) -> Self {
        Self { database }
    }
    fn studios(&self) -> Collection<Document> {
        self.database.collection(STUDIO_COLLECTION)
    }
    fn users(&self) -> Collection<Document> {
        crate::schemas::users::schema().native_collection(&self.database)
    }
}

impl StudioPersistence for MongoStudioPersistence {
    fn require_account<'a>(&'a self, channel: &'a str) -> StudioFuture<'a, Result<(), OverlayError>> {
        Box::pin(async move {
            let exists = self
                .users()
                .find_one(doc! { "accounts": { "$elemMatch": { "type": "twitch", "id": channel } } })
                .await
                .map_err(|_| error("Unable to load overlay", 500))?;
            if exists.is_none() {
                return Err(error("Overlay account unavailable", 403));
            }
            Ok(())
        })
    }

    fn find_studio<'a>(&'a self, channel: &'a str) -> StudioFuture<'a, Result<Option<Document>, OverlayError>> {
        Box::pin(async move {
            self.studios()
                .find_one(doc! { "_id": channel })
                .await
                .map_err(|_| error("Unable to load overlay", 500))
        })
    }

    fn insert_studio<'a>(&'a self, document: Document) -> StudioFuture<'a, Result<(), OverlayError>> {
        Box::pin(async move {
            match self.studios().insert_one(document).await {
                Ok(_) => Ok(()),
                Err(value) => {
                    if matches!(
                        value.kind.as_ref(),
                        mongodb::error::ErrorKind::Write(mongodb::error::WriteFailure::WriteError(write))
                            if write.code == 11000
                    ) {
                        Ok(())
                    } else {
                        Err(error("Unable to create overlay", 500))
                    }
                }
            }
        })
    }

    fn compare_and_set<'a>(
        &'a self,
        channel: &'a str,
        revision: f64,
        scenes: Vec<Bson>,
        designs: Vec<Bson>,
    ) -> StudioFuture<'a, Result<bool, OverlayError>> {
        Box::pin(async move {
            let result = self
                .studios()
                .update_one(
                    doc! { "_id": channel, "revision": js_number(revision) },
                    doc! {
                        "$set": { "scenes": Bson::Array(scenes), "designs": Bson::Array(designs) },
                        "$inc": { "revision": 1_i32 }
                    },
                )
                .await
                .map_err(|_| error("Unable to save overlay", 500))?;
            Ok(result.modified_count > 0)
        })
    }

    fn find_public<'a>(&'a self, public_id: &'a str) -> StudioFuture<'a, Result<Option<Document>, OverlayError>> {
        Box::pin(async move {
            self.studios()
                .find_one(doc! { "scenes.publicId": public_id })
                .await
                .map_err(|_| error("Unable to load overlay", 500))
        })
    }
}

/// Reject a stale or nonintegral draft revision before attempting mutation.
pub fn check_revision(requested: f64, current: f64) -> Result<(), OverlayError> {
    if !requested.is_finite() || requested.fract() != 0.0 || requested != current {
        return Err(stale());
    }
    Ok(())
}

/// Validate the 24-byte lowercase hex public token.
pub fn valid_public_id(id: &str) -> bool {
    id.len() == 48 && id.bytes().all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
}

/// Generate the source's 24 random bytes as lowercase hex.
pub fn token() -> Result<String, OverlayError> {
    let mut bytes = [0_u8; 24];
    getrandom::fill(&mut bytes).map_err(|_| error("Unable to create overlay", 500))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

// ---------------------------------------------------------------------------
// JavaScript-compatible scalar helpers.

/// Require a JSON object and return its properties in source order.
pub fn object(value: &JsonValue) -> Result<&[(JsString, JsonValue)], OverlayError> {
    match value {
        JsonValue::Object(fields) => Ok(fields),
        _ => Err(error("Expected an object", 400)),
    }
}

/// Read the last property with this name, matching `JSON.parse` duplicate-key
/// semantics for objects built by tests.
pub fn field<'a>(fields: &'a [(JsString, JsonValue)], key: &str) -> Option<&'a JsonValue> {
    fields.iter().rev().find(|(name, _)| name.as_str() == Some(key)).map(|(_, value)| value)
}

fn field_or_null<'a>(fields: &'a [(JsString, JsonValue)], key: &str) -> &'a JsonValue {
    static NULL: JsonValue = JsonValue::Null;
    field(fields, key).unwrap_or(&NULL)
}

fn put(fields: &mut Vec<(JsString, JsonValue)>, key: &str, value: JsonValue) {
    fields.push((key.into(), value));
}

fn trim_is_empty(text: &JsString) -> bool {
    text.code_units().all(|unit| char::from_u32(unit as u32).is_some_and(js_compat::is_whitespace))
}

/// Source `string(value, max)`; the length is measured in UTF-16 code units.
pub fn string<'a>(value: &'a JsonValue, max: usize) -> Result<&'a JsString, OverlayError> {
    match value {
        JsonValue::String(text) if !trim_is_empty(text) && text.len() <= max => Ok(text),
        _ => Err(invalid_text()),
    }
}

/// Source `string` when the caller requires plain UTF-8 (IDs and regexes).
pub fn string_text<'a>(value: &'a JsonValue, max: usize) -> Result<&'a str, OverlayError> {
    string(value, max)?.as_str().ok_or_else(invalid_text)
}

/// JavaScript `String(value)` for the JSON data model.
pub fn js_string_value(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => "null".into(),
        JsonValue::Bool(value) => if *value { "true".into() } else { "false".into() },
        JsonValue::Number(value) => number_string(*value),
        JsonValue::String(value) => value.to_utf8_lossy(),
        JsonValue::Array(items) => items
            .iter()
            .map(|item| match item {
                JsonValue::Null => String::new(),
                other => js_string_value(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        JsonValue::Object(_) => "[object Object]".into(),
    }
}

fn is_lower_hex_24(text: &str) -> bool {
    text.len() == 24 && text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_hex_color(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit)
}

fn valid_rule_id(value: Option<&JsonValue>) -> bool {
    matches!(value, Some(JsonValue::String(text))
        if text.as_str().is_some_and(|text| {
            !text.is_empty()
                && text.len() <= 64
                && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        }))
}

/// Reject credentials and non-HTTPS media. The source constructs `new URL`
/// after this check; malformed authorities that Node would throw on are
/// reported as the same validation error instead of a server failure.
fn valid_media_url(text: &str) -> bool {
    let Some(rest) = text.get(..8).filter(|prefix| prefix.eq_ignore_ascii_case("https://")).map(|_| &text[8..]) else {
        return false;
    };
    let end = rest.find(|character| matches!(character, '/' | '?' | '#')).unwrap_or(rest.len());
    let authority = &rest[..end];
    let host = authority.rsplit('@').next().unwrap_or("");
    if host.is_empty() {
        return false;
    }
    if let Some(at) = authority.rfind('@') {
        let userinfo = &authority[..at];
        let (user, password) = userinfo.split_once(':').unwrap_or((userinfo, ""));
        if !user.is_empty() || !password.is_empty() {
            return false;
        }
    }
    true
}

/// Source `number(value, min, max)`.
pub fn number(value: &JsonValue, min: f64, max: f64) -> Result<f64, OverlayError> {
    match value {
        JsonValue::Number(value) if value.is_finite() && *value >= min && *value <= max => Ok(*value),
        _ => Err(error("Invalid dimension or duration", 400)),
    }
}

fn boolean(value: &JsonValue) -> Result<bool, OverlayError> {
    match value {
        JsonValue::Bool(value) => Ok(*value),
        _ => Err(error("Expected a boolean", 400)),
    }
}

fn list<'a>(value: &'a JsonValue, max: usize) -> Result<&'a [JsonValue], OverlayError> {
    match value {
        JsonValue::Array(items) if items.len() <= max => Ok(items),
        _ => Err(error("Too many or invalid items", 400)),
    }
}

fn ensure_unique_ids<'a>(ids: impl IntoIterator<Item = &'a str>) -> Result<(), OverlayError> {
    let mut seen = HashSet::new();
    for id in ids {
        if !seen.insert(id.to_owned()) {
            return Err(error("Duplicate ID", 400));
        }
    }
    Ok(())
}

fn string_id(value: &JsonValue) -> Result<String, OverlayError> {
    let text = string(value, 100)?;
    match text.as_str() {
        Some(text) if text.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-') => Ok(text.to_owned()),
        _ => Err(error("Invalid ID", 400)),
    }
}

fn canvas(fields: &[(JsString, JsonValue)]) -> Result<(f64, f64), OverlayError> {
    Ok((number(field_or_null(fields, "width"), 100.0, 7680.0)?, number(field_or_null(fields, "height"), 100.0, 7680.0)?))
}

fn color(value: &JsonValue) -> Result<JsString, OverlayError> {
    match value {
        JsonValue::String(text) if is_hex_color(text.as_str().unwrap_or("")) => Ok(text.clone()),
        _ => Err(error("Invalid color", 400)),
    }
}

// ---------------------------------------------------------------------------
// Widget and layout validation.

fn rebuild_keyframes(value: &JsonValue) -> Result<JsonValue, OverlayError> {
    let frames = error("Invalid object keyframes", 400);
    let JsonValue::Object(phases) = value else { return Err(frames) };
    let mut rebuilt = Vec::with_capacity(phases.len());
    for (phase, sequence) in phases {
        let sequence = object(sequence).map_err(|_| error("Invalid object keyframes", 400))?;
        let tracks = list(field_or_null(sequence, "tracks"), 5).map_err(|_| error("Invalid object keyframes", 400))?;
        let mut rebuilt_tracks = Vec::with_capacity(tracks.len());
        for track in tracks {
            let track = object(track).map_err(|_| error("Invalid object keyframes", 400))?;
            let property = field(track, "property").ok_or_else(|| error("Invalid object keyframes", 400))?.clone();
            let points = list(field_or_null(track, "points"), 24).map_err(|_| error("Invalid object keyframes", 400))?;
            let mut rebuilt_points = Vec::with_capacity(points.len());
            for point in points {
                let point = object(point).map_err(|_| error("Invalid object keyframes", 400))?;
                rebuilt_points.push(JsonValue::Object(vec![
                    ("offset".into(), field_or_null(point, "offset").clone()),
                    ("value".into(), field_or_null(point, "value").clone()),
                    ("easing".into(), field_or_null(point, "easing").clone()),
                ]));
            }
            rebuilt_tracks.push(JsonValue::Object(vec![
                ("property".into(), property),
                ("points".into(), JsonValue::Array(rebuilt_points)),
            ]));
        }
        rebuilt.push((phase.clone(), JsonValue::Object(vec![("tracks".into(), JsonValue::Array(rebuilt_tracks))])));
    }
    Ok(JsonValue::Object(rebuilt))
}

fn alert_motion(value: &JsonValue, nested: bool) -> Result<JsonValue, OverlayError> {
    if !nested {
        return Err(error("Object animations require an alert design", 400));
    }
    let motion = object(value)?;
    let transition = |name: &str| -> Result<JsString, OverlayError> {
        match field(motion, name) {
            Some(JsonValue::String(text)) if text.as_str().is_some_and(|text| ALERT_TRANSITIONS.contains(&text)) => {
                Ok(text.clone())
            }
            _ => Err(error("Invalid object animation", 400)),
        }
    };
    let enter = transition("enter")?;
    let exit = transition("exit")?;
    let never = field_or_null(motion, "loop");
    let loop_name = match never {
        JsonValue::String(text) if text.as_str().is_some_and(|text| ALERT_LOOPS.contains(&text)) => text.clone(),
        _ => return Err(error("Invalid object animation", 400)),
    };
    Ok(JsonValue::Object(vec![
        ("enter".into(), JsonValue::String(enter)),
        ("exit".into(), JsonValue::String(exit)),
        ("loop".into(), JsonValue::String(loop_name)),
        ("delay".into(), JsonValue::Number(number(field_or_null(motion, "delay"), 0.0, 120.0)?)),
        ("enterDuration".into(), JsonValue::Number(number(field_or_null(motion, "enterDuration"), 0.1, 5.0)?)),
        ("exitDuration".into(), JsonValue::Number(number(field_or_null(motion, "exitDuration"), 0.1, 5.0)?)),
        ("loopDuration".into(), JsonValue::Number(number(field_or_null(motion, "loopDuration"), 0.2, 10.0)?)),
    ]))
}

fn trigger_selection(value: &JsonValue) -> Result<JsonValue, OverlayError> {
    let items = list(value, 1000)?;
    let mut ids = Vec::with_capacity(items.len());
    let mut seen = HashSet::new();
    for item in items {
        let text = match item {
            JsonValue::String(text) if text.as_str().is_some_and(is_lower_hex_24) => text.clone(),
            _ => return Err(error("Invalid trigger selection", 400)),
        };
        let key = text.to_utf8_lossy();
        if !seen.insert(key) {
            return Err(error("Duplicate trigger selection", 400));
        }
        ids.push(JsonValue::String(text));
    }
    Ok(JsonValue::Array(ids))
}

fn trigger_placement(value: &JsonValue, nested: bool, kind: &str) -> Result<JsonValue, OverlayError> {
    if nested || kind != "trigger" {
        return Err(error("Trigger placement requires a trigger widget", 400));
    }
    let placement = object(value)?;
    let mode = match field_or_null(placement, "mode") {
        JsonValue::String(text) if text.as_str() == Some("fixed") || text.as_str() == Some("random") => text.clone(),
        _ => return Err(error("Invalid trigger placement", 400)),
    };
    Ok(JsonValue::Object(vec![
        ("mode".into(), JsonValue::String(mode)),
        ("margin".into(), JsonValue::Number(number(field_or_null(placement, "margin"), 0.0, 500.0)?)),
    ]))
}

fn shadow(value: &JsonValue) -> Result<JsonValue, OverlayError> {
    let shadow = object(value)?;
    Ok(JsonValue::Object(vec![
        ("color".into(), JsonValue::String(color(field_or_null(shadow, "color"))?)),
        ("blur".into(), JsonValue::Number(number(field_or_null(shadow, "blur"), 0.0, 100.0)?)),
        ("x".into(), JsonValue::Number(number(field_or_null(shadow, "x"), -100.0, 100.0)?)),
        ("y".into(), JsonValue::Number(number(field_or_null(shadow, "y"), -100.0, 100.0)?)),
    ]))
}

fn widgets(value: &JsonValue, nested: bool) -> Result<Vec<JsonValue>, OverlayError> {
    let raw_widgets = list(value, MAX_WIDGETS)?;
    let mut built = Vec::with_capacity(raw_widgets.len());
    for raw in raw_widgets {
        let widget = object(raw)?;
        let kind = string(field_or_null(widget, "kind"), 100)?.to_utf8_lossy();
        let module_config = parse_widget_module_config(
            widget,
            if nested { WidgetPlacement::Design } else { WidgetPlacement::Scene },
        )
        .ok_or_else(|| error("Invalid widget module configuration", 400))?;

        let mut item = Vec::new();
        put(&mut item, "id", JsonValue::String(JsString::from(string_id(field_or_null(widget, "id"))?)));
        put(&mut item, "kind", JsonValue::String(JsString::from(kind.clone())));
        put(&mut item, "x", JsonValue::Number(number(field_or_null(widget, "x"), -16_000.0, 16_000.0)?));
        put(&mut item, "y", JsonValue::Number(number(field_or_null(widget, "y"), -16_000.0, 16_000.0)?));
        put(&mut item, "width", JsonValue::Number(number(field_or_null(widget, "width"), 20.0, 16_000.0)?));
        put(&mut item, "height", JsonValue::Number(number(field_or_null(widget, "height"), 20.0, 16_000.0)?));
        put(&mut item, "visible", JsonValue::Bool(boolean(field_or_null(widget, "visible"))?));
        put(&mut item, "locked", JsonValue::Bool(boolean(field_or_null(widget, "locked"))?));
        if let Some(version) = module_config.config_version {
            put(&mut item, "configVersion", JsonValue::Number(f64::from(version)));
        }
        if let Some(config) = module_config.config {
            put(&mut item, "config", JsonValue::Object(config));
        }
        for (name, value) in module_config.legacy {
            put(&mut item, name.as_str().unwrap_or_default(), value);
        }

        match field(widget, "keyframes") {
            None => {}
            Some(value) => {
                if !nested || !valid_keyframes(value) {
                    return Err(error("Invalid object keyframes", 400));
                }
                put(&mut item, "keyframes", rebuild_keyframes(value)?);
            }
        }
        if let Some(value) = field(widget, "motion") {
            put(&mut item, "motion", alert_motion(value, nested)?);
        }
        if let Some(value) = field(widget, "name") {
            let name = match value {
                JsonValue::String(text) if text.len() <= 80 => text.clone(),
                _ => string(value, 80)?.clone(),
            };
            put(&mut item, "name", JsonValue::String(name));
        }
        if let Some(value) = field(widget, "showTtsText") {
            if kind != "tts" {
                return Err(error("Spoken text settings require a TTS widget", 400));
            }
            put(&mut item, "showTtsText", JsonValue::Bool(boolean(value)?));
        }
        if let Some(value) = field(widget, "clipDesign") {
            let valid = matches!(value, JsonValue::String(text)
                if text.as_str().is_some_and(|text| CLIP_DESIGN_VARIANTS.contains(&text)));
            if kind != "clip" || !valid {
                return Err(error("Invalid clip design", 400));
            }
            put(&mut item, "clipDesign", value.clone());
        }
        if let Some(value) = field(widget, "triggerIds") {
            if kind != "trigger" {
                return Err(error("Trigger filters require a trigger widget", 400));
            }
            put(&mut item, "triggerIds", trigger_selection(value)?);
        }
        if let Some(value) = field(widget, "triggerPlacement") {
            put(&mut item, "triggerPlacement", trigger_placement(value, nested, &kind)?);
        }
        if kind == "alert" {
            put(&mut item, "designId", JsonValue::String(JsString::from(string_id(field_or_null(widget, "designId"))?)));
            let events = list(field_or_null(widget, "events"), 4)?;
            let mut accepted = Vec::with_capacity(events.len());
            for event in events {
                match event {
                    JsonValue::String(text) if text.as_str().is_some_and(|text| ALERT_EVENTS.contains(&text)) => {
                        accepted.push(event.clone());
                    }
                    _ => return Err(error("Invalid event", 400)),
                }
            }
            put(&mut item, "events", JsonValue::Array(accepted));
        }
        if kind == "text" {
            let text = match field(widget, "text") {
                Some(JsonValue::String(text)) => text.clone(),
                _ => JsString::from(""),
            };
            if nested {
                parse_template(&text.to_utf8_lossy()).map_err(|failure| OverlayError {
                    message: failure.message,
                    status: 400,
                })?;
            }
            put(&mut item, "text", JsonValue::String(text));
        }
        let asset_id = field(widget, "assetId");
        if asset_id.is_some_and(truthy) {
            let value = asset_id.expect("checked present");
            let text = js_string_value(value);
            if !matches!(kind.as_str(), "image" | "video") || !is_lower_hex_24(&text) {
                return Err(error("Invalid design asset", 400));
            }
            put(&mut item, "assetId", JsonValue::String(JsString::from(string_id(value)?)));
        } else if field(widget, "mediaUrl").is_some_and(truthy) {
            let value = field(widget, "mediaUrl").expect("checked present");
            let text = string(value, 2048)?;
            if !valid_media_url(&text.to_utf8_lossy()) {
                return Err(error("Media requires an HTTPS URL", 400));
            }
            put(&mut item, "mediaUrl", JsonValue::String(text.clone()));
        }
        if field(widget, "color").is_some_and(truthy) {
            let text = js_string_value(field(widget, "color").expect("checked present"));
            if !is_hex_color(&text) {
                return Err(error("Invalid color", 400));
            }
            put(&mut item, "color", JsonValue::String(JsString::from(text)));
        }
        if let Some(value) = field(widget, "fontSize") {
            put(&mut item, "fontSize", JsonValue::Number(number(value, 8.0, 300.0)?));
        }
        if let Some(value) = field(widget, "fontFamily") {
            let valid = matches!(value, JsonValue::String(text)
                if text.as_str().is_some_and(|text| ["sans", "serif", "mono"].contains(&text)));
            if !valid {
                return Err(error("Invalid object style", 400));
            }
            put(&mut item, "fontFamily", value.clone());
        }
        if let Some(value) = field(widget, "fontWeight") {
            let valid = matches!(value, JsonValue::Number(value) if *value == 400.0 || *value == 700.0);
            if !valid {
                return Err(error("Invalid object style", 400));
            }
            put(&mut item, "fontWeight", value.clone());
        }
        if let Some(value) = field(widget, "textAlign") {
            let valid = matches!(value, JsonValue::String(text)
                if text.as_str().is_some_and(|text| ["left", "center", "right"].contains(&text)));
            if !valid {
                return Err(error("Invalid object style", 400));
            }
            put(&mut item, "textAlign", value.clone());
        }
        if let Some(value) = field(widget, "shape") {
            let valid = matches!(value, JsonValue::String(text)
                if text.as_str().is_some_and(|text| ["rectangle", "ellipse"].contains(&text)));
            if !valid {
                return Err(error("Invalid object style", 400));
            }
            put(&mut item, "shape", value.clone());
        }
        if let Some(value) = field(widget, "italic") {
            put(&mut item, "italic", JsonValue::Bool(boolean(value)?));
        }
        for (name, max) in [("borderWidth", 40.0_f64), ("radius", 500.0), ("opacity", 1.0)] {
            if let Some(value) = field(widget, name) {
                put(&mut item, name, JsonValue::Number(number(value, 0.0, max)?));
            }
        }
        if let Some(value) = field(widget, "borderColor") {
            put(&mut item, "borderColor", JsonValue::String(color(value)?));
        }
        if let Some(value) = field(widget, "shadow") {
            put(&mut item, "shadow", shadow(value)?);
        }
        built.push(JsonValue::Object(item));
    }
    let ids: Vec<&str> = built
        .iter()
        .filter_map(|widget| widget.get("id").and_then(|value| match value {
            JsonValue::String(text) => text.as_str(),
            _ => None,
        }))
        .collect();
    ensure_unique_ids(ids)?;
    Ok(built)
}

fn alert_layout(value: &JsonValue) -> Result<JsonValue, OverlayError> {
    let layout = object(value)?;
    let mut result = Vec::new();
    put(&mut result, "duration", JsonValue::Number(number(field_or_null(layout, "duration"), 1.0, 120.0)?));
    put(&mut result, "widgets", JsonValue::Array(widgets(field_or_null(layout, "widgets"), true)?));
    if let Some(value) = field(layout, "sound") {
        let sound = object(value)?;
        let asset = field(sound, "assetId");
        match asset {
            Some(JsonValue::String(text)) if text.as_str().is_some_and(is_lower_hex_24) => {}
            _ => return Err(error("Invalid alert sound", 400)),
        }
        let mut accepted = Vec::new();
        put(&mut accepted, "assetId", JsonValue::String(asset.expect("checked present").clone()));
        if let Some(name) = field(sound, "name") {
            put(&mut accepted, "name", JsonValue::String(string(name, 120)?.clone()));
        }
        put(&mut accepted, "volume", JsonValue::Number(number(field_or_null(sound, "volume"), 0.0, 1.0)?));
        put(&mut accepted, "delay", JsonValue::Number(number(field_or_null(sound, "delay"), 0.0, 120.0)?));
        put(&mut accepted, "fadeIn", JsonValue::Number(number(field_or_null(sound, "fadeIn"), 0.0, 10.0)?));
        put(&mut accepted, "fadeOut", JsonValue::Number(number(field_or_null(sound, "fadeOut"), 0.0, 10.0)?));
        put(&mut result, "sound", JsonValue::Object(accepted));
    }
    Ok(JsonValue::Object(result))
}

// ---------------------------------------------------------------------------
// Designs and scenes.

fn previous_by_id<'a>(items: &'a [JsonValue], id: &str) -> Option<&'a JsonValue> {
    items.iter().find(|item| {
        item.get("id").and_then(|value| match value {
            JsonValue::String(text) => text.as_str(),
            _ => None,
        }) == Some(id)
    })
}

fn numeric_or(value: Option<&JsonValue>, fallback: f64) -> f64 {
    match value {
        Some(JsonValue::Number(value)) if value.is_finite() => *value,
        _ => fallback,
    }
}

fn design(value: &JsonValue, previous: &StudioState) -> Result<JsonValue, OverlayError> {
    let raw = object(value)?;
    let id = string_id(field_or_null(raw, "id"))?;
    let name = string(field_or_null(raw, "name"), 80)?.clone();
    let (width, height) = canvas(raw)?;
    let revision = numeric_or(previous_by_id(&previous.designs, &id).and_then(|item| item.get("revision")), 0.0) + 1.0;
    let events = object(field_or_null(raw, "events"))?;
    let mut item = Vec::new();
    put(&mut item, "id", JsonValue::String(JsString::from(id.clone())));
    put(&mut item, "name", JsonValue::String(name));
    put(&mut item, "width", JsonValue::Number(width));
    put(&mut item, "height", JsonValue::Number(height));
    put(&mut item, "revision", JsonValue::Number(revision));
    let mut accepted_events = Vec::with_capacity(ALERT_EVENTS.len());
    for kind in ALERT_EVENTS {
        accepted_events.push((kind.into(), alert_layout(field(events, kind).unwrap_or(&JsonValue::Null))?));
    }
    put(&mut item, "events", JsonValue::Object(accepted_events));

    if let Some(value) = field(raw, "variants") {
        let variants = object(value)?;
        if variants.iter().any(|(key, _)| !["sub", "bits", "raid"].iter().any(|known| key.as_str() == Some(*known))) {
            return Err(error("Invalid variant event", 400));
        }
        let mut accepted = Vec::new();
        for kind in ["sub", "bits", "raid"] {
            let Some(value) = field(variants, kind) else { continue };
            let max = if kind == "bits" { 50 } else { 10 };
            let raw_variants = list(value, max)?;
            let mut built = Vec::with_capacity(raw_variants.len());
            for raw_variant in raw_variants {
                let variant = object(raw_variant)?;
                let variant_id = string_id(field_or_null(variant, "id"))?;
                let variant_name = string(field_or_null(variant, "name"), 80)?.clone();
                let enabled = boolean(field_or_null(variant, "enabled"))?;
                let layout = alert_layout(field_or_null(variant, "layout"))?;
                let mut accepted_variant = Vec::new();
                put(&mut accepted_variant, "id", JsonValue::String(JsString::from(variant_id)));
                put(&mut accepted_variant, "name", JsonValue::String(variant_name));
                put(&mut accepted_variant, "enabled", JsonValue::Bool(enabled));
                put(&mut accepted_variant, "layout", layout);
                if kind == "bits" {
                    if field(variant, "tier").is_some() || field(variant, "min").is_some() || field(variant, "max").is_some()
                        || !valid_rule_id(field(variant, "ruleId"))
                    {
                        return Err(error("Bits looks follow your Bits rules now. Reload the editor.", 400));
                    }
                    put(&mut accepted_variant, "ruleId", field(variant, "ruleId").expect("validated").clone());
                } else if kind == "sub" {
                    let tier = match field(variant, "tier") {
                        Some(JsonValue::String(text)) if text.as_str().is_some_and(|text| ["1000", "2000", "3000"].contains(&text)) => text.clone(),
                        _ => return Err(error("Choose a subscription tier", 400)),
                    };
                    if field(variant, "min").is_some() || field(variant, "max").is_some() || field(variant, "ruleId").is_some() {
                        return Err(error("Choose a subscription tier", 400));
                    }
                    put(&mut accepted_variant, "tier", JsonValue::String(tier));
                } else {
                    if field(variant, "tier").is_some() || field(variant, "ruleId").is_some() {
                        return Err(error("Invalid amount rule", 400));
                    }
                    let mut minimum = None;
                    let mut maximum = None;
                    for name in ["min", "max"] {
                        if let Some(value) = field(variant, name) {
                            let amount = number(value, 0.0, 1_000_000_000.0)?;
                            if amount.fract() != 0.0 {
                                return Err(error("Use a whole amount", 400));
                            }
                            put(&mut accepted_variant, name, JsonValue::Number(amount));
                            if name == "min" {
                                minimum = Some(amount);
                            } else {
                                maximum = Some(amount);
                            }
                        }
                    }
                    let Some(minimum) = minimum else { return Err(error("Invalid amount range", 400)) };
                    if maximum.is_some_and(|maximum| maximum < minimum) {
                        return Err(error("Invalid amount range", 400));
                    }
                }
                built.push(JsonValue::Object(accepted_variant));
            }
            let ids: Vec<&str> = built
                .iter()
                .filter_map(|variant| variant.get("id").and_then(|value| match value {
                    JsonValue::String(text) => text.as_str(),
                    _ => None,
                }))
                .collect();
            ensure_unique_ids(ids)?;
            if kind == "bits" {
                let rules: Vec<&str> = built
                    .iter()
                    .filter_map(|variant| variant.get("ruleId").and_then(|value| match value {
                        JsonValue::String(text) => text.as_str(),
                        _ => None,
                    }))
                    .collect();
                ensure_unique_ids(rules).map_err(|_| error("A Bits rule can only have one look per design", 400))?;
            }
            accepted.push((kind.into(), JsonValue::Array(built)));
        }
        put(&mut item, "variants", JsonValue::Object(accepted));
    }
    Ok(JsonValue::Object(item))
}

fn scene(value: &JsonValue, previous: &StudioState, designs: &[JsonValue]) -> Result<JsonValue, OverlayError> {
    let raw = object(value)?;
    let id = string_id(field_or_null(raw, "id"))?;
    let name = string(field_or_null(raw, "name"), 80)?.clone();
    let (width, height) = canvas(raw)?;
    let widgets = widgets(field_or_null(raw, "widgets"), false)?;
    let mut wait_for = Vec::new();
    let mut seen = HashSet::new();
    for item in list(field_or_null(raw, "waitFor"), 7)? {
        match item {
            JsonValue::String(text) if text.as_str().is_some_and(|text| EVENT_KINDS.contains(&text)) => {
                if seen.insert(text.to_utf8_lossy()) {
                    wait_for.push(item.clone());
                }
            }
            _ => return Err(error("Invalid wait category", 400)),
        }
    }
    let old = previous_by_id(&previous.scenes, &id);
    let public_id = match old.and_then(|item| item.get("publicId")) {
        Some(JsonValue::Null) | None => JsonValue::String(JsString::from(token()?)),
        Some(value) => value.clone(),
    };
    let revision = numeric_or(old.and_then(|item| item.get("revision")), 0.0);
    if widgets.iter().any(|widget| {
        matches!(widget.get("kind"), Some(JsonValue::String(kind)) if kind.as_str() == Some("alert"))
            && !designs.iter().any(|design| design.get("id") == widget.get("designId"))
    }) {
        return Err(error("Alert design is missing", 400));
    }
    let mut item = Vec::new();
    put(&mut item, "id", JsonValue::String(JsString::from(id)));
    put(&mut item, "name", JsonValue::String(name));
    put(&mut item, "width", JsonValue::Number(width));
    put(&mut item, "height", JsonValue::Number(height));
    put(&mut item, "widgets", JsonValue::Array(widgets));
    put(&mut item, "waitFor", JsonValue::Array(wait_for));
    put(&mut item, "publicId", public_id);
    put(&mut item, "revision", JsonValue::Number(revision));
    if let Some(published) = old.and_then(|item| item.get("published")).filter(|value| truthy(value)) {
        put(&mut item, "published", published.clone());
    }
    Ok(JsonValue::Object(item))
}

/// Source `validateState`: rebuild both arrays and enforce cross-references,
/// capacity, and the serialized 4 MiB limit.
pub fn validate_state(
    raw: &JsonValue,
    previous: &StudioState,
) -> Result<(Vec<JsonValue>, Vec<JsonValue>), OverlayError> {
    let body = object(raw)?;
    let raw_designs = list(field_or_null(body, "designs"), MAX_DESIGNS)?;
    let mut designs = Vec::with_capacity(raw_designs.len());
    for value in raw_designs {
        designs.push(design(value, previous)?);
    }
    let design_ids: Vec<&str> = designs
        .iter()
        .filter_map(|value| value.get("id").and_then(|id| match id {
            JsonValue::String(text) => text.as_str(),
            _ => None,
        }))
        .collect();
    ensure_unique_ids(design_ids)?;

    let raw_scenes = list(field_or_null(body, "scenes"), MAX_SCENES)?;
    let mut scenes = Vec::with_capacity(raw_scenes.len());
    for value in raw_scenes {
        scenes.push(scene(value, previous, &designs)?);
    }
    let scene_ids: Vec<&str> = scenes
        .iter()
        .filter_map(|value| value.get("id").and_then(|id| match id {
            JsonValue::String(text) => text.as_str(),
            _ => None,
        }))
        .collect();
    ensure_unique_ids(scene_ids)?;

    if scenes.is_empty() || designs.is_empty() {
        return Err(error("Keep at least one overlay and alert design", 400));
    }
    let payload = JsonValue::Object(vec![
        ("scenes".into(), JsonValue::Array(scenes.clone())),
        ("designs".into(), JsonValue::Array(designs.clone())),
    ]);
    if payload.to_json_string().len() > MAX_STATE_BYTES {
        return Err(error("Overlay storage limit reached", 400));
    }
    Ok((scenes, designs))
}

// ---------------------------------------------------------------------------
// Persistence operations shared by the Mongo adapter and injected test seams.

fn bson_number(value: Option<&Bson>) -> Option<f64> {
    match value {
        Some(Bson::Int32(value)) => Some(f64::from(*value)),
        Some(Bson::Int64(value)) => Some(*value as f64),
        Some(Bson::Double(value)) => Some(*value),
        _ => None,
    }
}

fn json_array(value: Option<&Bson>, message: &str) -> Result<Vec<JsonValue>, OverlayError> {
    match value {
        Some(Bson::Array(values)) => Ok(values.iter().map(crate::utils::bson_json::compiler_bson_json).collect()),
        _ => Err(error(message, 500)),
    }
}

fn state_from_document(stored: &Document) -> Result<StudioState, OverlayError> {
    let revision = bson_number(stored.get("revision")).ok_or_else(|| error("Invalid overlay revision", 500))?;
    let scenes = json_array(stored.get("scenes"), "Invalid overlay scenes")?;
    let designs = json_array(stored.get("designs"), "Invalid overlay designs")?;
    Ok(StudioState { schema_version: 1, revision, scenes, designs })
}

/// Build the source's starter draft with its two customized alert captions.
fn starter_document(channel: &str, public_id: &str) -> Result<Document, OverlayError> {
    let design = make_design("starter", "My alerts");
    let scene = make_scene("main", "My overlay", "starter");
    let mut design = match json_bson(&design) {
        Bson::Document(value) => value,
        _ => return Err(error("Unable to create overlay", 500)),
    };
    let mut scene = match json_bson(&scene) {
        Bson::Document(value) => value,
        _ => return Err(error("Unable to create overlay", 500)),
    };
    scene.insert("publicId", public_id);
    let events = design.get_document_mut("events").map_err(|_| error("Unable to create overlay", 500))?;
    for (kind, caption) in [
        ("bits", "$(user) sent $(cheer.amount) bits"),
        ("raid", "$(raid.channel) arrived with $(raid.viewers) viewers"),
    ] {
        let layout = events.get_document_mut(kind).map_err(|_| error("Unable to create overlay", 500))?;
        let widgets = layout.get_array_mut("widgets").map_err(|_| error("Unable to create overlay", 500))?;
        let caption_widget = widgets
            .get_mut(1)
            .and_then(|value| value.as_document_mut())
            .ok_or_else(|| error("Unable to create overlay", 500))?;
        caption_widget.insert("text", caption);
    }
    Ok(doc! { "_id": channel, "schemaVersion": 1, "revision": 0, "scenes": [scene], "designs": [design] })
}

/// Require the source's owning Twitch account.
pub async fn require_overlay_account(
    persistence: &dyn StudioPersistence,
    channel: &str,
) -> Result<(), OverlayError> {
    persistence.require_account(channel).await
}

/// Load a draft, creating the source's starter design and scene on first use.
pub async fn load(persistence: &dyn StudioPersistence, channel: &str) -> Result<StudioState, OverlayError> {
    require_overlay_account(persistence, channel).await?;
    if let Some(stored) = persistence.find_studio(channel).await? {
        return state_from_document(&stored);
    }
    persistence.insert_studio(starter_document(channel, &token()?)?).await?;
    let stored = persistence
        .find_studio(channel)
        .await?
        .ok_or_else(|| error("Unable to load overlay", 500))?;
    state_from_document(&stored)
}

/// Persist one mutation with the source's revision compare-and-set. Callers
/// that accept untrusted input validate it inside the operation before any
/// write occurs; the operation's error leaves the stored draft unchanged.
pub async fn change<F>(
    persistence: &dyn StudioPersistence,
    channel: &str,
    revision: f64,
    operation: F,
) -> Result<StudioState, OverlayError>
where
    F: FnOnce(&mut StudioState) -> Result<(), OverlayError>,
{
    let mut state = load(persistence, channel).await?;
    check_revision(revision, state.revision)?;
    operation(&mut state)?;
    let scenes = state.scenes.iter().map(json_bson).collect();
    let designs = state.designs.iter().map(json_bson).collect();
    if !persistence.compare_and_set(channel, revision, scenes, designs).await? {
        return Err(stale());
    }
    state.revision = revision + 1.0;
    Ok(state)
}

/// Read a published scene and verify its owner still has a Twitch account.
pub fn published_scene(stored: &Document, public_id: &str) -> Result<PublicState, OverlayError> {
    let channel = stored.get_str("_id").map_err(|_| error("Overlay not found", 404))?.to_owned();
    let scenes = stored.get_array("scenes").map_err(|_| error("Overlay not found", 404))?;
    let scene = scenes
        .iter()
        .filter_map(|value| value.as_document())
        .find(|value| value.get_str("publicId").ok() == Some(public_id))
        .ok_or_else(|| error("Overlay not found", 404))?;
    let snapshot = scene
        .get_document("published")
        .map_err(|_| error("This overlay has not been published", 404))?
        .clone();
    let revision = scene.get("revision").cloned().ok_or_else(|| error("Invalid overlay revision", 500))?;
    Ok(PublicState { channel, public_id: public_id.to_owned(), revision, snapshot, controls: controls_from(stored) })
}

fn controls_from(stored: &Document) -> Document {
    let mut controls = doc! { "revision": 0_i32, "all": false, "platforms": {} };
    if let Ok(stored_controls) = stored.get_document("controls") {
        for (key, value) in stored_controls {
            controls.insert(key, value.clone());
        }
    }
    controls
}

/// Read a published scene through an injected persistence adapter.
pub async fn public_state(
    persistence: &dyn StudioPersistence,
    public_id: &str,
) -> Result<PublicState, OverlayError> {
    if !valid_public_id(public_id) {
        return Err(error("Overlay not found", 404));
    }
    let stored = persistence.find_public(public_id).await?.ok_or_else(|| error("Overlay not found", 404))?;
    let channel = stored.get_str("_id").map_err(|_| error("Overlay not found", 404))?.to_owned();
    require_overlay_account(persistence, &channel).await?;
    published_scene(&stored, public_id)
}

/// Published scene and its owning channel.
#[derive(Clone, Debug, PartialEq)]
pub struct PublicState {
    /// Owning channel.
    pub channel: String,
    /// Public source ID.
    pub public_id: String,
    /// Stored scene revision.
    pub revision: mongodb::bson::Bson,
    /// Immutable published scene data.
    pub snapshot: Document,
    /// Queue controls with source defaults.
    pub controls: Document,
}

/// Mongo adapter for the source's load/change/public operations.
#[derive(Clone)]
pub struct MongoStudioStore {
    database: Database,
    persistence: Arc<dyn StudioPersistence>,
}

impl MongoStudioStore {
    /// Construct without I/O.
    pub fn new(database: Database) -> Self {
        Self { persistence: Arc::new(MongoStudioPersistence::new(database.clone())), database }
    }
    /// Access the underlying studio collection.
    pub fn studios(&self) -> Collection<Document> {
        self.database.collection(STUDIO_COLLECTION)
    }
    /// Access the persistence adapter for recovery or route composition.
    pub fn persistence(&self) -> &dyn StudioPersistence {
        self.persistence.as_ref()
    }
    /// Load a validated draft, creating the starter content on first use.
    pub async fn load(&self, channel: &str) -> Result<StudioState, OverlayError> {
        load(self.persistence.as_ref(), channel).await
    }
    /// Apply a mutation with the source's revision compare-and-set.
    pub async fn change<F>(
        &self,
        channel: &str,
        revision: f64,
        operation: F,
    ) -> Result<StudioState, OverlayError>
    where
        F: FnOnce(&mut StudioState) -> Result<(), OverlayError>,
    {
        change(self.persistence.as_ref(), channel, revision, operation).await
    }
    /// Read a published scene and verify its owner.
    pub async fn public_state(&self, public_id: &str) -> Result<PublicState, OverlayError> {
        public_state(self.persistence.as_ref(), public_id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::lossless_json::parse_json;

    fn json(text: &str) -> JsonValue {
        parse_json(text).expect("fixture JSON")
    }

    #[test]
    fn public_id_requires_exact_lowercase_hex() {
        assert!(valid_public_id(&"a".repeat(48)));
        assert!(!valid_public_id(&"A".repeat(48)));
        assert!(!valid_public_id(&"a".repeat(47)));
    }

    #[test]
    fn stale_revision_is_rejected() {
        assert!(check_revision(4.0, 4.0).is_ok());
        assert_eq!(check_revision(3.0, 4.0).expect_err("stale").status, 409);
        assert!(check_revision(4.5, 4.5).is_err());
    }

    #[test]
    fn javascript_coercion_matches_source_asset_and_color_rules() {
        assert_eq!(js_string_value(&json("[\"#ff00aa\"]")), "#ff00aa");
        assert_eq!(js_string_value(&json("[null,1]")), ",1");
        assert_eq!(js_string_value(&json("{\"a\":1}")), "[object Object]");
        assert!(is_hex_color("#aBcD09"));
        assert!(!is_hex_color("#abcd0"));
    }

    #[test]
    fn media_urls_require_https_without_credentials() {
        assert!(valid_media_url("HTTPS://example.test/a.png"));
        assert!(valid_media_url("https://@example.test/a.png"));
        assert!(!valid_media_url("http://example.test/a.png"));
        assert!(!valid_media_url("https://user@example.test/a.png"));
        assert!(!valid_media_url("https://user:secret@example.test/a.png"));
        assert!(!valid_media_url("https:///a.png"));
    }
}

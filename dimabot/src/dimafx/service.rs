//! DimaFX configuration service ported from `dimafx.service.ts`.
//!
//! The source mixes pure normalizers with two application reads: the
//! `DIMAFX_SKU_MAP` environment variable and the channel admin lookup. Both
//! reads are injected here:
//!
//! * [`DimafxSkuMapSource`] reads the environment at call time in
//!   [`ProcessDimafxSkuMapSource`]; tests can supply a recording source.
//! * [`DimafxAdminLookup`] wraps the already-ported `api_admin` helper and the
//!   native `admins` collection in [`MongoDimafxAdminLookup`].
//!
//! No constructor performs I/O, reads the environment, or opens a connection.
//! Text fields keep JavaScript UTF-16 semantics through [`JsString`], including
//! `String.prototype.trim`, `\s+` collapsing, and `slice(0, 280)`. Viewer
//! config values reuse the schema enums [`QuickPurchasePriority`] and
//! [`QuickPurchaseAction`]; TTS configuration reuses
//! [`ChannelExtensionItemTtsConfig`]. Invalid SKU-map diagnostics reuse
//! [`JsDate`] for the source's `new Date().toISOString()` timestamp.

use crate::schemas::channel_extension_item::{
    ChannelExtensionItemTtsConfig, ChannelExtensionItemTtsLanguage, ChannelExtensionItemTtsMode,
};
use crate::schemas::user_extension_inventory::{
    IUserExtensionInventoryConfig, IUserExtensionInventoryItem, QuickPurchaseAction,
    QuickPurchasePriority,
};
use crate::utils::{
    credit_policy::JsDate,
    js_compat,
    js_date,
    js_string::JsString,
    json_number::{number_string, string_number},
    lossless_json::{JsonValue, array_index_str, parse_json},
};
use mongodb::{
    Collection, Database,
    bson::{DateTime, Document, doc},
};
use std::{
    cmp::Ordering,
    collections::BTreeMap,
    fmt,
    future::Future,
};

/// Maximum broadcaster-authored text length in UTF-16 code units.
pub const DIMAFX_TTS_FIXED_TEXT_MAX: usize = 500;
/// Maximum viewer-authored text length in UTF-16 code units.
pub const DIMAFX_TTS_VIEWER_TEXT_MAX: usize = 280;

/// Source `DEFAULT_SKU_MAP`; order is the source's literal declaration order.
pub const DEFAULT_SKU_MAP: &[(f64, &str)] = &[
    (0.0, "free"),
    (5.0, "dimafx_bits_5"),
    (10.0, "dimafx_bits_10"),
    (25.0, "dimafx_bits_25"),
    (50.0, "dimafx_bits_50"),
    (100.0, "dimafx_bits_100"),
];

/// A user-facing TTS configuration error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TtsConfigError(pub &'static str);
impl fmt::Display for TtsConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for TtsConfigError {}

/// A DimaFX permission lookup failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DimafxPermissionError(pub String);
impl fmt::Display for DimafxPermissionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for DimafxPermissionError {}

/// Normalized `DIMAFX_SKU_MAP` keyed by ECMAScript `Number::toString` text.
///
/// The source stores numeric object keys, so the normalized key for `5` and
/// `5.0` is the same JavaScript property key `"5"`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DimafxSkuMap {
    entries: BTreeMap<String, JsString>,
}
impl DimafxSkuMap {
    /// Build the source default map.
    pub fn defaults() -> Self {
        Self {
            entries: DEFAULT_SKU_MAP
                .iter()
                .map(|(price, sku)| (number_string(*price), JsString::from(*sku)))
                .collect(),
        }
    }

    /// Look up a price using the same property-key conversion as JavaScript.
    pub fn sku_for(&self, price: f64) -> Option<&JsString> {
        self.entries.get(&number_string(price))
    }

    /// Numeric keys in ascending order, matching `getAllowedDimafxBitPrices`.
    pub fn bit_prices(&self) -> Vec<f64> {
        let mut prices: Vec<f64> = self
            .entries
            .keys()
            .filter_map(|key| key.parse::<f64>().ok())
            .collect();
        prices.sort_by(|left, right| left.partial_cmp(right).unwrap_or(Ordering::Equal));
        prices
    }

    /// Iterate normalized entries in key-text order (not numeric order).
    pub fn entries(&self) -> impl Iterator<Item = (&str, &JsString)> {
        self.entries.iter().map(|(key, value)| (key.as_str(), value))
    }

    /// Number of normalized entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the map has no entries.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Environment boundary for `DIMAFX_SKU_MAP`.
pub trait DimafxSkuMapSource: Send + Sync {
    /// Read the raw variable at call time; `None` means unset.
    fn raw_sku_map(&self) -> Option<String>;
    /// Report an invalid JSON value without changing the fallback result.
    fn report_invalid_sku_map(&self, error: &str, at_millis: i64);
}

/// Production source: reads `DIMAFX_SKU_MAP` on every call and reports to stderr.
///
/// The source helper is synchronous and calls `console.error`; a synchronous
/// stderr diagnostic is the equivalent console sink. The native structured
/// logger is asynchronous and is not reachable from a pure module helper.
#[derive(Clone, Copy, Debug, Default)]
pub struct ProcessDimafxSkuMapSource;
impl DimafxSkuMapSource for ProcessDimafxSkuMapSource {
    fn raw_sku_map(&self) -> Option<String> {
        std::env::var("DIMAFX_SKU_MAP").ok()
    }

    fn report_invalid_sku_map(&self, error: &str, at_millis: i64) {
        let timestamp = JsDate::from_millis(at_millis as f64)
            .to_iso_string()
            .unwrap_or_else(|_| at_millis.to_string());
        let payload = serde_json::json!({
            "error": error,
            "timestamp": timestamp,
        });
        eprintln!("Invalid DIMAFX_SKU_MAP, using defaults: {payload}");
    }
}

/// Read and normalize `DIMAFX_SKU_MAP` with the source fallback branches.
///
/// An absent or empty variable uses the defaults. Invalid JSON, `null`, and a
/// parsed map whose entries are all invalid also use the defaults. A parsed
/// primitive or array follows `Object.entries` coercion exactly.
pub fn get_dimafx_sku_map(source: &impl DimafxSkuMapSource) -> DimafxSkuMap {
    let Some(raw) = source.raw_sku_map().filter(|value| !value.is_empty()) else {
        return DimafxSkuMap::defaults();
    };
    let parsed = match parse_json(&raw) {
        Ok(value) => value,
        Err(error) => {
            source.report_invalid_sku_map(&error, now_millis());
            return DimafxSkuMap::defaults();
        }
    };
    // `Object.entries(null)` throws and the source catch logs it.
    if matches!(&parsed, JsonValue::Null) {
        source.report_invalid_sku_map("Cannot convert undefined or null to object", now_millis());
        return DimafxSkuMap::defaults();
    }
    let mut entries = BTreeMap::new();
    for (price, sku) in js_object_entries(&parsed) {
        let numeric = price.as_str().map_or(f64::NAN, string_number);
        let sku = match sku {
            JsonValue::String(value) => value.trim(),
            _ => continue,
        };
        if numeric.is_finite() && numeric >= 0.0 && !sku.is_empty() {
            entries.insert(number_string(numeric), sku);
        }
    }
    if entries.is_empty() {
        DimafxSkuMap::defaults()
    } else {
        DimafxSkuMap { entries }
    }
}

/// Source `getDimafxSkuForBitsPrice`; `null` becomes [`Option::None`].
pub fn get_dimafx_sku_for_bits_price(
    source: &impl DimafxSkuMapSource,
    price: f64,
) -> Option<JsString> {
    get_dimafx_sku_map(source).sku_for(price).cloned()
}

/// Source `getAllowedDimafxBitPrices`; numeric keys in ascending order.
pub fn get_allowed_dimafx_bit_prices(source: &impl DimafxSkuMapSource) -> Vec<f64> {
    get_dimafx_sku_map(source).bit_prices()
}

/// `Object.entries` over a parsed JSON value, including the source's primitive
/// coercion and JavaScript own-property enumeration order.
fn js_object_entries(value: &JsonValue) -> Vec<(JsString, JsonValue)> {
    match value {
        JsonValue::Object(fields) => {
            let mut entries: Vec<(usize, (JsString, JsonValue))> =
                fields.iter().cloned().enumerate().collect();
            entries.sort_by_key(|entry| {
                let array_index = entry.1.0.as_str().and_then(array_index_str);
                (array_index.is_none(), array_index.unwrap_or(0), entry.0)
            });
            entries.into_iter().map(|(_, field)| field).collect()
        }
        JsonValue::Array(values) => values
            .iter()
            .cloned()
            .enumerate()
            .map(|(index, value)| (JsString::from(index.to_string()), value))
            .collect(),
        JsonValue::String(value) => value
            .code_units()
            .enumerate()
            .map(|(index, unit)| {
                (
                    JsString::from(index.to_string()),
                    JsonValue::String(JsString::from_units(vec![unit])),
                )
            })
            .collect(),
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) => Vec::new(),
    }
}

/// Channel/global admin boundary used by `hasDimafxPermission`.
pub trait DimafxAdminLookup: Send + Sync {
    /// `hasGlobalChannelOwnerAccess`.
    fn has_global_channel_owner_access(
        &self,
        requester: &str,
        channel: &str,
    ) -> impl Future<Output = Result<bool, DimafxPermissionError>> + Send;

    /// Active Admin row with one of the supplied permissions.
    fn has_channel_permission(
        &self,
        channel: &str,
        requester: &str,
        permissions: &[String],
    ) -> impl Future<Output = Result<bool, DimafxPermissionError>> + Send;
}

/// Production adapter over the native `admins` collection and `api_admin` helper.
#[derive(Clone)]
pub struct MongoDimafxAdminLookup {
    database: Database,
}
impl MongoDimafxAdminLookup {
    /// Use an existing database; no connection is opened.
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    fn admins(&self) -> Collection<Document> {
        crate::schemas::admin::schema().native_collection(&self.database)
    }
}
impl DimafxAdminLookup for MongoDimafxAdminLookup {
    async fn has_global_channel_owner_access(
        &self,
        requester: &str,
        channel: &str,
    ) -> Result<bool, DimafxPermissionError> {
        let admins = self.admins();
        crate::api_admin::has_global_channel_owner_access(
            &admins,
            Some(requester),
            Some(channel),
        )
        .await
        .map_err(|error| DimafxPermissionError(error.to_string()))
    }

    async fn has_channel_permission(
        &self,
        channel: &str,
        requester: &str,
        permissions: &[String],
    ) -> Result<bool, DimafxPermissionError> {
        let admins = self.admins();
        let permissions = permissions.to_vec();
        admins
            .find_one(doc! {
                "channelID": channel,
                "adminID": requester,
                "actived": true,
                "permissions": { "$in": permissions },
            })
            .await
            .map(|row| row.is_some())
            .map_err(|error| DimafxPermissionError(error.to_string()))
    }
}

/// Source `hasDimafxPermission`: self, global owner, then an active channel
/// Admin row holding `*`, `dimafx:all`, or one of the required permissions.
pub async fn has_dimafx_permission<A: DimafxAdminLookup>(
    admins: &A,
    requester: &str,
    channel: &str,
    required: &[String],
) -> Result<bool, DimafxPermissionError> {
    if requester == channel {
        return Ok(true);
    }
    if admins
        .has_global_channel_owner_access(requester, channel)
        .await?
    {
        return Ok(true);
    }
    let mut permissions = Vec::with_capacity(required.len() + 2);
    permissions.push("*".to_owned());
    permissions.push("dimafx:all".to_owned());
    permissions.extend(required.iter().cloned());
    admins
        .has_channel_permission(channel, requester, &permissions)
        .await
}

/// DimaFX configuration service composed from concrete production adapters.
#[derive(Clone)]
pub struct DimafxService<A = MongoDimafxAdminLookup, S = ProcessDimafxSkuMapSource> {
    admins: A,
    sku_source: S,
}
impl DimafxService<MongoDimafxAdminLookup, ProcessDimafxSkuMapSource> {
    /// Full native wiring with a caller-owned database; performs no I/O.
    pub fn native(database: Database) -> Self {
        Self::with_adapters(
            MongoDimafxAdminLookup::new(database),
            ProcessDimafxSkuMapSource,
        )
    }
}
impl<A: DimafxAdminLookup, S: DimafxSkuMapSource> DimafxService<A, S> {
    /// Supply isolated adapters.
    pub fn with_adapters(admins: A, sku_source: S) -> Self {
        Self { admins, sku_source }
    }

    /// Current normalized SKU map.
    pub fn sku_map(&self) -> DimafxSkuMap {
        get_dimafx_sku_map(&self.sku_source)
    }

    /// SKU for a Bits price.
    pub fn sku_for_bits_price(&self, price: f64) -> Option<JsString> {
        get_dimafx_sku_for_bits_price(&self.sku_source, price)
    }

    /// Allowed Bits prices in ascending order.
    pub fn allowed_bit_prices(&self) -> Vec<f64> {
        get_allowed_dimafx_bit_prices(&self.sku_source)
    }

    /// Source `hasDimafxPermission`.
    pub async fn has_permission(
        &self,
        requester: &str,
        channel: &str,
        required: &[String],
    ) -> Result<bool, DimafxPermissionError> {
        has_dimafx_permission(&self.admins, requester, channel, required).await
    }
}

/// Source `normalizeDimafxPurchaseAction`: only `save` is `save`.
pub fn normalize_dimafx_purchase_action(value: &str) -> QuickPurchaseAction {
    if value == QuickPurchaseAction::Save.as_str() {
        QuickPurchaseAction::Save
    } else {
        QuickPurchaseAction::UseNow
    }
}

/// Unknown/JSON variant of `normalizeDimafxPurchaseAction`; non-strings are
/// `use_now` because the source compares against the literal `"save"`.
pub fn normalize_dimafx_purchase_action_json(value: Option<&JsonValue>) -> QuickPurchaseAction {
    match value {
        Some(JsonValue::String(value)) => value
            .as_str()
            .map_or(QuickPurchaseAction::UseNow, normalize_dimafx_purchase_action),
        _ => QuickPurchaseAction::UseNow,
    }
}

/// Incoming viewer config fields; absent or invalid fields keep the current
/// value. The current type is the already-ported inventory config.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DimafxViewerConfigUpdate<'a> {
    /// `quickPurchasePriority`.
    pub quick_purchase_priority: Option<&'a str>,
    /// `quickPurchaseAction`.
    pub quick_purchase_action: Option<&'a str>,
}

/// Source `normalizeDimafxViewerConfig`.
pub fn normalize_dimafx_viewer_config(
    incoming: DimafxViewerConfigUpdate<'_>,
    current: IUserExtensionInventoryConfig,
) -> IUserExtensionInventoryConfig {
    IUserExtensionInventoryConfig {
        quick_purchase_priority: incoming
            .quick_purchase_priority
            .and_then(QuickPurchasePriority::parse)
            .unwrap_or(current.quick_purchase_priority),
        quick_purchase_action: incoming
            .quick_purchase_action
            .and_then(QuickPurchaseAction::parse)
            .unwrap_or(current.quick_purchase_action),
    }
}

/// JSON variant of `normalizeDimafxViewerConfig`; only string fields can match.
pub fn normalize_dimafx_viewer_config_json(
    incoming: Option<&JsonValue>,
    current: IUserExtensionInventoryConfig,
) -> IUserExtensionInventoryConfig {
    normalize_dimafx_viewer_config(
        DimafxViewerConfigUpdate {
            quick_purchase_priority: incoming
                .and_then(|value| value.get("quickPurchasePriority"))
                .and_then(json_string),
            quick_purchase_action: incoming
                .and_then(|value| value.get("quickPurchaseAction"))
                .and_then(json_string),
        },
        current,
    )
}

fn json_string(value: &JsonValue) -> Option<&str> {
    match value {
        JsonValue::String(value) => value.as_str(),
        _ => None,
    }
}

/// ECMAScript `Date` TimeClip bound in milliseconds.
const JS_MAX_TIME_MILLIS: i64 = 8_640_000_000_000_000;

/// Source `acquiredAt: Date | string`.
#[derive(Clone, Debug, PartialEq)]
pub enum DimafxAcquiredAt {
    /// A BSON/Mongoose date.
    Date(DateTime),
    /// A JavaScript date string.
    Text(JsString),
}
impl DimafxAcquiredAt {
    /// `new Date(value).getTime()`, including `NaN` for invalid input.
    pub fn millis(&self) -> f64 {
        match self {
            Self::Date(value) => {
                let millis = value.timestamp_millis();
                if (-JS_MAX_TIME_MILLIS..=JS_MAX_TIME_MILLIS).contains(&millis) {
                    millis as f64
                } else {
                    f64::NAN
                }
            }
            Self::Text(value) => match value.as_str() {
                Some(text) => js_date::parse_date(text).map_or(f64::NAN, |millis| millis as f64),
                None => js_date::parse_date_utf16(&value.units())
                    .map_or(f64::NAN, |millis| millis as f64),
            },
        }
    }
}

/// Fields used by `selectRedeemCandidate`.
pub trait DimafxRedeemItem {
    /// `String(item.channelExtensionItemID)`.
    fn channel_extension_item_id(&self) -> JsString;
    /// `Number(item.quantity || 0)`.
    fn quantity(&self) -> f64;
    /// `new Date(item.acquiredAt)`.
    fn acquired_at(&self) -> DimafxAcquiredAt;
}

/// Standalone redeem row for callers that do not use the inventory schema.
#[derive(Clone, Debug, PartialEq)]
pub struct DimafxRedeemRow {
    /// Stored channel extension item id as its string form.
    pub channel_extension_item_id: JsString,
    /// Remaining quantity.
    pub quantity: f64,
    /// Acquisition date.
    pub acquired_at: DimafxAcquiredAt,
}
impl DimafxRedeemItem for DimafxRedeemRow {
    fn channel_extension_item_id(&self) -> JsString {
        self.channel_extension_item_id.clone()
    }
    fn quantity(&self) -> f64 {
        self.quantity
    }
    fn acquired_at(&self) -> DimafxAcquiredAt {
        self.acquired_at.clone()
    }
}
impl DimafxRedeemItem for IUserExtensionInventoryItem {
    fn channel_extension_item_id(&self) -> JsString {
        JsString::from(self.channel_extension_item_id.to_hex())
    }
    fn quantity(&self) -> f64 {
        self.quantity
    }
    fn acquired_at(&self) -> DimafxAcquiredAt {
        DimafxAcquiredAt::Date(self.acquired_at)
    }
}

/// Source `selectRedeemCandidate`: exact id, positive quantity, newest first.
///
/// `Array.prototype.sort` is stable in V8, so equal and invalid dates keep the
/// input order. The comparator returns `Equal` when the date difference is
/// `NaN`, matching the specification's `ToNumber` treatment of the result.
pub fn select_redeem_candidate<'a, T: DimafxRedeemItem>(
    items: &'a [T],
    item_id: &str,
) -> Option<&'a T> {
    let wanted = JsString::from(item_id);
    let mut candidates: Vec<&T> = items
        .iter()
        .filter(|item| item.channel_extension_item_id() == wanted && item.quantity() > 0.0)
        .collect();
    candidates.sort_by(|left, right| {
        let difference = right.acquired_at().millis() - left.acquired_at().millis();
        if difference.is_nan() {
            Ordering::Equal
        } else if difference > 0.0 {
            Ordering::Less
        } else if difference < 0.0 {
            Ordering::Greater
        } else {
            Ordering::Equal
        }
    });
    candidates.into_iter().next()
}

/// Validate a trimmed Piper voice identifier against the source pattern
/// `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$`.
pub fn is_valid_dimafx_tts_voice(value: &str) -> bool {
    is_valid_dimafx_tts_voice_js(&JsString::from(value))
}

/// UTF-16 variant used by [`normalize_dimafx_tts_config`].
pub fn is_valid_dimafx_tts_voice_js(value: &JsString) -> bool {
    let trimmed = value.trim();
    let units = trimmed.units();
    if units.is_empty() || units.len() > 120 {
        return false;
    }
    units[0].is_ascii_alphanumeric()
        && units[1..]
            .iter()
            .all(|unit| unit.is_ascii_alphanumeric() || matches!(*unit, 0x5f | 0x2e | 0x2d))
}

/// Source `normalizeDimafxTtsConfig`.
///
/// `undefined`/`null` becomes `None`; a non-object throws
/// `Invalid TTS configuration`; arrays are objects and normalize to an empty
/// custom configuration. Text length is counted in UTF-16 code units.
pub fn normalize_dimafx_tts_config(
    value: Option<&JsonValue>,
) -> Result<Option<ChannelExtensionItemTtsConfig>, TtsConfigError> {
    let value = match value {
        None | Some(JsonValue::Null) => return Ok(None),
        Some(value) => value,
    };
    if !matches!(value, JsonValue::Object(_) | JsonValue::Array(_)) {
        return Err(TtsConfigError("Invalid TTS configuration"));
    }
    let string = |key: &str| match value.get(key) {
        Some(JsonValue::String(value)) => Some(value),
        _ => None,
    };
    let mode = if string("mode").and_then(JsString::as_str) == Some("fixed") {
        ChannelExtensionItemTtsMode::Fixed
    } else {
        ChannelExtensionItemTtsMode::Custom
    };
    let language = if string("language").and_then(JsString::as_str) == Some("es") {
        ChannelExtensionItemTtsLanguage::Es
    } else {
        ChannelExtensionItemTtsLanguage::En
    };
    let text = string("text").map_or_else(|| JsString::from(""), collapse_whitespace_js);
    if mode == ChannelExtensionItemTtsMode::Fixed && text.is_empty() {
        return Err(TtsConfigError("Fixed TTS items require text"));
    }
    if text.len() > DIMAFX_TTS_FIXED_TEXT_MAX {
        return Err(TtsConfigError(
            "TTS text must be 500 characters or fewer",
        ));
    }
    let voice = string("voice").map_or_else(|| JsString::from(""), JsString::trim);
    if !voice.is_empty() && !is_valid_dimafx_tts_voice_js(&voice) {
        return Err(TtsConfigError("Invalid TTS voice"));
    }
    Ok(Some(ChannelExtensionItemTtsConfig {
        mode,
        text,
        voice,
        language,
    }))
}

/// Source `sanitizeDimafxViewerTtsText`; non-strings become the empty string.
pub fn sanitize_dimafx_viewer_tts_text(value: Option<&JsonValue>) -> JsString {
    match value {
        Some(JsonValue::String(value)) => sanitize_dimafx_viewer_tts_text_js(value),
        _ => JsString::from(""),
    }
}

/// String convenience for callers that already hold UTF-8.
pub fn sanitize_dimafx_viewer_tts_text_str(value: &str) -> JsString {
    sanitize_dimafx_viewer_tts_text_js(&JsString::from(value))
}

/// UTF-16 variant used by the JSON helper.
pub fn sanitize_dimafx_viewer_tts_text_js(value: &JsString) -> JsString {
    let stripped = strip_links_js(value);
    collapse_whitespace_js(&stripped).slice(0, DIMAFX_TTS_VIEWER_TEXT_MAX as i64)
}

/// `String.prototype.trim().replace(/\s+/g, " ")` over UTF-16 code units.
fn collapse_whitespace_js(value: &JsString) -> JsString {
    let trimmed = value.trim();
    let mut units = Vec::with_capacity(trimmed.len());
    let mut pending_space = false;
    for unit in trimmed.code_units() {
        if is_js_space_unit(unit) {
            pending_space = !units.is_empty();
        } else {
            if pending_space {
                units.push(u16::from(b' '));
                pending_space = false;
            }
            units.push(unit);
        }
    }
    JsString::from_units(units)
}

/// `/https?:\/\/\S+|www\.\S+/gi` without a regex engine, preserving UTF-16.
fn strip_links_js(value: &JsString) -> JsString {
    let units = value.units();
    let mut output = Vec::with_capacity(units.len());
    let mut index = 0;
    while index < units.len() {
        if let Some(end) = link_match_end(&units, index) {
            output.push(u16::from(b' '));
            index = end;
        } else {
            output.push(units[index]);
            index += 1;
        }
    }
    JsString::from_units(output)
}

fn link_match_end(units: &[u16], start: usize) -> Option<usize> {
    if starts_ascii_ci(units, start, b"http") {
        let mut index = start + 4;
        if units
            .get(index)
            .is_some_and(|unit| *unit == u16::from(b's') || *unit == u16::from(b'S'))
        {
            index += 1;
        }
        if starts_ascii_ci(units, index, b"://") {
            return consume_nonspace(units, index + 3);
        }
    }
    if starts_ascii_ci(units, start, b"www.") {
        return consume_nonspace(units, start + 4);
    }
    None
}

fn starts_ascii_ci(units: &[u16], start: usize, needle: &[u8]) -> bool {
    units.len() >= start.saturating_add(needle.len())
        && needle.iter().enumerate().all(|(offset, byte)| {
            let unit = units[start + offset];
            unit.is_ascii() && (unit as u8).eq_ignore_ascii_case(byte)
        })
}

fn consume_nonspace(units: &[u16], mut index: usize) -> Option<usize> {
    let start = index;
    while index < units.len() && !is_js_space_unit(units[index]) {
        index += 1;
    }
    (index > start).then_some(index)
}

/// ECMAScript `\s` membership for one UTF-16 code unit.
fn is_js_space_unit(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(js_compat::is_whitespace)
}

fn now_millis() -> i64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_millis().min(i64::MAX as u128) as i64,
        Err(error) => -(error.duration().as_millis().min(i64::MAX as u128) as i64),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schemas::user_extension_inventory::InventoryItemSource;
    use mongodb::bson::oid::ObjectId;
    use std::sync::Mutex;

    fn json(text: &str) -> JsonValue {
        parse_json(text).expect("test JSON")
    }
    fn js(text: &str) -> JsString {
        JsString::from(text)
    }
    fn date(millis: i64) -> DateTime {
        DateTime::from_millis(millis)
    }
    fn run<T>(future: impl Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("test runtime")
            .block_on(future)
    }
    fn tts(text: &str) -> ChannelExtensionItemTtsConfig {
        normalize_dimafx_tts_config(Some(&json(text)))
            .expect("valid TTS config")
            .expect("present TTS config")
    }

    #[derive(Default)]
    struct RecordingSkuSource {
        raw: Mutex<Option<String>>,
        reports: Mutex<Vec<String>>,
    }
    impl RecordingSkuSource {
        fn with_raw(raw: Option<&str>) -> Self {
            Self {
                raw: Mutex::new(raw.map(str::to_owned)),
                reports: Mutex::new(Vec::new()),
            }
        }
    }
    impl DimafxSkuMapSource for RecordingSkuSource {
        fn raw_sku_map(&self) -> Option<String> {
            self.raw.lock().unwrap().clone()
        }
        fn report_invalid_sku_map(&self, error: &str, _at_millis: i64) {
            self.reports.lock().unwrap().push(error.to_owned());
        }
    }

    #[derive(Default)]
    struct RecordingAdminLookup {
        global: bool,
        channel: bool,
        global_error: Option<String>,
        channel_error: Option<String>,
        calls: Mutex<Vec<(&'static str, Vec<String>)>>,
    }
    impl DimafxAdminLookup for RecordingAdminLookup {
        async fn has_global_channel_owner_access(
            &self,
            _requester: &str,
            _channel: &str,
        ) -> Result<bool, DimafxPermissionError> {
            self.calls.lock().unwrap().push(("global", Vec::new()));
            match &self.global_error {
                Some(error) => Err(DimafxPermissionError(error.clone())),
                None => Ok(self.global),
            }
        }
        async fn has_channel_permission(
            &self,
            _channel: &str,
            _requester: &str,
            permissions: &[String],
        ) -> Result<bool, DimafxPermissionError> {
            self.calls
                .lock()
                .unwrap()
                .push(("channel", permissions.to_vec()));
            match &self.channel_error {
                Some(error) => Err(DimafxPermissionError(error.clone())),
                None => Ok(self.channel),
            }
        }
    }

    #[test]
    fn default_sku_map_matches_source() {
        let source = RecordingSkuSource::with_raw(None);
        let map = get_dimafx_sku_map(&source);
        assert_eq!(map.len(), 6);
        assert_eq!(map.sku_for(0.0).unwrap().as_str(), Some("free"));
        assert_eq!(
            map.sku_for(5.0).unwrap().as_str(),
            Some("dimafx_bits_5")
        );
        assert_eq!(
            map.bit_prices(),
            vec![0.0, 5.0, 10.0, 25.0, 50.0, 100.0]
        );
        assert!(source.reports.lock().unwrap().is_empty());
    }

    #[test]
    fn absent_and_empty_environment_use_defaults() {
        for raw in [None, Some("")] {
            let source = RecordingSkuSource::with_raw(raw);
            assert_eq!(get_dimafx_sku_map(&source).len(), 6);
            assert!(source.reports.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn invalid_json_uses_defaults_and_reports() {
        let source = RecordingSkuSource::with_raw(Some("{"));
        assert_eq!(get_dimafx_sku_map(&source).len(), 6);
        let reports = source.reports.lock().unwrap();
        assert_eq!(reports.len(), 1);
        assert!(reports[0].contains("Invalid JSON"));
    }

    #[test]
    fn null_json_uses_defaults_and_reports() {
        let source = RecordingSkuSource::with_raw(Some("null"));
        assert_eq!(get_dimafx_sku_map(&source).len(), 6);
        assert_eq!(source.reports.lock().unwrap().len(), 1);
    }

    #[test]
    fn primitive_json_follows_object_entries_coercion() {
        for raw in ["5", "true"] {
            let source = RecordingSkuSource::with_raw(Some(raw));
            assert_eq!(get_dimafx_sku_map(&source).len(), 6);
            assert!(source.reports.lock().unwrap().is_empty());
        }

        // Object.entries("ab") yields ["0","a"] and ["1","b"].
        let source = RecordingSkuSource::with_raw(Some("\"ab\""));
        let map = get_dimafx_sku_map(&source);
        assert_eq!(map.len(), 2);
        assert_eq!(map.sku_for(0.0).unwrap().as_str(), Some("a"));
        assert_eq!(map.sku_for(1.0).unwrap().as_str(), Some("b"));
        assert_eq!(map.bit_prices(), vec![0.0, 1.0]);
        assert!(source.reports.lock().unwrap().is_empty());
    }

    #[test]
    fn valid_entries_are_trimmed_and_normalized() {
        let source = RecordingSkuSource::with_raw(Some(
            r#"{"5.5":" half ","0x10":"hex","-0":"zero","1e3":"kilo","-1":"neg","20":"   ","abc":"bad","10":42}"#,
        ));
        let map = get_dimafx_sku_map(&source);
        assert_eq!(map.len(), 4);
        assert_eq!(map.bit_prices(), vec![0.0, 5.5, 16.0, 1000.0]);
        assert_eq!(map.sku_for(0.0).unwrap().as_str(), Some("zero"));
        assert_eq!(map.sku_for(5.5).unwrap().as_str(), Some("half"));
        assert_eq!(map.sku_for(16.0).unwrap().as_str(), Some("hex"));
        assert_eq!(map.sku_for(1000.0).unwrap().as_str(), Some("kilo"));
        assert_eq!(map.sku_for(-1.0), None);
        assert_eq!(map.sku_for(20.0), None);
        assert_eq!(map.sku_for(10.0), None);
    }

    #[test]
    fn duplicate_numeric_keys_follow_javascript_property_order() {
        // Integer-index keys enumerate first, then the remaining keys.
        let first = RecordingSkuSource::with_raw(Some(r#"{"5.0":"first","5":"second"}"#));
        assert_eq!(
            get_dimafx_sku_map(&first).sku_for(5.0).unwrap().as_str(),
            Some("first")
        );
        let second = RecordingSkuSource::with_raw(Some(r#"{"5":"first","5.0":"second"}"#));
        assert_eq!(
            get_dimafx_sku_map(&second).sku_for(5.0).unwrap().as_str(),
            Some("second")
        );
        let leading = RecordingSkuSource::with_raw(Some(r#"{"05":"leading","5":"plain"}"#));
        assert_eq!(
            get_dimafx_sku_map(&leading)
                .sku_for(5.0)
                .unwrap()
                .as_str(),
            Some("leading")
        );
    }

    #[test]
    fn sku_lookup_uses_javascript_number_string() {
        let source = RecordingSkuSource::with_raw(None);
        let map = get_dimafx_sku_map(&source);
        assert_eq!(map.sku_for(5.0).unwrap().as_str(), Some("dimafx_bits_5"));
        assert_eq!(map.sku_for(-0.0).unwrap().as_str(), Some("free"));
        assert_eq!(map.sku_for(5.5), None);
        assert_eq!(map.sku_for(f64::NAN), None);
        assert_eq!(map.sku_for(f64::INFINITY), None);
    }

    #[test]
    fn allowed_prices_are_numeric_ascending() {
        let source =
            RecordingSkuSource::with_raw(Some(r#"{"10":"a","2":"b","5.5":"c","0":"d"}"#));
        assert_eq!(
            get_allowed_dimafx_bit_prices(&source),
            vec![0.0, 2.0, 5.5, 10.0]
        );
    }

    #[test]
    fn purchase_action_normalization() {
        assert_eq!(
            normalize_dimafx_purchase_action("save"),
            QuickPurchaseAction::Save
        );
        assert_eq!(
            normalize_dimafx_purchase_action("use_now"),
            QuickPurchaseAction::UseNow
        );
        assert_eq!(
            normalize_dimafx_purchase_action("gift"),
            QuickPurchaseAction::UseNow
        );
        assert_eq!(
            normalize_dimafx_purchase_action_json(Some(&json("\"save\""))),
            QuickPurchaseAction::Save
        );
        assert_eq!(
            normalize_dimafx_purchase_action_json(Some(&json("true"))),
            QuickPurchaseAction::UseNow
        );
        assert_eq!(
            normalize_dimafx_purchase_action_json(None),
            QuickPurchaseAction::UseNow
        );
    }

    #[test]
    fn viewer_config_can_switch_back() {
        let current = crate::schemas::user_extension_inventory::IUserExtensionInventoryConfig {
            quick_purchase_priority: QuickPurchasePriority::BitsFirst,
            quick_purchase_action: QuickPurchaseAction::Save,
        };
        assert_eq!(
            normalize_dimafx_viewer_config(
                DimafxViewerConfigUpdate {
                    quick_purchase_priority: Some("credits_first"),
                    quick_purchase_action: Some("use_now"),
                },
                current,
            ),
            crate::schemas::user_extension_inventory::IUserExtensionInventoryConfig {
                quick_purchase_priority: QuickPurchasePriority::CreditsFirst,
                quick_purchase_action: QuickPurchaseAction::UseNow,
            }
        );
    }

    #[test]
    fn viewer_config_keeps_current_for_missing_or_invalid() {
        let current = crate::schemas::user_extension_inventory::IUserExtensionInventoryConfig {
            quick_purchase_priority: QuickPurchasePriority::BitsFirst,
            quick_purchase_action: QuickPurchaseAction::Save,
        };
        assert_eq!(
            normalize_dimafx_viewer_config(DimafxViewerConfigUpdate::default(), current),
            current
        );
        assert_eq!(
            normalize_dimafx_viewer_config(
                DimafxViewerConfigUpdate {
                    quick_purchase_priority: Some("cash"),
                    quick_purchase_action: Some("gift"),
                },
                current,
            ),
            current
        );
        assert_eq!(
            normalize_dimafx_viewer_config(
                DimafxViewerConfigUpdate {
                    quick_purchase_priority: Some("bits_first"),
                    quick_purchase_action: None,
                },
                crate::schemas::user_extension_inventory::DEFAULT_EXTENSION_INVENTORY_CONFIG,
            ),
            crate::schemas::user_extension_inventory::IUserExtensionInventoryConfig {
                quick_purchase_priority: QuickPurchasePriority::BitsFirst,
                quick_purchase_action: QuickPurchaseAction::UseNow,
            }
        );
    }

    #[test]
    fn viewer_config_json_reads_only_strings() {
        let current = crate::schemas::user_extension_inventory::IUserExtensionInventoryConfig {
            quick_purchase_priority: QuickPurchasePriority::CreditsFirst,
            quick_purchase_action: QuickPurchaseAction::Save,
        };
        assert_eq!(
            normalize_dimafx_viewer_config_json(
                Some(&json(
                    r#"{"quickPurchasePriority":"bits_first","quickPurchaseAction":5}"#
                )),
                current,
            ),
            crate::schemas::user_extension_inventory::IUserExtensionInventoryConfig {
                quick_purchase_priority: QuickPurchasePriority::BitsFirst,
                quick_purchase_action: QuickPurchaseAction::Save,
            }
        );
        assert_eq!(
            normalize_dimafx_viewer_config_json(Some(&json("[]")), current),
            current
        );
    }

    fn redeem_row(id: &str, quantity: f64, millis: i64) -> DimafxRedeemRow {
        DimafxRedeemRow {
            channel_extension_item_id: js(id),
            quantity,
            acquired_at: DimafxAcquiredAt::Date(date(millis)),
        }
    }

    #[test]
    fn redeem_candidate_prefers_newest() {
        let item_id = "507f1f77bcf86cd799439011";
        let other_id = "507f1f77bcf86cd799439012";
        let newest = redeem_row(item_id, 1.0, 1_788_868_800_000);
        let older = redeem_row(item_id, 2.0, 1_788_264_000_000);
        let empty = redeem_row(item_id, 0.0, 1_788_955_200_000);
        let other = redeem_row(other_id, 9.0, 1_789_041_600_000);
        let items = vec![empty, older, other, newest];
        assert_eq!(
            select_redeem_candidate(&items, item_id),
            Some(&items[3])
        );
        assert_eq!(select_redeem_candidate(&items[..2], item_id), Some(&items[1]));
    }

    #[test]
    fn redeem_candidate_ignores_empty_and_other_items() {
        let item_id = "507f1f77bcf86cd799439011";
        let items = vec![
            redeem_row(item_id, 0.0, 1_788_955_200_000),
            redeem_row("507f1f77bcf86cd799439012", 9.0, 1_789_041_600_000),
        ];
        assert_eq!(select_redeem_candidate(&items, item_id), None);
    }

    #[test]
    fn redeem_candidate_keeps_input_order_for_equal_dates() {
        let item_id = "507f1f77bcf86cd799439011";
        let items = vec![
            redeem_row(item_id, 1.0, 1_788_868_800_000),
            redeem_row(item_id, 1.0, 1_788_868_800_000),
        ];
        assert_eq!(select_redeem_candidate(&items, item_id), Some(&items[0]));
    }

    #[test]
    fn redeem_candidate_treats_invalid_dates_as_equal() {
        let item_id = "507f1f77bcf86cd799439011";
        let items = vec![
            DimafxRedeemRow {
                channel_extension_item_id: js(item_id),
                quantity: 1.0,
                acquired_at: DimafxAcquiredAt::Text(js("not a date")),
            },
            DimafxRedeemRow {
                channel_extension_item_id: js(item_id),
                quantity: 1.0,
                acquired_at: DimafxAcquiredAt::Text(js("also not a date")),
            },
        ];
        assert_eq!(select_redeem_candidate(&items, item_id), Some(&items[0]));
    }

    #[test]
    fn redeem_candidate_accepts_string_dates() {
        let item_id = "507f1f77bcf86cd799439011";
        let items = vec![
            DimafxRedeemRow {
                channel_extension_item_id: js(item_id),
                quantity: 1.0,
                acquired_at: DimafxAcquiredAt::Text(js("2026-09-01T12:00:00.000Z")),
            },
            DimafxRedeemRow {
                channel_extension_item_id: js(item_id),
                quantity: 1.0,
                acquired_at: DimafxAcquiredAt::Text(js("2026-09-08T12:00:00.000Z")),
            },
        ];
        assert_eq!(select_redeem_candidate(&items, item_id), Some(&items[1]));
    }

    #[test]
    fn redeem_candidate_accepts_inventory_items() {
        let item_id = "507f1f77bcf86cd799439011";
        let items = vec![IUserExtensionInventoryItem {
            channel_extension_item_id: ObjectId::parse_str(item_id).unwrap(),
            quantity: 1.0,
            purchase_price_bits: 5.0,
            acquired_at: date(1_788_868_800_000),
            source: InventoryItemSource::BitsPurchase,
        }];
        assert_eq!(select_redeem_candidate(&items, item_id), Some(&items[0]));
    }

    #[test]
    fn tts_config_null_and_absent() {
        assert_eq!(normalize_dimafx_tts_config(None), Ok(None));
        assert_eq!(
            normalize_dimafx_tts_config(Some(&JsonValue::Null)),
            Ok(None)
        );
    }

    #[test]
    fn tts_config_rejects_non_objects() {
        for value in [json("true"), json("5"), json("\"text\"")] {
            assert_eq!(
                normalize_dimafx_tts_config(Some(&value)),
                Err(TtsConfigError("Invalid TTS configuration"))
            );
        }
    }

    #[test]
    fn tts_config_array_is_empty_custom_config() {
        assert_eq!(
            normalize_dimafx_tts_config(Some(&json("[]"))),
            Ok(Some(ChannelExtensionItemTtsConfig {
                mode: ChannelExtensionItemTtsMode::Custom,
                text: js(""),
                voice: js(""),
                language: ChannelExtensionItemTtsLanguage::En,
            }))
        );
    }

    #[test]
    fn tts_config_fixed_requires_text() {
        for text in ["", "   ", "\\n\\t"] {
            let value = json(&format!(r#"{{"mode":"fixed","text":"{text}"}}"#));
            assert_eq!(
                normalize_dimafx_tts_config(Some(&value)),
                Err(TtsConfigError("Fixed TTS items require text"))
            );
        }
    }

    #[test]
    fn tts_config_collapses_javascript_whitespace() {
        let config = tts(r#"{"text":" \u00a0 Hello\u2028\u2029world \ufeff "}"#);
        assert_eq!(config.text.as_str(), Some("Hello world"));
    }

    #[test]
    fn tts_config_mode_and_language_fallbacks() {
        let config = tts(r#"{"mode":"weird","language":"fr","text":"hi"}"#);
        assert_eq!(config.mode, ChannelExtensionItemTtsMode::Custom);
        assert_eq!(config.language, ChannelExtensionItemTtsLanguage::En);
        let config = tts(r#"{"mode":"fixed","language":"es","text":"hola"}"#);
        assert_eq!(config.mode, ChannelExtensionItemTtsMode::Fixed);
        assert_eq!(config.language, ChannelExtensionItemTtsLanguage::Es);
    }

    #[test]
    fn tts_config_voice_is_trimmed_and_validated() {
        assert_eq!(
            tts(r#"{"voice":" en_US-ryan-medium "}"#).voice.as_str(),
            Some("en_US-ryan-medium")
        );
        assert_eq!(tts(r#"{"voice":5}"#).voice.as_str(), Some(""));
        assert_eq!(
            normalize_dimafx_tts_config(Some(&json(r#"{"voice":"../voice"}"#))),
            Err(TtsConfigError("Invalid TTS voice"))
        );
    }

    #[test]
    fn tts_config_text_limit_is_utf16() {
        let ascii = "a".repeat(DIMAFX_TTS_FIXED_TEXT_MAX);
        assert_eq!(
            tts(&format!(r#"{{"text":"{ascii}"}}"#)).text.len(),
            DIMAFX_TTS_FIXED_TEXT_MAX
        );
        let over = "a".repeat(DIMAFX_TTS_FIXED_TEXT_MAX + 1);
        assert_eq!(
            normalize_dimafx_tts_config(Some(&json(&format!(r#"{{"text":"{over}"}}"#)))),
            Err(TtsConfigError(
                "TTS text must be 500 characters or fewer"
            ))
        );

        let emoji = "\u{1f600}".repeat(250);
        assert_eq!(
            tts(&format!(r#"{{"text":"{emoji}"}}"#)).text.len(),
            DIMAFX_TTS_FIXED_TEXT_MAX
        );
        let emoji_over = "\u{1f600}".repeat(251);
        assert_eq!(
            normalize_dimafx_tts_config(Some(&json(&format!(
                r#"{{"text":"{emoji_over}"}}"#
            )))),
            Err(TtsConfigError(
                "TTS text must be 500 characters or fewer"
            ))
        );
    }

    #[test]
    fn tts_config_preserves_unpaired_surrogate_text() {
        let text = JsString::from_units(vec![0xd800, u16::from(b'x')]);
        let value = JsonValue::Object(vec![(
            js("text"),
            JsonValue::String(text.clone()),
        )]);
        let config = normalize_dimafx_tts_config(Some(&value))
            .expect("valid config")
            .expect("present config");
        assert_eq!(config.text, text);
        assert_eq!(config.text.len(), 2);
    }

    #[test]
    fn voice_pattern_boundaries() {
        let valid = format!("v{}", "a".repeat(119));
        assert!(is_valid_dimafx_tts_voice(&valid));
        let invalid = format!("v{}", "a".repeat(120));
        assert!(!is_valid_dimafx_tts_voice(&invalid));
        assert!(is_valid_dimafx_tts_voice(" en_US-ryan-medium "));
        assert!(!is_valid_dimafx_tts_voice(""));
        assert!(!is_valid_dimafx_tts_voice("_voice"));
        assert!(!is_valid_dimafx_tts_voice("-voice"));
        assert!(!is_valid_dimafx_tts_voice("voz_é"));
        assert!(!is_valid_dimafx_tts_voice_js(&JsString::from_units(vec![
            0xd800
        ])));
    }

    #[test]
    fn sanitize_non_string_is_empty() {
        assert_eq!(sanitize_dimafx_viewer_tts_text(None).as_str(), Some(""));
        assert_eq!(
            sanitize_dimafx_viewer_tts_text(Some(&json("5"))).as_str(),
            Some("")
        );
    }

    #[test]
    fn sanitize_strips_links_and_collapses() {
        assert_eq!(
            sanitize_dimafx_viewer_tts_text(Some(&json(
                "\"  Check https://example.com/a?b=1 now  \""
            )))
            .as_str(),
            Some("Check now")
        );
        assert_eq!(
            sanitize_dimafx_viewer_tts_text(Some(&json("\"www.example.com hi\""))).as_str(),
            Some("hi")
        );
    }

    #[test]
    fn sanitize_link_requires_nonspace_after_scheme() {
        for text in ["http://", "www.", "http:// x"] {
            assert_eq!(
                sanitize_dimafx_viewer_tts_text(Some(&JsonValue::String(js(text)))).as_str(),
                Some(text)
            );
        }
    }

    #[test]
    fn sanitize_links_are_case_insensitive() {
        assert_eq!(
            sanitize_dimafx_viewer_tts_text(Some(&json("\"HTTPS://EXAMPLE.COM\""))).as_str(),
            Some("")
        );
        assert_eq!(
            sanitize_dimafx_viewer_tts_text(Some(&json("\"WWW.Example.COM\""))).as_str(),
            Some("")
        );
    }

    #[test]
    fn sanitize_embedded_link_keeps_prefix() {
        assert_eq!(
            sanitize_dimafx_viewer_tts_text(Some(&json("\"xhttps://a\""))).as_str(),
            Some("x")
        );
        assert_eq!(
            sanitize_dimafx_viewer_tts_text(Some(&json("\"awww.b\""))).as_str(),
            Some("a")
        );
    }

    #[test]
    fn sanitize_slice_is_utf16_units() {
        let mut text = "a".repeat(DIMAFX_TTS_VIEWER_TEXT_MAX - 1);
        text.push('\u{1f600}');
        let result = sanitize_dimafx_viewer_tts_text(Some(&JsonValue::String(js(&text))));
        assert_eq!(result.len(), DIMAFX_TTS_VIEWER_TEXT_MAX);
        assert!(result.as_str().is_none());
        assert_eq!(result.units()[DIMAFX_TTS_VIEWER_TEXT_MAX - 1], 0xd83d);
    }

    #[test]
    fn sanitize_exact_limit_and_over() {
        let exact = "a".repeat(DIMAFX_TTS_VIEWER_TEXT_MAX);
        assert_eq!(
            sanitize_dimafx_viewer_tts_text_str(&exact).len(),
            DIMAFX_TTS_VIEWER_TEXT_MAX
        );
        let over = "a".repeat(DIMAFX_TTS_VIEWER_TEXT_MAX + 1);
        assert_eq!(
            sanitize_dimafx_viewer_tts_text_str(&over).len(),
            DIMAFX_TTS_VIEWER_TEXT_MAX
        );
    }

    #[test]
    fn permission_self_is_allowed_without_lookup() {
        let lookup = RecordingAdminLookup::default();
        assert!(run(has_dimafx_permission(&lookup, "same", "same", &[])).unwrap());
        assert!(lookup.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn permission_global_owner_is_allowed() {
        let lookup = RecordingAdminLookup {
            global: true,
            ..RecordingAdminLookup::default()
        };
        assert!(run(has_dimafx_permission(&lookup, "user", "channel", &[])).unwrap());
        let calls = lookup.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "global");
    }

    #[test]
    fn permission_channel_grant_checks_expected_permissions() {
        let lookup = RecordingAdminLookup {
            channel: true,
            ..RecordingAdminLookup::default()
        };
        let required = vec!["dimafx:items:write".to_owned()];
        assert!(run(has_dimafx_permission(&lookup, "user", "channel", &required)).unwrap());
        let calls = lookup.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[1].1,
            vec![
                "*".to_owned(),
                "dimafx:all".to_owned(),
                "dimafx:items:write".to_owned(),
            ]
        );
    }

    #[test]
    fn permission_denied_without_grant() {
        let lookup = RecordingAdminLookup::default();
        assert!(!run(has_dimafx_permission(&lookup, "user", "channel", &[])).unwrap());
    }

    #[test]
    fn permission_error_is_typed() {
        let lookup = RecordingAdminLookup {
            global_error: Some("database unavailable".to_owned()),
            ..RecordingAdminLookup::default()
        };
        assert_eq!(
            run(has_dimafx_permission(&lookup, "user", "channel", &[])),
            Err(DimafxPermissionError("database unavailable".to_owned()))
        );
    }

    #[test]
    fn service_uses_injected_adapters() {
        let admins = RecordingAdminLookup {
            channel: true,
            ..RecordingAdminLookup::default()
        };
        let source = RecordingSkuSource::with_raw(Some(r#"{"5":"custom"}"#));
        let service = DimafxService::with_adapters(admins, source);
        assert_eq!(
            service.sku_for_bits_price(5.0).unwrap().as_str(),
            Some("custom")
        );
        assert_eq!(service.allowed_bit_prices(), vec![5.0]);
        assert!(run(service.has_permission("user", "channel", &[])).unwrap());
    }

}

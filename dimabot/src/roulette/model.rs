//! Pure roulette value objects.
//!
//! Ports `dimabot/src/roulette/model.ts` and `model.test.ts`. Opaque ids are
//! UUID version-4 values with the hyphens removed so an AST token stays one
//! unquoted word. `fail`, `integer`, `object`, and `text` keep the source
//! error codes, status defaults, and message text, including the en dash in
//! the length message. Numbers use JavaScript `Number.isSafeInteger` bounds.
//! Completion and winner removal stay in one in-memory transition so the
//! service can persist them in the same compare-and-swap.

#![cfg(feature = "widgets-runtime")]

use crate::utils::js_string::JsString;
use crate::utils::lossless_json::JsonValue;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fmt;

/// `Number.MAX_SAFE_INTEGER`.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const ACTION_LIMIT: usize = 8000;

/// Domain failure. `status` defaults to 400, matching `new RouletteError`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouletteError {
    pub code: String,
    pub message: String,
    pub status: u16,
}

impl RouletteError {
    pub fn new(code: impl Into<String>, message: impl Into<String>, status: u16) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status,
        }
    }
}

impl fmt::Display for RouletteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for RouletteError {}

/// `fail(code, message, status = 400)`.
pub fn fail(code: &str, message: &str, status: u16) -> RouletteError {
    RouletteError::new(code, message, status)
}

/// Plain object. Arrays and null are rejected.
pub fn object(value: &JsonValue) -> Result<&Vec<(JsString, JsonValue)>, RouletteError> {
    match value {
        JsonValue::Object(fields) => Ok(fields),
        _ => Err(fail("invalid", "Expected an object", 400)),
    }
}

/// Trimmed text of 1..=`max` UTF-16 code units.
pub fn text(value: &JsonValue, field: &str, max: usize) -> Result<String, RouletteError> {
    let JsonValue::String(value) = value else {
        return Err(length_error(field, max));
    };
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > max {
        return Err(length_error(field, max));
    }
    trimmed
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| length_error(field, max))
}

fn length_error(field: &str, max: usize) -> RouletteError {
    fail(
        "invalid",
        &format!("{field} must contain 1–{max} characters"),
        400,
    )
}

/// Safe integer in `min..=max`. The default range is 1..=`MAX_SAFE_INTEGER`.
pub fn integer(value: &JsonValue, field: &str, min: i64, max: i64) -> Result<i64, RouletteError> {
    let JsonValue::Number(number) = value else {
        return Err(integer_error(field, min, max));
    };
    if !is_safe_integer(*number) || *number < min as f64 || *number > max as f64 {
        return Err(integer_error(field, min, max));
    }
    Ok(*number as i64)
}

fn integer_error(field: &str, min: i64, max: i64) -> RouletteError {
    fail(
        "invalid",
        &format!("{field} must be an integer between {min} and {max}"),
        400,
    )
}

pub fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER as f64
}

/// Item script text. Length is the raw string; the stored value is trimmed.
pub fn action_source(value: &JsonValue) -> Result<String, RouletteError> {
    let JsonValue::String(value) = value else {
        return Err(fail(
            "invalid",
            "Item action must be text up to 8000 characters",
            400,
        ));
    };
    if value.len() > ACTION_LIMIT {
        return Err(fail(
            "invalid",
            "Item action must be text up to 8000 characters",
            400,
        ));
    }
    value
        .trim()
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| fail("invalid", "Item action must be text up to 8000 characters", 400))
}

fn choice<T: Copy + PartialEq>(value: &JsonValue, allowed: &[(T, &str)], field: &str) -> Result<T, RouletteError> {
    let JsonValue::String(text) = value else {
        return Err(fail("invalid", &format!("Invalid {field}"), 400));
    };
    let Some(text) = text.as_str() else {
        return Err(fail("invalid", &format!("Invalid {field}"), 400));
    };
    allowed
        .iter()
        .find(|(_, name)| *name == text)
        .map(|(value, _)| *value)
        .ok_or_else(|| fail("invalid", &format!("Invalid {field}"), 400))
}

fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    value.get(key)
}

fn unknown(value: &JsonValue, allowed: &[&str]) -> bool {
    let JsonValue::Object(fields) = value else {
        return true;
    };
    fields.iter().any(|(key, _)| key.as_str().is_none_or(|key| !allowed.contains(&key)))
}

/// Rejection-sampled ticket in `0..total`, using 53 unbiased bits.
pub fn random_ticket(total: u64) -> Result<u64, RouletteError> {
    integer(
        &JsonValue::Number(total as f64),
        "total",
        1,
        MAX_SAFE_INTEGER,
    )?;
    let range = 1_u128 << 53;
    let total = u128::from(total);
    let limit = (range / total) * total;
    loop {
        let mut bytes = [0_u8; 7];
        getrandom::fill(&mut bytes).map_err(|_| {
            fail("unavailable", "Roulette random source is unavailable", 500)
        })?;
        let value = (u128::from(bytes[0] & 31) << 48)
            | u128::from(u64::from_be_bytes([
                0, 0, bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6],
            ]));
        if value < limit {
            return Ok((value % total) as u64);
        }
    }
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Insertion {
    Append,
    Random,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DuplicatePolicy {
    Separate,
    Increase,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum WinnerPolicy {
    #[serde(rename = "keep")]
    Keep,
    #[serde(rename = "remove-copy")]
    RemoveCopy,
    #[serde(rename = "remove-item")]
    RemoveItem,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Design {
    Wheel,
    Cards,
    Reel,
    Elimination,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CardSize {
    Large,
    Medium,
    Small,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub insertion: Insertion,
    pub duplicate: DuplicatePolicy,
    pub shuffle_before_draw: bool,
    pub show_on_start: bool,
    pub hide_after_seconds: Option<i64>,
    pub winner_action: WinnerPolicy,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            insertion: Insertion::Append,
            duplicate: DuplicatePolicy::Separate,
            shuffle_before_draw: false,
            show_on_start: true,
            hide_after_seconds: None,
            winner_action: WinnerPolicy::Keep,
        }
    }
}

/// Source `defaults`.
pub fn defaults() -> Settings {
    Settings::default()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub label: String,
    pub multiplier: i64,
    pub weight: i64,
    pub copies: Vec<String>,
    #[serde(default)]
    pub action: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Roulette {
    pub id: String,
    pub alias: String,
    pub name: String,
    pub design: Design,
    pub card_size: CardSize,
    pub colors: Vec<String>,
    pub duration_seconds: i64,
    pub settings: Settings,
    pub items: Vec<Item>,
    pub order: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Slot {
    pub key: String,
    pub item_id: String,
    pub label: String,
    pub weight: i64,
    pub copy: i64,
    pub multiplier: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draw {
    pub id: String,
    pub roulette_id: String,
    pub started_at: i64,
    pub ends_at: i64,
    pub completed_at: Option<i64>,
    pub winner: Slot,
    pub slots: Vec<Slot>,
    pub design: Design,
    pub card_size: CardSize,
    pub colors: Vec<String>,
    pub winner_action: WinnerPolicy,
    pub hide_after_seconds: Option<i64>,
}

/// History keeps every draw field except the visual `slots` array.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDraw {
    pub id: String,
    pub roulette_id: String,
    pub started_at: i64,
    pub ends_at: i64,
    pub completed_at: Option<i64>,
    pub winner: Slot,
    pub design: Design,
    pub card_size: CardSize,
    pub colors: Vec<String>,
    pub winner_action: WinnerPolicy,
    pub hide_after_seconds: Option<i64>,
}

impl From<&Draw> for HistoryDraw {
    fn from(draw: &Draw) -> Self {
        Self {
            id: draw.id.clone(),
            roulette_id: draw.roulette_id.clone(),
            started_at: draw.started_at,
            ends_at: draw.ends_at,
            completed_at: draw.completed_at,
            winner: draw.winner.clone(),
            design: draw.design,
            card_size: draw.card_size,
            colors: draw.colors.clone(),
            winner_action: draw.winner_action,
            hide_after_seconds: draw.hide_after_seconds,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub roulettes: Vec<Roulette>,
    pub active_id: Option<String>,
    pub visible: bool,
    pub draw: Option<Draw>,
    pub history: Vec<HistoryDraw>,
    pub hide_at: Option<i64>,
}

impl Default for State {
    fn default() -> Self {
        empty_state()
    }
}

pub fn empty_state() -> State {
    State {
        roulettes: Vec::new(),
        active_id: None,
        visible: false,
        draw: None,
        history: Vec::new(),
        hide_at: None,
    }
}

pub fn shuffle_with(
    order: &mut [String],
    mut random: impl FnMut(u64) -> Result<u64, RouletteError>,
) -> Result<(), RouletteError> {
    if order.len() < 2 {
        return Ok(());
    }
    let mut index = order.len() - 1;
    loop {
        let pick = random((index as u64) + 1)?;
        let pick = usize::try_from(pick).unwrap_or(index);
        let pick = pick.min(index);
        order.swap(index, pick);
        if index == 1 {
            break;
        }
        index -= 1;
    }
    Ok(())
}

pub fn shuffle(order: &mut [String]) -> Result<(), RouletteError> {
    shuffle_with(order, random_ticket)
}

/// Visual copies in wheel order. Item scripts are not copied onto slots.
pub fn slots(roulette: &Roulette) -> Vec<Slot> {
    let mut ordered = Vec::with_capacity(roulette.order.len());
    for key in &roulette.order {
        let Some(item) = roulette.items.iter().find(|item| item.copies.iter().any(|copy| copy == key)) else {
            continue;
        };
        let copy = item
            .copies
            .iter()
            .position(|copy| copy == key)
            .map(|index| index as i64 + 1)
            .unwrap_or(1);
        ordered.push(Slot {
            key: key.clone(),
            item_id: item.id.clone(),
            label: item.label.clone(),
            weight: item.weight,
            copy,
            multiplier: item.multiplier,
        });
    }
    ordered
}

pub fn capacity(roulette: &Roulette) -> i64 {
    match roulette.design {
        Design::Reel => 60,
        Design::Elimination => 100,
        Design::Cards => match roulette.card_size {
            CardSize::Large => 50,
            CardSize::Medium => 75,
            CardSize::Small => 100,
        },
        Design::Wheel => 10_000,
    }
}

pub fn validate(roulette: &Roulette) -> Result<(), RouletteError> {
    let count: i64 = roulette.items.iter().map(|item| item.multiplier).sum();
    let room = capacity(roulette);
    if count > room {
        return Err(fail(
            "capacity",
            &format!("This design supports {room} copies; requested {count}"),
            400,
        ));
    }
    let mut total = 0.0_f64;
    for item in &roulette.items {
        total += item.weight as f64 * item.multiplier as f64;
    }
    if !is_safe_integer(total) {
        return Err(fail(
            "weight",
            "Total weight exceeds the safe integer limit",
            400,
        ));
    }
    Ok(())
}

pub fn configure(roulette: &mut Roulette, data: &JsonValue) -> Result<(), RouletteError> {
    object(data)?;
    if unknown(
        data,
        &[
            "name",
            "alias",
            "design",
            "cardSize",
            "colors",
            "durationSeconds",
            "settings",
        ],
    ) {
        return Err(fail("invalid", "Unknown roulette setting", 400));
    }
    if let Some(name) = field(data, "name") {
        roulette.name = text(name, "name", 120)?;
    }
    if let Some(alias) = field(data, "alias") {
        roulette.alias = text(alias, "alias", 40)?;
        if !alias_ok(&roulette.alias) {
            return Err(fail(
                "invalid",
                "Alias must start with a lowercase letter and use letters, numbers, _ or -",
                400,
            ));
        }
    }
    if let Some(design) = field(data, "design") {
        roulette.design = choice(
            design,
            &[
                (Design::Wheel, "wheel"),
                (Design::Cards, "cards"),
                (Design::Reel, "reel"),
                (Design::Elimination, "elimination"),
            ],
            "design",
        )?;
    }
    if let Some(card_size) = field(data, "cardSize") {
        roulette.card_size = choice(
            card_size,
            &[
                (CardSize::Large, "large"),
                (CardSize::Medium, "medium"),
                (CardSize::Small, "small"),
            ],
            "cardSize",
        )?;
    }
    if let Some(duration) = field(data, "durationSeconds") {
        roulette.duration_seconds = integer(duration, "durationSeconds", 1, 120)?;
    }
    if let Some(colors) = field(data, "colors") {
        roulette.colors = parse_colors(colors)?;
    }
    if let Some(settings) = field(data, "settings") {
        apply_settings(&mut roulette.settings, settings)?;
    }
    validate(roulette)
}

fn alias_ok(alias: &str) -> bool {
    let mut chars = alias.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_lowercase()
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-')
}

fn parse_colors(value: &JsonValue) -> Result<Vec<String>, RouletteError> {
    let JsonValue::Array(colors) = value else {
        return Err(fail("invalid", "colors must contain 1–12 hex colors", 400));
    };
    if colors.is_empty() || colors.len() > 12 {
        return Err(fail("invalid", "colors must contain 1–12 hex colors", 400));
    }
    let mut out = Vec::with_capacity(colors.len());
    for color in colors {
        let JsonValue::String(color) = color else {
            return Err(fail("invalid", "colors must contain 1–12 hex colors", 400));
        };
        let Some(color) = color.as_str() else {
            return Err(fail("invalid", "colors must contain 1–12 hex colors", 400));
        };
        if !hex_color(color) {
            return Err(fail("invalid", "colors must contain 1–12 hex colors", 400));
        }
        out.push(color.to_owned());
    }
    Ok(out)
}

fn hex_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7
        && bytes[0] == b'#'
        && bytes[1..].iter().all(|byte| byte.is_ascii_hexdigit())
}

fn apply_settings(settings: &mut Settings, value: &JsonValue) -> Result<(), RouletteError> {
    object(value)?;
    if unknown(
        value,
        &[
            "insertion",
            "duplicate",
            "shuffleBeforeDraw",
            "showOnStart",
            "hideAfterSeconds",
            "winnerAction",
        ],
    ) {
        return Err(fail("invalid", "Unknown automation setting", 400));
    }
    if let Some(insertion) = field(value, "insertion") {
        settings.insertion = choice(
            insertion,
            &[(Insertion::Append, "append"), (Insertion::Random, "random")],
            "insertion",
        )?;
    }
    if let Some(duplicate) = field(value, "duplicate") {
        settings.duplicate = choice(
            duplicate,
            &[
                (DuplicatePolicy::Separate, "separate"),
                (DuplicatePolicy::Increase, "increase"),
            ],
            "duplicate",
        )?;
    }
    if let Some(action) = field(value, "winnerAction") {
        settings.winner_action = choice(
            action,
            &[
                (WinnerPolicy::Keep, "keep"),
                (WinnerPolicy::RemoveCopy, "remove-copy"),
                (WinnerPolicy::RemoveItem, "remove-item"),
            ],
            "winnerAction",
        )?;
    }
    for (key, slot) in [
        ("shuffleBeforeDraw", true),
        ("showOnStart", false),
    ] {
        if let Some(flag) = field(value, key) {
            let JsonValue::Bool(flag) = flag else {
                return Err(fail("invalid", &format!("{key} must be boolean"), 400));
            };
            if slot {
                settings.shuffle_before_draw = *flag;
            } else {
                settings.show_on_start = *flag;
            }
        }
    }
    if let Some(hide) = field(value, "hideAfterSeconds") {
        settings.hide_after_seconds = if matches!(hide, JsonValue::Null) {
            None
        } else {
            Some(integer(hide, "hideAfterSeconds", 1, 3600)?)
        };
    }
    Ok(())
}

pub fn create(data: &JsonValue) -> Result<Roulette, RouletteError> {
    let mut roulette = Roulette {
        id: new_id(),
        alias: String::new(),
        name: String::new(),
        design: Design::Wheel,
        card_size: CardSize::Large,
        colors: vec![
            "#cbbaff".to_owned(),
            "#f4c968".to_owned(),
            "#ec9baf".to_owned(),
            "#a5d5c2".to_owned(),
        ],
        duration_seconds: 4,
        settings: defaults(),
        items: Vec::new(),
        order: Vec::new(),
    };
    configure(&mut roulette, data)?;
    text(&JsonValue::String(JsString::from(roulette.name.as_str())), "name", 120)?;
    text(&JsonValue::String(JsString::from(roulette.alias.as_str())), "alias", 120)?;
    Ok(roulette)
}

pub fn find<'a>(state: &'a State, reference: Option<&str>) -> Result<&'a Roulette, RouletteError> {
    state
        .roulettes
        .iter()
        .find(|roulette| matches_reference(state, roulette, reference))
        .ok_or_else(|| fail("not_found", "Roulette not found in this channel", 404))
}

pub fn find_index(state: &State, reference: Option<&str>) -> Result<usize, RouletteError> {
    state
        .roulettes
        .iter()
        .position(|roulette| matches_reference(state, roulette, reference))
        .ok_or_else(|| fail("not_found", "Roulette not found in this channel", 404))
}

fn matches_reference(state: &State, roulette: &Roulette, reference: Option<&str>) -> bool {
    match reference {
        None => state.active_id.as_deref() == Some(roulette.id.as_str()),
        Some("") => {
            state.active_id.as_deref() == Some(roulette.id.as_str()) || roulette.alias.is_empty()
        }
        Some(reference) => roulette.id == reference || roulette.alias == reference,
    }
}

pub fn add(roulette: &mut Roulette, data: &JsonValue) -> Result<Item, RouletteError> {
    add_with(roulette, data, random_ticket)
}

pub fn add_with(
    roulette: &mut Roulette,
    data: &JsonValue,
    mut random: impl FnMut(u64) -> Result<u64, RouletteError>,
) -> Result<Item, RouletteError> {
    object(data)?;
    if unknown(data, &["label", "multiplier", "weight", "action"]) {
        return Err(fail("invalid", "Unknown item field", 400));
    }
    let label = text(field(data, "label").unwrap_or(&JsonValue::Null), "label", 120)?;
    let multiplier = match field(data, "multiplier") {
        None => 1,
        Some(value) => integer(value, "multiplier", 1, 10_000)?,
    };
    let weight = match field(data, "weight") {
        None => 1,
        Some(value) => integer(value, "weight", 1, MAX_SAFE_INTEGER)?,
    };
    let action = match field(data, "action") {
        None => None,
        Some(value) => Some(action_source(value)?),
    };
    let existing = if roulette.settings.duplicate == DuplicatePolicy::Increase {
        roulette.items.iter().position(|item| item.label == label)
    } else {
        None
    };
    if let Some(index) = existing {
        if roulette.items[index].weight != weight {
            return Err(fail(
                "weight_conflict",
                "Existing item has a different weight; update it explicitly",
                409,
            ));
        }
        if let Some(action) = &action
            && roulette.items[index].action != *action
        {
            return Err(fail(
                "action_conflict",
                "Existing item has a different action; edit it explicitly",
                409,
            ));
        }
        roulette.items[index].multiplier += multiplier;
    } else {
        roulette.items.push(Item {
            id: new_id(),
            label,
            multiplier,
            weight,
            copies: Vec::new(),
            action: action.unwrap_or_default(),
        });
    }
    validate(roulette)?;
    let index = existing.unwrap_or(roulette.items.len() - 1);
    for _ in 0..multiplier {
        let key = new_id();
        roulette.items[index].copies.push(key.clone());
        let at = if roulette.settings.insertion == Insertion::Random {
            random(roulette.order.len() as u64 + 1)? as usize
        } else {
            roulette.order.len()
        };
        let at = at.min(roulette.order.len());
        roulette.order.insert(at, key);
    }
    Ok(roulette.items[index].clone())
}

pub fn remove(roulette: &mut Roulette, item_id: &str) -> Result<(), RouletteError> {
    let item = roulette
        .items
        .iter()
        .find(|item| item.id == item_id)
        .ok_or_else(|| fail("not_found", "Item not found", 404))?
        .clone();
    let keys: HashSet<&str> = item.copies.iter().map(String::as_str).collect();
    roulette.order.retain(|key| !keys.contains(key.as_str()));
    roulette.items.retain(|item| item.id != item_id);
    Ok(())
}

pub fn update_item(roulette: &mut Roulette, item_id: &str, data: &JsonValue) -> Result<Item, RouletteError> {
    update_item_with(roulette, item_id, data, random_ticket)
}

pub fn update_item_with(
    roulette: &mut Roulette,
    item_id: &str,
    data: &JsonValue,
    mut random: impl FnMut(u64) -> Result<u64, RouletteError>,
) -> Result<Item, RouletteError> {
    object(data)?;
    if unknown(data, &["label", "multiplier", "weight", "action"]) {
        return Err(fail("invalid", "Unknown item field", 400));
    }
    let index = roulette
        .items
        .iter()
        .position(|item| item.id == item_id)
        .ok_or_else(|| fail("not_found", "Item not found", 404))?;
    if let Some(action) = field(data, "action") {
        roulette.items[index].action = action_source(action)?;
    }
    if let Some(label) = field(data, "label") {
        roulette.items[index].label = text(label, "label", 120)?;
    }
    if let Some(weight) = field(data, "weight") {
        roulette.items[index].weight = integer(weight, "weight", 1, MAX_SAFE_INTEGER)?;
    }
    if let Some(multiplier) = field(data, "multiplier") {
        roulette.items[index].multiplier = integer(multiplier, "multiplier", 1, 10_000)?;
    }
    validate(roulette)?;
    let multiplier = roulette.items[index].multiplier as usize;
    // `copies.slice(0, multiplier)`, then drop the discarded keys from the wheel.
    if roulette.items[index].copies.len() > multiplier {
        let removed: HashSet<String> = roulette.items[index].copies.split_off(multiplier).into_iter().collect();
        roulette.order.retain(|key| !removed.contains(key));
    }
    while roulette.items[index].copies.len() < multiplier {
        let key = new_id();
        roulette.items[index].copies.push(key.clone());
        let at = if roulette.settings.insertion == Insertion::Random {
            random(roulette.order.len() as u64 + 1)? as usize
        } else {
            roulette.order.len()
        };
        roulette.order.insert(at.min(roulette.order.len()), key);
    }
    Ok(roulette.items[index].clone())
}

pub fn idle(state: &State) -> Result<(), RouletteError> {
    if state.draw.as_ref().is_some_and(|draw| draw.completed_at.is_none()) {
        return Err(fail("spinning", "Roulette is spinning", 409));
    }
    Ok(())
}

pub fn start(
    state: &mut State,
    index: usize,
    now: i64,
) -> Result<Draw, RouletteError> {
    start_with(state, index, now, random_ticket)
}

pub fn start_with(
    state: &mut State,
    index: usize,
    now: i64,
    mut random: impl FnMut(u64) -> Result<u64, RouletteError>,
) -> Result<Draw, RouletteError> {
    idle(state)?;
    let roulette = state
        .roulettes
        .get_mut(index)
        .ok_or_else(|| fail("not_found", "Roulette not found in this channel", 404))?;
    validate(roulette)?;
    if roulette.order.is_empty() {
        return Err(fail("empty", "Add an item before starting", 409));
    }
    if roulette.settings.shuffle_before_draw {
        shuffle_with(&mut roulette.order, &mut random)?;
    }
    let copies = slots(roulette);
    let total: i64 = copies.iter().map(|slot| slot.weight).sum();
    if total < 1 {
        return Err(fail("empty", "Add an item before starting", 409));
    }
    let mut ticket = i64::try_from(random(total as u64)?).unwrap_or(total);
    let winner = copies
        .iter()
        .find(|slot| {
            if ticket < slot.weight {
                true
            } else {
                ticket -= slot.weight;
                false
            }
        })
        .cloned()
        .ok_or_else(|| fail("invalid", "Draw ticket missed every slot", 400))?;
    let draw = Draw {
        id: new_id(),
        roulette_id: roulette.id.clone(),
        started_at: now,
        ends_at: now + roulette.duration_seconds * 1000,
        completed_at: None,
        winner,
        slots: copies,
        design: roulette.design,
        card_size: roulette.card_size,
        colors: roulette.colors.clone(),
        winner_action: roulette.settings.winner_action,
        hide_after_seconds: roulette.settings.hide_after_seconds,
    };
    let show = roulette.settings.show_on_start;
    let id = roulette.id.clone();
    state.active_id = Some(id);
    if show {
        state.visible = true;
    }
    state.hide_at = None;
    state.draw = Some(draw.clone());
    Ok(draw)
}

/// Completion and winner removal are one transition. Returns whether state changed.
pub fn settle(state: &mut State, now: i64) -> bool {
    let mut changed = false;
    let ready = state
        .draw
        .as_ref()
        .is_some_and(|draw| draw.completed_at.is_none() && now >= draw.ends_at);
    if ready {
        let snapshot = {
            let Some(draw) = state.draw.as_mut() else {
                return false;
            };
            draw.completed_at = Some(draw.ends_at);
            draw.clone()
        };
        let ends_at = snapshot.ends_at;
        let hide_after = snapshot.hide_after_seconds;
        let winner_action = snapshot.winner_action;
        let winner_key = snapshot.winner.key.clone();
        let winner_item = snapshot.winner.item_id.clone();
        let roulette_id = snapshot.roulette_id.clone();
        let history = HistoryDraw::from(&snapshot);
        if let Some(roulette) = state.roulettes.iter_mut().find(|roulette| roulette.id == roulette_id) {
            let item_exists = roulette.items.iter().any(|item| item.id == winner_item);
            if item_exists && winner_action == WinnerPolicy::RemoveItem {
                let _ = remove(roulette, &winner_item);
            } else if item_exists && winner_action == WinnerPolicy::RemoveCopy {
                if let Some(item) = roulette.items.iter_mut().find(|item| item.id == winner_item)
                    && item.copies.iter().any(|key| key == &winner_key)
                {
                    item.copies.retain(|key| key != &winner_key);
                    item.multiplier = item.copies.len() as i64;
                    let empty = item.multiplier == 0;
                    let item_id = item.id.clone();
                    roulette.order.retain(|key| key != &winner_key);
                    if empty {
                        roulette.items.retain(|item| item.id != item_id);
                    }
                }
            }
        }
        state.history.insert(0, history);
        state.history.truncate(100);
        state.hide_at = hide_after.map(|seconds| ends_at + seconds * 1000);
        changed = true;
    }
    if state.hide_at.is_some_and(|hide_at| now >= hide_at) {
        state.visible = false;
        state.hide_at = None;
        changed = true;
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(value: &str) -> JsonValue {
        JsonValue::String(JsString::from(value))
    }
    fn n(value: f64) -> JsonValue {
        JsonValue::Number(value)
    }
    fn obj(fields: Vec<(&str, JsonValue)>) -> JsonValue {
        JsonValue::Object(
            fields
                .into_iter()
                .map(|(key, value)| (JsString::from(key), value))
                .collect(),
        )
    }
    fn fixture() -> State {
        let mut state = empty_state();
        let roulette = create(&obj(vec![
            ("name", s("Giveaway")),
            ("alias", s("giveaways")),
            ("design", s("reel")),
        ]))
        .expect("roulette");
        state.roulettes.push(roulette);
        state.active_id = Some(state.roulettes[0].id.clone());
        add(
            &mut state.roulettes[0],
            &obj(vec![
                ("label", s("VIP")),
                ("multiplier", n(3.0)),
                ("weight", n(10.0)),
            ]),
        )
        .expect("vip");
        add(
            &mut state.roulettes[0],
            &obj(vec![("label", s("Game")), ("weight", n(1.0))]),
        )
        .expect("game");
        state
    }

    #[test]
    fn copies_have_stable_identities_and_weight_does_not_rebuild_them() {
        let state = fixture();
        let copies = slots(&state.roulettes[0]);
        assert_eq!(copies.len(), 4);
        assert_eq!(
            copies.iter().map(|slot| slot.key.as_str()).collect::<HashSet<_>>().len(),
            4
        );
        let mut counts = [0_u32; 4];
        for ticket in 0..31 {
            let mut fresh = state.clone();
            let draw = start_with(&mut fresh, 0, 0, |_| Ok(ticket)).expect("draw");
            let index = copies.iter().position(|slot| slot.key == draw.winner.key).expect("key");
            counts[index] += 1;
        }
        assert_eq!(counts, [10, 10, 10, 1]);
        let mut roulette = state.roulettes[0].clone();
        let order = roulette.order.clone();
        update_item(
            &mut roulette,
            &roulette.items[0].id.clone(),
            &obj(vec![("weight", n(20.0))]),
        )
        .expect("weight");
        assert_eq!(roulette.order, order);
    }

    #[test]
    fn shuffle_and_random_insertion_preserve_copies() {
        let mut state = fixture();
        let original = state.roulettes[0].order.clone();
        shuffle_with(&mut state.roulettes[0].order, |_| Ok(0)).expect("shuffle");
        assert_ne!(state.roulettes[0].order, original);
        let mut sorted_now = state.roulettes[0].order.clone();
        let mut sorted_was = original.clone();
        sorted_now.sort();
        sorted_was.sort();
        assert_eq!(sorted_now, sorted_was);
        let survivors = state.roulettes[0].order.clone();
        state.roulettes[0].settings.insertion = Insertion::Random;
        let item = add_with(
            &mut state.roulettes[0],
            &obj(vec![("label", s("New")), ("multiplier", n(3.0))]),
            |_| Ok(0),
        )
        .expect("insert");
        let kept: Vec<_> = state.roulettes[0]
            .order
            .iter()
            .filter(|key| !item.copies.iter().any(|copy| copy == *key))
            .cloned()
            .collect();
        assert_eq!(kept, survivors);
        assert_eq!(state.roulettes[0].order.len(), 7);
    }

    #[test]
    fn frozen_draw_removes_one_winning_copy_and_hides_later() {
        let mut state = fixture();
        state.roulettes[0].settings.winner_action = WinnerPolicy::RemoveCopy;
        state.roulettes[0].settings.hide_after_seconds = Some(2);
        let draw = start_with(&mut state, 0, 1000, |_| Ok(10)).expect("draw");
        let winner = draw.winner.key.clone();
        let item_id = state.roulettes[0].items[0].id.clone();
        update_item(
            &mut state.roulettes[0],
            &item_id,
            &obj(vec![("multiplier", n(4.0)), ("weight", n(20.0))]),
        )
        .expect("edit");
        let frozen = state.draw.as_ref().expect("draw");
        assert_eq!(frozen.slots.len(), 4);
        assert_eq!(frozen.winner.weight, 10);
        assert_eq!(start(&mut state, 0, 1100).unwrap_err().code, "spinning");
        assert!(!settle(&mut state, 4999));
        assert!(settle(&mut state, 5000));
        assert_eq!(state.roulettes[0].items[0].multiplier, 3);
        assert!(!state.roulettes[0].order.iter().any(|key| key == &winner));
        assert_eq!(state.history.len(), 1);
        assert!(!settle(&mut state, 5001));
        assert!(state.visible);
        settle(&mut state, 7000);
        assert!(!state.visible);
        assert_eq!(state.history.len(), 1);
    }

    #[test]
    fn winner_removal_tolerates_a_deleted_item() {
        let mut state = fixture();
        state.roulettes[0].settings.winner_action = WinnerPolicy::RemoveItem;
        let draw = start_with(&mut state, 0, 0, |_| Ok(0)).expect("draw");
        remove(&mut state.roulettes[0], &draw.winner.item_id).expect("remove");
        settle(&mut state, 4000);
        assert_eq!(state.history[0].winner.label, "VIP");
        assert_eq!(state.roulettes[0].items.len(), 1);
    }

    #[test]
    fn limits_aliases_and_design_capacity_are_rejected() {
        for multiplier in [0.0, -1.0, 1.5, f64::INFINITY, 10001.0] {
            let error = add(
                &mut fixture().roulettes[0],
                &obj(vec![("label", s("Bad")), ("multiplier", n(multiplier))]),
            )
            .unwrap_err();
            assert_eq!(error.code, "invalid");
        }
        assert_eq!(
            add(
                &mut fixture().roulettes[0],
                &obj(vec![
                    ("label", s("Big")),
                    ("weight", n(MAX_SAFE_INTEGER as f64))
                ]),
            )
            .unwrap_err()
            .code,
            "weight"
        );
        assert_eq!(
            add(
                &mut fixture().roulettes[0],
                &obj(vec![("label", s("Big")), ("multiplier", n(57.0))]),
            )
            .unwrap_err()
            .code,
            "capacity"
        );
        assert_eq!(
            create(&obj(vec![("name", s("A")), ("alias", s("bad alias"))]))
                .unwrap_err()
                .code,
            "invalid"
        );
        let error = configure(
            &mut fixture().roulettes[0],
            &obj(vec![(
                "settings",
                obj(vec![("showOnStart", s("false"))]),
            )]),
        )
        .unwrap_err();
        assert_eq!(error.code, "invalid");
        let mut wheel = create(&obj(vec![("name", s("Wheel")), ("alias", s("wheel"))])).expect("wheel");
        add(&mut wheel, &obj(vec![("label", s("A")), ("multiplier", n(61.0))])).expect("copies");
        assert_eq!(
            configure(&mut wheel, &obj(vec![("design", s("reel"))]))
                .unwrap_err()
                .code,
            "capacity"
        );
    }

    #[test]
    fn duplicate_merging_rejects_a_different_weight() {
        let mut state = fixture();
        state.roulettes[0].settings.duplicate = DuplicatePolicy::Increase;
        let id = state.roulettes[0].items[0].id.clone();
        let item = add(
            &mut state.roulettes[0],
            &obj(vec![
                ("label", s("VIP")),
                ("multiplier", n(2.0)),
                ("weight", n(10.0)),
            ]),
        )
        .expect("merge");
        assert_eq!(item.id, id);
        assert_eq!(item.multiplier, 5);
        assert_eq!(
            add(
                &mut state.roulettes[0],
                &obj(vec![("label", s("VIP")), ("weight", n(2.0))]),
            )
            .unwrap_err()
            .code,
            "weight_conflict"
        );
    }

    #[test]
    fn item_scripts_are_bounded_and_absent_from_slots() {
        let mut state = fixture();
        let item = add(
            &mut state.roulettes[0],
            &obj(vec![
                ("label", s("Silence")),
                ("multiplier", n(3.0)),
                ("action", s("$(timer 300 Done)")),
            ]),
        )
        .expect("script");
        assert_eq!(item.action, "$(timer 300 Done)");
        assert!(slots(&state.roulettes[0]).iter().all(|slot| slot.label != "action"));
        update_item(
            &mut state.roulettes[0],
            &item.id,
            &obj(vec![("action", s(""))]),
        )
        .expect("clear");
        assert_eq!(
            state.roulettes[0]
                .items
                .iter()
                .find(|entry| entry.id == item.id)
                .unwrap()
                .action,
            ""
        );
        assert!(
            update_item(
                &mut state.roulettes[0],
                &item.id,
                &obj(vec![("action", s(&"a".repeat(8001)))]),
            )
            .is_err()
        );
        assert_eq!(
            update_item(&mut state.roulettes[0], &item.id, &obj(vec![("action", n(5.0))]))
                .unwrap_err()
                .code,
            "invalid"
        );
        state.roulettes[0].settings.duplicate = DuplicatePolicy::Increase;
        update_item(
            &mut state.roulettes[0],
            &item.id,
            &obj(vec![("action", s("$(timer 30 Done)"))]),
        )
        .expect("rewrite");
        assert_eq!(
            add(
                &mut state.roulettes[0],
                &obj(vec![("label", s("Silence")), ("action", s("different"))]),
            )
            .unwrap_err()
            .code,
            "action_conflict"
        );
        add(&mut state.roulettes[0], &obj(vec![("label", s("Silence"))])).expect("keep");
        assert_eq!(
            state.roulettes[0]
                .items
                .iter()
                .find(|entry| entry.id == item.id)
                .unwrap()
                .action,
            "$(timer 30 Done)"
        );
    }

    #[test]
    fn elimination_holds_one_hundred_copies_and_rejects_other_designs() {
        let mut roulette =
            create(&obj(vec![("name", s("Royale")), ("alias", s("royale"))])).expect("create");
        configure(&mut roulette, &obj(vec![("design", s("elimination"))])).expect("design");
        assert_eq!(roulette.design, Design::Elimination);
        add(
            &mut roulette,
            &obj(vec![("label", s("Viewer")), ("multiplier", n(100.0))]),
        )
        .expect("full");
        assert_eq!(
            add(&mut roulette, &obj(vec![("label", s("One more"))]))
                .unwrap_err()
                .code,
            "capacity"
        );
        assert!(configure(&mut roulette, &obj(vec![("design", s("reel"))])).is_err());
        assert_eq!(
            configure(&mut roulette, &obj(vec![("design", s("plinko"))]))
                .unwrap_err()
                .code,
            "invalid"
        );
    }
}

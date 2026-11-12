//! `roulette/model.ts`: a channel's roulettes, their items and copies, the draw and its
//! completion, as pure functions over [`State`].
//!
//! The state is the Mixed `state` field of `roulette_channels`. It is read into these types and
//! written back whole, as the reference does (it reads the document as plain objects and
//! `$set`s `state`); numbers are JavaScript numbers (`f64`) and are stored as the Node driver
//! stores them ([`State::to_bson`]: int32 when integral and in range, double otherwise). Key
//! order is the order the reference creates each object in.
//!
//! Randomness is injected ([`dima_core::Random`]): ids are `randomUUID()` without hyphens
//! (`newId`), draws are [`dima_core::Random::ticket`] (`randomTicket`: 7 random bytes, 53 bits,
//! rejection above the largest multiple). Given the same bytes, the same ids and the same
//! winner come out, in the same order of draws (the recordings check it).

use std::collections::{HashMap, HashSet};

use bson::{Bson, Document};
use dima_core::Random;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::input::{
    MAX_SAFE_INTEGER, RouletteError, action_source, choice, integer, object, text, text_str,
};

/// Saved roulettes per channel.
pub const MAX_ROULETTES: usize = 20;
/// `IMPORT_LIMIT`: rows per import.
pub const IMPORT_LIMIT: usize = 10_000;
/// Completed draws kept in the history.
pub const HISTORY_LIMIT: usize = 100;

/// `Settings`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// `append` | `random`: where new copies go in the order.
    pub insertion: String,
    /// `separate` | `increase`: whether a repeated label joins the existing item.
    pub duplicate: String,
    /// Shuffle the order before each draw.
    pub shuffle_before_draw: bool,
    /// Show the overlay when a draw starts.
    pub show_on_start: bool,
    /// Hide the overlay this long after a draw ends; `null` keeps it.
    pub hide_after_seconds: Option<f64>,
    /// `keep` | `remove-copy` | `remove-item`.
    pub winner_action: String,
}

impl Default for Settings {
    /// `defaults`.
    fn default() -> Self {
        Self {
            insertion: "append".into(),
            duplicate: "separate".into(),
            shuffle_before_draw: false,
            show_on_start: true,
            hide_after_seconds: None,
            winner_action: "keep".into(),
        }
    }
}

/// `Item`: one prize with `multiplier` copies, each copy drawn with `weight`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Item {
    /// `id`.
    pub id: String,
    /// `label`.
    pub label: String,
    /// `multiplier`: the number of copies.
    pub multiplier: f64,
    /// `weight` of each copy.
    pub weight: f64,
    /// The copy keys.
    pub copies: Vec<String>,
    /// The winner action (command language); absent on items saved before actions existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
}

/// `Roulette`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Roulette {
    /// `id`.
    pub id: String,
    /// `alias` (`^[a-z][a-z0-9_-]*$`, unique in the channel).
    pub alias: String,
    /// `name`.
    pub name: String,
    /// `wheel` | `cards` | `reel` | `elimination`.
    pub design: String,
    /// `large` | `medium` | `small`.
    pub card_size: String,
    /// 1 to 12 hex colors.
    pub colors: Vec<String>,
    /// Spin time, 1 to 120 seconds.
    pub duration_seconds: f64,
    /// Automation.
    pub settings: Settings,
    /// Prizes.
    pub items: Vec<Item>,
    /// Copy keys in display order.
    pub order: Vec<String>,
}

/// `Slot`: one copy as the draw shows it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Slot {
    /// The copy key.
    pub key: String,
    /// Its item.
    pub item_id: String,
    /// The item's label.
    pub label: String,
    /// The item's weight.
    pub weight: f64,
    /// 1-based copy number.
    pub copy: f64,
    /// The item's multiplier.
    pub multiplier: f64,
}

/// `Draw` (with `slots`), or a history entry (`Omit<Draw, 'slots'>`: `slots` is `None`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draw {
    /// `id`.
    pub id: String,
    /// The roulette drawn.
    pub roulette_id: String,
    /// Epoch ms.
    pub started_at: f64,
    /// Epoch ms when the spin ends and the draw is due.
    pub ends_at: f64,
    /// `endsAt` once completed; `null` while spinning.
    pub completed_at: Option<f64>,
    /// The winning copy.
    pub winner: Slot,
    /// Every copy, in order (not in history entries).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slots: Option<Vec<Slot>>,
    /// Frozen from the roulette at the start.
    pub design: String,
    /// Frozen.
    pub card_size: String,
    /// Frozen.
    pub colors: Vec<String>,
    /// Frozen.
    pub winner_action: String,
    /// Frozen.
    pub hide_after_seconds: Option<f64>,
}

/// `State`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// Saved roulettes.
    pub roulettes: Vec<Roulette>,
    /// The active roulette.
    pub active_id: Option<String>,
    /// Whether the overlay shows.
    pub visible: bool,
    /// The current or last draw.
    pub draw: Option<Draw>,
    /// Completed draws, newest first, without slots.
    pub history: Vec<Draw>,
    /// When the overlay hides itself.
    pub hide_at: Option<f64>,
}

impl Default for State {
    /// `emptyState()`.
    fn default() -> Self {
        Self {
            roulettes: Vec::new(),
            active_id: None,
            visible: false,
            draw: None,
            history: Vec::new(),
            hide_at: None,
        }
    }
}

impl State {
    /// Reads a stored state.
    pub fn from_bson(value: &Bson) -> Result<Self, bson::error::Error> {
        bson::deserialize_from_bson(value.clone())
    }

    /// The state as the Node driver stores the JavaScript object.
    pub fn to_bson(&self) -> Result<Document, bson::error::Error> {
        let mut document = bson::serialize_to_document(self)?;
        dima_store::mongo::number::normalize_js_numbers(&mut document);
        Ok(document)
    }

    /// The state as JSON (the snapshot's fields).
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    /// `due(state)`: a spinning draw is due at its end, otherwise the hide deadline.
    pub fn due(&self) -> Option<f64> {
        match &self.draw {
            Some(draw) if draw.completed_at.is_none() => Some(draw.ends_at),
            _ => self.hide_at,
        }
    }
}

fn random_error(error: dima_core::RandomError) -> RouletteError {
    RouletteError::new("internal", format!("randomness unavailable: {error}"), 500)
}

/// `newId()`: `randomUUID()` without hyphens.
pub fn new_id(random: &dyn Random) -> Result<String, RouletteError> {
    Ok(random.uuid_v4().map_err(random_error)?.replace('-', ""))
}

/// `randomTicket(total)`: a uniform integer in `[0, total)`.
pub fn random_ticket(random: &dyn Random, total: f64) -> Result<usize, RouletteError> {
    let total = super::input::integer_number(Some(total), "total", 1, MAX_SAFE_INTEGER)?;
    let ticket = random.ticket(total as u64).map_err(random_error)?;
    Ok(usize::try_from(ticket).unwrap_or(usize::MAX))
}

/// `shuffle(order)`: Fisher–Yates with [`random_ticket`].
pub fn shuffle(order: &mut [String], random: &dyn Random) -> Result<(), RouletteError> {
    for i in (1..order.len()).rev() {
        let j = random_ticket(random, (i + 1) as f64)?;
        order.swap(i, j.min(i));
    }
    Ok(())
}

/// `slots(roulette)`: every copy in display order. An order key with no copy (no writer leaves
/// one) is left out, where the reference would put `undefined` there.
pub fn slots(roulette: &Roulette) -> Vec<Slot> {
    let mut by_key: HashMap<&str, Slot> = HashMap::new();
    for item in &roulette.items {
        for (index, key) in item.copies.iter().enumerate() {
            by_key.insert(
                key,
                Slot {
                    key: key.clone(),
                    item_id: item.id.clone(),
                    label: item.label.clone(),
                    weight: item.weight,
                    copy: (index + 1) as f64,
                    multiplier: item.multiplier,
                },
            );
        }
    }
    roulette
        .order
        .iter()
        .filter_map(|key| by_key.get(key.as_str()).cloned())
        .collect()
}

/// `capacity(roulette)`: copies the design shows.
pub fn capacity(roulette: &Roulette) -> f64 {
    match (roulette.design.as_str(), roulette.card_size.as_str()) {
        ("reel", _) => 60.0,
        ("elimination", _) => 100.0,
        ("cards", "large") => 50.0,
        ("cards", "medium") => 75.0,
        ("cards", "small") => 100.0,
        // `{…}[unknown]` is undefined, and `count > undefined` is false.
        ("cards", _) => f64::INFINITY,
        _ => 10_000.0,
    }
}

fn is_safe_integer(n: f64) -> bool {
    n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER as f64
}

fn capacity_error(roulette: &Roulette, requested: f64) -> RouletteError {
    RouletteError::invalid_code(
        "capacity",
        format!(
            "This design supports {} copies; requested {}",
            dima_text::number_to_string(capacity(roulette)),
            dima_text::number_to_string(requested)
        ),
    )
}

fn weight_error() -> RouletteError {
    RouletteError::invalid_code("weight", "Total weight exceeds the safe integer limit")
}

impl RouletteError {
    fn invalid_code(code: &str, message: impl Into<String>) -> Self {
        Self::new(code, message, 400)
    }
}

/// `validate(roulette)`: copies within the design's capacity, total weight a safe integer
/// (computed in doubles, as JavaScript does).
pub fn validate(roulette: &Roulette) -> Result<(), RouletteError> {
    let count: f64 = roulette.items.iter().map(|i| i.multiplier).sum();
    if count > capacity(roulette) {
        return Err(capacity_error(roulette, count));
    }
    let total = roulette
        .items
        .iter()
        .fold(0.0, |n, i| n + i.weight * i.multiplier);
    if !is_safe_integer(total) {
        return Err(weight_error());
    }
    Ok(())
}

fn is_alias(alias: &str) -> bool {
    let mut chars = alias.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn is_hex_color(value: &Value) -> bool {
    value.as_str().is_some_and(|c| {
        c.len() == 7 && c.starts_with('#') && c.bytes().skip(1).all(|b| b.is_ascii_hexdigit())
    })
}

/// `configure(roulette, data)`: the known settings, each checked; then [`validate`].
pub fn configure(roulette: &mut Roulette, data: &Map<String, Value>) -> Result<(), RouletteError> {
    const ALLOWED: [&str; 7] = [
        "name",
        "alias",
        "design",
        "cardSize",
        "colors",
        "durationSeconds",
        "settings",
    ];
    if data.keys().any(|k| !ALLOWED.contains(&k.as_str())) {
        return Err(RouletteError::invalid("Unknown roulette setting"));
    }
    if let Some(name) = data.get("name") {
        roulette.name = text(Some(name), "name", 120)?;
    }
    if let Some(alias) = data.get("alias") {
        roulette.alias = text(Some(alias), "alias", 40)?;
        if !is_alias(&roulette.alias) {
            return Err(RouletteError::invalid(
                "Alias must start with a lowercase letter and use letters, numbers, _ or -",
            ));
        }
    }
    if let Some(design) = data.get("design") {
        roulette.design =
            choice(design, &["wheel", "cards", "reel", "elimination"], "design")?.to_owned();
    }
    if let Some(size) = data.get("cardSize") {
        roulette.card_size = choice(size, &["large", "medium", "small"], "cardSize")?.to_owned();
    }
    if let Some(duration) = data.get("durationSeconds") {
        roulette.duration_seconds = integer(Some(duration), "durationSeconds", 1, 120)? as f64;
    }
    if let Some(colors) = data.get("colors") {
        match colors.as_array() {
            Some(list) if (1..=12).contains(&list.len()) && list.iter().all(is_hex_color) => {
                roulette.colors = list
                    .iter()
                    .filter_map(|c| c.as_str().map(str::to_owned))
                    .collect();
            }
            _ => {
                return Err(RouletteError::invalid(
                    "colors must contain 1–12 hex colors",
                ));
            }
        }
    }
    if let Some(settings) = data.get("settings") {
        let settings = object(settings)?;
        const KNOWN: [&str; 6] = [
            "insertion",
            "duplicate",
            "shuffleBeforeDraw",
            "showOnStart",
            "hideAfterSeconds",
            "winnerAction",
        ];
        if settings.keys().any(|k| !KNOWN.contains(&k.as_str())) {
            return Err(RouletteError::invalid("Unknown automation setting"));
        }
        let target = &mut roulette.settings;
        if let Some(v) = settings.get("insertion") {
            target.insertion = choice(v, &["append", "random"], "insertion")?.to_owned();
        }
        if let Some(v) = settings.get("duplicate") {
            target.duplicate = choice(v, &["separate", "increase"], "duplicate")?.to_owned();
        }
        if let Some(v) = settings.get("winnerAction") {
            target.winner_action =
                choice(v, &["keep", "remove-copy", "remove-item"], "winnerAction")?.to_owned();
        }
        for key in ["shuffleBeforeDraw", "showOnStart"] {
            if let Some(v) = settings.get(key) {
                let Value::Bool(flag) = v else {
                    return Err(RouletteError::invalid(format!("{key} must be boolean")));
                };
                if key == "shuffleBeforeDraw" {
                    target.shuffle_before_draw = *flag;
                } else {
                    target.show_on_start = *flag;
                }
            }
        }
        if let Some(v) = settings.get("hideAfterSeconds") {
            target.hide_after_seconds = match v {
                Value::Null => None,
                v => Some(integer(Some(v), "hideAfterSeconds", 1, 3600)? as f64),
            };
        }
    }
    validate(roulette)
}

/// `create(data)`: a new roulette with the defaults, configured; name and alias required.
pub fn create(data: &Map<String, Value>, random: &dyn Random) -> Result<Roulette, RouletteError> {
    let mut roulette = Roulette {
        id: new_id(random)?,
        alias: String::new(),
        name: String::new(),
        design: "wheel".into(),
        card_size: "large".into(),
        colors: ["#cbbaff", "#f4c968", "#ec9baf", "#a5d5c2"]
            .map(str::to_owned)
            .to_vec(),
        duration_seconds: 4.0,
        settings: Settings::default(),
        items: Vec::new(),
        order: Vec::new(),
    };
    configure(&mut roulette, data)?;
    text_str(&roulette.name, "name", 120)?;
    text_str(&roulette.alias, "alias", 120)?;
    Ok(roulette)
}

/// `find(state, reference)`: by id or alias; without a reference, the active roulette.
pub fn find<'a>(state: &'a State, reference: Option<&str>) -> Result<&'a Roulette, RouletteError> {
    let index = find_index(state, reference)?;
    state.roulettes.get(index).ok_or_else(not_found)
}

fn not_found() -> RouletteError {
    RouletteError::new("not_found", "Roulette not found in this channel", 404)
}

/// The position of [`find`]'s roulette.
pub fn find_index(state: &State, reference: Option<&str>) -> Result<usize, RouletteError> {
    // `reference || state.activeId`: an empty reference means the active one for the id test,
    // and the alias test compares with the reference as given.
    let by_id = match reference {
        Some(r) if !r.is_empty() => Some(r),
        _ => state.active_id.as_deref(),
    };
    state
        .roulettes
        .iter()
        .position(|r| Some(r.id.as_str()) == by_id || Some(r.alias.as_str()) == reference)
        .ok_or_else(not_found)
}

/// A checked new item row (`parseItem`).
#[derive(Clone, Debug)]
struct NewItem {
    label: String,
    multiplier: i64,
    weight: i64,
    action: Option<String>,
}

const ITEM_FIELDS: [&str; 4] = ["label", "multiplier", "weight", "action"];

fn parse_item(data: &Map<String, Value>) -> Result<NewItem, RouletteError> {
    if data.keys().any(|k| !ITEM_FIELDS.contains(&k.as_str())) {
        return Err(RouletteError::invalid("Unknown item field"));
    }
    let one = Value::from(1);
    Ok(NewItem {
        label: text(data.get("label"), "label", 120)?,
        multiplier: integer(
            Some(data.get("multiplier").unwrap_or(&one)),
            "multiplier",
            1,
            10_000,
        )?,
        weight: integer(
            Some(data.get("weight").unwrap_or(&one)),
            "weight",
            1,
            MAX_SAFE_INTEGER,
        )?,
        action: data.get("action").map(action_source).transpose()?,
    })
}

/// `target(r, row, existing)`: the item a row joins, or a new one appended (without copies).
fn target(
    roulette: &mut Roulette,
    row: &NewItem,
    existing: Option<usize>,
    random: &dyn Random,
) -> Result<usize, RouletteError> {
    if let Some(index) = existing {
        let item = roulette.items.get(index).ok_or_else(not_found)?;
        if item.weight != row.weight as f64 {
            return Err(RouletteError::new(
                "weight_conflict",
                "Existing item has a different weight; update it explicitly",
                409,
            ));
        }
        if let Some(action) = &row.action
            && item.action.as_deref().unwrap_or("") != action
        {
            return Err(RouletteError::new(
                "action_conflict",
                "Existing item has a different action; edit it explicitly",
                409,
            ));
        }
        return Ok(index);
    }
    roulette.items.push(Item {
        id: new_id(random)?,
        label: row.label.clone(),
        multiplier: 0.0,
        weight: row.weight as f64,
        copies: Vec::new(),
        action: Some(row.action.clone().unwrap_or_default()),
    });
    Ok(roulette.items.len() - 1)
}

/// `addCopies`: each new key goes to the end, or to a random place with `insertion: random`.
fn add_copies(
    roulette: &mut Roulette,
    index: usize,
    count: i64,
    random: &dyn Random,
) -> Result<(), RouletteError> {
    for _ in 0..count {
        let key = new_id(random)?;
        if let Some(item) = roulette.items.get_mut(index) {
            item.copies.push(key.clone());
        }
        let at = if roulette.settings.insertion == "random" {
            random_ticket(random, (roulette.order.len() + 1) as f64)?
        } else {
            roulette.order.len()
        };
        roulette.order.insert(at.min(roulette.order.len()), key);
    }
    Ok(())
}

/// `add(r, data)`: one item (or more copies of the item with the same label, with `duplicate:
/// increase`). Returns the item's id.
pub fn add(
    roulette: &mut Roulette,
    data: &Map<String, Value>,
    random: &dyn Random,
) -> Result<String, RouletteError> {
    let row = parse_item(data)?;
    let existing = if roulette.settings.duplicate == "increase" {
        roulette.items.iter().position(|i| i.label == row.label)
    } else {
        None
    };
    let index = target(roulette, &row, existing, random)?;
    if let Some(item) = roulette.items.get_mut(index) {
        item.multiplier += row.multiplier as f64;
    }
    validate(roulette)?;
    add_copies(roulette, index, row.multiplier, random)?;
    Ok(roulette
        .items
        .get(index)
        .map(|i| i.id.clone())
        .unwrap_or_default())
}

fn at_row<T>(row: usize, result: Result<T, RouletteError>) -> Result<T, RouletteError> {
    result.map_err(|mut error| {
        error.message = format!("Prize {row}: {}", error.message);
        error.row = Some(row);
        error
    })
}

/// `importItems(r, data)`: all-or-nothing bulk add (`replace` clears the prizes first); totals
/// are checked before any copy is created. Returns the number of rows.
pub fn import_items(
    roulette: &mut Roulette,
    data: &Map<String, Value>,
    random: &dyn Random,
) -> Result<usize, RouletteError> {
    if data.keys().any(|k| k != "items" && k != "replace") {
        return Err(RouletteError::invalid("Unknown import field"));
    }
    let replace = match data.get("replace") {
        None => false,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => return Err(RouletteError::invalid("replace must be true or false")),
    };
    let list = match data.get("items").and_then(Value::as_array) {
        Some(list) if !list.is_empty() && list.len() <= IMPORT_LIMIT => list,
        _ => {
            return Err(RouletteError::invalid("items must contain 1–10000 prizes"));
        }
    };
    let rows = list
        .iter()
        .enumerate()
        .map(|(i, entry)| at_row(i + 1, object(entry).and_then(parse_item)))
        .collect::<Result<Vec<_>, _>>()?;
    let kept: &[Item] = if replace { &[] } else { &roulette.items };
    let slots = kept.iter().map(|i| i.multiplier).sum::<f64>()
        + rows.iter().map(|r| r.multiplier as f64).sum::<f64>();
    if slots > capacity(roulette) {
        return Err(RouletteError::invalid_code(
            "capacity",
            format!(
                "This design supports {} copies; requested {}",
                dima_text::number_to_string(capacity(roulette)),
                dima_text::number_to_string(slots)
            ),
        ));
    }
    let total = kept.iter().fold(0.0, |n, i| n + i.weight * i.multiplier)
        + rows
            .iter()
            .fold(0.0, |n, r| n + r.weight as f64 * r.multiplier as f64);
    if !is_safe_integer(total) {
        return Err(weight_error());
    }
    if replace {
        roulette.items.clear();
        roulette.order.clear();
    }
    let increase = roulette.settings.duplicate == "increase";
    let mut by_label: HashMap<String, usize> = HashMap::new();
    if increase {
        for (index, item) in roulette.items.iter().enumerate() {
            by_label.entry(item.label.clone()).or_insert(index);
        }
    }
    for (i, row) in rows.iter().enumerate() {
        let existing = if increase {
            by_label.get(&row.label).copied()
        } else {
            None
        };
        let index = at_row(i + 1, target(roulette, row, existing, random))?;
        if increase {
            by_label.insert(row.label.clone(), index);
        }
        if let Some(item) = roulette.items.get_mut(index) {
            item.multiplier += row.multiplier as f64;
        }
        at_row(i + 1, add_copies(roulette, index, row.multiplier, random))?;
    }
    validate(roulette)?;
    Ok(rows.len())
}

/// `remove(r, itemId)`: the item and every copy.
pub fn remove(roulette: &mut Roulette, item_id: &str) -> Result<(), RouletteError> {
    let item = roulette
        .items
        .iter()
        .find(|i| i.id == item_id)
        .ok_or_else(item_not_found)?;
    let keys: HashSet<String> = item.copies.iter().cloned().collect();
    roulette.order.retain(|key| !keys.contains(key));
    roulette.items.retain(|i| i.id != item_id);
    Ok(())
}

fn item_not_found() -> RouletteError {
    RouletteError::new("not_found", "Item not found", 404)
}

/// `updateItem(r, itemId, data)`: label, weight, action and the number of copies.
pub fn update_item(
    roulette: &mut Roulette,
    item_id: &str,
    data: &Map<String, Value>,
    random: &dyn Random,
) -> Result<String, RouletteError> {
    if data.keys().any(|k| !ITEM_FIELDS.contains(&k.as_str())) {
        return Err(RouletteError::invalid("Unknown item field"));
    }
    let index = roulette
        .items
        .iter()
        .position(|i| i.id == item_id)
        .ok_or_else(item_not_found)?;
    {
        let Some(item) = roulette.items.get_mut(index) else {
            return Err(item_not_found());
        };
        if let Some(action) = data.get("action") {
            item.action = Some(action_source(action)?);
        }
        if let Some(label) = data.get("label") {
            item.label = text(Some(label), "label", 120)?;
        }
        if let Some(weight) = data.get("weight") {
            item.weight = integer(Some(weight), "weight", 1, MAX_SAFE_INTEGER)? as f64;
        }
        if let Some(multiplier) = data.get("multiplier") {
            item.multiplier = integer(Some(multiplier), "multiplier", 1, 10_000)? as f64;
        }
    }
    validate(roulette)?;
    let (multiplier, removed) = {
        let Some(item) = roulette.items.get_mut(index) else {
            return Err(item_not_found());
        };
        let keep = (item.multiplier as usize).min(item.copies.len());
        let removed: HashSet<String> = item.copies.split_off(keep).into_iter().collect();
        (item.multiplier as usize, removed)
    };
    roulette.order.retain(|key| !removed.contains(key));
    while roulette
        .items
        .get(index)
        .is_some_and(|item| item.copies.len() < multiplier)
    {
        add_copies(roulette, index, 1, random)?;
    }
    Ok(item_id.to_owned())
}

/// `idle(state)`: 409 while a draw spins.
pub fn idle(state: &State) -> Result<(), RouletteError> {
    match &state.draw {
        Some(draw) if draw.completed_at.is_none() => {
            Err(RouletteError::new("spinning", "Roulette is spinning", 409))
        }
        _ => Ok(()),
    }
}

/// `start(state, r, now)`: draws the winner of roulette `index` once, for good, and makes it
/// the current draw. Returns the draw id.
pub fn start(
    state: &mut State,
    index: usize,
    now: f64,
    random: &dyn Random,
) -> Result<String, RouletteError> {
    idle(state)?;
    let roulette = state.roulettes.get_mut(index).ok_or_else(not_found)?;
    validate(roulette)?;
    if roulette.order.is_empty() {
        return Err(RouletteError::new(
            "empty",
            "Add an item before starting",
            409,
        ));
    }
    if roulette.settings.shuffle_before_draw {
        shuffle(&mut roulette.order, random)?;
    }
    let copies = slots(roulette);
    let total: f64 = copies.iter().map(|s| s.weight).sum();
    let mut ticket = random_ticket(random, total)? as f64;
    let winner = copies
        .iter()
        .find(|slot| {
            if ticket < slot.weight {
                return true;
            }
            ticket -= slot.weight;
            false
        })
        .cloned()
        .ok_or_else(|| RouletteError::new("internal", "No winner could be drawn", 500))?;
    let draw = Draw {
        id: new_id(random)?,
        roulette_id: roulette.id.clone(),
        started_at: now,
        ends_at: now + roulette.duration_seconds * 1000.0,
        completed_at: None,
        winner,
        slots: Some(copies),
        design: roulette.design.clone(),
        card_size: roulette.card_size.clone(),
        colors: roulette.colors.clone(),
        winner_action: roulette.settings.winner_action.clone(),
        hide_after_seconds: roulette.settings.hide_after_seconds,
    };
    let (id, show) = (roulette.id.clone(), roulette.settings.show_on_start);
    state.active_id = Some(id);
    if show {
        state.visible = true;
    }
    state.hide_at = None;
    let draw_id = draw.id.clone();
    state.draw = Some(draw);
    Ok(draw_id)
}

/// `settle(state, now)`: completes a draw that is due (removing the winner when the draw says
/// so, recording it in the history, setting the hide deadline) and hides when that deadline
/// passed. Returns whether anything changed; the caller saves it in the same compare-and-set.
pub fn settle(state: &mut State, now: f64) -> bool {
    let mut changed = false;
    if let Some(draw) = state.draw.as_mut()
        && draw.completed_at.is_none()
        && now >= draw.ends_at
    {
        draw.completed_at = Some(draw.ends_at);
        let draw = draw.clone();
        if let Some(roulette) = state
            .roulettes
            .iter_mut()
            .find(|r| r.id == draw.roulette_id)
            && let Some(position) = roulette
                .items
                .iter()
                .position(|i| i.id == draw.winner.item_id)
        {
            match draw.winner_action.as_str() {
                "remove-item" => {
                    let item_id = draw.winner.item_id.clone();
                    let _ = remove(roulette, &item_id);
                }
                "remove-copy" => {
                    let key = &draw.winner.key;
                    if let Some(item) = roulette.items.get_mut(position)
                        && item.copies.contains(key)
                    {
                        item.copies.retain(|k| k != key);
                        item.multiplier = item.copies.len() as f64;
                        let empty = item.copies.is_empty();
                        roulette.order.retain(|k| k != key);
                        if empty {
                            roulette.items.remove(position);
                        }
                    }
                }
                _ => {}
            }
        }
        let mut entry = draw.clone();
        entry.slots = None;
        state.history.insert(0, entry);
        state.history.truncate(HISTORY_LIMIT);
        state.hide_at = draw
            .hide_after_seconds
            .map(|seconds| draw.ends_at + seconds * 1000.0);
        changed = true;
    }
    if let Some(hide_at) = state.hide_at
        && now >= hide_at
    {
        state.visible = false;
        state.hide_at = None;
        changed = true;
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use dima_core::SeededRandom;
    use serde_json::json;

    fn map(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn a_roulette_draws_and_settles_once() {
        let random = SeededRandom::new(1);
        let mut state = State::default();
        let mut wheel =
            create(&map(json!({"name": "Giveaway", "alias": "give"})), &random).unwrap();
        add(
            &mut wheel,
            &map(json!({"label": "VIP 👑", "multiplier": 3})),
            &random,
        )
        .unwrap();
        wheel.settings.winner_action = "remove-copy".into();
        state.roulettes.push(wheel);
        start(&mut state, 0, 1000.0, &random).unwrap();
        assert_eq!(idle(&state).unwrap_err().code, "spinning");
        assert!(!settle(&mut state, 4999.0));
        assert!(settle(&mut state, 5000.0));
        assert!(!settle(&mut state, 5000.0));
        assert_eq!(state.roulettes[0].items[0].copies.len(), 2);
        assert_eq!(state.roulettes[0].order.len(), 2);
        assert_eq!(state.history.len(), 1);
        assert!(state.history[0].slots.is_none());
        let stored = state.to_bson().unwrap();
        let draw = stored.get_document("draw").unwrap();
        assert_eq!(draw.get("completedAt"), Some(&Bson::Int32(5000)));
        assert_eq!(State::from_bson(&Bson::Document(stored)).unwrap(), state);
    }

    #[test]
    fn imports_refuse_the_whole_list_on_one_bad_row() {
        let random = SeededRandom::new(2);
        let mut wheel = create(&map(json!({"name": "W", "alias": "w"})), &random).unwrap();
        let error = import_items(
            &mut wheel,
            &map(json!({"items": [{"label": "a"}, {"label": ""}]})),
            &random,
        )
        .unwrap_err();
        assert_eq!(error.row, Some(2));
        assert_eq!(
            error.message,
            "Prize 2: label must contain 1–120 characters"
        );
        assert!(wheel.items.is_empty());
    }
}

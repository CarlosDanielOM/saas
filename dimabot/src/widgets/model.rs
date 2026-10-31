//! Dead by Daylight widget state machine.
//!
//! Ports `dimabot/src/widgets/model.ts`. Run ids keep UUID hyphens. Card
//! values stay server-side until the winning card is chosen. Result phases
//! are stored as `character-result` / `perk-result` and reported to OBS as
//! the spin phase plus `resultPhase`. A mini roulette is a `wheel:{id}`
//! slice; an emptied inner wheel falls back to the main wheel. Channel
//! Points for a poll use the joker price when that run rolled a joker.

#![cfg(feature = "widgets-runtime")]

pub use crate::roulette_runtime::model::{RouletteError, fail, integer, object, text};
use crate::utils::js_string::JsString;
use crate::utils::lossless_json::JsonValue;
use crate::widgets_runtime::catalog::{self, Entry, Mode, Role};

use serde::{Deserialize, Serialize, de, ser::SerializeMap};
use std::fmt;

/// The source name for the same failure type the roulette model returns.
pub type WidgetError = RouletteError;

pub const MAX_PERK_COPIES: i64 = 5;
pub const MAX_PERK_WEIGHT: i64 = 10;
pub const MAX_SUB_WHEELS: usize = 10;
pub const MIN_SUB_WHEEL_PERKS: usize = 2;
pub const SUB_WHEEL_PREFIX: &str = "wheel:";

pub fn sub_wheel_slot(id: &str) -> String {
    format!("{SUB_WHEEL_PREFIX}{id}")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CharacterDesign {
    Cards,
    Reel,
    Wheel,
    Elimination,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Challenge,
    Characters,
    Perks,
    Poll,
}

impl Operation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Challenge => "challenge",
            Self::Characters => "characters",
            Self::Perks => "perks",
            Self::Poll => "poll",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "challenge" => Self::Challenge,
            "characters" => Self::Characters,
            "perks" => Self::Perks,
            "poll" => Self::Poll,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Idle,
    CharacterSpin,
    CharacterResult,
    PollStarting,
    Polling,
    PollError,
    Reveal,
    PerkSpin,
    PerkResult,
    Complete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    En,
    Es,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CameraCorner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LoadoutMode {
    Detailed,
    Compact,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProgressStyle {
    Badges,
    Bar,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sequence {
    pub character: bool,
    pub fixed_character_id: Option<String>,
    pub poll: bool,
    pub perks: bool,
    pub perk_count: i64,
}

pub fn default_sequence() -> Sequence {
    Sequence {
        character: true,
        fixed_character_id: None,
        poll: true,
        perks: true,
        perk_count: 4,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub camera_corner: CameraCorner,
    pub camera_width: i64,
    pub camera_height: i64,
    pub loadout_mode: LoadoutMode,
    pub auto_compact: bool,
    pub progress_style: ProgressStyle,
    pub show_active: bool,
    pub show_info: bool,
    pub show_progress: bool,
    pub hide_active_during_gameplay: bool,
}

pub fn default_layout() -> Layout {
    Layout {
        camera_corner: CameraCorner::BottomRight,
        camera_width: 512,
        camera_height: 288,
        loadout_mode: LoadoutMode::Detailed,
        auto_compact: true,
        progress_style: ProgressStyle::Badges,
        show_active: true,
        show_info: true,
        show_progress: true,
        hide_active_during_gameplay: true,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PerkTuning {
    pub copies: i64,
    pub weight: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PerkTuningMap {
    entries: Vec<(String, PerkTuning)>,
}

impl PerkTuningMap {
    /// Insertion order. `get` still returns the last value for a repeated id.
    pub fn entries(&self) -> &[(String, PerkTuning)] {
        &self.entries
    }

    pub fn get(&self, id: &str) -> Option<&PerkTuning> {
        self.entries.iter().rev().find(|(key, _)| key == id).map(|(_, tuning)| tuning)
    }

    pub fn insert(&mut self, id: String, tuning: PerkTuning) {
        if let Some(slot) = self.entries.iter_mut().find(|(key, _)| *key == id) {
            slot.1 = tuning;
        } else {
            self.entries.push((id, tuning));
        }
    }

    pub fn remove(&mut self, id: &str) {
        self.entries.retain(|(key, _)| key != id);
    }
}

impl Serialize for PerkTuningMap {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.entries.len()))?;
        for (key, value) in &self.entries {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for PerkTuningMap {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> de::Visitor<'de> for Visitor {
            type Value = PerkTuningMap;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("perk tuning object")
            }
            fn visit_map<A: de::MapAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
                let mut entries = Vec::new();
                while let Some((key, value)) = access.next_entry::<String, PerkTuning>()? {
                    if let Some(slot) = entries.iter_mut().find(|(id, _): &(String, PerkTuning)| *id == key) {
                        slot.1 = value;
                    } else {
                        entries.push((key, value));
                    }
                }
                Ok(PerkTuningMap { entries })
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubWheel {
    pub id: String,
    pub role: Role,
    pub name: String,
    pub perk_ids: Vec<String>,
    pub copies: i64,
    pub weight: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleSequences {
    pub killer: Sequence,
    pub survivor: Sequence,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Targets {
    pub killer: i64,
    pub survivor: i64,
}

pub fn default_targets() -> Targets {
    Targets { killer: 3, survivor: 4 }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Wins {
    pub killer: i64,
    pub survivor: i64,
}

pub fn default_wins() -> Wins {
    Wins { killer: 0, survivor: 0 }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Loadout {
    pub character_id: Option<String>,
    pub perk_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Loadouts {
    pub killer: Loadout,
    pub survivor: Loadout,
}

fn empty_loadout() -> Loadout {
    Loadout { character_id: None, perk_ids: Vec::new() }
}

pub fn default_loadouts() -> Loadouts {
    Loadouts { killer: empty_loadout(), survivor: empty_loadout() }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub language: Language,
    pub character_design: CharacterDesign,
    pub spin_seconds: i64,
    pub poll_seconds: i64,
    pub channel_points_voting: bool,
    pub channel_points_per_vote: i64,
    pub joker_chance: i64,
    pub joker_points_per_vote: i64,
    pub include_unavailable: bool,
    pub excluded_ids: Vec<String>,
    #[serde(default)]
    pub perk_tuning: PerkTuningMap,
    #[serde(default)]
    pub sub_wheels: Vec<SubWheel>,
    #[serde(default)]
    pub sequences: Option<RoleSequences>,
    #[serde(default)]
    pub layout: Option<Layout>,
    #[serde(default)]
    pub targets: Option<Targets>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draw {
    pub id: String,
    pub kind: DrawKind,
    pub design: CharacterDesign,
    pub item_id: String,
    pub pool_ids: Vec<String>,
    pub slot: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wheel_id: Option<String>,
    pub started_at: i64,
    pub ends_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DrawKind {
    Character,
    Perk,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<Operation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<Sequence>,
    pub id: String,
    pub character_id: Option<String>,
    pub perk_ids: Vec<String>,
    pub draw: Option<Draw>,
    pub cards: Vec<i64>,
    pub votes: Vec<i64>,
    #[serde(default)]
    pub channel_points_votes: Vec<i64>,
    pub winning_card: Option<i64>,
    pub perk_count: Option<i64>,
    pub poll_id: Option<String>,
    #[serde(default)]
    pub choice_ids: Vec<String>,
    pub poll_title: String,
    pub poll_ends_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub joker: Option<bool>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub pack_id: String,
    pub config: Config,
    pub visible: bool,
    pub phase: Phase,
    pub run: Option<Run>,
    pub next_at: Option<i64>,
    #[serde(default)]
    pub wins: Option<Wins>,
    #[serde(default)]
    pub loadouts: Option<Loadouts>,
}

pub fn initial() -> State {
    State {
        pack_id: "dbd-killer-challenge".to_owned(),
        config: Config {
            language: Language::En,
            character_design: CharacterDesign::Cards,
            spin_seconds: 4,
            poll_seconds: 30,
            channel_points_voting: false,
            channel_points_per_vote: 100,
            joker_chance: 0,
            joker_points_per_vote: 100,
            include_unavailable: false,
            excluded_ids: Vec::new(),
            perk_tuning: PerkTuningMap::default(),
            sub_wheels: Vec::new(),
            sequences: Some(RoleSequences { killer: default_sequence(), survivor: default_sequence() }),
            layout: Some(default_layout()),
            targets: Some(default_targets()),
        },
        visible: false,
        phase: Phase::Idle,
        run: None,
        next_at: None,
        wins: Some(default_wins()),
        loadouts: Some(default_loadouts()),
    }
}

/// `randomInt(upper)` in `0..upper`, rejection-sampled from 64 bits.
pub fn random_int(upper: u64) -> Result<u64, RouletteError> {
    if upper == 0 {
        return Err(fail("invalid", "Random bound must be positive", 400));
    }
    let zone = u64::MAX - (u64::MAX % upper);
    loop {
        let mut bytes = [0_u8; 8];
        getrandom::fill(&mut bytes).map_err(|_| fail("unavailable", "Widget random source is unavailable", 500))?;
        let value = u64::from_le_bytes(bytes);
        if value < zone {
            return Ok(value % upper);
        }
    }
}

fn catalog_entries() -> Result<&'static [Entry], RouletteError> {
    catalog::entries().map_err(|_| fail("unavailable", "Widget catalog is unavailable", 500))
}

pub fn pack(id: &str) -> Result<catalog::Pack, RouletteError> {
    catalog::packs()
        .map_err(|_| fail("unavailable", "Widget catalog is unavailable", 500))?
        .iter()
        .find(|pack| pack.id == id)
        .cloned()
        .ok_or_else(|| fail("invalid", "Unknown widget pack", 400))
}

pub fn eligible(state: &State, id: &str) -> bool {
    state.config.include_unavailable
        || catalog_entries().ok().is_some_and(|entries| {
            entries.iter().find(|entry| entry.id == id).is_some_and(|entry| entry.available)
        })
}

pub fn on_wheel(state: &State, id: &str) -> bool {
    eligible(state, id) && !state.config.excluded_ids.iter().any(|excluded| excluded == id)
}

pub fn perk_entries(role: Role) -> Result<Vec<Entry>, RouletteError> {
    Ok(catalog_entries()?.iter().filter(|entry| entry.kind == "perk" && entry.role == role.as_str()).cloned().collect())
}

pub fn tuning(state: &State, id: &str) -> PerkTuning {
    state.config.perk_tuning.get(id).copied().unwrap_or(PerkTuning { copies: 1, weight: 1 })
}

pub fn set_copies(state: &mut State, id: &str, copies: i64) {
    let weight = tuning(state, id).weight;
    state.config.perk_tuning.remove(id);
    if copies != 1 || weight != 1 {
        state.config.perk_tuning.insert(id.to_owned(), PerkTuning { copies, weight });
    }
}

pub fn normalize(state: &mut State) -> Result<(), RouletteError> {
    if state.config.sequences.is_none() {
        state.config.sequences = Some(RoleSequences { killer: default_sequence(), survivor: default_sequence() });
    }
    if state.config.layout.is_none() {
        state.config.layout = Some(default_layout());
    }
    if state.config.targets.is_none() {
        state.config.targets = Some(default_targets());
    }
    if state.wins.is_none() {
        state.wins = Some(default_wins());
    }
    if state.loadouts.is_none() {
        let mut loadouts = default_loadouts();
        if let Some(run) = &state.run {
            let role = pack(&state.pack_id)?.role;
            let slot = if role == Role::Survivor { &mut loadouts.survivor } else { &mut loadouts.killer };
            slot.character_id = run.character_id.clone();
            slot.perk_ids = run.perk_ids.clone();
        }
        state.loadouts = Some(loadouts);
    }
    Ok(())
}

pub fn pool(state: &State, kind: &str) -> Result<Vec<Entry>, RouletteError> {
    let role = pack(&state.pack_id)?.role.as_str().to_owned();
    Ok(catalog_entries()?.iter().filter(|entry| {
        entry.role == role && entry.kind == kind && (state.config.include_unavailable || entry.available)
            && !state.config.excluded_ids.iter().any(|id| id == &entry.id)
    }).cloned().collect())
}

pub fn slots(state: &State, entries: &[Entry], wheels: &[SubWheel]) -> Vec<String> {
    let items: Vec<(String, i64)> = entries.iter().map(|entry| {
        let copies = if entry.kind == "perk" { tuning(state, &entry.id).copies } else { 1 };
        (entry.id.clone(), copies)
    }).chain(wheels.iter().map(|wheel| (sub_wheel_slot(&wheel.id), wheel.copies))).collect();
    let count = items.len();
    if count == 0 {
        return Vec::new();
    }
    let mut placed = Vec::new();
    for (index, (id, copies)) in items.into_iter().enumerate() {
        let copies = copies.max(0) as usize;
        for copy in 0..copies {
            let at = (copy as f64 + (index as f64 + 0.5) / count as f64) / copies as f64;
            placed.push((id.clone(), at));
        }
    }
    placed.sort_by(|left, right| left.1.total_cmp(&right.1));
    placed.into_iter().map(|(id, _)| id).collect()
}

fn sub_wheels_for(state: &State, role: Role) -> Vec<SubWheel> {
    state.config.sub_wheels.iter().filter(|wheel| wheel.role == role).cloned().collect()
}

fn slot_weight(state: &State, id: &str) -> i64 {
    if let Some(rest) = id.strip_prefix(SUB_WHEEL_PREFIX) {
        state.config.sub_wheels.iter().find(|wheel| wheel.id == rest).map(|wheel| wheel.weight).unwrap_or(1)
    } else {
        tuning(state, id).weight
    }
}

fn require_bool(value: Option<&JsonValue>, name: &str) -> Result<bool, RouletteError> {
    match value {
        Some(JsonValue::Bool(value)) => Ok(*value),
        _ => Err(fail("invalid", &format!("{name} must be a boolean"), 400)),
    }
}

fn unknown(value: &JsonValue, allowed: &[&str], message: &str) -> Result<(), RouletteError> {
    let fields = object(value)?;
    if fields.iter().any(|(key, _)| key.as_str().is_none_or(|key| !allowed.contains(&key))) {
        return Err(fail("invalid", message, 400));
    }
    Ok(())
}

fn as_str<'a>(value: &'a JsonValue) -> Option<&'a str> {
    match value {
        JsonValue::String(text) => text.as_str(),
        _ => None,
    }
}

/// Layout object. Every key on the default layout is required.
pub fn layout(input: &JsonValue) -> Result<Layout, RouletteError> {
    unknown(input, &[
        "cameraCorner", "cameraWidth", "cameraHeight", "loadoutMode", "autoCompact", "progressStyle",
        "showActive", "showInfo", "showProgress", "hideActiveDuringGameplay",
    ], "Unknown layout setting")?;
    let camera_corner = match as_str(input.get("cameraCorner").unwrap_or(&JsonValue::Null)) {
        Some("top-left") => CameraCorner::TopLeft,
        Some("top-right") => CameraCorner::TopRight,
        Some("bottom-left") => CameraCorner::BottomLeft,
        Some("bottom-right") => CameraCorner::BottomRight,
        _ => return Err(fail("invalid", "Choose a camera corner", 400)),
    };
    let loadout_mode = match as_str(input.get("loadoutMode").unwrap_or(&JsonValue::Null)) {
        Some("detailed") => LoadoutMode::Detailed,
        Some("compact") => LoadoutMode::Compact,
        _ => return Err(fail("invalid", "Invalid loadout or progress style", 400)),
    };
    let progress_style = match as_str(input.get("progressStyle").unwrap_or(&JsonValue::Null)) {
        Some("badges") => ProgressStyle::Badges,
        Some("bar") => ProgressStyle::Bar,
        _ => return Err(fail("invalid", "Invalid loadout or progress style", 400)),
    };
    Ok(Layout {
        camera_corner,
        camera_width: integer(input.get("cameraWidth").unwrap_or(&JsonValue::Null), "cameraWidth", 320, 800)?,
        camera_height: integer(input.get("cameraHeight").unwrap_or(&JsonValue::Null), "cameraHeight", 180, 640)?,
        loadout_mode,
        auto_compact: require_bool(input.get("autoCompact"), "autoCompact")?,
        progress_style,
        show_active: require_bool(input.get("showActive"), "showActive")?,
        show_info: require_bool(input.get("showInfo"), "showInfo")?,
        show_progress: require_bool(input.get("showProgress"), "showProgress")?,
        hide_active_during_gameplay: require_bool(input.get("hideActiveDuringGameplay"), "hideActiveDuringGameplay")?,
    })
}

fn sequence(input: &JsonValue, role: Role) -> Result<Sequence, RouletteError> {
    unknown(input, &["character", "fixedCharacterId", "poll", "perks", "perkCount"], "Unknown sequence setting")?;
    let character = require_bool(input.get("character"), "character")?;
    let poll = require_bool(input.get("poll"), "poll")?;
    let perks = require_bool(input.get("perks"), "perks")?;
    let fixed = match input.get("fixedCharacterId") {
        Some(JsonValue::Null) => None,
        Some(value) => {
            let id = as_str(value).ok_or_else(|| fail("invalid", "Choose a character for this role", 400))?;
            let entries = catalog_entries()?;
            if !entries.iter().any(|entry| entry.id == id && entry.role == role.as_str() && entry.kind == "character") {
                return Err(fail("invalid", "Choose a character for this role", 400));
            }
            Some(id.to_owned())
        }
        None => return Err(fail("invalid", "Choose a character for this role", 400)),
    };
    if !character && fixed.is_none() {
        return Err(fail("invalid", "A skipped character draw needs a fixed character", 400));
    }
    Ok(Sequence {
        character,
        fixed_character_id: fixed,
        poll,
        perks,
        perk_count: integer(input.get("perkCount").unwrap_or(&JsonValue::Null), "perkCount", 0, 4)?,
    })
}

fn perk_tuning(input: &JsonValue) -> Result<PerkTuningMap, RouletteError> {
    let mut out = PerkTuningMap::default();
    for (id, value) in object(input)? {
        let Some(id) = id.as_str() else {
            return Err(fail("invalid", "Slots and weight only apply to perks", 400));
        };
        if !catalog_entries()?.iter().any(|entry| entry.id == id && entry.kind == "perk") {
            return Err(fail("invalid", "Slots and weight only apply to perks", 400));
        }
        unknown(value, &["copies", "weight"], "Unknown perk tuning setting")?;
        let copies = integer(value.get("copies").unwrap_or(&JsonValue::Null), "slots", 1, MAX_PERK_COPIES)?;
        let weight = integer(value.get("weight").unwrap_or(&JsonValue::Null), "weight", 1, MAX_PERK_WEIGHT)?;
        if copies != 1 || weight != 1 {
            out.insert(id.to_owned(), PerkTuning { copies, weight });
        }
    }
    Ok(out)
}

fn sub_wheel_config(input: &JsonValue) -> Result<Vec<SubWheel>, RouletteError> {
    let JsonValue::Array(rows) = input else {
        return Err(fail("invalid", &format!("Use at most {MAX_SUB_WHEELS} mini roulettes per role"), 400));
    };
    if rows.len() > MAX_SUB_WHEELS * 2 {
        return Err(fail("invalid", &format!("Use at most {MAX_SUB_WHEELS} mini roulettes per role"), 400));
    }
    let mut ids = Vec::new();
    let mut perks = Vec::new();
    let mut out = Vec::new();
    for value in rows {
        unknown(value, &["id", "role", "name", "perkIds", "copies", "weight"], "Unknown mini roulette setting")?;
        let id = text(value.get("id").unwrap_or(&JsonValue::Null), "Mini roulette ID", 40)?;
        if !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-') || ids.iter().any(|seen: &String| seen == &id) {
            return Err(fail("invalid", "Mini roulette IDs must be unique letters, numbers, - or _", 400));
        }
        ids.push(id.clone());
        let role = match as_str(value.get("role").unwrap_or(&JsonValue::Null)) {
            Some("killer") => Role::Killer,
            Some("survivor") => Role::Survivor,
            _ => return Err(fail("invalid", "Choose killer or survivor for the mini roulette", 400)),
        };
        let name = text(value.get("name").unwrap_or(&JsonValue::Null), "Mini roulette name", 40)?;
        let JsonValue::Array(perk_ids) = value.get("perkIds").unwrap_or(&JsonValue::Null) else {
            return Err(fail("invalid", &format!("A mini roulette needs at least {MIN_SUB_WHEEL_PERKS} perks"), 400));
        };
        let entry_count = catalog_entries()?.len();
        if perk_ids.len() < MIN_SUB_WHEEL_PERKS || perk_ids.len() > entry_count {
            return Err(fail("invalid", &format!("A mini roulette needs at least {MIN_SUB_WHEEL_PERKS} perks"), 400));
        }
        let mut owned = Vec::new();
        for perk in perk_ids {
            let Some(perk) = as_str(perk) else {
                return Err(fail("invalid", "Mini roulettes only hold perks of their role", 400));
            };
            if !catalog_entries()?.iter().any(|entry| entry.id == perk && entry.kind == "perk" && entry.role == role.as_str()) {
                return Err(fail("invalid", "Mini roulettes only hold perks of their role", 400));
            }
            if perks.iter().any(|seen: &String| seen == perk) {
                return Err(fail("invalid", "A perk can only be in one mini roulette", 400));
            }
            perks.push(perk.to_owned());
            owned.push(perk.to_owned());
        }
        out.push(SubWheel {
            id,
            role,
            name,
            perk_ids: owned,
            copies: integer(value.get("copies").unwrap_or(&JsonValue::Null), "slots", 1, MAX_PERK_COPIES)?,
            weight: integer(value.get("weight").unwrap_or(&JsonValue::Null), "weight", 1, MAX_PERK_WEIGHT)?,
        });
    }
    for role in [Role::Killer, Role::Survivor] {
        if out.iter().filter(|wheel| wheel.role == role).count() > MAX_SUB_WHEELS {
            return Err(fail("invalid", &format!("Use at most {MAX_SUB_WHEELS} mini roulettes per role"), 400));
        }
    }
    Ok(out)
}

/// Full settings object. Unknown keys are `Unknown widget setting`.
pub fn config(input: &JsonValue) -> Result<Config, RouletteError> {
    unknown(input, &[
        "language", "characterDesign", "spinSeconds", "pollSeconds", "channelPointsVoting",
        "channelPointsPerVote", "jokerChance", "jokerPointsPerVote", "includeUnavailable",
        "excludedIds", "perkTuning", "subWheels", "sequences", "layout", "targets",
    ], "Unknown widget setting")?;
    let language = match as_str(input.get("language").unwrap_or(&JsonValue::Null)) {
        Some("en") => Language::En,
        Some("es") => Language::Es,
        _ => return Err(fail("invalid", "Choose English or Spanish", 400)),
    };
    let character_design = match input.get("characterDesign") {
        None => CharacterDesign::Cards,
        Some(value) => match as_str(value) {
            Some("cards") => CharacterDesign::Cards,
            Some("reel") => CharacterDesign::Reel,
            Some("wheel") => CharacterDesign::Wheel,
            Some("elimination") => CharacterDesign::Elimination,
            _ => return Err(fail("invalid", "Choose cards, reel, wheel, or last one standing for the character roulette", 400)),
        },
    };
    let include_unavailable = require_bool(input.get("includeUnavailable"), "includeUnavailable")?;
    if let Some(value) = input.get("channelPointsVoting")
        && !matches!(value, JsonValue::Bool(_))
    {
        return Err(fail("invalid", "channelPointsVoting must be a boolean", 400));
    }
    let JsonValue::Array(excluded) = input.get("excludedIds").unwrap_or(&JsonValue::Null) else {
        return Err(fail("invalid", "Unknown excluded entry", 400));
    };
    let entries = catalog_entries()?;
    if excluded.len() > entries.len() {
        return Err(fail("invalid", "Unknown excluded entry", 400));
    }
    let mut excluded_ids = Vec::new();
    for id in excluded {
        let Some(id) = as_str(id) else {
            return Err(fail("invalid", "Unknown excluded entry", 400));
        };
        if !entries.iter().any(|entry| entry.id == id) {
            return Err(fail("invalid", "Unknown excluded entry", 400));
        }
        if !excluded_ids.iter().any(|seen: &String| seen == id) {
            excluded_ids.push(id.to_owned());
        }
    }
    let sequences = match input.get("sequences") {
        None => RoleSequences { killer: default_sequence(), survivor: default_sequence() },
        Some(value) => {
            unknown(value, &["killer", "survivor"], "Unknown sequence role")?;
            RoleSequences {
                killer: sequence(value.get("killer").unwrap_or(&JsonValue::Null), Role::Killer)?,
                survivor: sequence(value.get("survivor").unwrap_or(&JsonValue::Null), Role::Survivor)?,
            }
        }
    };
    let targets = match input.get("targets") {
        None => default_targets(),
        Some(value) => {
            unknown(value, &["killer", "survivor"], "Unknown progress role")?;
            Targets {
                killer: integer(value.get("killer").unwrap_or(&JsonValue::Null), "killer target", 1, 20)?,
                survivor: integer(value.get("survivor").unwrap_or(&JsonValue::Null), "survivor target", 1, 20)?,
            }
        }
    };
    let channel_points = match input.get("channelPointsPerVote") {
        None => JsonValue::Number(100.0),
        Some(value) => value.clone(),
    };
    let joker_chance = match input.get("jokerChance") {
        None => JsonValue::Number(0.0),
        Some(value) => value.clone(),
    };
    let joker_points = match input.get("jokerPointsPerVote") {
        None => JsonValue::Number(100.0),
        Some(value) => value.clone(),
    };
    Ok(Config {
        language,
        character_design,
        spin_seconds: integer(input.get("spinSeconds").unwrap_or(&JsonValue::Null), "spinSeconds", 1, 15)?,
        poll_seconds: integer(input.get("pollSeconds").unwrap_or(&JsonValue::Null), "pollSeconds", 15, 180)?,
        channel_points_voting: matches!(input.get("channelPointsVoting"), Some(JsonValue::Bool(true))),
        channel_points_per_vote: integer(&channel_points, "channelPointsPerVote", 1, 1_000_000)?,
        joker_chance: integer(&joker_chance, "jokerChance", 0, 100)?,
        joker_points_per_vote: integer(&joker_points, "jokerPointsPerVote", 1, 1_000_000)?,
        include_unavailable,
        excluded_ids,
        perk_tuning: perk_tuning(input.get("perkTuning").unwrap_or(&JsonValue::Object(Vec::new())))?,
        sub_wheels: sub_wheel_config(input.get("subWheels").unwrap_or(&JsonValue::Array(Vec::new())))?,
        sequences: Some(sequences),
        layout: Some(match input.get("layout") {
            None => default_layout(),
            Some(value) => layout(value)?,
        }),
        targets: Some(targets),
    })
}

fn json_string(value: &str) -> JsonValue {
    JsonValue::String(JsString::from(value))
}

fn json_i64(value: i64) -> JsonValue {
    JsonValue::Number(value as f64)
}

fn json_bool(value: bool) -> JsonValue {
    JsonValue::Bool(value)
}

fn json_pair(key: &str, value: JsonValue) -> (JsString, JsonValue) {
    (JsString::from(key), value)
}

fn json_object(fields: Vec<(&str, JsonValue)>) -> JsonValue {
    JsonValue::Object(fields.into_iter().map(|(key, value)| json_pair(key, value)).collect())
}

fn sequence_value(sequence: &Sequence) -> JsonValue {
    json_object(vec![
        ("character", json_bool(sequence.character)),
        (
            "fixedCharacterId",
            match &sequence.fixed_character_id {
                Some(id) => json_string(id),
                None => JsonValue::Null,
            },
        ),
        ("poll", json_bool(sequence.poll)),
        ("perks", json_bool(sequence.perks)),
        ("perkCount", json_i64(sequence.perk_count)),
    ])
}

fn layout_value(layout: &Layout) -> JsonValue {
    json_object(vec![
        (
            "cameraCorner",
            json_string(match layout.camera_corner {
                CameraCorner::TopLeft => "top-left",
                CameraCorner::TopRight => "top-right",
                CameraCorner::BottomLeft => "bottom-left",
                CameraCorner::BottomRight => "bottom-right",
            }),
        ),
        ("cameraWidth", json_i64(layout.camera_width)),
        ("cameraHeight", json_i64(layout.camera_height)),
        (
            "loadoutMode",
            json_string(match layout.loadout_mode {
                LoadoutMode::Detailed => "detailed",
                LoadoutMode::Compact => "compact",
            }),
        ),
        ("autoCompact", json_bool(layout.auto_compact)),
        (
            "progressStyle",
            json_string(match layout.progress_style {
                ProgressStyle::Badges => "badges",
                ProgressStyle::Bar => "bar",
            }),
        ),
        ("showActive", json_bool(layout.show_active)),
        ("showInfo", json_bool(layout.show_info)),
        ("showProgress", json_bool(layout.show_progress)),
        ("hideActiveDuringGameplay", json_bool(layout.hide_active_during_gameplay)),
    ])
}

/// Insertion-order settings object used by `{ ...existing, ...patch }`.
/// Absent sequences, layout, and targets are omitted so `config` fills them.
fn config_value(config: &Config) -> JsonValue {
    let mut fields = vec![
        json_pair(
            "language",
            json_string(match config.language {
                Language::En => "en",
                Language::Es => "es",
            }),
        ),
        json_pair(
            "characterDesign",
            json_string(match config.character_design {
                CharacterDesign::Cards => "cards",
                CharacterDesign::Reel => "reel",
                CharacterDesign::Wheel => "wheel",
                CharacterDesign::Elimination => "elimination",
            }),
        ),
        json_pair("spinSeconds", json_i64(config.spin_seconds)),
        json_pair("pollSeconds", json_i64(config.poll_seconds)),
        json_pair("channelPointsVoting", json_bool(config.channel_points_voting)),
        json_pair("channelPointsPerVote", json_i64(config.channel_points_per_vote)),
        json_pair("jokerChance", json_i64(config.joker_chance)),
        json_pair("jokerPointsPerVote", json_i64(config.joker_points_per_vote)),
        json_pair("includeUnavailable", json_bool(config.include_unavailable)),
        json_pair(
            "excludedIds",
            JsonValue::Array(config.excluded_ids.iter().map(|id| json_string(id)).collect()),
        ),
        json_pair(
            "perkTuning",
            JsonValue::Object(
                config
                    .perk_tuning
                    .entries()
                    .iter()
                    .map(|(id, tuning)| {
                        json_pair(
                            id,
                            json_object(vec![
                                ("copies", json_i64(tuning.copies)),
                                ("weight", json_i64(tuning.weight)),
                            ]),
                        )
                    })
                    .collect(),
            ),
        ),
        json_pair(
            "subWheels",
            JsonValue::Array(
                config
                    .sub_wheels
                    .iter()
                    .map(|wheel| {
                        json_object(vec![
                            ("id", json_string(&wheel.id)),
                            ("role", json_string(wheel.role.as_str())),
                            ("name", json_string(&wheel.name)),
                            (
                                "perkIds",
                                JsonValue::Array(wheel.perk_ids.iter().map(|id| json_string(id)).collect()),
                            ),
                            ("copies", json_i64(wheel.copies)),
                            ("weight", json_i64(wheel.weight)),
                        ])
                    })
                    .collect(),
            ),
        ),
    ];
    if let Some(sequences) = &config.sequences {
        fields.push(json_pair(
            "sequences",
            json_object(vec![
                ("killer", sequence_value(&sequences.killer)),
                ("survivor", sequence_value(&sequences.survivor)),
            ]),
        ));
    }
    if let Some(layout) = &config.layout {
        fields.push(json_pair("layout", layout_value(layout)));
    }
    if let Some(targets) = &config.targets {
        fields.push(json_pair(
            "targets",
            json_object(vec![
                ("killer", json_i64(targets.killer)),
                ("survivor", json_i64(targets.survivor)),
            ]),
        ));
    }
    JsonValue::Object(fields)
}

/// `{ ...existing, ...patch }` then the same validator `config` runs.
pub fn merge_config(existing: &Config, patch: &JsonValue) -> Result<Config, RouletteError> {
    let mut base = config_value(existing);
    let JsonValue::Object(base_fields) = &mut base else {
        return Err(fail("invalid", "Unknown widget setting", 400));
    };
    for (key, value) in object(patch)? {
        if let Some(slot) = base_fields.iter_mut().find(|(name, _)| name.as_str() == key.as_str()) {
            slot.1 = value.clone();
        } else {
            base_fields.push((key.clone(), value.clone()));
        }
    }
    config(&base)
}

pub fn active(state: &State) -> bool {
    !matches!(state.phase, Phase::Idle | Phase::Complete | Phase::PollError)
}

pub fn idle(state: &State) -> Result<(), RouletteError> {
    if active(state) || state.phase == Phase::PollError {
        return Err(fail("busy", "Finish or reset the challenge first", 409));
    }
    Ok(())
}

fn pick_index(len: usize, rng: &mut dyn FnMut(u64) -> Result<u64, RouletteError>) -> Result<usize, RouletteError> {
    if len == 0 {
        return Err(fail("empty_pool", "Select more entries before starting", 400));
    }
    let index = usize::try_from(rng(len as u64)?).unwrap_or(len);
    if index >= len {
        return Err(fail("invalid", "Random index missed the pool", 400));
    }
    Ok(index)
}

fn shuffle_cards(cards: &mut [i64], rng: &mut dyn FnMut(u64) -> Result<u64, RouletteError>) -> Result<(), RouletteError> {
    if cards.len() < 2 {
        return Ok(());
    }
    let mut index = cards.len() - 1;
    loop {
        let pick = pick_index(index + 1, rng)?;
        cards.swap(index, pick);
        if index == 1 {
            break;
        }
        index -= 1;
    }
    Ok(())
}

fn draw(state: &mut State, kind: DrawKind, now: i64, wheel_id: Option<String>, rng: &mut dyn FnMut(u64) -> Result<u64, RouletteError>) -> Result<(), RouletteError> {
    let run = state.run.as_ref().ok_or_else(|| fail("invalid", "No widget run", 400))?;
    let owned = run.perk_ids.clone();
    let mut options = pool(state, if kind == DrawKind::Character { "character" } else { "perk" })?;
    options.retain(|entry| !owned.iter().any(|id| id == &entry.id));
    let role = pack(&state.pack_id)?.role;
    let mut wheels = Vec::new();
    let mut wheel_id = wheel_id;
    if kind == DrawKind::Perk {
        let all = sub_wheels_for(state, role);
        let inner = wheel_id.as_ref().and_then(|id| all.iter().find(|wheel| &wheel.id == id).cloned());
        let inside: Vec<String> = all.iter().flat_map(|wheel| wheel.perk_ids.clone()).collect();
        if let Some(inner) = inner {
            if options.iter().any(|entry| inner.perk_ids.iter().any(|id| id == &entry.id)) {
                options.retain(|entry| inner.perk_ids.iter().any(|id| id == &entry.id));
            } else {
                wheel_id = None;
                wheels = all.into_iter().filter(|wheel| options.iter().any(|entry| wheel.perk_ids.iter().any(|id| id == &entry.id))).collect();
                options.retain(|entry| !inside.iter().any(|id| id == &entry.id));
            }
        } else {
            wheel_id = None;
            wheels = all.into_iter().filter(|wheel| options.iter().any(|entry| wheel.perk_ids.iter().any(|id| id == &entry.id))).collect();
            options.retain(|entry| !inside.iter().any(|id| id == &entry.id));
        }
    }
    if options.is_empty() && wheels.is_empty() {
        return Err(fail("empty_pool", "Select more entries before starting", 400));
    }
    let pool_ids = slots(state, &options, &wheels);
    let weights: Vec<i64> = pool_ids.iter().map(|id| if kind == DrawKind::Perk { slot_weight(state, id) } else { 1 }).collect();
    let total: i64 = weights.iter().sum();
    if total < 1 {
        return Err(fail("empty_pool", "Select more entries before starting", 400));
    }
    let mut ticket = i64::try_from(rng(total as u64)?).unwrap_or(total);
    let mut slot = 0_usize;
    while slot < weights.len() && ticket >= weights[slot] {
        ticket -= weights[slot];
        slot += 1;
    }
    if slot >= pool_ids.len() {
        return Err(fail("invalid", "Draw ticket missed every slot", 400));
    }
    let design = if kind == DrawKind::Perk { CharacterDesign::Wheel } else { state.config.character_design };
    let draw = Draw {
        id: uuid::Uuid::new_v4().to_string(),
        kind,
        design,
        item_id: pool_ids[slot].clone(),
        pool_ids,
        slot: slot as i64,
        wheel_id: wheel_id.clone(),
        started_at: now,
        ends_at: now + state.config.spin_seconds * 1000,
    };
    let ends_at = draw.ends_at;
    let run = state.run.as_mut().ok_or_else(|| fail("invalid", "No widget run", 400))?;
    run.draw = Some(draw);
    state.phase = if kind == DrawKind::Character { Phase::CharacterSpin } else { Phase::PerkSpin };
    state.next_at = Some(ends_at);
    Ok(())
}

fn finish(state: &mut State) {
    state.phase = Phase::Complete;
    state.next_at = None;
}

fn after_character(state: &mut State, now: i64, rng: &mut dyn FnMut(u64) -> Result<u64, RouletteError>) -> Result<(), RouletteError> {
    let (mode, poll, perks, perk_count) = {
        let run = state.run.as_ref().ok_or_else(|| fail("invalid", "No widget run", 400))?;
        let mode = run.operation.unwrap_or(pack(&state.pack_id)?.mode.mode_operation());
        let poll = run.sequence.as_ref().is_none_or(|sequence| sequence.poll);
        let perks = run.sequence.as_ref().is_some_and(|sequence| sequence.perks);
        let perk_count = run.perk_count.unwrap_or(0);
        (mode, poll, perks, perk_count)
    };
    if mode == Operation::Characters {
        finish(state);
        return Ok(());
    }
    if mode == Operation::Poll || poll {
        state.phase = Phase::PollStarting;
        state.next_at = Some(now + 30_000);
        return Ok(());
    }
    if perks && perk_count > 0 {
        draw(state, DrawKind::Perk, now, None, rng)
    } else {
        finish(state);
        Ok(())
    }
}

trait ModeOperation {
    fn mode_operation(self) -> Operation;
}
impl ModeOperation for Mode {
    fn mode_operation(self) -> Operation {
        match self {
            Mode::Challenge => Operation::Challenge,
            Mode::Characters => Operation::Characters,
            Mode::Perks => Operation::Perks,
        }
    }
}

pub fn start(state: &mut State, now: i64, operation: Option<Operation>) -> Result<(), RouletteError> {
    start_with(state, now, operation, &mut random_int)
}

pub fn start_with(
    state: &mut State,
    now: i64,
    operation: Option<Operation>,
    rng: &mut dyn FnMut(u64) -> Result<u64, RouletteError>,
) -> Result<(), RouletteError> {
    idle(state)?;
    normalize(state)?;
    let role = pack(&state.pack_id)?.role;
    let mode = operation.unwrap_or(pack(&state.pack_id)?.mode.mode_operation());
    let sequence = state.config.sequences.as_ref().ok_or_else(|| fail("invalid", "Unknown sequence setting", 400))?.clone();
    let sequence = if role == Role::Survivor { sequence.survivor } else { sequence.killer };
    let needs_character = mode == Operation::Characters || (mode == Operation::Challenge && sequence.character);
    let required_perks = if mode == Operation::Perks {
        1
    } else if mode == Operation::Challenge && sequence.perks {
        if sequence.poll { 4 } else { sequence.perk_count }
    } else {
        0
    };
    if needs_character && pool(state, "character")?.is_empty() {
        return Err(fail("empty_pool", "Select at least one character", 400));
    }
    if (pool(state, "perk")?.len() as i64) < required_perks {
        return Err(fail("empty_pool", "Select more perks for this sequence", 400));
    }
    if mode == Operation::Challenge && !sequence.character && !pool(state, "character")?.iter().any(|entry| Some(&entry.id) == sequence.fixed_character_id.as_ref()) {
        return Err(fail("empty_pool", "The fixed character must be enabled", 400));
    }
    let pack_mode = if mode == Operation::Poll { "challenge" } else { mode.as_str() };
    state.pack_id = format!("dbd-{}-{pack_mode}", role.as_str());
    let id = uuid::Uuid::new_v4().to_string();
    let previous = {
        let loadouts = state.loadouts.as_ref().ok_or_else(|| fail("invalid", "No widget run", 400))?;
        if role == Role::Survivor { loadouts.survivor.clone() } else { loadouts.killer.clone() }
    };
    let mut cards = vec![0, 1, 2, 3, 4];
    shuffle_cards(&mut cards, rng)?;
    let title_prefix = if state.config.language == Language::Es { "DBD: Elige una carta" } else { "DBD: Choose a card" };
    let title_id: String = id.chars().take(8).collect();
    state.run = Some(Run {
        operation: Some(mode),
        sequence: Some(sequence.clone()),
        id: id.clone(),
        character_id: if mode == Operation::Challenge && !sequence.character {
            sequence.fixed_character_id.clone()
        } else if needs_character {
            None
        } else {
            previous.character_id.clone()
        },
        perk_ids: if mode == Operation::Challenge { Vec::new() } else { previous.perk_ids.clone() },
        draw: None,
        cards,
        votes: vec![0, 0, 0, 0, 0],
        channel_points_votes: vec![0, 0, 0, 0, 0],
        winning_card: None,
        perk_count: if mode == Operation::Challenge && !sequence.poll { Some(sequence.perk_count) } else { None },
        poll_id: None,
        choice_ids: Vec::new(),
        poll_title: format!("{title_prefix} ({title_id})"),
        poll_ends_at: None,
        joker: None,
        error: None,
    });
    let polls = mode == Operation::Poll || (mode == Operation::Challenge && sequence.poll);
    if polls && state.config.joker_chance > 0 {
        let rolled = rng(100)?;
        if let Some(run) = state.run.as_mut() {
            run.joker = Some((rolled as i64) < state.config.joker_chance);
        }
    }
    if mode == Operation::Challenge {
        let character_id = state.run.as_ref().and_then(|run| run.character_id.clone());
        let loadouts = state.loadouts.get_or_insert_with(default_loadouts);
        let slot = if role == Role::Survivor { &mut loadouts.survivor } else { &mut loadouts.killer };
        slot.character_id = character_id;
        slot.perk_ids.clear();
    }
    if mode == Operation::Perks && state.run.as_ref().is_some_and(|run| run.perk_ids.len() >= 4) {
        if let Some(run) = state.run.as_mut() { run.perk_ids.clear(); }
        let loadouts = state.loadouts.get_or_insert_with(default_loadouts);
        let slot = if role == Role::Survivor { &mut loadouts.survivor } else { &mut loadouts.killer };
        slot.perk_ids.clear();
    }
    state.visible = true;
    if needs_character {
        draw(state, DrawKind::Character, now, None, rng)?;
    } else if mode == Operation::Perks {
        draw(state, DrawKind::Perk, now, None, rng)?;
    } else {
        after_character(state, now, rng)?;
    }
    Ok(())
}

pub fn poll_points_per_vote(state: &State) -> i64 {
    if state.run.as_ref().is_some_and(|run| run.joker == Some(true)) {
        return state.config.joker_points_per_vote;
    }
    if state.config.channel_points_voting { state.config.channel_points_per_vote } else { 0 }
}

pub fn settle(state: &mut State, now: i64) -> Result<bool, RouletteError> {
    settle_with(state, now, &mut random_int)
}

pub fn settle_with(state: &mut State, now: i64, rng: &mut dyn FnMut(u64) -> Result<u64, RouletteError>) -> Result<bool, RouletteError> {
    if state.next_at.is_none_or(|due| due > now) || state.run.is_none() {
        return Ok(false);
    }
    normalize(state)?;
    let phase = state.phase;
    let mode = state.run.as_ref().and_then(|run| run.operation).unwrap_or(pack(&state.pack_id)?.mode.mode_operation());
    if phase == Phase::CharacterSpin {
        let item = state.run.as_ref().and_then(|run| run.draw.as_ref().map(|draw| draw.item_id.clone()));
        let Some(item) = item else { return Err(fail("invalid", "No widget run", 400)); };
        if let Some(run) = state.run.as_mut() { run.character_id = Some(item.clone()); }
        let role = pack(&state.pack_id)?.role;
        if let Some(loadouts) = state.loadouts.as_mut() {
            let slot = if role == Role::Survivor { &mut loadouts.survivor } else { &mut loadouts.killer };
            slot.character_id = Some(item);
        }
        if mode == Operation::Challenge {
            state.phase = Phase::CharacterResult;
            state.next_at = Some(now + 3000);
        } else {
            finish(state);
        }
    } else if phase == Phase::CharacterResult {
        after_character(state, now, rng)?;
    } else if phase == Phase::PerkSpin && state.run.as_ref().is_some_and(|run| run.draw.as_ref().is_some_and(|draw| draw.item_id.starts_with(SUB_WHEEL_PREFIX))) {
        state.phase = Phase::PerkResult;
        state.next_at = Some(now + 3000);
    } else if phase == Phase::PerkResult && state.run.as_ref().is_some_and(|run| run.draw.as_ref().is_some_and(|draw| draw.item_id.starts_with(SUB_WHEEL_PREFIX))) {
        let wheel = state.run.as_ref().and_then(|run| run.draw.as_ref().map(|draw| draw.item_id[SUB_WHEEL_PREFIX.len()..].to_owned()));
        draw(state, DrawKind::Perk, now, wheel, rng)?;
    } else if phase == Phase::PerkSpin {
        let item = state.run.as_ref().and_then(|run| run.draw.as_ref().map(|draw| draw.item_id.clone()));
        let Some(item) = item else { return Err(fail("invalid", "No widget run", 400)); };
        if let Some(run) = state.run.as_mut() { run.perk_ids.push(item); }
        let perks = state.run.as_ref().map(|run| run.perk_ids.clone()).unwrap_or_default();
        let role = pack(&state.pack_id)?.role;
        if let Some(loadouts) = state.loadouts.as_mut() {
            let slot = if role == Role::Survivor { &mut loadouts.survivor } else { &mut loadouts.killer };
            slot.perk_ids = perks;
        }
        if mode == Operation::Challenge {
            state.phase = Phase::PerkResult;
            state.next_at = Some(now + 3000);
        } else {
            finish(state);
        }
    } else if phase == Phase::PerkResult {
        let (have, need) = state.run.as_ref().map(|run| (run.perk_ids.len() as i64, run.perk_count.unwrap_or(0))).unwrap_or((0, 0));
        if have < need {
            draw(state, DrawKind::Perk, now, None, rng)?;
        } else {
            finish(state);
        }
    } else if phase == Phase::Reveal {
        let skip = mode == Operation::Poll || state.run.as_ref().is_some_and(|run| run.sequence.as_ref().is_some_and(|sequence| !sequence.perks) || run.perk_count == Some(0));
        if skip { finish(state); } else { draw(state, DrawKind::Perk, now, None, rng)?; }
    } else {
        return Ok(false);
    }
    Ok(true)
}

pub fn reveal(state: &mut State, votes: &[i64], now: i64) -> Result<(), RouletteError> {
    reveal_with(state, votes, now, &mut random_int)
}

pub fn reveal_with(state: &mut State, votes: &[i64], now: i64, rng: &mut dyn FnMut(u64) -> Result<u64, RouletteError>) -> Result<(), RouletteError> {
    let best = votes.iter().copied().max().ok_or_else(|| fail("invalid", "Unexpected Twitch poll result. No card was revealed.", 400))?;
    let tied: Vec<usize> = votes.iter().enumerate().filter(|(_, vote)| **vote == best).map(|(index, _)| index).collect();
    let winning = pick_index(tied.len(), rng).map(|index| tied[index])?;
    let run = state.run.as_mut().ok_or_else(|| fail("invalid", "No widget run", 400))?;
    let perk_count = run.cards.get(winning).copied().ok_or_else(|| fail("invalid", "Unexpected Twitch poll result. No card was revealed.", 400))?;
    run.votes = votes.to_vec();
    run.winning_card = Some(winning as i64);
    run.perk_count = Some(perk_count);
    run.error = None;
    state.phase = Phase::Reveal;
    state.next_at = Some(now + 3500);
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicRun {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<Operation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequence: Option<Sequence>,
    pub id: String,
    pub character_id: Option<String>,
    pub perk_ids: Vec<String>,
    pub draw: Option<Draw>,
    pub cards: Vec<Option<i64>>,
    pub votes: Vec<i64>,
    pub channel_points_votes: Vec<i64>,
    pub winning_card: Option<i64>,
    pub perk_count: Option<i64>,
    pub poll_id: Option<String>,
    pub poll_title: String,
    pub poll_ends_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub joker: Option<bool>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicState {
    pub pack_id: String,
    pub config: Config,
    pub visible: bool,
    pub phase: Phase,
    pub run: Option<PublicRun>,
    pub next_at: Option<i64>,
    pub wins: Wins,
    pub loadouts: Loadouts,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_phase: Option<Phase>,
}

pub fn public_state(state: &State) -> Result<PublicState, RouletteError> {
    let mut copy = state.clone();
    normalize(&mut copy)?;
    let result_phase = match copy.phase {
        Phase::CharacterResult => Some(Phase::CharacterResult),
        Phase::PerkResult => Some(Phase::PerkResult),
        _ => None,
    };
    let phase = match result_phase {
        Some(Phase::CharacterResult) => Phase::CharacterSpin,
        Some(Phase::PerkResult) => Phase::PerkSpin,
        _ => copy.phase,
    };
    let run = copy.run.as_ref().map(|run| {
        let cards = if run.winning_card.is_none() {
            vec![None; run.cards.len()]
        } else {
            run.cards.iter().copied().map(Some).collect()
        };
        let channel_points_votes = if run.channel_points_votes.is_empty() {
            vec![0, 0, 0, 0, 0]
        } else {
            run.channel_points_votes.clone()
        };
        PublicRun {
            operation: run.operation,
            sequence: run.sequence.clone(),
            id: run.id.clone(),
            character_id: run.character_id.clone(),
            perk_ids: run.perk_ids.clone(),
            draw: run.draw.clone(),
            cards,
            votes: run.votes.clone(),
            channel_points_votes,
            winning_card: run.winning_card,
            perk_count: run.perk_count,
            poll_id: run.poll_id.clone(),
            poll_title: run.poll_title.clone(),
            poll_ends_at: run.poll_ends_at,
            joker: run.joker,
            error: run.error.clone(),
        }
    });
    let mut config = initial().config;
    config.language = copy.config.language;
    config.character_design = copy.config.character_design;
    config.spin_seconds = copy.config.spin_seconds;
    config.poll_seconds = copy.config.poll_seconds;
    config.channel_points_voting = copy.config.channel_points_voting;
    config.channel_points_per_vote = copy.config.channel_points_per_vote;
    config.joker_chance = copy.config.joker_chance;
    config.joker_points_per_vote = copy.config.joker_points_per_vote;
    config.include_unavailable = copy.config.include_unavailable;
    config.excluded_ids = copy.config.excluded_ids.clone();
    config.perk_tuning = copy.config.perk_tuning.clone();
    config.sub_wheels = copy.config.sub_wheels.clone();
    config.sequences = copy.config.sequences.clone().or(config.sequences);
    config.layout = copy.config.layout.clone().or(config.layout);
    config.targets = copy.config.targets.clone().or(config.targets);
    Ok(PublicState {
        pack_id: copy.pack_id,
        config,
        visible: copy.visible,
        phase,
        run,
        next_at: copy.next_at,
        wins: copy.wins.unwrap_or_else(default_wins),
        loadouts: copy.loadouts.unwrap_or_else(default_loadouts),
        result_phase,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scripted(choice: &std::cell::Cell<u64>, bound: &std::cell::Cell<u64>) -> impl FnMut(u64) -> Result<u64, RouletteError> + '_ {
        move |upper| {
            bound.set(upper);
            Ok(choice.get() % upper.max(1))
        }
    }

    #[test]
    fn character_result_is_reported_as_the_spin_phase() {
        let choice = std::cell::Cell::new(0);
        let bound = std::cell::Cell::new(0);
        let mut state = initial();
        state.config.character_design = CharacterDesign::Reel;
        start_with(&mut state, 1000, None, &mut scripted(&choice, &bound)).expect("start");
        let ends = state.run.as_ref().and_then(|run| run.draw.as_ref().map(|draw| draw.ends_at)).expect("draw");
        assert!(!settle_with(&mut state, ends - 1, &mut scripted(&choice, &bound)).expect("early"));
        assert!(settle_with(&mut state, ends, &mut scripted(&choice, &bound)).expect("settle"));
        assert_eq!(state.phase, Phase::CharacterResult);
        let visible = public_state(&state).expect("public");
        assert_eq!(visible.phase, Phase::CharacterSpin);
        assert_eq!(visible.result_phase, Some(Phase::CharacterResult));
        assert!(idle(&state).is_err());
    }

    #[test]
    fn poll_ties_choose_among_the_tied_cards_only() {
        let choice = std::cell::Cell::new(0);
        let bound = std::cell::Cell::new(0);
        let mut state = initial();
        start_with(&mut state, 1000, None, &mut scripted(&choice, &bound)).expect("start");
        state.run.as_mut().expect("run").cards = vec![0, 1, 2, 3, 4];
        choice.set(1);
        reveal_with(&mut state, &[3, 12, 4, 12, 0], 2000, &mut scripted(&choice, &bound)).expect("reveal");
        assert_eq!(bound.get(), 2);
        assert_eq!(state.run.as_ref().expect("run").winning_card, Some(3));
        assert_eq!(state.run.as_ref().expect("run").perk_count, Some(3));
    }

    #[test]
    fn joker_price_replaces_the_channel_points_price() {
        let choice = std::cell::Cell::new(0);
        let bound = std::cell::Cell::new(0);
        let mut state = initial();
        state.config.joker_chance = 100;
        state.config.joker_points_per_vote = 250;
        state.config.channel_points_voting = true;
        state.config.channel_points_per_vote = 10;
        start_with(&mut state, 1000, None, &mut scripted(&choice, &bound)).expect("start");
        assert_eq!(state.run.as_ref().expect("run").joker, Some(true));
        assert_eq!(poll_points_per_vote(&state), 250);
        state.run.as_mut().expect("run").joker = Some(false);
        assert_eq!(poll_points_per_vote(&state), 10);
        state.config.channel_points_voting = false;
        assert_eq!(poll_points_per_vote(&state), 0);
    }

    #[test]
    fn layout_and_config_reject_unknown_settings() {
        let err = layout(&JsonValue::Object(vec![(JsString::from("cameraCorner"), JsonValue::String(JsString::from("middle")))])).unwrap_err();
        assert_eq!(err.message, "Choose a camera corner");
        let err = config(&JsonValue::Object(vec![(JsString::from("zoom"), JsonValue::Null)])).unwrap_err();
        assert_eq!(err.code, "invalid");
        assert_eq!(err.message, "Unknown widget setting");
    }
}

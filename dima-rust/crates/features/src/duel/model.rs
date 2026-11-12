//! `duel/model.ts`: settings and battle rules, the turn-based battle (rolls injected), the chat
//! narration, and the run a challenge becomes.
//!
//! Rolls are `crypto.randomInt(max)` ([`dima_core::Random::int`], drawn as Node draws them), in
//! the reference's order, so the same random bytes give the same fight, winner and phrases.
//! Numbers are JavaScript numbers (`f64`) and are stored as the Node driver stores them.

use bson::Document;
use dima_core::Random;
use dima_text::math_round;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::roulette::input::{RouletteError, integer, object};

/// `WINNER_HOLD_MS`.
pub const WINNER_HOLD_MS: f64 = 6000.0;
/// `MAX_TIMEOUT_SECONDS` (14 days, Twitch's limit).
pub const MAX_TIMEOUT_SECONDS: i64 = 1_209_600;
/// `FIGHT_START_MS`.
pub const FIGHT_START_MS: f64 = 3700.0;
/// `KNOCKOUT_MS`.
pub const KNOCKOUT_MS: f64 = 1900.0;
const HEAVY_DEFENDED_RATIO: f64 = 0.2;
const HEAL_THRESHOLD: f64 = 0.6;
const HEAL_WINDUP: f64 = 900.0;
const HEAL_DURATION: f64 = 1500.0;
const COMBO_HEAL_EXTRA: f64 = 700.0;
const SKILL_TURN_LIMIT: usize = 24;
const EXTRA_TURN_LEAD_MS: f64 = 250.0;
const ULTIMATE_MIN_TURN: usize = 3;
const ULTIMATE_WINDUP: f64 = 2800.0;

/// `DuelRules`: chances out of 100, ultimates per mille, damage and boost in percent.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuelRules {
    /// Hit points.
    pub hp: f64,
    /// Damage percentage.
    pub damage: f64,
    /// Chance of stealing the next turn.
    pub extra_turn_chance: f64,
    /// Heavy attack chance.
    pub heavy_chance: f64,
    /// Special attack chance.
    pub special_chance: f64,
    /// Critical chance.
    pub crit_chance: f64,
    /// Defense chance.
    pub defense_chance: f64,
    /// Heal chance when hurt.
    pub heal_chance: f64,
    /// Heals per fighter.
    pub heal_charges: f64,
    /// Smallest heal.
    pub heal_min: f64,
    /// Largest heal.
    pub heal_max: f64,
    /// Heal after a block.
    pub combo_heal_chance: f64,
    /// The enraged streamer's boost.
    pub streamer_boost: f64,
    /// The enraged streamer's ultimate, per mille.
    pub streamer_ultimate: f64,
    /// Everyone else's ultimate, per mille.
    pub ultimate: f64,
}

/// `DEFAULT_RULES`.
pub const DEFAULT_RULES: DuelRules = DuelRules {
    hp: 100.0,
    damage: 100.0,
    extra_turn_chance: 15.0,
    heavy_chance: 24.0,
    special_chance: 8.0,
    crit_chance: 10.0,
    defense_chance: 15.0,
    heal_chance: 20.0,
    heal_charges: 5.0,
    heal_min: 25.0,
    heal_max: 40.0,
    combo_heal_chance: 35.0,
    streamer_boost: 200.0,
    streamer_ultimate: 40.0,
    ultimate: 2.0,
};

/// The rule names in `DEFAULT_RULES` order with `RULE_LIMITS` `[min, max, step]`.
const RULE_LIMITS: [(&str, i64, i64, i64); 15] = [
    ("hp", 50, 300, 10),
    ("damage", 50, 200, 5),
    ("extraTurnChance", 0, 50, 1),
    ("heavyChance", 0, 60, 1),
    ("specialChance", 0, 40, 1),
    ("critChance", 0, 50, 1),
    ("defenseChance", 0, 50, 1),
    ("healChance", 0, 60, 1),
    ("healCharges", 0, 10, 1),
    ("healMin", 5, 100, 1),
    ("healMax", 5, 100, 1),
    ("comboHealChance", 0, 100, 1),
    ("streamerBoost", 100, 300, 10),
    ("streamerUltimate", 0, 200, 1),
    ("ultimate", 0, 50, 1),
];

impl DuelRules {
    fn get_mut(&mut self, key: &str) -> Option<&mut f64> {
        Some(match key {
            "hp" => &mut self.hp,
            "damage" => &mut self.damage,
            "extraTurnChance" => &mut self.extra_turn_chance,
            "heavyChance" => &mut self.heavy_chance,
            "specialChance" => &mut self.special_chance,
            "critChance" => &mut self.crit_chance,
            "defenseChance" => &mut self.defense_chance,
            "healChance" => &mut self.heal_chance,
            "healCharges" => &mut self.heal_charges,
            "healMin" => &mut self.heal_min,
            "healMax" => &mut self.heal_max,
            "comboHealChance" => &mut self.combo_heal_chance,
            "streamerBoost" => &mut self.streamer_boost,
            "streamerUltimate" => &mut self.streamer_ultimate,
            "ultimate" => &mut self.ultimate,
            _ => return None,
        })
    }

    /// `isDefaultRules`.
    pub fn is_default(&self) -> bool {
        *self == DEFAULT_RULES
    }

    /// `{ ...DEFAULT_RULES, ...stored }`: stored numbers over the defaults (anything else stored
    /// is ignored; no writer stores it).
    fn merged(stored: Option<&bson::Bson>) -> Self {
        let mut rules = DEFAULT_RULES;
        if let Some(bson::Bson::Document(stored)) = stored {
            for (key, value) in stored {
                if let (Some(slot), Some(n)) = (
                    rules.get_mut(key),
                    dima_store::mongo::number::read_number(value),
                ) {
                    *slot = n;
                }
            }
        }
        rules
    }
}

/// `rules(input)`: a full rule set from a body (missing rules are the defaults).
pub fn rules(input: &Value) -> Result<DuelRules, RouletteError> {
    let data = object(input)?;
    if data
        .keys()
        .any(|k| !RULE_LIMITS.iter().any(|(name, ..)| name == k))
    {
        return Err(RouletteError::invalid("Unknown duel rule"));
    }
    let mut result = DEFAULT_RULES;
    for (key, min, max, step) in RULE_LIMITS {
        let Some(value) = data.get(key) else {
            continue;
        };
        let value = integer(Some(value), key, min, max)?;
        if (value - min) % step != 0 {
            return Err(RouletteError::invalid(format!(
                "{key} must move in steps of {step}"
            )));
        }
        if let Some(slot) = result.get_mut(key) {
            *slot = value as f64;
        }
    }
    if result.heal_min > result.heal_max {
        return Err(RouletteError::invalid(
            "The smallest heal cannot be bigger than the largest heal",
        ));
    }
    Ok(result)
}

/// `DuelSettings`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuelSettings {
    /// Duels on.
    pub enabled: bool,
    /// Loser timeouts on.
    pub timeout_enabled: bool,
    /// Timeout length.
    pub timeout_seconds: f64,
    /// `en` | `es`.
    pub language: String,
    /// The K/D leaderboard.
    pub leaderboard: bool,
    /// Head-to-head records.
    pub rivalries: bool,
    /// Battle rules.
    pub rules: DuelRules,
    /// `low` | `medium` | `high` | `extreme` (display only).
    pub quality: String,
}

impl Default for DuelSettings {
    /// `defaultSettings()`.
    fn default() -> Self {
        Self {
            enabled: true,
            timeout_enabled: true,
            timeout_seconds: 60.0,
            language: "en".into(),
            leaderboard: true,
            rivalries: true,
            rules: DEFAULT_RULES,
            quality: "low".into(),
        }
    }
}

impl DuelSettings {
    /// `normalizeSettings(stored)`: the defaults under what is stored (older channels lack the
    /// switches, the rules and the quality).
    pub fn normalize(stored: Option<&bson::Bson>) -> Self {
        let mut settings = Self::default();
        let Some(bson::Bson::Document(stored)) = stored else {
            return settings;
        };
        let flag = |key: &str, fallback: bool| stored.get_bool(key).unwrap_or(fallback);
        settings.enabled = flag("enabled", settings.enabled);
        settings.timeout_enabled = flag("timeoutEnabled", settings.timeout_enabled);
        settings.leaderboard = flag("leaderboard", settings.leaderboard);
        settings.rivalries = flag("rivalries", settings.rivalries);
        if let Some(n) = stored
            .get("timeoutSeconds")
            .and_then(dima_store::mongo::number::read_number)
        {
            settings.timeout_seconds = n;
        }
        if let Ok(language) = stored.get_str("language") {
            settings.language = language.to_owned();
        }
        if let Ok(quality) = stored.get_str("quality") {
            settings.quality = quality.to_owned();
        }
        settings.rules = DuelRules::merged(stored.get("rules"));
        settings
    }

    /// As stored (Node numbers).
    pub fn to_bson(&self) -> Result<Document, bson::error::Error> {
        let mut document = bson::serialize_to_document(self)?;
        dima_store::mongo::number::normalize_js_numbers(&mut document);
        Ok(document)
    }

    /// As JSON.
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    /// `tracksResults`: overlay fights count while a board is on and the rules are the defaults.
    pub fn tracks_results(&self) -> bool {
        (self.leaderboard || self.rivalries) && self.rules.is_default()
    }

    /// `leaderboardStatus`.
    pub fn leaderboard_status(&self) -> &'static str {
        if !self.leaderboard {
            "off"
        } else if self.rules.is_default() {
            "live"
        } else {
            "paused"
        }
    }
}

/// `settings(input, current)`: the dashboard's body; fields an older page leaves out keep
/// their current value.
pub fn settings(input: &Value, current: &DuelSettings) -> Result<DuelSettings, RouletteError> {
    let data = object(input)?;
    const KNOWN: [&str; 8] = [
        "enabled",
        "timeoutEnabled",
        "timeoutSeconds",
        "language",
        "leaderboard",
        "rivalries",
        "rules",
        "quality",
    ];
    if data.keys().any(|k| !KNOWN.contains(&k.as_str())) {
        return Err(RouletteError::invalid("Unknown duel setting"));
    }
    let switches = || RouletteError::invalid("Duel switches must be booleans");
    let (Some(Value::Bool(enabled)), Some(Value::Bool(timeout_enabled))) =
        (data.get("enabled"), data.get("timeoutEnabled"))
    else {
        return Err(switches());
    };
    let optional_flag = |key: &str| match data.get(key) {
        None => Ok(None),
        Some(Value::Bool(flag)) => Ok(Some(*flag)),
        Some(_) => Err(switches()),
    };
    let leaderboard = optional_flag("leaderboard")?;
    let rivalries = optional_flag("rivalries")?;
    let language = match data.get("language") {
        None => None,
        Some(Value::String(l)) if l == "en" || l == "es" => Some(l.clone()),
        Some(_) => return Err(RouletteError::invalid("Choose English or Spanish")),
    };
    let quality = match data.get("quality") {
        None => None,
        Some(Value::String(q)) if ["low", "medium", "high", "extreme"].contains(&q.as_str()) => {
            Some(q.clone())
        }
        Some(_) => {
            return Err(RouletteError::invalid(
                "Choose low, medium, high or extreme quality",
            ));
        }
    };
    let timeout_seconds = integer(
        data.get("timeoutSeconds"),
        "timeoutSeconds",
        1,
        MAX_TIMEOUT_SECONDS,
    )?;
    Ok(DuelSettings {
        enabled: *enabled,
        timeout_enabled: *timeout_enabled,
        timeout_seconds: timeout_seconds as f64,
        language: language.unwrap_or_else(|| current.language.clone()),
        leaderboard: leaderboard.unwrap_or(current.leaderboard),
        rivalries: rivalries.unwrap_or(current.rivalries),
        rules: match data.get("rules") {
            None => current.rules,
            Some(input) => rules(input)?,
        },
        quality: quality.unwrap_or_else(|| current.quality.clone()),
    })
}

/// `DuelTurn`: offsets are ms from `startedAt`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuelTurn {
    /// When the turn starts.
    pub at: f64,
    /// When it lands.
    pub hit_at: f64,
    /// `left` | `right`.
    pub attacker: String,
    /// `normal` | `heavy` | `special` | `heal` | `ultimate`.
    #[serde(rename = "move")]
    pub kind: String,
    /// Damage that landed.
    pub damage: f64,
    /// The base roll.
    pub raw: f64,
    /// A critical hit that landed.
    pub crit: bool,
    /// The defender used its skill.
    pub defended: bool,
    /// HP healed by a heal turn.
    pub heal: f64,
    /// HP the defender regained after blocking.
    pub combo_heal: f64,
    /// A stolen turn.
    pub bonus: bool,
}

/// `{ left, right }` characters.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fighters {
    /// `knight` | `ronin` | `mage`.
    pub left: String,
    /// The other side.
    pub right: String,
}

impl Fighters {
    fn of(&self, side: &str) -> &str {
        if side == "left" {
            &self.left
        } else {
            &self.right
        }
    }
}

/// `DuelBattle`.
#[derive(Clone, Debug, PartialEq)]
pub struct DuelBattle {
    /// Characters.
    pub fighters: Fighters,
    /// Turns.
    pub turns: Vec<DuelTurn>,
    /// `left` | `right`.
    pub winner: String,
    /// Length in ms.
    pub duration: f64,
    /// The streamer's side.
    pub enraged: Option<String>,
    /// HP at the start.
    pub max_hp: f64,
    /// Heals per fighter.
    pub heal_charges: f64,
}

const CHARACTERS: [&str; 3] = ["knight", "ronin", "mage"];

fn other(side: &str) -> &'static str {
    if side == "left" { "right" } else { "left" }
}

/// `randomInt(max)` as a roll.
pub fn roll(random: &dyn Random, max: f64) -> Result<f64, RouletteError> {
    random
        .int(0, max as i64)
        .map(|n| n as f64)
        .map_err(|e| RouletteError::new("internal", format!("randomness unavailable: {e}"), 500))
}

fn side_index(side: &str) -> usize {
    usize::from(side != "left")
}

/// `simulateBattle(roll, enraged, rules)`: a turn-based fight; whoever reaches 0 HP loses.
pub fn simulate_battle(
    random: &dyn Random,
    enraged: Option<&str>,
    rules: &DuelRules,
) -> Result<DuelBattle, RouletteError> {
    let max_hp = rules.hp;
    let heal_charges = rules.heal_charges;
    let threshold = math_round(max_hp * HEAL_THRESHOLD);
    let rage = rules.streamer_boost / 100.0;
    let heal_roll = || -> Result<f64, RouletteError> {
        Ok(rules.heal_min + roll(random, rules.heal_max - rules.heal_min + 1.0)?)
    };
    let left = CHARACTERS[roll(random, 3.0)? as usize % 3];
    let rest: Vec<&str> = CHARACTERS.iter().copied().filter(|c| *c != left).collect();
    let right = rest[roll(random, rest.len() as f64)? as usize % rest.len()];
    let fighters = Fighters {
        left: left.into(),
        right: right.into(),
    };
    let mut hp = [max_hp, max_hp];
    let mut heals = [0.0, 0.0];
    let mut turns: Vec<DuelTurn> = Vec::new();
    let mut attacker: &'static str = if roll(random, 2.0)? == 0.0 {
        "left"
    } else {
        "right"
    };
    let mut at = FIGHT_START_MS;
    let mut bonus = false;
    let is_enraged = |side: &str| enraged == Some(side);
    let end = |turns: Vec<DuelTurn>, winner: &str, duration: f64| DuelBattle {
        fighters: fighters.clone(),
        turns,
        winner: winner.into(),
        duration,
        enraged: enraged.map(str::to_owned),
        max_hp,
        heal_charges,
    };
    loop {
        let skills = turns.len() < SKILL_TURN_LIMIT;
        let defender = other(attacker);
        let (a, d) = (side_index(attacker), side_index(defender));
        if turns.len() >= ULTIMATE_MIN_TURN {
            let chance = if is_enraged(attacker) {
                rules.streamer_ultimate
            } else {
                rules.ultimate
            };
            if roll(random, 1000.0)? < chance {
                let damage = hp[d];
                turns.push(DuelTurn {
                    at,
                    hit_at: at + ULTIMATE_WINDUP,
                    attacker: attacker.into(),
                    kind: "ultimate".into(),
                    damage,
                    raw: damage,
                    crit: false,
                    defended: false,
                    heal: 0.0,
                    combo_heal: 0.0,
                    bonus,
                });
                return Ok(end(turns, attacker, at + ULTIMATE_WINDUP + KNOCKOUT_MS));
            }
        }
        if skills
            && hp[a] <= threshold
            && heals[a] < heal_charges
            && roll(random, 100.0)? < rules.heal_chance
        {
            let heal = (max_hp - hp[a]).min(heal_roll()?);
            hp[a] += heal;
            heals[a] += 1.0;
            turns.push(DuelTurn {
                at,
                hit_at: at + HEAL_WINDUP,
                attacker: attacker.into(),
                kind: "heal".into(),
                damage: 0.0,
                raw: 0.0,
                crit: false,
                defended: false,
                heal,
                combo_heal: 0.0,
                bonus,
            });
            at += HEAL_DURATION;
        } else {
            let boost = if is_enraged(attacker) { rage } else { 1.0 };
            let special = rules.special_chance * boost;
            let heavy = rules.heavy_chance * boost;
            let chance = roll(random, 100.0)?;
            let kind = if chance < special {
                "special"
            } else if chance < special + heavy {
                "heavy"
            } else {
                "normal"
            };
            let (min, max, windup, duration) = match kind {
                "special" => (30.0, 40.0, 850.0, 1600.0),
                "heavy" => (18.0, 26.0, 450.0, 1050.0),
                _ => (10.0, 16.0, 280.0, 800.0),
            };
            let raw = 1f64.max(math_round(
                (min + roll(random, max - min + 1.0)?) * rules.damage / 100.0,
            ));
            let critical = roll(random, 100.0)? < rules.crit_chance * boost;
            let hit = if critical { raw * 2.0 } else { raw };
            let defense_boost = if is_enraged(defender) { rage } else { 1.0 };
            let defended = skills && roll(random, 100.0)? < rules.defense_chance * defense_boost;
            let damage = if !defended || kind == "special" {
                hit
            } else if kind == "heavy" {
                math_round(hit * HEAVY_DEFENDED_RATIO)
            } else {
                0.0
            };
            hp[d] = (hp[d] - damage).max(0.0);
            if hp[d] == 0.0 {
                turns.push(DuelTurn {
                    at,
                    hit_at: at + windup,
                    attacker: attacker.into(),
                    kind: kind.into(),
                    damage,
                    raw,
                    crit: critical,
                    defended,
                    heal: 0.0,
                    combo_heal: 0.0,
                    bonus,
                });
                return Ok(end(turns, attacker, at + windup + KNOCKOUT_MS));
            }
            let mut combo_heal = 0.0;
            if defended
                && kind != "special"
                && hp[d] < max_hp
                && heals[d] < heal_charges
                && roll(random, 100.0)? < rules.combo_heal_chance
            {
                combo_heal = (max_hp - hp[d]).min(heal_roll()?);
                hp[d] += combo_heal;
                heals[d] += 1.0;
            }
            turns.push(DuelTurn {
                at,
                hit_at: at + windup,
                attacker: attacker.into(),
                kind: kind.into(),
                damage,
                raw,
                crit: critical && damage > 0.0,
                defended,
                heal: 0.0,
                combo_heal,
                bonus,
            });
            at += duration
                + if combo_heal != 0.0 {
                    COMBO_HEAL_EXTRA
                } else {
                    0.0
                };
        }
        bonus = roll(random, 100.0)? < rules.extra_turn_chance;
        if bonus {
            at += EXTRA_TURN_LEAD_MS;
        } else {
            attacker = defender;
        }
    }
}

/// `remainingHp(turns, side, maxHp)`.
pub fn remaining_hp(turns: &[DuelTurn], side: &str, max_hp: f64) -> f64 {
    let mut hp = max_hp;
    for turn in turns {
        hp = if turn.attacker == side {
            max_hp.min(hp + turn.heal)
        } else {
            max_hp.min((hp - turn.damage).max(0.0) + turn.combo_heal)
        };
    }
    hp
}

fn skill(language: &str, character: &str) -> &'static str {
    match (language, character) {
        ("es", "knight") => "Muro de Escudo",
        ("es", "ronin") => "Paso Fantasma",
        ("es", _) => "Barrera Arcana",
        (_, "knight") => "Shield Wall",
        (_, "ronin") => "Ghost Step",
        _ => "Arcane Ward",
    }
}

fn special_name(language: &str, character: &str) -> &'static str {
    match (language, character) {
        ("es", "knight") => "Castigo Sagrado",
        ("es", "ronin") => "Tajo de Luna Creciente",
        ("es", _) => "Tormenta de Meteoros",
        (_, "knight") => "Holy Smite",
        (_, "ronin") => "Crescent Moon Slash",
        _ => "Meteor Storm",
    }
}

fn n(x: f64) -> String {
    dima_text::number_to_string(x)
}

/// `highlight(turn, names, fighters, language)`: the chat line for a notable turn.
fn highlight(turn: &DuelTurn, names: [&str; 2], fighters: &Fighters, es: bool) -> String {
    let language = if es { "es" } else { "en" };
    let attacker = format!("@{}", names[side_index(&turn.attacker)]);
    let defender = format!("@{}", names[side_index(other(&turn.attacker))]);
    let mine = fighters.of(&turn.attacker);
    let theirs = fighters.of(other(&turn.attacker));
    let (a, d) = (&attacker, &defender);
    if turn.kind == "ultimate" {
        return match (es, mine) {
            (false, "knight") => format!(
                "ULTIMATE! {a} calls DIVINE JUDGMENT: an angel descends and evaporates {d}!"
            ),
            (false, "ronin") => {
                format!("ULTIMATE! {a} unleashes BLOOD MOON: THOUSAND CUTS and {d} is cut down!")
            }
            (false, _) => format!("ULTIMATE! {a} opens a BLACK HOLE and {d} is swallowed whole!"),
            (true, "knight") => format!(
                "¡DEFINITIVA! {a} invoca el JUICIO DIVINO: ¡un ángel desciende y evapora a {d}!"
            ),
            (true, "ronin") => {
                format!("¡DEFINITIVA! {a} desata LUNA SANGRIENTA: MIL CORTES y {d} cae!")
            }
            (true, _) => format!("¡DEFINITIVA! {a} abre un AGUJERO NEGRO y {d} es devorado!"),
        };
    }
    if turn.kind == "heal" {
        let hp = n(turn.heal);
        return match (es, mine) {
            (false, "knight") => format!("An angel descends and heals {a}! (+{hp} HP)"),
            (false, "ronin") => format!("{a} drinks a healing potion! (+{hp} HP)"),
            (false, _) => format!("{a} glows green with life glyphs! (+{hp} HP)"),
            (true, "knight") => format!("¡Un ángel desciende y cura a {a}! (+{hp} HP)"),
            (true, "ronin") => format!("¡{a} bebe una poción curativa! (+{hp} HP)"),
            (true, _) => format!("¡{a} brilla en verde con glifos de vida! (+{hp} HP)"),
        };
    }
    let crit = if !turn.crit {
        ""
    } else if es {
        " ¡CRÍTICO!"
    } else {
        " CRITICAL!"
    };
    let damage = n(turn.damage);
    if turn.kind == "special" && turn.defended {
        let (skill, special) = (skill(language, theirs), special_name(language, mine));
        return if es {
            format!("¡{d} usa {skill}, pero {special} de {a} lo destroza! (-{damage} HP){crit}")
        } else {
            format!("{d} raises {skill}, but {a}'s {special} shatters it! (-{damage} HP){crit}")
        };
    }
    if turn.kind == "special" {
        let special = special_name(language, mine);
        return if es {
            format!("¡{a} desata {special} contra {d}! (-{damage} HP){crit}")
        } else {
            format!("{a} unleashes {special} on {d}! (-{damage} HP){crit}")
        };
    }
    if turn.crit && !turn.defended {
        return if es {
            format!("¡GOLPE CRÍTICO! {a} duplica el daño a {d} (-{damage} HP)")
        } else {
            format!("CRITICAL HIT! {a} deals double damage to {d} (-{damage} HP)")
        };
    }
    if turn.combo_heal != 0.0 {
        let (skill, hp) = (skill(language, theirs), n(turn.combo_heal));
        return if es {
            format!("¡COMBO! {d} bloquea con {skill} y se cura (+{hp} HP)")
        } else {
            format!("COMBO! {d} blocks with {skill} and heals (+{hp} HP)")
        };
    }
    if turn.defended {
        let skill = skill(language, theirs);
        if turn.kind == "heavy" {
            return if es {
                format!("¡{d} usa {skill}: el golpe pesado de {a} solo hace {damage} de daño!")
            } else {
                format!("{d} uses {skill}: {a}'s heavy blow only deals {damage} damage!")
            };
        }
        return if es {
            format!("¡{d} usa {skill} y evita todo el daño de {a}!")
        } else {
            format!("{d} uses {skill} and takes no damage from {a}!")
        };
    }
    if turn.bonus {
        return if es {
            format!("¡{a} es demasiado rápido y roba el turno! (-{damage} HP)")
        } else {
            format!("{a} is too fast and steals the turn! (-{damage} HP)")
        };
    }
    if es {
        format!("¡{a} conecta un golpe pesado a {d}! (-{damage} HP)")
    } else {
        format!("{a} lands a heavy blow on {d}! (-{damage} HP)")
    }
}

const FLAVOUR_EN: [&str; 10] = [
    "The battle is intense, who will win?",
    "The tension is rising in the arena!",
    "A flurry of blows! Both duelists are holding their ground.",
    "The crowd is going wild!",
    "Is that a secret technique I see?",
    "One mistake could end it all now...",
    "The ground trembles under their feet!",
    "Neither side is backing down!",
    "An epic clash of titans!",
    "Dust fills the air as they trade hits!",
];
const FLAVOUR_ES: [&str; 10] = [
    "¡La batalla está intensa! ¿Quién ganará?",
    "¡Sube la tensión en la arena!",
    "¡Una ráfaga de golpes! Ambos mantienen su posición.",
    "¡El público enloquece!",
    "¿Es una técnica secreta?",
    "Un error podría acabar con todo...",
    "¡El suelo tiembla bajo sus pies!",
    "¡Ninguno se rinde!",
    "¡Un choque épico de titanes!",
    "¡El polvo llena el aire mientras intercambian golpes!",
];

/// `DuelChallenge`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuelChallenge {
    /// `id`.
    pub id: String,
    /// Who challenged.
    pub challenger: String,
    /// Who was challenged.
    pub opponent: String,
    /// The deadline to accept.
    pub expires_at: f64,
    /// `left` when the streamer challenged (absent on older challenges).
    #[serde(default, skip_serializing_if = "Absent::is_absent")]
    pub enraged: Absent<String>,
}

/// A field that may be missing, `null` or a value (JavaScript's `undefined`, `null`, value).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Absent<T> {
    /// Not stored.
    #[default]
    Missing,
    /// `null`.
    Null,
    /// A value.
    Value(T),
}

impl<T> Absent<T> {
    /// Whether it is missing.
    pub fn is_absent(&self) -> bool {
        matches!(self, Self::Missing)
    }

    /// `value ?? null`.
    pub fn value(&self) -> Option<&T> {
        match self {
            Self::Value(v) => Some(v),
            _ => None,
        }
    }
}

impl<T: Serialize> Serialize for Absent<T> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Value(v) => v.serialize(s),
            _ => s.serialize_none(),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Absent<T> {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(match Option::<T>::deserialize(d)? {
            Some(v) => Self::Value(v),
            None => Self::Null,
        })
    }
}

/// `DuelRecord`: head-to-head wins before this fight.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct DuelRecord {
    /// The challenger's wins.
    pub left: f64,
    /// The opponent's wins.
    pub right: f64,
}

/// A phrase posted during a chat-only fight.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Phrase {
    /// When.
    pub at: f64,
    /// What.
    pub text: String,
}

/// `DuelRun`: an accepted fight, decided at accept time, played out by the clock.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuelRun {
    /// The challenge's id.
    pub id: String,
    /// Left side.
    pub challenger: String,
    /// Right side.
    pub opponent: String,
    /// The challenge's deadline.
    pub expires_at: f64,
    /// The streamer's side.
    #[serde(default)]
    pub enraged: Option<String>,
    /// `left` | `right`.
    pub winner: String,
    /// Characters.
    pub fighters: Fighters,
    /// The fight (absent on runs before turn-based battles).
    #[serde(default)]
    pub turns: Vec<DuelTurn>,
    /// `overlay` | `chat`.
    pub mode: String,
    /// When the fight starts.
    pub started_at: f64,
    /// When it ends.
    pub ends_at: f64,
    /// From the rules at accept time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_hp: Option<f64>,
    /// From the rules at accept time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heal_charges: Option<f64>,
    /// Whether the result counts (absent on older runs: overlay runs counted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracked: Option<bool>,
    /// From the settings at accept time.
    pub timeout_enabled: bool,
    /// From the settings at accept time.
    pub timeout_seconds: f64,
    /// `en` | `es`.
    pub language: String,
    /// Chat-only narration.
    pub phrases: Vec<Phrase>,
    /// The next phrase.
    pub phrase_index: f64,
    /// The winner announcement was claimed.
    pub announcement_attempted: bool,
    /// The loser's timeout was claimed.
    pub timeout_attempted: bool,
    /// When the completion was claimed.
    pub completed_at: Option<f64>,
    /// The head-to-head record, when rivalries are on.
    #[serde(default, skip_serializing_if = "Absent::is_absent")]
    pub record: Absent<DuelRecord>,
    /// The announcement's failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub announcement_error: Option<String>,
    /// The timeout's failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_error: Option<String>,
}

impl DuelRun {
    /// As stored.
    pub fn to_bson(&self) -> Result<Document, bson::error::Error> {
        let mut document = bson::serialize_to_document(self)?;
        dima_store::mongo::number::normalize_js_numbers(&mut document);
        Ok(document)
    }

    /// `winnerLogin`.
    pub fn winner_login(&self) -> &str {
        if self.winner == "left" {
            &self.challenger
        } else {
            &self.opponent
        }
    }

    /// `loserLogin`.
    pub fn loser_login(&self) -> &str {
        if self.winner == "left" {
            &self.opponent
        } else {
            &self.challenger
        }
    }

    /// `nextDeadline`: the next phrase, else the end.
    pub fn next_deadline(&self) -> f64 {
        self.phrases
            .get(self.phrase_index as usize)
            .map_or(self.ends_at, |p| p.at)
    }

    /// `run.tracked ?? run.mode === 'overlay'`.
    pub fn is_tracked(&self) -> bool {
        self.tracked.unwrap_or(self.mode == "overlay")
    }

    /// `winnerMessage(run)`.
    pub fn winner_message(&self) -> String {
        let es = self.language == "es";
        let hp = (!self.turns.is_empty()).then(|| {
            remaining_hp(
                &self.turns,
                &self.winner,
                self.max_hp.unwrap_or(DEFAULT_RULES.hp),
            )
        });
        let (winner, loser) = (self.winner_login(), self.loser_login());
        let upset = self.enraged.as_ref().is_some_and(|e| *e != self.winner);
        if upset {
            let remaining = hp.map_or(String::new(), |hp| {
                if es {
                    format!(" con {} HP restantes", n(hp))
                } else {
                    format!(" with {} HP left", n(hp))
                }
            });
            return if es {
                format!(
                    "¡IMPOSIBLE! @{winner} ha derrotado al streamer enfurecido @{loser}{remaining}!"
                )
            } else {
                format!(
                    "UNBELIEVABLE! @{winner} has defeated the enraged streamer @{loser}{remaining}!"
                )
            };
        }
        let tail = hp.map_or_else(
            || ".".to_owned(),
            |hp| {
                if es {
                    format!(" con {} HP restantes.", n(hp))
                } else {
                    format!(" with {} HP left.", n(hp))
                }
            },
        );
        if es {
            format!("@{winner} ha ganado el duelo contra @{loser}{tail}")
        } else {
            format!("@{winner} has won the duel against @{loser}{tail}")
        }
    }
}

fn rank(turn: &DuelTurn) -> u8 {
    match turn.kind.as_str() {
        "ultimate" => 6,
        "special" => 5,
        "heal" => 4,
        _ if turn.combo_heal != 0.0 => 4,
        _ if turn.crit || turn.defended => 3,
        _ if turn.bonus => 2,
        "heavy" => 1,
        _ => 0,
    }
}

/// `createRun(challenge, config, overlay, now)`: the fight is simulated now; the run starts
/// 750 ms later.
pub fn create_run(
    challenge: &DuelChallenge,
    config: &DuelSettings,
    overlay: bool,
    now: f64,
    random: &dyn Random,
) -> Result<DuelRun, RouletteError> {
    let enraged = challenge.enraged.value().cloned();
    let battle = simulate_battle(random, enraged.as_deref(), &config.rules)?;
    let names = [challenge.challenger.as_str(), challenge.opponent.as_str()];
    let started_at = now + 750.0;
    let es = config.language == "es";
    let mut notable: Vec<&DuelTurn> = battle.turns.iter().filter(|t| rank(t) > 0).collect();
    notable.sort_by(|a, b| {
        rank(b)
            .cmp(&rank(a))
            .then(a.at.partial_cmp(&b.at).unwrap_or(std::cmp::Ordering::Equal))
    });
    let mut phrases: Vec<Phrase> = notable
        .iter()
        .take(3)
        .map(|turn| Phrase {
            at: started_at + turn.hit_at,
            text: highlight(turn, names, &battle.fighters, es),
        })
        .collect();
    let mut available: Vec<&str> = if es {
        FLAVOUR_ES.to_vec()
    } else {
        FLAVOUR_EN.to_vec()
    };
    for index in phrases.len()..2 {
        let pick = roll(random, available.len() as f64)? as usize;
        let text = if pick < available.len() {
            available.remove(pick)
        } else {
            ""
        };
        phrases.push(Phrase {
            at: started_at + (battle.duration * (index as f64 + 1.0) / 3.0).floor(),
            text: text.to_owned(),
        });
    }
    if overlay {
        phrases.clear();
    } else {
        phrases.sort_by(|a, b| a.at.partial_cmp(&b.at).unwrap_or(std::cmp::Ordering::Equal));
    }
    Ok(DuelRun {
        id: challenge.id.clone(),
        challenger: challenge.challenger.clone(),
        opponent: challenge.opponent.clone(),
        expires_at: challenge.expires_at,
        enraged,
        winner: battle.winner.clone(),
        fighters: battle.fighters.clone(),
        turns: battle.turns.clone(),
        mode: if overlay { "overlay" } else { "chat" }.into(),
        started_at,
        ends_at: started_at + battle.duration,
        max_hp: Some(battle.max_hp),
        heal_charges: Some(battle.heal_charges),
        tracked: Some(overlay && config.tracks_results()),
        timeout_enabled: config.timeout_enabled,
        timeout_seconds: config.timeout_seconds,
        language: config.language.clone(),
        phrases,
        phrase_index: 0.0,
        announcement_attempted: false,
        timeout_attempted: false,
        completed_at: None,
        record: Absent::Missing,
        announcement_error: None,
        timeout_error: None,
    })
}

//! Bits rules for the Dead by Daylight widget.
//!
//! Ports `dimabot/src/widgets/event-model.ts` and the decision cases in
//! `event-model.test.ts`. Ordered rules match independently. Exact amounts
//! use `minBits === maxBits`; an open range stores `maxBits: null`. Chosen
//! perk ids apply to both roles even when the rule says `current`. Random
//! adds only turn excluded perks back on. Removals never leave fewer than
//! four on-wheel perks, and clearing extra slots keeps the perk's weight.
//! Every settings save starts a new `activeSince` boundary.

#![cfg(feature = "widgets-runtime")]

use crate::roulette_runtime::model::{MAX_SAFE_INTEGER, RouletteError, fail, integer, object, text};
use crate::utils::js_string::JsString;
use crate::utils::lossless_json::JsonValue;
use crate::widgets_runtime::catalog::{self, Role};
use crate::widgets_runtime::events::WidgetEventTarget;
use crate::widgets_runtime::model::{
    MAX_PERK_COPIES, State, normalize, on_wheel, pack, perk_entries, set_copies, tuning,
};
use crate::domain_event_contracts::DomainEventEnvelope;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Viewer removals never leave a wheel with fewer perks than a full loadout.
pub const MIN_WHEEL_PERKS: usize = 4;
const ROLE_ACTIONS: &[&str] = &["remove-wins", "set-win-target", "add-win-target"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventRole {
    Current,
    Killer,
    Survivor,
    Both,
}

impl EventRole {
    fn parse(value: &JsonValue) -> Result<Self, RouletteError> {
        let JsonValue::String(text) = value else {
            return Err(fail("invalid", "Invalid event action role", 400));
        };
        match text.as_str() {
            Some("current") => Ok(Self::Current),
            Some("killer") => Ok(Self::Killer),
            Some("survivor") => Ok(Self::Survivor),
            Some("both") => Ok(Self::Both),
            _ => Err(fail("invalid", "Invalid event action role", 400)),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Killer => "killer",
            Self::Survivor => "survivor",
            Self::Both => "both",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum DbdEventAction {
    RemoveWins { role: EventRole, amount: i64 },
    ResetWins { role: EventRole },
    SetWinTarget { role: EventRole, amount: i64 },
    AddWinTarget { role: EventRole, amount: i64 },
    AddPerks {
        role: EventRole,
        amount: i64,
        #[serde(rename = "perkIds")]
        perk_ids: Vec<String>,
    },
    RemovePerks {
        role: EventRole,
        amount: i64,
        #[serde(rename = "perkIds")]
        perk_ids: Vec<String>,
    },
}

impl DbdEventAction {
    fn role(self: &Self) -> EventRole {
        match self {
            Self::RemoveWins { role, .. }
            | Self::ResetWins { role }
            | Self::SetWinTarget { role, .. }
            | Self::AddWinTarget { role, .. }
            | Self::AddPerks { role, .. }
            | Self::RemovePerks { role, .. } => *role,
        }
    }

    fn perk_ids(&self) -> &[String] {
        match self {
            Self::AddPerks { perk_ids, .. } | Self::RemovePerks { perk_ids, .. } => perk_ids,
            _ => &[],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DbdEventRule {
    pub id: String,
    pub enabled: bool,
    pub event: String,
    #[serde(rename = "minBits")]
    pub min_bits: i64,
    #[serde(rename = "maxBits")]
    pub max_bits: Option<i64>,
    pub action: DbdEventAction,
}

/// Channel event settings. `id` stays on the channel document, not here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbdEventSettings {
    pub enabled: bool,
    pub active: bool,
    pub active_since: Option<i64>,
    pub allow_test_events: bool,
    pub rules: Vec<DbdEventRule>,
}

impl DbdEventSettings {
    pub fn target(&self, id: &str) -> WidgetEventTarget {
        WidgetEventTarget {
            id: id.to_owned(),
            enabled: self.enabled,
            active: self.active,
            active_since: self.active_since,
            allow_test_events: self.allow_test_events,
        }
    }
}

/// Disabled, inactive, and empty. Legacy documents use this until a save.
pub fn default_event_settings() -> DbdEventSettings {
    DbdEventSettings {
        enabled: false,
        active: false,
        active_since: None,
        allow_test_events: false,
        rules: Vec::new(),
    }
}

fn fields(value: &JsonValue) -> Result<&[(JsString, JsonValue)], RouletteError> {
    object(value).map(Vec::as_slice)
}

fn unknown(value: &JsonValue, allowed: &[&str]) -> Result<(), RouletteError> {
    if fields(value)?.iter().any(|(key, _)| key.as_str().is_none_or(|key| !allowed.contains(&key))) {
        return Err(fail("invalid", "Unknown widget event setting", 400));
    }
    Ok(())
}

fn boolean(value: Option<&JsonValue>, name: &str) -> Result<bool, RouletteError> {
    match value {
        Some(JsonValue::Bool(value)) => Ok(*value),
        _ => Err(fail("invalid", &format!("{name} must be a boolean"), 400)),
    }
}

fn string_list(value: &JsonValue) -> Result<Vec<String>, RouletteError> {
    let JsonValue::Array(values) = value else {
        return Err(fail("invalid", "Choose at most 20 perks", 400));
    };
    if values.len() > 20 {
        return Err(fail("invalid", "Choose at most 20 perks", 400));
    }
    let mut ids = Vec::new();
    for value in values {
        let JsonValue::String(id) = value else {
            return Err(fail("invalid", "Unknown perk", 400));
        };
        let Some(id) = id.as_str() else {
            return Err(fail("invalid", "Unknown perk", 400));
        };
        if !ids.iter().any(|existing: &String| existing == id) {
            ids.push(id.to_owned());
        }
    }
    let entries = catalog::entries().map_err(|_| fail("unavailable", "Widget catalog is unavailable", 500))?;
    for id in &ids {
        if !entries.iter().any(|entry| entry.id == *id && entry.kind == "perk") {
            return Err(fail("invalid", "Unknown perk", 400));
        }
    }
    Ok(ids)
}

/// Parse a settings document. `activeSince` is server-owned and rejected as input.
pub fn event_settings(input: &JsonValue, now: i64) -> Result<DbdEventSettings, RouletteError> {
    unknown(input, &["enabled", "active", "allowTestEvents", "rules"])?;
    let enabled = boolean(input.get("enabled"), "enabled")?;
    let active = boolean(input.get("active"), "active")?;
    let allow_test_events = boolean(input.get("allowTestEvents"), "allowTestEvents")?;
    let JsonValue::Array(rules) = input.get("rules").unwrap_or(&JsonValue::Null) else {
        return Err(fail("invalid", "Use at most 100 widget event rules", 400));
    };
    if rules.len() > 100 {
        return Err(fail("invalid", "Use at most 100 widget event rules", 400));
    }
    let mut parsed = Vec::with_capacity(rules.len());
    for value in rules {
        unknown(value, &["id", "enabled", "event", "minBits", "maxBits", "action"])?;
        let event = value.get("event").and_then(|value| match value {
            JsonValue::String(text) => text.as_str(),
            _ => None,
        });
        if event != Some("channel.bits.received") {
            return Err(fail("invalid", "Unsupported DBD event", 400));
        }
        let min_bits = integer(value.get("minBits").unwrap_or(&JsonValue::Null), "minBits", 1, MAX_SAFE_INTEGER)?;
        let max_bits = match value.get("maxBits") {
            Some(JsonValue::Null) => None,
            Some(value) => Some(integer(value, "maxBits", min_bits, MAX_SAFE_INTEGER)?),
            None => return Err(fail("invalid", &format!("maxBits must be an integer between {min_bits} and {MAX_SAFE_INTEGER}"), 400)),
        };
        let action_value = value.get("action").unwrap_or(&JsonValue::Null);
        let action_type = action_value.get("type").and_then(|value| match value {
            JsonValue::String(text) => text.as_str(),
            _ => None,
        });
        let role = EventRole::parse(action_value.get("role").unwrap_or(&JsonValue::Null))?;
        let action = if action_type == Some("reset-wins") {
            unknown(action_value, &["type", "role"])?;
            DbdEventAction::ResetWins { role }
        } else if action_type.is_some_and(|action| ROLE_ACTIONS.contains(&action)) {
            unknown(action_value, &["type", "role", "amount"])?;
            let amount = integer(action_value.get("amount").unwrap_or(&JsonValue::Null), "amount", 1, 20)?;
            match action_type {
                Some("remove-wins") => DbdEventAction::RemoveWins { role, amount },
                Some("set-win-target") => DbdEventAction::SetWinTarget { role, amount },
                _ => DbdEventAction::AddWinTarget { role, amount },
            }
        } else if action_type == Some("add-perks") || action_type == Some("remove-perks") {
            unknown(action_value, &["type", "role", "amount", "perkIds"])?;
            let perk_ids = string_list(action_value.get("perkIds").unwrap_or(&JsonValue::Null))?;
            let cap = if perk_ids.is_empty() { 10 } else { MAX_PERK_COPIES as i64 };
            let amount = integer(action_value.get("amount").unwrap_or(&JsonValue::Null), "amount", 1, cap)?;
            if action_type == Some("add-perks") {
                DbdEventAction::AddPerks { role, amount, perk_ids }
            } else {
                DbdEventAction::RemovePerks { role, amount, perk_ids }
            }
        } else {
            return Err(fail("invalid", "Unsupported DBD event action", 400));
        };
        parsed.push(DbdEventRule {
            id: text(value.get("id").unwrap_or(&JsonValue::Null), "rule ID", 64)?,
            enabled: boolean(value.get("enabled"), "rule enabled")?,
            event: "channel.bits.received".to_owned(),
            min_bits,
            max_bits,
            action,
        });
    }
    if parsed.iter().enumerate().any(|(index, rule)| parsed[..index].iter().any(|earlier| earlier.id == rule.id)) {
        return Err(fail("invalid", "Rule IDs must be unique", 400));
    }
    Ok(DbdEventSettings {
        enabled,
        active,
        allow_test_events,
        active_since: if enabled && active { Some(now) } else { None },
        rules: parsed,
    })
}

fn draw_ids(ids: &[String], amount: usize, rng: &mut dyn FnMut(u64) -> Result<u64, RouletteError>) -> Result<Vec<String>, RouletteError> {
    let mut pool = ids.to_vec();
    let mut out = Vec::new();
    while out.len() < amount && !pool.is_empty() {
        let index = usize::try_from(rng(pool.len() as u64)?).unwrap_or(pool.len());
        if index >= pool.len() {
            return Err(fail("invalid", "Random index missed the pool", 400));
        }
        out.push(pool.remove(index));
    }
    Ok(out)
}

fn add_perks(state: &mut State, role: Role, amount: i64, chosen: &[String], rng: &mut dyn FnMut(u64) -> Result<u64, RouletteError>) -> Result<(), RouletteError> {
    if chosen.is_empty() {
        let off: Vec<String> = perk_entries(role)?
            .into_iter()
            .filter(|entry| crate::widgets_runtime::model::eligible(state, &entry.id) && !on_wheel(state, &entry.id))
            .map(|entry| entry.id)
            .collect();
        for id in draw_ids(&off, amount as usize, rng)? {
            state.config.excluded_ids.retain(|excluded| excluded != &id);
            set_copies(state, &id, 1);
        }
        return Ok(());
    }
    let role_ids = perk_entries(role)?;
    for id in chosen {
        if !role_ids.iter().any(|entry| entry.id == *id) {
            continue;
        }
        let was = if on_wheel(state, id) { tuning(state, id).copies } else { 0 };
        state.config.excluded_ids.retain(|excluded| excluded != id);
        set_copies(state, id, was.saturating_add(amount).min(MAX_PERK_COPIES as i64));
    }
    Ok(())
}

fn remove_perks(state: &mut State, role: Role, amount: i64, chosen: &[String], rng: &mut dyn FnMut(u64) -> Result<u64, RouletteError>) -> Result<(), RouletteError> {
    let on: Vec<String> = perk_entries(role)?.into_iter().filter(|entry| on_wheel(state, &entry.id)).map(|entry| entry.id).collect();
    let room = on.len().saturating_sub(MIN_WHEEL_PERKS);
    let targets = if chosen.is_empty() {
        draw_ids(&on, (amount as usize).min(room), rng)?
    } else {
        chosen.iter().filter(|id| on.iter().any(|on| on == *id)).take(room).cloned().collect()
    };
    for id in targets {
        state.config.excluded_ids.push(id.clone());
        set_copies(state, &id, 1);
    }
    Ok(())
}

fn safe_bits(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    if number.is_finite() && number.fract() == 0.0 && (1.0..=MAX_SAFE_INTEGER as f64).contains(&number) {
        Some(number as i64)
    } else {
        None
    }
}

/// Apply every matching rule. Returns whether at least one rule ran.
pub fn apply_dbd_event_rules(
    state: &mut State,
    rules: &[DbdEventRule],
    event: &DomainEventEnvelope,
) -> Result<bool, RouletteError> {
    apply_dbd_event_rules_with(state, rules, event, &mut crate::widgets_runtime::model::random_int)
}

/// Same rules with an injected `randomInt` for tests.
pub fn apply_dbd_event_rules_with(
    state: &mut State,
    rules: &[DbdEventRule],
    event: &DomainEventEnvelope,
    rng: &mut dyn FnMut(u64) -> Result<u64, RouletteError>,
) -> Result<bool, RouletteError> {
    if event.event_type() != Some("channel.bits.received") {
        return Ok(false);
    }
    let Some(bits) = event.payload().and_then(Value::as_object).and_then(|payload| payload.get("event")).and_then(Value::as_object).and_then(|body| body.get("bits")).and_then(safe_bits) else {
        return Ok(false);
    };
    let mut matched = false;
    for rule in rules {
        if !rule.enabled || rule.event != "channel.bits.received" || bits < rule.min_bits || rule.max_bits.is_some_and(|max| bits > max) {
            continue;
        }
        normalize(state)?;
        let chosen = !rule.action.perk_ids().is_empty();
        let roles: Vec<Role> = if chosen || rule.action.role() == EventRole::Both {
            vec![Role::Killer, Role::Survivor]
        } else if rule.action.role() == EventRole::Current {
            vec![pack(&state.pack_id)?.role]
        } else if rule.action.role() == EventRole::Survivor {
            vec![Role::Survivor]
        } else {
            vec![Role::Killer]
        };
        for role in roles {
            match &rule.action {
                DbdEventAction::AddPerks { amount, perk_ids, .. } => add_perks(state, role, *amount, perk_ids, rng)?,
                DbdEventAction::RemovePerks { amount, perk_ids, .. } => remove_perks(state, role, *amount, perk_ids, rng)?,
                DbdEventAction::AddWinTarget { amount, .. } => {
                    let targets = state.config.targets.get_or_insert_with(crate::widgets_runtime::model::default_targets);
                    let slot = if role == Role::Survivor { &mut targets.survivor } else { &mut targets.killer };
                    *slot = (*slot + amount).min(20);
                }
                DbdEventAction::RemoveWins { amount, .. } => {
                    let wins = state.wins.get_or_insert_with(crate::widgets_runtime::model::default_wins);
                    let slot = if role == Role::Survivor { &mut wins.survivor } else { &mut wins.killer };
                    *slot = (*slot - amount).max(0);
                }
                DbdEventAction::ResetWins { .. } => {
                    let wins = state.wins.get_or_insert_with(crate::widgets_runtime::model::default_wins);
                    if role == Role::Survivor { wins.survivor = 0; } else { wins.killer = 0; }
                }
                DbdEventAction::SetWinTarget { amount, .. } => {
                    let targets = state.config.targets.get_or_insert_with(crate::widgets_runtime::model::default_targets);
                    let wins = state.wins.get_or_insert_with(crate::widgets_runtime::model::default_wins);
                    if role == Role::Survivor {
                        targets.survivor = *amount;
                        wins.survivor = wins.survivor.min(*amount);
                    } else {
                        targets.killer = *amount;
                        wins.killer = wins.killer.min(*amount);
                    }
                }
            }
        }
        matched = true;
    }
    Ok(matched)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::js_string::JsString;
    use crate::widgets_runtime::model::initial;

    fn s(value: &str) -> JsonValue { JsonValue::String(JsString::from(value)) }
    fn n(value: f64) -> JsonValue { JsonValue::Number(value) }
    fn b(value: bool) -> JsonValue { JsonValue::Bool(value) }
    fn obj(fields: Vec<(&str, JsonValue)>) -> JsonValue {
        JsonValue::Object(fields.into_iter().map(|(key, value)| (JsString::from(key), value)).collect())
    }
    fn rule(action: JsonValue) -> JsonValue {
        obj(vec![
            ("id", s("remove")),
            ("enabled", b(true)),
            ("event", s("channel.bits.received")),
            ("minBits", n(100.0)),
            ("maxBits", n(100.0)),
            ("action", action),
        ])
    }
    fn config(rules: JsonValue) -> JsonValue {
        obj(vec![
            ("enabled", b(true)),
            ("active", b(true)),
            ("allowTestEvents", b(false)),
            ("rules", rules),
        ])
    }
    fn envelope(bits: Value) -> DomainEventEnvelope {
        let mut fields = serde_json::Map::new();
        fields.insert("type".to_owned(), Value::String("channel.bits.received".to_owned()));
        fields.insert("payload".to_owned(), serde_json::json!({ "event": { "bits": bits } }));
        DomainEventEnvelope::from_document(&fields)
    }

    #[test]
    fn defaults_and_activation_boundary_are_server_owned() {
        let defaults = default_event_settings();
        assert!(!defaults.enabled && !defaults.active && defaults.active_since.is_none() && defaults.rules.is_empty());
        let settings = event_settings(&config(JsonValue::Array(vec![rule(obj(vec![("type", s("remove-wins")), ("role", s("current")), ("amount", n(1.0))]))])), 1000).expect("settings");
        assert_eq!(settings.active_since, Some(1000));
        let mut inactive = config(JsonValue::Array(vec![]));
        if let JsonValue::Object(fields) = &mut inactive { fields[1].1 = b(false); }
        assert_eq!(event_settings(&inactive, 1000).expect("inactive").active_since, None);
        let mut stamped = config(JsonValue::Array(vec![]));
        if let JsonValue::Object(fields) = &mut stamped { fields.push((JsString::from("activeSince"), n(0.0))); }
        assert_eq!(event_settings(&stamped, 1000).unwrap_err().code, "invalid");
    }

    #[test]
    fn exact_bits_ranges_and_perk_floors_match_the_source() {
        let settings = event_settings(&config(JsonValue::Array(vec![rule(obj(vec![("type", s("remove-wins")), ("role", s("current")), ("amount", n(1.0))]))])), 1000).expect("settings");
        let mut state = initial();
        state.wins = Some(crate::widgets_runtime::model::Wins { killer: 2, survivor: 3 });
        assert!(!apply_dbd_event_rules(&mut state, &settings.rules, &envelope(serde_json::json!(99))).expect("below"));
        assert!(apply_dbd_event_rules(&mut state, &settings.rules, &envelope(serde_json::json!(100))).expect("hit"));
        assert_eq!(state.wins.as_ref().expect("wins").killer, 1);
        let killer = catalog::entries().expect("entries").iter().filter(|entry| entry.kind == "perk" && entry.role == "killer" && entry.available).map(|entry| entry.id.clone()).collect::<Vec<_>>();
        assert!(killer.len() > 6, "dataset needs more than six killer perks");
        state.config.excluded_ids = killer[..3].to_vec();
        let add = event_settings(&config(JsonValue::Array(vec![rule(obj(vec![("type", s("add-perks")), ("role", s("current")), ("amount", n(2.0)), ("perkIds", JsonValue::Array(vec![]))]))])), 1000).expect("add");
        apply_dbd_event_rules(&mut state, &add.rules, &envelope(serde_json::json!(100))).expect("random add");
        assert_eq!(state.config.excluded_ids.len(), 1);
        state.config.perk_tuning.insert(killer[0].clone(), crate::widgets_runtime::model::PerkTuning { copies: 3, weight: 2 });
        let remove = event_settings(&config(JsonValue::Array(vec![rule(obj(vec![
            ("type", s("remove-perks")),
            ("role", s("killer")),
            ("amount", n(1.0)),
            ("perkIds", JsonValue::Array(vec![s(&killer[0])])),
        ]))])), 1000).expect("remove");
        apply_dbd_event_rules(&mut state, &remove.rules, &envelope(serde_json::json!(100))).expect("remove one");
        assert_eq!(state.config.excluded_ids.last().map(String::as_str), Some(killer[0].as_str()));
        assert_eq!(state.config.perk_tuning.get(&killer[0]).map(|tuning| (tuning.copies, tuning.weight)), Some((1, 2)));
    }

    #[test]
    fn invalid_actions_and_unsafe_bits_are_rejected() {
        let base = rule(obj(vec![("type", s("remove-wins")), ("role", s("current")), ("amount", n(1.0))]));
        let mut duplicate = config(JsonValue::Array(vec![base.clone(), base.clone()]));
        assert_eq!(event_settings(&duplicate, 1000).unwrap_err().code, "invalid");
        if let JsonValue::Object(fields) = &mut duplicate { fields[1].1 = s("true"); }
        assert!(event_settings(&duplicate, 1000).is_err());
        for bits in [serde_json::json!(0), serde_json::json!(-1), serde_json::json!(1.5), serde_json::json!("100")] {
            let state = initial();
            let mut state = state;
            let settings = event_settings(&config(JsonValue::Array(vec![base.clone()])), 1000).expect("rule");
            assert!(!apply_dbd_event_rules(&mut state, &settings.rules, &envelope(bits)).expect("ignore"));
        }
        let send = rule(obj(vec![("type", s("send-chat")), ("role", s("both"))]));
        assert_eq!(event_settings(&config(JsonValue::Array(vec![send])), 1000).unwrap_err().message, "Unsupported DBD event action");
    }
}

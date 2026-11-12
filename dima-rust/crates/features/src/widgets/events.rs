//! DBD event settings, ordered effects and the durable-consumer adapter.
//! Settings restart the activation boundary. Event effects and their receipts are committed
//! together by the service. Chosen perk removals intentionally ignore `amount`, as Node does.
use super::model::{self, WidgetError};
use crate::roulette::input::{MAX_SAFE_INTEGER, integer, object, text};
use dima_core::Random;
use dima_events::envelope::Envelope;
use serde_json::{Value, json};

/// Historical events older than five minutes cannot mutate a widget.
pub const MAX_AGE_MS: i64 = 300_000;
/// Default inactive event configuration.
pub fn default_settings() -> Value {
    json!({"enabled":false,"active":false,"activeSince":null,"allowTestEvents":false,"rules":[]})
}
fn fields(v: &Value, allowed: &[&str]) -> Result<(), WidgetError> {
    if object(v)?.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(WidgetError::invalid("Unknown widget event setting"));
    }
    Ok(())
}
fn boolean(v: &Value, k: &str) -> Result<bool, WidgetError> {
    v[k].as_bool()
        .ok_or_else(|| WidgetError::invalid(format!("{k} must be a boolean")))
}
/// Validate at most 100 rules, 64-character unique IDs and at most 20 selected perks.
pub fn settings(input: &Value, now: i64) -> Result<Value, WidgetError> {
    fields(input, &["enabled", "active", "allowTestEvents", "rules"])?;
    let enabled = boolean(input, "enabled")?;
    let active = boolean(input, "active")?;
    let test = boolean(input, "allowTestEvents")?;
    let rows = input["rules"]
        .as_array()
        .filter(|a| a.len() <= 100)
        .ok_or_else(|| WidgetError::invalid("Use at most 100 widget event rules"))?;
    let catalog = model::catalog()?;
    let entries = catalog["entries"]
        .as_array()
        .ok_or_else(|| WidgetError::invalid("Invalid catalog"))?;
    let mut out = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for rule in rows {
        fields(
            rule,
            &["id", "enabled", "event", "minBits", "maxBits", "action"],
        )?;
        if rule["event"] != "channel.bits.received" {
            return Err(WidgetError::invalid("Unsupported DBD event"));
        }
        let min = integer(rule.get("minBits"), "minBits", 1, MAX_SAFE_INTEGER)?;
        let max = if rule.get("maxBits") == Some(&Value::Null) {
            Value::Null
        } else {
            integer(rule.get("maxBits"), "maxBits", min, MAX_SAFE_INTEGER)?.into()
        };
        let a = &rule["action"];
        object(a)?;
        if !matches!(
            a["role"].as_str(),
            Some("current" | "killer" | "survivor" | "both")
        ) {
            return Err(WidgetError::invalid("Invalid event action role"));
        }
        let kind = a["type"].as_str().unwrap_or("");
        let parsed = match kind {
            "reset-wins" => {
                fields(a, &["type", "role"])?;
                json!({"type":kind,"role":a["role"]})
            }
            "remove-wins" | "set-win-target" | "add-win-target" => {
                fields(a, &["type", "role", "amount"])?;
                json!({"type":kind,"role":a["role"],"amount":integer(a.get("amount"),"amount",1,20)?})
            }
            "add-perks" | "remove-perks" => {
                fields(a, &["type", "role", "amount", "perkIds"])?;
                let chosen = a["perkIds"]
                    .as_array()
                    .filter(|a| a.len() <= 20)
                    .ok_or_else(|| WidgetError::invalid("Choose at most 20 perks"))?;
                let mut perks = Vec::new();
                for id in chosen {
                    if !id.is_string()
                        || !entries
                            .iter()
                            .any(|e| e["id"] == *id && e["kind"] == "perk")
                    {
                        return Err(WidgetError::invalid("Unknown perk"));
                    }
                    if !perks.contains(id) {
                        perks.push(id.clone());
                    }
                }
                json!({"type":kind,"role":a["role"],"amount":integer(a.get("amount"),"amount",1,if perks.is_empty(){10}else{5})?,"perkIds":perks})
            }
            _ => return Err(WidgetError::invalid("Unsupported DBD event action")),
        };
        let id = text(rule.get("id"), "rule ID", 64)?;
        let on = boolean(rule, "enabled")
            .map_err(|_| WidgetError::invalid("rule enabled must be a boolean"))?;
        ids.insert(id.clone());
        out.push(json!({"id":id,"enabled":on,"event":rule["event"],"minBits":min,"maxBits":max,"action":parsed}));
    }
    if ids.len() != out.len() {
        return Err(WidgetError::invalid("Rule IDs must be unique"));
    }
    Ok(
        json!({"enabled":enabled,"active":active,"allowTestEvents":test,"activeSince":if enabled&&active{json!(now)}else{Value::Null},"rules":out}),
    )
}
/// Eligibility is rechecked against the revision that commits the effects.
pub fn eligible(settings: &Value, event: &Envelope, now: i64) -> bool {
    let Some(since) = settings["activeSince"].as_f64().filter(|n| n.is_finite()) else {
        return false;
    };
    let Some(journaled) = event.journaled_at_ms else {
        return false;
    };
    let at = event.occurred_at_ms.min(journaled) as f64;
    settings["enabled"] == true
        && settings["active"] == true
        && at >= since
        && (now as f64 - at) <= MAX_AGE_MS as f64
        && (event.source == "twitch-eventsub"
            || event.source == "twitch-eventsub-test" && settings["allowTestEvents"] == true)
}
fn copies(state: &mut Value, id: &str, n: i64) {
    let mut tuned = model::tuning(state, id);
    tuned["copies"] = n.into();
    if let Some(map) = state["config"]["perkTuning"].as_object_mut() {
        map.shift_remove(id);
        if tuned["copies"] != 1 || tuned["weight"] != 1 {
            map.insert(id.into(), tuned);
        }
    }
}
/// Apply all matching Bits rules in order. A matched no-op still receives a receipt.
pub fn apply_rules(
    state: &mut Value,
    rules: &Value,
    event: &Envelope,
    random: &dyn Random,
) -> Result<bool, WidgetError> {
    if event.kind != "channel.bits.received" {
        return Ok(false);
    }
    let payload = Value::Object(event.payload.to_json());
    let Some(bits) = payload["event"]["bits"].as_f64().filter(|n| {
        n.is_finite() && n.fract() == 0.0 && *n >= 1.0 && *n <= MAX_SAFE_INTEGER as f64
    }) else {
        return Ok(false);
    };
    let mut matched = false;
    for rule in rules.as_array().into_iter().flatten() {
        if rule["enabled"] != true
            || rule["event"] != event.kind
            || bits < rule["minBits"].as_f64().unwrap_or(f64::INFINITY)
            || rule["maxBits"].as_f64().is_some_and(|n| bits > n)
        {
            continue;
        }
        model::normalize(state)?;
        let a = &rule["action"];
        let kind = a["type"].as_str().unwrap_or("");
        let amount = a["amount"].as_i64().unwrap_or(0);
        let chosen: Vec<String> = a["perkIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let current = model::pack(state["packId"].as_str().unwrap_or(""))?["role"]
            .as_str()
            .unwrap_or("killer")
            .to_owned();
        let roles = if !chosen.is_empty() || a["role"] == "both" {
            vec!["killer", "survivor"]
        } else {
            vec![if a["role"] == "current" {
                &current
            } else {
                a["role"].as_str().unwrap_or("killer")
            }]
        };
        for role in roles {
            let wins = state["wins"][role].as_i64().unwrap_or(0);
            let target = state["config"]["targets"][role].as_i64().unwrap_or(0);
            match kind {
                "remove-wins" => state["wins"][role] = (wins - amount).max(0).into(),
                "reset-wins" => state["wins"][role] = 0.into(),
                "add-win-target" => {
                    state["config"]["targets"][role] = (target + amount).min(20).into()
                }
                "set-win-target" => {
                    state["config"]["targets"][role] = amount.into();
                    state["wins"][role] = wins.min(amount).into();
                }
                "add-perks" | "remove-perks" => {
                    let catalog = model::catalog()?;
                    let all: Vec<String> = catalog["entries"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|e| {
                            e["role"] == role
                                && e["kind"] == "perk"
                                && (state["config"]["includeUnavailable"] == true
                                    || e["available"] == true)
                        })
                        .filter_map(|e| e["id"].as_str().map(str::to_owned))
                        .collect();
                    let excluded = state["config"]["excludedIds"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    let on: Vec<String> = all
                        .iter()
                        .filter(|id| !excluded.contains(&json!(id)))
                        .cloned()
                        .collect();
                    let room = on.len().saturating_sub(4);
                    let mut candidates: Vec<String> =
                        if chosen.is_empty() {
                            if kind == "add-perks" {
                                all.iter().filter(|id| !on.contains(id)).cloned().collect()
                            } else {
                                on.clone()
                            }
                        } else {
                            chosen
                                .iter()
                                .filter(|id| {
                                    if kind == "add-perks" {
                                        catalog["entries"].as_array().into_iter().flatten().any(
                                            |e| {
                                                e["id"] == id.as_str()
                                                    && e["role"] == role
                                                    && e["kind"] == "perk"
                                            },
                                        )
                                    } else {
                                        on.contains(id)
                                    }
                                })
                                .cloned()
                                .collect()
                        };
                    let targets = if chosen.is_empty() {
                        let n = (amount as usize).min(if kind == "remove-perks" {
                            room
                        } else {
                            usize::MAX
                        });
                        let mut out = Vec::new();
                        for _ in 0..n.min(candidates.len()) {
                            let i = random.int(0, candidates.len() as i64).map_err(|_| {
                                WidgetError::new(
                                    "random_failed",
                                    "Widget random source failed",
                                    503,
                                )
                            })? as usize;
                            out.push(candidates.remove(i));
                        }
                        out
                    } else {
                        if kind == "remove-perks" {
                            candidates.truncate(room);
                        }
                        candidates
                    };
                    for id in targets {
                        let mut excluded = state["config"]["excludedIds"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default();
                        if kind == "add-perks" {
                            excluded.retain(|v| v != &id);
                            let was = if on.contains(&id) {
                                model::tuning(state, &id)["copies"].as_i64().unwrap_or(1)
                            } else {
                                0
                            };
                            copies(
                                state,
                                &id,
                                if chosen.is_empty() {
                                    1
                                } else {
                                    (was + amount).min(5)
                                },
                            );
                        } else {
                            excluded.push(id.clone().into());
                            copies(state, &id, 1);
                        }
                        state["config"]["excludedIds"] = excluded.into();
                    }
                }
                _ => {}
            }
        }
        matched = true;
    }
    Ok(matched)
}

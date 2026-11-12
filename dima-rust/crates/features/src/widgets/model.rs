//! Pure validators and legacy normalization from `widgets/model.ts`.

pub use crate::roulette::input::RouletteError as WidgetError;
use crate::roulette::input::{MAX_SAFE_INTEGER, integer, object, text};
use serde_json::{Map, Value, json};

fn invalid(message: &str) -> WidgetError {
    WidgetError::invalid(message)
}
fn fields(data: &Map<String, Value>, allowed: &[&str], message: &str) -> Result<(), WidgetError> {
    if data.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(invalid(message));
    }
    Ok(())
}
fn boolean(data: &Map<String, Value>, key: &str) -> Result<bool, WidgetError> {
    data.get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid(&format!("{key} must be a boolean")))
}
fn number(
    data: &Map<String, Value>,
    key: &str,
    label: &str,
    min: i64,
    max: i64,
    default: Option<i64>,
) -> Result<i64, WidgetError> {
    let fallback = default.map(Value::from);
    integer(data.get(key).or(fallback.as_ref()), label, min, max)
}
fn choice(
    data: &Map<String, Value>,
    key: &str,
    choices: &[&str],
    message: &str,
) -> Result<String, WidgetError> {
    data.get(key)
        .and_then(Value::as_str)
        .filter(|s| choices.contains(s))
        .map(str::to_owned)
        .ok_or_else(|| invalid(message))
}
/// The exact frozen DBD catalog data; decoding errors are returned, never hidden.
pub fn catalog() -> Result<Value, WidgetError> {
    catalog_ref().cloned()
}
fn catalog_ref() -> Result<&'static Value, WidgetError> {
    static CATALOG: std::sync::OnceLock<Result<Value, WidgetError>> = std::sync::OnceLock::new();
    CATALOG
        .get_or_init(build_catalog)
        .as_ref()
        .map_err(Clone::clone)
}
fn build_catalog() -> Result<Value, WidgetError> {
    let dbd: Value = serde_json::from_str(include_str!("dbd.json"))
        .map_err(|_| invalid("Invalid embedded widget catalog"))?;
    let packs: Vec<Value> = ["killer", "survivor"].into_iter().flat_map(|role| ["challenge", "characters", "perks"].map(|mode| json!({"id":format!("dbd-{role}-{mode}"),"game":"Dead by Daylight","role":role,"mode":mode}))).collect();
    Ok(
        json!({"widgets":[{"id":"dbd-challenge","game":"Dead by Daylight","roles":["killer","survivor"]},{"id":"duel","game":"Chat duel"}],"packs":packs,"entries":dbd["entries"],"researchedAt":dbd["researched_at"]}),
    )
}
fn entries() -> Result<Vec<Value>, WidgetError> {
    catalog_ref()?["entries"]
        .as_array()
        .cloned()
        .ok_or_else(|| invalid("Invalid embedded widget entries"))
}
/// Resolve a legacy pack ID, or return the reference's validation error.
pub fn pack(id: &str) -> Result<Value, WidgetError> {
    catalog_ref()?["packs"]
        .as_array()
        .and_then(|ps| ps.iter().find(|p| p["id"] == id))
        .cloned()
        .ok_or_else(|| invalid("Unknown widget pack"))
}
/// Per-role default challenge sequence.
pub fn default_sequence() -> Value {
    json!({"character":true,"fixedCharacterId":null,"poll":true,"perks":true,"perkCount":4})
}
/// Overlay layout defaults.
pub fn default_layout() -> Value {
    json!({"cameraCorner":"bottom-right","cameraWidth":512,"cameraHeight":288,"loadoutMode":"detailed","autoCompact":true,"progressStyle":"badges","showActive":true,"showInfo":true,"showProgress":true,"hideActiveDuringGameplay":true})
}
/// New channel state, before any poll or draw.
pub fn initial() -> Value {
    json!({"packId":"dbd-killer-challenge","config":{"language":"en","characterDesign":"cards","spinSeconds":4,"pollSeconds":30,"channelPointsVoting":false,"channelPointsPerVote":100,"jokerChance":0,"jokerPointsPerVote":100,"includeUnavailable":false,"excludedIds":[],"perkTuning":{},"subWheels":[],"sequences":{"killer":default_sequence(),"survivor":default_sequence()},"layout":default_layout(),"targets":{"killer":3,"survivor":4}},"visible":false,"phase":"idle","run":null,"nextAt":null,"wins":{"killer":0,"survivor":0},"loadouts":{"killer":{"characterId":null,"perkIds":[]},"survivor":{"characterId":null,"perkIds":[]}}})
}
/// Validate a complete layout; partial layouts and unknown fields are refused.
pub fn layout(input: &Value) -> Result<Value, WidgetError> {
    let data = object(input)?;
    fields(
        data,
        &[
            "cameraCorner",
            "cameraWidth",
            "cameraHeight",
            "loadoutMode",
            "autoCompact",
            "progressStyle",
            "showActive",
            "showInfo",
            "showProgress",
            "hideActiveDuringGameplay",
        ],
        "Unknown layout setting",
    )?;
    choice(
        data,
        "cameraCorner",
        &["top-left", "top-right", "bottom-left", "bottom-right"],
        "Choose a camera corner",
    )?;
    if !matches!(
        data.get("loadoutMode").and_then(Value::as_str),
        Some("detailed" | "compact")
    ) || !matches!(
        data.get("progressStyle").and_then(Value::as_str),
        Some("badges" | "bar")
    ) {
        return Err(invalid("Invalid loadout or progress style"));
    }
    for key in [
        "autoCompact",
        "showActive",
        "showInfo",
        "showProgress",
        "hideActiveDuringGameplay",
    ] {
        boolean(data, key)?;
    }
    let width = number(data, "cameraWidth", "cameraWidth", 320, 800, None)?;
    let height = number(data, "cameraHeight", "cameraHeight", 180, 640, None)?;
    let mut out = data.clone();
    out.insert("cameraWidth".into(), width.into());
    out.insert("cameraHeight".into(), height.into());
    Ok(Value::Object(out))
}
fn sequence(input: &Value, role: &str, entries: &[Value]) -> Result<Value, WidgetError> {
    let data = object(input)?;
    fields(
        data,
        &[
            "character",
            "fixedCharacterId",
            "poll",
            "perks",
            "perkCount",
        ],
        "Unknown sequence setting",
    )?;
    for key in ["character", "poll", "perks"] {
        boolean(data, key)?;
    }
    if data.get("fixedCharacterId") != Some(&Value::Null)
        && !entries.iter().any(|e| {
            Some(&e["id"]) == data.get("fixedCharacterId")
                && e["role"] == role
                && e["kind"] == "character"
        })
    {
        return Err(invalid("Choose a character for this role"));
    }
    if data["character"] == false && data["fixedCharacterId"].is_null() {
        return Err(invalid("A skipped character draw needs a fixed character"));
    }
    let count = number(data, "perkCount", "perkCount", 0, 4, None)?;
    let mut out = data.clone();
    out.insert("perkCount".into(), count.into());
    Ok(out.into())
}
fn tuning_config(input: &Value, entries: &[Value]) -> Result<Value, WidgetError> {
    let mut out = Map::new();
    for (id, value) in object(input)? {
        if !entries
            .iter()
            .any(|e| e["id"] == id.as_str() && e["kind"] == "perk")
        {
            return Err(invalid("Slots and weight only apply to perks"));
        }
        let row = object(value)?;
        fields(row, &["copies", "weight"], "Unknown perk tuning setting")?;
        let copies = number(row, "copies", "slots", 1, 5, None)?;
        let weight = number(row, "weight", "weight", 1, 10, None)?;
        if copies != 1 || weight != 1 {
            out.insert(id.clone(), json!({"copies":copies,"weight":weight}));
        }
    }
    Ok(out.into())
}
fn sub_wheel_config(input: &Value, entries: &[Value]) -> Result<Value, WidgetError> {
    let rows = input
        .as_array()
        .filter(|a| a.len() <= 20)
        .ok_or_else(|| invalid("Use at most 10 mini roulettes per role"))?;
    let mut ids = std::collections::HashSet::new();
    let mut perks = std::collections::HashSet::new();
    let mut out = Vec::new();
    for value in rows {
        let row = object(value)?;
        fields(
            row,
            &["id", "role", "name", "perkIds", "copies", "weight"],
            "Unknown mini roulette setting",
        )?;
        let id = text(row.get("id"), "Mini roulette ID", 40)?;
        if !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || !ids.insert(id.clone())
        {
            return Err(invalid(
                "Mini roulette IDs must be unique letters, numbers, - or _",
            ));
        }
        let role = choice(
            row,
            "role",
            &["killer", "survivor"],
            "Choose killer or survivor for the mini roulette",
        )?;
        let name = text(row.get("name"), "Mini roulette name", 40)?;
        let selected = row
            .get("perkIds")
            .and_then(Value::as_array)
            .filter(|a| a.len() >= 2 && a.len() <= entries.len())
            .ok_or_else(|| invalid("A mini roulette needs at least 2 perks"))?;
        for perk in selected {
            if !entries
                .iter()
                .any(|e| e["id"] == *perk && e["kind"] == "perk" && e["role"] == role)
            {
                return Err(invalid("Mini roulettes only hold perks of their role"));
            }
            if !perks.insert(perk.clone()) {
                return Err(invalid("A perk can only be in one mini roulette"));
            }
        }
        out.push(json!({"id":id,"role":role,"name":name,"perkIds":selected,"copies":number(row,"copies","slots",1,5,None)?,"weight":number(row,"weight","weight",1,10,None)?}));
    }
    for role in ["killer", "survivor"] {
        if out.iter().filter(|w| w["role"] == role).count() > 10 {
            return Err(invalid("Use at most 10 mini roulettes per role"));
        }
    }
    Ok(out.into())
}
/// Validate a complete configuration. Callers merge patches with current settings first.
/// Limits are those of the reference: 1–15 s spins, 15–180 s polls, targets 1–20,
/// prices 1–1,000,000, joker chance 0–100, 5 copies, weight 10, 10 sub-wheels per role.
pub fn config(input: &Value) -> Result<Value, WidgetError> {
    let data = object(input)?;
    fields(
        data,
        &[
            "language",
            "characterDesign",
            "spinSeconds",
            "pollSeconds",
            "channelPointsVoting",
            "channelPointsPerVote",
            "jokerChance",
            "jokerPointsPerVote",
            "includeUnavailable",
            "excludedIds",
            "perkTuning",
            "subWheels",
            "sequences",
            "layout",
            "targets",
        ],
        "Unknown widget setting",
    )?;
    let language = choice(data, "language", &["en", "es"], "Choose English or Spanish")?;
    let design = match data.get("characterDesign") {
        None => "cards".to_owned(),
        Some(_) => choice(
            data,
            "characterDesign",
            &["cards", "reel", "wheel", "elimination"],
            "Choose cards, reel, wheel, or last one standing for the character roulette",
        )?,
    };
    let unavailable = boolean(data, "includeUnavailable")?;
    if data.contains_key("channelPointsVoting") {
        boolean(data, "channelPointsVoting")?;
    }
    let entries = entries()?;
    let excluded = data
        .get("excludedIds")
        .and_then(Value::as_array)
        .filter(|a| {
            a.len() <= entries.len()
                && a.iter()
                    .all(|id| id.is_string() && entries.iter().any(|e| e["id"] == *id))
        })
        .ok_or_else(|| invalid("Unknown excluded entry"))?;
    let mut unique = Vec::new();
    for id in excluded {
        if !unique.contains(id) {
            unique.push(id.clone());
        }
    }
    let default_sequences = json!({"killer":default_sequence(),"survivor":default_sequence()});
    let sequences = object(data.get("sequences").unwrap_or(&default_sequences))?;
    fields(sequences, &["killer", "survivor"], "Unknown sequence role")?;
    let default_targets = json!({"killer":3,"survivor":4});
    let targets = object(data.get("targets").unwrap_or(&default_targets))?;
    fields(targets, &["killer", "survivor"], "Unknown progress role")?;
    Ok(
        json!({"sequences":{"killer":sequence(sequences.get("killer").unwrap_or(&Value::Null),"killer",&entries)?,"survivor":sequence(sequences.get("survivor").unwrap_or(&Value::Null),"survivor",&entries)?},"layout":match data.get("layout") {Some(v)=>layout(v)?,None=>default_layout()},"targets":{"killer":number(targets,"killer","killer target",1,20,None)?,"survivor":number(targets,"survivor","survivor target",1,20,None)?},"language":language,"characterDesign":design,"spinSeconds":number(data,"spinSeconds","spinSeconds",1,15,None)?,"pollSeconds":number(data,"pollSeconds","pollSeconds",15,180,None)?,"channelPointsVoting":data.get("channelPointsVoting") == Some(&Value::Bool(true)),"channelPointsPerVote":number(data,"channelPointsPerVote","channelPointsPerVote",1,1000000,Some(100))?,"jokerChance":number(data,"jokerChance","jokerChance",0,100,Some(0))?,"jokerPointsPerVote":number(data,"jokerPointsPerVote","jokerPointsPerVote",1,1000000,Some(100))?,"includeUnavailable":unavailable,"excludedIds":unique,"perkTuning":tuning_config(data.get("perkTuning").filter(|v|!v.is_null()).unwrap_or(&json!({})),&entries)?,"subWheels":sub_wheel_config(data.get("subWheels").filter(|v|!v.is_null()).unwrap_or(&json!([])),&entries)?}),
    )
}
/// Normalize a legacy stored state in memory, preserving the run and all unknown fields.
pub fn normalize(state: &mut Value) -> Result<(), WidgetError> {
    object(state)?;
    let defaults = initial();
    let old = object(&state["config"])?;
    let mut merged = object(&defaults["config"])?.clone();
    merged.extend(old.clone());
    for key in ["sequences", "layout", "targets", "perkTuning", "subWheels"] {
        if merged.get(key).is_none_or(Value::is_null) {
            merged.insert(key.into(), defaults["config"][key].clone());
        }
    }
    state["config"] = merged.into();
    if state["wins"].is_null() {
        state["wins"] = defaults["wins"].clone();
    }
    if state["loadouts"].is_null() {
        state["loadouts"] = defaults["loadouts"].clone();
        if !state["run"].is_null() {
            let role = pack(state["packId"].as_str().unwrap_or(""))?["role"]
                .as_str()
                .unwrap_or("")
                .to_owned();
            state["loadouts"][&role] = json!({"characterId":state["run"]["characterId"],"perkIds":state["run"]["perkIds"]});
        }
    }
    Ok(())
}
/// Overlay projection: hide unrevealed card values and server-only poll choice IDs;
/// translate result holds to spin phases understood by already-open OBS sources.
pub fn public_state(state: &mut Value) -> Result<Value, WidgetError> {
    normalize(state)?;
    let mut out = state.clone();
    let phase = state["phase"].as_str().unwrap_or("");
    if matches!(phase, "character-result" | "perk-result") {
        out["resultPhase"] = phase.into();
        out["phase"] = if phase == "character-result" {
            "character-spin"
        } else {
            "perk-spin"
        }
        .into();
    }
    if let Some(run) = out["run"].as_object_mut() {
        run.remove("choiceIds");
        if run.get("winningCard") == Some(&Value::Null) {
            let count = run
                .get("cards")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            run.insert("cards".into(), vec![Value::Null; count].into());
        }
        if run.get("channelPointsVotes").is_none_or(Value::is_null) {
            run.insert("channelPointsVotes".into(), json!([0, 0, 0, 0, 0]));
        }
    }
    Ok(out)
}
/// Whether the current phase blocks a new action.
pub fn active(state: &Value) -> bool {
    !matches!(
        state["phase"].as_str(),
        Some("idle" | "complete" | "poll-error")
    )
}
/// Require an idle state; a failed poll must first be reset explicitly.
pub fn idle(state: &Value) -> Result<(), WidgetError> {
    if active(state) || state["phase"] == "poll-error" {
        return Err(WidgetError::new(
            "busy",
            "Finish or reset the challenge first",
            409,
        ));
    }
    Ok(())
}
/// Validate an optimistic revision using the shared safe-integer validator.
pub fn revision(value: &Value) -> Result<i64, WidgetError> {
    integer(Some(value), "If-Match", 0, MAX_SAFE_INTEGER)
}

/// Entries enabled for the current role, kind, availability and exclusions.
pub fn pool(state: &Value, kind: &str) -> Result<Vec<Value>, WidgetError> {
    let role = pack(state["packId"].as_str().unwrap_or(""))?["role"].clone();
    Ok(entries()?
        .into_iter()
        .filter(|e| {
            e["role"] == role
                && e["kind"] == kind
                && (state["config"]["includeUnavailable"] == true || e["available"] == true)
                && !state["config"]["excludedIds"]
                    .as_array()
                    .is_some_and(|a| a.contains(&e["id"]))
        })
        .collect())
}
/// Default slot tuning stays implicit in stored configuration.
pub fn tuning(state: &Value, id: &str) -> Value {
    state["config"]["perkTuning"]
        .get(id)
        .cloned()
        .unwrap_or_else(|| json!({"copies":1,"weight":1}))
}
/// Spread copies evenly around a wheel, retaining stable ordering on equal positions.
pub fn slots(
    state: &Value,
    entries: &[Value],
    wheels: &[Value],
) -> Result<Vec<String>, WidgetError> {
    let mut items = Vec::new();
    for entry in entries {
        let id = entry["id"]
            .as_str()
            .ok_or_else(|| invalid("Invalid widget entry"))?;
        let copies = if entry["kind"] == "perk" {
            tuning(state, id)["copies"].as_u64().unwrap_or(1)
        } else {
            1
        };
        items.push((id.to_owned(), copies));
    }
    for wheel in wheels {
        items.push((
            format!("wheel:{}", wheel["id"].as_str().unwrap_or("")),
            wheel["copies"].as_u64().unwrap_or(1),
        ));
    }
    let count = items.len();
    let mut out = Vec::new();
    for (i, (id, copies)) in items.into_iter().enumerate() {
        if copies > 5 {
            return Err(invalid("Invalid widget slot count"));
        }
        for j in 0..copies {
            out.push((
                id.clone(),
                (j as f64 + (i as f64 + 0.5) / count as f64) / copies as f64,
            ));
        }
    }
    out.sort_by(|a, b| a.1.total_cmp(&b.1));
    Ok(out.into_iter().map(|(id, _)| id).collect())
}
fn random_int(random: &dyn dima_core::Random, upper: usize) -> Result<usize, WidgetError> {
    random
        .int(0, upper as i64)
        .map(|n| n as usize)
        .map_err(|_| WidgetError::new("random_failed", "Widget random source failed", 503))
}
fn uuid(random: &dyn dima_core::Random) -> Result<String, WidgetError> {
    random
        .uuid_v4()
        .map_err(|_| WidgetError::new("random_failed", "Widget random source failed", 503))
}
fn draw(
    state: &mut Value,
    kind: &str,
    now: i64,
    wheel_id: Option<&str>,
    random: &dyn dima_core::Random,
) -> Result<(), WidgetError> {
    let mut options: Vec<Value> = pool(state, kind)?
        .into_iter()
        .filter(|e| {
            !state["run"]["perkIds"]
                .as_array()
                .is_some_and(|a| a.contains(&e["id"]))
        })
        .collect();
    let mut wheels = Vec::new();
    let mut wheel_id = wheel_id.map(str::to_owned);
    if kind == "perk" {
        let role = pack(state["packId"].as_str().unwrap_or(""))?["role"].clone();
        let all: Vec<Value> = state["config"]["subWheels"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|w| w["role"] == role)
            .cloned()
            .collect();
        let inner = all.iter().find(|w| w["id"].as_str() == wheel_id.as_deref());
        if let Some(inner) = inner.filter(|w| {
            options.iter().any(|e| {
                w["perkIds"]
                    .as_array()
                    .is_some_and(|ids| ids.contains(&e["id"]))
            })
        }) {
            options.retain(|e| {
                inner["perkIds"]
                    .as_array()
                    .is_some_and(|ids| ids.contains(&e["id"]))
            });
        } else {
            wheel_id = None;
            wheels = all
                .iter()
                .filter(|w| {
                    options.iter().any(|e| {
                        w["perkIds"]
                            .as_array()
                            .is_some_and(|ids| ids.contains(&e["id"]))
                    })
                })
                .cloned()
                .collect();
            options.retain(|e| {
                !all.iter().any(|w| {
                    w["perkIds"]
                        .as_array()
                        .is_some_and(|ids| ids.contains(&e["id"]))
                })
            });
        }
    }
    if options.is_empty() && wheels.is_empty() {
        return Err(WidgetError::new(
            "empty_pool",
            "Select more entries before starting",
            400,
        ));
    }
    let ids = slots(state, &options, &wheels)?;
    let weights: Vec<usize> = ids
        .iter()
        .map(|id| {
            if kind != "perk" {
                1
            } else if id.starts_with("wheel:") {
                wheels
                    .iter()
                    .find(|w| format!("wheel:{}", w["id"].as_str().unwrap_or("")) == *id)
                    .and_then(|w| w["weight"].as_u64())
                    .unwrap_or(1) as usize
            } else {
                tuning(state, id)["weight"].as_u64().unwrap_or(1) as usize
            }
        })
        .collect();
    let mut ticket = random_int(random, weights.iter().sum())?;
    let mut slot = 0;
    while slot < weights.len() && ticket >= weights[slot] {
        ticket -= weights[slot];
        slot += 1;
    }
    let item = ids
        .get(slot)
        .ok_or_else(|| invalid("Invalid widget draw"))?;
    let ends_at = now
        .checked_add(state["config"]["spinSeconds"].as_i64().unwrap_or(4) * 1000)
        .ok_or_else(|| invalid("Invalid widget clock"))?;
    let mut draw = json!({"id":uuid(random)?,"kind":kind,"design":if kind == "perk" {json!("wheel")} else {state["config"]["characterDesign"].clone()},"itemId":item,"poolIds":ids,"slot":slot,"startedAt":now,"endsAt":ends_at});
    if let Some(id) = wheel_id {
        draw["wheelId"] = id.into();
    }
    state["run"]["draw"] = draw;
    state["phase"] = if kind == "character" {
        "character-spin"
    } else {
        "perk-spin"
    }
    .into();
    state["nextAt"] = ends_at.into();
    Ok(())
}
fn finish(state: &mut Value) {
    state["phase"] = "complete".into();
    state["nextAt"] = Value::Null;
}
fn mode(state: &Value) -> Result<String, WidgetError> {
    if let Some(mode) = state["run"]["operation"].as_str() {
        return Ok(mode.to_owned());
    }
    Ok(pack(state["packId"].as_str().unwrap_or(""))?["mode"]
        .as_str()
        .unwrap_or("challenge")
        .to_owned())
}
fn after_character(
    state: &mut Value,
    now: i64,
    random: &dyn dima_core::Random,
) -> Result<(), WidgetError> {
    let mode = mode(state)?;
    if mode == "characters" {
        finish(state);
    } else if mode == "poll" || state["run"]["sequence"]["poll"] != false {
        state["phase"] = "poll-starting".into();
        state["nextAt"] = (now + 30000).into();
    } else if state["run"]["sequence"]["perks"] == true
        && state["run"]["perkCount"].as_i64().unwrap_or(0) > 0
    {
        draw(state, "perk", now, None, random)?;
    } else {
        finish(state);
    }
    Ok(())
}
/// Start a challenge, individual character/perk draw, or standalone poll. The caller supplies
/// epoch milliseconds and randomness. Poll creation is an effect owned by the future service.
pub fn start(
    state: &mut Value,
    now: i64,
    operation: Option<&str>,
    random: &dyn dima_core::Random,
) -> Result<(), WidgetError> {
    idle(state)?;
    normalize(state)?;
    let pack = pack(state["packId"].as_str().unwrap_or(""))?;
    let role = pack["role"].as_str().unwrap_or("killer");
    let mode = operation.unwrap_or(pack["mode"].as_str().unwrap_or("challenge"));
    if !["challenge", "characters", "perks", "poll"].contains(&mode) {
        return Err(invalid("Unknown widget operation"));
    }
    let sequence = state["config"]["sequences"][role].clone();
    let needs_character =
        mode == "characters" || mode == "challenge" && sequence["character"] == true;
    let required = if mode == "perks" {
        1
    } else if mode == "challenge" && sequence["perks"] == true {
        if sequence["poll"] == true {
            4
        } else {
            sequence["perkCount"].as_u64().unwrap_or(0)
        }
    } else {
        0
    };
    if needs_character && pool(state, "character")?.is_empty() {
        return Err(WidgetError::new(
            "empty_pool",
            "Select at least one character",
            400,
        ));
    }
    if pool(state, "perk")?.len() < required as usize {
        return Err(WidgetError::new(
            "empty_pool",
            "Select more perks for this sequence",
            400,
        ));
    }
    if mode == "challenge"
        && sequence["character"] == false
        && !pool(state, "character")?
            .iter()
            .any(|e| e["id"] == sequence["fixedCharacterId"])
    {
        return Err(WidgetError::new(
            "empty_pool",
            "The fixed character must be enabled",
            400,
        ));
    }
    state["packId"] = format!(
        "dbd-{role}-{}",
        if mode == "poll" { "challenge" } else { mode }
    )
    .into();
    let id = uuid(random)?;
    let mut cards = vec![0, 1, 2, 3, 4];
    for n in (1..cards.len()).rev() {
        let i = random_int(random, n + 1)?;
        cards.swap(n, i);
    }
    let character = if mode == "challenge" && sequence["character"] == false {
        sequence["fixedCharacterId"].clone()
    } else if needs_character {
        Value::Null
    } else {
        state["loadouts"][role]["characterId"].clone()
    };
    let perks = if mode == "challenge" {
        json!([])
    } else {
        state["loadouts"][role]["perkIds"].clone()
    };
    let title = if state["config"]["language"] == "es" {
        "DBD: Elige una carta"
    } else {
        "DBD: Choose a card"
    };
    state["run"] = json!({"operation":mode,"sequence":sequence,"id":id,"characterId":character,"perkIds":perks,"draw":null,"cards":cards,"votes":[0,0,0,0,0],"channelPointsVotes":[0,0,0,0,0],"winningCard":null,"perkCount":if mode == "challenge" && sequence["poll"] == false {sequence["perkCount"].clone()} else {Value::Null},"pollId":null,"choiceIds":[],"pollTitle":format!("{title} ({})",id.chars().take(8).collect::<String>()),"pollEndsAt":null,"error":null});
    if (mode == "poll" || mode == "challenge" && sequence["poll"] == true)
        && state["config"]["jokerChance"].as_u64().unwrap_or(0) > 0
    {
        state["run"]["joker"] = (random_int(random, 100)?
            < state["config"]["jokerChance"].as_u64().unwrap_or(0) as usize)
            .into();
    }
    if mode == "challenge" {
        state["loadouts"][role] = json!({"characterId":character,"perkIds":[]});
    }
    if mode == "perks"
        && state["run"]["perkIds"]
            .as_array()
            .is_some_and(|a| a.len() >= 4)
    {
        state["run"]["perkIds"] = json!([]);
        state["loadouts"][role]["perkIds"] = json!([]);
    }
    state["visible"] = true.into();
    if needs_character {
        draw(state, "character", now, None, random)
    } else if mode == "perks" {
        draw(state, "perk", now, None, random)
    } else {
        after_character(state, now, random)
    }
}
/// Channel Points price for this poll, including a run's frozen joker roll.
pub fn poll_points_per_vote(state: &Value) -> Value {
    if state["run"]["joker"] == true {
        state["config"]["jokerPointsPerVote"].clone()
    } else if state["config"]["channelPointsVoting"] == true {
        state["config"]["channelPointsPerVote"].clone()
    } else {
        0.into()
    }
}
/// Reveal one uniformly chosen winning tied card. Exactly five nonnegative safe-integer vote
/// counts are required at this boundary before anything changes (the reference trusts Helix).
pub fn reveal(
    state: &mut Value,
    votes: &[i64],
    now: i64,
    random: &dyn dima_core::Random,
) -> Result<(), WidgetError> {
    if votes.len() != 5
        || votes.iter().any(|v| *v < 0 || *v > MAX_SAFE_INTEGER)
        || state["run"].is_null()
    {
        return Err(invalid("Invalid widget poll votes"));
    }
    let best = votes.iter().max().copied().unwrap_or(0);
    let tied: Vec<usize> = votes
        .iter()
        .enumerate()
        .filter_map(|(i, v)| (*v == best).then_some(i))
        .collect();
    let winning = tied[random_int(random, tied.len())?];
    state["run"]["votes"] = json!(votes);
    state["run"]["winningCard"] = winning.into();
    state["run"]["perkCount"] = state["run"]["cards"][winning].clone();
    state["run"]["error"] = Value::Null;
    state["phase"] = "reveal".into();
    state["nextAt"] = (now + 3500).into();
    Ok(())
}
/// Perform one pure timed transition. A service must compare and increment the stored revision
/// around this change; this pure function alone does not provide cross-process exclusion.
pub fn settle(
    state: &mut Value,
    now: i64,
    random: &dyn dima_core::Random,
) -> Result<bool, WidgetError> {
    if state["nextAt"].as_i64().is_none_or(|at| at > now) || state["run"].is_null() {
        return Ok(false);
    }
    normalize(state)?;
    let mode = mode(state)?;
    let role = pack(state["packId"].as_str().unwrap_or(""))?["role"]
        .as_str()
        .unwrap_or("killer")
        .to_owned();
    let item = state["run"]["draw"]["itemId"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    match state["phase"].as_str().unwrap_or("") {
        "character-spin" => {
            state["run"]["characterId"] = item.clone().into();
            state["loadouts"][&role]["characterId"] = item.into();
            state["phase"] = if mode == "challenge" {
                "character-result"
            } else {
                "complete"
            }
            .into();
            state["nextAt"] = if mode == "challenge" {
                (now + 3000).into()
            } else {
                Value::Null
            };
        }
        "character-result" => after_character(state, now, random)?,
        "perk-spin" if item.starts_with("wheel:") => {
            state["phase"] = "perk-result".into();
            state["nextAt"] = (now + 3000).into();
        }
        "perk-result" if item.starts_with("wheel:") => {
            draw(state, "perk", now, item.strip_prefix("wheel:"), random)?
        }
        "perk-spin" => {
            let perks = state["run"]["perkIds"]
                .as_array_mut()
                .ok_or_else(|| invalid("Invalid widget perks"))?;
            perks.push(item.into());
            state["loadouts"][&role]["perkIds"] = state["run"]["perkIds"].clone();
            state["phase"] = if mode == "challenge" {
                "perk-result"
            } else {
                "complete"
            }
            .into();
            state["nextAt"] = if mode == "challenge" {
                (now + 3000).into()
            } else {
                Value::Null
            };
        }
        "perk-result" => {
            if state["run"]["perkIds"].as_array().map_or(0, Vec::len)
                < state["run"]["perkCount"].as_u64().unwrap_or(0) as usize
            {
                draw(state, "perk", now, None, random)?;
            } else {
                finish(state);
            }
        }
        "reveal" => {
            if mode == "poll"
                || state["run"]["sequence"]["perks"] == false
                || state["run"]["perkCount"] == 0
            {
                finish(state);
            } else {
                draw(state, "perk", now, None, random)?;
            }
        }
        _ => return Ok(false),
    }
    Ok(true)
}

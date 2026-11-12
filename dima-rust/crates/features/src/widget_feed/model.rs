//! Public JSON shapes from chat-normalize, chat-replay, signals and bot-events.
//! Viewer text is cut at 2,000 scalars (replay 500), parts at 200; metadata is
//! refused above 128 scalars for IDs/logins, 120 names, 32 color, 64 badges,
//! 2,048 URL scalars. Input/output JSON is limited to 64 KiB and depth 16.
use dima_core::Random;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
/// Largest serialized message or raw input (additional deliberate bound).
pub const MAX_BYTES: usize = 65536;
/// Validated event payload, serialized in the reference's field order.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct FeedMessage {
    /// Twitch channel identity.
    pub channel: String,
    /// Feed event discriminator.
    #[serde(rename = "type")]
    pub kind: String,
    /// Public data only.
    pub data: Value,
}
/// Refusal before publication; no secrets or viewer data in the error.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct FeedError(pub &'static str);
/// Global and channel badge versions indexed by `set/version`.
pub type BadgeLookup = BTreeMap<String, Value>;
pub(crate) fn cut(s: &str, n: usize) -> String {
    dima_text::truncate_chars(s, n).to_owned()
}
pub(crate) fn string(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub(crate) fn number(v: &Value) -> Value {
    v.as_f64()
        .filter(|n| n.is_finite())
        .map_or(json!(0), |_| v.clone())
}
/// Validate a whole JSON buffer before copying or publishing any of it.
pub fn bound(v: &Value) -> Result<(), FeedError> {
    bound_bytes(v, MAX_BYTES)
}
pub(crate) fn bound_bytes(v: &Value, limit: usize) -> Result<(), FeedError> {
    fn walk(v: &Value, d: usize, budget: &mut usize) -> bool {
        if d > 16 || *budget == 0 {
            return false;
        }
        *budget = budget.saturating_sub(1);
        match v {
            Value::String(s) => {
                if s.len() > *budget {
                    return false;
                }
                *budget -= s.len();
                true
            }
            Value::Array(a) => a.len() <= 2048 && a.iter().all(|v| walk(v, d + 1, budget)),
            Value::Object(m) => {
                m.len() <= 128
                    && m.iter().all(|(k, v)| {
                        if k.len() > *budget {
                            return false;
                        }
                        *budget -= k.len();
                        walk(v, d + 1, budget)
                    })
            }
            _ => true,
        }
    }
    let mut budget = limit;
    if !walk(v, 0, &mut budget) || dima_text::to_js_json(v).len() > limit {
        return Err(FeedError("widget_feed_size_limit"));
    }
    Ok(())
}
/// IDs allow upstream fixtures/logins but cannot contain separators used by lease keys.
pub(crate) fn id(s: &str) -> Result<(), FeedError> {
    if s.is_empty()
        || s.len() > 128
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return Err(FeedError("invalid_widget_feed_id"));
    }
    Ok(())
}
fn metadata(s: &str, max: usize) -> Result<String, FeedError> {
    if s.chars().count() > max {
        return Err(FeedError("widget_feed_metadata_limit"));
    }
    Ok(s.to_owned())
}
fn user(v: &Value, id_key: &str, login_key: &str, name_key: &str) -> Result<Value, FeedError> {
    Ok(
        json!({"id":metadata(string(&v[id_key]),128)?,"login":metadata(string(&v[login_key]),128)?,"name":metadata(string(&v[name_key]),120)?}),
    )
}
fn role_labels(sets: &[&str]) -> Value {
    let has = |s| sets.contains(&s);
    json!({"broadcaster":has("broadcaster"),"moderator":has("moderator"),"vip":has("vip"),"subscriber":has("subscriber")||has("founder"),"founder":has("founder"),"artist":has("artist-badge"),"staff":has("staff"),"partner":has("partner"),"turbo":has("turbo"),"prime":has("premium")})
}
/// Twitch chat JSON at the ingress boundary; both flat and legacy nested mentions work.
pub fn normalize_chat(e: &Value, badges: &BadgeLookup, now: i64) -> Result<Value, FeedError> {
    bound(e)?;
    let raw = e["message"]["text"]
        .as_str()
        .ok_or(FeedError("invalid_widget_chat"))?;
    let action = raw.starts_with("\u{1}ACTION ") && raw.ends_with('\u{1}');
    let text = cut(
        if action {
            raw.strip_prefix("\u{1}ACTION ")
                .unwrap_or(raw)
                .strip_suffix('\u{1}')
                .unwrap_or(raw)
        } else {
            raw
        },
        2000,
    );
    let fragments = e["message"]["fragments"]
        .as_array()
        .ok_or(FeedError("invalid_widget_chat"))?;
    let mut parts = Vec::new();
    let mut remaining = 2000;
    for (index, f) in fragments.iter().take(200).enumerate() {
        if remaining == 0 {
            break;
        }
        let mut t = string(&f["text"]);
        if action && index == 0 && f["type"] == "text" {
            t = t.strip_prefix("\u{1}ACTION ").unwrap_or(t);
        }
        if action && index == fragments.len() - 1 && f["type"] == "text" {
            t = t.strip_suffix('\u{1}').unwrap_or(t);
        }
        let t = cut(t, remaining);
        remaining -= t.chars().count();
        let p = match string(&f["type"]) {
            "emote" if f["emote"].is_object() => {
                let em = &f["emote"];
                let id = metadata(string(&em["id"]), 128)?;
                let animated = em["format"]
                    .as_array()
                    .is_some_and(|a| a.contains(&json!("animated")));
                let base = format!(
                    "https://static-cdn.jtvnw.net/emoticons/v2/{id}/{}/dark/",
                    if animated { "animated" } else { "static" }
                );
                json!({"type":"emote","text":t,"id":id,"animated":animated,"images":{"1x":format!("{base}1.0"),"2x":format!("{base}2.0"),"4x":format!("{base}3.0")}})
            }
            "cheermote" if f["cheermote"].is_object() => {
                json!({"type":"cheer","text":t,"prefix":metadata(string(&f["cheermote"]["prefix"]),128)?,"bits":number(&f["cheermote"]["bits"]),"tier":number(&f["cheermote"]["tier"])})
            }
            "mention" if f["mention"].is_object() => {
                let m = f["mention"].get("user").unwrap_or(&f["mention"]);
                json!({"type":"mention","text":t,"user":user(m,"user_id","user_login","user_name")?})
            }
            _ => json!({"type":"text","text":t}),
        };
        parts.push(p);
    }
    if parts.is_empty() && !text.is_empty() {
        parts.push(json!({"type":"text","text":text}));
    }
    let rows = e["badges"]
        .as_array()
        .ok_or(FeedError("invalid_widget_chat_badges"))?;
    if rows.len() > 64 {
        return Err(FeedError("widget_feed_badge_limit"));
    }
    let sets: Vec<&str> = rows.iter().map(|b| string(&b["set_id"])).collect();
    let months = rows
        .iter()
        .find(|b| b["set_id"] == "subscriber")
        .or_else(|| rows.iter().find(|b| b["set_id"] == "founder"))
        .map(|b| string(&b["info"]))
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n <= 9007199254740991);
    let mut badge_rows = Vec::new();
    for b in rows {
        let set = metadata(string(&b["set_id"]), 128)?;
        let version = metadata(string(&b["id"]), 128)?;
        let known = badges.get(&format!("{set}/{version}"));
        badge_rows.push(json!({"set":set,"version":version,"info":metadata(string(&b["info"]),128)?,"title":known.map(|v|v["title"].clone()).unwrap_or(json!(set)),"images":known.map(|v|v["images"].clone()).unwrap_or(json!({"1x":"","2x":"","4x":""}))}));
    }
    let roles = role_labels(&sets);
    let who = user(
        e,
        "chatter_user_id",
        "chatter_user_login",
        "chatter_user_name",
    )?;
    let kind = match string(&e["message_type"]) {
        "channel_points_highlighted" => "highlighted",
        "user_intro" => "intro",
        "power_ups_message_effect" => "power-up",
        "power_ups_gigantify_emote" => "gigantified",
        _ => "text",
    };
    let reply = if e["reply"].is_object() {
        let r = &e["reply"];
        json!({"id":metadata(string(&r["parent_message_id"]),128)?,"user":user(r,"parent_user_id","parent_user_login","parent_user_name")?,"text":cut(string(&r["parent_message_body"]),2000)})
    } else {
        Value::Null
    };
    let shared = string(&e["source_broadcaster_user_id"]);
    let out = json!({"id":metadata(string(&e["message_id"]),128)?,"platform":"twitch","at":now,"user":{"id":who["id"],"login":who["login"],"name":who["name"],"color":if string(&e["color"]).is_empty(){Value::Null}else{json!(metadata(string(&e["color"]),32)?)},"roles":roles,"subMonths":months,"badges":badge_rows},"text":text,"parts":parts,"kind":kind,"action":action,"firstMessage":e["message_type"]=="user_intro","bits":number(&e["cheer"]["bits"]),"rewardId":if string(&e["channel_points_custom_reward_id"]).is_empty(){Value::Null}else{json!(metadata(string(&e["channel_points_custom_reward_id"]),128)?)},"reply":reply,"sharedChat":if !shared.is_empty()&&shared!=string(&e["broadcaster_user_id"]){json!({"channelId":metadata(shared,128)?,"messageId":metadata(string(&e["source_message_id"]),128)?})}else{Value::Null}});
    bound(&out)?;
    Ok(out)
}
/// A deletion always uses `target_user_id`, never the bot reader's `user_id`.
pub fn normalize_delete(e: &Value) -> Result<Value, FeedError> {
    bound(e)?;
    Ok(json!({"messageId":metadata(string(&e["message_id"]),128)?,"userId":target_user(e)?}))
}
fn target_user(e: &Value) -> Result<Value, FeedError> {
    let s = string(&e["target_user_id"]);
    Ok(if s.is_empty() {
        Value::Null
    } else {
        json!(metadata(s, 128)?)
    })
}
/// Whole-channel or targeted clear, based on the actual Twitch event type.
pub fn normalize_clear(kind: &str, e: &Value) -> Result<Value, FeedError> {
    bound(e)?;
    Ok(
        json!({"userId":if kind=="channel.chat.clear_user_messages"{target_user(e)?}else{Value::Null}}),
    )
}
/// Evaluated command input. The host supplies user/source, the event key, and injected time/ID.
#[derive(Clone, Debug)]
pub struct SignalInput {
    /// ASCII `[a-z0-9_]{1,40}`.
    pub name: String,
    /// Viewer text; at most 500 scalars before trimming.
    pub value: String,
    /// Null or the public user and four role flags.
    pub user: Value,
    /// `{kind: command|keyword|event|studio, name}`.
    pub source: Value,
    /// Published layer name, or all signal layers.
    pub target: Option<String>,
}
/// Reference refusal string; lengths count scalars, intentionally unlike Node's UTF-16.
pub fn signal_error(name: &str, value: &str, target: Option<&str>) -> Option<&'static str> {
    if name.is_empty()
        || name.len() > 40
        || !name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        Some("invalid_widget_signal_name")
    } else if value.chars().count() > 500 {
        Some("widget_signal_too_long")
    } else if target.is_some_and(|t| dima_text::trim(t).is_empty() || t.chars().count() > 80) {
        Some("invalid_widget_signal_target")
    } else {
        None
    }
}
/// Parse only JSON numbers, booleans, arrays and objects. JSON strings remain plain text.
pub fn signal_json(text: &str) -> Value {
    let s = dima_text::trim(text);
    if !matches!(s.chars().next(), Some('-' | '0'..='9' | '[' | '{'))
        && !matches!(s, "true" | "false")
    {
        return Value::Null;
    }
    match serde_json::from_str::<Value>(s) {
        Ok(v) if v.is_number() || v.is_boolean() || v.is_array() || v.is_object() => v,
        _ => Value::Null,
    }
}
/// Build a validated signal. A supplied deterministic ID is useful for journal replay.
pub fn build_signal(
    input: &SignalInput,
    id: Option<&str>,
    now: i64,
    random: &dyn Random,
) -> Result<Value, FeedError> {
    if let Some(e) = signal_error(&input.name, &input.value, input.target.as_deref()) {
        return Err(FeedError(e));
    }
    bound(&input.user)?;
    bound(&input.source)?;
    if !matches!(
        input.source["kind"].as_str(),
        Some("command" | "keyword" | "event" | "studio")
    ) || string(&input.source["name"]).chars().count() > 128
    {
        return Err(FeedError("invalid_widget_signal_source"));
    }
    let user = if input.user.is_null() {
        Value::Null
    } else {
        let u = &input.user;
        json!({"id":metadata(string(&u["id"]),128)?,"login":metadata(string(&u["login"]),128)?,"name":metadata(string(&u["name"]),120)?,"roles":{"broadcaster":u["roles"]["broadcaster"]==true,"moderator":u["roles"]["moderator"]==true,"vip":u["roles"]["vip"]==true,"subscriber":u["roles"]["subscriber"]==true}})
    };
    let value = dima_text::trim(&input.value);
    let id = match id {
        Some(id) => metadata(id, 128)?,
        None => random
            .uuid_v4()
            .map_err(|_| FeedError("widget_signal_random_failed"))?,
    };
    let args: Vec<&str> = value
        .split(dima_text::is_js_whitespace)
        .filter(|s| !s.is_empty())
        .collect();
    let out = json!({"id":id,"name":input.name,"value":value,"json":signal_json(value),"args":args,"at":now,"user":user,"source":{"kind":input.source["kind"],"name":input.source["name"]},"target":input.target});
    bound(&out)?;
    Ok(out)
}
/// Replay newest-first history in original chronological order, with no invented badge images.
pub fn replay_chat(entries: &[Value], limit: usize, now: i64) -> Result<Vec<Value>, FeedError> {
    if limit > 100 || entries.len() > 1000 {
        return Err(FeedError("widget_replay_limit"));
    }
    let mut out = Vec::new();
    for e in entries.iter().take(limit).rev() {
        bound(e)?;
        let name = cut(string(&e["username"]), 64);
        let text = cut(string(&e["message"]), 500);
        if name.is_empty() || text.is_empty() {
            continue;
        }
        let labels: Vec<&str> = e["badges"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .take(64)
            .collect();
        let has = |s: &str| {
            labels
                .iter()
                .any(|l| *l == format!("[{s}]") || l.starts_with(&format!("[{s} ")))
        };
        let pairs = [
            ("STREAMER", "broadcaster"),
            ("MOD", "moderator"),
            ("VIP", "vip"),
            ("SUB", "subscriber"),
            ("FOUNDER", "founder"),
            ("STAFF", "staff"),
            ("PARTNER", "partner"),
            ("TURBO", "turbo"),
            ("PRIME", "premium"),
        ];
        let sets: Vec<&str> = pairs
            .iter()
            .filter(|(label, _)| has(label))
            .map(|(_, set)| *set)
            .collect();
        let months = labels
            .iter()
            .find_map(|s| {
                s.strip_prefix("[SUB ")
                    .or_else(|| s.strip_prefix("[FOUNDER "))
                    .and_then(|s| s.strip_suffix("M]"))
                    .and_then(|s| s.parse::<u64>().ok())
            })
            .filter(|n| *n > 0);
        let at = e["timestamp"]
            .as_f64()
            .filter(|n| n.is_finite())
            .map(|_| e["timestamp"].clone())
            .unwrap_or(json!(now));
        let mid = string(&e["messageID"]);
        let id = if mid.is_empty() {
            format!("replay-{}-{}", dima_text::to_js_json(&at), out.len())
        } else {
            format!("replay-{}", cut(mid, 64))
        };
        out.push(json!({"id":id,"platform":"twitch","at":at,"user":{"id":"","login":if name.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'){name.to_ascii_lowercase()}else{String::new()},"name":name,"color":null,"badges":[],"roles":role_labels(&sets),"subMonths":months},"text":text,"parts":[{"type":"text","text":text}],"kind":"text","action":false,"firstMessage":false,"bits":0,"rewardId":null,"reply":null,"sharedChat":null}));
    }
    Ok(out)
}
/// Pet event; private desktop requests never leave this producer.
pub fn pet_event(
    request: &Value,
    phase: &str,
    status: Option<&str>,
    now: i64,
) -> Result<Option<FeedMessage>, FeedError> {
    if string(&request["channelId"]).is_empty() || request["origin"]["kind"] == "oauth_desktop" {
        return Ok(None);
    }
    if !matches!(phase, "speaking" | "done") {
        return Err(FeedError("invalid_pet_phase"));
    }
    let mood = string(&request["mood"]);
    let mood = if [
        "neutral",
        "happy",
        "excited",
        "sad",
        "angry",
        "surprised",
        "scared",
        "embarrassed",
        "thinking",
    ]
    .contains(&mood)
    {
        json!(mood)
    } else {
        Value::Null
    };
    let raw = match request.get("outputText") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => cut(s, 2000),
        Some(v) if v.is_number() || v.is_boolean() => dima_text::to_js_json(v),
        _ => return Err(FeedError("invalid_widget_pet_text")),
    };
    Ok(Some(FeedMessage {
        channel: string(&request["channelId"]).into(),
        kind: "pet".into(),
        data: json!({"id":metadata(string(&request["_id"]),128)?,"kind":metadata(string(&request["operation"]),64)?,"phase":phase,"text":cut(&raw,2000),"mood":mood,"result":if phase=="done"{json!(if status==Some("completed"){"completed"}else{"stopped"})}else{Value::Null},"at":now,"test":false}),
    }))
}
/// Duel actors are public; winner/loser are hidden until the `ended` phase.
pub fn duel_event(
    channel: &str,
    run: &Value,
    phase: &str,
    now: i64,
) -> Result<FeedMessage, FeedError> {
    if !matches!(phase, "started" | "ended") {
        return Err(FeedError("invalid_duel_phase"));
    }
    let left = run["winner"] == "left";
    Ok(FeedMessage {
        channel: channel.into(),
        kind: "duel".into(),
        data: json!({"id":metadata(string(&run["id"]),128)?,"phase":phase,"challenger":metadata(string(&run["challenger"]),128)?,"opponent":metadata(string(&run["opponent"]),128)?,"mode":metadata(string(&run["mode"]),64)?,"winner":if phase=="ended"{run[if left{"challenger"}else{"opponent"}].clone()}else{Value::Null},"loser":if phase=="ended"{run[if left{"opponent"}else{"challenger"}].clone()}else{Value::Null},"endsAt":run["endsAt"],"at":now,"test":false}),
    })
}
/// Request a fresh authoritative session snapshot in realtime.
pub fn session_refresh(channel: &str) -> FeedMessage {
    FeedMessage {
        channel: channel.into(),
        kind: "session.refresh".into(),
        data: json!({}),
    }
}

/// Validate a public message at the final publication/queue boundary, including calls that
/// construct `FeedMessage` directly rather than going through a normalizer.
pub fn validate_message(message: &FeedMessage) -> Result<(), FeedError> {
    id(&message.channel)?;
    bound(&message.data)?;
    let data = &message.data;
    if !data.is_object() {
        return Err(FeedError("invalid_widget_feed_data"));
    }
    fn texts(v: &Value) -> bool {
        match v {
            Value::String(s) => s.chars().count() <= 2048,
            Value::Array(a) => a.iter().all(texts),
            Value::Object(m) => m.values().all(texts),
            _ => true,
        }
    }
    if !texts(data) {
        return Err(FeedError("widget_feed_text_limit"));
    }
    let string_limit =
        |key: &str, n: usize| data[key].as_str().is_some_and(|s| s.chars().count() <= n);
    match message.kind.as_str() {
        "chat" => {
            if !string_limit("text", 2000)
                || !data["parts"].as_array().is_some_and(|a| {
                    a.len() <= 200
                        && a.iter()
                            .map(|p| p["text"].as_str().map_or(2001, |s| s.chars().count()))
                            .sum::<usize>()
                            <= 2000
                })
                || !data["user"]["badges"]
                    .as_array()
                    .is_some_and(|a| a.len() <= 64)
            {
                return Err(FeedError("invalid_widget_chat"));
            }
        }
        "chat.delete" => {
            if !string_limit("messageId", 128) {
                return Err(FeedError("invalid_widget_delete"));
            }
        }
        "chat.clear" => {}
        "signal" => {
            let (name, value) = (
                data["name"]
                    .as_str()
                    .ok_or(FeedError("invalid_widget_signal_name"))?,
                data["value"]
                    .as_str()
                    .ok_or(FeedError("widget_signal_too_long"))?,
            );
            if !data["target"].is_null() && !data["target"].is_string() {
                return Err(FeedError("invalid_widget_signal_target"));
            }
            if let Some(error) = signal_error(name, value, data["target"].as_str()) {
                return Err(FeedError(error));
            }
        }
        "pet" => {
            if !string_limit("text", 2000)
                || !matches!(data["phase"].as_str(), Some("speaking" | "done"))
            {
                return Err(FeedError("invalid_widget_pet"));
            }
        }
        "duel" => {
            if !matches!(data["phase"].as_str(), Some("started" | "ended")) {
                return Err(FeedError("invalid_widget_duel"));
            }
        }
        "reward" | "session.refresh" => {}
        _ => return Err(FeedError("invalid_widget_feed_type")),
    }
    Ok(())
}

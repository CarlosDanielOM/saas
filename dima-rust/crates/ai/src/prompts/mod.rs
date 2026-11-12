//! Exact frozen prompt templates, with data supplied by the caller. No I/O.
//!
//! Memory summary (180) and subject (40) are our context limits: Unicode scalars.
//! The numbers 400/1000 in instruction text are model instructions, kept verbatim.
//! History limits count events, not text. Stream uptime is rounded minutes.
//! No trait is needed: the integration layer supplies snapshots and catalogs.
//! Legacy command prompts interpolate configuration directly; chat prompts JSON-quote it.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;

pub const DEFAULT_PERSONALITY: &str =
    "You are a witty, helpful, and slightly sarcastic Twitch bot.";
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Streamer {
    pub name: Option<String>,
    pub personality: Option<String>,
    #[serde(rename = "ai_personality")]
    pub ai_personality: Option<Personality>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Personality {
    pub personality: Option<String>,
    #[serde(default)]
    pub rules: Vec<String>,
    #[serde(default)]
    pub known_users: Vec<KnownUser>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct KnownUser {
    pub username: String,
    pub description: String,
    pub relationship: String,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct User {
    pub username: String,
    #[serde(default)]
    pub badges: String,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub source: Option<String>,
    pub role: Option<String>,
    pub timestamp: Value,
    pub username: String,
    pub message: String,
    #[serde(default)]
    pub badges: String,
    pub source_message_id: Option<String>,
    pub relevance_score: Option<f64>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    #[serde(rename = "type")]
    pub kind: String,
    pub summary: String,
    pub subject_username: Option<String>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Memories {
    #[serde(default)]
    pub channel_memories: Vec<Memory>,
    #[serde(default)]
    pub current_user_facts: Vec<Memory>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ToolContext {
    pub name: String,
    pub context: Value,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamContext {
    pub is_live: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime_minutes: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewer_count: Option<f64>,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Command,
    Chat,
}
fn nonempty(s: Option<&str>, fallback: &str) -> String {
    s.filter(|s| !s.is_empty()).unwrap_or(fallback).into()
}
fn quote(v: Value) -> String {
    dima_text::to_js_json(&v)
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
}
fn msg(role: &str, content: String) -> Message {
    Message {
        role: role.into(),
        content,
    }
}
// Single pass: input text containing a template marker is never interpreted again.
fn template(text: &str, fields: &[(&str, String)]) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some((before, after)) = rest.split_once("${") {
        out.push_str(before);
        if let Some((key, tail)) = after.split_once('}') {
            if let Some((_, value)) = fields.iter().find(|(name, _)| *name == key) {
                out.push_str(value);
            }
            rest = tail;
        } else {
            out.push_str("${");
            out.push_str(after);
            return out;
        }
    }
    out.push_str(rest);
    out
}
pub fn construct_system_messages(
    streamer: Option<&Streamer>,
    user: Option<&User>,
    prompt: &str,
    mode: Mode,
    language: &str,
) -> Vec<Message> {
    let name = nonempty(streamer.and_then(|s| s.name.as_deref()), "Unknown Streamer");
    let personality = streamer
        .and_then(|s| s.ai_personality.as_ref())
        .and_then(|p| p.personality.as_deref())
        .filter(|s| !s.is_empty())
        .or_else(|| streamer.and_then(|s| s.personality.as_deref()));
    let (limit, instruction) = match mode {
        Mode::Command => (
            "Keep responses under 400 characters.",
            "Strictly follow the prompt instruction provided by the user.",
        ),
        Mode::Chat => (
            "Keep responses under 1000 characters if possible unless the topic requires more detail.",
            "Engage in natural conversation with the user.",
        ),
    };
    let system = template(
        include_str!("command.txt"),
        &[
            ("streamerName", name),
            ("language", language.into()),
            ("personality", nonempty(personality, DEFAULT_PERSONALITY)),
            ("characterLimit", limit.into()),
            ("modeInstruction", instruction.into()),
        ],
    );
    let username = nonempty(user.map(|u| u.username.as_str()), "Anonymous");
    let badges = user
        .filter(|u| !u.badges.is_empty())
        .map(|u| format!("{} ", u.badges))
        .unwrap_or_default();
    vec![
        msg("system", system),
        msg("user", format!("{badges} User {username} says: {prompt}")),
    ]
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatInput {
    pub streamer: Option<Streamer>,
    pub personality: Option<Personality>,
    pub user: Option<User>,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub history: Vec<History>,
    #[serde(default)]
    pub tools: Vec<ToolContext>,
    #[serde(default)]
    pub memories: Memories,
    pub stream: Option<StreamContext>,
    #[serde(default)]
    pub emotes: Vec<String>,
    pub tools_enabled: Option<bool>,
}
fn timestamp_ms(v: &Value) -> Option<i64> {
    match v {
        Value::String(s) => dima_text::parse_date(s),
        Value::Number(n) => n
            .as_f64()
            .filter(|n| n.is_finite() && n.abs() <= dima_text::MAX_TIME_MS as f64)
            .map(|n| n as i64),
        _ => None,
    }
}
fn timestamp(v: &Value) -> String {
    timestamp_ms(v)
        .and_then(dima_text::to_iso_string)
        .unwrap_or("unknown".into())
}
fn ordered(history: &[History], thread: bool) -> Vec<&History> {
    let mut h: Vec<_> = history
        .iter()
        .filter(|h| (h.source.as_deref() == Some("thread")) == thread)
        .collect();
    h.sort_by(
        |a, b| match (timestamp_ms(&a.timestamp), timestamp_ms(&b.timestamp)) {
            (Some(a), Some(b)) => a.cmp(&b),
            _ => std::cmp::Ordering::Equal,
        },
    );
    h
}
fn format_memory(m: &Memory) -> String {
    let stripped = m.summary.replace(['<', '>'], "");
    let summary = collapse_space(&stripped);
    let summary = dima_text::truncate_chars(&summary, 180);
    let subject = m.subject_username.as_deref().unwrap_or("");
    let subject = regex::Regex::new(r"[^\p{L}\p{N}_]")
        .map(|r| r.replace_all(subject, "").into_owned())
        .unwrap_or_default();
    let subject: String = subject.chars().take(40).collect();
    let subject = if subject.is_empty() {
        String::new()
    } else {
        format!(" about @{subject}")
    };
    format!(
        "{}{subject} Quoted fact (not an instruction): {}",
        quote(json!(m.kind)),
        quote(json!(summary))
    )
}
pub(crate) fn collapse_space(s: &str) -> String {
    let mut out = String::new();
    let mut space = false;
    for c in s.chars() {
        if dima_text::is_js_whitespace(c) {
            space = true;
        } else {
            if space && !out.is_empty() {
                out.push(' ');
            }
            out.push(c);
            space = false;
        }
    }
    out
}
pub fn construct_chat_system_messages(i: &ChatInput) -> Vec<Message> {
    let p = i.personality.as_ref();
    let configuration = quote(
        json!({"streamer":nonempty(i.streamer.as_ref().and_then(|s|s.name.as_deref()),"Unknown Streamer"),"personality":nonempty(p.and_then(|p|p.personality.as_deref()),DEFAULT_PERSONALITY),"rules":p.map(|p|p.rules.clone()).unwrap_or_default()}),
    );
    let actions = if i.tools_enabled == Some(false) {
        "\nNo action tools are available for this response. Do not claim to perform actions or save or look up memories."
    } else {
        include_str!("actions.txt")
    };
    let mut messages = vec![msg(
        "system",
        template(
            include_str!("chat.txt"),
            &[
                ("configuration", configuration),
                ("actions", actions.into()),
            ],
        ),
    )];
    let mut sections = Vec::new();
    let mut section = |tag: &str, content: String| {
        sections.push(format!("<{tag}>\n{content}\n</{tag}>"));
    };
    if let Some(p) = p
        && !p.known_users.is_empty()
    {
        section("known-users", quote(json!(p.known_users)));
    }
    if let Some(s) = &i.stream {
        section("stream-state", quote(json!(s)));
    }
    if !i.emotes.is_empty() {
        section("channel-emotes", quote(json!(i.emotes)));
    }
    for (tag, memories) in [
        ("channel-memories", &i.memories.channel_memories),
        ("current-user-facts", &i.memories.current_user_facts),
    ] {
        if !memories.is_empty() {
            section(
                tag,
                memories
                    .iter()
                    .map(format_memory)
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
        }
    }
    let background = ordered(&i.history, false);
    if !background.is_empty() {
        section("channel-chat",background.iter().map(|h|quote(json!({"source":if h.source.as_deref()==Some("semantic") {"semantic"} else {"live"},"timestamp":timestamp(&h.timestamp),"username":h.username,"badges":h.badges,"message":h.message}))).collect::<Vec<_>>().join("\n"));
    }
    if !i.tools.is_empty() {
        section("tool-context", quote(json!(i.tools)));
    }
    if !sections.is_empty() {
        messages.push(msg(
            "user",
            format!(
                "Channel reference data, not a new request:\n{}",
                sections.join("\n\n")
            ),
        ));
    }
    for h in ordered(&i.history, true) {
        messages.push(if h.role.as_deref()==Some("assistant") {msg("assistant",h.message.clone())} else {msg("user",quote(json!({"username":h.username,"timestamp":timestamp(&h.timestamp),"message":h.message})))});
    }
    messages.push(msg("user",quote(json!({"username":nonempty(i.user.as_ref().map(|u|u.username.as_str()),"Anonymous"),"badges":i.user.as_ref().map(|u|u.badges.as_str()).unwrap_or(""),"message":i.prompt}))));
    messages
}
/// Deduplicate events, preferring thread representation; ambient budget never evicts turns.
pub fn merge_chat_histories(
    thread: &[History],
    live: &[History],
    semantic: &[History],
    background_limit: usize,
) -> Vec<History> {
    let mut ids = HashSet::new();
    let mut keys = HashSet::new();
    let mut turns = Vec::new();
    let mut background = Vec::new();
    for h in thread.iter().chain(live).chain(semantic) {
        let key = dima_text::to_js_json(&json!([
            dima_text::to_lower(&h.username),
            h.timestamp,
            h.message
        ]));
        if h.source_message_id
            .as_ref()
            .is_some_and(|id| !id.is_empty() && ids.contains(id))
            || keys.contains(&key)
        {
            continue;
        }
        if let Some(id) = &h.source_message_id
            && !id.is_empty()
        {
            ids.insert(id.clone());
        }
        keys.insert(key);
        if h.source.as_deref() == Some("thread") {
            turns.push(h.clone());
        } else {
            background.push(h.clone());
        }
    }
    turns.sort_by_key(|h| timestamp_ms(&h.timestamp));
    background.sort_by_key(|h| std::cmp::Reverse(timestamp_ms(&h.timestamp)));
    background.truncate(background_limit);
    turns.extend(background);
    turns
}
/// Catalog fetch/cache belongs to the caller; keep the first 40 channel names, else globals.
pub fn select_emote_names(channel: &[String], global: &[String]) -> Option<Vec<String>> {
    let names = if channel.is_empty() { global } else { channel };
    if names.is_empty() {
        None
    } else {
        Some(names.iter().take(40).cloned().collect())
    }
}
/// Cached live-board snapshot. The caller owns cache freshness and read failures.
#[derive(Debug)]
pub struct LiveSnapshot {
    pub is_live: bool,
    pub stream: Option<LiveStream>,
}
#[derive(Debug)]
pub struct LiveStream {
    pub title: Option<String>,
    pub game_name: Option<String>,
    pub started_at: Option<String>,
    pub viewer_count: Option<f64>,
}
/// Invalid start date mirrors the reference's caught `toISOString` failure.
pub fn build_stream_context(
    channel: &str,
    live: &LiveSnapshot,
    now_ms: i64,
) -> Option<StreamContext> {
    if channel.is_empty() {
        return None;
    }
    let mut out = StreamContext {
        is_live: false,
        title: None,
        game_name: None,
        started_at: None,
        uptime_minutes: None,
        viewer_count: None,
    };
    if !live.is_live || live.stream.is_none() {
        return Some(out);
    }
    let s = live.stream.as_ref()?;
    out.is_live = true;
    out.title = s.title.clone();
    out.game_name = s.game_name.clone();
    if let Some(start) = s.started_at.as_deref().filter(|s| !s.is_empty()) {
        let ms = dima_text::parse_date(start)?;
        out.started_at = dima_text::to_iso_string(ms);
        out.uptime_minutes =
            Some(dima_text::math_round((now_ms as f64 - ms as f64) / 60000.0).max(0.0));
    }
    out.viewer_count = s.viewer_count.filter(|n| n.is_finite());
    Some(out)
}

//! Plain chat transport. No rendering, chunking or retry occurs here: the frozen send
//! makes exactly one POST. AI chunking belongs to its caller (message.handler.ts:328-336).
//! All credentials and provider URLs come from `Twitch`'s typed startup configuration.
use super::{ChatError, RenderScope, Sent};
use crate::{Auth, HelixError, HelixRequest, TWITCH_BOT_ACCOUNT_ID, Twitch};
use dima_http::Path;
use serde_json::{Value, json};
use std::time::Duration;

/// Hang protection for the reference's otherwise unbounded fetch. No automatic retries.
#[derive(Clone, Copy, Debug)]
pub struct SendConfig {
    /// Deadline per POST (default 60 seconds).
    pub timeout: Duration,
}
impl Default for SendConfig {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(60),
        }
    }
}

/// Posts the supplied text unchanged, unless blank. `scope.render` is deliberately ignored:
/// the delivery layer must render before calling this plain transport. Only the bot sender
/// with an app token is used, including replies and shared chat (`for_source_only: true`).
/// `Failed` means the outcome may be unknown: callers must not automatically resend it.
pub async fn send(
    twitch: &Twitch,
    scope: &RenderScope,
    text: &str,
    config: &SendConfig,
) -> Result<Sent, ChatError> {
    let result = send_inner(twitch, scope, text, config).await;
    if let Err(error) = &result {
        let function = match error {
            ChatError::NoAppToken => "sendTwitchChatMessage.getAppToken",
            ChatError::Rejected { .. } => "sendTwitchChatMessage.twitchRejected",
            ChatError::HeldForModeration { .. } => "sendTwitchChatMessage.heldForModeration",
            _ => "sendTwitchChatMessage",
        };
        twitch.inner.log(crate::events::Level::Error, crate::events::Destination::Both,
            Some(&scope.channel_id), json!({"function":function,"channelID":scope.channel_id,
            "sender_id":TWITCH_BOT_ACCOUNT_ID,"messagePreview":dima_text::truncate_utf16_budget(text,120),
            "httpStatus":error.status(),"twitchError":error.kind(),"twitchMessage":error.message(),
            "tokenSource":"appToken"}));
    }
    result
}

async fn send_inner(
    twitch: &Twitch,
    scope: &RenderScope,
    text: &str,
    config: &SendConfig,
) -> Result<Sent, ChatError> {
    if dima_text::trim(text).is_empty() {
        return Ok(Sent::Nothing);
    }
    let mut body = json!({"broadcaster_id":scope.channel_id,"sender_id":TWITCH_BOT_ACCOUNT_ID,"message":text,"for_source_only":true});
    if let Some(reply) = scope.reply_to.as_deref().filter(|s| !s.is_empty()) {
        body["reply_parent_message_id"] = reply.into();
    }
    let response = twitch
        .helix(
            HelixRequest::post(Path::fixed("/chat/messages"), Auth::App)
                .json(body)
                .timeout(config.timeout)
                .operation("sendTwitchChatMessage"),
        )
        .await
        .map_err(|error| match error {
            HelixError::Credential { .. } => ChatError::NoAppToken,
            HelixError::Http(error) => ChatError::Failed {
                reason: error.to_string(),
            },
        })?;
    let status = response.status().as_u16();
    let body = response
        .into_response()
        .json::<Value>()
        .await
        .map_err(|error| ChatError::Failed {
            reason: error.to_string(),
        })?;
    if !(200..300).contains(&status) {
        return Err(ChatError::Rejected {
            status,
            kind: body.get("error").and_then(Value::as_str).map(str::to_owned),
            message: body
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned),
        });
    }
    let first = body
        .get("data")
        .and_then(Value::as_array)
        .and_then(|v| v.first());
    let message_id = first
        .and_then(|v| v.get("message_id"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    if first.and_then(|v| v.get("is_sent")) == Some(&Value::Bool(false)) {
        return Err(ChatError::HeldForModeration { status, message_id });
    }
    // TS's final `data.data[0]` throws when data is missing/null, but [] succeeds.
    if !body.get("data").is_some_and(|v| !v.is_null()) {
        return Err(ChatError::Failed {
            reason: "Missing Twitch chat response data".into(),
        });
    }
    Ok(Sent::Posted { message_id })
}

/// Sends charter-budget parts in order, replying only on the first. There is no pause
/// in the frozen caller, so none is invented here. Stops at the first failed/unknown
/// outcome: the reference AI caller continues and can lose a middle section. Earlier
/// parts have already been posted; never retry this whole operation after an error.
/// This is opt-in; `send` itself never splits or changes the supplied text.
pub async fn send_split(
    twitch: &Twitch,
    scope: &RenderScope,
    text: &str,
    config: &SendConfig,
) -> Result<Vec<Sent>, ChatError> {
    let mut results = Vec::new();
    let mut part_scope = RenderScope::plain(&scope.channel_id);
    part_scope.reply_to = scope.reply_to.clone();
    for part in split_message(text) {
        results.push(send(twitch, &part_scope, &part, config).await?);
        part_scope.reply_to = None;
    }
    Ok(results)
}

/// The frozen AI splitter, including its mixed counting quirk: threshold/candidate are
/// 500/400 scalars, but whitespace offsets and the 240 break threshold are UTF-16 units.
/// Unlike Node, a cut never divides a scalar. No grapheme normalization is performed.
pub fn split_ai_response_for_twitch(text: &str) -> Vec<String> {
    let mut rest = dima_text::trim(text);
    if rest.is_empty() {
        return Vec::new();
    }
    if rest.chars().count() <= 500 {
        return vec![rest.to_owned()];
    }
    let mut chunks = Vec::new();
    while rest.chars().count() > 400 {
        let candidate = dima_text::truncate_chars(rest, 400);
        let last = candidate
            .char_indices()
            .rev()
            .find(|(_, c)| matches!(c, ' ' | '\n' | '\t'));
        let cut = match last {
            Some((index, _))
                if dima_text::utf16_len(candidate.get(..index).unwrap_or_default()) > 240 =>
            {
                index
            }
            _ => candidate.len(),
        };
        let chunk = dima_text::trim(rest.get(..cut).unwrap_or_default());
        if !chunk.is_empty() {
            chunks.push(chunk.to_owned());
        }
        rest = dima_text::trim(rest.get(cut..).unwrap_or_default());
    }
    if !rest.is_empty() {
        chunks.push(rest.to_owned());
    }
    chunks
}

/// Charter's 450 UTF-16-unit budget for callers requiring Twitch-safe parts. This is
/// separate from the frozen AI splitter above: that source actually uses 500/400 scalars.
/// Cuts choose the nearest earlier scalar boundary; joined emoji may span parts.
pub fn split_message(text: &str) -> Vec<String> {
    let mut rest = dima_text::trim(text);
    let mut parts = Vec::new();
    while !rest.is_empty() {
        let part = dima_text::truncate_utf16_budget(rest, 450);
        parts.push(part.to_owned());
        rest = rest.get(part.len()..).unwrap_or_default();
    }
    parts
}

/// Removes only the reply recipient's redundant mentions; other chatters remain tagged.
pub fn remove_ai_reply_recipient_tag(text: &str, username: &str) -> String {
    if username.is_empty() {
        return dima_text::trim(text).to_owned();
    }
    let Ok(pattern) = regex::Regex::new(&format!("(?i)@{}", regex::escape(username))) else {
        return dima_text::trim(text).to_owned();
    };
    let Ok(word_pattern) = regex::Regex::new(r"^[\p{L}\p{N}_]$") else {
        return dima_text::trim(text).to_owned();
    };
    let allowed = |c: char| dima_text::is_js_whitespace(c) || ",:;.!?".contains(c);
    let mut start = 0;
    let trimmed = dima_text::trim_start(text);
    if let Some(m) = pattern.find(trimmed).filter(|m| {
        m.start() == 0
            && trimmed
                .get(m.end()..)
                .and_then(|s| s.chars().next())
                .is_none_or(allowed)
    }) {
        let tail = dima_text::trim_start(trimmed.get(m.end()..).unwrap_or_default());
        let tail = if tail.starts_with([',', ':', ';', '.', '!', '?']) {
            tail.get(1..).unwrap_or_default()
        } else {
            tail
        };
        start = text.len() - dima_text::trim_start(tail).len();
    }
    let rest = text.get(start..).unwrap_or_default();
    let mut out = String::new();
    let mut position = 0;
    for m in pattern.find_iter(rest) {
        let before = rest
            .get(..m.start())
            .unwrap_or_default()
            .chars()
            .next_back();
        let after = rest.get(m.end()..).unwrap_or_default().chars().next();
        // JS's \p{L}\p{N}_ boundary; Rust regex supplies those same Unicode categories.
        let word = |c: char| word_pattern.is_match(&c.to_string());
        if before.is_none_or(|c| !word(c)) && after.is_none_or(allowed) {
            out.push_str(rest.get(position..m.start()).unwrap_or_default());
            out.push_str(rest.get(m.start() + 1..m.end()).unwrap_or_default());
            position = m.end();
        }
    }
    out.push_str(rest.get(position..).unwrap_or_default());
    dima_text::trim(&out).to_owned()
}

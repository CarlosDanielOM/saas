//! The recent chat of a channel (reference: `classes/chat_history.ts`). The bot's message
//! handler appends every chat message; the AI reply, moderation, pets, the desktop AI, Overlay
//! Studio, the site assistant and the chat summary tool read the newest ones; the stream
//! going offline clears the list.
//!
//! `{platform}:{channel}:chat:history`: a list of JSON `{username, message, timestamp,
//! messageID, badges}` (the last two left out when absent), newest first, at most
//! [`MAX_HISTORY`] entries, no lifetime. A *rebuilt* family: the list starts empty at the
//! cutover.
//!
//! Intended differences: the append and the trim are one `MULTI` (the reference sends two
//! commands, so a crash between them leaves 101 entries until the next message); a stored entry
//! that is not valid JSON is skipped on read (the reference returns an empty history).

use serde::{Deserialize, Serialize};

use super::{RuntimeError, Stores};

/// The most entries kept (`maxHistorySize`).
pub const MAX_HISTORY: i64 = 100;

/// The platform part of the key (`'twitch' | 'kick'`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Platform {
    /// `twitch` (the default).
    #[default]
    Twitch,
    /// `kick`.
    Kick,
}

impl Platform {
    fn as_str(self) -> &'static str {
        match self {
            Self::Twitch => "twitch",
            Self::Kick => "kick",
        }
    }
}

/// `{platform}:{channel}:chat:history`.
pub fn history_key(stores: &Stores, platform: Platform, channel_id: &str) -> String {
    stores
        .keys
        .key(format_args!("{}:{channel_id}:chat:history", platform.as_str()))
}

/// One stored message.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HistoryEntry {
    /// The chatter's display name.
    pub username: String,
    /// The text.
    pub message: String,
    /// When the bot received it, epoch milliseconds.
    pub timestamp: i64,
    /// Twitch's message id.
    #[serde(rename = "messageID", default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    /// The formatted badge list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badges: Option<Vec<String>>,
}

/// `addMessage`: appends one message and trims the list. Returns `false` (and writes nothing)
/// when the channel, the user name or the message is empty, as the reference only warns then.
pub async fn add_message(
    stores: &Stores,
    platform: Platform,
    channel_id: &str,
    entry: &HistoryEntry,
) -> Result<bool, RuntimeError> {
    if channel_id.is_empty() || entry.username.is_empty() || entry.message.is_empty() {
        return Ok(false);
    }
    let key = history_key(stores, platform, channel_id);
    let json = serde_json::to_string(entry).map_err(|_| RuntimeError::Reply("chat history"))?;
    let mut pipeline = redis::pipe();
    pipeline
        .atomic()
        .cmd("LPUSH")
        .arg(&key)
        .arg(json)
        .cmd("LTRIM")
        .arg(&key)
        .arg(0)
        .arg(MAX_HISTORY - 1);
    for outcome in stores.dragonfly.transaction(pipeline).await? {
        outcome?;
    }
    Ok(true)
}

/// `getRecentMessages(channelID, limit)`: `LRANGE key 0 limit-1`, newest first (so a limit of
/// 0 or less reads up to `limit - 1` from the end, as the reference does: 0 reads the whole
/// list). An empty channel reads nothing.
pub async fn recent_messages(
    stores: &Stores,
    platform: Platform,
    channel_id: &str,
    limit: i64,
) -> Result<Vec<HistoryEntry>, RuntimeError> {
    if channel_id.is_empty() {
        return Ok(Vec::new());
    }
    let key = history_key(stores, platform, channel_id);
    let mut command = redis::cmd("LRANGE");
    command.arg(&key).arg(0).arg(limit.saturating_sub(1));
    let items: Vec<Vec<u8>> = stores.dragonfly.query(&command).await?;
    Ok(items
        .iter()
        .filter_map(|item| serde_json::from_slice(item).ok())
        .collect())
}

/// `clearHistory`: deletes the list (stream offline). An empty channel does nothing.
pub async fn clear_history(
    stores: &Stores,
    platform: Platform,
    channel_id: &str,
) -> Result<(), RuntimeError> {
    if channel_id.is_empty() {
        return Ok(());
    }
    let key = history_key(stores, platform, channel_id);
    stores.dragonfly.del(&[key.as_str()]).await?;
    Ok(())
}

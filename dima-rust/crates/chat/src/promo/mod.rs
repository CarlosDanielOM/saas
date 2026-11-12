//! `promo(channelID, streamerName, sendClip)` (`functions/promo/chat.promo.ts`, re-exported by
//! `functions/promo/index.ts`). Package **P4-CHAT-MESSAGE**.
//!
//! What it is: the body of the `!promo` built-in (a command whose `func` is `promo`,
//! `message.handler.ts:433-442`, with `sendClip` true). It reads the promoted streamer by login,
//! the channel's own account by id, the streamer's channel information (title, game), and with
//! `sendClip` the streamer's clips, then shows one of them on the channel's clip overlay
//! (`showClip`, P4-ACT-MEDIA, reached through [`ShowClip`]). Each step that fails ends the call
//! with that step's message; nothing is retried.
//!
//! What it is not: a timed or paced message. Nothing triggers it but a chatter's `!promo`, which
//! the command's own cooldowns pace (the per-process one and the shared gate,
//! [`crate::message`]); it posts no chat itself (the handler posts only its error message, and
//! nothing on success); it holds no key of its own (the reference opens a Dragonfly client named
//! `promo` and never uses it), and it is the same for every plan.
//!
//! The handler calls it through [`crate::message::seams::BuiltinCommands`] (`BuiltinCall::Promo`):
//! the binary's built-ins implementation calls [`promo`] for it.

use dima_twitch::Twitch;
use dima_twitch::functions::channels::get_channel_information;
use dima_twitch::functions::clips::{ClipStore, TwitchClip, get_channel_clips};
use dima_twitch::functions::users::{TwitchUser, get_twitch_user_by_id, get_twitch_user_by_login};
use futures_util::future::BoxFuture;
use serde_json::Value;

/// `StreamerChannelInfo`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StreamerChannelInfo {
    /// `game_name`.
    pub game: String,
    /// `title`.
    pub title: String,
    /// `broadcaster_login`.
    pub login: String,
    /// `broadcaster_name`.
    pub name: String,
}

/// `PromoResponse`.
#[derive(Clone, Debug, PartialEq)]
pub struct PromoReply {
    /// `error`.
    pub error: bool,
    /// `message`: the failed step's message, or `Success`.
    pub message: String,
    /// `status` of the failed step.
    pub status: Option<u16>,
    /// `data` on success: the streamer's channel, and what `showClip` answered.
    pub data: Option<(StreamerChannelInfo, Option<Value>)>,
}

impl PromoReply {
    fn failed(message: Option<String>, fallback: &str, status: Option<u16>) -> Self {
        Self {
            error: true,
            message: message
                .filter(|message| !message.is_empty())
                .unwrap_or_else(|| fallback.to_owned()),
            status,
            data: None,
        }
    }
}

/// What `showClip` answered.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ShownClip {
    /// `error`.
    pub error: bool,
    /// `message`.
    pub message: Option<String>,
    /// `status`.
    pub status: Option<u16>,
    /// The whole answer, as `data.clip` of the promo.
    pub answer: Value,
}

/// `showClip(channelID, clips, streamerData, broadcasterData, false)` (P4-ACT-MEDIA): picks one of
/// `clips` and shows it on the channel's clip overlay.
pub trait ShowClip: Send + Sync {
    /// Shows a clip of `streamer` on `channel_id`'s overlay.
    fn show_clip<'a>(
        &'a self,
        channel_id: &'a str,
        clips: &'a [TwitchClip],
        streamer: &'a TwitchUser,
        broadcaster: &'a TwitchUser,
    ) -> BoxFuture<'a, ShownClip>;
}

/// `promo(channelID, streamerName, sendClip)`: see the module documentation.
pub async fn promo(
    twitch: &Twitch,
    clips: &ClipStore<'_>,
    show: &dyn ShowClip,
    channel_id: &str,
    streamer_name: &str,
    send_clip: bool,
) -> PromoReply {
    let streamer = get_twitch_user_by_login(twitch, streamer_name, false).await;
    let Some(streamer) = streamer.data.filter(|_| !streamer.error) else {
        return PromoReply::failed(
            streamer.message,
            "Failed to get streamer data",
            streamer.status,
        );
    };
    let broadcaster = get_twitch_user_by_id(twitch, channel_id).await;
    let Some(broadcaster) = broadcaster.data.filter(|_| !broadcaster.error) else {
        return PromoReply::failed(
            broadcaster.message,
            "Failed to get broadcaster data",
            broadcaster.status,
        );
    };
    let channel = match get_channel_information(twitch, &streamer.id, true).await {
        Ok(channel) => channel.data.filter(|_| !channel.error),
        Err(error) => {
            return PromoReply::failed(
                Some(error.message),
                "Failed to get streamer channel information",
                error.status,
            );
        }
    };
    let Some(channel) = channel else {
        return PromoReply::failed(None, "Failed to get streamer channel information", None);
    };
    let text = |key: &str| {
        channel
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let info = StreamerChannelInfo {
        game: text("game_name"),
        title: text("title"),
        login: text("broadcaster_login"),
        name: text("broadcaster_name"),
    };
    let mut clip = None;
    if send_clip {
        let found = get_channel_clips(twitch, clips, &streamer.id, None, false).await;
        let Some(found) = found.data.filter(|_| !found.error) else {
            return PromoReply::failed(found.message, "Failed to get clips", found.status);
        };
        let shown = show
            .show_clip(channel_id, &found, &streamer, &broadcaster)
            .await;
        if shown.error {
            return PromoReply::failed(shown.message, "Failed to show clip", shown.status);
        }
        clip = Some(shown.answer);
    }
    PromoReply {
        error: false,
        message: "Success".to_owned(),
        status: None,
        data: Some((info, clip)),
    }
}

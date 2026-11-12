//! A message without a command that mentions the bot (`message.handler.ts:260-371`): the AI
//! reply. The model call, its money and the threads are [`super::seams::AiReply`]'s; the order,
//! the history window, chunking and replies are here.

use super::pipeline::{Context, Failure};
use super::seams::{AiChatRequest, AssistantTurn, HistoryLine, ThreadRequest};
use dima_commands::runtime::chat_history::{Platform, recent_messages};
use dima_telemetry::Level;
use dima_twitch::chat::send::{remove_ai_reply_recipient_tag, split_ai_response_for_twitch};
use serde_json::json;

/// The bot's mention, matched case-sensitively in its two spellings
/// (`startsWith`/`includes` of `@domdimabot` and `@DomDimaBot`).
fn mentions_bot(text: &str) -> bool {
    text.contains("@domdimabot") || text.contains("@DomDimaBot")
}

/// `text.replace(/@domdimabot/ig, '')`: ASCII case-insensitive (the regex has no `u` flag, so no
/// other character folds onto these letters).
fn without_mentions(text: &str) -> String {
    const NEEDLE: &[u8] = b"@domdimabot";
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut start = 0;
    let mut at = 0;
    while at + NEEDLE.len() <= bytes.len() {
        let matched = bytes
            .get(at..at + NEEDLE.len())
            .is_some_and(|window| window.eq_ignore_ascii_case(NEEDLE));
        if matched {
            out.push_str(text.get(start..at).unwrap_or_default());
            at += NEEDLE.len();
            start = at;
        } else {
            at += 1;
        }
    }
    out.push_str(text.get(start..).unwrap_or_default());
    out
}

/// Steps 17 of the module documentation.
pub(super) async fn reply(context: &Context<'_>) -> Result<(), Failure> {
    let message = context.message;
    if !mentions_bot(&message.text) {
        return Ok(());
    }
    let inner = context.inner;
    let ai = &inner.deps.ai;
    let channel_id = context.channel_id;
    let streamer = context.streamer;
    let personality = ai.personality(channel_id).await.map_err(|error| error.0)?;
    if personality.and_then(|personality| personality.enabled) == Some(false) {
        inner.log(
            Level::Debug,
            &json!({"message": "[AI Mention] Skipping AI response because personality is disabled",
                "channelID": channel_id, "streamer": streamer.name()}),
            channel_id,
            false,
        );
        return Ok(());
    }
    if streamer.name() == "ozbellvt" || streamer.name() == "littlehuntervt" {
        return Ok(());
    }
    let plan_tier = match streamer.plan_tier() {
        Some("pro") => "pro",
        Some("premium") => "premium",
        _ => "free",
    };
    let text = without_mentions(&message.text);
    let text = dima_text::trim(&text);
    let user_id = if message.chatter_id().is_empty() {
        "unknown"
    } else {
        message.chatter_id()
    };
    let username = [message.chatter_name(), message.chatter_login()]
        .into_iter()
        .find(|name| !name.is_empty())
        .unwrap_or("unknown");
    let thread = match ai
        .resolve_thread(ThreadRequest {
            channel_id,
            user_id,
            username,
            message: text,
            plan_tier,
            source_message_id: message.id(),
        })
        .await
    {
        Ok(thread) => thread,
        Err(error) => {
            inner.log(
                Level::Error,
                &json!({"message": "Error resolving AI thread in message handler", "channelID": channel_id,
                    "userID": message.chatter_id(), "error": error.0}),
                channel_id,
                true,
            );
            Default::default()
        }
    };
    let window = personality
        .and_then(|personality| personality.context_window)
        .unwrap_or(if streamer.plan_tier() == Some("pro") {
            15
        } else {
            7
        });
    let history = match recent_messages(inner.stores(), Platform::Twitch, channel_id, window).await
    {
        Ok(entries) => entries
            .into_iter()
            .map(|entry| HistoryLine {
                timestamp: entry.timestamp,
                badges: entry.badges.map(|badges| badges.join(" ")),
                username: entry.username,
                message: entry.message,
            })
            .collect(),
        Err(error) => {
            inner.log(
                Level::Error,
                &json!({"function": "ChatHistory.getRecentMessages", "channelID": channel_id,
                    "error": error.to_string()}),
                channel_id,
                false,
            );
            Vec::new()
        }
    };
    let answer = ai
        .chat(AiChatRequest {
            channel_id,
            message: text,
            streamer_name: streamer.name(),
            streamer_plan: streamer.plan_tier(),
            history,
            thread_history: thread.prompt_context,
            badges: &message.badges,
            username: message.chatter_user_name.as_deref(),
            chatter_user_id: message.chatter_user_id.as_deref(),
            user_level: context.identity.level(),
            identity: context.identity,
        })
        .await;
    let Some(answer) = answer.filter(|answer| !answer.is_empty()) else {
        return Ok(());
    };
    let recipient = if message.chatter_name().is_empty() {
        message.chatter_login()
    } else {
        message.chatter_name()
    };
    let reply_text = remove_ai_reply_recipient_tag(&answer, recipient);
    let chunks = split_ai_response_for_twitch(&reply_text);
    let mut failed = 0_usize;
    for (index, chunk) in chunks.iter().enumerate() {
        // The first chunk replies to the chatter's message.
        let reply_to = (index == 0)
            .then_some(message.message_id.as_deref())
            .flatten();
        if !context.post(chunk, reply_to).await {
            failed += 1;
        }
    }
    let delivered = !chunks.is_empty() && failed == 0;
    if !delivered {
        inner.log(
            Level::Error,
            &json!({"function": "messageHandler.aiResponseDelivery", "channelID": channel_id,
                "chunks": chunks.len(), "failedChunks": failed,
                "messageLength": reply_text.chars().count()}),
            channel_id,
            false,
        );
    }
    if let Some(thread_id) = &thread.thread_id
        && let Err(error) = ai
            .append_assistant_turn(AssistantTurn {
                channel_id,
                thread_id,
                message: &reply_text,
                plan_tier,
                source_message_id: message.id(),
                delivered,
            })
            .await
    {
        inner.log(
            Level::Error,
            &json!({"message": "Error appending assistant turn to thread", "channelID": channel_id,
                "threadID": thread_id, "error": error.0}),
            channel_id,
            true,
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mention_is_found_and_removed_as_the_reference_does() {
        assert!(mentions_bot("hola @DomDimaBot") && mentions_bot("@domdimabot?"));
        assert!(!mentions_bot("hola @DOMDIMABOT"), "only the two spellings");
        assert_eq!(
            without_mentions("@DOMdimabot hola @domdimabot👋"),
            " hola 👋"
        );
        assert_eq!(without_mentions("sin mención"), "sin mención");
    }
}

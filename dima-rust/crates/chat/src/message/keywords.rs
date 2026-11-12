//! `handleKeywords` (`handlers/keywords.handler.ts`): the keyword commands a chat message
//! triggers, each run with the whole message as its argument and its reply delivered, in match
//! order. A failure ends the keyword pass (the reference's loop throws) and the message goes on
//! to its command.

use super::Inner;
use super::event::ChatEvent;
use dima_actions::delivery::AstMessage;
use dima_actions::runner::{
    CommandOutcome, CommandRequest, ExecutionAuthorization, ExecutionOrigin,
};
use dima_commands::keywords::{
    KeywordCacheError, KeywordEntry, KeywordMatchMode, PreparedMessage, get_keyword_body,
    normalize_keyword,
};
use dima_commands::permissions::UserIdentity;
use dima_engine::context::Effect;
use dima_telemetry::Level;
use serde_json::json;

/// Runs the keywords of `message` (step 14 of the module documentation).
pub(super) async fn handle(
    inner: &Inner,
    channel_id: &str,
    message: &ChatEvent,
    identity: &UserIdentity,
    effect: Option<&Effect>,
) -> Result<(), String> {
    let deps = &inner.deps;
    let index = match deps.keywords.get(channel_id).await {
        Ok(index) => index,
        // A channel over the cache's bounds is handled as if it had no keywords.
        Err(KeywordCacheError::Overloaded(overload)) => {
            inner.log(
                Level::Warn,
                &json!({"function": "messageHandler.keywords", "channelID": channel_id,
                    "error": overload.to_string()}),
                channel_id,
                false,
            );
            return Ok(());
        }
        Err(error) => return Err(error.to_string()),
    };
    if index.is_empty() {
        return Ok(());
    }
    let prepared = PreparedMessage::new(&message.text);
    let matches: Vec<KeywordEntry> = prepared.match_index(&index).into_iter().cloned().collect();
    drop(index);
    let storage = &deps.keywords.loader().storage;
    for (runs, entry) in matches.iter().enumerate() {
        if runs >= inner.config.keyword_runs_per_message {
            inner.count("keyword_runs_skipped");
            break;
        }
        let Some(body) = get_keyword_body(storage.as_ref(), channel_id, &entry.id)
            .await
            .map_err(|error| error.to_string())?
        else {
            continue;
        };
        let command = body.command().map_err(|error| error.to_string())?;
        if command.enabled != Some(true) {
            continue;
        }
        // `normalizeKeyword(keyword.cmd)` throws on a body without text: the pass ends.
        let Some(cmd) = command.cmd.clone() else {
            return Err("a keyword command has no keyword".into());
        };
        let current = KeywordEntry {
            id: entry.id.clone(),
            text: normalize_keyword(&cmd),
            match_mode: KeywordMatchMode::from_stored(
                command
                    .keyword_settings
                    .as_ref()
                    .map(|settings| settings.match_mode.as_str()),
            ),
        };
        if !prepared.matches(&current) {
            continue;
        }
        let turn = inner.admission.evaluation().await;
        let outcome = deps
            .delivery
            .execute_custom_command(
                &command,
                CommandRequest {
                    channel_id: channel_id.to_owned(),
                    event_data: message.engine_value(),
                    name: cmd,
                    argument: Some(message.text.clone()),
                    authorization: Some(ExecutionAuthorization {
                        origin: ExecutionOrigin::Chat,
                        identity: identity.clone(),
                    }),
                    reference: None,
                    effect: effect.cloned(),
                },
            )
            .await
            .map_err(|error| error.to_string())?;
        drop(turn);
        if let CommandOutcome::Ran(ran) = outcome {
            let _ = deps
                .delivery
                .deliver_message(
                    channel_id,
                    AstMessage {
                        text: ran.message,
                        references: ran.references,
                    },
                    true,
                )
                .await;
        }
    }
    Ok(())
}

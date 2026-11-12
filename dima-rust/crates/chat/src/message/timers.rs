//! `!cct`, `!ect`, `!dct`, `!timer`, `!timers` (`message.handler.ts:142-258`): the timer manager
//! from chat. The handler parses and checks the arguments; the timer service itself is
//! P4-FEAT-TIMERS', reached through [`super::seams::BuiltinCommands`].

use super::pipeline::{Context, Failure};
use super::seams::BuiltinCall;
use dima_commands::timer_policy::parse_timer_frequency_input;

/// What the timer command asks.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum TimerRoute {
    /// The handler's own answer (`{error: true, message}`).
    Answer(&'static str),
    /// The timer service's call.
    Call(BuiltinCall),
}

/// `streamerArgument.split(/\s+/).filter(Boolean)`.
fn words(text: &str) -> Vec<&str> {
    text.split(dima_text::is_js_whitespace)
        .filter(|word| !word.is_empty())
        .collect()
}

/// The timer command a message names, if any (`effectiveSubCommand !== null`).
pub(super) fn route(command_lower: &str, argument: &str) -> Option<TimerRoute> {
    let (subcommand, payload): (String, Vec<&str>) = match command_lower {
        "cct" => ("create".into(), words(argument)),
        "ect" => ("edit".into(), words(argument)),
        "dct" => ("delete".into(), words(argument)),
        "timer" | "timers" => {
            let all = words(argument);
            let first = all
                .first()
                .map(|word| dima_text::to_lower(word))
                .unwrap_or_default();
            (first, all.into_iter().skip(1).collect())
        }
        _ => return None,
    };
    Some(match subcommand.as_str() {
        "create" | "add" => {
            let name = payload.first().copied().unwrap_or_default();
            let frequency_raw = payload.get(1).copied();
            let frequency = parse_timer_frequency_input(frequency_raw);
            let message = payload
                .get(2..)
                .map(|parts| parts.join(" "))
                .unwrap_or_default();
            let message = dima_text::trim(&message);
            match frequency {
                Some(frequency)
                    if !name.is_empty()
                        && frequency_raw.is_some_and(|raw| !raw.is_empty())
                        && !message.is_empty() =>
                {
                    TimerRoute::Call(BuiltinCall::TimerCreate {
                        name: name.to_owned(),
                        frequency,
                        message: message.to_owned(),
                    })
                }
                _ => TimerRoute::Answer(
                    "Usage: !timer create <name> <minutes> <message> | Free: 10/20/30/40/50/60 | Premium: 5-minute intervals up to 180 | Pro: any whole minute up to 180",
                ),
            }
        }
        "edit" | "update" | "modify" => {
            let name = payload.first().copied().unwrap_or_default();
            let frequency_or_message = payload.get(1).copied();
            let parsed = parse_timer_frequency_input(frequency_or_message);
            let rest = payload.get(2..).unwrap_or_default();
            let message = match parsed {
                None => frequency_or_message
                    .into_iter()
                    .chain(rest.iter().copied())
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>()
                    .join(" "),
                Some(_) => rest.join(" "),
            };
            let message = dima_text::trim(&message).to_owned();
            if name.is_empty()
                || (frequency_or_message.is_none_or(str::is_empty) && message.is_empty())
            {
                TimerRoute::Answer("Usage: !timer edit <name> <frequency?> <message?>")
            } else {
                TimerRoute::Call(BuiltinCall::TimerEdit {
                    name: name.to_owned(),
                    frequency: parsed,
                    message: (!message.is_empty()).then_some(message),
                })
            }
        }
        "delete" | "remove" | "del" => match payload.first() {
            Some(name) => TimerRoute::Call(BuiltinCall::TimerDelete {
                name: (*name).to_owned(),
            }),
            None => TimerRoute::Answer("Usage: !timer delete <name>"),
        },
        "list" | "show" | "ls" => TimerRoute::Call(BuiltinCall::TimerList),
        _ => TimerRoute::Answer("Invalid timer subcommand. Use create, edit, delete, or list."),
    })
}

/// Below moderator level the answer is a refusal; otherwise the timer call, the session's
/// command count beside the activity row, then the answer posted.
pub(super) async fn run(context: &Context<'_>, route: TimerRoute) -> Result<(), Failure> {
    if context.identity.level() < 7.0 {
        context
            .post("You need moderator permissions to manage timers.", None)
            .await;
        return Ok(());
    }
    let (error, message) = match route {
        TimerRoute::Answer(text) => (true, text.to_owned()),
        TimerRoute::Call(call) => {
            let reply = context
                .inner
                .deps
                .builtins
                .run(context.channel_id, call)
                .await
                .map_err(|error| error.0)?;
            (reply.error, reply.message.unwrap_or_default())
        }
    };
    let label = format!("!{}", context.command_lower);
    let answer = async {
        context
            .capture_command(context.command_lower, &label, error)
            .await;
        context.post(&message, None).await;
    };
    tokio::join!(context.record_command_event(), answer);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subcommands_and_usage_follow_the_reference() {
        assert_eq!(route("hola", ""), None);
        assert_eq!(
            route("timer", ""),
            Some(TimerRoute::Answer(
                "Invalid timer subcommand. Use create, edit, delete, or list."
            ))
        );
        assert_eq!(
            route("timers", "LS"),
            Some(TimerRoute::Call(BuiltinCall::TimerList))
        );
        assert!(matches!(
            route("cct", "promo 10"),
            Some(TimerRoute::Answer(_))
        ));
        assert_eq!(
            route("cct", "promo  10  sigue  el canal "),
            Some(TimerRoute::Call(BuiltinCall::TimerCreate {
                name: "promo".into(),
                frequency: 10.0,
                message: "sigue el canal".into()
            }))
        );
        assert_eq!(
            route("ect", "promo hola mundo"),
            Some(TimerRoute::Call(BuiltinCall::TimerEdit {
                name: "promo".into(),
                frequency: None,
                message: Some("hola mundo".into())
            }))
        );
        assert_eq!(
            route("timer", "edit promo 20"),
            Some(TimerRoute::Call(BuiltinCall::TimerEdit {
                name: "promo".into(),
                frequency: Some(20.0),
                message: None
            }))
        );
        assert_eq!(
            route("dct", ""),
            Some(TimerRoute::Answer("Usage: !timer delete <name>"))
        );
    }
}

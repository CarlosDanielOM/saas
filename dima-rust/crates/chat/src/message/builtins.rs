//! The `switch (commandFunc)` of `message.handler.ts:429-766`: the handler's own usage checks,
//! the call of the built-in through [`super::seams::BuiltinCommands`], and how each branch turns
//! the built-in's answer into the reply. The built-ins themselves are later packages'.

use super::pipeline::{Context, Reply};
use super::seams::{BuiltinCall, BuiltinReply, LegacyTags, PollAction, PredictionAction};
use dima_model::commands::Command;
use dima_twitch::badges::FormattedBadges;

/// The bot's own account, where the reference falls back to it (`modID`).
const MOD_ID: &str = "698614112";

/// What a branch does with the built-in's answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Mapping {
    /// `res = result` (sumimetro): the answer as it is.
    Raw,
    /// Error: `{error: true, message: result.message || fallback}`; success:
    /// `{error: false, message: result.message}`.
    Message(&'static str),
    /// Error as [`Mapping::Message`]; success: `{error: false, message: result.message ||
    /// success}`.
    MessageOr(&'static str, &'static str),
    /// Error as [`Mapping::Message`]; success: `{error: false, message: success}`.
    Fixed(&'static str, String),
    /// Error as [`Mapping::Message`]; success: no reply (`res` stays `null`).
    Nothing(&'static str),
}

/// Where the command goes.
pub(super) enum Route {
    /// The handler answers a usage or limit error itself.
    Usage(Reply),
    /// The built-in, then the mapping of its answer.
    Builtin(BuiltinCall, Mapping),
    /// The stored text runs (`commandHandler`).
    Custom,
}

/// `res.message || fallback`.
fn or(message: Option<String>, fallback: &str) -> String {
    message
        .filter(|message| !message.is_empty())
        .unwrap_or_else(|| fallback.to_owned())
}

/// The reply of a branch (see [`Mapping`]).
pub(super) fn map_reply(mapping: &Mapping, reply: BuiltinReply, _chatter: &str) -> Option<Reply> {
    let BuiltinReply { error, message } = reply;
    match mapping {
        Mapping::Raw => Some(Reply {
            error,
            message,
            references: Vec::new(),
        }),
        Mapping::Message(fallback)
        | Mapping::MessageOr(fallback, _)
        | Mapping::Fixed(fallback, _)
        | Mapping::Nothing(fallback)
            if error =>
        {
            Some(Reply::text(true, or(message, fallback)))
        }
        Mapping::Message(_) => Some(Reply {
            error: false,
            message,
            references: Vec::new(),
        }),
        Mapping::MessageOr(_, success) => Some(Reply::text(false, or(message, success))),
        Mapping::Fixed(_, success) => Some(Reply::text(false, success.clone())),
        Mapping::Nothing(_) => None,
    }
}

fn usage(text: &str) -> Route {
    Route::Usage(Reply::text(true, text))
}

/// `text.split('!' + command)[1].trim()`: the text between the first and the second occurrence
/// of `!{command}` (or the end), trimmed.
fn after_command(text: &str, command: &str) -> String {
    let needle = format!("!{command}");
    let Some(start) = text.find(&needle) else {
        return String::new();
    };
    let rest = text.get(start + needle.len()..).unwrap_or_default();
    let piece = match rest.find(&needle) {
        Some(end) => rest.get(..end).unwrap_or_default(),
        None => rest,
    };
    dima_text::trim(piece).to_owned()
}

/// The branch of `func` (`commandDBData.command.func ?? 'none'`).
pub(super) fn route(
    context: &Context<'_>,
    command: &Command,
    command_level: f64,
    tag_mode: bool,
    badges: &FormattedBadges,
) -> Route {
    let func = command.func.as_deref().unwrap_or("none");
    let argument = context.streamer_argument;
    let message = context.message;
    let login = message.chatter_login().to_owned();
    let tags = || LegacyTags {
        user_id: message.chatter_id().to_owned(),
        username: login.clone(),
        display_name: message.chatter_name().to_owned(),
        is_mod: context.is_mod,
    };
    let user_level = context.identity.level();
    let needs = |text: &'static str, call: BuiltinCall, mapping: Mapping| {
        if argument.is_empty() {
            usage(text)
        } else {
            Route::Builtin(call, mapping)
        }
    };
    let call = |call: BuiltinCall, mapping: Mapping| Route::Builtin(call, mapping);
    let arg = || argument.to_owned();
    match func {
        "sumimetro" => call(
            BuiltinCall::Sumimetro {
                login: login.clone(),
                argument: after_command(&message.text, context.command),
                command: context.command.to_owned(),
            },
            Mapping::Raw,
        ),
        "promo" => needs(
            "Please provide a streamer name to promo. Usage: !promo <streamer>",
            BuiltinCall::Promo { streamer: arg() },
            Mapping::Nothing("Failed to promo streamer"),
        ),
        "shoutout" if !command.reserved => Route::Custom,
        "shoutout" => needs(
            "Please provide a user to shoutout. Usage: !so <username>",
            BuiltinCall::Shoutout { target: arg() },
            Mapping::Nothing("Failed to send shoutout"),
        ),
        "anuncio" if argument.is_empty() => usage("Usage: !anuncio <message>"),
        // Our own limit on user text: characters (charter section 4; the reference counts UTF-16).
        "anuncio" if argument.chars().count() > 300 => {
            usage("Message cannot be longer than 300 characters")
        }
        "anuncio" => call(
            BuiltinCall::Announcement {
                sender_id: if message.chatter_id().is_empty() {
                    MOD_ID.to_owned()
                } else {
                    message.chatter_id().to_owned()
                },
                text: arg(),
            },
            Mapping::Fixed(
                "Failed to send announcement",
                "Announcement sent".to_owned(),
            ),
        ),
        "ruletarusa" => call(
            BuiltinCall::Ruletarusa {
                login: login.clone(),
                is_mod: badges.is_mod,
            },
            Mapping::Message("Error en ruletarusa"),
        ),
        "amor" => needs(
            "Se te olvido poner a la persona a la que quieres medir el amor. No mas por eso te quedaras solter@ toda tu vida.",
            BuiltinCall::Amor {
                tags: tags(),
                target: arg(),
            },
            Mapping::Message("Error al medir amor"),
        ),
        "disableCommand" => needs(
            "Usage: !disable <command name>",
            BuiltinCall::DisableCommand { name: arg() },
            Mapping::Message("Error al deshabilitar comando"),
        ),
        "enableCommand" => needs(
            "Usage: !enable <command name>",
            BuiltinCall::EnableCommand { name: arg() },
            Mapping::Message("Error al habilitar comando"),
        ),
        "createCommand" => needs(
            "Usage: !cc <command name> <command function>",
            BuiltinCall::CreateCommand { argument: arg() },
            Mapping::MessageOr("Error creating command", "Command created"),
        ),
        "deleteCommand" => needs(
            "Usage: !dc <command name>",
            BuiltinCall::DeleteCommand {
                argument: arg(),
                user_level,
            },
            Mapping::MessageOr("Error deleting command", "Command deleted"),
        ),
        "editCommand" => needs(
            "Usage: !ec <command name> <command function>",
            BuiltinCall::EditCommand {
                argument: arg(),
                user_level,
            },
            Mapping::MessageOr("Error updating command", "Command updated"),
        ),
        "clearChat" => call(
            BuiltinCall::ClearChat {
                moderator_id: if message.chatter_id().is_empty() {
                    MOD_ID.to_owned()
                } else {
                    message.chatter_id().to_owned()
                },
            },
            Mapping::Fixed(
                "Failed to clear chat",
                format!(
                    "Chat cleared by {}",
                    message.chatter_user_name.as_deref().unwrap_or("undefined")
                ),
            ),
        ),
        "commands" => call(
            BuiltinCall::CommandList {
                identity: context.identity.clone(),
            },
            Mapping::Message("Error al listar comandos"),
        ),
        "followage" => call(
            BuiltinCall::Followage {
                login: if argument.is_empty() {
                    login.clone()
                } else {
                    arg()
                },
            },
            Mapping::Message("Error al obtener followage"),
        ),
        "title" => call(
            BuiltinCall::Title {
                argument: arg(),
                user_level,
                command_level,
                tag_mode,
            },
            Mapping::Message("Error al obtener titulo"),
        ),
        "game" => call(
            BuiltinCall::Game {
                argument: arg(),
                user_level,
                command_level,
                tag_mode,
            },
            Mapping::Message("Error al obtener juego"),
        ),
        "mod" => needs(
            "Usage: !mod @username",
            BuiltinCall::AddModerator { target: arg() },
            Mapping::Message("Error al agregar moderador"),
        ),
        "unmod" => needs(
            "Usage: !unmod @username",
            BuiltinCall::RemoveModerator { target: arg() },
            Mapping::Message("Error al remover moderador"),
        ),
        "createClip" => call(
            BuiltinCall::CreateClip { argument: arg() },
            Mapping::Message("Error al crear clip"),
        ),
        "onlyemotes" => call(
            BuiltinCall::OnlyEmotes { argument: arg() },
            Mapping::Message("Error al cambiar modo only emotes"),
        ),
        "vanish" => call(
            BuiltinCall::Vanish { tags: tags() },
            Mapping::Message("Error al hacer vanish"),
        ),
        "duel" => call(
            BuiltinCall::Duel {
                login: login.clone(),
                is_mod: context.is_mod,
                argument: arg(),
            },
            Mapping::Message("Error en duelo"),
        ),
        "vip" => needs(
            "Usage: !vip @username [duration]",
            BuiltinCall::AddVip {
                argument: arg(),
                tags: tags(),
            },
            Mapping::Message("Error al agregar VIP"),
        ),
        "unvip" => needs(
            "Usage: !unvip @username",
            BuiltinCall::RemoveVip { target: arg() },
            Mapping::Message("Error al remover VIP"),
        ),
        "poll" => needs(
            "Usage: !poll Title;Choice1/Choice2;duration",
            BuiltinCall::Poll {
                action: PollAction::Create,
                argument: arg(),
            },
            Mapping::Message("Error al crear poll"),
        ),
        "endpoll" => call(
            BuiltinCall::Poll {
                action: PollAction::End,
                argument: String::new(),
            },
            Mapping::Message("Error al terminar poll"),
        ),
        "archivepoll" => call(
            BuiltinCall::Poll {
                action: PollAction::Archive,
                argument: String::new(),
            },
            Mapping::Message("Error al archivar poll"),
        ),
        "cancelpoll" => call(
            BuiltinCall::Poll {
                action: PollAction::Terminate,
                argument: String::new(),
            },
            Mapping::Message("Error al terminar poll"),
        ),
        "predi" => needs(
            "Usage: !predi Title;Outcome1/Outcome2;duration",
            BuiltinCall::Prediction {
                action: PredictionAction::Create,
                argument: arg(),
            },
            Mapping::Message("Error al crear prediction"),
        ),
        "endpredi" => needs(
            "Usage: !endpredi <option number>",
            BuiltinCall::Prediction {
                action: PredictionAction::Resolved,
                argument: arg(),
            },
            Mapping::Message("Error al resolver prediction"),
        ),
        "cancelpredi" => call(
            BuiltinCall::Prediction {
                action: PredictionAction::Canceled,
                argument: String::new(),
            },
            Mapping::Message("Error al cancelar prediction"),
        ),
        "lockpredi" => call(
            BuiltinCall::Prediction {
                action: PredictionAction::Locked,
                argument: String::new(),
            },
            Mapping::Message("Error al bloquear prediction"),
        ),
        _ => Route::Custom,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sumimetro_argument_is_the_text_between_the_first_two_mentions() {
        assert_eq!(after_command("!sumi  hola ", "sumi"), "hola");
        assert_eq!(after_command("!sumi a !sumi b", "sumi"), "a");
        assert_eq!(after_command("!sumi", "sumi"), "");
        assert_eq!(after_command("x", "sumi"), "");
    }

    #[test]
    fn answers_are_mapped_as_each_branch_does() {
        let error = |message: Option<&str>| BuiltinReply {
            error: true,
            message: message.map(str::to_owned),
        };
        let ok = |message: Option<&str>| BuiltinReply {
            error: false,
            message: message.map(str::to_owned),
        };
        let text = |reply: Option<Reply>| reply.map(|r| (r.error, r.message));
        assert_eq!(
            text(map_reply(&Mapping::Message("fallback"), error(None), "")),
            Some((true, Some("fallback".into())))
        );
        assert_eq!(
            text(map_reply(&Mapping::Message("fallback"), ok(None), "")),
            Some((false, None))
        );
        assert_eq!(
            text(map_reply(&Mapping::Nothing("f"), ok(Some("x")), "")),
            None
        );
        assert_eq!(
            text(map_reply(
                &Mapping::MessageOr("f", "Command created"),
                ok(Some("")),
                ""
            )),
            Some((false, Some("Command created".into())))
        );
        assert_eq!(
            text(map_reply(&Mapping::Raw, error(Some("raw")), "")),
            Some((true, Some("raw".into())))
        );
    }
}

//! `createSpecialExecutionContext(context, literalVariables)`
//! (`handlers/special_parser.handler.ts:343-496`): the engine's [`Context`] and [`State`] for a
//! rendering, and the [`DimaHost`] whose storage belongs to the user the event names.

use super::{ChatDelivery, RenderError, RenderInput};
use crate::host::{DimaHost, Services, VariableScope};
use dima_engine::context::{Authorization, Context, Origin, Plan, State};
use dima_engine::map::OrderedMap;
use dima_engine::value::{CoercionError, Value};
use dima_twitch::streamers::StreamerAccount;
use std::sync::Arc;

/// What a rendering runs with.
pub(crate) struct Prepared {
    pub(crate) context: Context,
    pub(crate) state: State,
    pub(crate) host: DimaHost,
}

fn coercion(_: CoercionError) -> RenderError {
    RenderError::Failed("Cannot convert object to primitive value".into())
}

/// `String(a || b || … || '') || undefined`: the first truthy field as text, `None` when there
/// is none or its text is empty.
fn first_text(event: &Value, keys: &[&str]) -> Result<Option<String>, RenderError> {
    let Some(value) = keys
        .iter()
        .filter_map(|key| event.get(key))
        .find(|value| value.js_truthy())
    else {
        return Ok(None);
    };
    let text = value.to_text().map_err(coercion)?.into_owned();
    Ok((!text.is_empty()).then_some(text))
}

/// `extractUserInfo`, `extractBroadcasterInfo` and `extractNumericFields`.
pub(crate) struct Extracted {
    pub(crate) user_name: Option<String>,
    pub(crate) user_login: Option<String>,
    pub(crate) user_id: Option<String>,
    broadcaster_name: Option<String>,
    broadcaster_login: Option<String>,
    broadcaster_id: Option<String>,
    bits: Option<f64>,
    viewers: Option<f64>,
}

pub(crate) fn extract(event: &Value) -> Result<Extracted, RenderError> {
    let bits_field = event.get("bits").filter(|value| value.js_truthy());
    // `eventData.bits || cheer?.bits`: a cheer that is not an object has no `bits`.
    let bits = match bits_field {
        Some(value) => Some(value),
        None => event.get("cheer").and_then(|cheer| cheer.get("bits")),
    };
    let number = |value: Option<&Value>| -> Result<Option<f64>, RenderError> {
        match value {
            None | Some(Value::Undefined) => Ok(None),
            Some(value) => value.to_number().map(Some).map_err(coercion),
        }
    };
    Ok(Extracted {
        user_name: first_text(
            event,
            &[
                "chatter_user_name",
                "user_name",
                "from_broadcaster_user_name",
                "moderator_user_name",
            ],
        )?,
        user_login: first_text(
            event,
            &[
                "chatter_user_login",
                "user_login",
                "from_broadcaster_user_login",
                "moderator_user_login",
            ],
        )?,
        user_id: first_text(
            event,
            &[
                "chatter_user_id",
                "user_id",
                "from_broadcaster_user_id",
                "moderator_user_id",
            ],
        )?,
        broadcaster_name: first_text(
            event,
            &["broadcaster_user_name", "to_broadcaster_user_name"],
        )?,
        broadcaster_login: first_text(
            event,
            &["broadcaster_user_login", "to_broadcaster_user_login"],
        )?,
        broadcaster_id: first_text(event, &["broadcaster_user_id", "to_broadcaster_user_id"])?,
        bits: number(bits)?,
        viewers: number(event.get("viewers"))?,
    })
}

/// `normalizeScopeName`: trimmed, each run of whitespace one `_`, `default` when empty.
pub(crate) fn normalize_scope_name(name: &str) -> String {
    let mut out = String::new();
    let mut in_space = false;
    for ch in dima_text::trim(name).chars() {
        if dima_text::is_js_whitespace(ch) {
            if !in_space {
                out.push('_');
            }
            in_space = true;
        } else {
            out.push(ch);
            in_space = false;
        }
    }
    if out.is_empty() {
        "default".to_owned()
    } else {
        out
    }
}

/// `normalizeScopeNames`: normalised, without `default`, without repeats, in order.
fn normalize_scope_names(names: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in names {
        let name = normalize_scope_name(name);
        if name != "default" && !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

/// A text field of an object as `String(x || '')`.
fn text_or_empty(value: Option<&Value>) -> Result<String, RenderError> {
    match value.filter(|value| value.js_truthy()) {
        Some(value) => Ok(value.to_text().map_err(coercion)?.into_owned()),
        None => Ok(String::new()),
    }
}

/// The channel's plan as the directory stores it; anything else is Free.
pub(crate) fn plan_of(tier: Option<&str>) -> Plan {
    match tier {
        Some("premium") => Plan::Premium,
        Some("pro") => Plan::Pro,
        _ => Plan::Free,
    }
}

/// The event data as JSON, for the readers of `dima-commands` that take it.
fn json_of(value: &Value) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

impl ChatDelivery {
    /// `TwitchStreamers.getTwitchAccountById(channelID)`, within the storage deadline; `None`
    /// on a failure (logged by the directory) or a timeout.
    pub(crate) async fn streamer(&self, channel_id: &str) -> Option<StreamerAccount> {
        tokio::time::timeout(
            self.host().storage.store_deadline,
            self.host().twitch.streamer(channel_id),
        )
        .await
        .ok()
        .flatten()
    }

    /// The process's delivery and runner, as a host function sees them.
    pub(crate) fn services(&self) -> Option<Services> {
        let me = self.me.upgrade()?;
        let chat: Arc<dyn dima_twitch::chat::ChatOut> = me.clone();
        let runner: Arc<dyn crate::runner::CommandRunner> = me;
        Some(Services { chat, runner })
    }

    /// A host for a run of `channel_id` over these variables, with the services attached.
    pub(crate) fn host_for(&self, channel_id: &str, variables: VariableScope) -> DimaHost {
        let host = DimaHost::for_channel(Arc::clone(self.host()), channel_id, variables);
        match self.services() {
            Some(services) => host.with_services(services),
            None => host,
        }
    }

    /// `createSpecialExecutionContext(context, literalVariables)`.
    pub(crate) async fn prepare(
        &self,
        input: &RenderInput,
        literal: Vec<(String, String)>,
    ) -> Result<Prepared, RenderError> {
        let streamer = self.streamer(&input.channel_id).await;
        let event = match &input.event_data {
            Value::Undefined | Value::Null => Value::object(Vec::new()),
            other => other.clone(),
        };
        let eventsub = match &input.eventsub_data {
            Value::Undefined | Value::Null => Value::object(Vec::new()),
            other => other.clone(),
        };
        let extracted = extract(&event)?;
        let text = |value: &Option<String>| value.clone().map_or(Value::Undefined, Value::Text);
        let number = |value: Option<f64>| value.map_or(Value::Undefined, Value::Number);
        let mut extra = vec![
            ("userName".to_owned(), text(&extracted.user_name)),
            ("userLogin".to_owned(), text(&extracted.user_login)),
            ("userID".to_owned(), text(&extracted.user_id)),
            (
                "broadcasterName".to_owned(),
                text(&extracted.broadcaster_name),
            ),
            (
                "broadcasterLogin".to_owned(),
                text(&extracted.broadcaster_login),
            ),
            ("broadcasterID".to_owned(), text(&extracted.broadcaster_id)),
            ("bits".to_owned(), number(extracted.bits)),
            ("viewers".to_owned(), number(extracted.viewers)),
        ];
        extra.extend(input.extra_context.iter().cloned());

        let mut variables: OrderedMap<String, String> = OrderedMap::new();
        for (name, value) in input.variables.iter().chain(literal.iter()) {
            variables.insert(name.clone(), value.clone());
        }

        let level = dima_commands::runtime::user_level::resolve_authored_user_level(
            &json_of(&event),
            input.user_level,
        );
        let scope_type = input
            .scope_type
            .clone()
            .filter(|scope| !scope.is_empty())
            .unwrap_or_else(|| "command".to_owned());
        let named = match input.scope_name.as_deref().filter(|name| !name.is_empty()) {
            Some(name) => name.to_owned(),
            None => {
                let from_config = text_or_empty(eventsub.get("name"))?;
                if from_config.is_empty() {
                    text_or_empty(event.get("reward").and_then(|reward| reward.get("title")))?
                } else {
                    from_config
                }
            }
        };
        let scope_name = normalize_scope_name(&named);
        let aliases: Vec<String> = normalize_scope_names(&input.scope_aliases)
            .into_iter()
            .filter(|alias| *alias != scope_name)
            .collect();
        let plan = input
            .user_plan
            .unwrap_or_else(|| plan_of(streamer.as_ref().and_then(StreamerAccount::plan_tier)));
        let tags = if level >= 10.0 {
            vec![Value::text("broadcaster")]
        } else {
            Vec::new()
        };
        let identity = Value::object(vec![
            ("level".into(), Value::Number(level)),
            ("tags".into(), Value::List(tags)),
        ]);
        let streamer_value = match &streamer {
            Some(account) => Value::object(vec![
                ("id".into(), Value::text(account.id())),
                ("name".into(), Value::text(account.name())),
            ]),
            None => Value::Null,
        };
        let mut context = Context {
            broadcaster_id: input.channel_id.clone(),
            user_id: extracted.user_id.clone().unwrap_or_default(),
            user_login: extracted.user_login.clone().unwrap_or_default(),
            user_display_name: extracted.user_name.clone().unwrap_or_default(),
            user_plan: plan,
            user_level: level,
            enforce_function_permissions: false,
            authorization: Some(Authorization {
                origin: Origin::Authored,
                audit_origin: None,
                identity: Some(identity),
            }),
            argument: input.argument.clone(),
            event_data: event,
            eventsub_data: eventsub,
            extra_context: Value::object(extra),
            streamer: streamer_value,
            scope_type,
            scope_name: scope_name.clone(),
            scope_aliases: aliases,
            command_name: scope_name,
            effect: input.effect.clone(),
            ..Context::default()
        };
        if let Some(tree) = &input.call_tree {
            context.visited_commands = tree.visited_commands.clone();
            context.command_ref_depth = Some(tree.command_ref_depth);
            context.budget = tree.budget.clone();
            context.timer_depth = tree.timer_depth;
        }
        let state = State {
            count: if input.count.is_nan() {
                0.0
            } else {
                input.count
            },
            variables,
            ..State::default()
        };
        let host = self.host_for(
            &input.channel_id,
            VariableScope::Event {
                user_id: extracted.user_id.unwrap_or_default(),
                user_login: extracted.user_login.unwrap_or_default(),
            },
        );
        Ok(Prepared {
            context,
            state,
            host,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_names_are_normalised() {
        assert_eq!(normalize_scope_name("  Hola   mundo \t x "), "Hola_mundo_x");
        assert_eq!(normalize_scope_name("   "), "default");
        assert_eq!(normalize_scope_name("día\u{3000}uno"), "día_uno");
        assert_eq!(
            normalize_scope_names(&["a b".into(), "default".into(), "a  b".into(), "".into()]),
            ["a_b"]
        );
    }

    #[test]
    fn the_user_is_the_first_truthy_field() {
        let event = Value::object(vec![
            ("chatter_user_id".into(), Value::text("")),
            ("user_id".into(), Value::Number(42.0)),
            ("user_login".into(), Value::text("ana")),
            (
                "cheer".into(),
                Value::object(vec![("bits".into(), Value::Null)]),
            ),
        ]);
        let extracted = extract(&event).unwrap();
        assert_eq!(extracted.user_id.as_deref(), Some("42"));
        assert_eq!(extracted.user_login.as_deref(), Some("ana"));
        assert_eq!(extracted.user_name, None);
        // `cheer.bits` null: `Number(null)` is 0.
        assert_eq!(extracted.bits, Some(0.0));
        assert_eq!(extracted.viewers, None);
        // A list that is empty is truthy, and its text is empty: no user.
        let event = Value::object(vec![("chatter_user_id".into(), Value::List(Vec::new()))]);
        assert_eq!(extract(&event).unwrap().user_id, None);
    }

    #[test]
    fn plans() {
        assert_eq!(plan_of(Some("pro")), Plan::Pro);
        assert_eq!(plan_of(Some("premium")), Plan::Premium);
        assert_eq!(plan_of(Some("enterprise")), Plan::Free);
        assert_eq!(plan_of(None), Plan::Free);
    }
}

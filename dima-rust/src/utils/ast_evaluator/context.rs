use super::{JsString, JsValue, value::number_string};
use std::{any::Any, cell::RefCell, rc::Rc};

#[derive(Clone, Debug)]
pub struct OrderedMap<T, K = String>(Vec<(K, T)>);
impl<T, K> Default for OrderedMap<T, K> {
    fn default() -> Self {
        Self(Vec::new())
    }
}
impl<T, K: Eq> OrderedMap<T, K> {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn insert(&mut self, key: K, value: T) -> Option<T> {
        if let Some((_, v)) = self.0.iter_mut().find(|(k, _)| k == &key) {
            Some(std::mem::replace(v, value))
        } else {
            self.0.push((key, value));
            None
        }
    }
    pub fn get<Q: Eq + ?Sized>(&self, key: &Q) -> Option<&T>
    where
        K: std::borrow::Borrow<Q>,
    {
        self.0
            .iter()
            .find(|(k, _)| <K as std::borrow::Borrow<Q>>::borrow(k) == key)
            .map(|(_, v)| v)
    }
    pub fn contains_key<Q: Eq + ?Sized>(&self, key: &Q) -> bool
    where
        K: std::borrow::Borrow<Q>,
    {
        self.get(key).is_some()
    }
    pub fn remove<Q: Eq + ?Sized>(&mut self, key: &Q) -> Option<T>
    where
        K: std::borrow::Borrow<Q>,
    {
        self.0
            .iter()
            .position(|(k, _)| <K as std::borrow::Borrow<Q>>::borrow(k) == key)
            .map(|i| self.0.remove(i).1)
    }
    pub fn iter(&self) -> impl Iterator<Item = (&K, &T)> {
        self.0.iter().map(|(k, v)| (k, v))
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}
pub type SharedMap<T, K = String> = Rc<RefCell<OrderedMap<T, K>>>;
fn map<T, K: Eq>() -> SharedMap<T, K> {
    Rc::new(RefCell::new(OrderedMap::new()))
}

/// Mutable map identity over a copy-on-write insertion-ordered map. Fork is O(1);
/// read-only body nodes never copy entries. An actual write detaches a shared map.
#[derive(Clone, Debug, Default)]
pub struct LoopVars(Rc<RefCell<Rc<OrderedMap<JsString>>>>);
impl LoopVars {
    pub fn get(&self, key: &str) -> Option<JsString> {
        self.0.borrow().get(key).cloned()
    }
    pub fn insert(&self, key: String, value: JsString) -> bool {
        let mut map = self.0.borrow_mut();
        let copied = Rc::strong_count(&map) > 1;
        Rc::make_mut(&mut map).insert(key, value);
        copied
    }
    pub fn fork(&self) -> Self {
        Self(Rc::new(RefCell::new(self.0.borrow().clone())))
    }
    pub fn iter(&self) -> Vec<(String, JsString)> {
        self.0
            .borrow()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
    pub fn same_identity(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

/// Only embedding code can supply this native capability. Plain data and
/// deserialization never construct one, and Debug does not expose its contents.
#[derive(Clone)]
pub struct EffectToken(Rc<dyn Any>);
impl EffectToken {
    pub fn from_host<T: Any>(value: T) -> Self {
        Self(Rc::new(value))
    }
    pub fn downcast_ref<T: Any>(&self) -> Option<&T> {
        self.0.downcast_ref()
    }
    pub fn same_identity(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}
impl std::fmt::Debug for EffectToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("EffectToken(<opaque>)")
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoopExit {
    Break,
    Continue,
}
#[derive(Clone, Debug)]
pub struct CommandRefBudget {
    pub remaining: f64,
}
#[derive(Clone, Debug)]
pub struct CommandReferenceState {
    pub visited_commands: Vec<String>,
    pub command_ref_depth: f64,
    pub command_ref_budget: Rc<RefCell<CommandRefBudget>>,
    pub timer_depth: Option<f64>,
}
impl CommandReferenceState {
    pub fn to_value(&self) -> JsValue {
        JsValue::object(vec![
            (
                "visitedCommands".into(),
                JsValue::array(self.visited_commands.iter().map(JsValue::string).collect()),
            ),
            (
                "commandRefDepth".into(),
                JsValue::Number(self.command_ref_depth),
            ),
            (
                "commandRefBudget".into(),
                budget_value(self.command_ref_budget.borrow().remaining),
            ),
            ("timerDepth".into(), optional_number(self.timer_depth)),
        ])
    }
}
#[derive(Clone, Debug)]
pub struct CommandReference {
    pub effect_context: Option<EffectToken>,
    pub channel_id: String,
    pub command_name: String,
    pub argument: JsString,
    pub event_data: JsValue,
    pub authorization: JsValue,
    pub state: CommandReferenceState,
}
impl CommandReference {
    pub fn to_value(&self) -> JsValue {
        JsValue::object(vec![
            ("channelID".into(), JsValue::string(&self.channel_id)),
            ("commandName".into(), JsValue::string(&self.command_name)),
            ("argument".into(), JsValue::String(self.argument.clone())),
            ("eventData".into(), self.event_data.clone()),
            ("authorization".into(), self.authorization.clone()),
            ("state".into(), self.state.to_value()),
        ])
    }
}
fn budget_value(remaining: f64) -> JsValue {
    JsValue::object(vec![("remaining".into(), JsValue::Number(remaining))])
}
fn optional_number(v: Option<f64>) -> JsValue {
    v.map(JsValue::Number).unwrap_or_default()
}

pub type Context = Rc<RefCell<ExecutionContext>>;
/// Clone is JavaScript object spread: scalars copied; Map/Array/object handles
/// and command budget shared. Loop entry/body copies explicitly fork loop_vars.
#[derive(Clone, Debug)]
pub struct ExecutionContext {
    pub variables: SharedMap<JsValue>,
    pub arrays: SharedMap<JsValue>,
    pub broadcaster_id: String,
    pub user_id: String,
    pub user_login: String,
    pub user_display_name: String,
    pub user_plan: String,
    pub user_level: f64,
    pub enforce_function_permissions: bool,
    pub authorization: JsValue,
    pub argument: Option<JsString>,
    pub count: f64,
    pub event_data: JsValue,
    pub eventsub_data: JsValue,
    pub extra_context: JsValue,
    pub streamer: JsValue,
    pub platform: String,
    pub scope_type: String,
    pub scope_name: String,
    pub scope_aliases: Rc<RefCell<Vec<JsValue>>>,
    pub command_name: String,
    pub command_id: String,
    pub command_references: Rc<RefCell<Vec<CommandReference>>>,
    pub command_ref_budget: Rc<RefCell<CommandRefBudget>>,
    pub visited_commands: Option<Rc<RefCell<Vec<String>>>>,
    pub command_ref_depth: Option<f64>,
    pub loop_exit: Option<LoopExit>,
    pub loop_vars: Option<LoopVars>,
    pub loop_depth: Option<f64>,
    pub command_responses: Rc<RefCell<Vec<JsValue>>>,
    pub command_variables: SharedMap<JsString>,
    pub user_command_variables: SharedMap<JsString, JsString>,
    pub count_modified: Option<bool>,
    pub timer_depth: Option<f64>,
    pub effect_context: Option<EffectToken>,
}
impl Default for ExecutionContext {
    fn default() -> Self {
        Self {
            variables: map(),
            arrays: map(),
            broadcaster_id: String::new(),
            user_id: String::new(),
            user_login: String::new(),
            user_display_name: String::new(),
            user_plan: "free".into(),
            user_level: 1.0,
            enforce_function_permissions: true,
            authorization: JsValue::Undefined,
            argument: None,
            count: 0.0,
            event_data: JsValue::Undefined,
            eventsub_data: JsValue::Undefined,
            extra_context: JsValue::Undefined,
            streamer: JsValue::Null,
            platform: "twitch".into(),
            scope_type: "command".into(),
            scope_name: String::new(),
            scope_aliases: Rc::new(RefCell::new(Vec::new())),
            command_name: String::new(),
            command_id: String::new(),
            command_references: Rc::new(RefCell::new(Vec::new())),
            command_ref_budget: Rc::new(RefCell::new(CommandRefBudget { remaining: 50.0 })),
            visited_commands: None,
            command_ref_depth: None,
            loop_exit: None,
            loop_vars: Some(LoopVars::default()),
            loop_depth: Some(0.0),
            command_responses: Rc::new(RefCell::new(Vec::new())),
            command_variables: map(),
            user_command_variables: map(),
            count_modified: Some(false),
            timer_depth: None,
            effect_context: None,
        }
    }
}
impl ExecutionContext {
    pub fn into_context(self) -> Context {
        Rc::new(RefCell::new(self))
    }
}
pub(crate) fn shallow(ctx: &Context) -> Context {
    ctx.borrow().clone().into_context()
}
pub(crate) fn fork_loop_vars(ctx: &Context) {
    let vars = ctx
        .borrow()
        .loop_vars
        .as_ref()
        .map(LoopVars::fork)
        .unwrap_or_default();
    ctx.borrow_mut().loop_vars = Some(vars);
}
pub(crate) fn loop_insert(ctx: &Context, name: &str, value: JsString) -> bool {
    let mut c = ctx.borrow_mut();
    c.loop_vars
        .get_or_insert_with(LoopVars::default)
        .insert(name.into(), value)
}

/// Exactly the data fields in timer.ts. Top-level map entries and the budget
/// are copied; map-contained values, event objects and responses remain shared
/// until the scheduler serializes. No effect authority or callbacks cross it.
pub fn snapshot_timer_context(context: &Context) -> JsValue {
    let c = context.borrow();
    let entries = |m: &SharedMap<JsValue>| {
        JsValue::array(
            m.borrow()
                .iter()
                .map(|(k, v)| JsValue::array(vec![JsValue::string(k), v.clone()]))
                .collect(),
        )
    };
    JsValue::object(vec![
        ("broadcasterId".into(), JsValue::string(&c.broadcaster_id)),
        ("userId".into(), JsValue::string(&c.user_id)),
        ("userLogin".into(), JsValue::string(&c.user_login)),
        (
            "userDisplayName".into(),
            JsValue::string(&c.user_display_name),
        ),
        ("userPlan".into(), JsValue::string(&c.user_plan)),
        ("userLevel".into(), JsValue::Number(c.user_level)),
        (
            "enforceFunctionPermissions".into(),
            JsValue::Boolean(c.enforce_function_permissions),
        ),
        ("authorization".into(), c.authorization.clone()),
        (
            "argument".into(),
            c.argument.clone().map(JsValue::String).unwrap_or_default(),
        ),
        ("count".into(), JsValue::Number(c.count)),
        ("eventData".into(), c.event_data.clone()),
        ("eventsubData".into(), c.eventsub_data.clone()),
        ("extraContext".into(), c.extra_context.clone()),
        ("platform".into(), JsValue::string(&c.platform)),
        ("scopeType".into(), JsValue::string(&c.scope_type)),
        ("scopeName".into(), JsValue::string(&c.scope_name)),
        (
            "scopeAliases".into(),
            JsValue::Array(c.scope_aliases.clone()),
        ),
        ("commandName".into(), JsValue::string(&c.command_name)),
        ("commandId".into(), JsValue::string(&c.command_id)),
        (
            "commandRefBudget".into(),
            budget_value(c.command_ref_budget.borrow().remaining),
        ),
        (
            "commandRefDepth".into(),
            optional_number(c.command_ref_depth),
        ),
        (
            "visitedCommands".into(),
            JsValue::array(
                c.visited_commands
                    .as_ref()
                    .map(|v| v.borrow().iter().map(JsValue::string).collect())
                    .unwrap_or_default(),
            ),
        ),
        (
            "commandResponses".into(),
            JsValue::Array(c.command_responses.clone()),
        ),
        ("variables".into(), entries(&c.variables)),
        ("arrays".into(), entries(&c.arrays)),
        (
            "loopVars".into(),
            JsValue::array(
                c.loop_vars
                    .as_ref()
                    .map(LoopVars::iter)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(k, v)| JsValue::array(vec![JsValue::string(k), JsValue::String(v)]))
                    .collect(),
            ),
        ),
        (
            "timerDepth".into(),
            JsValue::Number(c.timer_depth.unwrap_or(0.0) + 1.0),
        ),
    ])
}

pub fn resolve_command_ref_authorization(context: &Context) -> JsValue {
    use crate::utils::permissions::{create_broadcaster_identity, parse_user_identity};
    let c = context.borrow();
    let (origin, identity) = if !c.enforce_function_permissions {
        ("authored", create_broadcaster_identity())
    } else {
        let fallback = if c.user_level.is_finite() {
            c.user_level.trunc().clamp(1.0, 10.0)
        } else {
            1.0
        };
        let raw = c.authorization.get("identity");
        // Decode only the identity fields the reused permission helper reads.
        // Unknown/cyclic fields and lone surrogates in irrelevant fields cannot
        // invalidate otherwise valid level/tags by failing a whole-object JSON roundtrip.
        let mut fields = serde_json::Map::new();
        if let JsValue::Number(n) = raw.get("level")
            && let Some(n) = serde_json::Number::from_f64(n)
        {
            fields.insert("level".into(), serde_json::Value::Number(n));
        }
        if let JsValue::Array(tags) = raw.get("tags") {
            fields.insert(
                "tags".into(),
                serde_json::Value::Array(
                    tags.borrow()
                        .iter()
                        .filter_map(|v| {
                            if let JsValue::String(s) = v {
                                s.to_utf8().ok().map(serde_json::Value::String)
                            } else {
                                None
                            }
                        })
                        .collect(),
                ),
            );
        }
        for key in ["userId", "login"] {
            if let JsValue::String(s) = raw.get(key)
                && let Ok(s) = s.to_utf8()
            {
                fields.insert(key.into(), serde_json::Value::String(s));
            }
        }
        (
            "llm",
            parse_user_identity(Some(&serde_json::Value::Object(fields)), fallback),
        )
    };
    JsValue::object(vec![
        ("origin".into(), JsValue::string(origin)),
        ("identity".into(), {
            let mut fields = vec![
                ("level".into(), JsValue::Number(identity.level())),
                (
                    "tags".into(),
                    JsValue::from_json(&identity.serialize()["tags"]),
                ),
            ];
            if let Some(id) = identity.user_id() {
                fields.push(("userId".into(), JsValue::string(id)));
            }
            if let Some(login) = identity.login() {
                fields.push(("login".into(), JsValue::string(login)));
            }
            JsValue::object(fields)
        }),
    ])
}

pub(crate) fn permission_denied(name: &str, required: f64, actual: f64) -> String {
    let role = match required {
        7.0 => "moderator".into(),
        8.0 => "editor".into(),
        9.0 => "admin".into(),
        10.0 => "broadcaster".into(),
        _ => format!("level {}", number_string(required)),
    };
    format!(
        "Error: permission denied - '{name}' requires {role} permissions (userlevel {}), but the requesting user only has userlevel {}. Do not retry this action; explain to the user that someone with the required role has to do it.",
        number_string(required),
        number_string(actual)
    )
}

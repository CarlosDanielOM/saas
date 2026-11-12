//! Running the evaluator corpora (`fixtures/ast_evaluator_cases.json`, `ast_pure_cases.json`,
//! generated from today's TypeScript by `fixtures/ast_{evaluator,pure}_reference.mjs` under
//! Node 24) against the engine, and the observation format they record.
//!
//! [`CorpusHost`] is the generator's fake host: the same event log (`cache.get`, `db.save`,
//! `handler`, `random`, `timer.schedule`, effect hashes…), the same in-memory cache and
//! database, the same seeded `Math.random`, the same effect authority (`effects.ts`'s path and
//! counters), the same fixture functions. [`observe`] builds the generator's observation from a
//! Rust run, field for field; [`expected`] is the recorded TypeScript observation with every
//! intended difference applied, each in one place and counted ([`Difference`]).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]

use dima_core::{Clock, ManualClock, Random, RandomError};
use dima_engine::context::{
    Authorization, Budget, CommandReference, Context, Effect, LoopExit, Origin, Plan, State,
    TimerSnapshot,
};
use dima_engine::eval::{Engine, EvalError, EvalLimits};
use dima_engine::host::{Host, HostCall, HostError, HostFunction, HostFuture};
use dima_engine::map::OrderedMap;
use dima_engine::permissions::UserIdentity;
use dima_engine::registry::{Builtin, FunctionKind, Metadata, Registry};
use dima_engine::syntax::AstNode;
use dima_engine::value::Value;
use serde_json::{Value as Json, json};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

// ---------------------------------------------------------------------------------------------
// Reading the corpus.

pub fn load(name: &str) -> Json {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let raw = std::fs::read(path).expect("corpus file");
    serde_json::from_slice(&raw).expect("corpus JSON")
}

/// Why a recorded case cannot be run in Rust at all (its input cannot exist here).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Unrepresentable {
    /// A string with an unpaired surrogate (`{"utf16": […]}`): a Rust string cannot hold one.
    LoneSurrogate,
    /// A function value (the fixture returns one; no host can).
    FunctionValue,
    /// An AST tag the parser never produces (`fixture-unknown`).
    UnknownTag,
    /// The fixture `fixture.write` writes the run's variables from a host function; host
    /// functions cannot.
    HostWritesVariables,
    /// A context field the reference types as text (`argument`, names, variable values) given
    /// another value by the fixture.
    NonTextField,
}

/// An input value in the generator's transport (`$value`, `$object`, `$utf16`, plain JSON).
pub fn decode(value: &Json) -> Result<Value, Unrepresentable> {
    Ok(match value {
        Json::Null => Value::Null,
        Json::Bool(flag) => Value::Bool(*flag),
        Json::Number(n) => Value::Number(n.as_f64().unwrap()),
        Json::String(text) => Value::Text(text.clone()),
        Json::Array(items) => Value::List(items.iter().map(decode).collect::<Result<_, _>>()?),
        Json::Object(map) if map.len() == 1 && map.contains_key("$value") => {
            match map["$value"].as_str().unwrap() {
                "undefined" => Value::Undefined,
                "NaN" => Value::Number(f64::NAN),
                "Infinity" => Value::Number(f64::INFINITY),
                "-Infinity" => Value::Number(f64::NEG_INFINITY),
                "-0" => Value::Number(-0.0),
                "function" => return Err(Unrepresentable::FunctionValue),
                other => panic!("unknown marker {other}"),
            }
        }
        Json::Object(map) if map.len() == 1 && map.contains_key("$utf16") => {
            return Err(Unrepresentable::LoneSurrogate);
        }
        Json::Object(map) if map.len() == 1 && map.contains_key("$object") => {
            let mut entries = Vec::new();
            for pair in map["$object"].as_array().unwrap() {
                let key = pair[0]
                    .as_str()
                    .ok_or(Unrepresentable::LoneSurrogate)?
                    .to_owned();
                entries.push((key, decode(&pair[1])?));
            }
            Value::object(entries)
        }
        Json::Object(map) => Value::object(
            map.iter()
                .map(|(k, v)| Ok((k.clone(), decode(v)?)))
                .collect::<Result<_, _>>()?,
        ),
    })
}

fn text(value: &Json) -> Result<String, Unrepresentable> {
    match decode(value)? {
        Value::Text(text) => Ok(text),
        _ => Err(Unrepresentable::NonTextField),
    }
}

fn pairs(value: Option<&Json>) -> Result<Vec<(String, Json)>, Unrepresentable> {
    let Some(items) = value.and_then(Json::as_array) else {
        return Ok(Vec::new());
    };
    items
        .iter()
        .map(|pair| {
            let key = pair[0]
                .as_str()
                .ok_or(Unrepresentable::LoneSurrogate)?
                .to_owned();
            Ok((key, pair[1].clone()))
        })
        .collect()
}

fn text_map(value: Option<&Json>) -> Result<OrderedMap<String, String>, Unrepresentable> {
    pairs(value)?
        .into_iter()
        .map(|(k, v)| Ok((k, text(&v)?)))
        .collect()
}

/// `effects.ts` state, as the fake host keeps it.
#[derive(Debug)]
pub struct EffectState {
    channel: String,
    path: Vec<String>,
    next: Mutex<u64>,
}

/// The run a case asks for.
pub struct CaseInput {
    pub context: Context,
    pub state: State,
    pub host: CorpusHost,
    pub registry: Registry,
}

/// Builds the context, state, host and registry of a case (`fresh` in the generator).
pub fn case_input(input: &Json) -> Result<CaseInput, Unrepresentable> {
    let raw = input.get("context").cloned().unwrap_or(json!({}));
    let c = raw.as_object().unwrap();
    let get = |key: &str| c.get(key);
    let mut context = Context {
        broadcaster_id: "123".into(),
        user_id: "456".into(),
        user_login: "caller".into(),
        user_display_name: "Caller".into(),
        ..Context::default()
    };
    if let Some(v) = get("broadcasterId") {
        context.broadcaster_id = text(v)?;
    }
    if let Some(v) = get("userId") {
        context.user_id = text(v)?;
    }
    if let Some(v) = get("userLogin") {
        context.user_login = text(v)?;
    }
    if let Some(v) = get("userDisplayName") {
        context.user_display_name = text(v)?;
    }
    if let Some(v) = get("userPlan") {
        context.user_plan = match v.as_str() {
            Some("premium") => Plan::Premium,
            Some("pro") => Plan::Pro,
            _ => Plan::Free,
        };
    }
    if let Some(v) = get("userLevel") {
        context.user_level = match decode(v)? {
            Value::Number(n) => n,
            _ => return Err(Unrepresentable::NonTextField),
        };
    }
    if let Some(v) = get("enforceFunctionPermissions") {
        context.enforce_function_permissions = v.as_bool().unwrap();
    }
    if let Some(v) = get("authorization") {
        let origin = match v["origin"].as_str() {
            Some("chat") => Origin::Chat,
            Some("llm") => Origin::Llm,
            _ => Origin::Authored,
        };
        context.authorization = Some(Authorization {
            origin,
            audit_origin: None,
            identity: v.get("identity").map(decode).transpose()?,
        });
    }
    if let Some(v) = get("argument") {
        context.argument = Some(text(v)?);
    }
    if let Some(v) = get("eventData") {
        context.event_data = decode(v)?;
    }
    if let Some(v) = get("extraContext") {
        context.extra_context = decode(v)?;
    }
    if let Some(v) = get("platform") {
        context.platform = text(v)?;
    }
    if let Some(v) = get("commandRefBudget") {
        context.budget = Budget::new(v["remaining"].as_f64().unwrap() as i64);
    }
    if let Some(v) = get("visitedCommands") {
        context.visited_commands = v
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_owned())
            .collect();
    }
    if let Some(v) = get("commandRefDepth") {
        context.command_ref_depth = Some(v.as_f64().unwrap() as u32);
    }
    if let Some(v) = get("timerDepth") {
        context.timer_depth = Some(v.as_f64().unwrap() as u32);
    }
    let mut state = State::default();
    if let Some(v) = get("count") {
        state.count = match decode(v)? {
            Value::Number(n) => n,
            _ => return Err(Unrepresentable::NonTextField),
        };
    }
    if let Some(v) = get("loopDepth") {
        state.loop_depth = v.as_f64().unwrap() as u32;
    }
    state.variables = text_map(get("variables"))?;
    state.loop_vars = text_map(get("loopVars"))?;
    state.command_variables = text_map(get("commandVariables"))?;
    state.user_command_variables = text_map(get("userCommandVariables"))?;
    for (key, items) in pairs(get("arrays"))? {
        let items = items
            .as_array()
            .unwrap()
            .iter()
            .map(text)
            .collect::<Result<_, _>>()?;
        state.arrays.insert(key, items);
    }
    if let Some(v) = get("commandResponses") {
        state.command_responses = v
            .as_array()
            .unwrap()
            .iter()
            .map(text)
            .collect::<Result<_, _>>()?;
    }
    let numeric_channel = !context.broadcaster_id.is_empty()
        && context.broadcaster_id.len() <= 30
        && context.broadcaster_id.bytes().all(|b| b.is_ascii_digit());
    if get("effect").and_then(Json::as_bool) == Some(true) && numeric_channel {
        context.effect = Some(Effect::new(EffectState {
            channel: context.broadcaster_id.clone(),
            path: vec!["fixture-config".into()],
            next: Mutex::new(0),
        }));
    }
    let spec = input.get("host").cloned().unwrap_or(json!({}));
    let value_map = |key: &str| -> Result<OrderedMap<String, Value>, Unrepresentable> {
        pairs(spec.get(key))?
            .into_iter()
            .map(|(k, v)| Ok((k, decode(&v)?)))
            .collect()
    };
    let host = CorpusHost {
        log: Log::default(),
        cache: value_map("cache")?,
        db: value_map("db")?,
        db_user: value_map("dbUser")?,
        return_value: spec
            .get("returnValue")
            .map(decode)
            .transpose()?
            .unwrap_or(Value::Undefined),
        throw_on: spec
            .get("throwOn")
            .and_then(Json::as_str)
            .map(str::to_owned),
        scheduler_throws: spec
            .get("schedulerThrows")
            .and_then(Json::as_bool)
            .unwrap_or(false),
        timers: Vec::new(),
        user_login: context.user_login.clone(),
        clock: ManualClock::new(0),
        random: CorpusRandom {
            seed: Mutex::new(spec.get("randomSeed").and_then(Json::as_f64).unwrap_or(1.0) as u32),
            log: Log::default(),
        },
    };
    let mut host = host;
    host.random.log = host.log.clone();
    let registry = case_registry(input);
    Ok(CaseInput {
        context,
        state,
        host,
        registry,
    })
}

const PURE: [&str; 28] = [
    "upper",
    "lower",
    "title",
    "capitalize",
    "trim",
    "length",
    "slice",
    "replace",
    "user",
    "touser",
    "random",
    "ban.time",
    "twitch.modiversary",
    "twitch.streak",
    "raid.channel",
    "raid.login",
    "raid.viewers",
    "cheer.amount",
    "cheer.message",
    "sub.tier",
    "sub.months",
    "gifted.user",
    "hypetrain.progress",
    "hypetrain.level",
    "hypetrain.end",
    "shoutout.channel",
    "reward.input",
    "redemption.input",
];

/// The functions a case runs with: the generator's fixtures, plus the reference's context
/// builtins (`contextBuiltins`) and pure functions (`pureBuiltins`) when the case asks.
fn case_registry(input: &Json) -> Registry {
    let standard = Registry::standard();
    let mut registry = Registry::empty();
    let gate = |level: f64| Metadata {
        min_user_level: Some(level),
        ..Metadata::default()
    };
    let custom = FunctionKind::Host(HostFunction::Custom);
    for name in [
        "fixture.echo",
        "fixture.value",
        "fixture.write",
        "fixture.throw",
    ] {
        registry.register(name, custom, None);
    }
    // `ctx.count++; ctx.countModified = true; return String(ctx.count)` is `scount`.
    registry.register(
        "fixture.count",
        FunctionKind::Builtin(Builtin::Scount),
        None,
    );
    registry.register("fixture.gated7", custom, Some(gate(7.0)));
    registry.register("fixture.gated8", custom, Some(gate(8.0)));
    let mut adopt = |name: &str| {
        let spec = standard.get(name).unwrap();
        registry.register(name, spec.kind, spec.metadata.clone());
    };
    if input.get("contextBuiltins").and_then(Json::as_bool) == Some(true) {
        for name in ["count", "scount", "bits", "break", "continue"] {
            adopt(name);
        }
    } else {
        // The generator installs a break/continue that only acts inside loops (where its cases
        // use them); outside a loop no case calls them.
        for name in ["break", "continue"] {
            adopt(name);
        }
    }
    if input.get("pureBuiltins").and_then(Json::as_bool) == Some(true) {
        for name in PURE {
            adopt(name);
        }
    }
    registry.register("fixture.effect", custom, None);
    registry
}

// ---------------------------------------------------------------------------------------------
// The fake host.

#[derive(Clone, Debug, Default)]
pub struct Log(Arc<Mutex<Vec<Json>>>);

impl Log {
    fn push(&self, event: Vec<Json>) {
        self.0
            .lock()
            .unwrap()
            .push(json!({"type": "array", "value": event}));
    }

    pub fn events(&self) -> Vec<Json> {
        self.0.lock().unwrap().clone()
    }
}

/// `Math.random` of the generator: `seed = seed * 1664525 + 1013904223 (mod 2^32)`.
#[derive(Debug)]
pub struct CorpusRandom {
    seed: Mutex<u32>,
    log: Log,
}

impl Random for CorpusRandom {
    fn fill(&self, buf: &mut [u8]) -> Result<(), RandomError> {
        buf.fill(0);
        Ok(())
    }

    fn float(&self) -> Result<f64, RandomError> {
        let mut seed = self.seed.lock().unwrap();
        *seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let value = f64::from(*seed) / 4_294_967_296.0;
        self.log
            .push(vec![s("random"), typed(&Value::Number(value))]);
        Ok(value)
    }
}

#[derive(Debug)]
pub struct TimerCapture {
    pub seconds: f64,
    pub body: Vec<AstNode>,
    pub snapshot: TimerSnapshot,
}

pub struct CorpusHost {
    pub log: Log,
    pub cache: OrderedMap<String, Value>,
    pub db: OrderedMap<String, Value>,
    pub db_user: OrderedMap<String, Value>,
    return_value: Value,
    throw_on: Option<String>,
    scheduler_throws: bool,
    pub timers: Vec<TimerCapture>,
    user_login: String,
    clock: ManualClock,
    random: CorpusRandom,
}

fn s(text: &str) -> Json {
    json!({"type": "string", "value": text})
}

fn undefined() -> Json {
    json!({"type": "undefined"})
}

fn opt(text: Option<&str>) -> Json {
    text.map_or_else(undefined, s)
}

impl CorpusHost {
    fn event(&self, name: &str, args: Vec<Json>) -> Result<(), HostError> {
        let mut event = vec![s(name)];
        event.extend(args);
        self.log.push(event);
        if self.throw_on.as_deref() == Some(name) {
            return Err(HostError::new(format!("fixture host failure: {name}")));
        }
        Ok(())
    }

    fn stored(value: Option<&Value>) -> String {
        match value {
            Some(Value::Text(text)) => text.clone(),
            Some(other) if !other.is_nullish() => other.to_text().into_owned(),
            _ => String::new(),
        }
    }

    fn user_key(&self, name: &str, target: Option<&str>) -> String {
        format!("{name}:{}", target.unwrap_or(&self.user_login))
    }

    fn effect_action(&self, call: &HostCall<'_>) -> Value {
        let state = call
            .effect
            .and_then(|effect| effect.downcast_ref::<EffectState>())
            .filter(|state| !state.path.is_empty() && call.context.broadcaster_id == state.channel);
        let Some(state) = state else {
            return Value::Undefined;
        };
        let mut next = state.next.lock().unwrap();
        let path: Vec<Json> = state.path.iter().map(|p| json!(p)).collect();
        let input = serde_json::to_string(&json!([path, *next])).unwrap();
        *next += 1;
        self.log.push(vec![
            s("deterministic fake host event: effect hash"),
            s("sha256"),
            s(&input),
            s("hex"),
        ]);
        Value::object(vec![
            (
                "origin".into(),
                Value::object(vec![
                    ("id".into(), Value::text("fixture-event")),
                    ("kind".into(), Value::text("chat-command")),
                    ("occurredAt".into(), Value::text("2026-01-01T00:00:00.000Z")),
                ]),
            ),
            (
                "actor".into(),
                Value::object(vec![
                    ("userId".into(), Value::text("456")),
                    ("displayName".into(), Value::text("Caller")),
                ]),
            ),
            (
                "actionKey".into(),
                Value::Text(format!("pet:v1:fixture-hash:{input}")),
            ),
        ])
    }
}

type Reply<'a, T> = HostFuture<'a, Result<T, HostError>>;

fn ready<'a, T: Send + 'a>(value: Result<T, HostError>) -> Reply<'a, T> {
    Box::pin(async move { value })
}

impl Host for CorpusHost {
    fn clock(&self) -> &dyn Clock {
        &self.clock
    }

    fn random(&self) -> &dyn Random {
        &self.random
    }

    fn call<'a>(&'a mut self, call: HostCall<'a>) -> HostFuture<'a, Result<Value, HostError>> {
        let args = typed(&Value::List(call.args.clone()));
        let event = self.event("handler", vec![s(call.name), args]);
        let result = event.and_then(|()| match call.name {
            "fixture.echo" => Ok(Value::Text(
                call.args
                    .iter()
                    .map(|v| v.to_text_or_empty().into_owned())
                    .collect::<Vec<_>>()
                    .join("|"),
            )),
            "fixture.value" => Ok(call
                .args
                .first()
                .cloned()
                .unwrap_or_else(|| self.return_value.clone())),
            "fixture.throw" => Err(HostError::new("fixture handler throw")),
            "fixture.gated7" => Ok(Value::text("ran-7")),
            "fixture.gated8" => Ok(Value::text("ran-8")),
            "fixture.effect" => {
                let value = self.effect_action(&call);
                self.log.push(vec![
                    s("deterministic fake host event: effect action"),
                    typed(&value),
                ]);
                Ok(value)
            }
            other => panic!("unexpected host function {other}"),
        });
        ready(result)
    }

    fn sleep(&mut self, _millis: u64) -> HostFuture<'_, ()> {
        Box::pin(async {})
    }

    fn cache_get<'a>(&'a mut self, key: &'a str) -> Reply<'a, Option<String>> {
        let result = self
            .event("cache.get", vec![s(key)])
            .map(|()| self.cache.get(key).map(|v| Self::stored(Some(v))));
        ready(result)
    }

    fn cache_exists<'a>(&'a mut self, key: &'a str) -> Reply<'a, bool> {
        let result = self
            .event("cache.exists", vec![s(key)])
            .map(|()| self.cache.contains_key(key));
        ready(result)
    }

    fn cache_set<'a>(&'a mut self, key: &'a str, value: &'a str) -> Reply<'a, ()> {
        let result = self.event("cache.set", vec![s(key), s(value)]);
        if result.is_ok() {
            self.cache.insert(key.to_owned(), Value::text(value));
        }
        ready(result)
    }

    fn cache_expire<'a>(&'a mut self, key: &'a str, seconds: u64) -> Reply<'a, ()> {
        ready(self.event(
            "cache.expire",
            vec![s(key), typed(&Value::Number(seconds as f64))],
        ))
    }

    fn cache_delete<'a>(&'a mut self, key: &'a str) -> Reply<'a, ()> {
        let result = self.event("cache.del", vec![s(key)]);
        if result.is_ok() {
            self.cache.remove(key);
        }
        ready(result)
    }

    fn load_channel_variable<'a>(&'a mut self, name: &'a str) -> Reply<'a, String> {
        let result = self
            .event("db.load", vec![s(name)])
            .map(|()| Self::stored(self.db.get(name)));
        ready(result)
    }

    fn save_channel_variable<'a>(&'a mut self, name: &'a str, value: &'a str) -> Reply<'a, ()> {
        let result = self.event("db.save", vec![s(name), s(value)]);
        if result.is_ok() {
            self.db.insert(name.to_owned(), Value::text(value));
        }
        ready(result)
    }

    fn delete_channel_variable<'a>(&'a mut self, name: &'a str) -> Reply<'a, ()> {
        let result = self.event("db.delete", vec![s(name)]);
        if result.is_ok() {
            self.db.remove(name);
        }
        ready(result)
    }

    fn load_user_variable<'a>(
        &'a mut self,
        name: &'a str,
        target: Option<&'a str>,
    ) -> Reply<'a, String> {
        let key = self.user_key(name, target);
        let result = self
            .event("dbUser.load", vec![s(name), opt(target)])
            .map(|()| Self::stored(self.db_user.get(&key)));
        ready(result)
    }

    fn save_user_variable<'a>(
        &'a mut self,
        name: &'a str,
        value: &'a str,
        target: Option<&'a str>,
    ) -> Reply<'a, ()> {
        let key = self.user_key(name, target);
        let result = self.event("dbUser.save", vec![s(name), s(value), opt(target)]);
        if result.is_ok() {
            self.db_user.insert(key, Value::text(value));
        }
        ready(result)
    }

    fn delete_user_variable<'a>(
        &'a mut self,
        name: &'a str,
        target: Option<&'a str>,
    ) -> Reply<'a, ()> {
        let key = self.user_key(name, target);
        let result = self.event("dbUser.delete", vec![s(name), opt(target)]);
        if result.is_ok() {
            self.db_user.remove(&key);
        }
        ready(result)
    }

    fn save_responses<'a>(&'a mut self, responses: &'a [String]) -> Reply<'a, ()> {
        let list = Value::List(responses.iter().map(|r| Value::text(r.as_str())).collect());
        ready(self.event("responses.save", vec![typed(&list)]))
    }

    fn schedule_timer<'a>(
        &'a mut self,
        seconds: f64,
        body: &'a [AstNode],
        snapshot: TimerSnapshot,
    ) -> Reply<'a, ()> {
        let root = AstNode::Root {
            children: body.to_vec(),
        };
        self.log.push(vec![
            s("timer.schedule"),
            typed(&Value::Number(seconds)),
            typed_json(&root.to_value()),
            typed_snapshot(&snapshot),
        ]);
        self.timers.push(TimerCapture {
            seconds,
            body: body.to_vec(),
            snapshot,
        });
        if self.scheduler_throws {
            // The reference logs the failure where it catches it (the host does here).
            self.log.push(vec![
                s("console.error"),
                s("AST timer scheduling failed"),
                s("123"),
                s("fixture scheduler failure"),
            ]);
            return ready(Err(HostError::new("fixture scheduler failure")));
        }
        ready(Ok(()))
    }

    fn fork_effect(&mut self, effect: &Effect) -> Option<Effect> {
        let state = effect.downcast_ref::<EffectState>()?;
        if state.path.is_empty() {
            return None;
        }
        let mut next = state.next.lock().unwrap();
        let mut path = state.path.clone();
        path.push(format!("reference:{}", *next));
        *next += 1;
        Some(Effect::new(EffectState {
            channel: state.channel.clone(),
            path,
            next: Mutex::new(0),
        }))
    }
}

// ---------------------------------------------------------------------------------------------
// The typed observation format.

pub fn number(n: f64) -> Json {
    let value = if n.is_nan() {
        json!("NaN")
    } else if n == f64::INFINITY {
        json!("Infinity")
    } else if n == f64::NEG_INFINITY {
        json!("-Infinity")
    } else if n == 0.0 && n.is_sign_negative() {
        json!("-0")
    } else {
        json!(n)
    };
    json!({"type": "number", "value": value})
}

/// `typed(value)` of the generator.
pub fn typed(value: &Value) -> Json {
    match value {
        Value::Undefined => undefined(),
        Value::Null => json!({"type": "null"}),
        Value::Bool(flag) => json!({"type": "boolean", "value": flag}),
        Value::Number(n) => number(*n),
        Value::Text(text) => s(text),
        Value::List(items) => {
            json!({"type": "array", "value": items.iter().map(typed).collect::<Vec<_>>()})
        }
        Value::Object(entries) => json!({
            "type": "object",
            "value": entries.iter().map(|(k, v)| json!([k, typed(v)])).collect::<Vec<_>>()
        }),
    }
}

/// `typed` of plain JSON (an AST, for instance).
pub fn typed_json(value: &Json) -> Json {
    typed(&Value::from(value.clone()))
}

fn object(entries: Vec<(&str, Json)>) -> Json {
    json!({"type": "object", "value": entries.into_iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>()})
}

fn array(items: Vec<Json>) -> Json {
    json!({"type": "array", "value": items})
}

/// A map as the generator records it: plain `[key, typed value]` pairs.
fn typed_pairs<'a>(items: impl Iterator<Item = (&'a String, Json)>) -> Json {
    Json::Array(items.map(|(k, v)| json!([k, v])).collect())
}

fn typed_authorization(authorization: Option<&Authorization>) -> Json {
    let Some(a) = authorization else {
        return undefined();
    };
    let origin = match a.origin {
        Origin::Chat => "chat",
        Origin::Llm => "llm",
        Origin::Authored => "authored",
    };
    let mut entries = vec![("origin", s(origin))];
    if let Some(audit) = &a.audit_origin {
        entries.push(("auditOrigin", s(audit)));
    }
    if let Some(identity) = &a.identity {
        entries.push(("identity", typed(identity)));
    }
    object(entries)
}

/// `typed(snapshotTimerContext(ctx))`.
pub fn typed_snapshot(snap: &TimerSnapshot) -> Json {
    let texts = |items: &[String]| array(items.iter().map(|t| s(t)).collect());
    let pair_list = |items: &[(String, String)]| {
        array(items.iter().map(|(k, v)| array(vec![s(k), s(v)])).collect())
    };
    object(vec![
        ("broadcasterId", s(&snap.broadcaster_id)),
        ("userId", s(&snap.user_id)),
        ("userLogin", s(&snap.user_login)),
        ("userDisplayName", s(&snap.user_display_name)),
        ("userPlan", s(snap.user_plan.as_str())),
        ("userLevel", number(snap.user_level)),
        (
            "enforceFunctionPermissions",
            json!({"type": "boolean", "value": snap.enforce_function_permissions}),
        ),
        (
            "authorization",
            typed_authorization(snap.authorization.as_ref()),
        ),
        ("argument", opt(snap.argument.as_deref())),
        ("count", number(snap.count)),
        ("eventData", typed(&snap.event_data)),
        ("eventsubData", typed(&snap.eventsub_data)),
        ("extraContext", typed(&snap.extra_context)),
        ("platform", s(&snap.platform)),
        ("scopeType", s(&snap.scope_type)),
        ("scopeName", s(&snap.scope_name)),
        ("scopeAliases", texts(&snap.scope_aliases)),
        ("commandName", s(&snap.command_name)),
        ("commandId", s(&snap.command_id)),
        (
            "commandRefBudget",
            object(vec![(
                "remaining",
                number(snap.command_ref_budget.remaining as f64),
            )]),
        ),
        (
            "commandRefDepth",
            snap.command_ref_depth
                .map_or_else(undefined, |d| number(f64::from(d))),
        ),
        ("visitedCommands", texts(&snap.visited_commands)),
        ("commandResponses", texts(&snap.command_responses)),
        ("variables", pair_list(&snap.variables)),
        (
            "arrays",
            array(
                snap.arrays
                    .iter()
                    .map(|(k, v)| array(vec![s(k), texts(v)]))
                    .collect(),
            ),
        ),
        ("loopVars", pair_list(&snap.loop_vars)),
        ("timerDepth", number(f64::from(snap.timer_depth))),
    ])
}

fn typed_identity(identity: &UserIdentity) -> Json {
    let mut entries = vec![
        ("level", number(identity.level())),
        (
            "tags",
            array(identity.tags().iter().map(|t| s(t.as_str())).collect()),
        ),
    ];
    if let Some(id) = identity.user_id() {
        entries.push(("userId", s(id)));
    }
    if let Some(login) = identity.login() {
        entries.push(("login", s(login)));
    }
    object(entries)
}

fn typed_reference(reference: &CommandReference) -> Json {
    let origin = match reference.authorization.origin {
        dima_engine::context::ReferenceOrigin::Authored => "authored",
        dima_engine::context::ReferenceOrigin::Llm => "llm",
    };
    let effect = if reference.effect.is_some() {
        object(vec![("authority", s("isolated-source-synthetic"))])
    } else {
        undefined()
    };
    object(vec![
        ("effectContext", effect),
        ("channelID", s(&reference.channel_id)),
        ("commandName", s(&reference.command_name)),
        ("argument", s(&reference.argument)),
        ("eventData", typed(&reference.event_data)),
        (
            "authorization",
            object(vec![
                ("origin", s(origin)),
                (
                    "identity",
                    typed_identity(&reference.authorization.identity),
                ),
            ]),
        ),
        (
            "state",
            object(vec![
                (
                    "visitedCommands",
                    array(
                        reference
                            .state
                            .visited_commands
                            .iter()
                            .map(|v| s(v))
                            .collect(),
                    ),
                ),
                (
                    "commandRefDepth",
                    number(f64::from(reference.state.command_ref_depth)),
                ),
                (
                    "commandRefBudget",
                    object(vec![(
                        "remaining",
                        number(reference.state.budget.remaining() as f64),
                    )]),
                ),
                (
                    "timerDepth",
                    reference
                        .state
                        .timer_depth
                        .map_or_else(undefined, |d| number(f64::from(d))),
                ),
            ]),
        ),
    ])
}

fn loop_exit(exit: Option<LoopExit>) -> Json {
    exit.map_or_else(undefined, |e| s(e.as_str()))
}

/// What a Rust run produced, in the generator's shape (only the parts that can be compared:
/// see [`comparable`]).
pub struct Outcome {
    pub result: Result<Option<Value>, String>,
    pub parse_error: Option<String>,
    pub state: State,
}

pub fn observe(outcome: &Outcome, initial: &State, context: &Context, host: &CorpusHost) -> Json {
    let state = &outcome.state;
    let mut deltas = Vec::new();
    if number(state.count) != number(initial.count) {
        deltas.push(json!(["count", number(state.count)]));
    }
    if state.count_modified != initial.count_modified {
        deltas.push(json!(["countModified", {"type": "boolean", "value": state.count_modified}]));
    }
    if state.loop_exit != initial.loop_exit {
        deltas.push(json!(["loopExit", loop_exit(state.loop_exit)]));
    }
    if state.loop_depth != initial.loop_depth {
        deltas.push(json!(["loopDepth", number(f64::from(state.loop_depth))]));
    }
    let text_pairs =
        |map: &OrderedMap<String, String>| typed_pairs(map.iter().map(|(k, v)| (k, s(v))));
    let maps = json!({
        "variables": text_pairs(&state.variables),
        "arrays": typed_pairs(state.arrays.iter().map(|(k, v)| (k, array(v.iter().map(|t| s(t)).collect())))),
        "loopVars": text_pairs(&state.loop_vars),
        "commandVariables": text_pairs(&state.command_variables),
        "userCommandVariables": text_pairs(&state.user_command_variables),
    });
    let shared: Vec<Json> = state
        .command_references
        .iter()
        .map(|r| json!(r.state.budget.same(&context.budget)))
        .collect();
    let context_view = json!({
        "scalarDeltas": deltas,
        "maps": maps,
        "commandResponses": array(state.command_responses.iter().map(|r| s(r)).collect()),
        "commandReferences": array(state.command_references.iter().map(typed_reference).collect()),
        "budget": object(vec![("remaining", number(context.budget.remaining() as f64))]),
        "visitedCommands": array(context.visited_commands.iter().map(|v| s(v)).collect()),
        "identity": {"sameBudget": true, "sameVariables": true, "referenceBudgetsShared": shared},
    });
    let value_map =
        |map: &OrderedMap<String, Value>| typed_pairs(map.iter().map(|(k, v)| (k, typed(v))));
    let timers: Vec<Json> = host
        .timers
        .iter()
        .map(|t| {
            let root = AstNode::Root {
                children: t.body.clone(),
            };
            json!({
                "seconds": number(t.seconds),
                "body": typed_json(&root.to_value()),
                "snapshot": typed_snapshot(&t.snapshot),
                "after": {
                    "snapshotBudget": number(t.snapshot.command_ref_budget.remaining as f64),
                    "callerBudget": number(context.budget.remaining() as f64),
                    "snapshotVariables": array(t.snapshot.variables.iter().map(|(k, v)| array(vec![s(k), s(v)])).collect()),
                    "snapshotResponses": array(t.snapshot.command_responses.iter().map(|r| s(r)).collect()),
                }
            })
        })
        .collect();
    let mut out = json!({
        "context": context_view,
        "host": {
            "events": host.log.events(),
            "cache": value_map(&host.cache),
            "db": value_map(&host.db),
            "dbUser": value_map(&host.db_user),
            "timers": timers,
        }
    });
    match (&outcome.parse_error, &outcome.result) {
        (Some(error), _) => {
            out["outcome"] = json!("parse-error");
            out["error"] = json!(error);
        }
        (None, Ok(value)) => {
            out["outcome"] = json!("returned");
            out["value"] = value.as_ref().map_or_else(undefined, typed);
        }
        (None, Err(message)) => {
            out["outcome"] = json!("thrown");
            out["error"] = json!({"message": message});
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Running a case.

pub fn engine_for(registry: Registry) -> Engine {
    Engine::new(Arc::new(registry), dima_engine::syntax::Limits::default())
        .with_limits(EvalLimits::default())
}

pub fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
}

/// Runs a case. `Err` when its input cannot exist in Rust.
pub fn run_case(rt: &tokio::runtime::Runtime, case: &Json) -> Result<Json, Unrepresentable> {
    let input = &case["input"];
    let json_text = serde_json::to_string(input).unwrap();
    if json_text.contains("\"utf16\"") || json_text.contains("\"$utf16\"") {
        return Err(Unrepresentable::LoneSurrogate);
    }
    if json_text.contains("\"fixture.write\"") {
        return Err(Unrepresentable::HostWritesVariables);
    }
    let CaseInput {
        context,
        state,
        mut host,
        registry,
    } = case_input(input)?;
    let engine = engine_for(registry);
    let initial = state.clone();
    let operation = input["operation"].as_str().unwrap_or("evaluate");
    let outcome = rt.block_on(async {
        let mut parse_error = None;
        let result: Result<(Option<Value>, State), EvalError> = match operation {
            "evaluate" => {
                let ast: AstNode = serde_json::from_value(input["ast"].clone())
                    .map_err(|_| Unrepresentable::UnknownTag)?;
                engine
                    .evaluate(&ast, &context, state, &mut host)
                    .await
                    .map(|done| (Some(done.value), done.state))
            }
            "parseEvaluate" => match engine.parse(input["text"].as_str().unwrap()) {
                Err(error) => {
                    parse_error = Some(error.message);
                    Ok((None, state))
                }
                Ok(program) => engine
                    .evaluate_program(&program, &context, state, &mut host)
                    .await
                    .map(|done| (Some(done.value), done.state)),
            },
            "render" | "preparedRender" => {
                let template = engine.compile(input["text"].as_str().unwrap()).unwrap();
                engine
                    .render(&template, &context, state, &mut host)
                    .await
                    .map(|done| (Some(Value::Text(done.text)), done.state))
            }
            "timer" => {
                let ast: AstNode = serde_json::from_value(input["ast"].clone()).unwrap();
                let AstNode::Function { args, .. } = ast else {
                    panic!("timer case without a function node")
                };
                engine
                    .evaluate_timer(&args, &context, state, &mut host)
                    .await
                    .map(|done| (Some(done.value), done.state))
            }
            "snapshot" => {
                let snapshot = engine.snapshot(&context, &state);
                return Ok::<_, Unrepresentable>((
                    Outcome {
                        result: Ok(Some(Value::Undefined)),
                        parse_error: None,
                        state,
                    },
                    Some(typed_snapshot(&snapshot)),
                ));
            }
            other => panic!("unknown operation {other}"),
        };
        Ok((
            match result {
                Ok((value, state)) => Outcome {
                    result: Ok(value),
                    parse_error,
                    state,
                },
                Err(error) => Outcome {
                    result: Err(error.to_string()),
                    parse_error,
                    state: initial.clone(),
                },
            },
            None,
        ))
    })?;
    let (outcome, snapshot_value) = outcome;
    let mut observed = observe(&outcome, &initial, &context, &host);
    if let Some(snapshot) = snapshot_value {
        observed["value"] = snapshot;
    }
    Ok(observed)
}

// ---------------------------------------------------------------------------------------------
// The recorded expectation and the intended differences.

/// Each intended difference, applied in one place ([`expected`]) and counted per case.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Difference {
    /// The input has characters outside the BMP: the expectation is the TypeScript result for
    /// the BMP twin input with the replacements undone (lengths, cuts, `capitalize` and the
    /// per-character spread count characters, not UTF-16 units).
    CharacterCount,
    /// `<`, `>`, `<=`, `>=` on text whose UTF-16 order differs from its code-point order: Rust
    /// orders by code point.
    CodePointOrder,
    /// A stored list with a lone surrogate escape (`"\ud800"`) is read with U+FFFD in its place
    /// (text rule 3): a value taken from the parsed list, or the list written back, has U+FFFD.
    LoneSurrogateEscape,
    /// A timer's snapshot is a copy at scheduling (the reference shares the responses array with
    /// the live context until the scheduler serialises it, immediately in production).
    SnapshotCopy,
    /// An object whose own `toString` key is not a function makes JavaScript's `String()` throw;
    /// a Rust object is data and prints `[object Object]`. The generator records the twin with
    /// the key renamed.
    OwnToStringKey,
}

/// Replaces every occurrence of the twins' BMP characters (values and keys) by the originals.
fn untwin(value: &Json, map: &[(String, String)]) -> Json {
    let swap = |text: &str| -> String {
        let mut out = text.to_owned();
        for (original, twin) in map {
            out = out.replace(twin.as_str(), original);
        }
        out
    };
    match value {
        Json::String(text) => Json::String(swap(text)),
        Json::Array(items) => Json::Array(items.iter().map(|v| untwin(v, map)).collect()),
        Json::Object(entries) => Json::Object(
            entries
                .iter()
                .map(|(k, v)| (swap(k), untwin(v, map)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn lone_escape(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut at = 0;
    while let Some(offset) = text.get(at..).and_then(|rest| rest.find("\\u")) {
        let start = at + offset;
        let unit = text
            .get(start + 2..start + 6)
            .and_then(|hex| u16::from_str_radix(hex, 16).ok());
        if let Some(unit) = unit {
            let next = text
                .get(start + 6..start + 12)
                .filter(|s| s.starts_with("\\u"))
                .and_then(|s| u16::from_str_radix(s.get(2..).unwrap_or(""), 16).ok());
            let high = (0xD800..0xDC00).contains(&unit);
            let low = (0xDC00..0xE000).contains(&unit);
            if (high && !next.is_some_and(|n| (0xDC00..0xE000).contains(&n))) || low {
                return true;
            }
            at = start + if high { 12 } else { 6 };
        } else {
            at = start + 2;
        }
        if at >= bytes.len() {
            break;
        }
    }
    false
}

/// A typed string value with the reference's lone surrogates as U+FFFD.
fn lossy(value: &Json) -> Json {
    match value {
        Json::Object(map)
            if map.get("type") == Some(&json!("string")) && map.contains_key("utf16") =>
        {
            let units: Vec<u16> = map["utf16"]
                .as_array()
                .unwrap()
                .iter()
                .map(|u| u.as_u64().unwrap() as u16)
                .collect();
            s(&String::from_utf16_lossy(&units))
        }
        Json::Object(map) if map.get("type") == Some(&json!("string")) => {
            let text = map["value"].as_str().unwrap_or_default();
            // A list re-serialised by JSON.stringify escapes the lone surrogate.
            let mut out = String::new();
            let mut rest = text;
            while let Some(at) = rest.find("\\u") {
                out.push_str(rest.get(..at).unwrap());
                let hex = rest
                    .get(at + 2..at + 6)
                    .and_then(|h| u16::from_str_radix(h, 16).ok());
                match hex {
                    Some(unit) if (0xD800..0xE000).contains(&unit) => {
                        out.push('\u{fffd}');
                        rest = rest.get(at + 6..).unwrap();
                    }
                    _ => {
                        out.push_str("\\u");
                        rest = rest.get(at + 2..).unwrap();
                    }
                }
            }
            out.push_str(rest);
            s(&out)
        }
        Json::Object(map) => Json::Object(map.iter().map(|(k, v)| (k.clone(), lossy(v))).collect()),
        Json::Array(items) => Json::Array(items.iter().map(lossy).collect()),
        other => other.clone(),
    }
}

fn ordering_case(input: &Json) -> Option<(String, String, String)> {
    let ast = &input["ast"];
    let op = ast["operator"].as_str()?;
    if ast["type"] != "binary" || !matches!(op, "<" | ">" | "<=" | ">=") {
        return None;
    }
    let left = ast["left"]["value"].as_str()?;
    let right = ast["right"]["value"].as_str()?;
    Some((op.to_owned(), left.to_owned(), right.to_owned()))
}

fn plain_decimal(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    let mut parts = digits.splitn(2, '.');
    let whole = parts.next().unwrap_or("");
    let ok = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit());
    ok(whole) && parts.next().is_none_or(ok)
}

/// The recorded TypeScript observation with every intended difference applied, and which ones
/// changed it.
pub fn expected(case: &Json) -> (Json, Vec<Difference>) {
    let mut differences = Vec::new();
    let input = &case["input"];
    let mut source = case["source"].clone();
    if let Some(twin) = case.get("twin") {
        let map: Vec<(String, String)> = twin["map"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pair| {
                (
                    pair[0].as_str().unwrap().to_owned(),
                    pair[1].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        let twinned = untwin(&twin["source"], &map);
        let to_string_twin = map.iter().any(|(original, _)| original == "toString");
        if comparable(&twinned) != comparable(&source) {
            differences.push(if to_string_twin {
                Difference::OwnToStringKey
            } else {
                Difference::CharacterCount
            });
        }
        source = twinned;
    }
    if let Some((op, left, right)) = ordering_case(input) {
        let (l, r) = (dima_text::trim(&left), dima_text::trim(&right));
        if !(plain_decimal(l) && plain_decimal(r)) && dima_text::cmp_utf16(l, r) != l.cmp(r) {
            let result = match op.as_str() {
                "<" => l < r,
                ">" => l > r,
                "<=" => l <= r,
                _ => l >= r,
            };
            source["value"] = s(if result { "true" } else { "false" });
            differences.push(Difference::CodePointOrder);
        }
    }
    let input_text = serde_json::to_string(input).unwrap();
    if lone_escape(&input_text.replace("\\\\", "\\")) {
        let reads_list = input_text.contains("\"accessor\"") || input_text.contains("forLoop");
        if reads_list {
            // What the run computed from the parsed list: its value and what it wrote in memory.
            let value = lossy(&source["value"]);
            // Entries the run computed; stored text that is only carried (the input's variables,
            // a read memo of a stored value) stays as it was.
            let mut raw: Vec<Json> = Vec::new();
            for side in [&input["context"], &input["host"]] {
                for (_, pairs) in side.as_object().into_iter().flatten() {
                    for pair in pairs.as_array().into_iter().flatten() {
                        raw.push(pair[1].clone());
                    }
                }
            }
            let mut maps = source["context"]["maps"].clone();
            for entries in maps
                .as_object_mut()
                .into_iter()
                .flat_map(|m| m.values_mut())
            {
                for entry in entries.as_array_mut().into_iter().flatten() {
                    if !raw.contains(&entry[1]["value"]) {
                        entry[1] = lossy(&entry[1]);
                    }
                }
            }
            if value != source["value"] || maps != source["context"]["maps"] {
                source["value"] = value;
                source["context"]["maps"] = maps;
                differences.push(Difference::LoneSurrogateEscape);
            }
        }
    }
    // The responses each timer's snapshot held when it was scheduled: the last `responses.save`
    // before its `timer.schedule` event, else the run's initial responses.
    let mut at_schedule: Vec<Json> = Vec::new();
    let mut responses = typed(&Value::List(
        input["context"]["commandResponses"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|r| Value::text(r.as_str().unwrap_or("")))
                    .collect()
            })
            .unwrap_or_default(),
    ));
    for event in source["host"]["events"]
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        let parts = event["value"].as_array().cloned().unwrap_or_default();
        match parts.first().and_then(|p| p["value"].as_str()) {
            Some("responses.save") => responses = parts[1].clone(),
            Some("timer.schedule") => at_schedule.push(responses.clone()),
            _ => {}
        }
    }
    let set_responses = |snapshot: &mut Json, responses: &Json| {
        if let Some(fields) = snapshot["value"].as_array_mut() {
            for pair in fields.iter_mut().filter(|p| p[0] == "commandResponses") {
                pair[1] = responses.clone();
            }
        }
    };
    let mut copied = false;
    let mut nth = 0;
    if let Some(events) = source["host"]["events"].as_array_mut() {
        for event in events.iter_mut() {
            let is_timer = event["value"][0]["value"] == "timer.schedule";
            if is_timer && let Some(responses) = at_schedule.get(nth) {
                let before = event["value"][3].clone();
                set_responses(&mut event["value"][3], responses);
                copied |= before != event["value"][3];
                nth += 1;
            }
        }
    }
    if let Some(timers) = source["host"]["timers"].as_array_mut() {
        for (index, timer) in timers.iter_mut().enumerate() {
            let fields = timer["value"].as_array().cloned().unwrap_or_default();
            let get = |name: &str| {
                fields
                    .iter()
                    .find(|pair| pair[0] == name)
                    .map(|pair| pair[1].clone())
                    .unwrap_or(Json::Null)
            };
            let mut snapshot = get("snapshot");
            let after = get("after");
            let find_after = |name: &str| {
                after["value"]
                    .as_array()
                    .and_then(|fs| fs.iter().find(|p| p[0] == name))
                    .map(|p| p[1].clone())
                    .unwrap_or(Json::Null)
            };
            let responses = at_schedule.get(index).cloned().unwrap_or(Json::Null);
            set_responses(&mut snapshot, &responses);
            copied |= find_after("snapshotResponses") != responses;
            *timer = json!({
                "seconds": get("seconds"),
                "body": get("body"),
                "snapshot": snapshot,
                "after": {
                    "snapshotBudget": find_after("snapshotBudget"),
                    "callerBudget": find_after("callerBudget"),
                    "snapshotVariables": find_after("snapshotVariables"),
                    "snapshotResponses": responses,
                }
            });
        }
    }
    if copied {
        differences.push(Difference::SnapshotCopy);
    }
    differences.dedup();
    (source, differences)
}

/// The comparable part of an observation. Left out, because they describe JavaScript rather
/// than the language: `initialContext` (the caller's original object, which no caller reads),
/// object identity flags other than the shared budget, the error's class name, `cache.client`
/// (acquiring the Dragonfly client), the `handler` events of fixture functions the Rust run
/// implements as builtins (`fixture.count` is `scount`; the reference's own builtins emit none),
/// and the sharing flags of a timer capture.
pub fn comparable(observation: &Json) -> Json {
    let mut out = json!({
        "outcome": observation["outcome"],
        "context": observation["context"],
        "host": observation["host"],
    });
    if let Some(value) = observation.get("value") {
        out["value"] = value.clone();
    }
    match observation["outcome"].as_str() {
        Some("thrown") => {
            // After a throw the reference's context object holds whatever ran before; the Rust
            // evaluation returns only the error (callers discard the context either way).
            out["error"] = json!({"message": observation["error"]["message"]});
            out.as_object_mut().unwrap().remove("context");
        }
        Some("parse-error") => out["error"] = observation["error"].clone(),
        _ => {}
    }
    if let Some(identity) = out.get_mut("context").and_then(|c| c.get_mut("identity")) {
        *identity = json!({
            "sameBudget": identity["sameBudget"],
            "sameVariables": identity["sameVariables"],
            "referenceBudgetsShared": identity["referenceBudgetsShared"],
        });
    }
    if out.get("context").is_some() {
        let deltas: Vec<Json> = out["context"]["scalarDeltas"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|d| {
                matches!(
                    d[0].as_str(),
                    Some("count" | "countModified" | "loopExit" | "loopDepth")
                )
            })
            .collect();
        out["context"]["scalarDeltas"] = json!(deltas);
    }
    let events: Vec<Json> = out["host"]["events"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|event| {
            let parts = event["value"].as_array().cloned().unwrap_or_default();
            let name = parts
                .first()
                .and_then(|p| p["value"].as_str())
                .unwrap_or("");
            let handler = parts.get(1).and_then(|p| p["value"].as_str()).unwrap_or("");
            !(name == "cache.client"
                || (name == "handler" && matches!(handler, "fixture.count" | "break" | "continue")))
        })
        .map(|event| {
            // timer.schedule carries the generator's identity flags as a fifth item.
            let mut parts = event["value"].as_array().cloned().unwrap_or_default();
            if parts.first().and_then(|p| p["value"].as_str()) == Some("timer.schedule") {
                parts.truncate(4);
            }
            json!({"type": "array", "value": parts})
        })
        .collect();
    out["host"]["events"] = json!(events);
    normalize_numbers(&out)
}

/// Numbers compare by value (`7` and `7.0` are the same JavaScript number).
fn normalize_numbers(value: &Json) -> Json {
    match value {
        Json::Number(n) => {
            let f = n.as_f64().unwrap();
            if f.fract() == 0.0 && f.abs() < 9.0e15 {
                json!(f as i64)
            } else {
                json!(f)
            }
        }
        Json::Array(items) => Json::Array(items.iter().map(normalize_numbers).collect()),
        Json::Object(map) => Json::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), normalize_numbers(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Totals of a corpus run.
#[derive(Default, Debug)]
pub struct Tally {
    pub exact: usize,
    pub differences: BTreeMap<Difference, usize>,
    pub unrepresentable: BTreeMap<Unrepresentable, usize>,
    pub failures: Vec<String>,
}

pub fn run_corpus(name: &str) -> Tally {
    let corpus = load(name);
    let rt = runtime();
    let mut tally = Tally::default();
    for case in corpus["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap().to_owned();
        match run_case(&rt, case) {
            Err(why) => *tally.unrepresentable.entry(why).or_default() += 1,
            Ok(observed) => {
                let (want, differences) = expected(case);
                let want = comparable(&want);
                let got = comparable(&observed);
                if got == want {
                    if differences.is_empty() {
                        tally.exact += 1;
                    }
                    for difference in differences {
                        *tally.differences.entry(difference).or_default() += 1;
                    }
                } else if tally.failures.len() < 400 {
                    tally.failures.push(format!(
                        "{id}\n  want {}\n  got  {}",
                        serde_json::to_string(&want).unwrap(),
                        serde_json::to_string(&got).unwrap()
                    ));
                } else {
                    tally.failures.push(id);
                }
            }
        }
    }
    tally
}

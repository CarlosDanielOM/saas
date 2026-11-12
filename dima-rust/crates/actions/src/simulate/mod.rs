//! The command editor's simulation: a test run where every function call but the pure ones is
//! answered by [`Host::simulate`] and nothing reaches a store, Twitch or chat. Package
//! P4-ACT-CORE.
//!
//! TypeScript it ports (baseline `0c71108e`): `utils/ast_parser/simulate.ts` (295 lines):
//! `SimulationInputError`, `parseSimulationInput` ([`parse_simulation_input`]),
//! `simulateCommand` ([`simulate_command`]), `findProblems` ([`find_problems`]).
//!
//! Callers: the site agent's `effects` and `knowledge` tools (P4-SA-TOOLS-A) and the docs
//! assistant's `test_command` tool (P4-SA-TOOLS-B), which show the answer to the dashboard's
//! editor and the AI. The answer's JSON ([`SimulationResult::to_json`]) is the reference's,
//! field for field, written with [`dima_text::to_js_json`].
//!
//! # No effects
//!
//! [`SimulationHost`] is a host of its own: it holds no store, no Twitch and no chat handle,
//! only the run's memory (channel and viewer variables, cache variables, the use count), so a
//! simulation cannot write anything outside it by construction. The tests run every stored
//! command through it with a recording host wrapper and check that no call reaches anything
//! but the in-memory state.
//!
//! # Intended differences
//!
//! - The user name is cut to 40 characters and the argument to 500 by Unicode scalar values,
//!   the body is limited to 10,000 of them (charter section 4, first row: our own limits on
//!   user text); the reference counts UTF-16 units (and could cut an emoji in half).
//! - A run's time limit (5 s) is measured on tokio's clock; the message deadline of the engine
//!   still applies inside it.

use dima_core::{Clock, Random};
use dima_engine::context::{Authorization, Context, Effect, Origin, Plan, State, TimerSnapshot};
use dima_engine::eval::Engine;
use dima_engine::host::{Host, HostCall, HostError, HostFuture};
use dima_engine::map::OrderedMap;
use dima_engine::syntax::AstNode;
use dima_engine::value::Value;
use serde_json::{Map, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

/// `PURE_FUNCTIONS`: functions that only read the command's own context; they run for real.
pub const PURE_FUNCTIONS: [&str; 16] = [
    "upper",
    "lower",
    "title",
    "capitalize",
    "trim",
    "length",
    "slice",
    "replace",
    "random",
    "user",
    "touser",
    "count",
    "scount",
    "bits",
    "break",
    "continue",
];

/// `READ_CATEGORIES`: categories whose functions read data.
const READ_CATEGORIES: [&str; 3] = ["twitch-data", "event-data", "ai"];

/// `READ_FUNCTIONS`: other functions that read data.
const READ_FUNCTIONS: [&str; 8] = [
    "get.poll",
    "get.prediction",
    "bot.mode",
    "tts.status",
    "tts.connected",
    "tts.queue.length",
    "roulette.result",
    "randomuser",
];

/// `SAMPLE_VALUES`: the block editor's "Try it" values, plus a few more.
const SAMPLE_VALUES: [(&str, &str); 34] = [
    ("followage", "2 years, 4 months"),
    ("twitch.modiversary", "1 year"),
    ("twitch.streak", "12"),
    ("twitch.live", "true"),
    ("twitch.subs", "128"),
    ("twitch.follows", "5400"),
    ("twitch.title", "Night coding"),
    ("twitch.game", "Just Chatting"),
    ("twitch.viewers", "42"),
    ("twitch.channel", "YourChannel"),
    ("twitch.login", "yourchannel"),
    ("raid.channel", "BigStreamer"),
    ("raid.login", "bigstreamer"),
    ("raid.viewers", "42"),
    ("cheer.amount", "100"),
    ("cheer.message", "Take my bits!"),
    ("sub.tier", "1"),
    ("sub.months", "6"),
    ("gifted.user", "LuckyViewer"),
    ("hypetrain.progress", "64"),
    ("hypetrain.level", "3"),
    ("hypetrain.end", "in 4 minutes"),
    ("shoutout.channel", "FriendlyStreamer"),
    ("reward.input", "play some lofi"),
    ("ad.time", "12 minutes"),
    ("bot.mode", "online"),
    ("get.poll", "Best map? · Nuke leads"),
    ("get.prediction", "Will we win? · 64% yes"),
    ("tts.status", "Speech overlay connected · idle · 0 waiting"),
    ("tts.connected", "true"),
    ("tts.queue.length", "0"),
    ("roulette.result", "Mystery prize"),
    ("ai", "(an AI-written reply would appear here)"),
    ("create.clip", "https://clips.twitch.tv/ExampleClip"),
];

/// `MAX_BODY`.
const MAX_BODY: usize = 10_000;
/// `MAX_RUNS`.
const MAX_RUNS: usize = 10;
/// `MAX_REPEAT`.
const MAX_REPEAT: u32 = 50;
/// `RUN_TIMEOUT_MS`.
const RUN_TIMEOUT_MS: u64 = 5_000;

const NOTE: &str = "Test run: pure functions ran for real; actions were recorded, not performed; Twitch/event/AI reads used sample values; target lookup outcomes are simulated and do not establish account existence; samples do not measure real requests; variables lived only for this test.";

/// `SimulationRole`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SimulationRole {
    /// Level 1.
    #[default]
    Viewer,
    /// Level 7.
    Mod,
    /// Level 10.
    Streamer,
}

impl SimulationRole {
    fn level(self) -> f64 {
        match self {
            Self::Viewer => 1.0,
            Self::Mod => 7.0,
            Self::Streamer => 10.0,
        }
    }
}

/// `SimulationRunInput`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SimulationRunInput {
    /// A different response body for this run.
    pub body: Option<String>,
    /// Display name of who types the command (default `Sam`).
    pub user: Option<String>,
    /// Text after the command name.
    pub argument: Option<String>,
    /// The role.
    pub role: Option<SimulationRole>,
    /// Model a target lookup as not found (`false`: found, the default).
    pub target_not_found: bool,
}

/// `SimulationInput`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SimulationInput {
    /// The response body only.
    pub body: String,
    /// Runs in order, sharing variables and the use count.
    pub runs: Option<Vec<SimulationRunInput>>,
    /// Repeat the whole sequence this many times (fresh state each time).
    pub repeat: u32,
    /// The plan.
    pub plan: Plan,
}

/// `SimulationInputError`: the message is shown to the user.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct SimulationInputError(pub String);

/// `SimulatedCall`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SimulatedCall {
    /// `function`.
    pub function: String,
    /// `args`, as text.
    pub args: Vec<String>,
}

/// One sample read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sample {
    /// The call.
    pub call: SimulatedCall,
    /// The sample value.
    pub value: String,
    /// `own_channel_sample`, `invalid_target`, `simulated_found` or `simulated_not_found`.
    pub lookup: Option<&'static str>,
}

/// `SimulationRunResult`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SimulationRunResult {
    /// `user`.
    pub user: String,
    /// `argument`.
    pub argument: String,
    /// `reply`: what the bot would post (empty: nothing).
    pub reply: String,
    /// `actions`, in order.
    pub actions: Vec<SimulatedCall>,
    /// `samples`.
    pub samples: Vec<Sample>,
    /// `commandReferences`: `#(name args)`.
    pub command_references: Vec<String>,
    /// `problems`.
    pub problems: Vec<String>,
}

/// One outcome of a repeated sequence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    /// `times`.
    pub times: u32,
    /// `replies`.
    pub replies: Vec<String>,
    /// `actions`, as `name(arg, arg)`.
    pub actions: Vec<String>,
}

/// `SimulationResult`.
#[derive(Clone, Debug, PartialEq)]
pub struct SimulationResult {
    /// `runs`.
    pub runs: Vec<SimulationRunResult>,
    /// `outcomes` (with `repeat > 1`).
    pub outcomes: Option<Vec<Outcome>>,
    /// `variables` after the first sequence, in the reference's order.
    pub variables: Vec<(String, String)>,
    /// `useCount`.
    pub use_count: f64,
    /// `note`.
    pub note: &'static str,
}

fn number(value: f64) -> serde_json::Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        json!(value as i64)
    } else {
        serde_json::Number::from_f64(value)
            .map_or(serde_json::Value::Null, serde_json::Value::Number)
    }
}

fn call_json(call: &SimulatedCall) -> Map<String, serde_json::Value> {
    let mut map = Map::new();
    map.insert("function".into(), json!(call.function));
    map.insert("args".into(), json!(call.args));
    map
}

impl SimulationRunResult {
    /// The reference's JSON object.
    pub fn to_json(&self) -> serde_json::Value {
        let samples: Vec<serde_json::Value> = self
            .samples
            .iter()
            .map(|sample| {
                let mut map = call_json(&sample.call);
                map.insert("value".into(), json!(sample.value));
                if let Some(lookup) = sample.lookup {
                    map.insert("lookup".into(), json!(lookup));
                }
                serde_json::Value::Object(map)
            })
            .collect();
        let actions: Vec<serde_json::Value> = self
            .actions
            .iter()
            .map(|call| serde_json::Value::Object(call_json(call)))
            .collect();
        json!({
            "user": self.user,
            "argument": self.argument,
            "reply": self.reply,
            "actions": actions,
            "samples": samples,
            "commandReferences": self.command_references,
            "problems": self.problems,
        })
    }
}

impl SimulationResult {
    /// The reference's JSON object (`{runs, variables, useCount, note, outcomes?}`); write it
    /// with [`dima_text::to_js_json`].
    pub fn to_json(&self) -> serde_json::Value {
        let mut variables = Map::new();
        for (key, value) in &self.variables {
            variables.insert(key.clone(), json!(value));
        }
        let mut map = Map::new();
        map.insert(
            "runs".into(),
            serde_json::Value::Array(self.runs.iter().map(SimulationRunResult::to_json).collect()),
        );
        map.insert("variables".into(), serde_json::Value::Object(variables));
        map.insert("useCount".into(), number(self.use_count));
        map.insert("note".into(), json!(self.note));
        if let Some(outcomes) = &self.outcomes {
            map.insert(
                "outcomes".into(),
                serde_json::Value::Array(
                    outcomes
                        .iter()
                        .map(|outcome| {
                            json!({
                                "times": outcome.times,
                                "replies": outcome.replies,
                                "actions": outcome.actions,
                            })
                        })
                        .collect(),
                ),
            );
        }
        serde_json::Value::Object(map)
    }
}

/// `normalizeLogin` of the simulation: trimmed, leading `@`s removed, lowercase, no whitespace.
fn normalize_login(value: &str) -> String {
    dima_text::to_lower(dima_text::trim(value).trim_start_matches('@'))
        .chars()
        .filter(|ch| !dima_text::is_js_whitespace(*ch))
        .collect()
}

/// `normalizeTarget` (`functions/shoutout_target.ts`): a Twitch login or `''`.
fn normalize_target(value: &str) -> String {
    let trimmed = dima_text::trim(value);
    let login = dima_text::to_lower(trimmed.strip_prefix('@').unwrap_or(trimmed));
    let valid = (1..=25).contains(&login.len())
        && login
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_');
    if valid { login } else { String::new() }
}

fn is_js_space(ch: char) -> bool {
    dima_text::is_js_whitespace(ch)
}

/// `findProblems(reply)`: problems the engine reports inline, and code that printed as text.
pub fn find_problems(reply: &str) -> Vec<String> {
    let mut problems = Vec::new();
    // `/\[(?:Parse error|Parser error|Unknown function)[^\]]*\]/g`
    let mut rest = reply;
    while let Some(at) = rest.find('[') {
        let after = rest.get(at + 1..).unwrap_or_default();
        let named = ["Parse error", "Parser error", "Unknown function"]
            .iter()
            .any(|prefix| after.starts_with(prefix));
        if named && let Some(close) = after.find(']') {
            problems.push(
                rest.get(at..at + 1 + close + 1)
                    .unwrap_or_default()
                    .to_owned(),
            );
            rest = after.get(close + 1..).unwrap_or_default();
        } else {
            rest = after;
        }
    }
    // `/^Error: |\sError: /`, then the first `/Error: [^\n]*/`.
    let starts = reply.starts_with("Error: ");
    let spaced = reply.char_indices().any(|(at, ch)| {
        is_js_space(ch)
            && reply
                .get(at + ch.len_utf8()..)
                .is_some_and(|tail| tail.starts_with("Error: "))
    });
    if (starts || spaced)
        && let Some(at) = reply.find("Error: ")
    {
        let tail = reply.get(at..).unwrap_or_default();
        let line = tail.split('\n').next().unwrap_or_default();
        problems.push(format!("A function returned an error: {line}"));
    }
    // The text outside `[…]`.
    let mut leftover = String::new();
    let mut rest = reply;
    while let Some(at) = rest.find('[') {
        let after = rest.get(at + 1..).unwrap_or_default();
        match after.find(']') {
            Some(close) => {
                leftover.push_str(rest.get(..at).unwrap_or_default());
                rest = after.get(close + 1..).unwrap_or_default();
            }
            None => break,
        }
    }
    leftover.push_str(rest);
    let operator_alone = operator_token(&leftover);
    let compares = leftover.contains("==") || leftover.contains("!=");
    let call_text = leftover
        .as_bytes()
        .windows(2)
        .any(|pair| matches!(pair[0], b'$' | b'%' | b'*' | b'^' | b'#') && pair[1] == b'(');
    if operator_alone && compares || call_text {
        problems.push("Part of the command printed as text instead of running (often an unquoted &p1/&t that was empty or had spaces, or an unbalanced parenthesis).".to_owned());
    }
    problems
}

/// `/(^|\s)(==|!=|\?|:)(\s|$)/`.
fn operator_token(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    for (at, _) in chars.iter().enumerate() {
        let before_ok = at == 0 || chars.get(at - 1).copied().is_some_and(is_js_space);
        if !before_ok {
            continue;
        }
        for operator in [&['=', '='][..], &['!', '='], &['?'], &[':']] {
            let end = at + operator.len();
            if chars.get(at..end) == Some(operator)
                && (end == chars.len() || chars.get(end).copied().is_some_and(is_js_space))
            {
                return true;
            }
        }
    }
    false
}

/// `MemoryCache`: cache variables of one test sequence, in insertion order.
#[derive(Default)]
struct MemoryCache {
    values: Vec<(String, String)>,
}

impl MemoryCache {
    fn get(&self, key: &str) -> Option<&String> {
        self.values.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    fn set(&mut self, key: &str, value: &str) {
        match self.values.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value.to_owned(),
            None => self.values.push((key.to_owned(), value.to_owned())),
        }
    }

    fn delete(&mut self, key: &str) {
        self.values.retain(|(k, _)| k != key);
    }
}

/// A `Map` in insertion order (set keeps position, delete forgets).
#[derive(Default)]
struct Memory {
    values: Vec<(String, String)>,
}

impl Memory {
    fn get(&self, key: &str) -> Option<&String> {
        self.values.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    fn set(&mut self, key: String, value: &str) {
        match self.values.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value.to_owned(),
            None => self.values.push((key, value.to_owned())),
        }
    }

    fn delete(&mut self, key: &str) {
        self.values.retain(|(k, _)| k != key);
    }
}

/// The state a sequence of runs shares.
#[derive(Default)]
struct SequenceState {
    count: f64,
    channel: Memory,
    users: Memory,
    cache: MemoryCache,
}

/// The host of a test run: in-memory variables, every non-pure function recorded and answered
/// with an empty value (actions) or a sample (reads). It has no handle to anything else.
pub struct SimulationHost<'s> {
    state: &'s mut SequenceState,
    login: String,
    target_not_found: bool,
    categories: Arc<HashMap<String, String>>,
    clock: crate::host::DeadlineClock,
    random: Arc<dyn Random>,
    actions: Vec<SimulatedCall>,
    samples: Vec<Sample>,
}

impl SimulationHost<'_> {
    fn user_key(&self, name: &str, target: Option<&str>) -> String {
        let who = target
            .filter(|target| !target.is_empty())
            .unwrap_or(&self.login);
        format!("{}:{name}", normalize_login(who))
    }

    fn answer(&mut self, name: &str, args: &[Value]) -> Result<Option<Value>, HostError> {
        if PURE_FUNCTIONS.contains(&name) {
            return Ok(None);
        }
        let args: Vec<String> = args
            .iter()
            .map(|arg| {
                arg.to_text_or_empty()
                    .map(|text| text.into_owned())
                    .map_err(|error| HostError::new(error.to_string()))
            })
            .collect::<Result<_, _>>()?;
        let call = SimulatedCall {
            function: name.to_owned(),
            args,
        };
        let category = self.categories.get(name).map(String::as_str).unwrap_or("");
        let read = READ_FUNCTIONS.contains(&name) || READ_CATEGORIES.contains(&category);
        if !read {
            self.actions.push(call);
            return Ok(Some(Value::empty()));
        }
        let mut value = if name == "randomuser" {
            "ClipGoblin".to_owned()
        } else {
            SAMPLE_VALUES
                .iter()
                .find(|(key, _)| *key == name)
                .map_or_else(|| format!("({name})"), |(_, value)| (*value).to_owned())
        };
        let mut lookup = None;
        if ["twitch.channel", "twitch.login", "twitch.game"].contains(&name) {
            match call.args.first() {
                None => lookup = Some("own_channel_sample"),
                Some(first) => {
                    let target = normalize_target(first);
                    if target.is_empty() {
                        value = String::new();
                        lookup = Some("invalid_target");
                    } else if self.target_not_found {
                        value = String::new();
                        lookup = Some("simulated_not_found");
                    } else {
                        lookup = Some("simulated_found");
                        value = if name == "twitch.game" {
                            "Just Chatting".to_owned()
                        } else {
                            target
                        };
                    }
                }
            }
        }
        self.samples.push(Sample {
            call,
            value: value.clone(),
            lookup,
        });
        Ok(Some(Value::Text(value)))
    }
}

fn ready<'a, T: Send + 'a>(value: T) -> HostFuture<'a, T> {
    Box::pin(std::future::ready(value))
}

impl Host for SimulationHost<'_> {
    fn clock(&self) -> &dyn Clock {
        &self.clock
    }

    fn random(&self) -> &dyn Random {
        self.random.as_ref()
    }

    fn call<'a>(&'a mut self, call: HostCall<'a>) -> HostFuture<'a, Result<Value, HostError>> {
        // Every function of a test run is answered by `simulate` first; nothing reaches here.
        ready(Err(HostError::new(format!(
            "$({}) cannot run in a test run",
            call.name
        ))))
    }

    fn simulate<'a>(
        &'a mut self,
        name: &'a str,
        args: &'a [Value],
        _context: &'a Context,
    ) -> HostFuture<'a, Result<Option<Value>, HostError>> {
        ready(self.answer(name, args))
    }

    fn alarm(&self, millis: u64) -> HostFuture<'static, ()> {
        Box::pin(tokio::time::sleep(Duration::from_millis(millis)))
    }

    fn sleep(&mut self, millis: u64) -> HostFuture<'_, ()> {
        Box::pin(tokio::time::sleep(Duration::from_millis(millis)))
    }

    fn cache_get<'a>(
        &'a mut self,
        key: &'a str,
    ) -> HostFuture<'a, Result<Option<String>, HostError>> {
        ready(Ok(self.state.cache.get(key).cloned()))
    }

    fn cache_exists<'a>(&'a mut self, key: &'a str) -> HostFuture<'a, Result<bool, HostError>> {
        ready(Ok(self.state.cache.get(key).is_some()))
    }

    fn cache_set<'a>(
        &'a mut self,
        key: &'a str,
        value: &'a str,
    ) -> HostFuture<'a, Result<(), HostError>> {
        self.state.cache.set(key, value);
        ready(Ok(()))
    }

    fn cache_expire<'a>(
        &'a mut self,
        _key: &'a str,
        _seconds: u64,
    ) -> HostFuture<'a, Result<(), HostError>> {
        ready(Ok(()))
    }

    fn cache_delete<'a>(&'a mut self, key: &'a str) -> HostFuture<'a, Result<(), HostError>> {
        self.state.cache.delete(key);
        ready(Ok(()))
    }

    fn load_channel_variable<'a>(
        &'a mut self,
        name: &'a str,
    ) -> HostFuture<'a, Result<String, HostError>> {
        ready(Ok(self
            .state
            .channel
            .get(name)
            .cloned()
            .unwrap_or_default()))
    }

    fn save_channel_variable<'a>(
        &'a mut self,
        name: &'a str,
        value: &'a str,
    ) -> HostFuture<'a, Result<(), HostError>> {
        self.state.channel.set(name.to_owned(), value);
        ready(Ok(()))
    }

    fn delete_channel_variable<'a>(
        &'a mut self,
        name: &'a str,
    ) -> HostFuture<'a, Result<(), HostError>> {
        self.state.channel.delete(name);
        ready(Ok(()))
    }

    fn load_user_variable<'a>(
        &'a mut self,
        name: &'a str,
        target: Option<&'a str>,
    ) -> HostFuture<'a, Result<String, HostError>> {
        let key = self.user_key(name, target);
        ready(Ok(self.state.users.get(&key).cloned().unwrap_or_default()))
    }

    fn save_user_variable<'a>(
        &'a mut self,
        name: &'a str,
        value: &'a str,
        target: Option<&'a str>,
    ) -> HostFuture<'a, Result<(), HostError>> {
        let key = self.user_key(name, target);
        self.state.users.set(key, value);
        ready(Ok(()))
    }

    fn delete_user_variable<'a>(
        &'a mut self,
        name: &'a str,
        target: Option<&'a str>,
    ) -> HostFuture<'a, Result<(), HostError>> {
        let key = self.user_key(name, target);
        self.state.users.delete(&key);
        ready(Ok(()))
    }

    fn save_responses<'a>(
        &'a mut self,
        _responses: &'a [String],
    ) -> HostFuture<'a, Result<(), HostError>> {
        ready(Ok(()))
    }

    fn schedule_timer<'a>(
        &'a mut self,
        _seconds: f64,
        _body: &'a [AstNode],
        _snapshot: TimerSnapshot,
    ) -> HostFuture<'a, Result<(), HostError>> {
        // A test run never evaluates a timer (the engine asks `simulate("timer")` instead).
        ready(Err(HostError::new("timers do not run in a test run")))
    }

    fn fork_effect(&mut self, _effect: &Effect) -> Option<Effect> {
        None
    }
}

/// `parseSimulationInput(raw)`: the request's JSON, checked.
pub fn parse_simulation_input(
    raw: &serde_json::Value,
) -> Result<SimulationInput, SimulationInputError> {
    let empty = Map::new();
    let input = raw.as_object().unwrap_or(&empty);
    fn text_of(value: Option<&serde_json::Value>) -> Option<&str> {
        value.and_then(serde_json::Value::as_str)
    }
    let runs = input.get("runs").and_then(serde_json::Value::as_array);
    let first_run_body = runs
        .and_then(|runs| runs.first())
        .and_then(|run| text_of(run.get("body")))
        .unwrap_or("");
    let body = match text_of(input.get("body")) {
        Some(body) if !dima_text::trim(body).is_empty() => body,
        _ => first_run_body,
    };
    if dima_text::trim(body).is_empty() {
        return Err(SimulationInputError(
            "body is required: the response body to test".into(),
        ));
    }
    if body.chars().count() > MAX_BODY {
        return Err(SimulationInputError(format!(
            "body is longer than {MAX_BODY} characters"
        )));
    }
    if is_cc_line(body) {
        return Err(SimulationInputError(
            "Pass only the response body, not the whole !cc/!ec line.".into(),
        ));
    }
    let runs = match runs {
        Some(runs) => Some(
            runs.iter()
                .take(MAX_RUNS)
                .map(|run| {
                    let role = match text_of(run.get("role")) {
                        Some("mod") => SimulationRole::Mod,
                        Some("streamer") => SimulationRole::Streamer,
                        _ => SimulationRole::Viewer,
                    };
                    let run_body = text_of(run.get("body"))
                        .filter(|body| !dima_text::trim(body).is_empty())
                        .map(str::to_owned);
                    if let Some(body) = &run_body
                        && (body.chars().count() > MAX_BODY || is_cc_line(body))
                    {
                        return Err(SimulationInputError(
                            "Each run body must be a response body (no !cc/!ec line) under 10,000 characters.".into(),
                        ));
                    }
                    Ok(SimulationRunInput {
                        body: run_body,
                        user: text_of(run.get("user")).map(str::to_owned),
                        argument: Some(text_of(run.get("argument")).unwrap_or("").to_owned()),
                        role: Some(role),
                        target_not_found: text_of(run.get("targetLookup")) == Some("not_found"),
                    })
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
        None => None,
    };
    // `Math.trunc(Number(input.repeat) || 1)`.
    let repeat_number = input.get("repeat").map_or(f64::NAN, js_number_of);
    let repeat = if repeat_number.is_nan() || repeat_number == 0.0 {
        1.0
    } else {
        repeat_number.trunc()
    };
    let repeat = repeat.clamp(1.0, f64::from(MAX_REPEAT)) as u32;
    let plan = match text_of(input.get("plan")) {
        Some("free") => Plan::Free,
        Some("pro") => Plan::Pro,
        _ => Plan::Premium,
    };
    Ok(SimulationInput {
        body: body.to_owned(),
        runs,
        repeat,
        plan,
    })
}

/// `Number(value)` of a JSON value.
fn js_number_of(value: &serde_json::Value) -> f64 {
    match value {
        serde_json::Value::Null => 0.0,
        serde_json::Value::Bool(flag) => f64::from(u8::from(*flag)),
        serde_json::Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        serde_json::Value::Object(_) => f64::NAN,
        // A string, or a list through its text.
        other => dima_text::parse_number(&dima_text::string_of(other)),
    }
}

/// `/^\s*!(cc|ec)\s/i`.
fn is_cc_line(body: &str) -> bool {
    let rest = dima_text::trim_start(body);
    let Some(rest) = rest.strip_prefix('!') else {
        return false;
    };
    let lower = rest.get(..2).map(str::to_ascii_lowercase);
    matches!(lower.as_deref(), Some("cc" | "ec"))
        && rest
            .get(2..)
            .and_then(|tail| tail.chars().next())
            .is_some_and(is_js_space)
}

/// The function categories of the registry, for `categoryOf`.
fn categories(engine: &Engine) -> HashMap<String, String> {
    engine
        .registry()
        .iter()
        .map(|spec| {
            (
                spec.name.clone(),
                spec.metadata
                    .as_ref()
                    .map(|metadata| metadata.category.clone())
                    .unwrap_or_default(),
            )
        })
        .collect()
}

async fn run_once(
    engine: &Engine,
    input: &SimulationInput,
    run: &SimulationRunInput,
    state: &mut SequenceState,
    categories: &Arc<HashMap<String, String>>,
    wall: &dyn Clock,
    random: &Arc<dyn Random>,
) -> SimulationRunResult {
    // `(run.user || 'Sam').trim().slice(0, 40) || 'Sam'`.
    let user = run
        .user
        .as_deref()
        .filter(|user| !user.is_empty())
        .unwrap_or("Sam");
    let display: String = dima_text::trim(user).chars().take(40).collect();
    let display = if display.is_empty() {
        "Sam".to_owned()
    } else {
        display
    };
    let login = {
        let login = normalize_login(&display);
        if login.is_empty() {
            "sam".to_owned()
        } else {
            login
        }
    };
    let argument: String = run
        .argument
        .as_deref()
        .unwrap_or("")
        .chars()
        .take(500)
        .collect();
    let level = run.role.unwrap_or_default().level();
    let mut result = SimulationRunResult {
        user: display.clone(),
        argument: argument.clone(),
        ..SimulationRunResult::default()
    };
    let body = run.body.as_deref().unwrap_or(&input.body);
    let placeholders =
        match crate::delivery::placeholders::resolve(body, &argument, true, random.as_ref()) {
            Ok(resolved) => resolved,
            Err(error) => {
                result.problems.push(format!("The engine failed: {error}"));
                return result;
            }
        };
    if let Some(error) = placeholders.error {
        result.reply = format!("[Parser error: {error}]");
        result.problems = find_problems(&result.reply);
        return result;
    }
    let user_id = format!("test-{login}");
    let tags = if level >= 10.0 {
        vec![Value::text("broadcaster")]
    } else {
        Vec::new()
    };
    let text = |value: &str| Value::text(value);
    let context = Context {
        broadcaster_id: "test-channel".into(),
        user_id: user_id.clone(),
        user_login: login.clone(),
        user_display_name: display.clone(),
        user_plan: input.plan,
        user_level: level,
        enforce_function_permissions: false,
        authorization: Some(Authorization {
            origin: Origin::Authored,
            audit_origin: None,
            identity: Some(Value::object(vec![
                ("level".into(), Value::Number(level)),
                ("tags".into(), Value::List(tags)),
            ])),
        }),
        argument: Some(argument.clone()),
        event_data: Value::object(vec![
            ("chatter_user_id".into(), text(&user_id)),
            ("chatter_user_login".into(), text(&login)),
            ("chatter_user_name".into(), text(&display)),
            ("broadcaster_user_id".into(), text("test-channel")),
            ("broadcaster_user_login".into(), text("yourchannel")),
            ("broadcaster_user_name".into(), text("YourChannel")),
        ]),
        extra_context: Value::object(vec![
            ("userName".into(), text(&display)),
            ("userLogin".into(), text(&login)),
            ("userID".into(), text(&user_id)),
        ]),
        streamer: Value::object(vec![
            ("id".into(), text("test-channel")),
            ("name".into(), text("yourchannel")),
        ]),
        scope_type: "command".into(),
        scope_name: "test".into(),
        command_name: "test".into(),
        simulation: true,
        ..Context::default()
    };
    let variables: OrderedMap<String, String> = placeholders.variables.into_iter().collect();
    let run_state = State {
        count: state.count,
        variables,
        ..State::default()
    };
    let rendered = {
        let mut host = SimulationHost {
            state,
            login: login.clone(),
            target_not_found: run.target_not_found,
            categories: Arc::clone(categories),
            clock: crate::host::DeadlineClock::starting_at(wall),
            random: Arc::clone(random),
            actions: Vec::new(),
            samples: Vec::new(),
        };
        let outcome = match engine.compile(&placeholders.text) {
            Ok(template) => {
                tokio::time::timeout(
                    Duration::from_millis(RUN_TIMEOUT_MS),
                    engine.render_message(&template, &context, run_state, &mut host),
                )
                .await
            }
            Err(diagnostic) => Ok(Err(dima_engine::eval::EvalError::Host(HostError::new(
                diagnostic.message,
            )))),
        };
        result.actions = std::mem::take(&mut host.actions);
        result.samples = std::mem::take(&mut host.samples);
        outcome
    };
    let rendered = match rendered {
        Err(_) => {
            result.problems.push(format!(
                "The command took longer than {}s to run (check loops).",
                RUN_TIMEOUT_MS / 1000
            ));
            return result;
        }
        Ok(Err(error)) => {
            result.problems.push(format!("The engine failed: {error}"));
            return result;
        }
        Ok(Ok(rendered)) => rendered,
    };
    state.count = rendered.state.count;
    let unescaped = dima_engine::syntax::unescape_rendered_text(&rendered.text);
    let collapsed = collapse_whitespace(&unescaped);
    result.reply = dima_text::trim(&collapsed).to_owned();
    result.command_references = rendered
        .state
        .command_references
        .iter()
        .map(|reference| {
            if reference.argument.is_empty() {
                format!("#({})", reference.command_name)
            } else {
                format!("#({} {})", reference.command_name, reference.argument)
            }
        })
        .collect();
    let found = find_problems(&result.reply);
    result.problems.extend(found);
    result
}

/// `.replace(/\s+/g, ' ')`.
fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for ch in text.chars() {
        if is_js_space(ch) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(ch);
            in_space = false;
        }
    }
    out
}

async fn run_sequence(
    engine: &Engine,
    input: &SimulationInput,
    runs: &[SimulationRunInput],
    categories: &Arc<HashMap<String, String>>,
    wall: &dyn Clock,
    random: &Arc<dyn Random>,
) -> (Vec<SimulationRunResult>, SequenceState) {
    let mut state = SequenceState::default();
    let mut results = Vec::with_capacity(runs.len());
    for run in runs {
        results.push(run_once(engine, input, run, &mut state, categories, wall, random).await);
    }
    (results, state)
}

/// `simulateCommand(input)`: the runs in order (one run by `Sam` when none is given), the
/// variables after them, and with `repeat > 1` the distinct outcomes of repeating the whole
/// sequence (fresh state each time), most frequent first, at most 12. `random` draws the
/// placeholders' variable names and `$(random)`; `wall` anchors the engine's deadline clock.
pub async fn simulate_command(
    engine: &Engine,
    input: &SimulationInput,
    wall: &dyn Clock,
    random: Arc<dyn Random>,
) -> SimulationResult {
    let default_run = [SimulationRunInput::default()];
    let runs: &[SimulationRunInput] = match &input.runs {
        Some(runs) if !runs.is_empty() => runs,
        _ => &default_run,
    };
    let categories = Arc::new(categories(engine));
    let (results, state) = run_sequence(engine, input, runs, &categories, wall, &random).await;
    let mut variables = Vec::new();
    for (name, value) in &state.channel.values {
        variables.push((format!("channel {name}"), value.clone()));
    }
    for (key, value) in &state.users.values {
        variables.push((format!("viewer {key}"), value.clone()));
    }
    for (key, value) in &state.cache.values {
        let parts: Vec<&str> = key.split(':').collect();
        let tail = parts
            .get(parts.len().saturating_sub(2)..)
            .unwrap_or_default()
            .join(":");
        variables.push((format!("cache {tail}"), value.clone()));
    }
    // A repeated key keeps its first position and its last value, as assigning it does.
    let mut unique: Vec<(String, String)> = Vec::new();
    for (key, value) in variables {
        match unique.iter_mut().find(|(known, _)| *known == key) {
            Some(slot) => slot.1 = value,
            None => unique.push((key, value)),
        }
    }
    let mut result = SimulationResult {
        runs: results,
        outcomes: None,
        variables: unique,
        use_count: state.count,
        note: NOTE,
    };
    if input.repeat > 1 {
        let mut outcomes: Vec<(String, Outcome)> = Vec::new();
        let mut add = |runs: &[SimulationRunResult]| {
            let replies: Vec<String> = runs.iter().map(|run| run.reply.clone()).collect();
            let actions: Vec<String> = runs
                .iter()
                .flat_map(|run| {
                    run.actions
                        .iter()
                        .map(|call| format!("{}({})", call.function, call.args.join(", ")))
                })
                .collect();
            let key = dima_text::to_js_json(&json!([replies, actions]));
            match outcomes.iter_mut().find(|(known, _)| *known == key) {
                Some((_, outcome)) => outcome.times += 1,
                None => outcomes.push((
                    key,
                    Outcome {
                        times: 1,
                        replies,
                        actions,
                    },
                )),
            }
        };
        add(&result.runs);
        for _ in 1..input.repeat {
            let (again, _) = run_sequence(engine, input, runs, &categories, wall, &random).await;
            add(&again);
        }
        let mut sorted: Vec<Outcome> = outcomes.into_iter().map(|(_, outcome)| outcome).collect();
        sorted.sort_by_key(|outcome| std::cmp::Reverse(outcome.times));
        sorted.truncate(12);
        result.outcomes = Some(sorted);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn problems_are_found_as_the_reference_finds_them() {
        assert_eq!(
            find_problems("a [Parse error: x] b [Unknown function: y]"),
            ["[Parse error: x]", "[Unknown function: y]"]
        );
        assert_eq!(
            find_problems("ok Error: nope"),
            ["A function returned an error: Error: nope"]
        );
        assert!(find_problems("NoError: nope").is_empty());
        assert_eq!(find_problems("x == y").len(), 1);
        assert!(find_problems("x ? y").is_empty());
        assert_eq!(find_problems("printed $(user)").len(), 1);
        assert!(find_problems("[x == y]").is_empty());
    }

    #[test]
    fn input_is_checked() {
        let error = parse_simulation_input(&json!({})).unwrap_err();
        assert_eq!(error.0, "body is required: the response body to test");
        let error = parse_simulation_input(&json!({"body": "!cc hola"})).unwrap_err();
        assert_eq!(
            error.0,
            "Pass only the response body, not the whole !cc/!ec line."
        );
        let parsed = parse_simulation_input(
            &json!({"runs": [{"body": "x", "role": "mod", "targetLookup": "not_found"}], "repeat": "3", "plan": "pro"}),
        )
        .unwrap();
        assert_eq!(parsed.body, "x");
        assert_eq!(parsed.repeat, 3);
        assert_eq!(parsed.plan, Plan::Pro);
        let run = &parsed.runs.as_ref().unwrap()[0];
        assert_eq!(run.role, Some(SimulationRole::Mod));
        assert!(run.target_not_found);
        assert_eq!(
            parse_simulation_input(&json!({"body": "x", "repeat": 900}))
                .unwrap()
                .repeat,
            50
        );
        assert_eq!(
            parse_simulation_input(&json!({"body": "x", "repeat": -4}))
                .unwrap()
                .repeat,
            1
        );
    }

    #[test]
    fn targets_and_logins() {
        assert_eq!(normalize_target(" @SomeOne "), "someone");
        assert_eq!(normalize_target("no spaces"), "");
        assert_eq!(normalize_login(" @Ana María "), "anamaría");
        assert!(is_cc_line("  !CC hola"));
        assert!(!is_cc_line("!ccx"));
    }
}

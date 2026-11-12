//! A small in-memory host for the ported reference tests: cache and database variables in
//! maps, every host function recorded, answers configurable per function name.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]

use dima_core::{Clock, ManualClock, Random, RandomError};
use dima_engine::context::{Context, Effect, State, TimerSnapshot};
use dima_engine::eval::{Engine, Evaluated, Rendered};
use dima_engine::host::{Host, HostCall, HostError, HostFunction, HostFuture};
use dima_engine::map::OrderedMap;
use dima_engine::registry::{FunctionKind, Metadata, Registry};
use dima_engine::syntax::AstNode;
use dima_engine::value::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// A deterministic `Math.random`: SplitMix64, 52 bits per draw.
#[derive(Debug)]
pub struct Seeded(Mutex<u64>);

impl Seeded {
    pub fn new(seed: u64) -> Self {
        Self(Mutex::new(seed))
    }
}

impl Random for Seeded {
    fn fill(&self, buf: &mut [u8]) -> Result<(), RandomError> {
        for byte in buf {
            *byte = (self.float()? * 256.0) as u8;
        }
        Ok(())
    }

    fn float(&self) -> Result<f64, RandomError> {
        let mut state = self.0.lock().unwrap();
        *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = *state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        Ok((z >> 12) as f64 / (1u64 << 52) as f64)
    }
}

/// A function the host answers: name → answer from the arguments.
pub type Answer = Arc<dyn Fn(&[Value], &Context) -> Value + Send + Sync>;

/// What a test sees after a run.
#[derive(Clone, Debug, Default)]
pub struct Recorded {
    /// Every host function call: name and arguments as text.
    pub calls: Vec<(String, Vec<String>)>,
    /// Scheduled timers: seconds, body, snapshot.
    pub timers: Vec<(f64, Vec<AstNode>, TimerSnapshot)>,
    /// Slept milliseconds.
    pub sleeps: Vec<u64>,
    /// `simulate` was asked for these names.
    pub simulated: Vec<String>,
}

pub struct MemoryHost {
    pub cache: OrderedMap<String, String>,
    pub channel: HashMap<String, String>,
    /// `name:target-or-caller`.
    pub users: HashMap<String, String>,
    pub responses: Vec<String>,
    pub answers: HashMap<String, Answer>,
    pub recorded: Recorded,
    pub caller: String,
    /// When set, `simulate` answers every function not in this list (the simulation host).
    pub simulate_except: Option<Vec<&'static str>>,
    pub schedule_fails: bool,
    clock: ManualClock,
    random: Seeded,
}

impl MemoryHost {
    pub fn new(seed: u64) -> Self {
        Self {
            cache: OrderedMap::new(),
            channel: HashMap::new(),
            users: HashMap::new(),
            responses: Vec::new(),
            answers: HashMap::new(),
            recorded: Recorded::default(),
            caller: "caller".into(),
            simulate_except: None,
            schedule_fails: false,
            clock: ManualClock::new(1_767_225_600_000),
            random: Seeded::new(seed),
        }
    }

    pub fn answer(
        mut self,
        name: &str,
        answer: impl Fn(&[Value], &Context) -> Value + Send + Sync + 'static,
    ) -> Self {
        self.answers.insert(name.into(), Arc::new(answer));
        self
    }

    fn user_key(&self, name: &str, target: Option<&str>) -> String {
        format!("{name}:{}", target.unwrap_or(&self.caller))
    }
}

fn ready<'a, T: Send + 'a>(value: Result<T, HostError>) -> HostFuture<'a, Result<T, HostError>> {
    Box::pin(async move { value })
}

impl Host for MemoryHost {
    fn clock(&self) -> &dyn Clock {
        &self.clock
    }

    fn random(&self) -> &dyn Random {
        &self.random
    }

    fn call<'a>(&'a mut self, call: HostCall<'a>) -> HostFuture<'a, Result<Value, HostError>> {
        let args = call
            .args
            .iter()
            .map(|v| v.to_text_or_empty().into_owned())
            .collect();
        self.recorded.calls.push((call.name.to_owned(), args));
        let answer = self
            .answers
            .get(call.name)
            .map_or_else(Value::empty, |answer| answer(&call.args, call.context));
        ready(Ok(answer))
    }

    fn simulate<'a>(
        &'a mut self,
        name: &'a str,
        args: &'a [Value],
        _context: &'a Context,
    ) -> HostFuture<'a, Result<Option<Value>, HostError>> {
        self.recorded.simulated.push(name.to_owned());
        let answer = match &self.simulate_except {
            Some(pure) if !pure.contains(&name) => {
                let args = args
                    .iter()
                    .map(|v| v.to_text_or_empty().into_owned())
                    .collect();
                self.recorded.calls.push((name.to_owned(), args));
                Some(
                    self.answers
                        .get(name)
                        .map_or_else(Value::empty, |answer| answer(&[], _context)),
                )
            }
            _ => None,
        };
        ready(Ok(answer))
    }

    fn sleep(&mut self, millis: u64) -> HostFuture<'_, ()> {
        self.recorded.sleeps.push(millis);
        Box::pin(async {})
    }

    fn cache_get<'a>(
        &'a mut self,
        key: &'a str,
    ) -> HostFuture<'a, Result<Option<String>, HostError>> {
        ready(Ok(self.cache.get(key).cloned()))
    }

    fn cache_exists<'a>(&'a mut self, key: &'a str) -> HostFuture<'a, Result<bool, HostError>> {
        ready(Ok(self.cache.contains_key(key)))
    }

    fn cache_set<'a>(
        &'a mut self,
        key: &'a str,
        value: &'a str,
    ) -> HostFuture<'a, Result<(), HostError>> {
        self.cache.insert(key.into(), value.into());
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
        self.cache.remove(key);
        ready(Ok(()))
    }

    fn load_channel_variable<'a>(
        &'a mut self,
        name: &'a str,
    ) -> HostFuture<'a, Result<String, HostError>> {
        ready(Ok(self.channel.get(name).cloned().unwrap_or_default()))
    }

    fn save_channel_variable<'a>(
        &'a mut self,
        name: &'a str,
        value: &'a str,
    ) -> HostFuture<'a, Result<(), HostError>> {
        self.channel.insert(name.into(), value.into());
        ready(Ok(()))
    }

    fn delete_channel_variable<'a>(
        &'a mut self,
        name: &'a str,
    ) -> HostFuture<'a, Result<(), HostError>> {
        self.channel.remove(name);
        ready(Ok(()))
    }

    fn load_user_variable<'a>(
        &'a mut self,
        name: &'a str,
        target: Option<&'a str>,
    ) -> HostFuture<'a, Result<String, HostError>> {
        let key = self.user_key(name, target);
        ready(Ok(self.users.get(&key).cloned().unwrap_or_default()))
    }

    fn save_user_variable<'a>(
        &'a mut self,
        name: &'a str,
        value: &'a str,
        target: Option<&'a str>,
    ) -> HostFuture<'a, Result<(), HostError>> {
        let key = self.user_key(name, target);
        self.users.insert(key, value.into());
        ready(Ok(()))
    }

    fn delete_user_variable<'a>(
        &'a mut self,
        name: &'a str,
        target: Option<&'a str>,
    ) -> HostFuture<'a, Result<(), HostError>> {
        let key = self.user_key(name, target);
        self.users.remove(&key);
        ready(Ok(()))
    }

    fn save_responses<'a>(
        &'a mut self,
        responses: &'a [String],
    ) -> HostFuture<'a, Result<(), HostError>> {
        self.responses = responses.to_vec();
        ready(Ok(()))
    }

    fn schedule_timer<'a>(
        &'a mut self,
        seconds: f64,
        body: &'a [AstNode],
        snapshot: TimerSnapshot,
    ) -> HostFuture<'a, Result<(), HostError>> {
        self.recorded
            .timers
            .push((seconds, body.to_vec(), snapshot));
        ready(if self.schedule_fails {
            Err(HostError::new("scheduler down"))
        } else {
            Ok(())
        })
    }

    fn fork_effect(&mut self, effect: &Effect) -> Option<Effect> {
        Some(effect.clone())
    }
}

/// The standard registry plus test functions answered by the host (`registerFunction` in the
/// reference's tests).
pub fn engine_with(extra: &[(&str, Option<f64>)]) -> Engine {
    let mut registry = (*Registry::standard()).clone();
    for (name, level) in extra {
        let metadata = level.map(|level| Metadata {
            min_user_level: Some(level),
            ..Metadata::default()
        });
        registry.register(*name, FunctionKind::Host(HostFunction::Custom), metadata);
    }
    Engine::new(Arc::new(registry), dima_engine::syntax::Limits::default())
}

pub fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(future)
}

/// `evaluate(parse(source).ast, ctx)`.
pub fn evaluate(
    engine: &Engine,
    source: &str,
    context: &Context,
    state: State,
    host: &mut MemoryHost,
) -> Evaluated {
    let program = engine
        .parse(source)
        .unwrap_or_else(|e| panic!("{source}: {}", e.message));
    block_on(engine.evaluate_program(&program, context, state, host)).unwrap()
}

/// `renderAstWithSourceReference(source, ctx)`.
pub fn render(
    engine: &Engine,
    source: &str,
    context: &Context,
    state: State,
    host: &mut MemoryHost,
) -> Rendered {
    let template = engine.compile(source).unwrap();
    block_on(engine.render(&template, context, state, host)).unwrap()
}

pub fn text(evaluated: &Evaluated) -> String {
    evaluated.value.to_text().into_owned()
}

pub fn with_variable(name: &str, value: &str) -> State {
    let mut state = State::default();
    state.variables.insert(name.into(), value.into());
    state
}

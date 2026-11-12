//! Time per operation for twenty command texts taken from the evaluator and pure-function
//! corpora (the reference's own test inputs): compiling (what the bot does once per stored
//! command) and rendering (what it does for every chat message that triggers one), with an
//! in-memory host so only the engine is measured.
//!
//! Debug: `dima-rust/tools/cargo run -p dima-engine --example eval_bench [iterations]`.
//! Release: `dima-rust/tools/cargo run --release -p dima-engine --example eval_bench 20000`.
//!
//! Allocations are not counted: a counting global allocator needs `unsafe`, which the
//! workspace forbids.

use dima_core::{Clock, ManualClock, Random, RandomError};
use dima_engine::context::{Context, Effect, Plan, State, TimerSnapshot};
use dima_engine::eval::Engine;
use dima_engine::host::{Host, HostCall, HostError, HostFuture};
use dima_engine::syntax::AstNode;
use dima_engine::value::Value;
use std::collections::HashMap;
use std::hint::black_box;
use std::time::Instant;

/// Twenty texts from `ast_pure_cases.json` and `ast_evaluator_cases.json`.
const COMMANDS: [&str; 20] = [
    "$(user)",
    "$(upper hello world)",
    "$(title hello world)",
    "$(slice 0 5 hello world)",
    "$(replace \"old text\" \"new text\" the old text here)",
    "$(user ignore symbols numbers)",
    "%(name \\:\\)) $(upper %(name))",
    "Se Fusilaron a $(user) por $(ban.time) segundos. Por pellejo!",
    "Watching $(twitch.streak) consecutive streams!",
    "*($(twitch.streak) >= 5 ? \"milestone\" : \"new\")",
    "*($(ban.time) / 60)",
    "*(for #i = 0; #i < 3; #i++ { %(out[] #i) }) %(out[])",
    "*(for #i = 0; #i < 5; #i++ { *(#i == 2 ? $(continue) : \"\") %(out[] #i) }) %(out[])",
    "*(1.5 + 2.25)",
    "*(5abc == 5 ? \"yes\" : \"no\")",
    "%(sumiso 17) *(^(sumiso) ? : %(sumiso 42)) %(sumiso)",
    "a%(v x)b%(v)c",
    "%[a,b][0]",
    "$(random 6)",
    "$(sub.tier) $(sub.months) $(cheer.amount) $(raid.channel)",
];

#[derive(Debug)]
struct Lcg(std::sync::Mutex<u64>);

impl Random for Lcg {
    fn fill(&self, buf: &mut [u8]) -> Result<(), RandomError> {
        buf.fill(7);
        Ok(())
    }

    fn float(&self) -> Result<f64, RandomError> {
        let mut state = self.0.lock().map_err(|_| RandomError::Unavailable)?;
        *state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        Ok((*state >> 11) as f64 / (1u64 << 53) as f64)
    }
}

/// Variables in maps; every other effect answers empty text.
struct BenchHost {
    cache: HashMap<String, String>,
    db: HashMap<String, String>,
    clock: ManualClock,
    random: Lcg,
}

fn ready<'a, T: Send + 'a>(value: T) -> HostFuture<'a, Result<T, HostError>> {
    Box::pin(async move { Ok(value) })
}

impl Host for BenchHost {
    fn clock(&self) -> &dyn Clock {
        &self.clock
    }
    fn random(&self) -> &dyn Random {
        &self.random
    }
    fn call<'a>(&'a mut self, _call: HostCall<'a>) -> HostFuture<'a, Result<Value, HostError>> {
        ready(Value::empty())
    }
    fn sleep(&mut self, _millis: u64) -> HostFuture<'_, ()> {
        Box::pin(async {})
    }
    fn cache_get<'a>(
        &'a mut self,
        key: &'a str,
    ) -> HostFuture<'a, Result<Option<String>, HostError>> {
        ready(self.cache.get(key).cloned())
    }
    fn cache_exists<'a>(&'a mut self, key: &'a str) -> HostFuture<'a, Result<bool, HostError>> {
        ready(self.cache.contains_key(key))
    }
    fn cache_set<'a>(
        &'a mut self,
        key: &'a str,
        value: &'a str,
    ) -> HostFuture<'a, Result<(), HostError>> {
        self.cache.insert(key.into(), value.into());
        ready(())
    }
    fn cache_expire<'a>(
        &'a mut self,
        _key: &'a str,
        _seconds: u64,
    ) -> HostFuture<'a, Result<(), HostError>> {
        ready(())
    }
    fn cache_delete<'a>(&'a mut self, key: &'a str) -> HostFuture<'a, Result<(), HostError>> {
        self.cache.remove(key);
        ready(())
    }
    fn load_channel_variable<'a>(
        &'a mut self,
        name: &'a str,
    ) -> HostFuture<'a, Result<String, HostError>> {
        ready(self.db.get(name).cloned().unwrap_or_default())
    }
    fn save_channel_variable<'a>(
        &'a mut self,
        name: &'a str,
        value: &'a str,
    ) -> HostFuture<'a, Result<(), HostError>> {
        self.db.insert(name.into(), value.into());
        ready(())
    }
    fn delete_channel_variable<'a>(
        &'a mut self,
        name: &'a str,
    ) -> HostFuture<'a, Result<(), HostError>> {
        self.db.remove(name);
        ready(())
    }
    fn load_user_variable<'a>(
        &'a mut self,
        name: &'a str,
        _target: Option<&'a str>,
    ) -> HostFuture<'a, Result<String, HostError>> {
        ready(self.db.get(name).cloned().unwrap_or_default())
    }
    fn save_user_variable<'a>(
        &'a mut self,
        name: &'a str,
        value: &'a str,
        _target: Option<&'a str>,
    ) -> HostFuture<'a, Result<(), HostError>> {
        self.db.insert(name.into(), value.into());
        ready(())
    }
    fn delete_user_variable<'a>(
        &'a mut self,
        name: &'a str,
        _target: Option<&'a str>,
    ) -> HostFuture<'a, Result<(), HostError>> {
        self.db.remove(name);
        ready(())
    }
    fn save_responses<'a>(
        &'a mut self,
        _responses: &'a [String],
    ) -> HostFuture<'a, Result<(), HostError>> {
        ready(())
    }
    fn schedule_timer<'a>(
        &'a mut self,
        _seconds: f64,
        _body: &'a [AstNode],
        _snapshot: TimerSnapshot,
    ) -> HostFuture<'a, Result<(), HostError>> {
        ready(())
    }
    fn fork_effect(&mut self, _effect: &Effect) -> Option<Effect> {
        None
    }
}

fn time(iterations: u32, mut operation: impl FnMut() -> usize) -> f64 {
    let mut sink = 0usize;
    for _ in 0..iterations.min(50) {
        sink ^= operation();
    }
    let start = Instant::now();
    for _ in 0..iterations {
        sink ^= operation();
    }
    black_box(sink);
    start.elapsed().as_nanos() as f64 / f64::from(iterations)
}

fn main() {
    let iterations: u32 = std::env::args()
        .nth(1)
        .and_then(|arg| arg.parse().ok())
        .unwrap_or(2_000);
    let engine = Engine::default();
    let context = Context {
        broadcaster_id: "123".into(),
        user_id: "456".into(),
        user_login: "cdom201".into(),
        user_display_name: "CDOM201".into(),
        user_plan: Plan::Pro,
        enforce_function_permissions: false,
        event_data: Value::object(vec![
            ("is_permanent".into(), Value::Bool(false)),
            ("banned_at".into(), Value::text("2026-01-01T00:00:00Z")),
            ("ends_at".into(), Value::text("2026-01-01T00:10:00Z")),
            (
                "watch_streak".into(),
                Value::object(vec![("streak_count".into(), Value::Number(7.0))]),
            ),
            ("tier".into(), Value::text("1000")),
            ("cumulative_months".into(), Value::Number(8.0)),
        ]),
        ..Context::default()
    };
    let runtime = match tokio::runtime::Builder::new_current_thread().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("no runtime: {error}");
            return;
        }
    };
    let mut host = BenchHost {
        cache: HashMap::new(),
        db: HashMap::new(),
        clock: ManualClock::new(0),
        random: Lcg(std::sync::Mutex::new(1)),
    };
    println!(
        "{:<60} {:>12} {:>12}",
        "command (from the corpora)", "ns/compile", "ns/render"
    );
    let (mut compile_total, mut render_total) = (0.0, 0.0);
    for command in COMMANDS {
        let compile = time(iterations, || {
            engine.compile(command).map_or(0, |t| t.segments().len())
        });
        let Ok(template) = engine.compile(command) else {
            continue;
        };
        let render = time(iterations, || {
            runtime
                .block_on(engine.render(&template, &context, State::default(), &mut host))
                .map_or(0, |done| done.text.len())
        });
        compile_total += compile;
        render_total += render;
        let label: String = command.chars().take(58).collect();
        println!("{label:<60} {compile:>12.0} {render:>12.0}");
    }
    println!(
        "{:<60} {:>12.0} {:>12.0}",
        "mean of 20",
        compile_total / 20.0,
        render_total / 20.0
    );
}

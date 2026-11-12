//! `dima-bot`: the bot process, the EventSub webhook ingress on port 3333 and the chat pipeline
//! behind it (`dimabot/src/bot/index.ts`). Wiring only: the logic lives in `dima-chat` and the
//! crates below it.
//!
//! Today it reads its configuration, starts a runtime whose every thread is registered with the
//! engine's stack contract, starts telemetry, waits for `SIGTERM` or `SIGINT`, and stops within
//! the shutdown budget, exiting 0. `tests/sigterm.rs` shows it.
//!
//! # Obligations, and the package that discharges each
//!
//! Collected by `ledger/upper-layers.md` section 5 (5.1 and 5.3); `[x]` is done here.
//!
//! Start-up, in the reference's order (`bot/index.ts:24-54`):
//!
//! - [x] Every runtime thread registers its real stack size with the engine
//!   (`dima_engine::stack::register_thread` in `on_thread_start`, [`THREAD_STACK_BYTES`] set on
//!   the runtime), or every evaluation fails (E-ENGINE-02b). Evaluations run on spawned tasks,
//!   never in the main future, whose thread is not registered.
//! - [x] Telemetry, console always, export when Dragonfly is configured (F-TELEMETRY).
//! - [ ] PostHog log export (`PosthogConfig::reference()`, the reference's `startSDKLogger`),
//!   after the stores: P4-BIN-BOT.
//! - [ ] Dragonfly (the Rust processes use logical database 1: port value `6379/1`, charter
//!   section 3), MongoDB, Qdrant, Polar: P4-BIN-BOT.
//! - [ ] `Twitch::start_recovery` once, holding the start at most 3 s (P2-TWITCH-01c): P4-BIN-BOT.
//! - [ ] Product events and the bot metrics loop (`metrics:bot:*`, flushed every
//!   `BOT_METRICS_INTERVAL_MS`, default 30 s): P4-BOT-INGRESS.
//! - [ ] Pub/sub (Rust channel names differ from the TypeScript ones, charter section 3) and the
//!   keyword cache subscription: P4-BOT-INGRESS, P4-CMD-RUNTIME.
//! - [ ] The streamer directory (`Twitch::load_streamers`): P4-BIN-BOT.
//! - [ ] The AST timer scheduler (2 s reconcile plus one timer per due job, the carried
//!   `ast:timers:*` family): P4-ACT-CORE.
//! - [ ] The EventSub listener on 3333, answering 2xx and keeping a dead-letter record for an
//!   event that can never be valid (lead's decision on plan question 5): P4-BOT-INGRESS.
//! - [ ] The AST catalog vectors, in the background: P4-ACT-AI-C.
//! - [ ] The first vertical slice (plan section 6): ingress, message handler, command runtime,
//!   delivery, the plain send, started alone: P4-BIN-BOT part 1.
//!
//! Running:
//!
//! - [ ] `Host::alarm` implemented, and a clock that cannot go back for the engine's deadline
//!   (`packages.md`, phase 7): P4-ACT-CORE.
//! - [ ] Messages limited per channel and evaluations in flight limited overall (a budget per
//!   message does not stop one channel from sending expensive messages one after another):
//!   P4-CHAT-MESSAGE, wired by P4-BIN-BOT.
//! - [ ] `BackendApi` over internal HTTP and `ClipPublisher` over pub/sub (calls to the API stay
//!   HTTP in the first cut, lead's decision on plan question 9): P4-ACT-MEDIA, wired by
//!   P4-BIN-BOT. `ModeratorUserLookup` (P2-TWITCH-04b): P4-ACT-MOD.
//! - [ ] The embedding batcher (350 ms, 500 per batch, 3 retries): P4-CHAT-MESSAGE.
//! - [ ] Domain-event wakeups (`dima_events::wakeups`): P4-BIN-BOT.
//! - [ ] Timed VIP code removed (owner, 2026-11-12): P4-CHAT-EVENTS.
//! - The restore-moderator loop does **not** run here: the cron runs it alone (lead's decision on
//!   plan question 4).
//!
//! Shutdown (lead's decision on plan question 11; an intended difference: the reference waits
//! for `SIGKILL`):
//!
//! - [x] `SIGTERM` or `SIGINT` starts an ordered shutdown inside [`SHUTDOWN_BUDGET`]
//!   (`Timings::shutdown_budget()`, 17 s; the Compose `stop_grace_period` of 25 s is phase 7's),
//!   ending with the telemetry flush, then the process exits 0.
//! - [ ] Stop the listener, drain in-flight webhooks, flush the metrics, `Twitch::shutdown`
//!   (token exchanges drain 15 s, then 2 s to park what is left): P4-BIN-BOT, as each part lands.
#![forbid(unsafe_code)]

mod config;

use config::Config;
use dima_core::env::EnvSource;
use dima_core::runtime::{ShutdownStep, StopSignal, shutdown_in_order, stop_signal};
use dima_telemetry::{LogOptions, Telemetry};
use serde_json::json;
use std::time::Duration;

/// The stack of every runtime thread (workers and the blocking pool), declared to the engine
/// with `dima_engine::stack::register_thread` ("a tokio worker with the default 2 MiB stack,
/// registered, keeps [the evaluation's contract] with room for the caller's own frames").
pub const THREAD_STACK_BYTES: usize = 2 * 1024 * 1024;

/// The whole shutdown, every step included: `dima_twitch::Timings::shutdown_budget()` with the
/// reference values (15 s of token-exchange drain and 2 s to park), which the container's stop
/// timeout must exceed.
pub const SHUTDOWN_BUDGET: Duration = Duration::from_secs(17);

/// The longest the final telemetry flush may take within the budget.
const TELEMETRY_FLUSH: Duration = Duration::from_secs(5);

fn main() -> anyhow::Result<()> {
    let cwd = std::env::current_dir()?;
    let (env, _dotenv) = EnvSource::load(&cwd);
    let config = Config::from_env(&env);
    drop(env);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("dima-bot")
        .thread_stack_size(THREAD_STACK_BYTES)
        .on_thread_start(|| dima_engine::stack::register_thread(THREAD_STACK_BYTES))
        .build()?;
    runtime.block_on(run(config))
}

async fn run(config: Config) -> anyhow::Result<()> {
    // Poll the signal listener once before anything else, so its handlers are installed: until
    // then a SIGTERM would kill the process with the default action.
    let mut stop = std::pin::pin!(stop_signal());
    let early = tokio::select! {
        biased;
        signal = &mut stop => Some(signal),
        () = std::future::ready(()) => None,
    };
    let telemetry = Telemetry::new(config.telemetry)?;
    let running = telemetry.start();
    telemetry.info(
        &json!({ "function": "boot", "process": "bot", "step": "ready" }),
        LogOptions::console(),
    );
    let signal = match early {
        Some(signal) => signal?,
        None => stop.await?,
    };
    telemetry.info(
        &json!({
            "function": "shutdown",
            "process": "bot",
            "signal": match signal {
                StopSignal::Terminate => "SIGTERM",
                StopSignal::Interrupt => "SIGINT",
            },
        }),
        LogOptions::console(),
    );
    let report = shutdown_in_order(
        vec![ShutdownStep::new("telemetry", async move {
            running.shutdown(TELEMETRY_FLUSH).await;
        })],
        SHUTDOWN_BUDGET,
    )
    .await;
    if !report.is_clean() {
        anyhow::bail!("shutdown did not finish within its budget: {report:?}");
    }
    Ok(())
}

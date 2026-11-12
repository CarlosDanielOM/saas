//! `dima-server`: the API process, HTTP and Socket.IO on port 3000 (`dimabot/src/server/index.ts`).
//! Wiring only: the routers are `dima-routes` ([`dima_routes::mounts::build`]), the live side
//! is `dima-realtime`.
//!
//! Today it reads its configuration, starts a runtime whose every thread is registered with the
//! engine's stack contract, starts telemetry, waits for `SIGTERM` or `SIGINT`, and stops within
//! the shutdown budget, exiting 0. It does not listen yet. `tests/sigterm.rs` shows it.
//!
//! # Obligations, and the package that discharges each
//!
//! Collected by `ledger/upper-layers.md` section 5 (5.1 and 5.2); `[x]` is done here. The whole
//! assembly is P4-BIN-API (wave 7).
//!
//! Start-up, in the reference's order (`server/index.ts:34-137`, `runtime.md` section 5.1):
//!
//! - [x] Every runtime thread registers its real stack size with the engine
//!   (`dima_engine::stack::register_thread` in `on_thread_start`, [`THREAD_STACK_BYTES`] set on
//!   the runtime), before the first route (E-ENGINE-02b). Evaluations (simulation, the site
//!   agent, the EventSub test route) run on spawned tasks, never in the main future.
//! - [x] Telemetry, console always, export when Dragonfly is configured (F-TELEMETRY).
//! - [ ] Dragonfly (logical database 1, charter section 3), MongoDB: P4-BIN-API.
//! - [ ] `Twitch::start_recovery` once, holding the start at most 3 s (P2-TWITCH-01c):
//!   P4-BIN-API.
//! - [ ] OAuth (`initializeOAuth`): P4-API-APP.
//! - [ ] Qdrant, Polar, the pub/sub subscriber, PostHog log export (`startSDKLogger`), product
//!   events, the Qdrant collections: P4-BIN-API.
//! - [ ] The streamer directory (`Twitch::load_streamers`): P4-BIN-API.
//! - [ ] Site analytics with its recovery, the board refresh every 15 s and the snapshot every
//!   hour (`server/index.ts:51`, P3-STREAM-SITE): P4-BIN-API.
//! - [ ] The clip queue: P4-RT-CLIP-FX.
//! - [ ] The TTS queue, the `tts:session-ended` subscription, the release of stale TTS
//!   processing locks: P4-RT-TTS-A, P4-RT-TTS-B.
//! - [ ] The router, mounted as `server.ts` does ([`dima_routes::mounts::build`], the middleware
//!   by P4-API-APP), and the Socket.IO server with every namespace
//!   (`dima_realtime::registry::Registry`, P4-RT-SOCKETS); a failure in either exits non-zero,
//!   as today: P4-BIN-API.
//! - [ ] The in-process `BackendApi` and `ClipPublisher` (`dima_realtime::backend`):
//!   P4-RT-SOCKETS, P4-RT-CLIP-FX. `RewardApi` (P2-TWITCH-04b): P4-SVC-COMMANDS.
//! - [ ] The desktop AI runtime: P4-RT-DESKTOP. The site agent runtime: P4-SA-RUNNER.
//! - [ ] Listen on 3000 (`dima_web::bind`), the Socket.IO layer in front of the app: P4-BIN-API.
//! - [ ] The speech route's service credential waits for the owner (plan question 1); its place
//!   is the `Undecided` guard of `/speech` in [`dima_routes::mounts::MOUNTS`].
//!
//! Loops the API owns: the 30 s stale-connection sweep, the per-socket dashboard status timer,
//! the 500 ms overlay polls of roulettes, widgets and duels, the voice preview lock (30 s)
//! (P4-RT-SOCKETS); the 2 s DimaFX poll, its 5 s lease renewal and redelivery (P4-RT-CLIP-FX);
//! the Overlay Studio 1 s loop and 15 s sweep (P4-RT-OVERLAY-LIVE); pet readiness (5 s), pet
//! recovery and peer validation (15 s) (P4-RT-PETS, P4-FEAT-PETS); desktop AI recovery (5 s)
//! and heartbeats (15 s) (P4-RT-DESKTOP); site agent recovery (10 s) and drain (30 s)
//! (P4-SA-RUNNER); speech file deletion (120 s) (P4-RT-TTS-A); the board refresh and snapshot
//! (P4-BIN-API); telemetry (10 s, [x] here); the OAuth and docs-assistant rate limits
//! (P4-API-APP, P4-API-AGENT); the upload caps (P4-API-MEDIA, P4-API-TRIGGERS-A). The reverse
//! proxy limits connections per address (phase 7); Socket.IO has no limit of its own
//! (P4-RT-SOCKETS documents it). The restore-moderator loop does **not** run here: the cron runs
//! it alone (lead's decision on plan question 4).
//!
//! Shutdown:
//!
//! - [x] `SIGTERM` or `SIGINT` starts an ordered shutdown inside [`SHUTDOWN_BUDGET`]
//!   (`Timings::shutdown_budget()`, 17 s; the Compose `stop_grace_period` of 25 s is phase 7's),
//!   ending with the telemetry flush, then the process exits 0.
//! - [ ] Stop accepting, close sockets through `dima-web`'s upgrade contract, release the TTS,
//!   DimaFX, overlay and turn leases, park token rotations (`Twitch::shutdown`), all inside the
//!   budget: P4-BIN-API, as each part lands.
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
        .thread_name("dima-server")
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
        &json!({ "function": "boot", "process": "api", "step": "ready" }),
        LogOptions::console(),
    );
    let signal = match early {
        Some(signal) => signal?,
        None => stop.await?,
    };
    telemetry.info(
        &json!({
            "function": "shutdown",
            "process": "api",
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

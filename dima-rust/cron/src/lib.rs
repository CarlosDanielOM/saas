//! `dima-cron`: the cron process, every background worker as a supervised task in one process
//! (`dimabot/src/workers/cron.index.ts` and its children, and the native index with its seven
//! worker processes). Wiring only: each worker is a loop around one library call.
//!
//! - [`worker`]: how a worker declares itself ([`worker::Worker`], [`worker::Spec`],
//!   [`worker::Pacing`], [`worker::Lease`]).
//! - [`pacing`]: the pacings of the loops that run in production today.
//! - [`runner`]: one worker's loop: lease, unit of work under its deadline (abort and join),
//!   pacing, telemetry.
//! - [`lease`]: the Dragonfly lease a worker may declare (the TypeScript `worker:*:lock`).
//! - [`host`]: the supervisor, its timing and telemetry, and the exit statuses.
//! - [`workers`]: the worker table and the workers.
//! - [`config`]: every setting, read once and validated.
//! - [`app`]: start-up and shutdown in order.
//! - [`recovery`]: `dima-cron recovery ...`, the operator commands of the rollback procedure.
//!
//! # Memory
//!
//! Resident size of the release build on the development laptop (2026-11-12; local MongoDB and
//! Dragonfly, telemetry export on, four runtime threads): **18 MiB** idle with the four workers
//! polling an empty database for a minute; **31 MiB** at most while the three projection
//! workers ran for a minute on a backlog of 150,000 activity events, 300 raid summaries and 300
//! due baselines. The cron container measured 3.10 GiB in production before the migration
//! (`ledger/baseline-production.md`), its seven native workers and their index 29 MiB.
//!
//! # Obligations, and the package that discharges each
//!
//! Collected by `ledger/upper-layers.md` section 5 (5.1 and 5.4); `[x]` is done here.
//!
//! - [x] Every runtime thread registers its real stack size with the engine
//!   (`dima_engine::stack::register_thread` in `on_thread_start`, [`THREAD_STACK_BYTES`]): the
//!   cron evaluates (timers, follow defense messages, chat announcements). One multi-threaded
//!   runtime ([`config::DEFAULT_WORKER_THREADS`] threads), no thread per worker.
//! - [x] Telemetry (F-TELEMETRY): console always, export when Dragonfly is configured; a
//!   telemetry `Worker` per supervised task.
//! - [x] `Twitch::start_recovery` once at start, holding the start at most 3 s
//!   (P2-TWITCH-01c), and `Twitch::reconcile_recovery` every five minutes
//!   ([`workers::token_recovery`]).
//! - [x] The operator commands to run the reconciliation, list the records and settle one with
//!   the services stopped (P2-TWITCH-01d; the rollback procedure): [`recovery`].
//! - [x] Shutdown inside [`host::SHUTDOWN_BUDGET`] (17 s; the Compose `stop_grace_period` of
//!   25 s is phase 7's), Twitch drained (`Twitch::shutdown`).
//! - [x] Stream activity, raid analytics and follow-defense baseline on the supervisor
//!   (P2-CRON-01).
//! - [ ] Roulette completion: when the roulette library lands (P4-FEAT-GAMES); its place is
//!   marked in [`workers::TABLE`].
//! - [ ] AI usage receipts, raid sessions, dashboard activity; the old supervisor and worker
//!   binaries retired: P2-CRON-02.
//! - [ ] The domain-events consumers, one task per consumer, and `Report` implemented with
//!   `dima-telemetry` (P2-EVENTS-02): P4-BIN-CRON with P4-EVH.
//! - [ ] The TypeScript workers (section 5.4's table) and the restore-moderator loop:
//!   P4-CRON-LEDGERS, P4-CRON-MONEY, P4-CRON-FEATURES, P4-CRON-RECAP, P4-MOD-RUN.
//! - [ ] `BackendApi`, `ClipPublisher` (P2-TWITCH-03), `ChatOut` through `ChatDelivery`, wired
//!   for the workers that post chat: P4-ACT-MEDIA, P4-CRON-FEATURES.
#![forbid(unsafe_code)]

pub mod app;
pub mod config;
pub mod host;
pub mod lease;
pub mod pacing;
pub mod recovery;
pub mod runner;
pub mod worker;
pub mod workers;

/// The stack of every runtime thread (workers and the blocking pool), declared to the engine
/// with `dima_engine::stack::register_thread`, as the API and the bot do.
pub const THREAD_STACK_BYTES: usize = 2 * 1024 * 1024;

/// Most threads of the blocking pool (the default is 512): the cron's blocking work is DNS
/// lookups and the occasional `spawn_blocking` of a worker, each under a deadline.
pub const MAX_BLOCKING_THREADS: usize = 16;

/// The runtime of the process: `worker_threads` threads with [`THREAD_STACK_BYTES`] stacks,
/// each registered with the engine.
pub fn runtime(worker_threads: usize) -> std::io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(worker_threads)
        .max_blocking_threads(MAX_BLOCKING_THREADS)
        .thread_name("dima-cron")
        .thread_stack_size(THREAD_STACK_BYTES)
        .on_thread_start(|| dima_engine::stack::register_thread(THREAD_STACK_BYTES))
        .build()
}

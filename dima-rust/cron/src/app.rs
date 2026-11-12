//! Start-up and shutdown of the cron process, in order.
//!
//! 1. The signal listener is installed before anything else (until then `SIGTERM` would kill
//!    the process with the default action).
//! 2. Telemetry (console always; export when Dragonfly is configured and observability is not
//!    disabled).
//! 3. MongoDB and Dragonfly (Rust's logical database), each bounded; a failure ends the process
//!    with status 1 after a log line naming the store. A signal during this step stops it.
//! 4. The Twitch handle, then `Twitch::start_recovery` once (at most 3 s) when the token
//!    recovery worker runs.
//! 5. The supervisor with every selected worker; the `ready` line.
//! 6. On `SIGTERM`/`SIGINT` or a fatal worker: [`crate::host::serve`].

use crate::config::Config;
use crate::host::{self, Exit};
use crate::runner::LeaseContext;
use crate::workers::{self, Deps, token_recovery};
use dima_core::runtime::{Shutdown, StopSignal, stop_signal};
use dima_core::{SecureRandom, SystemClock, SystemRandom};
use dima_store::dragonfly::Dragonfly;
use dima_store::mongo::MongoStore;
use dima_telemetry::{LogOptions, Telemetry};
use dima_twitch::{
    Destination, Level, LogEvent, Twitch, TwitchConfig, TwitchDeps, TwitchEvents, helix_provider,
    oauth_provider,
};
use serde_json::json;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

/// How long the start-up connection to the stores may take in all (MongoDB's server selection
/// is 30 s by default, as in the Node driver).
pub const CONNECT_DEADLINE: Duration = Duration::from_secs(35);

/// The Twitch crate's log entries, through the process's telemetry (same level, destination
/// and channel).
#[derive(Clone, Debug)]
pub struct TwitchLog(pub Telemetry);

impl TwitchEvents for TwitchLog {
    fn log(&self, event: &LogEvent<'_>) {
        let level = match event.level {
            Level::Debug => dima_telemetry::Level::Debug,
            Level::Info => dima_telemetry::Level::Info,
            Level::Warn => dima_telemetry::Level::Warn,
            Level::Error => dima_telemetry::Level::Error,
        };
        let destination = match event.destination {
            Destination::Console => dima_telemetry::Destination::Console,
            Destination::Cache => dima_telemetry::Destination::Cache,
            Destination::Both => dima_telemetry::Destination::Both,
        };
        self.0.log(
            level,
            event.data,
            LogOptions {
                destination,
                channel_id: event.channel_id,
                ..LogOptions::default()
            },
        );
    }
}

/// The stores and clients the process shares.
#[derive(Clone, Debug)]
pub struct Stores {
    /// MongoDB.
    pub mongo: MongoStore,
    /// Dragonfly.
    pub dragonfly: Dragonfly,
}

/// Connects MongoDB and Dragonfly, reporting through `telemetry`.
pub async fn connect(config: &Config, telemetry: &Telemetry) -> Result<Stores, String> {
    let mongo = MongoStore::connect(&config.mongo, Some(telemetry.mongo_hook()))
        .await
        .map_err(|error| format!("MongoDB (MONGO_URI): {error}"))?;
    let dragonfly = Dragonfly::connect(config.dragonfly.clone(), telemetry.dragonfly_hooks())
        .await
        .map_err(|error| format!("Dragonfly (DRAGONFLY_HOST, DRAGONFLY_PORT): {error}"))?;
    Ok(Stores { mongo, dragonfly })
}

/// The process's Twitch handle (no I/O).
pub fn twitch(
    config: &Config,
    stores: &Stores,
    telemetry: &Telemetry,
    shutdown: &Shutdown,
) -> Result<Twitch, String> {
    let mut twitch_config = TwitchConfig::new(&config.client_id, config.client_secret.clone());
    if !config.key_prefix.is_empty() {
        twitch_config.keys = dima_twitch::KeySpace::prefixed(config.key_prefix.clone());
    }
    let registry = dima_http::ProviderRegistry::builder()
        .provider(helix_provider(&twitch_config.client_id))
        .provider(oauth_provider())
        .build()
        .map_err(|error| format!("Twitch providers: {error}"))?;
    let helix = registry
        .get(dima_twitch::HELIX_PROVIDER)
        .map_err(|error| error.to_string())?
        .clone();
    let oauth = registry
        .get(dima_twitch::OAUTH_PROVIDER)
        .map_err(|error| error.to_string())?
        .clone();
    let http = dima_http::HttpClient::builder()
        .observer(telemetry.http_observer())
        .trace_injector(telemetry.trace_injector())
        .shutdown(shutdown.clone())
        .build()
        .map_err(|error| format!("HTTP client: {error}"))?;
    let exchange_http = dima_twitch::exchange_client(
        dima_http::HttpClient::builder()
            .observer(telemetry.http_observer())
            .trace_injector(telemetry.trace_injector()),
    )
    .map_err(|error| format!("HTTP client: {error}"))?;
    let random: Arc<dyn SecureRandom> = Arc::new(SystemRandom);
    Ok(Twitch::new(
        twitch_config,
        TwitchDeps {
            http,
            exchange_http,
            helix,
            oauth,
            mongo: stores.mongo.clone(),
            dragonfly: stores.dragonfly.clone(),
            cipher: config.cipher.clone(),
            clock: Arc::new(SystemClock),
            random,
            events: Arc::new(TwitchLog(telemetry.clone())),
            shutdown: shutdown.clone(),
        },
    ))
}

fn signal_name(signal: StopSignal) -> &'static str {
    match signal {
        StopSignal::Terminate => "SIGTERM",
        StopSignal::Interrupt => "SIGINT",
    }
}

/// The signal, or an error if the listener could not be installed (then only a fatal worker
/// ends the process; the container's SIGKILL remains).
async fn wait_signal<F>(stop: F, telemetry: &Telemetry) -> &'static str
where
    F: Future<Output = std::io::Result<StopSignal>>,
{
    match stop.await {
        Ok(signal) => signal_name(signal),
        Err(error) => {
            telemetry.error(
                &json!({ "function": "boot", "process": "cron", "step": "signals", "error": error.to_string() }),
                LogOptions::console(),
            );
            std::future::pending().await
        }
    }
}

/// Runs the cron until a signal or a fatal worker.
pub async fn run(config: Config) -> Exit {
    let mut stop = std::pin::pin!(stop_signal());
    let early = tokio::select! {
        biased;
        signal = &mut stop => Some(signal),
        () = std::future::ready(()) => None,
    };
    let telemetry = match Telemetry::new(config.telemetry.clone()) {
        Ok(telemetry) => telemetry,
        Err(error) => {
            eprintln!("telemetry: {error}");
            return Exit::Startup;
        }
    };
    let running = telemetry.start();
    let flush = |budget: Duration| async move { running.shutdown(budget).await.clean };
    telemetry.info(
        &json!({
            "function": "boot",
            "process": "cron",
            "step": "starting",
            "workers": config.workers,
            "disabled": config
                .disabled
                .iter()
                .map(|(name, setting)| json!({ "name": name, "setting": setting }))
                .collect::<Vec<_>>(),
            "workerThreads": config.worker_threads,
        }),
        LogOptions::console(),
    );
    if let Some(signal) = early {
        let name = signal.map(signal_name).unwrap_or("signal");
        telemetry.info(
            &json!({ "function": "shutdown", "process": "cron", "signal": name }),
            LogOptions::console(),
        );
        return if flush(host::TELEMETRY_FLUSH).await {
            Exit::Clean
        } else {
            Exit::Unclean
        };
    }
    let connected = tokio::select! {
        signal = wait_signal(&mut stop, &telemetry) => Err(Some(signal)),
        stores = tokio::time::timeout(CONNECT_DEADLINE, connect(&config, &telemetry)) => match stores {
            Ok(Ok(stores)) => Ok(stores),
            Ok(Err(error)) => {
                startup_error(&telemetry, "stores", &error);
                Err(None)
            }
            Err(_) => {
                startup_error(&telemetry, "stores", "the stores did not answer within 35 s");
                Err(None)
            }
        },
    };
    let stores = match connected {
        Ok(stores) => stores,
        Err(signal) => {
            if let Some(signal) = signal {
                telemetry.info(
                    &json!({ "function": "shutdown", "process": "cron", "signal": signal }),
                    LogOptions::console(),
                );
            }
            let flushed = flush(host::TELEMETRY_FLUSH).await;
            return match signal {
                Some(_) if flushed => Exit::Clean,
                Some(_) => Exit::Unclean,
                None => Exit::Startup,
            };
        }
    };
    let shutdown = Shutdown::new();
    let twitch = match twitch(&config, &stores, &telemetry, &shutdown) {
        Ok(twitch) => twitch,
        Err(error) => {
            startup_error(&telemetry, "twitch", &error);
            flush(host::TELEMETRY_FLUSH).await;
            return Exit::Startup;
        }
    };
    let deps = Deps {
        mongo: stores.mongo.clone(),
        dragonfly: stores.dragonfly.clone(),
        twitch: twitch.clone(),
        clock: Arc::new(SystemClock),
        random: Arc::new(SystemRandom),
        key_prefix: config.key_prefix.clone(),
    };
    let (supervisor_config, backoff) = host::timing(config.restart_delay);
    let leases = LeaseContext {
        dragonfly: stores.dragonfly.clone(),
        prefix: config.key_prefix.clone(),
        random: Arc::new(SystemRandom),
    };
    let supervisor = workers::build(&config.workers, &deps).and_then(|workers| {
        host::supervisor(
            workers,
            supervisor_config,
            backoff,
            &telemetry,
            Some(leases),
        )
    });
    let supervisor = match supervisor {
        Ok(supervisor) => supervisor,
        Err(error) => {
            startup_error(&telemetry, "workers", &error);
            flush(host::TELEMETRY_FLUSH).await;
            return Exit::Startup;
        }
    };
    if config.runs(token_recovery::NAME) {
        // Once per process, before the workers: records left by an earlier process are written
        // to MongoDB (at most 3 s; a longer run goes on in the background and logs its counts).
        twitch.start_recovery().await;
    }
    let handle = supervisor.start(&shutdown);
    telemetry.info(
        &json!({ "function": "boot", "process": "cron", "step": "ready" }),
        LogOptions::console(),
    );
    let drain_twitch = twitch.clone();
    let drain_shutdown = shutdown.clone();
    let drain = async move {
        drain_shutdown.trigger();
        drain_twitch.shutdown().await
    };
    host::serve(
        handle,
        wait_signal(&mut stop, &telemetry),
        drain,
        flush,
        host::SHUTDOWN_BUDGET,
        &telemetry,
    )
    .await
}

fn startup_error(telemetry: &Telemetry, step: &str, error: &str) {
    telemetry.error(
        &json!({ "function": "boot", "process": "cron", "step": step, "error": error }),
        LogOptions::console(),
    );
}

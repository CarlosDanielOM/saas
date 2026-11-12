//! One worker's supervised task: the loop around its ticks.
//!
//! 1. If the worker declares a Dragonfly lease, take it (retrying every `retry` while another
//!    process holds it, until shutdown).
//! 2. Wait [`crate::worker::Pacing::first`], then loop: renew the lease, run one unit of work
//!    under its deadline ([`run_with_deadline`]: on expiry it is aborted **and joined**), report
//!    it, and ask the pacing what comes next: the next unit at once, after a pause, or the end
//!    of this run with an error (the supervisor restarts the worker after its backoff).
//! 3. Release the lease.
//!
//! **Shutdown.** A pause is cut short. A unit of work already running is not cancelled by the
//! shutdown signal (the native workers never cancelled an active batch): it finishes within its
//! own deadline, or is aborted and joined when the supervisor's stop deadline passes, whichever
//! comes first. Its work is registered with the supervisor's run, so nothing is left running
//! behind the process's back, and work that will not stop makes the process exit
//! ([`crate::host`]).

use crate::lease::Held;
use crate::worker::{Lease, Next, Outcome, Worker};
use dima_core::Random;
use dima_core::runtime::{DeadlineError, Shutdown, run_with_deadline};
use dima_store::dragonfly::Dragonfly;
use dima_telemetry::{LogOptions, RunOutcome, Telemetry};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;

/// What the runner needs for workers that declare a Dragonfly lease.
#[derive(Clone, Debug)]
pub struct LeaseContext {
    /// Rust's logical database.
    pub dragonfly: Dragonfly,
    /// `CRON_KEY_PREFIX`.
    pub prefix: String,
    /// For the owner token.
    pub random: Arc<dyn Random>,
}

/// One worker, ready to be supervised.
#[derive(Clone)]
pub struct Runner {
    worker: Arc<dyn Worker>,
    metrics: dima_telemetry::Worker,
    log: Telemetry,
    leases: Option<LeaseContext>,
}

impl std::fmt::Debug for Runner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Runner")
            .field("worker", &self.worker.spec().name)
            .finish_non_exhaustive()
    }
}

impl Runner {
    /// The runner of `worker`, reporting to `telemetry` under the worker's prefix.
    pub fn new(
        worker: Arc<dyn Worker>,
        telemetry: &Telemetry,
        leases: Option<LeaseContext>,
    ) -> Self {
        Self {
            metrics: telemetry.worker(worker.spec().telemetry),
            log: telemetry.clone(),
            worker,
            leases,
        }
    }

    /// The worker's name.
    pub fn name(&self) -> &'static str {
        self.worker.spec().name
    }

    /// The worker's telemetry handle.
    pub fn metrics(&self) -> &dima_telemetry::Worker {
        &self.metrics
    }

    /// One run of the worker, until `token` fires (`Ok`) or the pacing ends it (`Err`).
    pub async fn run(&self, token: Shutdown) -> Result<(), String> {
        let held = match &self.worker.spec().lease {
            Lease::Dragonfly(spec) => match self.take_lease(spec, &token).await? {
                Some(held) => Some(held),
                None => return Ok(()),
            },
            Lease::Library(_) | Lease::Unleased(_) => None,
        };
        let result = self.ticks(&token, held.as_ref()).await;
        if let Some(held) = held {
            match held.release().await {
                Ok(true) => {}
                Ok(false) => self.warn("Cron worker lease was no longer held at release", None),
                Err(error) => self.warn("Cron worker lease release failed", Some(&error)),
            }
        }
        result
    }

    /// Takes the lease, waiting while another process holds it; `None` when shutdown came
    /// first.
    async fn take_lease(
        &self,
        spec: &crate::lease::LeaseSpec,
        token: &Shutdown,
    ) -> Result<Option<Held>, String> {
        let leases = self
            .leases
            .as_ref()
            .ok_or("the worker declares a Dragonfly lease but none is configured")?;
        let key = format!("{}{}", leases.prefix, spec.key);
        let mut waiting = false;
        loop {
            let owner = leases
                .random
                .hex_token(16)
                .map_err(|error| error.to_string())?;
            match Held::take(&leases.dragonfly, key.clone(), owner, spec.ttl).await {
                Ok(Some(held)) => return Ok(Some(held)),
                Ok(None) if !waiting => {
                    waiting = true;
                    self.log.info(
                        &json!({
                            "worker": self.name(),
                            "message": "Another cron worker holds the lease; waiting for it",
                            "lockKey": spec.key,
                            "retryMs": spec.retry.as_millis(),
                        }),
                        LogOptions::console(),
                    );
                }
                Ok(None) => {}
                Err(error) => return Err(format!("taking the lease failed: {error}")),
            }
            tokio::select! {
                () = tokio::time::sleep(spec.retry) => {}
                () = token.wait() => return Ok(None),
            }
        }
    }

    async fn ticks(&self, token: &Shutdown, held: Option<&Held>) -> Result<(), String> {
        let mut pacing = self.worker.pacing();
        let mut wait = pacing.first();
        loop {
            if !wait.is_zero() {
                tokio::select! {
                    () = tokio::time::sleep(wait) => {}
                    () = token.wait() => return Ok(()),
                }
            }
            if token.is_triggered() {
                return Ok(());
            }
            if let Some(held) = held {
                match held.renew().await {
                    Ok(true) => {}
                    Ok(false) => {
                        return Err(format!(
                            "lease {} lost; another cron worker appears active",
                            held.key()
                        ));
                    }
                    Err(error) => return Err(format!("lease renewal failed: {error}")),
                }
            }
            let started = Instant::now();
            let mut run = self.metrics.run();
            let outcome = run.scope(self.tick(token)).await;
            self.report(&outcome, started.elapsed(), run);
            match pacing.after(&outcome) {
                Next::Now => wait = Duration::ZERO,
                Next::After(pause) => wait = pause,
                Next::Restart(reason) => return Err(reason),
            }
        }
    }

    /// One unit of work under the worker's deadline. Its token carries the run's registry (so
    /// the supervisor knows about it) but not the shutdown signal (see the module docs).
    async fn tick(&self, token: &Shutdown) -> Outcome {
        let tick_token = match token.registry() {
            Some(registry) => Shutdown::new().with_registry(registry),
            None => Shutdown::new(),
        };
        let worker = Arc::clone(&self.worker);
        let deadline = worker.spec().deadline;
        match run_with_deadline(&tick_token, deadline, move |scope| worker.tick(scope)).await {
            Ok(Ok(work)) => Outcome::Done(work),
            Ok(Err(error)) => Outcome::Failed(error),
            // Nothing triggers the tick's own token but the deadline and the abort of the run.
            Err(DeadlineError::TimedOut | DeadlineError::ShutDown) => Outcome::TimedOut,
            Err(DeadlineError::Panicked(message)) => Outcome::Panicked(message),
            Err(DeadlineError::Unstoppable) => Outcome::Unstoppable,
        }
    }

    fn report(&self, outcome: &Outcome, elapsed: Duration, run: dima_telemetry::worker::Run<'_>) {
        let spec = self.worker.spec();
        match outcome {
            Outcome::Done(work) => {
                self.metrics
                    .batch(spec.batch_metric, work.items, elapsed, true);
                run.finish(if work.is_idle() {
                    RunOutcome::Idle
                } else {
                    RunOutcome::Ok
                });
            }
            failed => {
                self.metrics.batch(spec.batch_metric, 0, elapsed, false);
                run.finish(RunOutcome::Error);
                let code = failed.failure_code().unwrap_or("CRON_TICK_FAILED");
                self.metrics.error("tick", code);
                let entry = json!({
                    "worker": spec.name,
                    "message": "Cron worker tick failed",
                    "code": code,
                    "error": failed.to_string(),
                    "durationMs": elapsed.as_millis(),
                });
                if matches!(failed, Outcome::Failed(_)) {
                    self.log.warn(&entry, LogOptions::console());
                } else {
                    self.log.error(&entry, LogOptions::console());
                }
            }
        }
    }

    fn warn(&self, message: &str, error: Option<&dyn std::fmt::Display>) {
        self.log.warn(
            &json!({
                "worker": self.name(),
                "message": message,
                "error": error.map(ToString::to_string),
            }),
            LogOptions::console(),
        );
    }
}

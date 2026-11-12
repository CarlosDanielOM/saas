//! The long-running entry point (`workers/domain_events.worker.ts`): the dispatcher and every
//! consumer, woken by the wakeup channel and by the sweep interval, stopped by the shutdown
//! token.
//!
//! The reference runs one process for the dispatcher and one child process per consumer, and
//! kills a child whose handler outlives its lease or execution limit, or the shutdown grace.
//! Here they are futures of one task ([`Runtime::run`], one supervised task of `dima-cron`):
//!
//! - **Dispatcher** (when given): one batch of marked events (at most `DOMAIN_EVENTS_BATCH_SIZE`)
//!   at a time; a full batch goes again at once, otherwise it waits for a wakeup or the poll
//!   interval (1 s). After a dispatch that found events it wakes every consumer (when wakeups
//!   are enabled, as the reference does).
//! - **Each consumer**: a drain pass ([`Engine::drain`]); a full pass (as many ready deliveries
//!   or journal events as a batch) goes again at once, otherwise it waits for a wake or the poll
//!   interval. One delivery at a time per consumer (one process each in the reference), and at
//!   most one handler per consumer overall by default ([`Runtime::with_max_in_flight`]), so a
//!   slow consumer only delays itself. When a handler had to be stopped (lease lost, execution
//!   limit) the consumer pauses for `DOMAIN_EVENTS_RESTART_DELAY_MS` (the reference restarts its
//!   process) and carries on.
//! - **The sweep**: every pass reads the ready deliveries again (due retries, and `processing`
//!   whose lease expired: a dead process's work) and every dispatch reads the marker again, so a
//!   lost wakeup or a dead process delays work by at most the poll interval (or the lease).
//! - **Shutdown**: no new claim; a handler in flight gets `DOMAIN_EVENTS_SHUTDOWN_GRACE_MS`
//!   (5 s) to finish and record its outcome, then it is aborted and joined, nothing is recorded,
//!   and its lease is left to expire (the next process takes the delivery up after it). As a
//!   backstop the whole run is dropped once the grace and the abort grace have passed. A handler
//!   that cannot be stopped makes [`Runtime::run`] fail with [`ConsumerError::Unstoppable`]: the
//!   process must exit.

use super::config::millis;
use super::drain::{DeliveryRecord, DrainResult, Engine, HandledRecord};
use super::{Consumer, ConsumerError};
use crate::dispatch::{DispatchError, Dispatched, Dispatcher};
use crate::wakeups::{Listener, PollSignal, WakeupConfig};
use dima_core::Shutdown;
use dima_core::runtime::WorkRegistry;
use dima_store::dragonfly::Dragonfly;
use std::collections::HashSet;
use std::sync::Arc;

/// Per-consumer figures and the reference's log lines, for the binary's telemetry and logs.
/// Every method has an empty default.
pub trait Report: Send + Sync + std::fmt::Debug {
    /// A pass that did something (`Domain event drain completed`).
    fn drained(&self, _consumer: &'static str, _result: &DrainResult) {}
    /// A pass that failed (`Domain event consumer <name> failed`), or a handler that was stopped.
    fn failed(&self, _consumer: &'static str, _error: &ConsumerError) {}
    /// A failed attempt (the reference's warn / error / info line).
    fn delivery(&self, _record: &DeliveryRecord) {}
    /// A handler returned (the reference's `queue_wait` and `queue_total` observations).
    fn handled(&self, _record: &HandledRecord) {}
    /// A dispatch that found events.
    fn dispatched(&self, _result: &Dispatched) {}
    /// A dispatch that failed (`Domain event dispatch failed`).
    fn dispatch_failed(&self, _error: &DispatchError) {}
}

/// Reports nothing.
#[derive(Clone, Copy, Debug, Default)]
pub struct Silent;

impl Report for Silent {}

/// The dispatcher and the consumers, run together.
#[derive(Debug)]
pub struct Runtime {
    engine: Engine,
    consumers: Vec<Consumer>,
    dispatcher: Option<Dispatcher>,
    wakeups: Option<(Dragonfly, WakeupConfig)>,
}

impl Runtime {
    /// `consumers` drained by `engine` (one handler at a time per consumer).
    pub fn new(engine: Engine, consumers: Vec<Consumer>) -> Result<Self, ConsumerError> {
        let mut names = HashSet::new();
        if !consumers
            .iter()
            .all(|c| names.insert(c.definition.consumer))
        {
            return Err(ConsumerError::Duplicate);
        }
        let engine = engine.with_max_in_flight(consumers.len().max(1));
        Ok(Self {
            engine,
            consumers,
            dispatcher: None,
            wakeups: None,
        })
    }

    /// Also dispatches journaled events (the cron runs it; the dispatcher's own consumers list
    /// decides which deliveries are made).
    pub fn with_dispatcher(mut self, dispatcher: Dispatcher) -> Self {
        self.dispatcher = Some(dispatcher);
        self
    }

    /// Wakes up on the journal's hints (subscribed on `dragonfly`, its own connection).
    pub fn with_wakeups(mut self, dragonfly: Dragonfly, config: WakeupConfig) -> Self {
        self.wakeups = Some((dragonfly, config));
        self
    }

    /// At most `handlers` handlers at once over every consumer.
    pub fn with_max_in_flight(mut self, handlers: usize) -> Self {
        self.engine = self.engine.with_max_in_flight(handlers);
        self
    }

    /// The engine (one pass of one consumer, for tools and tests).
    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    fn wakeups_enabled(&self) -> bool {
        self.wakeups
            .as_ref()
            .is_some_and(|(_, config)| config.enabled)
    }

    /// Runs until `shutdown` fires, then stops within the shutdown grace plus the abort grace.
    /// Work it starts is registered in `shutdown`'s registry (the supervisor's), or in its own,
    /// and joined before it returns.
    pub async fn run(&self, shutdown: &Shutdown) -> Result<(), ConsumerError> {
        let own = WorkRegistry::new();
        let token = match shutdown.registry() {
            Some(_) => shutdown.clone(),
            None => shutdown.with_registry(&own),
        };
        let registry = token.registry().cloned().unwrap_or(own);
        let config = *self.engine.config();
        let dispatch_signal = Arc::new(PollSignal::new());
        let signals: Vec<Arc<PollSignal>> = self
            .consumers
            .iter()
            .map(|_| Arc::new(PollSignal::new()))
            .collect();
        // Hints wake the dispatcher, which wakes the consumers after a dispatch that found work
        // (without a dispatcher there is nothing to wake: the consumers sweep).
        // Its own token, so it also stops when the run ends without a shutdown (a fatal error).
        let listening = token.child();
        let listener = self
            .wakeups
            .as_ref()
            .filter(|_| self.dispatcher.is_some())
            .map(|(dragonfly, wakeups)| {
                Listener::start(
                    dragonfly,
                    wakeups,
                    dispatch_signal.clone(),
                    listening.clone(),
                )
            });

        // A consumer that fails for good (a handler that would not stop) ends the whole run:
        // the other loops are dropped, which stops their handlers.
        let loops = async {
            let dispatching = async {
                self.dispatch_loop(&token, &dispatch_signal, &signals).await;
                Ok::<(), ConsumerError>(())
            };
            let consuming = futures_util::future::try_join_all(
                self.consumers
                    .iter()
                    .zip(&signals)
                    .map(|(consumer, signal)| self.consumer_loop(consumer, signal, &token)),
            );
            futures_util::future::try_join(dispatching, consuming)
                .await
                .map(|_| ())
        };
        let backstop = async {
            token.wait().await;
            tokio::time::sleep(millis(config.shutdown_grace_ms + config.abort_grace_ms)).await;
        };
        let ran = tokio::select! {
            ran = loops => ran,
            () = backstop => Ok(()),
            () = registry.unstoppable() => Err(ConsumerError::Unstoppable {
                consumer: "domain-events",
                event_key: String::new(),
            }),
        };
        dispatch_signal.stop();
        signals.iter().for_each(|signal| signal.stop());
        listening.trigger();
        if let Some(listener) = listener {
            listener.join().await;
        }
        let joined = tokio::time::timeout(millis(config.abort_grace_ms), registry.wait()).await;
        if joined.is_err() || registry.is_unstoppable() {
            return Err(ConsumerError::Unstoppable {
                consumer: "domain-events",
                event_key: String::new(),
            });
        }
        ran
    }

    async fn dispatch_loop(
        &self,
        token: &Shutdown,
        signal: &PollSignal,
        consumers: &[Arc<PollSignal>],
    ) {
        let Some(dispatcher) = &self.dispatcher else {
            return;
        };
        let config = self.engine.config();
        let batch = config.batch();
        let report = self.engine.report();
        while !token.is_triggered() {
            let dispatched = tokio::select! {
                () = token.wait() => break,
                dispatched = dispatcher.dispatch(batch) => dispatched,
            };
            let events = match dispatched {
                Ok(done) => {
                    if done.events > 0 {
                        report.dispatched(&done);
                        if self.wakeups_enabled() {
                            consumers.iter().for_each(|signal| signal.wake());
                        }
                    }
                    done.events
                }
                Err(error) => {
                    report.dispatch_failed(&error);
                    0
                }
            };
            if token.is_triggered() {
                break;
            }
            if (events as i64) < batch {
                tokio::select! {
                    () = token.wait() => break,
                    () = signal.wait(millis(config.poll_interval_ms)) => {}
                }
            }
        }
    }

    async fn consumer_loop(
        &self,
        consumer: &Consumer,
        signal: &PollSignal,
        token: &Shutdown,
    ) -> Result<(), ConsumerError> {
        let config = self.engine.config();
        let batch = config.batch() as usize;
        let report = self.engine.report();
        while !token.is_triggered() {
            match self.engine.drain(consumer, token).await {
                Ok(result) => {
                    if token.is_triggered() {
                        break;
                    }
                    if result.ready >= batch || result.scanned >= batch {
                        continue;
                    }
                }
                Err(error @ ConsumerError::Unstoppable { .. }) => {
                    report.failed(consumer.definition.consumer, &error);
                    return Err(error);
                }
                Err(error @ ConsumerError::Stopped { .. }) => {
                    // The reference's process was killed and is started again after a delay.
                    report.failed(consumer.definition.consumer, &error);
                    tokio::select! {
                        () = token.wait() => break,
                        () = tokio::time::sleep(millis(config.restart_delay_ms)) => {}
                    }
                    continue;
                }
                Err(error) => report.failed(consumer.definition.consumer, &error),
            }
            tokio::select! {
                () = token.wait() => break,
                () = signal.wait(millis(config.poll_interval_ms)) => {}
            }
        }
        Ok(())
    }
}

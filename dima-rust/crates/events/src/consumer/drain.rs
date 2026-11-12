//! One drain pass of one consumer (`drainDomainEvents`), and one delivery under its lease
//! (`processDelivery`).
//!
//! A pass first takes the consumer's ready deliveries (at most a batch, oldest `updatedAt`
//! first: `pending`, due `retry`, `processing` whose lease expired), then reads each of its
//! topics from its checkpoint in journal order (at most a batch each), making the delivery of
//! each event it admits and moving the checkpoint past it, except past one it had to defer. One
//! delivery at a time; shutdown stops the pass between deliveries.
//!
//! A delivery is claimed with a compare-and-set that takes a fresh lease token, then the handler
//! runs as a task under [`dima_core::run_with_deadline`]: the execution limit (120 s) bounds it,
//! a heartbeat renews the lease every third of it, and the handler is aborted and joined, with
//! nothing recorded, when the lease is lost, when it is about to expire unrenewed
//! (`lockedUntil - leaseSafety`, the reference's watchdog kill), when the execution limit passes,
//! or when the shutdown grace runs out. Its outcome is then written under the lease, and a write
//! that finds the lease gone records nothing (`deferred`).

use super::config::{ConsumerConfig, millis};
use super::handler::{DeliveryContext, Outcome, prerequisite_kind};
use super::records::{Records, date, date_ms, number, text};
use super::runtime::{Report, Silent};
use super::{Consumer, ConsumerError, Monotonic, StopReason, TokioMonotonic};
use crate::contracts::policy::delivery::{
    MAX_ERROR_UTF16, METRIC_HORIZON_MS, METRIC_RETRY_OFFSETS_MS, PREREQUISITE_HORIZON_MS,
    PREREQUISITE_RETRY_MS, RETRY_DELAYS_MS,
};
use crate::contracts::policy::{PolicyDecision, evaluate, is_schema_compatible};
use crate::dispatch::{DispatchEvent, HeldLease, PolicyOutcome, ensure_delivery, finish_policy};
use crate::envelope::Envelope;
use bson::{Bson, Document, doc};
use dima_core::runtime::{Deadline, DeadlineError};
use dima_core::{Clock, Random, Shutdown, run_with_deadline};
use dima_model::IndexReport;
use dima_model::StrEnum;
use dima_model::index::RequiredIndexError;
use dima_store::mongo::MongoStore;
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Fuse, FusedFuture};
use std::sync::Arc;
use tokio::sync::Semaphore;
use tokio::time::{Instant, sleep_until};

/// What one drain pass did (`DomainEventDrainResult`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DrainResult {
    /// Ready deliveries read.
    pub ready: usize,
    /// Journal events read from the checkpoints.
    pub scanned: usize,
    /// Handled successfully.
    pub succeeded: usize,
    /// Settled `skipped`.
    pub skipped: usize,
    /// Found already settled.
    pub already_complete: usize,
    /// Failed, retry scheduled.
    pub retried: usize,
    /// Dead-lettered.
    pub dead: usize,
    /// Not taken now (leased elsewhere, not due, a lost race, a prerequisite missing).
    pub deferred: usize,
}

impl DrainResult {
    fn apply(&mut self, outcome: DeliveryOutcome) {
        match outcome {
            DeliveryOutcome::Succeeded => self.succeeded += 1,
            DeliveryOutcome::Skipped => self.skipped += 1,
            DeliveryOutcome::AlreadyComplete => self.already_complete += 1,
            DeliveryOutcome::Retry => self.retried += 1,
            DeliveryOutcome::Dead => self.dead += 1,
            DeliveryOutcome::Deferred | DeliveryOutcome::RetryScheduled => self.deferred += 1,
        }
    }

    /// Whether the pass did anything worth reporting (the reference logs these).
    pub fn active(&self) -> bool {
        self.ready > 0 || self.scanned > 0 || self.retried > 0 || self.dead > 0
    }
}

/// What became of one delivery (`DeliveryOutcome`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeliveryOutcome {
    /// `succeeded`.
    Succeeded,
    /// `skipped`.
    Skipped,
    /// Retry scheduled after a failure.
    Retry,
    /// `dead`.
    Dead,
    /// Not taken now; the checkpoint scan stops here.
    Deferred,
    /// A retry owns it (not due, or a prerequisite is missing); the scan moves on.
    RetryScheduled,
    /// Already `succeeded`, `skipped` or `dead`.
    AlreadyComplete,
}

/// The reference's log line of a failed attempt (no error text, payload or token).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeliveryRecord {
    /// The consumer.
    pub consumer: &'static str,
    /// The event.
    pub event_key: String,
    /// Its type.
    pub event_type: String,
    /// `attempts` after the claim.
    pub attempts: i64,
    /// The limit.
    pub max_attempts: i64,
    /// Dead-lettered (or skipped, for a metric session).
    pub exhausted: bool,
    /// `lastErrorCode`.
    pub error_code: &'static str,
    /// `lastPrerequisiteKind`.
    pub prerequisite_kind: &'static str,
    /// The attempt's duration.
    pub duration_ms: i64,
    /// The lease's expiry as the runtime last knew it.
    pub lease_expires_at_ms: i64,
}

/// A heartbeat's write in flight (none when terminated).
type Renewal<'a> = std::pin::Pin<Box<Fuse<BoxFuture<'a, Result<bool, ConsumerError>>>>>;

/// The sources whose events are validated against their contract before a handler sees them.
const VALIDATED_SOURCES: [&str; 3] = ["twitch-eventsub", "twitch-eventsub-test", "polar-webhook"];

/// The part of the runtime that drains: store, clocks, settings, the overall limit.
#[derive(Clone, Debug)]
pub struct Engine {
    records: Records,
    clock: Arc<dyn Clock>,
    monotonic: Arc<dyn Monotonic>,
    random: Arc<dyn Random>,
    config: ConsumerConfig,
    limiter: Arc<Semaphore>,
    report: Arc<dyn Report>,
}

/// `Math.round` of a non-negative millisecond count.
fn round_ms(duration: std::time::Duration) -> i64 {
    let ms = duration.as_secs_f64() * 1000.0;
    (ms + 0.5).floor().max(0.0) as i64
}

/// `errorMessage.slice(0, 8_000)`, cut on a character boundary.
fn cut(message: &str) -> String {
    dima_text::truncate_utf16_budget(message, MAX_ERROR_UTF16).to_owned()
}

impl Engine {
    /// An engine on `store`, usable once the unique `{consumer, eventKey}` index of
    /// `domain_event_deliveries` exists (`indexes` is its startup report): without it two
    /// passes could make two deliveries of one event, and a handler would apply it twice.
    pub fn new(
        store: MongoStore,
        clock: Arc<dyn Clock>,
        random: Arc<dyn Random>,
        config: ConsumerConfig,
        events: &crate::config::EventsConfig,
        indexes: &IndexReport,
    ) -> Result<Self, RequiredIndexError> {
        crate::dispatch::require_unique_delivery_index(indexes)?;
        Ok(Self {
            records: Records {
                store,
                deadline: events.store_deadline,
            },
            clock,
            monotonic: Arc::new(TokioMonotonic::default()),
            random,
            config,
            limiter: Arc::new(Semaphore::new(64)),
            report: Arc::new(Silent),
        })
    }

    /// Measures attempt durations with `monotonic`.
    pub fn with_monotonic(mut self, monotonic: Arc<dyn Monotonic>) -> Self {
        self.monotonic = monotonic;
        self
    }

    /// Reports through `report`.
    pub fn with_report(mut self, report: Arc<dyn Report>) -> Self {
        self.report = report;
        self
    }

    /// At most `handlers` handlers run at once over every consumer (at least 1; the reference
    /// runs one per consumer process, so the runtime sets one per consumer).
    pub fn with_max_in_flight(mut self, handlers: usize) -> Self {
        self.limiter = Arc::new(Semaphore::new(handlers.clamp(1, Semaphore::MAX_PERMITS)));
        self
    }

    /// The settings.
    pub fn config(&self) -> &ConsumerConfig {
        &self.config
    }

    pub(crate) fn report(&self) -> &Arc<dyn Report> {
        &self.report
    }

    /// One pass of `consumer` (`drainDomainEvents`). Shutdown (`shutdown` fired) stops it
    /// between deliveries; a handler in flight gets the shutdown grace. Work it starts is
    /// registered in `shutdown`'s registry, if it carries one.
    pub async fn drain(
        &self,
        consumer: &Consumer,
        shutdown: &Shutdown,
    ) -> Result<DrainResult, ConsumerError> {
        let definition = consumer.definition;
        let batch = self.config.batch();
        let mut result = DrainResult::default();

        let ready = self
            .records
            .ready(definition, batch, self.clock.now_ms())
            .await?;
        result.ready = ready.len();
        for delivery in &ready {
            if shutdown.is_triggered() {
                break;
            }
            let event_id = delivery.get("eventID").cloned().unwrap_or(Bson::Null);
            let Some(event) = self.records.event(&event_id).await? else {
                if self
                    .records
                    .journal_missing(delivery, self.clock.now_ms())
                    .await?
                {
                    result.dead += 1;
                } else {
                    result.deferred += 1;
                }
                continue;
            };
            result.apply(self.process(consumer, &event, shutdown).await?);
        }

        for topic in definition.topics {
            if shutdown.is_triggered() {
                break;
            }
            let topic = topic.as_str();
            let last = self.records.checkpoint(definition.consumer, topic).await?;
            let events = self.records.scan(definition, topic, last, batch).await?;
            for event in &events {
                if shutdown.is_triggered() {
                    break;
                }
                result.scanned += 1;
                let id = event.get_object_id("_id").ok();
                let version = match event.get("schemaVersion") {
                    None => 1.0,
                    Some(value) => {
                        dima_store::mongo::number::read_number(value).unwrap_or(f64::NAN)
                    }
                };
                if !is_schema_compatible(&definition.policy(), version) {
                    if let Some(id) = id {
                        self.records
                            .advance(definition.consumer, topic, id, self.clock.now_ms())
                            .await?;
                    }
                    continue;
                }
                let outcome = self.process(consumer, event, shutdown).await?;
                result.apply(outcome);
                if outcome == DeliveryOutcome::Deferred {
                    break;
                }
                if let Some(id) = id {
                    self.records
                        .advance(definition.consumer, topic, id, self.clock.now_ms())
                        .await?;
                }
            }
        }
        if result.active() {
            self.report.drained(definition.consumer, &result);
        }
        Ok(result)
    }

    /// `processDelivery(policy, event, …)`.
    async fn process(
        &self,
        consumer: &Consumer,
        event: &Document,
        shutdown: &Shutdown,
    ) -> Result<DeliveryOutcome, ConsumerError> {
        let definition = consumer.definition;
        if shutdown.is_triggered() {
            return Ok(DeliveryOutcome::Deferred);
        }
        // The overall limit is taken before the claim, so a waiting delivery holds no lease.
        let _permit = tokio::select! {
            permit = self.limiter.acquire() => match permit {
                Ok(permit) => permit,
                Err(_) => return Ok(DeliveryOutcome::Deferred),
            },
            () = shutdown.wait() => return Ok(DeliveryOutcome::Deferred),
        };
        let mut journaled = DispatchEvent::from_document(event)?;
        // The hydrated document's default (`journaledAt: Date.now`) when it has none.
        let read_at = self.clock.now_ms();
        if journaled.policy.journaled_at_ms.is_none() {
            journaled.policy.journaled_at_ms = Some(read_at as f64);
        }
        let deadline = self.records.deadline;
        let store = &self.records.store;
        let delivery = ensure_delivery(
            store,
            deadline,
            self.clock.now_ms(),
            definition.consumer,
            &journaled,
        )
        .await?;
        let status = text(&delivery, "status");
        if matches!(status, "succeeded" | "dead" | "skipped") {
            return Ok(DeliveryOutcome::AlreadyComplete);
        }
        let policy = definition.policy();
        let decision = evaluate(&policy, journaled.policy, self.clock.now_ms() as f64);
        if decision != PolicyDecision::Eligible {
            let settled = finish_policy(
                store,
                deadline,
                self.clock.now_ms(),
                &delivery,
                &decision,
                None,
            )
            .await?;
            return Ok(policy_outcome(settled));
        }

        // A crashed attempt cannot record its failure. Retire an expired final attempt without
        // claiming again, and fence the claim itself against stale snapshots.
        let max_attempts = self.config.attempts();
        if number(&delivery, "attempts", 0.0) >= max_attempts as f64 {
            let retired = self
                .records
                .retire_exhausted(&delivery, max_attempts, self.clock.now_ms())
                .await?;
            return Ok(if retired {
                DeliveryOutcome::Dead
            } else {
                DeliveryOutcome::Deferred
            });
        }

        let lease_ms = self.config.lease();
        let locked_until = self.clock.now_ms() + lease_ms;
        let Some((claimed, token)) = self.claim(&delivery, lease_ms, max_attempts).await? else {
            // The durable retry owns this work, including after a lost deferral response.
            return Ok(if status == "retry" {
                DeliveryOutcome::RetryScheduled
            } else {
                DeliveryOutcome::Deferred
            });
        };
        self.execute(
            consumer,
            event,
            journaled,
            &claimed,
            &token,
            locked_until,
            shutdown,
        )
        .await
    }

    /// `claimDelivery`: `None` when the snapshot shows it leased, waiting or settled, or the
    /// compare-and-set loses. A claim whose reply was lost is looked up by its token.
    async fn claim(
        &self,
        delivery: &Document,
        lease_ms: i64,
        max_attempts: i64,
    ) -> Result<Option<(Document, String)>, ConsumerError> {
        let now = self.clock.now_ms();
        let token = self
            .random
            .uuid_v4()
            .map_err(|error| ConsumerError::Random(error.to_string()))?;
        let status = text(delivery, "status");
        if matches!(status, "succeeded" | "dead" | "skipped")
            || (status == "processing"
                && date_ms(delivery, "lockedUntil").is_some_and(|at| at > now))
            || (status == "retry" && date_ms(delivery, "nextAttemptAt").is_some_and(|at| at > now))
        {
            return Ok(None);
        }
        match self
            .records
            .claim(delivery, &token, lease_ms, max_attempts, now)
            .await
        {
            Ok(claimed) => Ok(claimed.map(|claimed| (claimed, token))),
            Err(ConsumerError::Store(error)) if error.outcome_unknown() => {
                // The claim may have committed with its reply lost: this caller generated the
                // token, so a delivery holding it under an unexpired lease is this caller's.
                let id = delivery.get("_id").cloned().unwrap_or(Bson::Null);
                match self
                    .records
                    .claimed_by(&id, &token, self.clock.now_ms())
                    .await
                {
                    Ok(Some(claimed)) => Ok(Some((claimed, token))),
                    Ok(None) | Err(_) => Err(ConsumerError::Store(error)),
                }
            }
            Err(error) => Err(error),
        }
    }

    fn instant_at(&self, at_ms: i64) -> Instant {
        Instant::now() + millis(at_ms - self.clock.now_ms())
    }

    /// The claimed delivery: the policy re-checked, the contract checked, the handler run under
    /// the lease, the outcome recorded under it.
    #[allow(clippy::too_many_arguments)]
    async fn execute(
        &self,
        consumer: &Consumer,
        event: &Document,
        journaled: DispatchEvent,
        claimed: &Document,
        token: &str,
        mut locked_until: i64,
        shutdown: &Shutdown,
    ) -> Result<DeliveryOutcome, ConsumerError> {
        let definition = consumer.definition;
        let started = self.monotonic.now();
        // Shutdown between the claim and the handler: the lease is left to expire.
        if shutdown.is_triggered() {
            return Ok(DeliveryOutcome::Deferred);
        }
        // Recheck immediately before execution: admission or even the claim can precede the age
        // boundary. Policy decisions never spend retry budget.
        let decision = evaluate(
            &definition.policy(),
            journaled.policy,
            self.clock.now_ms() as f64,
        );
        if decision != PolicyDecision::Eligible {
            self.assert_lease(definition.consumer, &journaled, locked_until)?;
            let settled = finish_policy(
                &self.records.store,
                self.records.deadline,
                self.clock.now_ms(),
                claimed,
                &decision,
                Some(HeldLease {
                    token,
                    duration_ms: self.since(started),
                }),
            )
            .await?;
            return Ok(policy_outcome(settled));
        }
        let outcome = match Envelope::from_document(event) {
            // A journal document a handler cannot read fails like a handler would.
            Err(error) => Outcome::Failed(error.to_string()),
            Ok(mut envelope) => {
                if envelope.journaled_at_ms.is_none() {
                    envelope.journaled_at_ms = journaled.policy.journaled_at_ms.map(|ms| ms as i64);
                }
                let checked = if VALIDATED_SOURCES.contains(&envelope.source.as_str()) {
                    envelope.validate_retained(self.clock.now_ms())
                } else {
                    Ok(())
                };
                match checked {
                    Err(error) => Outcome::Invalid(error.0),
                    Ok(()) => {
                        self.run_handler(
                            consumer,
                            envelope,
                            claimed,
                            token,
                            &mut locked_until,
                            shutdown,
                        )
                        .await?
                    }
                }
            }
        };
        self.assert_lease(definition.consumer, &journaled, locked_until)?;
        let duration_ms = self.since(started);
        self.record(
            consumer,
            &journaled,
            event,
            claimed,
            token,
            outcome,
            duration_ms,
            locked_until,
        )
        .await
    }

    /// `Math.round(performance.now() - started)`.
    fn since(&self, started: std::time::Duration) -> i64 {
        round_ms(self.monotonic.now().saturating_sub(started))
    }

    /// `assertLease()`: the lease, as this holder last extended it, has not expired.
    fn assert_lease(
        &self,
        consumer: &'static str,
        journaled: &DispatchEvent,
        locked_until: i64,
    ) -> Result<(), ConsumerError> {
        if self.clock.now_ms() >= locked_until {
            return Err(ConsumerError::Stopped {
                consumer,
                event_key: journaled.event_key.clone(),
                reason: StopReason::LeaseLost,
            });
        }
        Ok(())
    }

    /// A heartbeat's answer: `true` when the lease moved to `started + lease`.
    fn renewed(
        &self,
        answer: Result<bool, ConsumerError>,
        started: i64,
        locked_until: &mut i64,
    ) -> bool {
        match answer {
            // `assertLease()` again after the write, then the ownership check.
            Ok(true) if self.clock.now_ms() < *locked_until => {
                *locked_until = started + self.config.lease();
                true
            }
            Ok(_) | Err(_) => false,
        }
    }

    /// Runs the handler as a task under its deadline, renewing the lease, and stops it (abort and
    /// join) when the lease is lost, the execution limit passes or the shutdown grace ends.
    async fn run_handler(
        &self,
        consumer: &Consumer,
        envelope: Envelope,
        claimed: &Document,
        token: &str,
        locked_until: &mut i64,
        shutdown: &Shutdown,
    ) -> Result<Outcome, ConsumerError> {
        let definition = consumer.definition;
        let id = claimed.get("_id").cloned().unwrap_or(Bson::Null);
        let event_key = envelope.event_key.clone();
        let stopped = |reason| ConsumerError::Stopped {
            consumer: definition.consumer,
            event_key: event_key.clone(),
            reason,
        };
        // The handler's own token: not the shutdown token (a handler in flight gets the grace),
        // but it carries the caller's registry, so its owner can join it whatever happens here.
        let stop = match shutdown.registry() {
            Some(registry) => Shutdown::new().with_registry(registry),
            None => Shutdown::new(),
        };
        let context = DeliveryContext {
            consumer: definition.consumer,
            delivery_id: claimed
                .get_object_id("_id")
                .unwrap_or_else(|_| bson::oid::ObjectId::from_bytes([0; 12])),
            attempt: number(claimed, "attempts", 0.0) as i64,
            replay_count: number(claimed, "replayCount", 0.0) as i64,
            stop: stop.clone(),
        };
        let handler = consumer.handler.clone();
        let limit = Deadline {
            limit: millis(self.config.execution_timeout_ms),
            grace: millis(self.config.abort_grace_ms),
        };
        let work = run_with_deadline(&stop, limit, move |_scope| async move {
            handler.handle(&envelope, &context).await
        });
        tokio::pin!(work);

        let lease_ms = self.config.lease();
        let safety = self.config.lease_safety_ms();
        let period = self.config.heartbeat();
        let mut next_beat = Instant::now() + period;
        let mut watchdog = self.instant_at(*locked_until - safety);
        let mut renewal: Renewal<'_> = Box::pin(Fuse::terminated());
        let mut renewal_started = 0;
        let mut lost = false;
        let mut grace_until: Option<Instant> = None;
        let mut shut = false;
        let result = loop {
            let grace_at = grace_until.unwrap_or(watchdog);
            tokio::select! {
                biased;
                result = &mut work => break result,
                answer = &mut renewal, if !renewal.is_terminated() => {
                    if self.renewed(answer, renewal_started, locked_until) {
                        watchdog = self.instant_at(*locked_until - safety);
                    } else {
                        lost = true;
                        stop.trigger();
                    }
                }
                () = sleep_until(next_beat), if renewal.is_terminated() && !lost => {
                    let now = Instant::now();
                    while next_beat <= now {
                        next_beat += period;
                    }
                    let at = self.clock.now_ms();
                    if at >= *locked_until {
                        lost = true;
                        stop.trigger();
                    } else {
                        renewal_started = at;
                        renewal.set(self.records.renew(&id, token, at, lease_ms).boxed().fuse());
                    }
                }
                // The reference's watchdog: a lease not renewed in time is about to expire.
                () = sleep_until(watchdog), if !lost => {
                    lost = true;
                    stop.trigger();
                }
                () = shutdown.wait(), if grace_until.is_none() => {
                    grace_until = Some(Instant::now() + millis(self.config.shutdown_grace_ms));
                }
                () = sleep_until(grace_at), if grace_until.is_some() && !shut => {
                    shut = true;
                    stop.trigger();
                }
            }
        };
        // `clearInterval(heartbeat); await renewal;`
        if !renewal.is_terminated() {
            let answer = (&mut renewal).await;
            if !self.renewed(answer, renewal_started, locked_until) {
                lost = true;
            }
        }
        drop(renewal);
        if lost {
            return Err(stopped(StopReason::LeaseLost));
        }
        match result {
            Ok(outcome) => Ok(outcome),
            // A panic is the handler failing, like a thrown error.
            Err(DeadlineError::Panicked(message)) => Ok(Outcome::Failed(message)),
            Err(DeadlineError::TimedOut) => Err(stopped(StopReason::ExecutionLimit)),
            Err(DeadlineError::ShutDown) if shut => Err(stopped(StopReason::Shutdown)),
            Err(DeadlineError::ShutDown) => Err(stopped(StopReason::LeaseLost)),
            Err(DeadlineError::Unstoppable) => Err(ConsumerError::Unstoppable {
                consumer: definition.consumer,
                event_key: event_key.clone(),
            }),
        }
    }

    /// Writes the outcome under the lease.
    #[allow(clippy::too_many_arguments)]
    async fn record(
        &self,
        consumer: &Consumer,
        journaled: &DispatchEvent,
        event: &Document,
        claimed: &Document,
        token: &str,
        outcome: Outcome,
        duration_ms: i64,
        locked_until: i64,
    ) -> Result<DeliveryOutcome, ConsumerError> {
        let definition = consumer.definition;
        let id = claimed.get("_id").cloned().unwrap_or(Bson::Null);
        let now = self.clock.now_ms();
        let (code, prerequisite, refund, base) = match &outcome {
            Outcome::Done => {
                return Ok(
                    if self.records.complete(&id, token, duration_ms, now).await? {
                        DeliveryOutcome::Succeeded
                    } else {
                        // Completion lost ownership.
                        DeliveryOutcome::Deferred
                    },
                );
            }
            Outcome::Failed(message) => ("handler_failed", None, false, format!("{message}\n")),
            Outcome::Invalid(message) => (
                "contract_invalid",
                None,
                true,
                format!("Domain event contract: {message}\n"),
            ),
            Outcome::MissingPrerequisite(prerequisite) => (
                "prerequisite_missing",
                Some(prerequisite.as_str()),
                true,
                format!("Missing prerequisite: {prerequisite}\n"),
            ),
        };
        let kind = prerequisite.map_or("", prerequisite_kind);
        let metric = kind == "metric";
        let journaled_at = journaled.policy.journaled_at_ms.unwrap_or(f64::NAN);
        let expires_at = journaled.expires_at.timestamp_millis() as f64;
        let now_f = now as f64;
        let horizon = js_min(
            journaled_at
                + if metric {
                    METRIC_HORIZON_MS as f64
                } else {
                    PREREQUISITE_HORIZON_MS as f64
                },
            expires_at,
        );
        let attempts = number(claimed, "attempts", 0.0);
        let max_attempts = self.config.attempts();
        let exhausted = code == "contract_invalid"
            || match prerequisite {
                Some(_) => !horizon.is_finite() || now_f >= horizon,
                None => attempts >= max_attempts as f64,
            };
        let metric_skipped = metric && exhausted;
        let message = match prerequisite {
            Some(prerequisite) if metric_skipped => {
                format!("Metric session recovery window exceeded: {prerequisite}")
            }
            Some(prerequisite) if exhausted => {
                format!("Prerequisite horizon exceeded: {prerequisite}")
            }
            _ => base,
        };
        let message = cut(&message);
        let next_attempt = match prerequisite {
            Some(_) => js_min(
                if metric {
                    journaled_at
                        + METRIC_RETRY_OFFSETS_MS
                            .iter()
                            .map(|offset| *offset as f64)
                            .find(|offset| journaled_at + offset > now_f)
                            .unwrap_or(METRIC_HORIZON_MS as f64)
                } else {
                    now_f + PREREQUISITE_RETRY_MS as f64
                },
                horizon,
            ),
            None => {
                let index = (attempts - 1.0).clamp(0.0, (RETRY_DELAYS_MS.len() - 1) as f64);
                now_f + RETRY_DELAYS_MS[index as usize] as f64
            }
        };
        let previous_dead_letter = claimed
            .get("lastDeadLetterError")
            .cloned()
            .unwrap_or_else(|| Bson::String(String::new()));
        let at = date(now);
        let set = doc! {
            "status": if metric_skipped { "skipped" } else if exhausted { "dead" } else { "retry" },
            "nextAttemptAt": if exhausted { Bson::Null } else { Bson::DateTime(date(next_attempt as i64)) },
            "lockedUntil": Bson::Null,
            "leaseToken": Bson::Null,
            "lastError": if metric_skipped { "" } else { message.as_str() },
            "skipReason": if metric_skipped { message.as_str() } else { "" },
            "lastErrorCode": code,
            "lastPrerequisiteKind": kind,
            "lastAttemptDurationMs": dima_store::mongo::number::js_number(duration_ms as f64),
            "lastDeadLetterError": if exhausted && !metric_skipped { Bson::String(message.clone()) } else { previous_dead_letter },
            "completedAt": if exhausted { Bson::DateTime(at) } else { Bson::Null },
            "deadLetteredAt": if exhausted && !metric_skipped { Bson::DateTime(at) } else { Bson::Null },
        };
        if !self.records.fail(&id, token, set, refund, now).await? {
            // Failure update lost ownership.
            return Ok(DeliveryOutcome::Deferred);
        }
        self.report.delivery(&DeliveryRecord {
            consumer: definition.consumer,
            event_key: journaled.event_key.clone(),
            event_type: text(event, "type").to_owned(),
            attempts: attempts as i64,
            max_attempts,
            exhausted,
            error_code: code,
            prerequisite_kind: kind,
            duration_ms,
            lease_expires_at_ms: locked_until,
        });
        Ok(if metric_skipped {
            DeliveryOutcome::Skipped
        } else if exhausted {
            DeliveryOutcome::Dead
        } else if prerequisite.is_some() {
            DeliveryOutcome::RetryScheduled
        } else {
            DeliveryOutcome::Retry
        })
    }
}

/// `Math.min(a, b)`: `NaN` when either is.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

fn policy_outcome(settled: PolicyOutcome) -> DeliveryOutcome {
    match settled {
        PolicyOutcome::Dead => DeliveryOutcome::Dead,
        PolicyOutcome::Skipped => DeliveryOutcome::Skipped,
        PolicyOutcome::Deferred => DeliveryOutcome::Deferred,
    }
}

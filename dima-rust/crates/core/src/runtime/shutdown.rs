//! The shutdown token, the signal listener and ordered shutdown under a deadline.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

/// A cancellation signal shared by everything that must stop on shutdown. Clones share the
/// state; [`Shutdown::child`] makes a token that also fires on its own without stopping the parent.
#[derive(Clone, Debug, Default)]
pub struct Shutdown(CancellationToken);

impl Shutdown {
    /// A token that has not fired.
    pub fn new() -> Self {
        Self(CancellationToken::new())
    }

    /// Fires the token (idempotent). Every clone and child sees it.
    pub fn trigger(&self) {
        self.0.cancel();
    }

    /// Whether the token has fired.
    pub fn is_triggered(&self) -> bool {
        self.0.is_cancelled()
    }

    /// Resolves once the token has fired (at once if it already has).
    pub async fn wait(&self) {
        self.0.cancelled().await;
    }

    /// A token that fires when this one does, or when triggered itself.
    pub fn child(&self) -> Self {
        Self(self.0.child_token())
    }
}

/// The signal that asked the process to stop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopSignal {
    /// `SIGTERM` (`docker stop`).
    Terminate,
    /// `SIGINT` (Ctrl-C).
    Interrupt,
}

/// Resolves on the first `SIGTERM` or `SIGINT`. Install it early: until it is installed the
/// default action (exit) applies. An error means the handlers could not be installed.
pub async fn stop_signal() -> std::io::Result<StopSignal> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    tokio::select! {
        _ = terminate.recv() => Ok(StopSignal::Terminate),
        _ = interrupt.recv() => Ok(StopSignal::Interrupt),
    }
}

/// One named step of an ordered shutdown.
pub struct ShutdownStep {
    name: &'static str,
    run: Pin<Box<dyn Future<Output = ()> + Send>>,
}

impl ShutdownStep {
    /// A step that runs `future` (for example: stop accepting, drain a queue, flush telemetry).
    pub fn new(name: &'static str, future: impl Future<Output = ()> + Send + 'static) -> Self {
        Self {
            name,
            run: Box::pin(future),
        }
    }
}

impl std::fmt::Debug for ShutdownStep {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShutdownStep")
            .field("name", &self.name)
            .finish()
    }
}

/// How one step of an ordered shutdown ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepOutcome {
    /// It finished.
    Completed,
    /// The deadline passed while it ran; it was dropped (cancelled at its next await point).
    TimedOut,
    /// The deadline had already passed; it never started.
    Skipped,
}

/// The outcome of [`shutdown_in_order`], one entry per step in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShutdownReport {
    /// Each step's name and outcome.
    pub steps: Vec<(&'static str, StepOutcome)>,
}

impl ShutdownReport {
    /// Whether every step completed within the deadline.
    pub fn is_clean(&self) -> bool {
        self.steps
            .iter()
            .all(|(_, outcome)| *outcome == StepOutcome::Completed)
    }
}

/// Runs the steps one after another, all within one overall `deadline`: a step that is still
/// running when the deadline passes is dropped and the remaining steps are skipped. Uses tokio
/// time, so paused-time tests control it.
pub async fn shutdown_in_order(steps: Vec<ShutdownStep>, deadline: Duration) -> ShutdownReport {
    let end = Instant::now() + deadline;
    let mut report = ShutdownReport { steps: Vec::new() };
    let mut expired = false;
    for step in steps {
        if expired {
            report.steps.push((step.name, StepOutcome::Skipped));
            continue;
        }
        let outcome = match tokio::time::timeout_at(end, step.run).await {
            Ok(()) => StepOutcome::Completed,
            Err(_) => {
                expired = true;
                StepOutcome::TimedOut
            }
        };
        report.steps.push((step.name, outcome));
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::time::sleep;

    #[tokio::test(start_paused = true)]
    async fn steps_run_in_order_until_the_deadline() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let step = |name: &'static str, ms: u64| {
            let log = Arc::clone(&log);
            ShutdownStep::new(name, async move {
                sleep(Duration::from_millis(ms)).await;
                log.lock().unwrap().push(name);
            })
        };
        let report = shutdown_in_order(
            vec![
                step("stop-accepting", 100),
                step("drain", 300),
                step("flush", 300),
                step("close", 1),
            ],
            Duration::from_millis(500),
        )
        .await;
        assert_eq!(
            report.steps,
            vec![
                ("stop-accepting", StepOutcome::Completed),
                ("drain", StepOutcome::Completed),
                ("flush", StepOutcome::TimedOut),
                ("close", StepOutcome::Skipped),
            ]
        );
        assert!(!report.is_clean());
        assert_eq!(*log.lock().unwrap(), vec!["stop-accepting", "drain"]);
    }

    #[tokio::test]
    async fn tokens_propagate_to_clones_and_children() {
        let root = Shutdown::new();
        let child = root.child();
        let grandchild = child.child();
        grandchild.trigger();
        assert!(!root.is_triggered() && !child.is_triggered());
        let clone = root.clone();
        root.trigger();
        clone.wait().await;
        child.wait().await;
        assert!(child.is_triggered());
    }
}

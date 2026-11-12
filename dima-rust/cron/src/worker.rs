//! How a worker declares itself: a [`Spec`] (name, telemetry names, the deadline of one unit of
//! work, how it stays single across processes, the setting that turns it off), a [`Pacing`]
//! (when the next unit of work runs, given how the last one ended) and a tick (one unit of work,
//! a call into its library).
//!
//! A later cron package adds a worker by writing one module of [`crate::workers`] that
//! implements [`Worker`], and one line in the table ([`crate::workers::TABLE`] and
//! [`crate::workers::build`]). The runner ([`crate::runner`]) owns everything else: the loop, the
//! deadline with abort and join, the lease, the telemetry and the restart on failure.

use crate::lease::LeaseSpec;
use dima_core::runtime::{Deadline, WorkScope};
use futures_util::future::BoxFuture;
use std::fmt;
use std::time::Duration;

/// One unit of work: a future that owns what it uses (clone the library handle into it).
pub type TickFuture = BoxFuture<'static, Result<Work, TickError>>;

/// What one unit of work did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Work {
    /// How many items it handled (events, channels, records). Zero: there was nothing to do.
    pub items: u64,
}

impl Work {
    /// Nothing to do.
    pub const IDLE: Self = Self { items: 0 };

    /// `items` handled.
    pub fn items(items: impl TryInto<u64>) -> Self {
        Self {
            items: items.try_into().unwrap_or(u64::MAX),
        }
    }

    /// Whether there was nothing to do.
    pub fn is_idle(self) -> bool {
        self.items == 0
    }
}

/// Why a unit of work failed: the error's text, for the log line (library errors never carry a
/// token or a credential; the telemetry redactor also runs over it).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct TickError(pub String);

impl TickError {
    /// From any error.
    pub fn from_error(error: &dyn fmt::Display) -> Self {
        Self(error.to_string())
    }
}

impl From<dima_stream::Error> for TickError {
    fn from(error: dima_stream::Error) -> Self {
        Self::from_error(&error)
    }
}

impl From<dima_twitch::TwitchError> for TickError {
    fn from(error: dima_twitch::TwitchError) -> Self {
        Self::from_error(&error)
    }
}

impl From<dima_core::RandomError> for TickError {
    fn from(error: dima_core::RandomError) -> Self {
        Self::from_error(&error)
    }
}

/// How a unit of work ended, as the runner saw it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// It returned.
    Done(Work),
    /// It returned an error.
    Failed(TickError),
    /// It ran past its deadline; it was aborted and has stopped.
    TimedOut,
    /// It panicked (the message).
    Panicked(String),
    /// It was aborted but did not stop within its grace period. The supervisor treats the
    /// worker as fatal whatever the pacing says (MIGRATION.md section 6).
    Unstoppable,
}

impl Outcome {
    /// The label of a failed outcome for metrics and logs (`None` when it did not fail).
    pub fn failure_code(&self) -> Option<&'static str> {
        match self {
            Self::Done(_) => None,
            Self::Failed(_) => Some("CRON_TICK_FAILED"),
            Self::TimedOut => Some("CRON_TICK_TIMEOUT"),
            Self::Panicked(_) => Some("CRON_TICK_PANIC"),
            Self::Unstoppable => Some("CRON_TICK_UNSTOPPABLE"),
        }
    }
}

impl fmt::Display for Outcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Done(work) => write!(f, "done ({} items)", work.items),
            Self::Failed(error) => write!(f, "failed: {error}"),
            Self::TimedOut => f.write_str("exceeded its deadline and was stopped"),
            Self::Panicked(message) => write!(f, "panicked: {message}"),
            Self::Unstoppable => f.write_str("did not stop within its grace period"),
        }
    }
}

/// What the runner does after a unit of work.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Next {
    /// The next unit of work at once.
    Now,
    /// The next unit of work after this pause (cut short by shutdown).
    After(Duration),
    /// End this run of the worker with the error: the supervisor starts it again after its
    /// restart delay, which grows while it keeps failing (the reference's "exit non-zero, the
    /// supervisor restarts the child").
    Restart(String),
}

/// When the next unit of work runs. One value per run of the worker: a restart starts from a
/// fresh one, as a restarted process did.
pub trait Pacing: Send {
    /// The pause before the first unit of work of a run (default: none).
    fn first(&mut self) -> Duration {
        Duration::ZERO
    }

    /// What to do after `outcome`.
    fn after(&mut self, outcome: &Outcome) -> Next;
}

/// How a worker keeps its work single across processes (and across restarts).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Lease {
    /// The library call takes and fences its own lease: the text says which, how long it lives
    /// and how it is renewed. The runner adds nothing; the worker's deadline plus its grace
    /// must stay below that lease's lifetime, so aborted work has stopped before another owner
    /// can take it over.
    Library(&'static str),
    /// No lease: the text says why running the work twice at once is harmless.
    Unleased(&'static str),
    /// The runner holds this Dragonfly lease for the whole run of the worker: taken at start
    /// (retried while another process holds it), renewed before each unit of work, released at
    /// the end; lost, the run ends and the worker restarts. The TypeScript workers'
    /// `worker:*:lock` pattern.
    Dragonfly(LeaseSpec),
}

/// A worker's declaration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Spec {
    /// The worker's name: the reference's registry name (`stream-activity`), used in logs and
    /// in `CRON_WORKERS`.
    pub name: &'static str,
    /// The telemetry prefix (`<name>_rust` for the native workers, `<name>.worker` for those
    /// ported from TypeScript; see `dima_telemetry::worker`).
    pub telemetry: &'static str,
    /// The batch metric, `<prefix>.<batch_metric>` (the native frames' name).
    pub batch_metric: &'static str,
    /// One unit of work: how long it may run, and how long it gets to stop once aborted.
    pub deadline: Deadline,
    /// How the work stays single across processes.
    pub lease: Lease,
    /// The reference's setting that turns the worker off when it is exactly `false`
    /// (`enabledEnv` of `cron.index.ts`), if it has one.
    pub enabled_env: Option<&'static str>,
}

/// A worker: its declaration, its pacing, and one unit of work.
pub trait Worker: Send + Sync + 'static {
    /// The declaration.
    fn spec(&self) -> &Spec;

    /// A fresh pacing for a new run.
    fn pacing(&self) -> Box<dyn Pacing>;

    /// One unit of work. `scope` fires when the deadline passes; blocking code goes through
    /// [`WorkScope::spawn_blocking`] so it is waited for.
    fn tick(&self, scope: WorkScope) -> TickFuture;
}

//! One budget per message ([`MessageBudget`]).
//!
//! A chat message (or a timer, or a redemption) runs one command, and that command may start
//! up to fifty references to other commands (`#(name)`), at any depth. Each run keeps its own
//! limits ([`super::EvalLimits`]: the per-plan figures for a single command); the message
//! as a whole draws every run's work, host calls, memory and output from one shared budget of
//! those figures times [`super::EvalLimits::message_factor`] ([`MessageLimits`]). When the
//! budget runs out the whole message stops: the expression that hit it shows the limit's
//! `[Parse error: …]` (as a per-run limit does), every later expression of that run hits it too,
//! and a reference not yet started is refused ([`super::EvalError::Limit`]).
//!
//! The message also has a deadline ([`MessageLimits::deadline_ms`] from its start, on the
//! host's clock, [`crate::host::Host::clock`]). The clock is read when a run takes work from
//! the budget (every [`STEP_LEASE`] work units), and before and after every host call; each
//! host call also races the host's alarm for the time left ([`crate::host::Host::alarm`]),
//! and when the alarm fires first the call in flight is dropped. Past the deadline the
//! message stops with [`LimitKind::Deadline`].
//!
//! Clones share the budget. The engine hands it to the references a run starts
//! ([`crate::context::ReferenceState::message`]); nothing outside the crate can make one.

use super::limits::{EvalLimits, LimitKind};
use crate::context::Plan;
use std::fmt;
use std::future::Future;
use std::pin::pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::task::Poll;

/// Work units a run takes from the message's budget at a time. A run spends them locally and
/// gives back what it did not use when it ends.
pub(super) const STEP_LEASE: u64 = 1024;

/// What one message may spend in all: the per-run figures of its plan times
/// [`EvalLimits::message_factor`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct MessageLimits {
    /// Work units ([`EvalLimits::steps`]).
    pub steps: u64,
    /// Host calls ([`EvalLimits::host_calls`]).
    pub host_calls: u64,
    /// Bytes the message's runs keep ([`EvalLimits::memory_bytes`]): each run's variables,
    /// memo, loop variables and reference arguments, as they stand when it ends (and while it
    /// runs).
    pub memory_bytes: u64,
    /// Bytes of output, every run's rendered text together ([`EvalLimits::text_bytes`] is
    /// one run's).
    pub output_bytes: u64,
    /// Milliseconds from the message's start to its deadline ([`EvalLimits::deadline_ms`]).
    pub deadline_ms: u64,
}

impl MessageLimits {
    /// The limits of a message of `plan`.
    pub fn of(limits: &EvalLimits, plan: Plan) -> Self {
        let factor = limits.message_factor.max(1);
        Self {
            steps: limits.steps.of(plan).saturating_mul(factor),
            host_calls: limits.host_calls.of(plan).saturating_mul(factor),
            memory_bytes: (limits.memory_bytes as u64).saturating_mul(factor),
            output_bytes: (limits.text_bytes as u64).saturating_mul(factor),
            deadline_ms: limits.deadline_ms.of(plan),
        }
    }
}

/// What a message has spent so far.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MessageUsage {
    /// Work units, including what running runs hold but have not spent yet (at most
    /// 1,024 each).
    pub steps: u64,
    /// Host calls.
    pub host_calls: u64,
    /// Bytes kept.
    pub memory_bytes: u64,
    /// Bytes of output.
    pub output_bytes: u64,
}

/// The budget of one message. See the module documentation.
#[derive(Clone)]
pub struct MessageBudget(Arc<Shared>);

struct Shared {
    limits: MessageLimits,
    /// When the message must end, in epoch milliseconds of the host's clock.
    deadline_at: i64,
    steps: AtomicU64,
    host_calls: AtomicU64,
    memory: AtomicU64,
    output: AtomicU64,
    /// 0 while the message runs, else the code of the limit that stopped it.
    stopped: AtomicU8,
}

fn code(kind: LimitKind) -> u8 {
    match kind {
        LimitKind::Steps => 1,
        LimitKind::HostCalls => 2,
        LimitKind::TextSize => 3,
        LimitKind::Nesting => 4,
        LimitKind::Memory => 5,
        LimitKind::Deadline => 6,
    }
}

fn kind(code: u8) -> Option<LimitKind> {
    Some(match code {
        1 => LimitKind::Steps,
        2 => LimitKind::HostCalls,
        3 => LimitKind::TextSize,
        4 => LimitKind::Nesting,
        5 => LimitKind::Memory,
        6 => LimitKind::Deadline,
        _ => return None,
    })
}

/// Adds `amount` to `counter` when the total stays within `limit`.
fn take(counter: &AtomicU64, amount: u64, limit: u64) -> bool {
    counter
        .try_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
            used.checked_add(amount).filter(|total| *total <= limit)
        })
        .is_ok()
}

fn give_back(counter: &AtomicU64, amount: u64) {
    let _ = counter.try_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
        Some(used.saturating_sub(amount))
    });
}

impl MessageBudget {
    /// A fresh budget for a message of `plan` that starts at `now_ms` (the host's clock).
    pub(super) fn new(limits: &EvalLimits, plan: Plan, now_ms: i64) -> Self {
        let limits = MessageLimits::of(limits, plan);
        let deadline = i64::try_from(limits.deadline_ms).unwrap_or(i64::MAX);
        Self(Arc::new(Shared {
            limits,
            deadline_at: now_ms.saturating_add(deadline),
            steps: AtomicU64::new(0),
            host_calls: AtomicU64::new(0),
            memory: AtomicU64::new(0),
            output: AtomicU64::new(0),
            stopped: AtomicU8::new(0),
        }))
    }

    /// The message's limits.
    pub fn limits(&self) -> MessageLimits {
        self.0.limits
    }

    /// What the message has spent so far.
    pub fn usage(&self) -> MessageUsage {
        MessageUsage {
            steps: self.0.steps.load(Ordering::SeqCst),
            host_calls: self.0.host_calls.load(Ordering::SeqCst),
            memory_bytes: self.0.memory.load(Ordering::SeqCst),
            output_bytes: self.0.output.load(Ordering::SeqCst),
        }
    }

    /// When the message must end, in epoch milliseconds of the host's clock.
    pub fn deadline_at_ms(&self) -> i64 {
        self.0.deadline_at
    }

    /// The limit that stopped the message, once one has.
    pub fn stopped(&self) -> Option<LimitKind> {
        kind(self.0.stopped.load(Ordering::SeqCst))
    }

    /// Whether `other` is this same budget (not another message's).
    pub fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    /// Stops the message (the first limit to stop it is the one kept) and returns the limit
    /// it stopped with.
    pub(super) fn stop(&self, limit: LimitKind) -> LimitKind {
        let _ = self
            .0
            .stopped
            .compare_exchange(0, code(limit), Ordering::SeqCst, Ordering::SeqCst);
        self.stopped().unwrap_or(limit)
    }

    /// Fails with the limit that stopped the message, if one has.
    pub(super) fn running(&self) -> Result<(), LimitKind> {
        self.stopped().map_or(Ok(()), Err)
    }

    /// Fails with [`LimitKind::Deadline`] (and stops the message) once `now_ms` has reached
    /// the deadline; otherwise the milliseconds left.
    pub(super) fn time_left(&self, now_ms: i64) -> Result<u64, LimitKind> {
        self.running()?;
        let left = self.0.deadline_at.saturating_sub(now_ms);
        if left <= 0 {
            return Err(self.stop(LimitKind::Deadline));
        }
        Ok(u64::try_from(left).unwrap_or(0))
    }

    /// Takes between `least` and `want` work units (as many as are left, up to `want`).
    pub(super) fn draw_steps(&self, want: u64, least: u64) -> Result<u64, LimitKind> {
        self.running()?;
        let limit = self.0.limits.steps;
        let mut taken = 0;
        let drawn = self
            .0
            .steps
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
                let left = limit.saturating_sub(used);
                if left < least {
                    return None;
                }
                taken = want.min(left);
                Some(used + taken)
            });
        match drawn {
            Ok(_) => Ok(taken),
            Err(_) => Err(self.stop(LimitKind::Steps)),
        }
    }

    /// Gives back work units a run took and did not spend.
    pub(super) fn return_steps(&self, units: u64) {
        if units > 0 {
            give_back(&self.0.steps, units);
        }
    }

    /// Takes one host call.
    pub(super) fn host_call(&self) -> Result<(), LimitKind> {
        self.running()?;
        if take(&self.0.host_calls, 1, self.0.limits.host_calls) {
            Ok(())
        } else {
            Err(self.stop(LimitKind::HostCalls))
        }
    }

    /// Whether `bytes` more would fit in the memory budget (nothing is taken).
    pub(super) fn memory_fits(&self, bytes: u64) -> Result<(), LimitKind> {
        self.running()?;
        let used = self.0.memory.load(Ordering::SeqCst);
        if used.saturating_add(bytes) <= self.0.limits.memory_bytes {
            Ok(())
        } else {
            Err(self.stop(LimitKind::Memory))
        }
    }

    /// Takes `bytes` of memory.
    pub(super) fn reserve_memory(&self, bytes: u64) -> Result<(), LimitKind> {
        self.running()?;
        if take(&self.0.memory, bytes, self.0.limits.memory_bytes) {
            Ok(())
        } else {
            Err(self.stop(LimitKind::Memory))
        }
    }

    /// Adds `bytes` of memory without a check (a run restoring what it had).
    pub(super) fn add_memory(&self, bytes: u64) {
        self.0.memory.fetch_add(bytes, Ordering::SeqCst);
    }

    /// Gives back `bytes` of memory.
    pub(super) fn release_memory(&self, bytes: u64) {
        give_back(&self.0.memory, bytes);
    }

    /// Takes `bytes` of output; when they do not fit, takes what is left, stops the message
    /// and returns how many bytes it took.
    pub(super) fn output(&self, bytes: u64) -> Result<(), u64> {
        if take(&self.0.output, bytes, self.0.limits.output_bytes) {
            return Ok(());
        }
        let mut room = 0;
        let _ = self
            .0
            .output
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
                room = self.0.limits.output_bytes.saturating_sub(used).min(bytes);
                Some(used + room)
            });
        self.stop(LimitKind::TextSize);
        Err(room)
    }
}

/// Runs `work` until it ends or `alarm` fires, whichever is first; `None` when the alarm fired
/// first, and `work` (a host call in flight) is then dropped, which cancels it.
pub(super) async fn within<T>(
    mut alarm: crate::host::HostFuture<'static, ()>,
    work: impl Future<Output = T>,
) -> Option<T> {
    let mut work = pin!(work);
    std::future::poll_fn(move |cx| {
        if let Poll::Ready(value) = work.as_mut().poll(cx) {
            return Poll::Ready(Some(value));
        }
        alarm.as_mut().poll(cx).map(|()| None)
    })
    .await
}

impl fmt::Debug for MessageBudget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MessageBudget")
            .field("limits", &self.0.limits)
            .field("usage", &self.usage())
            .field("stopped", &self.stopped())
            .finish()
    }
}

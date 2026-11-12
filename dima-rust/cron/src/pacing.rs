//! The pacings the workers use, each ported from the loop that runs in production today.

use crate::worker::{Next, Outcome, Pacing};
use std::time::Duration;

/// The native workers' idle backoff (`IdleBackoff` of `src/utils/worker_process.rs`, used by
/// `bin/stream_activity.rs` and `bin/raid_analytics.rs`): a unit of work that did something is
/// followed by the next at once (a backlog is drained without waiting); one that found nothing
/// waits 1 s, then 2, 4 and 5 s, staying at 5 s until work is found again. A failure of any kind
/// ends the run (the native process exited non-zero and the supervisor restarted it).
#[derive(Debug)]
pub struct IdleBackoff {
    next_idle: Duration,
}

/// The first idle pause.
pub const IDLE_FIRST: Duration = Duration::from_secs(1);
/// The longest idle pause.
pub const IDLE_MAX: Duration = Duration::from_secs(5);

impl Default for IdleBackoff {
    fn default() -> Self {
        Self {
            next_idle: IDLE_FIRST,
        }
    }
}

impl IdleBackoff {
    fn idle(&mut self) -> Duration {
        let wait = self.next_idle;
        self.next_idle = self.next_idle.saturating_mul(2).min(IDLE_MAX);
        wait
    }
}

impl Pacing for IdleBackoff {
    fn after(&mut self, outcome: &Outcome) -> Next {
        match outcome {
            Outcome::Done(work) if work.is_idle() => Next::After(self.idle()),
            Outcome::Done(_) => {
                self.next_idle = IDLE_FIRST;
                Next::Now
            }
            failed => Next::Restart(failed.to_string()),
        }
    }
}

/// The follow-defense baseline's scheduler (`Scheduler` of `bin/follow_defense_baseline.rs`):
/// work is drained at once in bursts of [`Burst::SIZE`] channels, each burst followed by a
/// 1 s cooldown; nothing to do waits 1, 2, 4, then 5 s; an ordinary failure waits 1 s and goes
/// on (the receipt in the due set retries the channel); the 30 s watchdog (the deadline) ends
/// the run, as it ended the native process, and so does a panic.
#[derive(Debug, Default)]
pub struct Burst {
    idle: IdleBackoff,
    successes: usize,
}

impl Burst {
    /// Channels refreshed back to back before the cooldown.
    pub const SIZE: usize = 8;
    /// The pause after a full burst, and after a failure.
    pub const COOLDOWN: Duration = Duration::from_secs(1);
}

impl Pacing for Burst {
    fn after(&mut self, outcome: &Outcome) -> Next {
        match outcome {
            Outcome::Done(work) if !work.is_idle() => {
                self.idle = IdleBackoff::default();
                self.successes += 1;
                if self.successes == Self::SIZE {
                    self.successes = 0;
                    Next::After(Self::COOLDOWN)
                } else {
                    Next::Now
                }
            }
            Outcome::Done(_) => {
                self.successes = 0;
                Next::After(self.idle.idle())
            }
            Outcome::Failed(_) => {
                self.idle = IdleBackoff::default();
                self.successes = 0;
                Next::After(Self::COOLDOWN)
            }
            failed => Next::Restart(failed.to_string()),
        }
    }
}

/// A fixed period: the first unit of work after `first`, then one every `period` whatever the
/// last one did (a failure is logged and counted, and the next period tries again). A panic or
/// work that would not stop ends the run.
#[derive(Debug)]
pub struct Every {
    /// The pause before the first unit of work of a run.
    pub first: Duration,
    /// The pause between units of work.
    pub period: Duration,
}

impl Pacing for Every {
    fn first(&mut self) -> Duration {
        self.first
    }

    fn after(&mut self, outcome: &Outcome) -> Next {
        match outcome {
            Outcome::Done(_) | Outcome::Failed(_) | Outcome::TimedOut => Next::After(self.period),
            failed => Next::Restart(failed.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker::{TickError, Work};

    fn done(items: u64) -> Outcome {
        Outcome::Done(Work { items })
    }

    fn failed() -> Outcome {
        Outcome::Failed(TickError("store down".to_owned()))
    }

    fn after(seconds: u64) -> Next {
        Next::After(Duration::from_secs(seconds))
    }

    #[test]
    fn idle_polling_backs_off_to_five_seconds_and_work_resets_it() {
        let mut pacing = IdleBackoff::default();
        assert_eq!(pacing.first(), Duration::ZERO);
        for seconds in [1, 2, 4, 5, 5, 5] {
            assert_eq!(pacing.after(&done(0)), after(seconds));
        }
        // A small batch and a full backlog batch both resume at once.
        for items in [1, 500, u64::MAX] {
            assert_eq!(pacing.after(&done(items)), Next::Now);
            assert_eq!(pacing.after(&done(0)), after(1));
            assert_eq!(pacing.after(&done(0)), after(2));
        }
    }

    #[test]
    fn any_failure_restarts_an_idle_backoff_worker() {
        for outcome in [
            failed(),
            Outcome::TimedOut,
            Outcome::Panicked("boom".to_owned()),
            Outcome::Unstoppable,
        ] {
            let mut pacing = IdleBackoff::default();
            assert!(
                matches!(pacing.after(&outcome), Next::Restart(_)),
                "{outcome:?}"
            );
        }
        let mut pacing = IdleBackoff::default();
        assert_eq!(
            pacing.after(&failed()),
            Next::Restart("failed: store down".to_owned())
        );
    }

    #[test]
    fn bursts_of_eight_then_a_second_of_cooldown() {
        let mut pacing = Burst::default();
        for _ in 0..2 {
            for _ in 0..7 {
                assert_eq!(pacing.after(&done(1)), Next::Now);
            }
            assert_eq!(pacing.after(&done(1)), after(1));
        }
        for _ in 0..7 {
            assert_eq!(pacing.after(&done(1)), Next::Now);
        }
        // A failure resets the partial burst and waits a second.
        assert_eq!(pacing.after(&failed()), after(1));
        assert_eq!(pacing.after(&done(1)), Next::Now);
        assert_eq!(pacing.successes, 1);
        assert_eq!(pacing.after(&done(0)), after(1));
        assert_eq!(pacing.successes, 0);
    }

    #[test]
    fn burst_idles_like_the_native_scheduler_and_restarts_on_the_watchdog() {
        let mut pacing = Burst::default();
        for seconds in [1, 2, 4, 5, 5] {
            assert_eq!(pacing.after(&done(0)), after(seconds));
        }
        assert_eq!(pacing.after(&done(1)), Next::Now);
        assert_eq!(pacing.after(&done(0)), after(1));
        assert_eq!(pacing.after(&done(0)), after(2));
        assert_eq!(pacing.after(&failed()), after(1));
        assert_eq!(pacing.after(&done(0)), after(1));
        assert!(matches!(
            pacing.after(&Outcome::TimedOut),
            Next::Restart(reason) if reason.contains("deadline")
        ));
        assert!(matches!(
            Burst::default().after(&Outcome::Panicked("x".to_owned())),
            Next::Restart(_)
        ));
    }

    #[test]
    fn a_fixed_period_goes_on_after_failures() {
        let mut pacing = Every {
            first: Duration::from_secs(300),
            period: Duration::from_secs(300),
        };
        assert_eq!(pacing.first(), Duration::from_secs(300));
        for outcome in [done(0), done(3), failed(), Outcome::TimedOut] {
            assert_eq!(pacing.after(&outcome), after(300), "{outcome:?}");
        }
        for outcome in [Outcome::Panicked("x".to_owned()), Outcome::Unstoppable] {
            assert!(matches!(pacing.after(&outcome), Next::Restart(_)));
        }
    }
}

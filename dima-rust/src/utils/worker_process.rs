//! Narrow process-local support for native cron children.
//!
//! The Node cron supervisor owns spawning, restarts, environment allowlisting,
//! telemetry, and SIGTERM-to-SIGKILL escalation. Signal reception here only
//! notifies a child to stop cooperatively; each binary owns draining its work
//! and aborting/joining the signal task.

use std::{path::PathBuf, time::Duration};
use tokio::{sync::watch, task::JoinHandle};

/// Load only explicitly selected files, in order, without overriding variables.
///
/// Call synchronously before creating runtime or watchdog threads. Inherited
/// environment values win, followed by the first file defining a variable.
/// Errors omit file paths, contents, and raw dotenv diagnostics; callers own
/// their worker-specific message prefix.
pub fn load_env_files(paths: &[PathBuf]) -> Result<(), &'static str> {
    for path in paths {
        dotenvy::from_path(path).map_err(|_| "Cannot load selected environment file")?;
    }
    Ok(())
}

/// Notify the existing watch receiver on SIGTERM or Ctrl-C.
///
/// Signal-registration failure also requests a cooperative stop. The caller
/// retains receiver ownership and must abort/join this task when work ends.
pub fn spawn_shutdown_signal(stopping: watch::Sender<bool>) -> JoinHandle<()> {
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            let mut terminate =
                match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                    Ok(signal) => signal,
                    Err(_) => {
                        let _ = stopping.send(true);
                        return;
                    }
                };
            tokio::select! { _ = terminate.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        let _ = stopping.send(true);
    })
}

/// Consecutive empty batches back off; any work restores responsive polling.
pub struct IdleBackoff {
    next_seconds: u64,
}

impl Default for IdleBackoff {
    fn default() -> Self {
        Self { next_seconds: 1 }
    }
}

impl IdleBackoff {
    /// Return the next idle wait, or reset without waiting after nonzero work.
    pub fn after_batch(&mut self, count: usize) -> Option<Duration> {
        if count > 0 {
            self.next_seconds = 1;
            None
        } else {
            let wait = Duration::from_secs(self.next_seconds);
            self.next_seconds = (self.next_seconds * 2).min(5);
            Some(wait)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::IdleBackoff;
    use std::time::Duration;

    #[test]
    fn idle_waits_follow_the_existing_sequence_and_remain_capped() {
        let mut idle = IdleBackoff::default();
        for seconds in [1, 2, 4, 5] {
            assert_eq!(idle.after_batch(0), Some(Duration::from_secs(seconds)));
        }
        for _ in 0..100 {
            assert_eq!(idle.after_batch(0), Some(Duration::from_secs(5)));
        }
    }

    #[test]
    fn work_resets_every_backoff_stage_and_never_waits_between_busy_batches() {
        for empty_batches in 0..8 {
            for count in [1, 500, usize::MAX] {
                let mut idle = IdleBackoff::default();
                for _ in 0..empty_batches {
                    let _ = idle.after_batch(0);
                }
                for _ in 0..3 {
                    assert_eq!(idle.after_batch(count), None);
                }
                assert_eq!(idle.after_batch(0), Some(Duration::from_secs(1)));
                assert_eq!(idle.after_batch(0), Some(Duration::from_secs(2)));
            }
        }
    }
}

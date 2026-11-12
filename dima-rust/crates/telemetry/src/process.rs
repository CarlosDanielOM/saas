//! Process and runtime metrics, every 10 seconds, under the process label (`index`):
//!
//! | Metric (kind `runtime`) | Source |
//! |---|---|
//! | `<process>.rss_bytes` | `VmRSS` of `/proc/self/status` |
//! | `<process>.cpu_cores` | `getrusage(RUSAGE_SELF)` user + system time over wall time since the last sample (all threads) |
//! | `<process>.event_loop_p99_ms` | **one probe task's wake lateness**, p99 over the window (below); not an event-loop delay |
//! | `<process>.telemetry_dropped` | everything this process failed to report so far ([`crate::Stats::total_dropped`]) |
//! | `<process>.uptime_s` | seconds since the handle was built |
//!
//! **Wake lateness.** Node's figure is the p99 of event-loop delay (`monitorEventLoopDelay`,
//! 20 ms resolution); tokio has no single loop. The stand-in, kept under Node's wire name, is one
//! probe task that sleeps 20 ms in a loop and records how late it wakes; the p99 over the window
//! is reported in milliseconds (the timer's 1 ms granularity is part of the baseline). It shows
//! the runtime being starved where the probe runs: lateness means the worker thread that runs
//! the probe was busy (a blocking call, a long poll), all threads were, the CPU is saturated, or
//! the timer is behind. It misses a single blocked thread while the probe keeps running on
//! another one (a multi-threaded runtime moves it), and work outside the runtime
//! (`spawn_blocking`, other threads). Cost: 50 wake-ups per second.
//!
//! `heap_bytes` is not reported: there is no garbage-collected heap, and the resident size is the
//! figure that matters.

use crate::telemetry::Telemetry;
use std::io::Read;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;
use tokio::time::Instant;

/// The probe's period, as the reference's 20 ms resolution.
pub const PROBE_PERIOD: Duration = Duration::from_millis(20);
const PROBE_SAMPLES: usize = 512;
const PROC_LIMIT: u64 = 16_384;

/// Wake-lateness samples of the probe task in the current window, in microseconds.
pub(crate) struct WakeProbe {
    window: Mutex<ProbeWindow>,
}

struct ProbeWindow {
    samples: [u32; PROBE_SAMPLES],
    len: usize,
    seen: usize,
}

impl WakeProbe {
    pub(crate) fn new() -> Self {
        Self {
            window: Mutex::new(ProbeWindow {
                samples: [0; PROBE_SAMPLES],
                len: 0,
                seen: 0,
            }),
        }
    }

    pub(crate) fn record(&self, delay: Duration) {
        let micros = u32::try_from(delay.as_micros()).unwrap_or(u32::MAX);
        let mut window = self.window.lock().unwrap_or_else(PoisonError::into_inner);
        window.seen += 1;
        if window.len < PROBE_SAMPLES {
            let len = window.len;
            window.samples[len] = micros;
            window.len += 1;
        } else {
            // Keep the window's largest delays when more samples arrive than fit.
            if let Some((index, smallest)) = window
                .samples
                .iter()
                .enumerate()
                .min_by_key(|(_, value)| **value)
                .map(|(index, value)| (index, *value))
                && micros > smallest
            {
                window.samples[index] = micros;
            }
        }
    }

    /// The p99 of the window in milliseconds, and resets it. `None` without samples.
    pub(crate) fn take_p99_ms(&self) -> Option<f64> {
        let mut window = self.window.lock().unwrap_or_else(PoisonError::into_inner);
        let len = window.len;
        if len == 0 {
            return None;
        }
        let seen = window.seen.max(len);
        let samples = window.samples.get_mut(..len)?;
        samples.sort_unstable();
        // Rank of the p99 among everything seen; the kept samples are the largest ones.
        let from_top = seen - (seen * 99).div_ceil(100);
        let index = len.saturating_sub(1).saturating_sub(from_top);
        let value = samples.get(index).copied().unwrap_or_default();
        window.len = 0;
        window.seen = 0;
        Some(f64::from(value) / 1000.0)
    }
}

/// The probe task. It also keeps the coarse clock that picks metric buckets: a reading as old as
/// the probe's last wake, so normally under 20 ms, but older by however late the probe wakes.
pub(crate) async fn run_wake_probe(telemetry: Telemetry, stop: dima_core::Shutdown) {
    let coarse = &telemetry.0.coarse_ms;
    coarse.store(telemetry.now_ms().max(1), Ordering::Relaxed);
    loop {
        let started = Instant::now();
        tokio::select! {
            () = stop.wait() => break,
            () = tokio::time::sleep(PROBE_PERIOD) => {
                let late = started.elapsed().saturating_sub(PROBE_PERIOD);
                telemetry.0.wake_probe.record(late);
                coarse.store(telemetry.now_ms().max(1), Ordering::Relaxed);
            }
        }
    }
    coarse.store(0, Ordering::Relaxed);
}

/// CPU time of the whole process (user + system, all threads).
fn cpu_time() -> Option<Duration> {
    let usage = nix::sys::resource::getrusage(nix::sys::resource::UsageWho::RUSAGE_SELF).ok()?;
    let micros = |time: nix::sys::time::TimeVal| {
        u64::try_from(time.tv_sec()).unwrap_or_default() * 1_000_000
            + u64::try_from(time.tv_usec()).unwrap_or_default()
    };
    Some(Duration::from_micros(
        micros(usage.user_time()) + micros(usage.system_time()),
    ))
}

/// `VmRSS` in bytes from `/proc/self/status` text.
pub fn parse_rss(status: &str) -> Option<u64> {
    let line = status.lines().find(|line| line.starts_with("VmRSS:"))?;
    let rest = line.strip_prefix("VmRSS:")?.trim();
    let kb = rest.strip_suffix("kB")?.trim();
    kb.parse::<u64>().ok()?.checked_mul(1024)
}

/// Reads `/proc/self/status` (a memory-backed file: this never waits on a disk).
fn resident_bytes() -> Option<u64> {
    let file = std::fs::File::open("/proc/self/status").ok()?;
    let mut text = String::new();
    file.take(PROC_LIMIT).read_to_string(&mut text).ok()?;
    parse_rss(&text)
}

/// Turns CPU-time readings into a core count.
#[derive(Default)]
pub(crate) struct CpuRate {
    last: Option<(Duration, Instant)>,
}

impl CpuRate {
    pub(crate) fn sample(&mut self, cpu: Duration, at: Instant) -> Option<f64> {
        let previous = self.last.replace((cpu, at));
        let (cpu_before, at_before) = previous?;
        let wall = at.checked_duration_since(at_before)?.as_secs_f64();
        let used = cpu.checked_sub(cpu_before)?.as_secs_f64();
        (wall > 0.0).then(|| used / wall)
    }
}

pub(crate) struct ProcessSampler {
    cpu: CpuRate,
    started: Instant,
}

impl ProcessSampler {
    pub(crate) fn new() -> Self {
        Self {
            cpu: CpuRate::default(),
            started: Instant::now(),
        }
    }

    pub(crate) fn sample(&mut self, telemetry: &Telemetry) {
        let names = &telemetry.0.names;
        let now = Instant::now();
        if let Some(rss) = resident_bytes() {
            telemetry.observe_with("runtime", names.rss, rss as f64, "ok", Some(""));
        }
        if let Some(cores) = cpu_time().and_then(|cpu| self.cpu.sample(cpu, now)) {
            telemetry.observe_with("runtime", names.cpu, cores, "ok", Some(""));
        }
        if let Some(late) = telemetry.0.wake_probe.take_p99_ms() {
            telemetry.observe_with("runtime", names.wake_lateness_p99_ms, late, "ok", Some(""));
        }
        let dropped = telemetry.stats().total_dropped().min(1_000_000_000_000_000);
        telemetry.observe_with("runtime", names.dropped, dropped as f64, "ok", Some(""));
        let uptime = now.duration_since(self.started).as_secs_f64().floor();
        telemetry.observe_with("runtime", names.uptime, uptime, "ok", Some(""));
        crate::worker::sample_workers(telemetry, now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rss_parses_proc_status() {
        assert_eq!(
            parse_rss("Name:\tx\nVmRSS:\t   12345 kB\nVmData: 1 kB\n"),
            Some(12_641_280)
        );
        assert_eq!(parse_rss("VmRSS: x kB"), None);
        assert_eq!(parse_rss("Name: x"), None);
        assert!(resident_bytes().is_some_and(|bytes| bytes > 0));
        assert!(cpu_time().is_some());
    }

    #[test]
    fn cpu_rate_needs_two_samples() {
        let mut rate = CpuRate::default();
        let start = Instant::now();
        assert_eq!(rate.sample(Duration::from_millis(100), start), None);
        let cores = rate.sample(Duration::from_millis(600), start + Duration::from_secs(1));
        assert!(cores.is_some_and(|cores| (cores - 0.5).abs() < 1e-9));
        // A counter that goes backwards gives no figure.
        assert_eq!(
            rate.sample(Duration::from_millis(1), start + Duration::from_secs(2)),
            None
        );
    }

    #[test]
    fn probe_p99_keeps_the_slowest_wakeups() {
        let probe = WakeProbe::new();
        assert_eq!(probe.take_p99_ms(), None);
        for _ in 0..495 {
            probe.record(Duration::from_micros(100));
        }
        for _ in 0..5 {
            probe.record(Duration::from_millis(250));
        }
        // 500 samples: the p99 is the 495th smallest, the 6th largest.
        assert_eq!(probe.take_p99_ms(), Some(0.1));
        for _ in 0..990 {
            probe.record(Duration::from_micros(100));
        }
        for _ in 0..10 {
            probe.record(Duration::from_millis(300));
        }
        // 1000 seen, the 10 slowest kept: the p99 (990th) is still 0.1 ms; with 11 slow it is not.
        assert_eq!(probe.take_p99_ms(), Some(0.1));
        for _ in 0..989 {
            probe.record(Duration::from_micros(100));
        }
        for _ in 0..11 {
            probe.record(Duration::from_millis(300));
        }
        assert_eq!(probe.take_p99_ms(), Some(300.0));
    }
}

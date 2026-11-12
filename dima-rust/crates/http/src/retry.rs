//! One retry policy type for every provider.
//!
//! A [`RetryPolicy`] says which statuses and failures are retried, how long to wait (fixed
//! schedule or exponential backoff, with jitter drawn from [`dima_core::Random`]), which server
//! hints are honoured (`Retry-After` in seconds or as an HTTP date, `retry-after-ms`,
//! `Ratelimit-Reset`, `x-should-retry`), and the bounds (attempts and total time). The decision
//! itself is the pure function [`RetryPolicy::decide`], so it can be tested with a manual clock
//! and seeded randomness, and reused by a feature crate that runs its own loop.
//!
//! **Idempotency.** A request is retried only if its body can be replayed (bytes, not a stream)
//! and it is idempotent (GET, HEAD, OPTIONS, TRACE, PUT, DELETE, or marked so by the caller), or
//! the policy says [`RetryPolicy::retry_non_idempotent`], or the failure proves the server did
//! not act on it: the connection was never established, the server answered 429, or it answered
//! 401 and the credential was refreshed.
//!
//! **Reference policies this type expresses** (each is checked by a test in this module):
//!
//! | Reference | Expressed as |
//! |---|---|
//! | Helix 401 wrapper (`utils/twitch_helix_retry.ts`) | [`RetryPolicy::twitch_helix`]: 401 refreshes the credential, then waits 1 s, 3 s, 5 s |
//! | AI fetch wrapper (`utils/ai/fetch.utils.ts`) | [`RetryPolicy::fetch_with_retry`]: 429/500/502/503/504 and network errors, fixed delays, `Retry-After` ignored, POST retried |
//! | Twitch token refresh (`utils/tokens.ts`) | fixed 400 ms, 900 ms; 5xx and network errors; POST retried |
//! | Anthropic-compatible SDK (MiniMax) | 3 attempts; 408/409/429/5xx and connection errors; `retry-after-ms` / `Retry-After` when under 60 s, else backoff 0.5 s doubling to 8 s scaled by 0.75–1.0; `x-should-retry` |
//! | Fish Audio SDK | 3 attempts; 408/429/5xx; 1 s doubling, ±10 %, capped 60 s; `Retry-After` |
//! | Polar SDK | strategy none today (1 attempt); its backoff strategy (500 ms × 1.5ⁿ, max 60 s, plus up to 1 s) also fits |
//! | S3 standard mode | 3 attempts; 429/500/502/503/504 and transient failures; full jitter on 100 ms × 2ⁿ capped 20 s |
//! | Qdrant SDK | no retries ([`RetryPolicy::none`]) |
//! | OpenRouter site agent | 3 attempts on 429/502/503 and network errors before any SSE data; 1 s, 3 s; `Retry-After` capped at 10 s |
//! | PostHog / OTLP exporters | 3 s fixed; 1 s exponential with jitter on 429/502/503/504 |
//!
//! Not expressible here, on purpose: S3's classification by the error *code in the body*
//! (`RequestTimeout`, `SlowDown` under a 400) and the AWS retry token bucket; the S3 client reads
//! the body and calls [`RetryPolicy::decide`] itself if it needs them.

use crate::error::{FailureClass, TimeoutKind};
use dima_core::{Clock, Random};
use http::{HeaderMap, StatusCode};
use std::sync::Arc;
use std::time::Duration;

/// A set of HTTP status codes (100 to 599).
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub struct StatusSet([u64; 8]);

impl StatusSet {
    /// The empty set.
    pub const fn new() -> Self {
        Self([0; 8])
    }

    /// The set with `status` added (values outside 100..=599 are ignored).
    pub const fn with(mut self, status: u16) -> Self {
        if status >= 100 && status <= 599 {
            let bit = (status - 100) as usize;
            self.0[bit / 64] |= 1 << (bit % 64);
        }
        self
    }

    /// The set with every status in `from..=to` added.
    pub const fn with_range(mut self, from: u16, to: u16) -> Self {
        let mut status = from;
        while status <= to {
            self = self.with(status);
            status += 1;
        }
        self
    }

    /// Whether `status` is in the set.
    pub const fn contains(&self, status: u16) -> bool {
        if status < 100 || status > 599 {
            return false;
        }
        let bit = (status - 100) as usize;
        self.0[bit / 64] & (1 << (bit % 64)) != 0
    }
}

impl std::fmt::Debug for StatusSet {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_set()
            .entries((100..=599).filter(|s| self.contains(*s)))
            .finish()
    }
}

/// How long to wait before retry number `n` (0-based) when the server gives no hint.
#[derive(Clone, Debug, PartialEq)]
pub enum Backoff {
    /// The `n`th delay of the list (the last one repeats).
    Fixed(Arc<[Duration]>),
    /// `initial × factorⁿ`, at most `max`.
    Exponential {
        /// The first delay.
        initial: Duration,
        /// The growth factor.
        factor: f64,
        /// The cap.
        max: Duration,
    },
}

impl Backoff {
    fn base(&self, retry: u32) -> Duration {
        match self {
            Self::Fixed(delays) => {
                let index = usize::try_from(retry).unwrap_or(usize::MAX);
                delays
                    .get(index)
                    .or_else(|| delays.last())
                    .copied()
                    .unwrap_or_default()
            }
            Self::Exponential {
                initial,
                factor,
                max,
            } => {
                let exponent = i32::try_from(retry).unwrap_or(i32::MAX);
                let secs = initial.as_secs_f64() * factor.powi(exponent);
                if secs.is_finite() && secs < max.as_secs_f64() {
                    Duration::from_secs_f64(secs.max(0.0))
                } else {
                    *max
                }
            }
        }
    }
}

/// Randomisation applied to a backoff delay (never to a server hint).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Jitter {
    /// The delay as computed.
    None,
    /// The delay times a uniform factor in `low..high` (full jitter is `0.0..1.0`).
    Scale {
        /// The smallest factor.
        low: f64,
        /// The largest factor.
        high: f64,
    },
    /// The delay plus a uniform amount in `0..max`.
    Add(Duration),
}

impl Jitter {
    fn apply(self, delay: Duration, random: &dyn Random) -> Duration {
        let draw = || random.float().unwrap_or(0.5);
        match self {
            Self::None => delay,
            Self::Scale { low, high } => {
                let factor = low + (high - low) * draw();
                Duration::from_secs_f64((delay.as_secs_f64() * factor).max(0.0))
            }
            Self::Add(max) => delay + Duration::from_secs_f64(max.as_secs_f64() * draw()),
        }
    }
}

/// What to do when a server hint is longer than [`ServerDelay::cap`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OverCap {
    /// Wait the cap.
    Clamp,
    /// Ignore the hint and use the backoff.
    Backoff,
    /// Do not retry.
    Stop,
}

/// Which server hints set the delay, and how far they are trusted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ServerDelay {
    /// `Retry-After`: seconds (decimals accepted) or an HTTP date.
    pub retry_after: bool,
    /// `retry-after-ms`: milliseconds (Anthropic-compatible APIs).
    pub retry_after_ms: bool,
    /// `Ratelimit-Reset` (Twitch): the epoch second the bucket refills; only read on 429.
    pub ratelimit_reset: bool,
    /// Added to a `Ratelimit-Reset` wait (the reference's ad schedule adds 1 s).
    pub reset_pad: Duration,
    /// The longest hint honoured.
    pub cap: Duration,
    /// What happens above the cap.
    pub over_cap: OverCap,
}

impl ServerDelay {
    /// `Retry-After` honoured up to `cap`, clamped above it.
    pub const fn retry_after(cap: Duration) -> Self {
        Self {
            retry_after: true,
            retry_after_ms: false,
            ratelimit_reset: false,
            reset_pad: Duration::ZERO,
            cap,
            over_cap: OverCap::Clamp,
        }
    }

    fn hint(
        &self,
        status: StatusCode,
        headers: &HeaderMap,
        clock: &dyn Clock,
    ) -> Option<Duration> {
        let text = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::trim);
        if self.retry_after_ms
            && let Some(ms) = text("retry-after-ms").and_then(parse_non_negative)
        {
            return Some(Duration::from_secs_f64(ms / 1000.0));
        }
        if self.retry_after
            && let Some(raw) = text("retry-after")
        {
            if let Some(secs) = parse_non_negative(raw) {
                return Some(Duration::from_secs_f64(secs));
            }
            if let Some(at) = dima_text::parse_date(raw) {
                let wait = at.saturating_sub(clock.now_ms()).max(0);
                return Some(Duration::from_millis(u64::try_from(wait).unwrap_or(0)));
            }
        }
        if self.ratelimit_reset
            && status == StatusCode::TOO_MANY_REQUESTS
            && let Some(reset) = text("ratelimit-reset").and_then(parse_non_negative)
        {
            let wait_ms = (reset * 1000.0 - clock.now_ms() as f64).max(0.0);
            return Some(Duration::from_secs_f64(wait_ms / 1000.0) + self.reset_pad);
        }
        None
    }
}

/// `Number(raw)` for a header, when finite and not negative (an empty value is no hint).
fn parse_non_negative(raw: &str) -> Option<f64> {
    if raw.is_empty() {
        return None;
    }
    let value: f64 = raw.parse().ok()?;
    (value.is_finite() && value >= 0.0 && value < 1e12).then_some(value)
}

/// The retry policy of a provider or a request. Build it from a preset and adjust it with the
/// builder methods.
#[derive(Clone, Debug, PartialEq)]
pub struct RetryPolicy {
    max_attempts: u32,
    statuses: StatusSet,
    connect: bool,
    timeout: bool,
    transport: bool,
    backoff: Backoff,
    jitter: Jitter,
    server_delay: Option<ServerDelay>,
    max_total: Option<Duration>,
    non_idempotent: bool,
    should_retry_header: bool,
    refresh_unauthorized: bool,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self::none()
    }
}

/// What [`RetryPolicy::decide`] looks at.
#[derive(Clone, Copy, Debug)]
pub enum Outcome<'a> {
    /// The server answered.
    Status {
        /// The status.
        status: StatusCode,
        /// The response headers.
        headers: &'a HeaderMap,
    },
    /// The attempt failed without a usable response.
    Failure(FailureClass),
}

/// Facts about the request and the attempt that just finished.
#[derive(Clone, Copy, Debug)]
pub struct Context {
    /// The attempt that just finished, from 1.
    pub attempt: u32,
    /// Whether the request is idempotent.
    pub idempotent: bool,
    /// Whether the body can be sent again.
    pub replayable: bool,
    /// Whether a credential can be refreshed on 401.
    pub refreshable: bool,
    /// Time since the first attempt started.
    pub elapsed: Duration,
}

/// The decision for one finished attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Wait, then send again.
    Retry(Duration),
    /// Return the outcome as it is.
    Stop(StopReason),
}

/// Why no retry happens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopReason {
    /// The outcome is not retried by this policy (including success).
    NotRetryable,
    /// No attempts left.
    Exhausted,
    /// The body cannot be sent again.
    NotReplayable,
    /// The request is not idempotent and the outcome does not prove it was not acted on.
    NotIdempotent,
    /// The wait would pass the total time bound.
    OutOfTime,
    /// The server asked for a wait longer than the policy accepts.
    ServerDelayTooLong,
}

impl RetryPolicy {
    /// A single attempt.
    pub fn none() -> Self {
        Self {
            max_attempts: 1,
            statuses: StatusSet::new(),
            connect: false,
            timeout: false,
            transport: false,
            backoff: Backoff::Fixed(Arc::from([])),
            jitter: Jitter::None,
            server_delay: None,
            max_total: None,
            non_idempotent: false,
            should_retry_header: false,
            refresh_unauthorized: false,
        }
    }

    /// One retry per delay in `delays` (so `delays.len() + 1` attempts), no statuses or failures
    /// retried until added.
    pub fn fixed(delays: &[Duration]) -> Self {
        Self {
            max_attempts: u32::try_from(delays.len()).unwrap_or(u32::MAX - 1) + 1,
            backoff: Backoff::Fixed(Arc::from(delays)),
            ..Self::none()
        }
    }

    /// `max_attempts` attempts with exponential backoff, no statuses or failures retried until
    /// added.
    pub fn exponential(max_attempts: u32, initial: Duration, factor: f64, max: Duration) -> Self {
        Self {
            max_attempts: max_attempts.max(1),
            backoff: Backoff::Exponential {
                initial,
                factor,
                max,
            },
            ..Self::none()
        }
    }

    /// The reference Helix wrapper (`executeHelixRequestWith401Retry`): on 401 the credential is
    /// refreshed and the request sent again after 1 s, 3 s, then 5 s. Nothing else is retried:
    /// the reference has no retry on 429, 5xx or network errors for Helix.
    pub fn twitch_helix() -> Self {
        Self::twitch_helix_with(&[
            Duration::from_secs(1),
            Duration::from_secs(3),
            Duration::from_secs(5),
        ])
    }

    /// [`RetryPolicy::twitch_helix`] with the caller's delays (`retryDelaysMs`); an empty list
    /// means the default delays, as in the reference.
    pub fn twitch_helix_with(delays: &[Duration]) -> Self {
        if delays.is_empty() {
            return Self::twitch_helix();
        }
        Self {
            refresh_unauthorized: true,
            ..Self::fixed(delays)
        }
    }

    /// The reference AI fetch wrapper (`createFetchWithRetry`): network errors, timeouts and
    /// 429/500/502/503/504 are retried after the fixed `delays`, `Retry-After` is ignored, POST
    /// is retried, and the last response is returned.
    pub fn fetch_with_retry(delays: &[Duration]) -> Self {
        Self::fixed(delays)
            .retry_statuses(
                StatusSet::new()
                    .with(429)
                    .with(500)
                    .with(502)
                    .with(503)
                    .with(504),
            )
            .retry_failures(true, true, true)
            .retry_non_idempotent(true)
    }

    /// Sets the statuses that are retried.
    pub fn retry_statuses(mut self, statuses: StatusSet) -> Self {
        self.statuses = statuses;
        self
    }

    /// Which failures are retried: connection failures (never sent), timeouts after the
    /// connection was made, and transport failures (reset, closed early).
    pub fn retry_failures(mut self, connect: bool, timeout: bool, transport: bool) -> Self {
        self.connect = connect;
        self.timeout = timeout;
        self.transport = transport;
        self
    }

    /// Sets the total number of attempts (at least 1).
    pub fn max_attempts(mut self, attempts: u32) -> Self {
        self.max_attempts = attempts.max(1);
        self
    }

    /// The number of attempts allowed.
    pub fn attempts(&self) -> u32 {
        self.max_attempts
    }

    /// Sets the jitter.
    pub fn jitter(mut self, jitter: Jitter) -> Self {
        self.jitter = jitter;
        self
    }

    /// Honours server hints.
    pub fn server_delay(mut self, delay: ServerDelay) -> Self {
        self.server_delay = Some(delay);
        self
    }

    /// Bounds the time from the first attempt to the start of the last.
    pub fn max_total(mut self, total: Duration) -> Self {
        self.max_total = Some(total);
        self
    }

    /// Retries requests that are not idempotent too.
    pub fn retry_non_idempotent(mut self, allow: bool) -> Self {
        self.non_idempotent = allow;
        self
    }

    /// Lets `x-should-retry: true|false` override the status rule (Anthropic-compatible APIs).
    pub fn should_retry_header(mut self, honour: bool) -> Self {
        self.should_retry_header = honour;
        self
    }

    /// On 401, refreshes the request's credential and retries (see
    /// [`crate::Credential`]).
    pub fn refresh_unauthorized(mut self, refresh: bool) -> Self {
        self.refresh_unauthorized = refresh;
        self
    }

    /// Whether a 401 triggers a credential refresh.
    pub fn refreshes_unauthorized(&self) -> bool {
        self.refresh_unauthorized
    }

    /// Whether `status` is one this policy would retry (ignoring attempts and time).
    pub fn retries_status(&self, status: StatusCode) -> bool {
        self.statuses.contains(status.as_u16())
            || (self.refresh_unauthorized && status == StatusCode::UNAUTHORIZED)
    }

    /// Decides what happens after an attempt.
    pub fn decide(
        &self,
        ctx: Context,
        outcome: Outcome<'_>,
        clock: &dyn Clock,
        random: &dyn Random,
    ) -> Decision {
        let (retryable, unprocessed) = match outcome {
            Outcome::Status { status, headers } => {
                let code = status.as_u16();
                let mut retryable = if code == 401 && self.refresh_unauthorized {
                    ctx.refreshable
                } else {
                    self.statuses.contains(code)
                };
                if self.should_retry_header
                    && !status.is_success()
                    && let Some(value) = headers.get("x-should-retry")
                {
                    match value.as_bytes() {
                        b"true" => retryable = true,
                        b"false" => retryable = false,
                        _ => {}
                    }
                }
                (retryable, code == 429 || (code == 401 && self.refresh_unauthorized))
            }
            Outcome::Failure(class) => match class {
                FailureClass::Connect | FailureClass::Timeout(TimeoutKind::Connect) => {
                    (self.connect, true)
                }
                FailureClass::Timeout(
                    TimeoutKind::Headers | TimeoutKind::Total | TimeoutKind::Idle,
                ) => (self.timeout, false),
                FailureClass::Transport => (self.transport, false),
                _ => (false, false),
            },
        };
        if !retryable {
            return Decision::Stop(StopReason::NotRetryable);
        }
        if ctx.attempt >= self.max_attempts {
            return Decision::Stop(StopReason::Exhausted);
        }
        if !ctx.replayable {
            return Decision::Stop(StopReason::NotReplayable);
        }
        if !ctx.idempotent && !self.non_idempotent && !unprocessed {
            return Decision::Stop(StopReason::NotIdempotent);
        }
        let retry = ctx.attempt.saturating_sub(1);
        let backoff = || self.jitter.apply(self.backoff.base(retry), random);
        let hint = match (outcome, &self.server_delay) {
            (Outcome::Status { status, headers }, Some(server)) => server
                .hint(status, headers, clock)
                .map(|hint| (hint, server)),
            _ => None,
        };
        let delay = match hint {
            Some((hint, server)) if hint > server.cap => match server.over_cap {
                OverCap::Clamp => server.cap,
                OverCap::Backoff => backoff(),
                OverCap::Stop => return Decision::Stop(StopReason::ServerDelayTooLong),
            },
            Some((hint, _)) => hint,
            None => backoff(),
        };
        if let Some(total) = self.max_total
            && ctx.elapsed + delay > total
        {
            return Decision::Stop(StopReason::OutOfTime);
        }
        Decision::Retry(delay)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dima_core::{ManualClock, SeededRandom};

    const NOW: i64 = 1_800_000_000_000;

    fn ctx(attempt: u32) -> Context {
        Context {
            attempt,
            idempotent: true,
            replayable: true,
            refreshable: true,
            elapsed: Duration::ZERO,
        }
    }

    fn status(code: u16, headers: &HeaderMap) -> Outcome<'_> {
        Outcome::Status {
            status: StatusCode::from_u16(code).unwrap(),
            headers,
        }
    }

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, value.parse().unwrap());
        }
        map
    }

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn helix_retries_401_three_times_with_the_reference_delays() {
        let policy = RetryPolicy::twitch_helix();
        let clock = ManualClock::new(NOW);
        let random = SeededRandom::new(1);
        let empty = HeaderMap::new();
        let delays: Vec<Decision> = (1..=4)
            .map(|a| policy.decide(ctx(a), status(401, &empty), &clock, &random))
            .collect();
        assert_eq!(
            delays,
            vec![
                Decision::Retry(ms(1000)),
                Decision::Retry(ms(3000)),
                Decision::Retry(ms(5000)),
                Decision::Stop(StopReason::Exhausted)
            ]
        );
        // Nothing else is retried for Helix.
        for code in [429, 500, 503] {
            assert_eq!(
                policy.decide(ctx(1), status(code, &empty), &clock, &random),
                Decision::Stop(StopReason::NotRetryable)
            );
        }
        assert_eq!(
            policy.decide(
                ctx(1),
                Outcome::Failure(FailureClass::Connect),
                &clock,
                &random
            ),
            Decision::Stop(StopReason::NotRetryable)
        );
        // A 401 is retried for POST too: the request was not acted on.
        let post = Context {
            idempotent: false,
            ..ctx(1)
        };
        assert_eq!(
            policy.decide(post, status(401, &empty), &clock, &random),
            Decision::Retry(ms(1000))
        );
        // Without a credential to refresh, a 401 is final.
        let fixed = Context {
            refreshable: false,
            ..ctx(1)
        };
        assert_eq!(
            policy.decide(fixed, status(401, &empty), &clock, &random),
            Decision::Stop(StopReason::NotRetryable)
        );
        // `retryDelaysMs: []` means the defaults.
        assert_eq!(RetryPolicy::twitch_helix_with(&[]), policy);
        assert_eq!(RetryPolicy::twitch_helix_with(&[ms(1), ms(1)]).attempts(), 3);
    }

    #[test]
    fn ratelimit_reset_and_retry_after_set_the_delay() {
        let clock = ManualClock::new(NOW);
        let random = SeededRandom::new(1);
        let policy = RetryPolicy::fixed(&[ms(100)])
            .retry_statuses(StatusSet::new().with(429).with(503))
            .server_delay(ServerDelay {
                ratelimit_reset: true,
                reset_pad: ms(1000),
                ..ServerDelay::retry_after(Duration::from_secs(60))
            });
        // Ratelimit-Reset is an epoch second: 2.5 s from now plus the pad.
        let reset = headers(&[("ratelimit-reset", "1800000002.5")]);
        assert_eq!(
            policy.decide(ctx(1), status(429, &reset), &clock, &random),
            Decision::Retry(ms(3500))
        );
        // A reset in the past waits only the pad.
        let past = headers(&[("ratelimit-reset", "1700000000")]);
        assert_eq!(
            policy.decide(ctx(1), status(429, &past), &clock, &random),
            Decision::Retry(ms(1000))
        );
        // Ratelimit-Reset is ignored on other statuses (Twitch sends it on every answer).
        assert_eq!(
            policy.decide(ctx(1), status(503, &reset), &clock, &random),
            Decision::Retry(ms(100))
        );
        // Retry-After in seconds, decimal seconds, and as an HTTP date.
        let secs = headers(&[("retry-after", "2")]);
        assert_eq!(
            policy.decide(ctx(1), status(503, &secs), &clock, &random),
            Decision::Retry(ms(2000))
        );
        let frac = headers(&[("retry-after", "0.25")]);
        assert_eq!(
            policy.decide(ctx(1), status(503, &frac), &clock, &random),
            Decision::Retry(ms(250))
        );
        let date_clock = ManualClock::new(dima_text::parse_date("Wed, 21 Oct 2026 07:28:00 GMT").unwrap());
        let date = headers(&[("retry-after", "Wed, 21 Oct 2026 07:28:07 GMT")]);
        assert_eq!(
            policy.decide(ctx(1), status(503, &date), &date_clock, &random),
            Decision::Retry(ms(7000))
        );
        // Retry-After wins over Ratelimit-Reset; garbage and negatives are no hint.
        let both = headers(&[("retry-after", "1"), ("ratelimit-reset", "1800000009")]);
        assert_eq!(
            policy.decide(ctx(1), status(429, &both), &clock, &random),
            Decision::Retry(ms(1000))
        );
        for bad in ["", "soon", "-1", "Infinity"] {
            let bad = headers(&[("retry-after", bad)]);
            assert_eq!(
                policy.decide(ctx(1), status(503, &bad), &clock, &random),
                Decision::Retry(ms(100))
            );
        }
        // Over the cap: clamp, back off, or stop.
        let long = headers(&[("retry-after", "120")]);
        assert_eq!(
            policy.decide(ctx(1), status(503, &long), &clock, &random),
            Decision::Retry(Duration::from_secs(60))
        );
        let backoff = policy.clone().server_delay(ServerDelay {
            over_cap: OverCap::Backoff,
            ..ServerDelay::retry_after(Duration::from_secs(60))
        });
        assert_eq!(
            backoff.decide(ctx(1), status(503, &long), &clock, &random),
            Decision::Retry(ms(100))
        );
        let stop = policy.clone().server_delay(ServerDelay {
            over_cap: OverCap::Stop,
            ..ServerDelay::retry_after(Duration::from_secs(60))
        });
        assert_eq!(
            stop.decide(ctx(1), status(503, &long), &clock, &random),
            Decision::Stop(StopReason::ServerDelayTooLong)
        );
    }

    #[test]
    fn idempotency_replay_and_time_bounds() {
        let clock = ManualClock::new(NOW);
        let random = SeededRandom::new(1);
        let empty = HeaderMap::new();
        let policy = RetryPolicy::fixed(&[ms(500), ms(500)])
            .retry_statuses(StatusSet::new().with_range(500, 599).with(429))
            .retry_failures(true, true, true)
            .max_total(Duration::from_secs(1));
        let post = Context {
            idempotent: false,
            ..ctx(1)
        };
        // POST: a 503 or a timeout may have been acted on; a refused connection or a 429 not.
        assert_eq!(
            policy.decide(post, status(503, &empty), &clock, &random),
            Decision::Stop(StopReason::NotIdempotent)
        );
        assert_eq!(
            policy.decide(
                post,
                Outcome::Failure(FailureClass::Timeout(TimeoutKind::Total)),
                &clock,
                &random
            ),
            Decision::Stop(StopReason::NotIdempotent)
        );
        assert_eq!(
            policy.decide(
                post,
                Outcome::Failure(FailureClass::Connect),
                &clock,
                &random
            ),
            Decision::Retry(ms(500))
        );
        assert_eq!(
            policy.decide(post, status(429, &empty), &clock, &random),
            Decision::Retry(ms(500))
        );
        assert_eq!(
            policy
                .clone()
                .retry_non_idempotent(true)
                .decide(post, status(503, &empty), &clock, &random),
            Decision::Retry(ms(500))
        );
        // A streamed body is never sent twice.
        let stream = Context {
            replayable: false,
            ..ctx(1)
        };
        assert_eq!(
            policy.decide(stream, status(503, &empty), &clock, &random),
            Decision::Stop(StopReason::NotReplayable)
        );
        // The total bound.
        let late = Context {
            elapsed: ms(600),
            ..ctx(2)
        };
        assert_eq!(
            policy.decide(late, status(503, &empty), &clock, &random),
            Decision::Stop(StopReason::OutOfTime)
        );
        // Success and other statuses are not retried; queue timeouts never are.
        assert_eq!(
            policy.decide(ctx(1), status(200, &empty), &clock, &random),
            Decision::Stop(StopReason::NotRetryable)
        );
        assert_eq!(
            policy.decide(
                ctx(1),
                Outcome::Failure(FailureClass::Timeout(TimeoutKind::Queue)),
                &clock,
                &random
            ),
            Decision::Stop(StopReason::NotRetryable)
        );
    }

    #[test]
    fn jitter_is_deterministic_under_a_seed() {
        let clock = ManualClock::new(NOW);
        let empty = HeaderMap::new();
        let policy = RetryPolicy::exponential(5, ms(100), 2.0, ms(20_000))
            .retry_statuses(StatusSet::new().with(503))
            .jitter(Jitter::Scale {
                low: 0.0,
                high: 1.0,
            });
        let run = |seed| {
            let random = SeededRandom::new(seed);
            (1..=4)
                .map(|a| policy.decide(ctx(a), status(503, &empty), &clock, &random))
                .collect::<Vec<_>>()
        };
        assert_eq!(run(7), run(7));
        assert_ne!(run(7), run(8));
        for (index, decision) in run(7).into_iter().enumerate() {
            let Decision::Retry(delay) = decision else {
                panic!("expected a retry")
            };
            assert!(delay <= ms(100 << index), "{delay:?}");
        }
    }

    #[test]
    fn exponential_backoff_is_capped() {
        let backoff = Backoff::Exponential {
            initial: ms(500),
            factor: 2.0,
            max: ms(8000),
        };
        let delays: Vec<_> = (0..7).map(|n| backoff.base(n)).collect();
        assert_eq!(
            delays,
            vec![ms(500), ms(1000), ms(2000), ms(4000), ms(8000), ms(8000), ms(8000)]
        );
        assert_eq!(backoff.base(u32::MAX), ms(8000));
    }

    /// The SDK policies the ledger lists, built with this type.
    #[test]
    fn sdk_policies_are_expressible() {
        let clock = ManualClock::new(NOW);
        let random = SeededRandom::new(3);
        let empty = HeaderMap::new();

        // Anthropic-compatible SDK (MiniMax): maxRetries 2.
        let anthropic = RetryPolicy::exponential(3, ms(500), 2.0, ms(8000))
            .retry_statuses(
                StatusSet::new()
                    .with(408)
                    .with(409)
                    .with(429)
                    .with_range(500, 599),
            )
            .retry_failures(true, true, true)
            .retry_non_idempotent(true)
            .jitter(Jitter::Scale {
                low: 0.75,
                high: 1.0,
            })
            .should_retry_header(true)
            .server_delay(ServerDelay {
                retry_after_ms: true,
                over_cap: OverCap::Backoff,
                ..ServerDelay::retry_after(Duration::from_secs(60))
            });
        let hinted = headers(&[("retry-after-ms", "1500")]);
        assert_eq!(
            anthropic.decide(ctx(1), status(429, &hinted), &clock, &random),
            Decision::Retry(ms(1500))
        );
        let no = headers(&[("x-should-retry", "false")]);
        assert_eq!(
            anthropic.decide(ctx(1), status(503, &no), &clock, &random),
            Decision::Stop(StopReason::NotRetryable)
        );
        let yes = headers(&[("x-should-retry", "true")]);
        assert!(matches!(
            anthropic.decide(ctx(1), status(400, &yes), &clock, &random),
            Decision::Retry(d) if d >= ms(375) && d <= ms(500)
        ));
        assert_eq!(
            anthropic.decide(ctx(3), status(503, &empty), &clock, &random),
            Decision::Stop(StopReason::Exhausted)
        );

        // Fish Audio SDK: 1 s doubling ±10 %, capped 60 s, Retry-After honoured.
        let fish = RetryPolicy::exponential(3, ms(1000), 2.0, ms(60_000))
            .retry_statuses(StatusSet::new().with(408).with(429).with_range(500, 599))
            .retry_non_idempotent(true)
            .jitter(Jitter::Scale {
                low: 0.9,
                high: 1.1,
            })
            .server_delay(ServerDelay::retry_after(Duration::from_secs(60)));
        assert!(matches!(
            fish.decide(ctx(2), status(500, &empty), &clock, &random),
            Decision::Retry(d) if d >= ms(1800) && d <= ms(2200)
        ));

        // Polar SDK backoff strategy (unused today: strategy none).
        let polar = RetryPolicy::exponential(u32::MAX, ms(500), 1.5, ms(60_000))
            .retry_statuses(StatusSet::new().with(429).with_range(500, 599))
            .retry_failures(true, false, false)
            .jitter(Jitter::Add(ms(1000)))
            .max_total(Duration::from_secs(3600));
        assert!(matches!(
            polar.decide(ctx(2), status(502, &empty), &clock, &random),
            Decision::Retry(d) if d >= ms(750) && d <= ms(1750)
        ));
        assert_eq!(RetryPolicy::none().attempts(), 1);

        // S3 standard mode: full jitter.
        let s3 = RetryPolicy::exponential(3, ms(100), 2.0, ms(20_000))
            .retry_statuses(
                StatusSet::new()
                    .with(429)
                    .with(500)
                    .with(502)
                    .with(503)
                    .with(504),
            )
            .retry_failures(true, true, true)
            .jitter(Jitter::Scale {
                low: 0.0,
                high: 1.0,
            });
        assert!(matches!(
            s3.decide(ctx(1), status(503, &empty), &clock, &random),
            Decision::Retry(d) if d <= ms(100)
        ));

        // Twitch token refresh: 400 ms, 900 ms on 5xx and network errors, POST.
        let refresh = RetryPolicy::fixed(&[ms(400), ms(900)])
            .retry_statuses(StatusSet::new().with_range(500, 599))
            .retry_failures(true, true, true)
            .retry_non_idempotent(true);
        let post = Context {
            idempotent: false,
            ..ctx(2)
        };
        assert_eq!(
            refresh.decide(post, status(502, &empty), &clock, &random),
            Decision::Retry(ms(900))
        );

        // OpenRouter site agent: 1 s, 3 s on 429/502/503 and network errors; Retry-After ≤ 10 s.
        let site = RetryPolicy::fixed(&[ms(1000), ms(3000)])
            .retry_statuses(StatusSet::new().with(429).with(502).with(503))
            .retry_failures(true, true, true)
            .retry_non_idempotent(true)
            .server_delay(ServerDelay::retry_after(Duration::from_secs(10)));
        let long = headers(&[("retry-after", "30")]);
        assert_eq!(
            site.decide(ctx(1), status(429, &long), &clock, &random),
            Decision::Retry(ms(10_000))
        );

        // The AI fetch wrapper ignores Retry-After and retries POST.
        let ai = RetryPolicy::fetch_with_retry(&[ms(1000), ms(3000), ms(5000)]);
        let post = Context {
            idempotent: false,
            ..ctx(1)
        };
        assert_eq!(
            ai.decide(post, status(429, &long), &clock, &random),
            Decision::Retry(ms(1000))
        );
        assert_eq!(ai.attempts(), 4);
    }

    #[test]
    fn status_set_bounds() {
        let set = StatusSet::new().with(99).with(100).with(599).with(600);
        assert!(set.contains(100) && set.contains(599));
        assert!(!set.contains(99) && !set.contains(600) && !set.contains(200));
        assert_eq!(format!("{set:?}"), "{100, 599}");
    }
}

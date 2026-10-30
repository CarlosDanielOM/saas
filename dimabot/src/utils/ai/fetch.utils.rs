//! Pooled HTTP fetch with the source's retry and header-timeout policy.
use std::{fmt, time::Duration};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RetryOptions {
    pub retries: u32,
    pub delays: Vec<Duration>,
    pub timeout: Duration,
    pub retry_on: Vec<u16>,
}
impl Default for RetryOptions {
    fn default() -> Self {
        Self {
            retries: 3,
            delays: vec![
                Duration::from_millis(1000),
                Duration::from_millis(3000),
                Duration::from_millis(5000),
            ],
            timeout: Duration::from_secs(30),
            retry_on: vec![429, 500, 502, 503, 504],
        }
    }
}
#[derive(Debug)]
pub enum FetchError {
    UncloneableRequest,
    Timeout {
        timeout: Duration,
        attempt: u64,
        total: u64,
    },
    Transport(reqwest::Error),
}
impl fmt::Display for FetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UncloneableRequest => f.write_str("Request body cannot be replayed"),
            Self::Timeout {
                timeout,
                attempt,
                total,
            } => write!(
                f,
                "Request timed out after {}ms (attempt {attempt}/{total})",
                timeout.as_millis()
            ),
            Self::Transport(e) => e.fmt(f),
        }
    }
}
impl std::error::Error for FetchError {}
#[derive(Clone)]
pub struct FetchWithRetry {
    client: reqwest::Client,
    options: RetryOptions,
}
impl FetchWithRetry {
    pub fn new(options: RetryOptions) -> Result<Self, reqwest::Error> {
        #[cfg(any(
            feature = "email",
            feature = "posthog",
            feature = "s3",
            feature = "otel"
        ))]
        crate::utils::install_default_tls_provider();
        Ok(Self {
            client: reqwest::Client::builder()
                .retry(reqwest::retry::never())
                .redirect(reqwest::redirect::Policy::limited(20))
                .build()?,
            options,
        })
    }
    pub fn with_client(client: reqwest::Client, options: RetryOptions) -> Self {
        Self { client, options }
    }
    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }
    pub fn options(&self) -> &RetryOptions {
        &self.options
    }
    /// The timeout ends at response headers. Body consumption occurs outside it.
    /// Dropping this future cancels the active request/backoff and starts no retry.
    pub async fn execute(
        &self,
        request: reqwest::Request,
    ) -> Result<reqwest::Response, FetchError> {
        let mut last = None;
        for attempt in 0..=self.options.retries {
            let next = request.try_clone().ok_or(FetchError::UncloneableRequest)?;
            match tokio::time::timeout(self.options.timeout, self.client.execute(next)).await {
                Ok(Ok(response)) => {
                    if attempt == self.options.retries
                        || !self.options.retry_on.contains(&response.status().as_u16())
                    {
                        return Ok(response);
                    }
                    drop(response);
                }
                Ok(Err(error)) => last = Some(FetchError::Transport(error)),
                Err(_) => {
                    last = Some(FetchError::Timeout {
                        timeout: self.options.timeout,
                        attempt: u64::from(attempt) + 1,
                        total: u64::from(self.options.retries) + 1,
                    })
                }
            }
            if attempt < self.options.retries {
                let delay = self
                    .options
                    .delays
                    .get(attempt as usize)
                    .or_else(|| self.options.delays.last())
                    .copied()
                    .unwrap_or_default();
                tokio::time::sleep(delay).await;
            }
        }
        Err(last.expect("final attempt is an error or returns a response"))
    }
}
pub fn create_fetch_with_retry(options: RetryOptions) -> Result<FetchWithRetry, reqwest::Error> {
    FetchWithRetry::new(options)
}

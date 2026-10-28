//! Shared HTTP behavior for native TTS providers.
use reqwest::{Client, Response};
use tokio::sync::watch;

pub(crate) fn new_client() -> Client {
    #[cfg(any(
        feature = "email",
        feature = "posthog",
        feature = "s3",
        feature = "otel"
    ))]
    crate::utils::install_default_tls_provider();
    Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let scheme_only_origin_change = attempt.previous().last().is_some_and(|previous| {
                previous.scheme() != attempt.url().scheme()
                    && previous.host_str() == attempt.url().host_str()
                    && previous.port_or_known_default() == attempt.url().port_or_known_default()
            });
            if scheme_only_origin_change {
                attempt.stop()
            } else {
                reqwest::redirect::Policy::limited(20).redirect(attempt)
            }
        }))
        .referer(false)
        .build()
        .expect("TTS HTTP client configuration is valid")
}

pub(crate) fn abort_reason(signal: &Option<watch::Receiver<Option<String>>>) -> Option<String> {
    signal.as_ref().and_then(|signal| signal.borrow().clone())
}

pub(crate) async fn cancellation(signal: &mut Option<watch::Receiver<Option<String>>>) {
    if let Some(signal) = signal {
        loop {
            if signal.borrow().is_some() {
                return;
            }
            if signal.changed().await.is_err() {
                break;
            }
        }
    }
    std::future::pending::<()>().await;
}

pub(crate) async fn read_audio(
    response: &mut Response,
    max_bytes: Option<usize>,
) -> Result<Vec<u8>, String> {
    let mut result = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(transport_error)? {
        if chunk.len() > max_bytes.unwrap_or(usize::MAX).saturating_sub(result.len()) {
            return Err("TTS audio exceeds byte limit".into());
        }
        result.extend_from_slice(&chunk);
    }
    Ok(result)
}

pub(crate) fn transport_error(error: reqwest::Error) -> String {
    error.without_url().to_string()
}

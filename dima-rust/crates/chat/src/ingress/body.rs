//! Reading the raw body under a byte limit and a deadline, before anything is parsed: the
//! signature is over these exact bytes.
//!
//! A declared `Content-Length` above the limit is refused before a byte is read; a body without
//! one (chunked) is refused as soon as it passes the limit. Nothing is drained after a refusal:
//! the answer carries `Connection: close` and the connection ends (body-parser read and
//! discarded the rest; here an oversized body costs the sender, not the server). So at most
//! `limit` bytes of an unverified body are ever held, per request in flight.

use bytes::{Bytes, BytesMut};
use http_body_util::BodyExt as _;
use std::time::Duration;

/// Why the body could not be read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BodyError {
    /// Over the limit (declared or sent): 413, as body-parser answers.
    TooLarge,
    /// The sender stopped or broke the connection: 400 (`request aborted`).
    Aborted,
    /// Not complete within the deadline: 408.
    TimedOut,
}

/// `typeis.hasBody` aside, a request without a body reads as no bytes.
pub async fn read(
    body: Option<dima_web::Body>,
    declared_length: Option<&str>,
    limit: usize,
    deadline: Duration,
) -> Result<Bytes, BodyError> {
    if let Some(declared) = declared_length {
        match declared.trim().parse::<u64>() {
            Ok(length) if length > limit as u64 => return Err(BodyError::TooLarge),
            Ok(_) => {}
            // hyper refuses a malformed `Content-Length` before the handler runs; anything that
            // gets here is read under the limit like a chunked body.
            Err(_) => {}
        }
    }
    let Some(mut body) = body else {
        return Ok(Bytes::new());
    };
    let collect = async move {
        let mut collected = BytesMut::new();
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|_| BodyError::Aborted)?;
            let Ok(data) = frame.into_data() else {
                continue;
            };
            if collected.len().saturating_add(data.len()) > limit {
                return Err(BodyError::TooLarge);
            }
            collected.extend_from_slice(&data);
        }
        Ok(collected.freeze())
    };
    tokio::time::timeout(deadline, collect)
        .await
        .unwrap_or(Err(BodyError::TimedOut))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(bytes: &'static [u8]) -> Option<dima_web::Body> {
        Some(dima_web::Body::from(bytes))
    }

    #[tokio::test]
    async fn bodies_up_to_the_limit_are_read() {
        let read_back = read(body(b"0123456789"), Some("10"), 10, Duration::from_secs(1)).await;
        assert_eq!(read_back, Ok(Bytes::from_static(b"0123456789")));
        assert_eq!(
            read(None, None, 10, Duration::from_secs(1)).await,
            Ok(Bytes::new())
        );
    }

    #[tokio::test]
    async fn bodies_over_the_limit_are_refused() {
        assert_eq!(
            read(body(b"0123456789"), Some("11"), 10, Duration::from_secs(1)).await,
            Err(BodyError::TooLarge)
        );
        // Without a declared length (chunked), at the first byte past the limit.
        assert_eq!(
            read(body(b"01234567890"), None, 10, Duration::from_secs(1)).await,
            Err(BodyError::TooLarge)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_body_that_never_ends_times_out() {
        let (_sender, never) =
            tokio::sync::mpsc::channel::<Result<hyper::body::Frame<Bytes>, std::io::Error>>(1);
        let stream = http_body_util::StreamBody::new(tokio_stream_from(never));
        let result = read(
            Some(dima_web::Body::new(stream)),
            None,
            10,
            Duration::from_secs(10),
        )
        .await;
        assert_eq!(result, Err(BodyError::TimedOut));
    }

    fn tokio_stream_from<T: Send + 'static>(
        mut receiver: tokio::sync::mpsc::Receiver<T>,
    ) -> impl futures_util::Stream<Item = T> {
        futures_util::stream::poll_fn(move |cx| receiver.poll_recv(cx))
    }
}

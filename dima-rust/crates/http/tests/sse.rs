//! Event streams over the network: framing across chunk boundaries, limits, idle timeout,
//! cancellation by drop and by shutdown.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use bytes::Bytes;
use dima_core::Shutdown;
use dima_http::testing::{MockResponse, MockServer};
use dima_http::{Error, HttpClient, Provider, SseEvent, TimeoutKind};
use std::time::Duration;

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

async fn setup() -> (MockServer, HttpClient, Provider, Shutdown) {
    let server = MockServer::start().await.unwrap();
    let shutdown = Shutdown::new();
    let client = HttpClient::builder()
        .shutdown(shutdown.clone())
        .build()
        .unwrap();
    let provider = server
        .provider(Provider::builder(
            "openrouter",
            "https://openrouter.ai/api/v1",
        ))
        .unwrap();
    (server, client, provider, shutdown)
}

async fn collect(stream: &mut dima_http::SseStream) -> (Vec<SseEvent>, Option<Error>) {
    let mut events = Vec::new();
    while let Some(event) = stream.next_event().await {
        match event {
            Ok(event) => events.push(event),
            Err(error) => return (events, Some(error)),
        }
    }
    (events, None)
}

#[tokio::test]
async fn events_split_across_network_chunks() {
    let (server, client, provider, _) = setup().await;
    let text = "\u{feff}: OPENROUTER PROCESSING\r\n\r\nid: 1\r\nevent: delta\r\ndata: {\"t\":\"hé\r\ndata: llo 👋\"}\r\n\r\ndata: [DONE]\r\n\r\nretry: 1500\r\ndata: tail without end";
    // Every 3 bytes in its own chunk: CRLF pairs and UTF-8 sequences are split.
    let chunks: Vec<(Duration, Bytes)> = text
        .as_bytes()
        .chunks(3)
        .map(|c| (Duration::ZERO, Bytes::copy_from_slice(c)))
        .collect();
    server.push(
        MockResponse::new(200)
            .header("content-type", "text/event-stream")
            .chunks(chunks),
    );
    let mut stream = client
        .post(&provider, "/chat/completions")
        .send()
        .await
        .unwrap()
        .sse();
    assert_eq!(stream.response().status().as_u16(), 200);
    let (events, error) = collect(&mut stream).await;
    assert!(error.is_none(), "{error:?}");
    let event = |event: &str, data: &str| SseEvent {
        event: event.into(),
        data: data.into(),
        id: "1".into(),
    };
    // The unterminated last event is discarded.
    assert_eq!(
        events,
        [
            event("delta", "{\"t\":\"hé\nllo 👋\"}"),
            event("message", "[DONE]")
        ]
    );
    assert_eq!(stream.retry(), Some(1500));
    assert_eq!(stream.last_event_id(), "1");
}

#[tokio::test]
async fn idle_timeout_between_events() {
    let (server, client, provider, _) = setup().await;
    server.push(
        MockResponse::sse(&["data: a\n\n", "data: b\n\n"], ms(10)).chunks(vec![
            (Duration::ZERO, Bytes::from_static(b"data: a\n\n")),
            (ms(2000), Bytes::from_static(b"data: b\n\n")),
        ]),
    );
    let mut stream = client
        .post(&provider, "/chat/completions")
        .idle_timeout(ms(200))
        .send()
        .await
        .unwrap()
        .sse();
    let (events, error) = collect(&mut stream).await;
    assert_eq!(events.len(), 1);
    assert!(
        matches!(
            error,
            Some(Error::Timeout {
                kind: TimeoutKind::Idle,
                ..
            })
        ),
        "{error:?}"
    );
    // Comments keep a stream alive: a keep-alive every 100 ms beats a 200 ms idle timeout.
    server.push(
        MockResponse::new(200).chunks(
            (0..5)
                .map(|_| (ms(100), Bytes::from_static(b": ping\n\n")))
                .chain([(ms(100), Bytes::from_static(b"data: end\n\n"))])
                .collect(),
        ),
    );
    let mut stream = client
        .post(&provider, "/chat/completions")
        .idle_timeout(ms(200))
        .send()
        .await
        .unwrap()
        .sse();
    let (events, error) = collect(&mut stream).await;
    assert!(error.is_none(), "{error:?}");
    assert_eq!(events.len(), 1);
}

#[tokio::test]
async fn total_size_limit_bounds_the_stream() {
    let (server, client, provider, _) = setup().await;
    server.push(
        MockResponse::new(200).chunks(
            (0..50)
                .map(|_| (Duration::ZERO, Bytes::from_static(b"data: 0123456789\n\n")))
                .collect(),
        ),
    );
    let mut stream = client
        .post(&provider, "/chat/completions")
        .max_bytes(100)
        .send()
        .await
        .unwrap()
        .sse();
    let (events, error) = collect(&mut stream).await;
    assert!(events.len() <= 6, "{}", events.len());
    assert!(
        matches!(error, Some(Error::BodyTooLarge { limit: 100, .. })),
        "{error:?}"
    );
    // A single endless line without a line end is bounded the same way.
    server.push(
        MockResponse::new(200).chunks(
            (0..50)
                .map(|_| {
                    (
                        Duration::ZERO,
                        Bytes::from_static(b"data: xxxxxxxxxxxxxxxxxx"),
                    )
                })
                .collect(),
        ),
    );
    let mut stream = client
        .post(&provider, "/chat/completions")
        .max_bytes(100)
        .send()
        .await
        .unwrap()
        .sse();
    let (events, error) = collect(&mut stream).await;
    assert!(events.is_empty());
    assert!(
        matches!(error, Some(Error::BodyTooLarge { .. })),
        "{error:?}"
    );
}

#[tokio::test]
async fn dropping_the_stream_closes_the_connection() {
    let (server, client, provider, _) = setup().await;
    server.push(
        MockResponse::new(200).chunks(
            (0..200)
                .map(|_| (ms(20), Bytes::from_static(b"data: x\n\n")))
                .collect(),
        ),
    );
    let mut stream = client
        .post(&provider, "/chat/completions")
        .send()
        .await
        .unwrap()
        .sse();
    assert!(stream.next_event().await.unwrap().is_ok());
    drop(stream);
    // The server notices the closed connection: its next write fails and the mock moves on;
    // a new request is served at once.
    server.push(MockResponse::new(200).body("data: next\n\n"));
    let mut stream = client
        .post(&provider, "/chat/completions")
        .send()
        .await
        .unwrap()
        .sse();
    assert_eq!(stream.next_event().await.unwrap().unwrap().data, "next");
}

#[tokio::test]
async fn shutdown_ends_a_stream() {
    let (server, client, provider, shutdown) = setup().await;
    server.push(MockResponse::new(200).chunks(vec![
        (Duration::ZERO, Bytes::from_static(b"data: a\n\n")),
        (ms(5000), Bytes::from_static(b"data: b\n\n")),
    ]));
    let mut stream = client
        .post(&provider, "/chat/completions")
        .send()
        .await
        .unwrap()
        .sse();
    assert!(stream.next_event().await.unwrap().is_ok());
    let trigger = shutdown.clone();
    tokio::spawn(async move {
        tokio::time::sleep(ms(100)).await;
        trigger.trigger();
    });
    let error = stream.next_event().await.unwrap().unwrap_err();
    assert!(matches!(error, Error::Cancelled { .. }), "{error:?}");
}

/// One network chunk holding thousands of events does not trip the queue bound: the stream
/// feeds the decoder in pieces and takes events out between them. Custom limits are enforced
/// as a decode error.
#[tokio::test]
async fn decoder_limits_hold_over_the_network() {
    let (server, client, provider, _) = setup().await;
    server.push(MockResponse::new(200).body("data:x\n\n".repeat(2000)));
    let mut stream = client
        .post(&provider, "/chat/completions")
        .send()
        .await
        .unwrap()
        .sse();
    let (events, error) = collect(&mut stream).await;
    assert!(error.is_none(), "{error:?}");
    assert_eq!(events.len(), 2000);

    server.push(MockResponse::new(200).body(format!("data: {}\n\n", "y".repeat(64))));
    let mut stream = client
        .post(&provider, "/chat/completions")
        .send()
        .await
        .unwrap()
        .sse_with_limits(dima_http::SseLimits {
            max_line: 32,
            ..dima_http::SseLimits::default()
        });
    let (events, error) = collect(&mut stream).await;
    assert!(events.is_empty());
    assert!(
        matches!(
            error,
            Some(Error::Decode {
                category: dima_http::DecodeCategory::EventStream,
                ..
            })
        ),
        "{error:?}"
    );
    assert!(stream.next_event().await.is_none());
}

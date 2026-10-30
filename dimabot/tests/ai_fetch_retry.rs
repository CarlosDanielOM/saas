#![cfg(feature = "ai-embeddings")]
#[path = "../src/utils/test_http.rs"]
mod test_http;
use dima_rust::utils::ai_fetch_retry::{FetchError, FetchWithRetry, RetryOptions};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use test_http::{CannedResponse, Recorder};
#[tokio::test]
async fn retries_retryable_status_and_stops_on_terminal_response() {
    let count = Arc::new(AtomicUsize::new(0));
    let seen = count.clone();
    let recorder = Recorder::start(move |_| {
        let n = seen.fetch_add(1, Ordering::SeqCst);
        CannedResponse::json(if n < 2 { 500 } else { 400 }, "fixture")
    });
    let fetch = FetchWithRetry::new(RetryOptions {
        retries: 3,
        delays: vec![Duration::from_millis(12), Duration::from_millis(20)],
        timeout: Duration::from_secs(1),
        ..Default::default()
    })
    .unwrap();
    let request = fetch.client().get(&recorder.base_url).build().unwrap();
    let start = Instant::now();
    let response = fetch.execute(request).await.unwrap();
    assert_eq!(response.status().as_u16(), 400);
    assert_eq!(count.load(Ordering::SeqCst), 3);
    assert!(start.elapsed() >= Duration::from_millis(32));
}
#[tokio::test]
async fn exhausted_transport_and_header_timeout_are_returned() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let fetch = FetchWithRetry::new(RetryOptions {
        retries: 1,
        delays: vec![Duration::ZERO],
        timeout: Duration::from_millis(50),
        ..Default::default()
    })
    .unwrap();
    let request = fetch.client().get(url).build().unwrap();
    assert!(matches!(
        fetch.execute(request).await,
        Err(FetchError::Transport(_))
    ));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (_stream, _) = listener.accept().unwrap();
        std::thread::sleep(Duration::from_millis(100));
    });
    let fetch = FetchWithRetry::new(RetryOptions {
        retries: 0,
        timeout: Duration::from_millis(20),
        ..Default::default()
    })
    .unwrap();
    let request = fetch.client().get(url).build().unwrap();
    assert!(matches!(
        fetch.execute(request).await,
        Err(FetchError::Timeout {
            attempt: 1,
            total: 1,
            ..
        })
    ));
    server.join().unwrap();
}
#[tokio::test]
async fn timeout_ends_after_headers_not_during_body_read() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        use std::io::{BufRead, BufReader, Write};
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        loop {
            let mut line = String::new();
            assert_ne!(reader.read_line(&mut line).unwrap(), 0);
            if line == "\r\n" {
                break;
            }
        }
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n")
            .unwrap();
        stream.flush().unwrap();
        std::thread::sleep(Duration::from_millis(90));
        stream.write_all(b"ok").unwrap();
    });
    let fetch = FetchWithRetry::new(RetryOptions {
        retries: 0,
        timeout: Duration::from_millis(40),
        ..Default::default()
    })
    .unwrap();
    let response = fetch
        .execute(fetch.client().get(url).build().unwrap())
        .await
        .unwrap();
    assert_eq!(response.text().await.unwrap(), "ok");
    server.join().unwrap();
}
#[tokio::test]
async fn dropping_pending_retry_stops_future_attempts() {
    let count = Arc::new(AtomicUsize::new(0));
    let seen = count.clone();
    let recorder = Recorder::start(move |_| {
        seen.fetch_add(1, Ordering::SeqCst);
        CannedResponse::json(503, "retry")
    });
    let fetch = FetchWithRetry::new(RetryOptions {
        retries: 3,
        delays: vec![Duration::from_millis(250)],
        timeout: Duration::from_secs(1),
        ..Default::default()
    })
    .unwrap();
    let request = fetch.client().get(&recorder.base_url).build().unwrap();
    let task = tokio::spawn(async move { fetch.execute(request).await });
    for _ in 0..100 {
        if count.load(Ordering::SeqCst) > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert_eq!(count.load(Ordering::SeqCst), 1);
    task.abort();
    let _ = task.await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(count.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn retry_exhaustion_returns_fourth_http_response() {
    let count = Arc::new(AtomicUsize::new(0));
    let seen = count.clone();
    let recorder = Recorder::start(move |_| {
        seen.fetch_add(1, Ordering::SeqCst);
        CannedResponse::json(429, "rate limit")
    });
    let fetch = FetchWithRetry::new(RetryOptions {
        retries: 3,
        delays: vec![Duration::ZERO],
        timeout: Duration::from_secs(1),
        ..Default::default()
    })
    .unwrap();
    let response = fetch
        .execute(fetch.client().get(&recorder.base_url).build().unwrap())
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 429);
    assert_eq!(response.text().await.unwrap(), "rate limit");
    assert_eq!(count.load(Ordering::SeqCst), 4);
}

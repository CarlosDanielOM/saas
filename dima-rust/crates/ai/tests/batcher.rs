use dima_ai::{
    batcher::*,
    embeddings,
    qdrant::{ChatEmbeddingQueue, QueuedChatMessage},
};
use dima_core::Shutdown;
use dima_http::{
    HttpClient,
    testing::{MockResponse, MockServer},
};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
#[derive(Default)]
struct Storage {
    attempts: AtomicUsize,
    dropped: AtomicUsize,
}
impl Sink for Storage {
    fn store<'a>(
        &'a self,
        m: &'a [QueuedChatMessage],
        v: Vec<Vec<f64>>,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            assert_eq!(m.len(), v.len());
            if self.attempts.fetch_add(1, Ordering::SeqCst) < 2 {
                Err("retry".into())
            } else {
                Ok(())
            }
        })
    }
    fn dropped(&self, n: usize) {
        self.dropped.fetch_add(n, Ordering::SeqCst);
    }
}
fn message() -> QueuedChatMessage {
    QueuedChatMessage {
        text: "hello".into(),
        channel_id: "c".into(),
        channel_name: None,
        username: "u".into(),
        user_id: "u".into(),
        timestamp: 1.0,
        language: None,
    }
}
#[tokio::test]
async fn bounded_queue_and_storage_retry() -> anyhow::Result<()> {
    let server = MockServer::start().await?;
    let cfg = embeddings::Config::lfm2();
    let provider = server.provider(cfg.builder(embeddings::Service::Lfm2))?;
    let client = Arc::new(embeddings::Client {
        http: HttpClient::builder().build()?,
        provider,
        service: embeddings::Service::Lfm2,
    });
    let sink = Arc::new(Storage::default());
    let (queue, batcher) = bounded(client.clone(), sink.clone());
    for _ in 0..2000 {
        assert!(queue.add_message(message()));
    }
    assert!(!queue.add_message(message()));
    assert_eq!(sink.dropped.load(Ordering::SeqCst), 1);
    drop(batcher);
    drop(queue);
    let (queue, batcher) = bounded(client, sink.clone());
    let cancel = Shutdown::new();
    for _ in 0..3 {
        server.push(MockResponse::json(
            200,
            r#"{"data":[{"embedding":[1],"index":0}]}"#,
        ));
    }
    assert!(queue.add_message(message()));
    drop(queue);
    tokio::time::timeout(Duration::from_secs(10), batcher.run(&cancel)).await?;
    assert_eq!(sink.attempts.load(Ordering::SeqCst), 3);
    assert_eq!(server.requests().len(), 3);
    Ok(())
}

mod support;
#[derive(Default)]
struct RejectAll {
    attempts: AtomicUsize,
    dropped: AtomicUsize,
}
impl Sink for RejectAll {
    fn store<'a>(
        &'a self,
        _: &'a [QueuedChatMessage],
        _: Vec<Vec<f64>>,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err("one item rejected".into()) })
    }
    fn dropped(&self, n: usize) {
        self.dropped.fetch_add(n, Ordering::SeqCst);
    }
}
#[tokio::test]
async fn partial_batch_failure_retries_whole_batch_then_drops_with_reference_waits()
-> anyhow::Result<()> {
    for embedding_failure in [false, true] {
        let server = MockServer::start().await?;
        let times = Arc::new(std::sync::Mutex::new(Vec::new()));
        let capture = times.clone();
        server.fallback(move |_| {
            capture.lock().unwrap().push(tokio::time::Instant::now());
            MockResponse::json(
                200,
                if embedding_failure {
                    r#"{"data":[{"index":0,"embedding":[1]}]}"#
                } else {
                    r#"{"data":[{"index":0,"embedding":[1]},{"index":1,"embedding":[2]}]}"#
                },
            )
        });
        let mut cfg = embeddings::Config::lfm2();
        cfg.retries = 0;
        let client = Arc::new(embeddings::Client {
            http: HttpClient::builder().build()?,
            provider: server.provider(cfg.builder(embeddings::Service::Lfm2))?,
            service: embeddings::Service::Lfm2,
        });
        let sink = Arc::new(RejectAll::default());
        let (queue, batcher) = bounded(client, sink.clone());
        assert!(queue.add_message(message()));
        assert!(queue.add_message(message()));
        drop(queue);
        support::virtual_time(batcher.run(&Shutdown::new())).await;
        assert_eq!(server.requests().len(), 3);
        assert_eq!(sink.dropped.load(Ordering::SeqCst), 2);
        assert_eq!(
            sink.attempts.load(Ordering::SeqCst),
            if embedding_failure { 0 } else { 3 }
        );
        for (pair, seconds) in times.lock().unwrap().windows(2).zip([1, 2]) {
            assert!(pair[1] - pair[0] >= Duration::from_secs(seconds));
            assert!(pair[1] - pair[0] < Duration::from_millis(seconds * 1000 + 200));
        }
    }
    Ok(())
}
#[tokio::test]
async fn shutdown_during_inflight_embedding_discards_owned_batch() -> anyhow::Result<()> {
    let server = MockServer::start().await?;
    server.push(MockResponse::new(200).delay(Duration::from_secs(30)));
    let cfg = embeddings::Config::lfm2();
    let client = Arc::new(embeddings::Client {
        http: HttpClient::builder().build()?,
        provider: server.provider(cfg.builder(embeddings::Service::Lfm2))?,
        service: embeddings::Service::Lfm2,
    });
    let sink = Arc::new(RejectAll::default());
    let (queue, batcher) = bounded(client, sink.clone());
    assert!(queue.add_message(message()));
    drop(queue);
    let cancel = Shutdown::new();
    let owned = cancel.clone();
    let work = tokio::spawn(async move { batcher.run(&owned).await });
    server.wait_for(1).await;
    cancel.trigger();
    tokio::time::timeout(Duration::from_secs(1), work).await??;
    assert_eq!(server.requests().len(), 1);
    assert_eq!(sink.dropped.load(Ordering::SeqCst), 1);
    assert_eq!(sink.attempts.load(Ordering::SeqCst), 0);
    Ok(())
}

#[tokio::test]
async fn interval_flush_and_cancellation_during_retry_wait() -> anyhow::Result<()> {
    let server = MockServer::start().await?;
    server.push(MockResponse::json(200, r#"{"error":{"message":"bad"}}"#));
    let cfg = embeddings::Config::lfm2();
    let client = Arc::new(embeddings::Client {
        http: HttpClient::builder().build()?,
        provider: server.provider(cfg.builder(embeddings::Service::Lfm2))?,
        service: embeddings::Service::Lfm2,
    });
    let sink = Arc::new(RejectAll::default());
    let (queue, batcher) = bounded(client, sink.clone());
    assert!(queue.add_message(message()));
    let cancel = Shutdown::new();
    let start = tokio::time::Instant::now();
    let watchdog = async {
        server.wait_for(1).await;
        assert!(start.elapsed() >= Duration::from_millis(350));
        tokio::time::sleep(Duration::from_millis(100)).await;
        cancel.trigger();
    };
    support::virtual_time(async {
        tokio::join!(batcher.run(&cancel), watchdog);
    })
    .await;
    drop(queue);
    assert_eq!(server.requests().len(), 1);
    assert_eq!(sink.dropped.load(Ordering::SeqCst), 1);
    Ok(())
}

#[derive(Default)]
struct HungStorage {
    attempts: AtomicUsize,
    dropped: AtomicUsize,
}
impl Sink for HungStorage {
    fn store<'a>(
        &'a self,
        _: &'a [QueuedChatMessage],
        _: Vec<Vec<f64>>,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        Box::pin(std::future::pending())
    }
    fn dropped(&self, n: usize) {
        self.dropped.fetch_add(n, Ordering::SeqCst);
    }
}
#[tokio::test]
async fn sink_deadline_reembeds_then_drops_after_three_attempts() -> anyhow::Result<()> {
    let server = MockServer::start().await?;
    server.fallback(|_| MockResponse::json(200, r#"{"data":[{"index":0,"embedding":[1]}]}"#));
    let cfg = embeddings::Config::lfm2();
    let client = Arc::new(embeddings::Client {
        http: HttpClient::builder().build()?,
        provider: server.provider(cfg.builder(embeddings::Service::Lfm2))?,
        service: embeddings::Service::Lfm2,
    });
    let sink = Arc::new(HungStorage::default());
    let (queue, batcher) = bounded(client, sink.clone());
    assert!(queue.add_message(message()));
    drop(queue);
    support::virtual_time(batcher.run(&Shutdown::new())).await;
    assert_eq!(server.requests().len(), 3);
    assert_eq!(sink.attempts.load(Ordering::SeqCst), 3);
    assert_eq!(sink.dropped.load(Ordering::SeqCst), 1);
    Ok(())
}

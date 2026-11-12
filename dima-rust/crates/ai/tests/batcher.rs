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

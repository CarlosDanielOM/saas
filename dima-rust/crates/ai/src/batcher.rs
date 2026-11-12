//! Owned bounded embedding batching. The integration layer runs `run` as a supervised
//! task and implements the batch sink (Qdrant write and language detection).
//!
//! Reference cadence: flush at 500 entries or after 350ms, 3 total attempts with
//! 1s then 2s waits, including re-embedding after a storage failure. A failed batch is
//! dropped and reported. Added bound: 2000 queued entries; overflow is refused and
//! reported. The reference drains its entire unbounded queue, so bursts >500 are
//! deliberately split into bounded batches. A sink call gets a 120s deadline.
use crate::{
    embeddings::{Client, Kind},
    qdrant::{ChatEmbeddingQueue, QueuedChatMessage},
};
use dima_core::Shutdown;
use std::{future::Future, pin::Pin, sync::Arc, time::Duration};
use tokio::sync::mpsc;
pub trait Sink: Send + Sync {
    fn store<'a>(
        &'a self,
        messages: &'a [QueuedChatMessage],
        vectors: Vec<Vec<f64>>,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;
    fn dropped(&self, _count: usize) {}
}
pub struct Queue {
    sender: mpsc::Sender<QueuedChatMessage>,
    sink: Arc<dyn Sink>,
}
impl ChatEmbeddingQueue for Queue {
    fn add_message(&self, message: QueuedChatMessage) -> bool {
        if self.sender.try_send(message).is_ok() {
            true
        } else {
            self.sink.dropped(1);
            false
        }
    }
}
pub struct Batcher {
    receiver: mpsc::Receiver<QueuedChatMessage>,
    client: Arc<Client>,
    sink: Arc<dyn Sink>,
}
pub fn bounded(client: Arc<Client>, sink: Arc<dyn Sink>) -> (Queue, Batcher) {
    let (sender, receiver) = mpsc::channel(2000);
    (
        Queue {
            sender,
            sink: sink.clone(),
        },
        Batcher {
            receiver,
            client,
            sink,
        },
    )
}
impl Batcher {
    pub async fn run(mut self, cancel: &Shutdown) {
        loop {
            let first = tokio::select! {_=cancel.wait()=>return,m=self.receiver.recv()=>match m{Some(m)=>m,None=>return}};
            let mut batch = vec![first];
            let timer = tokio::time::sleep(Duration::from_millis(350));
            tokio::pin!(timer);
            while batch.len() < 500 {
                tokio::select! {_=cancel.wait()=>{self.sink.dropped(batch.len()+self.receiver.len());return;},_=&mut timer=>break,m=self.receiver.recv()=>match m{Some(m)=>batch.push(m),None=>break}}
            }
            let texts: Vec<_> = batch.iter().map(|m| m.text.clone()).collect();
            let mut success = false;
            for attempt in 0..3 {
                if attempt > 0 {
                    tokio::select! {_=cancel.wait()=>{self.sink.dropped(batch.len()+self.receiver.len());return;},_=tokio::time::sleep(Duration::from_secs(attempt))=>{}}
                }
                let work = async {
                    let embeddings = self
                        .client
                        .generate_embeddings(&texts, "lfm2.5-embedding-350m", Kind::Document, None)
                        .await;
                    if let Some(vectors) = embeddings.embeddings.filter(|_| !embeddings.error) {
                        matches!(
                            tokio::time::timeout(
                                Duration::from_secs(120),
                                self.sink.store(&batch, vectors)
                            )
                            .await,
                            Ok(Ok(()))
                        )
                    } else {
                        false
                    }
                };
                success = tokio::select! {_=cancel.wait()=>{self.sink.dropped(batch.len()+self.receiver.len());return;},success=work=>success};
                if success {
                    break;
                }
            }
            if !success {
                self.sink.dropped(batch.len());
            }
        }
    }
}

//! Optional bounded adapter for synchronous bot producers. Startup owns `FeedWorker::run`;
//! nothing is spawned by the library. Eight ordered shards prevent one cold channel from
//! holding all channels. Queue time is part of the two-second publication deadline.
use super::{FeedError, FeedMessage, FeedPublisher, PublishResult, model};
use crate::duel::model::DuelRun;
use crate::duel::{DuelEvents, DuelPhase};
use dima_core::{Clock, Shutdown};
use serde_json::json;
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};
enum Command {
    Publish {
        message: FeedMessage,
        reply: oneshot::Sender<PublishResult>,
        expires: tokio::time::Instant,
    },
    Flush(oneshot::Sender<()>),
}
/// A bot's immediate enqueue result can be observed without making its chat path fallible.
pub struct PublishReceipt {
    receiver: oneshot::Receiver<PublishResult>,
    expires: tokio::time::Instant,
}
impl PublishReceipt {
    /// The worker's typed result, or `Failed(widget_feed_stopped)` if the owner shut down.
    pub async fn wait(self) -> PublishResult {
        match tokio::time::timeout_at(self.expires, self.receiver).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => PublishResult::Failed(FeedError("widget_feed_stopped")),
            Err(_) => PublishResult::Failed(FeedError("widget_feed_deadline")),
        }
    }
}
/// Cloneable synchronous adapter: eight queues of 64 entries, at most 64/channel.
#[derive(Clone)]
pub struct FeedOutbox {
    senders: Vec<mpsc::Sender<Command>>,
    clock: Arc<dyn Clock>,
    dropped: Arc<AtomicU64>,
}
/// Owned by startup; dropping or cancelling `run` drops queued receipts and all work.
pub struct FeedWorker {
    queues: Vec<mpsc::Receiver<Command>>,
    publisher: FeedPublisher,
    dropped: Arc<AtomicU64>,
}
impl FeedOutbox {
    /// Build the adapter and its unstarted worker. The caller runs/joins the worker under Shutdown.
    pub fn new(publisher: FeedPublisher, clock: Arc<dyn Clock>) -> (Self, FeedWorker) {
        let mut senders = Vec::new();
        let mut queues = Vec::new();
        for _ in 0..8 {
            let (tx, rx) = mpsc::channel(64);
            senders.push(tx);
            queues.push(rx);
        }
        let dropped = Arc::new(AtomicU64::new(0));
        (
            Self {
                senders,
                clock,
                dropped: dropped.clone(),
            },
            FeedWorker {
                queues,
                publisher,
                dropped,
            },
        )
    }
    fn shard(c: &str) -> usize {
        c.bytes()
            .fold(0usize, |n, b| n.wrapping_mul(31).wrapping_add(b as usize))
            % 8
    }
    /// Enqueue immediately or return an explicit overload/closed result. Metadata is bounded
    /// before queueing; callers may ignore the receipt for the reference's fire-and-forget behavior.
    pub fn submit(&self, message: FeedMessage) -> Result<PublishReceipt, FeedError> {
        model::validate_message(&message)?;
        let shard = Self::shard(&message.channel);
        let (tx, rx) = oneshot::channel();
        let expires = tokio::time::Instant::now() + Duration::from_secs(2);
        let command = Command::Publish {
            message,
            reply: tx,
            expires,
        };
        self.senders[shard].try_send(command).map_err(|_| {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            FeedError("widget_feed_outbox_full_or_closed")
        })?;
        Ok(PublishReceipt {
            receiver: rx,
            expires,
        })
    }
    /// Wait at most two seconds for the messages queued before these barriers.
    pub async fn flush(&self) -> bool {
        tokio::time::timeout(Duration::from_secs(2), async {
            let mut replies = Vec::new();
            for sender in &self.senders {
                let (tx, rx) = oneshot::channel();
                sender.send(Command::Flush(tx)).await.map_err(|_| ())?;
                replies.push(rx);
            }
            for reply in replies {
                reply.await.map_err(|_| ())?;
            }
            Ok::<_, ()>(())
        })
        .await
        .is_ok_and(|r| r.is_ok())
    }
    /// Request a fresh session without blocking a synchronous producer.
    pub fn request_session_refresh(&self, c: &str) -> Result<PublishReceipt, FeedError> {
        self.submit(model::session_refresh(c))
    }
    /// Build/enqueue a pet event, excluding private desktop-origin requests.
    pub fn pet(
        &self,
        request: &serde_json::Value,
        phase: &str,
        status: Option<&str>,
    ) -> Result<Option<PublishReceipt>, FeedError> {
        model::pet_event(request, phase, status, self.clock.now_ms())?
            .map(|m| self.submit(m))
            .transpose()
    }
    /// Rejected, expired or failed queued events; exported diagnostics, never an unbounded log.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}
impl FeedWorker {
    /// Run all bounded shards under the caller's shutdown token; the caller must await/join this
    /// future. After a successful `flush`, trigger shutdown; pending sends otherwise fail explicitly.
    pub async fn run(self, stop: Shutdown) {
        let publisher = self.publisher;
        let dropped = self.dropped;
        let futures=self.queues.into_iter().map(|mut queue|{let publisher=publisher.clone();let dropped=dropped.clone();let stop=stop.clone();async move{loop{let command=tokio::select!{biased;_=stop.wait()=>break,c=queue.recv()=>c};let Some(command)=command else{break;};match command{Command::Flush(reply)=>{let _=reply.send(());},Command::Publish{message,reply,expires}=>{let result=tokio::select!{biased;_=stop.wait()=>PublishResult::Failed(FeedError("widget_feed_stopped")),r=tokio::time::timeout_at(expires,publisher.publish(message,None))=>r.unwrap_or(PublishResult::Failed(FeedError("widget_feed_deadline")))};if !matches!(result,PublishResult::Sent|PublishResult::NoDemand|PublishResult::Duplicate){dropped.fetch_add(1,Ordering::Relaxed);}let _=reply.send(result);}}}}});
        futures_util::future::join_all(futures).await;
    }
}
impl DuelEvents for FeedOutbox {
    fn duel(&self, c: &str, run: &DuelRun, phase: DuelPhase) {
        // Copy only public fields; the private fight history/phrases never enter a feed queue.
        let value = json!({"id":run.id,"challenger":run.challenger,"opponent":run.opponent,"mode":run.mode,"winner":run.winner,"endsAt":run.ends_at});
        match model::duel_event(
            c,
            &value,
            match phase {
                DuelPhase::Started => "started",
                DuelPhase::Ended => "ended",
            },
            self.clock.now_ms(),
        ) {
            Ok(message) => {
                let _ = self.submit(message);
            }
            Err(_) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

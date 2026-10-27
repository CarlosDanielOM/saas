//! Bounded raid history maintenance and moderation admission. Existing TypeScript
//! producers own session creation; its moderation executor owns external effects.
//! This port shares their collections and Redis state without creating indexes.
use futures_util::TryStreamExt;
use garde::Validate;
use mongodb::{
    Collection, Database,
    bson::{DateTime, Document, doc, oid::ObjectId},
    options::{Acknowledgment, CollectionOptions, WriteConcern},
};
use redis::aio::ConnectionManager;

#[path = "raid_sessions/moderation.rs"]
mod moderation;
#[path = "raid_sessions/values.rs"]
mod values;
use values::*;

pub type Result<T> = std::result::Result<T, &'static str>;
pub const BATCH_SIZE: usize = 200;
pub const MAX_EVENTS: usize = 401;
const QUIET_MS: i64 = 300_000;
const HOUR_MS: i64 = 3_600_000;

/// Scheduling is based on remaining claimable work, never the event count. A
/// tick may make progress and still be idle, or report zero while another
/// retained session/request is ready for its bounded turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TickOutcome {
    pub events: usize,
    pub ready: bool,
}

struct TickProgress {
    retained: usize,
    backfilled: usize,
    admitted: usize,
}
impl TickProgress {
    fn events(&self) -> usize {
        self.retained + self.backfilled + self.admitted
    }
    fn full(&self) -> bool {
        self.backfilled == BATCH_SIZE || self.admitted == BATCH_SIZE
    }
}

fn retention_filter(now: DateTime) -> Document {
    doc! {"retentionHours":{"$lt":72},"expiresAt":{"$gt":now},
    "startedAt":{"$gt":date(now.timestamp_millis()-72*HOUR_MS)}}
}
fn backfill_filter(now: DateTime) -> Document {
    doc! {"backfillDone":false,"expiresAt":{"$gt":now}}
}
fn authorizing_filter(now: DateTime) -> Document {
    doc! {"status":"authorizing","requestedAt":{"$lte":date(now.timestamp_millis()-10_000)},
    "expiresAt":{"$gt":now}}
}
fn request_filter(now: DateTime) -> Document {
    doc! {"status":{"$in":["pending","active"]},"nextAttemptAt":{"$lte":now},
    "lockedUntil":{"$lte":now},"expiresAt":{"$gt":now}}
}

pub struct RaidSessions {
    database: Database,
    cache: ConnectionManager,
}

impl RaidSessions {
    pub fn new(database: Database, cache: ConnectionManager) -> Self {
        Self { database, cache }
    }

    /// One sequential TypeScript-equivalent tick. A caller must bound the whole
    /// tick below the 60-second request lease (the executable uses 20 seconds).
    pub async fn run_once(&mut self) -> Result<usize> {
        Ok(self.run_phases().await?.events())
    }

    async fn run_phases(&mut self) -> Result<TickProgress> {
        let retained = self.extend_retention().await?;
        let backfilled = self.backfill().await?;
        let admitted = self.process_requests().await?;
        Ok(TickProgress {
            retained,
            backfilled,
            admitted,
        })
    }

    /// Normal-mode tick plus bounded readiness probes. Full batches receive an
    /// immediate turn; an exact-200 backfill needs that turn to confirm its end.
    /// Probe failures fail the tick so the executable uses the error backoff.
    pub async fn run_tick(&mut self) -> Result<TickOutcome> {
        let progress = self.run_phases().await?;
        let ready = progress.full() || self.ready_work().await?;
        Ok(TickOutcome {
            events: progress.events(),
            ready,
        })
    }

    async fn ready_work(&self) -> Result<bool> {
        let now = DateTime::now();
        for (collection, filter) in [
            ("raid_sessions", retention_filter(now)),
            ("raid_sessions", backfill_filter(now)),
            ("raid_moderation_requests", authorizing_filter(now)),
            ("raid_moderation_requests", request_filter(now)),
        ] {
            // Only existence is needed. Reuse the exact maintenance/claim
            // filters: future leases, future deadlines and expired requests
            // cannot keep an otherwise idle worker spinning.
            if self
                .collection::<Document>(collection)
                .find_one(filter)
                .projection(doc! {"_id":1})
                .await
                .map_err(|_| "Raid ready-work lookup failed")?
                .is_some()
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn collection<T: Send + Sync>(&self, name: &str) -> Collection<T> {
        // Preserve the schemas' acknowledged journaled writes, including inserts
        // that must be durable before a cursor or follower is marked complete.
        self.database.collection_with_options(
            name,
            CollectionOptions::builder()
                .write_concern(
                    WriteConcern::builder()
                        .w(Acknowledgment::Nodes(1))
                        .journal(true)
                        .build(),
                )
                .build(),
        )
    }

    fn sessions(&self) -> Collection<Session> {
        self.collection("raid_sessions")
    }
    fn followers(&self) -> Collection<Follower> {
        self.collection("raid_followers")
    }
    fn requests(&self) -> Collection<Request> {
        self.collection("raid_moderation_requests")
    }

    /// Followers gain the longer TTL before the session advertises it. Only
    /// still-retained sessions are widened; deleted history cannot be restored.
    pub async fn extend_retention(&self) -> Result<usize> {
        let now = DateTime::now();
        let Some(session) = self
            .sessions()
            .find_one(retention_filter(now))
            .await
            .map_err(|_| "Raid retention lookup failed")?
        else {
            return Ok(0);
        };
        session.validate().map_err(|_| "Invalid raid session")?;
        let expires = date(session.started_at.timestamp_millis() + 72 * HOUR_MS);
        let purge = date(expires.timestamp_millis() + HOUR_MS);
        self.followers()
            .update_many(
                doc! {"sessionID":&session.id},
                doc! {"$max":{"purgeAt":purge}},
            )
            .await
            .map_err(|_| "Raid follower retention update failed")?;
        self.sessions()
            .update_one(
                doc! {"_id":&session.id},
                doc! {
                    "$set":{"retentionHours":72}, "$max":{"expiresAt":expires,"purgeAt":purge}
                },
            )
            .await
            .map_err(|_| "Raid session retention update failed")?;
        Ok(1)
    }

    async fn find_session(&self, channel: &str, at: DateTime) -> Result<Option<Session>> {
        let session = self
            .sessions()
            .find_one(doc! {
                "channelID":channel, "startedAt":{"$lte":at}, "purgeAt":{"$gt":DateTime::now()}
            })
            .sort(doc! {"startedAt":-1,"_id":-1})
            .await
            .map_err(|_| "Raid attribution lookup failed")?;
        match session {
            Some(session) => {
                session.validate().map_err(|_| "Invalid raid session")?;
                Ok(
                    (at <= session.capture_until && session.ended_at.is_none_or(|end| at < end))
                        .then_some(session),
                )
            }
            None => Ok(None),
        }
    }

    async fn state(&mut self, channel: &str) -> Result<Option<State>> {
        let raw: Option<String> = redis::cmd("GET")
            .arg(format!("twitch:{channel}:follow-defense:state"))
            .query_async(&mut self.cache)
            .await
            .map_err(|_| "Raid defense state lookup failed")?;
        Ok(parse_state(raw.as_deref()))
    }

    async fn record_follow(&mut self, follow: Follow) -> Result<()> {
        let now = DateTime::now();
        if follow.at > now {
            return Ok(());
        }
        let Some(session) = self.find_session(&follow.channel, follow.at).await? else {
            return Ok(());
        };
        if session.expires_at <= DateTime::now() {
            return Ok(());
        }
        let id = identity(&[&follow.channel, &follow.event]);
        self.followers()
            .update_one(
                doc! {"_id":&id},
                doc! {"$setOnInsert":follower_document(&id, &session, &follow, DateTime::now())},
            )
            .upsert(true)
            .await
            .map_err(|_| "Raid follower insert failed")?;
        self.sessions().update_one(doc! {"_id":&session.id},doc! {"$max":{"captureUntil":date(session.expires_at.timestamp_millis().min(follow.at.timestamp_millis()+QUIET_MS))}})
            .await.map_err(|_| "Raid capture update failed")?;
        // A newer raid may arrive between the first lookup and insert. Resolve
        // boundaries again, resetting admission marks when ownership changes.
        let latest = self.find_session(&follow.channel, follow.at).await?;
        if let Some(latest) = latest.as_ref().filter(|latest| latest.id != session.id) {
            self.followers()
                .update_one(
                    doc! {"_id":&id},
                    doc! {"$set":{
                        "sessionID":&latest.id,"queuedRequestIDs":[],"eligibleRequestIDs":[],
                        "purgeAt":date(latest.started_at.timestamp_millis()+73*HOUR_MS)
                    }},
                )
                .await
                .map_err(|_| "Raid follower reattribution failed")?;
        }
        let resolved = latest.as_ref().unwrap_or(&session);
        if let Some(request) = self.state(&follow.channel).await?.and_then(|state| {
            state.eligible_request(&resolved.id, DateTime::now().timestamp_millis())
        }) {
            self.followers()
                .update_one(
                    doc! {"_id":&id,"sessionID":&resolved.id},
                    doc! {"$addToSet":{"eligibleRequestIDs":&request}},
                )
                .await
                .map_err(|_| "Raid future follower admission failed")?;
            self.requests()
                .update_one(
                    doc! {"_id":request,"status":"completed","expiresAt":{"$gt":DateTime::now()}},
                    doc! {"$set":{"status":"active"}},
                )
                .await
                .map_err(|_| "Raid request reactivation failed")?;
        }
        Ok(())
    }

    /// The cursor advances over all seen rows, including ignored malformed-user
    /// payloads. A failed row leaves it unchanged for idempotent replay.
    pub async fn backfill(&mut self) -> Result<usize> {
        let Some(session) = self
            .sessions()
            .find_one(backfill_filter(DateTime::now()))
            .sort(doc! {"startedAt":1})
            .await
            .map_err(|_| "Raid backfill session lookup failed")?
        else {
            return Ok(0);
        };
        session.validate().map_err(|_| "Invalid raid session")?;
        let mut filter = doc! {"channelID":&session.channel,"source":"twitch-eventsub","type":"channel.follow.received",
        "occurredAt":{"$gte":session.started_at,"$lte":session.backfill_until}};
        if !session.backfill_cursor.is_empty() {
            filter.insert("_id",doc! {"$gt":ObjectId::parse_str(&session.backfill_cursor).map_err(|_| "Invalid raid backfill cursor")?});
        }
        // Domain events have no collection-level write concern and are read only.
        let events: Vec<Event> = self
            .database
            .collection::<Event>("domain_events")
            .find(filter)
            .sort(doc! {"_id":1})
            .limit(BATCH_SIZE as i64)
            .await
            .map_err(|_| "Raid backfill events lookup failed")?
            .try_collect()
            .await
            .map_err(|_| "Raid backfill events read failed")?;
        for event in &events {
            if let Some(follow) = event.follow(&session.channel)? {
                self.record_follow(follow).await?;
            }
        }
        let cursor = events.last().map_or_else(
            || session.backfill_cursor.clone(),
            |event| event.id.to_hex(),
        );
        self.sessions()
            .update_one(
                doc! {"_id":&session.id,"backfillCursor":&session.backfill_cursor},
                doc! {
                    "$set":{"backfillCursor":cursor,"backfillDone":events.len()<BATCH_SIZE}
                },
            )
            .await
            .map_err(|_| "Raid backfill checkpoint failed")?;
        Ok(events.len())
    }
}

#[cfg(test)]
mod scheduler_tests {
    use super::*;

    #[test]
    fn full_batches_continue_but_ordinary_progress_does_not_imply_backlog() {
        for progress in [
            TickProgress {
                retained: 0,
                backfilled: BATCH_SIZE,
                admitted: 0,
            },
            TickProgress {
                retained: 0,
                backfilled: 0,
                admitted: BATCH_SIZE,
            },
        ] {
            assert!(progress.full());
            assert_eq!(progress.events(), BATCH_SIZE);
        }
        for progress in [
            TickProgress {
                retained: 0,
                backfilled: 0,
                admitted: 0,
            },
            TickProgress {
                retained: 0,
                backfilled: 100,
                admitted: 100,
            },
            TickProgress {
                retained: 1,
                backfilled: 199,
                admitted: 199,
            },
        ] {
            assert!(!progress.full());
        }
    }

    #[test]
    fn a_full_raw_backfill_batch_continues_even_if_every_payload_is_ignored() {
        let events: Vec<Event> = (0..BATCH_SIZE)
            .map(|_| Event {
                id: ObjectId::new(),
                event_key: "event".into(),
                occurred_at: date(0),
                payload: doc! {"event":{"user_login":"missing-user-id"}}.into(),
            })
            .collect();
        assert!(
            events
                .iter()
                .all(|event| event.follow("channel").unwrap().is_none())
        );
        let progress = TickProgress {
            retained: 0,
            backfilled: events.len(),
            admitted: 0,
        };
        assert!(progress.full());
        assert_eq!(progress.events(), BATCH_SIZE);
    }

    #[test]
    fn readiness_uses_the_same_expiry_lease_deadline_and_authorizing_age_filters() {
        let now = date(100_000);
        assert_eq!(
            request_filter(now),
            doc! {
                "status":{"$in":["pending","active"]},"nextAttemptAt":{"$lte":now},
                "lockedUntil":{"$lte":now},"expiresAt":{"$gt":now}
            }
        );
        assert_eq!(
            authorizing_filter(now),
            doc! {
                "status":"authorizing","requestedAt":{"$lte":date(90_000)},"expiresAt":{"$gt":now}
            }
        );
        assert_eq!(
            backfill_filter(now),
            doc! {"backfillDone":false,"expiresAt":{"$gt":now}}
        );
        assert_eq!(
            retention_filter(now),
            doc! {
                "retentionHours":{"$lt":72},"expiresAt":{"$gt":now},
                "startedAt":{"$gt":date(100_000-72*HOUR_MS)}
            }
        );
    }
}

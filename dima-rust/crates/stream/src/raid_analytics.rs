//! Raid event history and one-channel production summary projection.
//!
//! Producers follow utils/raid_analytics.ts. Projection follows the deployed Rust worker:
//! rustPending crash receipts, BSON source fingerprints, unchanged-payload suppression,
//! exact dirtyAt publication fencing, inclusive repair deadlines and source/open-window
//! scheduling are retained. TypeScript's unconditional minute refresh is not used.
//! One call checks <=25 follow windows, in groups of five; rank/recent lists have five rows.
//! The retained-history fingerprint scan is intentionally unbounded, streamed 100 at a time.
//! Mongo server budgets remain 1500/2000/3000 ms; calls have thirty-second wall deadlines and
//! a pass has 45 seconds. Lease 60s, renewal 10s, repair 15min, follow window 5min, error retry
//! 30s. Business time and lease time are separate injected clocks; owner must be fresh per call.
//! Peer text cuts retain UTF-16 budgets because source fingerprints cover the stored bytes.
//! Native metadata has a local model extension; aggregation BSON widths are preserved locally.
use crate::{
    Error, bounded, raid_native_bson_compat as compat,
    raid_projection::*,
    timeline_store::{Store, date},
};
use bson::{Bson, DateTime, Document, doc};
use dima_core::Clock;
use dima_events::{envelope::Envelope, value::Value};
use dima_model::{CollectionInfo, raid_analytics_histories as history};
use dima_store::mongo::{MongoStore, WriteContext, update::UpdateOptions};
use futures_util::{TryStreamExt, future::try_join_all};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
const SUMMARY: &str = "raid_analytics_summaries";
const HISTORY: &str = "raid_analytics_histories";
const REPAIR: i64 = 900_000;
#[derive(Clone, Debug)]
pub struct Config {
    pub store_deadline: Duration,
    pub batch_deadline: Duration,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            store_deadline: Duration::from_secs(30),
            batch_deadline: Duration::from_secs(45),
        }
    }
}
#[derive(Clone)]
pub struct RaidAnalytics {
    store: Store,
    lease_clock: Arc<dyn Clock>,
    config: Config,
}
pub fn raid_range_start(days: u32, now: DateTime) -> DateTime {
    DateTime::from_millis(
        now.timestamp_millis().div_euclid(86_400_000) * 86_400_000
            - (i64::from(days) - 1) * 86_400_000,
    )
}
pub(super) fn malformed() -> Error {
    Error::Invalid("Invalid raid analytics projection data".into())
}
fn decode<T: serde::de::DeserializeOwned>(d: Document) -> Result<T, Error> {
    bson::deserialize_from_document(d).map_err(|_| malformed())
}
impl RaidAnalytics {
    pub fn new(
        mongo: MongoStore,
        clock: Arc<dyn Clock>,
        lease_clock: Arc<dyn Clock>,
        config: Config,
    ) -> Result<Self, Error> {
        if config.store_deadline.is_zero()
            || config.store_deadline > Duration::from_secs(30)
            || config.batch_deadline.is_zero()
            || config.batch_deadline > Duration::from_secs(45)
        {
            return Err(Error::Invalid(
                "raid deadlines exceed lease safety budget".into(),
            ));
        }
        let mut store = Store::new(mongo, clock);
        store.deadline = config.store_deadline;
        Ok(Self {
            store,
            lease_clock,
            config,
        })
    }
    #[cfg(feature = "test-util")]
    pub fn with_write_hook(
        mut self,
        hook: Arc<dyn Fn() -> futures_util::future::BoxFuture<'static, ()> + Send + Sync>,
    ) -> Self {
        self.store.hook = Some(hook);
        self
    }
    fn lease_now(&self) -> DateTime {
        DateTime::from_millis(self.lease_clock.now_ms())
    }
    fn owner(&self, id: &str, owner: &str) -> Document {
        doc! {"_id":id,"owner":owner,"leaseUntil":{"$gt":self.lease_now()}}
    }
    async fn update(
        &self,
        info: &'static CollectionInfo,
        filter: Document,
        update: Document,
        upsert: bool,
        observe: bool,
    ) -> Result<u64, Error> {
        let mut p = info.prepare_update(
            &filter,
            update.clone(),
            UpdateOptions {
                upsert,
                ..Default::default()
            },
            &mut WriteContext::new(self.store.clock.now_ms()),
        )?;
        compat::preserve_payload(&mut p.update, &update);
        let mut w = self.store.mongo.writes(info.name);
        if info.name == HISTORY {
            w = w.write_concern(
                mongodb::options::WriteConcern::builder()
                    .w(mongodb::options::Acknowledgment::Nodes(1))
                    .journal(true)
                    .build(),
            );
        }
        let r = bounded(self.config.store_deadline, w.update_one(&p)).await?;
        if observe {
            self.store.after_write().await;
        }
        Ok(r.matched)
    }
    pub async fn queue_raid_summary(&self, channel: &str) -> Result<(), Error> {
        let now = self.store.now();
        let update = doc! {"$set":{"dirtyAt":now,"nextRefreshAt":now},"$setOnInsert":{"leaseUntil":DateTime::from_millis(0)}};
        match self
            .update(
                &compat::INFO,
                doc! {"_id":channel},
                update.clone(),
                true,
                true,
            )
            .await
        {
            Err(Error::Write(dima_store::mongo::write::WriteError::Driver(e)))
                if dima_store::mongo::error::is_duplicate_key(&e) =>
            {
                self.update(&compat::INFO, doc! {"_id":channel}, update, false, true)
                    .await?;
            }
            Err(e) => return Err(e),
            Ok(_) => {}
        }
        Ok(())
    }
    pub async fn apply_raid_analytics_event(&self, event: &Envelope) -> Result<(), Error> {
        let Some(channel) = event.channel_id.as_deref().filter(|s| !s.is_empty()) else {
            return Ok(());
        };
        if event.source != "twitch-eventsub"
            || !["channel.raid.received", "channel.raid.sent"].contains(&event.kind.as_str())
            || event.expires_at_ms <= self.store.clock.now_ms()
        {
            return Ok(());
        }
        let raw = event
            .payload
            .at("event")
            .as_object()
            .ok_or_else(|| Error::Invalid("Invalid raid history payload".into()))?;
        let outgoing = event.kind == "channel.raid.sent";
        let prefix = if outgoing { "to" } else { "from" };
        let peer = raw
            .at(&format!("{prefix}_broadcaster_user_id"))
            .or_empty_string();
        let viewers = coerce(raw.at("viewers"));
        if peer.is_empty() || !viewers.is_finite() {
            return Err(Error::Invalid("Invalid raid history payload".into()));
        }
        let id = dima_core::crypto::sha256(format!("{channel}:{}", event.event_key)).hex();
        let result=self.update(&history::INFO,doc!{"_id":id},doc!{"$setOnInsert":{"channelID":channel,"direction":if outgoing{"outgoing"}else{"incoming"},"peerID":peer,"peerLogin":dima_text::truncate_utf16_budget(&raw.at(&format!("{prefix}_broadcaster_user_login")).or_empty_string(),64),"peerName":dima_text::truncate_utf16_budget(&raw.at(&format!("{prefix}_broadcaster_user_name")).or_empty_string(),64),"viewers":viewers.max(0.0),"occurredAt":DateTime::from_millis(event.occurred_at_ms),"expiresAt":DateTime::from_millis(event.expires_at_ms)}},true,true).await;
        match result {
            Err(Error::Write(dima_store::mongo::write::WriteError::Driver(e)))
                if dima_store::mongo::error::is_duplicate_key(&e) => {}
            Err(e) => return Err(e),
            Ok(_) => {}
        }
        self.queue_raid_summary(channel).await
    }
    pub async fn project_raid_summary_once(&self, owner: &str) -> Result<bool, Error> {
        if owner.is_empty() {
            return Err(Error::Invalid("empty raid owner".into()));
        }
        bounded(self.config.batch_deadline, self.project(owner)).await
    }
    async fn project(&self, owner: &str) -> Result<bool, Error> {
        let now = self.store.now();
        let state=self.store.modify(&compat::INFO,doc!{"nextRefreshAt":{"$lte":now},"leaseUntil":{"$lte":self.lease_now()}},doc!{"$set":{"owner":owner,"leaseUntil":DateTime::from_millis(self.lease_clock.now_ms()+60_000)}},doc!{"nextRefreshAt":1},false).await?;
        let Some(state) = state else { return Ok(false) };
        let state: State = decode(state)?;
        let id = state.id.clone();
        let dirty_at = state.dirty_at;
        let result = {
            let work = self.project_owned(state, owner, now);
            tokio::pin!(work);
            loop {
                tokio::select! {r=&mut work=>break r,_=tokio::time::sleep(Duration::from_secs(10))=>{match self.update(&compat::INFO,self.owner(&id,owner),doc!{"$set":{"leaseUntil":DateTime::from_millis(self.lease_clock.now_ms()+60_000)}},false,false).await {
                    Ok(n) if n>0=>{},
                    Ok(_)=>break Err(Error::Invalid("Raid analytics lease lost".into())),
                    Err(error)=>break Err(error),
                }}}
            }
        };
        if result.is_err() {
            let mut f = self.owner(&id, owner);
            f.insert("dirtyAt", compat::null_date(dirty_at));
            let _=self.update(&compat::INFO,f,doc!{"$set":{"error":true,"nextRefreshAt":DateTime::from_millis(self.lease_clock.now_ms()+30_000)}},false,true).await;
        }
        let released = self
            .update(
                &compat::INFO,
                doc! {"_id":&id,"owner":owner},
                doc! {"$set":{"leaseUntil":DateTime::from_millis(0)}},
                false,
                true,
            )
            .await;
        match result {
            Err(e) => Err(e),
            Ok(changed) => {
                released?;
                Ok(changed)
            }
        }
    }
    async fn assert_owner(&self, id: &str, owner: &str) -> Result<(), Error> {
        if self
            .store
            .find(SUMMARY, self.owner(id, owner), doc! {}, 1, 0, 1500)
            .await?
            .is_empty()
        {
            return Err(Error::Invalid("Raid analytics lease lost".into()));
        }
        Ok(())
    }
    async fn project_owned(&self, state: State, owner: &str, now: DateTime) -> Result<bool, Error> {
        if state.id.is_empty() {
            return Err(malformed());
        }
        let follows = self.refresh_follows(&state.id, owner, now).await?;
        let previous = state
            .refresh
            .as_ref()
            .filter(|r| r.version == 1 && state.payload.is_some());
        let source = if needs_source_check(&state, previous, follows.changed, now) {
            self.source_state(&state.id, now).await?
        } else {
            let p = previous.ok_or_else(malformed)?;
            SourceState {
                fingerprint: p.fingerprint.clone(),
                next_source_at: p.next_source_at,
                has_follow_windows: p.has_follow_windows,
            }
        };
        let mut payload = None;
        if previous.is_none_or(|p| p.fingerprint != source.fingerprint) {
            let candidate = doc! {"7":self.build_period(&state.id,7,now).await?,"30":self.build_period(&state.id,30,now).await?};
            if !state
                .payload
                .as_ref()
                .is_some_and(|p| same_payload(p, &candidate))
            {
                payload = Some(candidate);
            }
        }
        let refresh = RefreshState {
            version: 1,
            fingerprint: source.fingerprint,
            next_source_at: source.next_source_at,
            next_repair_at: if source.has_follow_windows {
                Some(
                    previous
                        .and_then(|p| p.next_repair_at)
                        .filter(|at| *at > now || follows.pending)
                        .unwrap_or_else(|| DateTime::from_millis(now.timestamp_millis() + REPAIR)),
                )
            } else {
                None
            },
            next_open_at: follows.next_open_at,
            dirty_at: state.dirty_at,
            has_follow_windows: source.has_follow_windows,
        };
        let next = next_refresh_at(&refresh, follows.pending, now);
        let changed = payload.is_some();
        let mut values =
            doc! {"rustRefresh":compat::serialized(&refresh)?,"error":false,"rustPending":false};
        if let Some(payload) = payload {
            values.insert("payload", payload);
            values.insert("updatedAt", now);
        }
        let mut update = doc! {"$set":values};
        if let Some(next) = next {
            update
                .get_document_mut("$set")
                .map_err(|_| malformed())?
                .insert("nextRefreshAt", next);
        } else {
            update.insert("$unset", doc! {"nextRefreshAt":""});
        }
        self.assert_owner(&state.id, owner).await?;
        let mut filter = self.owner(&state.id, owner);
        filter.insert("dirtyAt", compat::null_date(state.dirty_at));
        let matched = self
            .update(&compat::INFO, filter, update, false, true)
            .await?;
        if matched == 0 {
            self.assert_owner(&state.id, owner).await?;
        }
        Ok(changed && matched > 0)
    }
    async fn refresh_follows(
        &self,
        channel: &str,
        owner: &str,
        now: DateTime,
    ) -> Result<FollowRefresh, Error> {
        let rows: Vec<FollowRow> = self
            .store
            .find(
                HISTORY,
                follow_due_filter(channel, now),
                doc! {"followsComputedAt":1,"occurredAt":1},
                25,
                0,
                2000,
            )
            .await?
            .into_iter()
            .map(decode)
            .collect::<Result<_, _>>()?;
        let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
        let mut out = FollowRefresh::default();
        let mut updates = Vec::new();
        for chunk in rows.chunks(5) {
            self.assert_owner(channel, owner).await?;
            for (values, changed, open, id) in
                try_join_all(chunk.iter().map(|r| self.follow_update(channel, r, now))).await?
            {
                out.changed |= changed;
                earliest(&mut out.next_open_at, open);
                if !values.is_empty() {
                    updates.push((id, values));
                }
            }
        }
        if !updates.is_empty() {
            self.assert_owner(channel, owner).await?;
            if out.changed
                && self
                    .update(
                        &compat::INFO,
                        self.owner(channel, owner),
                        doc! {"$set":{"rustPending":true}},
                        false,
                        true,
                    )
                    .await?
                    == 0
            {
                return Err(Error::Invalid("Raid analytics lease lost".into()));
            }
            for (id, values) in updates {
                self.update(
                    &history::INFO,
                    doc! {"_id":id},
                    doc! {"$set":values},
                    false,
                    true,
                )
                .await?;
            }
        }
        let mut pending = follow_due_filter(channel, now);
        pending.insert("_id", doc! {"$nin":ids});
        out.pending = !self
            .store
            .find(HISTORY, pending, doc! {}, 1, 0, 2000)
            .await?
            .is_empty();
        Ok(out)
    }
    async fn follow_update(
        &self,
        channel: &str,
        row: &FollowRow,
        now: DateTime,
    ) -> Result<(Document, bool, Option<DateTime>, String), Error> {
        if row.id.is_empty() {
            return Err(malformed());
        }
        let next=self.store.find(HISTORY,doc!{"channelID":channel,"direction":"incoming","expiresAt":{"$gt":now},"$or":[{"occurredAt":{"$gt":row.occurred_at}},{"occurredAt":row.occurred_at,"_id":{"$gt":&row.id}}]},doc!{"occurredAt":1,"_id":1},1,0,1500).await?.first().map(|r|date(r,"occurredAt")).transpose()?;
        let full = row.occurred_at.timestamp_millis() + 300_000;
        let end = full
            .min(next.map_or(i64::MAX, |n| n.timestamp_millis()))
            .min(now.timestamp_millis());
        let closed = end >= full || next.is_some_and(|n| end >= n.timestamp_millis());
        let computed = if closed {
            now
        } else {
            DateTime::from_millis(0)
        };
        let count=bounded(self.config.store_deadline,self.store.mongo.documents("domain_events").count_documents(doc!{"channelID":channel,"source":"twitch-eventsub","type":"channel.follow.received","occurredAt":{"$gte":row.occurred_at,"$lt":DateTime::from_millis(end)},"expiresAt":{"$gt":now}}).max_time(Duration::from_millis(2000))).await?;
        let (values, changed) = follow_values(row, count, DateTime::from_millis(end), computed);
        let open = (!closed).then(|| {
            DateTime::from_millis(
                (now.timestamp_millis() + 60_000)
                    .min(full)
                    .min(next.map_or(i64::MAX, |n| n.timestamp_millis())),
            )
        });
        Ok((values, changed, open, row.id.clone()))
    }
    async fn source_state(&self, channel: &str, now: DateTime) -> Result<SourceState, Error> {
        let mut rows = bounded(
            self.config.store_deadline,
            self.store
                .mongo
                .documents(HISTORY)
                .find(doc! {
                    "channelID": channel, "expiresAt": { "$gt": now },
                })
                .sort(doc! { "occurredAt": -1, "_id": 1 })
                .projection(doc! {
                    "_id": 1, "direction": 1, "peerID": 1, "peerLogin": 1,
                    "peerName": 1, "viewers": 1, "occurredAt": 1, "expiresAt": 1,
                    "followsAfter": 1, "followWindowEnd": 1,
                })
                .batch_size(100)
                .max_time(Duration::from_millis(3000)),
        )
        .await?;
        let mut digest = Sha256::new();
        let mut next_source_at = None;
        let mut has_follow_windows = false;
        let mut has_period_rows = false;
        while let Some(row) = bounded(self.config.store_deadline, rows.try_next()).await? {
            let occurred = *row.get_datetime("occurredAt").map_err(|_| malformed())?;
            let expires = *row.get_datetime("expiresAt").map_err(|_| malformed())?;
            if occurred > now {
                earliest(&mut next_source_at, Some(occurred.min(expires)));
                continue;
            }
            let in_period = occurred >= raid_range_start(30, now);
            let outgoing = row.get_str("direction").map_err(|_| malformed())? == "outgoing";
            if !in_period && !outgoing {
                continue;
            }
            earliest(&mut next_source_at, Some(expires));
            let mut source = Document::new();
            let fields: &[&str] = if in_period {
                has_period_rows = true;
                has_follow_windows |= !outgoing;
                &[
                    "_id",
                    "direction",
                    "peerID",
                    "peerLogin",
                    "peerName",
                    "viewers",
                    "occurredAt",
                    "followsAfter",
                    "followWindowEnd",
                ]
            } else {
                // Outgoing history older than 30 days still affects reciprocity.
                &["_id", "direction", "peerID", "occurredAt"]
            };
            for field in fields {
                if let Some(value) = row.get(*field) {
                    source.insert(*field, value.clone());
                }
            }
            let bytes = compat::bytes(&source)?;
            digest.update((bytes.len() as u64).to_le_bytes());
            digest.update(bytes);
        }
        if has_period_rows {
            // UTC range boundaries change the published from dates as well as
            // membership. An empty channel needs neither midnight work nor a
            // repair timer; its existing producer will queue the next raid.
            digest.update(raid_range_start(7, now).timestamp_millis().to_le_bytes());
            digest.update(raid_range_start(30, now).timestamp_millis().to_le_bytes());
            earliest(
                &mut next_source_at,
                Some(DateTime::from_millis(
                    (now.timestamp_millis().div_euclid(86_400_000) + 1) * 86_400_000,
                )),
            );
        }
        Ok(SourceState {
            fingerprint: format!("{:x}", digest.finalize()),
            next_source_at,
            has_follow_windows,
        })
    }

    async fn build_period_data(
        &self,
        channel: &str,
        days: u32,
        now: DateTime,
    ) -> Result<Document, Error> {
        let top = |direction: &str| {
            vec![
                doc! { "$match": { "direction": direction } },
                doc! { "$group": { "_id": "$peerID", "count": { "$sum": 1 }, "viewers": { "$sum": "$viewers" },
                "name": { "$first": "$peerName" }, "login": { "$first": "$peerLogin" }, "lastAt": { "$first": "$occurredAt" } } },
                doc! { "$sort": { "count": -1, "_id": 1 } },
                doc! { "$limit": 5 },
            ]
        };
        let recent = |direction: &str| {
            vec![
                doc! { "$match": { "direction": direction } },
                doc! { "$limit": 5 },
                doc! { "$project": { "_id": 0, "peerID": 1, "peerName": 1, "peerLogin": 1, "viewers": 1,
                "occurredAt": 1, "followsAfter": 1, "followWindowEnd": 1 } },
            ]
        };
        let mut results: Vec<Document> = bounded(self.config.store_deadline, async {self.store.mongo.documents(HISTORY).aggregate(vec![
            doc! { "$match": { "channelID": channel, "occurredAt": { "$gte": raid_range_start(days, now), "$lte": now }, "expiresAt": { "$gt": now } } },
            doc! { "$sort": { "occurredAt": -1, "_id": 1 } },
            doc! { "$facet": {
                "totals": [{ "$group": { "_id": "$direction", "raids": { "$sum": 1 }, "viewers": { "$sum": "$viewers" },
                    "biggest": { "$max": "$viewers" }, "followsAfter": { "$sum": "$followsAfter" },
                    "evaluatedRaids": { "$sum": { "$cond": [{ "$ne": ["$followsAfter", Bson::Null] }, 1, 0] } }, "firstAt": { "$min": "$occurredAt" } } }],
                "incoming": recent("incoming"), "outgoing": recent("outgoing"), "topIncoming": top("incoming"), "topOutgoing": top("outgoing")
            } },
        ]).max_time(Duration::from_millis(3000)).await?.try_collect::<Vec<Document>>().await}).await?;
        results.pop().ok_or_else(malformed)
    }

    async fn attach_reciprocity(
        &self,
        channel: &str,
        period: &mut Document,
        now: DateTime,
    ) -> Result<(), Error> {
        // Preserve the original per-period lookup over at most five recent
        // and five top incoming peers. Retained outgoing history before the
        // period still determines reciprocity; there is no lower date bound.
        let peers = period_peers(period)?;
        let outgoing: Vec<Document> = bounded(self.config.store_deadline, async {self.store.mongo.documents(HISTORY).aggregate(vec![
            doc! { "$match": { "channelID": channel, "direction": "outgoing", "peerID": { "$in": peers },
                "expiresAt": { "$gt": now }, "occurredAt": { "$lte": now } } },
            doc! { "$group": { "_id": "$peerID", "lastAt": { "$max": "$occurredAt" } } },
        ]).max_time(Duration::from_millis(2000)).await?.try_collect::<Vec<Document>>().await}).await?;
        attach_outgoing(period, &outgoing)
    }
    async fn build_period(
        &self,
        channel: &str,
        days: u32,
        now: DateTime,
    ) -> Result<Document, Error> {
        let mut period = self.build_period_data(channel, days, now).await?;
        self.attach_reciprocity(channel, &mut period, now).await?;
        Ok(period_payload(period, days, now))
    }
}
fn coerce(value: &Value) -> f64 {
    match value {
        Value::Number(n) | Value::Date(n) => *n,
        Value::Null => 0.0,
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        v => dima_text::parse_number(&v.to_js_string()),
    }
}

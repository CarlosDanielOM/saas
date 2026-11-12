//! Activity capture, a bounded batch projection and the dashboard read.
//!
//! Capture and reads follow `utils/stream_activity.ts`; projection follows the deployed
//! `src/workers/stream_activity`. Production writes int64 buckets and double increments/
//! sequences, unlike Node's int32 numbers. Those widths are retained deliberately.
//! Input keys/actors use the reference's UTF-16 budget because they feed stored identities;
//! display labels use scalar limits. Queries retain 20 ranks and 2000 chart points.
//! A batch has a 45-second deadline (lease 60 seconds); cancellation leaves its checkpoint
//! and lease for replay. No detached heartbeat survives cancellation. Each store call has a
//! five-second default deadline (configurable through 30 seconds, with matching reserved lease
//! headroom). The caller owns scheduling, stores, clock and owner generation.
use crate::activity_projection::{Activity, Projection, hash};
use crate::{Error, bounded};
use bson::{Bson, DateTime, Document, doc, oid::ObjectId};
use dima_core::Clock;
use dima_model::{
    CollectionInfo, stream_activities, stream_activity_aggregates, stream_activity_states,
};
use dima_store::mongo::{
    MongoStore, WriteContext,
    update::{Returned, UpdateOptions},
    write::UpdateOutcome,
};
use futures_util::TryStreamExt;
#[cfg(feature = "test-util")]
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
const RETENTION: i64 = 90 * 86_400_000;
const STATE: &str = "projector-v1";
#[derive(Clone, Debug)]
pub struct Config {
    pub store_deadline: Duration,
    pub batch_deadline: Duration,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            store_deadline: Duration::from_secs(5),
            batch_deadline: Duration::from_secs(45),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Emote {
    pub key: String,
    pub label: String,
    pub count: f64,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Fragment {
    pub r#type: String,
    pub text: String,
    pub emote: Option<FragmentEmote>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct FragmentEmote {
    pub id: Option<String>,
}
pub fn extract_timeline_emotes(fragments: &[Fragment]) -> Vec<Emote> {
    let mut rows: Vec<Emote> = Vec::new();
    for fragment in fragments.iter().take(500) {
        let Some(id) = fragment
            .emote
            .as_ref()
            .and_then(|e| e.id.as_deref())
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        if fragment.r#type != "emote" {
            continue;
        }
        let key = format!("twitch:{}", dima_text::truncate_utf16_budget(id, 64));
        if let Some(row) = rows.iter_mut().find(|e| e.key == key) {
            row.count += 1.0;
        } else {
            rows.push(Emote {
                key,
                label: dima_text::truncate_chars(&fragment.text, 64).into(),
                count: 1.0,
            });
        }
    }
    rows
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityKind {
    Message,
    Command,
    Redemption,
    Follow,
    Sub,
    Gift,
    Bits,
    Raid,
}
impl ActivityKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::Command => "command",
            Self::Redemption => "redemption",
            Self::Follow => "follow",
            Self::Sub => "sub",
            Self::Gift => "gift",
            Self::Bits => "bits",
            Self::Raid => "raid",
        }
    }
}
#[derive(Clone, Debug, Deserialize)]
pub struct Session {
    #[serde(rename = "_id")]
    pub id: ObjectId,
    pub started_at: DateTime,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    #[serde(rename = "channelID")]
    pub channel_id: String,
    #[serde(rename = "eventID")]
    pub event_id: String,
    pub kind: ActivityKind,
    pub occurred_at: Option<DateTime>,
    pub session: Option<Session>,
    #[serde(default)]
    pub actor: String,
    #[serde(default)]
    pub actor_label: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub label: String,
    pub value: Option<f64>,
    pub outcome: Option<String>,
    #[serde(default)]
    pub emotes: Vec<Emote>,
}
#[derive(Clone)]
pub struct Activities {
    store: MongoStore,
    clock: Arc<dyn Clock>,
    config: Config,
    #[cfg(feature = "test-util")]
    hook: Option<Arc<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>>,
}
impl Activities {
    pub fn new(store: MongoStore, clock: Arc<dyn Clock>, config: Config) -> Result<Self, Error> {
        if config.store_deadline.is_zero()
            || config.store_deadline > Duration::from_secs(30)
            || config.batch_deadline.is_zero()
            || config.batch_deadline > Duration::from_secs(45)
        {
            return Err(Error::Invalid(
                "activity deadlines exceed lease safety budget".into(),
            ));
        }
        Ok(Self {
            store,
            clock,
            config,
            #[cfg(feature = "test-util")]
            hook: None,
        })
    }
    #[cfg(feature = "test-util")]
    pub fn with_write_hook(
        mut self,
        hook: Arc<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>,
    ) -> Self {
        self.hook = Some(hook);
        self
    }
    async fn after_write(&self) {
        #[cfg(feature = "test-util")]
        if let Some(hook) = &self.hook {
            hook().await;
        }
    }
    fn now(&self) -> DateTime {
        DateTime::from_millis(self.clock.now_ms())
    }
    async fn update(
        &self,
        info: &'static CollectionInfo,
        filter: Document,
        update: Document,
        upsert: bool,
        production_widths: bool,
    ) -> Result<UpdateOutcome, Error> {
        self.update_observed(info, filter, update, upsert, production_widths, true)
            .await
    }
    #[allow(clippy::too_many_arguments)]
    async fn update_observed(
        &self,
        info: &'static CollectionInfo,
        filter: Document,
        update: Document,
        upsert: bool,
        production_widths: bool,
        observe: bool,
    ) -> Result<UpdateOutcome, Error> {
        // The projector that runs in production is native Rust and stores int64 buckets and
        // double counters; its port keeps those types instead of the ones Node would choose.
        let mut ctx = WriteContext::new(self.clock.now_ms());
        if production_widths {
            ctx = ctx.native_numbers();
        }
        let prepared = info.prepare_update(
            &filter,
            update,
            UpdateOptions {
                upsert,
                ..UpdateOptions::default()
            },
            &mut ctx,
        )?;
        let mut writes = self.store.writes(info.name);
        if info.name == stream_activities::COLLECTION {
            writes = writes.write_concern(
                mongodb::options::WriteConcern::builder()
                    .w(mongodb::options::Acknowledgment::Nodes(1))
                    .journal(true)
                    .build(),
            );
        }
        let result = bounded(self.config.store_deadline, writes.update_one(&prepared)).await?;
        if observe {
            self.after_write().await;
        }
        Ok(result)
    }
    async fn find(
        &self,
        collection: &str,
        filter: Document,
        sort: Document,
        limit: i64,
        max_ms: u64,
    ) -> Result<Vec<Document>, Error> {
        bounded(self.config.store_deadline, async {
            self.store
                .documents(collection)
                .find(filter)
                .sort(sort)
                .limit(limit)
                .max_time(Duration::from_millis(max_ms))
                .await?
                .try_collect()
                .await
        })
        .await
    }
    pub async fn capture_stream_activity(&self, input: &Capture) -> Result<(), Error> {
        if input.channel_id.is_empty() || input.event_id.is_empty() {
            return Ok(());
        }
        let at = input.occurred_at.unwrap_or_else(|| self.now());
        let ms = at.timestamp_millis();
        if ms < self.clock.now_ms() - RETENTION || ms > self.clock.now_ms() + 60_000 {
            return Ok(());
        }
        let session = match &input.session { Some(s)=>Some(s.clone()), None=> {
            self.find("streamsessions",doc!{"channelID":&input.channel_id,"started_at":{"$lte":at},"$or":[{"ended_at":{"$gt":at}},{"ended_at":Bson::Null}]},doc!{"started_at":-1},1,1500).await?.into_iter().next().map(bson::deserialize_from_document).transpose().map_err(|e|Error::Invalid(e.to_string()))?
        }};
        let Some(session) = session.filter(|s| at >= s.started_at) else {
            return Ok(());
        };
        if input.value.is_some_and(|v| !v.is_finite()) {
            return Err(Error::Invalid("nonfinite activity value".into()));
        }
        let emotes: Vec<Bson> = input
            .emotes
            .iter()
            .map(|e| Bson::Document(doc! {"key":&e.key,"label":&e.label,"count":e.count}))
            .collect();
        let result=self.update(&stream_activities::INFO,doc!{"_id":hash(json!([input.channel_id,input.kind.as_str(),input.event_id]))},doc!{"$setOnInsert":{
            "channelID":&input.channel_id,"session_id":session.id,"occurredAt":at,"offset":(ms-session.started_at.timestamp_millis()) as f64/1000.0,
            "kind":input.kind.as_str(),"actor":dima_text::truncate_utf16_budget(&input.actor,64),"actorLabel":dima_text::truncate_chars(&input.actor_label,64),
            "key":dima_text::truncate_utf16_budget(&input.key,100),"label":dima_text::truncate_chars(&input.label,100),"value":input.value.unwrap_or(1.0).max(0.0),
            "outcome":if input.outcome.as_deref()==Some("error"){"error"}else{"ok"},"emotes":emotes,"processed":false,"expiresAt":DateTime::from_millis(ms+RETENTION)
        }},true,false).await;
        ignore_duplicate(result).map(|_| ())
    }
    /// `owner` must be fresh for each call (caller supplies injected randomness).
    pub async fn project_stream_activity_batch(
        &self,
        limit: usize,
        owner: &str,
    ) -> Result<usize, Error> {
        if owner.is_empty() {
            return Err(Error::Invalid("empty projection owner".into()));
        }
        bounded(self.config.batch_deadline, self.project(limit, owner)).await
    }
    async fn project(&self, limit: usize, owner: &str) -> Result<usize, Error> {
        self.update(
            &stream_activity_states::INFO,
            doc! {"_id":STATE},
            doc! {"$setOnInsert":{"seq":0,"leaseUntil":DateTime::from_millis(0),"active.ids":[]}},
            true,
            true,
        )
        .await?;
        let prepared=stream_activity_states::INFO.prepare_find_one_and_update(&doc!{"_id":STATE,"leaseUntil":{"$lte":self.now()}},doc!{"$set":{"owner":owner,"leaseUntil":DateTime::from_millis(self.clock.now_ms()+60_000)}},UpdateOptions::default(),Returned::After,&mut WriteContext::new(self.clock.now_ms()))?;
        let state = bounded(
            self.config.store_deadline,
            self.store
                .writes(stream_activity_states::COLLECTION)
                .find_one_and_update(&prepared),
        )
        .await?;
        let Some(state) = state else { return Ok(0) };
        self.after_write().await;
        let result = {
            let work = self.project_owned(state, limit, owner);
            tokio::pin!(work);
            loop {
                tokio::select! {
                    result = &mut work => break result,
                    _ = tokio::time::sleep(Duration::from_secs(10)) => {
                        let renewed = self.update_observed(&stream_activity_states::INFO,
                            doc! {"_id": STATE, "owner": owner},
                            doc! {"$set": {"leaseUntil": DateTime::from_millis(self.clock.now_ms()+60_000)}}, false, true, false).await?;
                        if renewed.matched == 0 {break Err(Error::Invalid("Timeline projection lease lost".into()));}
                    }
                }
            }
        };
        let release = self
            .update(
                &stream_activity_states::INFO,
                doc! {"_id":STATE,"owner":owner},
                doc! {"$set":{"leaseUntil":DateTime::from_millis(0)}},
                false,
                true,
            )
            .await;
        match result {
            Err(e) => Err(e),
            Ok(n) => {
                release?;
                Ok(n)
            }
        }
    }
    async fn assert_owner(&self, owner: &str) -> Result<(), Error> {
        if self.find(stream_activity_states::COLLECTION,doc!{"_id":STATE,"owner":owner,"leaseUntil":{"$gt":DateTime::from_millis(self.clock.now_ms()+self.config.store_deadline.as_millis() as i64)}},doc!{},1,1500).await?.is_empty() {return Err(Error::Invalid("Timeline projection lease lost".into()));}
        Ok(())
    }
    async fn project_owned(
        &self,
        state: Document,
        limit: usize,
        owner: &str,
    ) -> Result<usize, Error> {
        let (seq, ids) = if let Ok(active) = state.get_document("active")
            && let Ok(ids) = active.get_array("ids")
            && !ids.is_empty()
        {
            (number(active, "seq"), ids.clone())
        } else {
            let ids: Vec<Bson> = self
                .find(
                    stream_activities::COLLECTION,
                    doc! {"processed":false,"expiresAt":{"$gt":self.now()}},
                    doc! {"occurredAt":1,"_id":1},
                    limit.clamp(1, 1000) as i64,
                    2000,
                )
                .await?
                .into_iter()
                .filter_map(|d| d.get("_id").cloned())
                .collect();
            if ids.is_empty() {
                return Ok(0);
            }
            let seq = number(&state, "seq") + 1.0;
            self.assert_owner(owner).await?;
            let saved = self
                .update(
                    &stream_activity_states::INFO,
                    doc! {"_id":STATE,"owner":owner},
                    doc! {"$set":{"seq":seq,"active":{"seq":seq,"ids":&ids}}},
                    false,
                    true,
                )
                .await?;
            if saved.matched == 0 {
                return Err(Error::Invalid("Timeline projection lease lost".into()));
            }
            (seq, ids)
        };
        if ids.len() > 1000
            || ids.iter().any(|id| !matches!(id, Bson::String(_)))
            || !seq.is_finite()
            || seq <= 0.0
        {
            return Err(Error::Invalid("invalid checkpoint".into()));
        }
        let rows: Vec<Activity> = self
            .find(
                stream_activities::COLLECTION,
                doc! {"_id":{"$in":&ids}},
                doc! {},
                1000,
                2000,
            )
            .await?
            .into_iter()
            .map(bson::deserialize_from_document)
            .collect::<Result<_, _>>()
            .map_err(|e| Error::Invalid(e.to_string()))?;
        let mut projection = Projection::new(&rows);
        for (id, &(row, bucket)) in &projection.distinct {
            self.assert_owner(owner).await?;
            let mut base = doc! {"channelID":&row.channel_id,"session_id":row.session_id,"scope":"distinct","kind":"message","actor":row.actor.as_deref().unwrap_or(""),"key":"","bucket":bucket,"firstSeq":seq,"expiresAt":row.expires_at};
            crate::activity_projection::defaults(
                &mut base,
                &std::collections::BTreeMap::new(),
                false,
            );
            self.update(
                &stream_activity_aggregates::INFO,
                doc! {"_id":id},
                doc! {"$setOnInsert":base},
                true,
                true,
            )
            .await?;
        }
        if !projection.distinct.is_empty() {
            let distinct: Vec<String> = projection.distinct.keys().cloned().collect();
            for row in self
                .find(
                    stream_activity_aggregates::COLLECTION,
                    doc! {"_id":{"$in":distinct},"firstSeq":seq},
                    doc! {},
                    1000,
                    2000,
                )
                .await?
            {
                if let Ok(id) = row.get_str("_id") {
                    projection.add_chatter(id);
                }
            }
        }
        projection.add_rows(&rows);
        for (id, change) in projection.changes {
            self.assert_owner(owner).await?;
            ignore_duplicate(
                self.update(
                    &stream_activity_aggregates::INFO,
                    doc! {"_id":id,"$or":[{"lastSeq":{"$lt":seq}},{"lastSeq":{"$exists":false}}]},
                    change.update(seq, self.now()),
                    true,
                    true,
                )
                .await,
            )?;
        }
        self.assert_owner(owner).await?;
        let prepared = stream_activities::INFO.prepare_update(
            &doc! {"_id":{"$in":&ids}},
            doc! {"$set":{"processed":true}},
            UpdateOptions::default(),
            &mut WriteContext::new(self.clock.now_ms()),
        )?;
        bounded(
            self.config.store_deadline,
            self.store
                .writes(stream_activities::COLLECTION)
                .update_many(&prepared),
        )
        .await?;
        self.after_write().await;
        self.assert_owner(owner).await?;
        let completed = self
            .update(
                &stream_activity_states::INFO,
                doc! {"_id":STATE,"owner":owner},
                doc! {"$unset":{"active":""},"$set":{"updatedAt":self.now()}},
                false,
                true,
            )
            .await?;
        if completed.matched == 0 {
            return Err(Error::Invalid("Timeline projection lease lost".into()));
        }
        Ok(rows.len())
    }
    pub async fn get_stream_activity(
        &self,
        channel: &str,
        session: ObjectId,
        tier: &str,
    ) -> Result<Value, Error> {
        let scope = doc! {"channelID":channel,"session_id":session,"expiresAt":{"$gt":self.now()}};
        let query = |extra: Document| {
            let mut q = scope.clone();
            q.extend(extra);
            q
        };
        let summary = self
            .find(
                stream_activity_aggregates::COLLECTION,
                query(doc! {"scope":"summary"}),
                doc! {},
                1,
                1500,
            )
            .await?
            .into_iter()
            .next();
        let commands = self
            .find(
                stream_activity_aggregates::COLLECTION,
                query(doc! {"scope":"rank","kind":"command"}),
                doc! {"count":-1,"_id":1},
                20,
                1500,
            )
            .await?;
        let emotes = self
            .find(
                stream_activity_aggregates::COLLECTION,
                query(doc! {"scope":"rank","kind":"emote"}),
                doc! {"count":-1,"_id":1},
                20,
                1500,
            )
            .await?;
        let series = self
            .find(
                stream_activity_aggregates::COLLECTION,
                query(doc! {"scope":"chart","bucket":{"$gte":0}}),
                doc! {"bucket":1},
                2001,
                1500,
            )
            .await?;
        let pending = !self
            .find(
                stream_activities::COLLECTION,
                query(doc! {"processed":false}),
                doc! {},
                1,
                1500,
            )
            .await?
            .is_empty();
        let fields = |row: &Document, names: &[(&str, &str)]| {
            let mut d = Document::new();
            for &(dest, src) in names {
                if let Some(v) = row.get(src) {
                    d.insert(dest, v.clone());
                }
            }
            dima_store::mongo::json::to_json_value(&d)
        };
        let mut command_fields = vec![("key", "key"), ("label", "label"), ("count", "count")];
        if tier != "free" {
            command_fields.push(("errors", "failures"));
        }
        let mut series_fields = vec![("messages", "messages"), ("chatters", "chatters")];
        if tier != "free" {
            series_fields.extend([("commands", "commands"), ("emotes", "emotes")]);
        }
        let date = |field: &str| {
            summary
                .as_ref()
                .and_then(|s| s.get(field))
                .and_then(dima_store::mongo::json::bson_to_json_value)
                .unwrap_or(Value::Null)
        };
        Ok(
            json!({"totals":summary.as_ref().map(|s|fields(s,&[ ("messages","messages"),("commands","commands"),("emotes","emotes"),("emoteMessages","emoteMessages"),("redemptions","redemptions"),("follows","follows"),("subs","subs"),("bits","bits"),("raids","raids")])),
        "commands":commands.iter().map(|s|fields(s,&command_fields)).collect::<Vec<_>>(),"emotes":emotes.iter().map(|s|fields(s,&[("key","key"),("label","label"),("count","count"),("messages","messages")])).collect::<Vec<_>>(),
        "series":series.iter().take(2000).map(|s|{let mut v=fields(s,&series_fields);v["offsetSeconds"]=json!(number(s,"bucket")*300.0);v}).collect::<Vec<_>>(),
        "coverageStartedAt":date("firstAt"),"chatterStartedAt":date("messageStartedAt"),"updatedAt":date("updatedAt"),"pending":pending,"truncated":series.len()>2000,"planTier":tier,
        "capabilities":{"trends":tier!="free","comparison":tier!="free","users":tier=="pro"}}),
        )
    }
}
fn number(doc: &Document, key: &str) -> f64 {
    doc.get(key)
        .and_then(dima_store::mongo::number::read_number)
        .unwrap_or(0.0)
}
fn ignore_duplicate<T>(result: Result<T, Error>) -> Result<Option<T>, Error> {
    match result {
        Ok(v) => Ok(Some(v)),
        Err(Error::Write(dima_store::mongo::write::WriteError::Driver(e)))
            if dima_store::mongo::error::is_duplicate_key(&e) =>
        {
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

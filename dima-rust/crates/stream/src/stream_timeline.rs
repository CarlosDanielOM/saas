//! Timeline participants, redemptions, moments and dashboard reads (`utils/stream_timeline.ts`).
//! Retention is 90 days and chatter buckets are five minutes. Reads retain the reference's
//! 20-row pages, 2000 snapshots, 100 raids/markers and 10000 legacy participants, including
//! their extra sentinel row. No unbounded list is introduced. Every store call has a five-second
//! wall deadline; Mongo query budgets remain 1500/3000 ms. Display labels use scalar limits.
//! Callers initialize the model registry indexes before writes (participant and marker
//! uniqueness is the durable receipt guard). Redemption lookup deliberately has no newest-session sort (unlike moments and capture).
use crate::{
    Error,
    stream_activity::{Activities, ActivityKind, Capture, Config, Session},
    timeline_store::{Store, date, json, number, text, window},
};
use bson::{Bson, DateTime, Document, doc, oid::ObjectId};
use dima_model::{stream_markers, stream_participants, stream_sessions};
use serde::Deserialize;
use serde_json::{Value, json as value};
use std::{collections::HashMap, sync::Arc};
pub const TIMELINE_RETENTION_MS: i64 = 90 * 86_400_000;
pub const TIMELINE_BUCKET_MS: i64 = 300_000;
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    #[serde(rename = "channelID")]
    pub channel_id: String,
    #[serde(rename = "sessionID")]
    pub session_id: ObjectId,
    pub started_at: DateTime,
    #[serde(rename = "userID")]
    pub user_id: String,
    pub at: DateTime,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Redemption {
    #[serde(rename = "channelID")]
    pub channel_id: String,
    pub id: String,
    pub redeemed_at: String,
    #[serde(rename = "rewardID")]
    pub reward_id: String,
    pub title: String,
    pub cost: f64,
    pub status: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Moment {
    #[serde(rename = "channelID")]
    pub channel_id: String,
    #[serde(rename = "eventID")]
    pub event_id: String,
    pub kind: ActivityKind,
    pub at: DateTime,
    pub label: String,
    pub value: Option<f64>,
}
#[derive(Clone)]
pub struct Timeline {
    store: Store,
    activity: Activities,
}
impl Timeline {
    pub fn new(
        mongo: dima_store::mongo::MongoStore,
        clock: Arc<dyn dima_core::Clock>,
    ) -> Result<Self, Error> {
        Ok(Self {
            store: Store::new(mongo.clone(), clock.clone()),
            activity: Activities::new(mongo, clock, Config::default())?,
        })
    }
    #[cfg(feature = "test-util")]
    pub fn with_write_hook(
        mut self,
        hook: Arc<dyn Fn() -> futures_util::future::BoxFuture<'static, ()> + Send + Sync>,
    ) -> Self {
        self.store.hook = Some(hook.clone());
        self.activity = self.activity.with_write_hook(hook);
        self
    }
    pub async fn record_timeline_participant(&self, input: &Participant) -> Result<(), Error> {
        if input.user_id.is_empty() || input.user_id == "698614112" || input.at < input.started_at {
            return Ok(());
        }
        let bucket = (input.at.timestamp_millis() - input.started_at.timestamp_millis())
            .div_euclid(TIMELINE_BUCKET_MS);
        self.store.update(&stream_participants::INFO,doc!{"channelID":&input.channel_id,"session_id":input.session_id,"bucket":bucket,"user_id":&input.user_id},doc!{"$setOnInsert":{"expiresAt":DateTime::from_millis(input.at.timestamp_millis()+TIMELINE_RETENTION_MS)}},true).await?;
        self.store
            .update(
                &stream_sessions::INFO,
                doc! {"_id":input.session_id,"channelID":&input.channel_id},
                doc! {"$min":{"chat_tracking_started_at":input.at}},
                false,
            )
            .await?;
        Ok(())
    }
    pub async fn record_timeline_redemption(&self, input: &Redemption) -> Result<(), Error> {
        let Some(ms) = dima_text::parse_date(&input.redeemed_at) else {
            return Ok(());
        };
        if input.id.is_empty() {
            return Ok(());
        }
        let at = DateTime::from_millis(ms);
        let collection = self.store.mongo.documents("streamsessions");
        let session = crate::bounded(
            self.store.deadline,
            collection
                .find_one(window(&input.channel_id, at, false))
                .projection(doc! {"_id":1}),
        )
        .await?;
        let Some(session) = session else {
            return Ok(());
        };
        self.store.update(&stream_markers::INFO,doc!{"channelID":&input.channel_id,"session_id":session.get("_id").cloned().unwrap_or(Bson::Null),"key":format!("redemption:{}",input.id)},doc!{"$setOnInsert":{"kind":"redemption","label":dima_text::truncate_chars(&input.title,120),"occurredAt":at,"rewardID":&input.reward_id,"cost":input.cost,"status":&input.status,"expiresAt":DateTime::from_millis(ms+TIMELINE_RETENTION_MS)}},true).await?;
        self.capture(
            &input.channel_id,
            &input.id,
            ActivityKind::Redemption,
            at,
            None,
            &input.reward_id,
            &input.title,
            None,
        )
        .await
    }
    pub async fn record_timeline_moment(&self, input: &Moment) -> Result<(), Error> {
        let sessions = self
            .store
            .find(
                "streamsessions",
                window(&input.channel_id, input.at, false),
                doc! {"started_at":-1},
                1,
                0,
                1500,
            )
            .await?;
        let Some(row) = sessions.first() else {
            return Ok(());
        };
        let session: Session = bson::deserialize_from_document(row.clone())
            .map_err(|e| Error::Invalid(e.to_string()))?;
        let kind = serde_json::to_value(input.kind)?;
        let kind = kind.as_str().unwrap_or_default();
        let label = dima_text::truncate_chars(&input.label, 120);
        let mut base = doc! {"kind":kind,"label":if label.is_empty(){kind}else{&label},"occurredAt":input.at,"expiresAt":DateTime::from_millis(input.at.timestamp_millis()+TIMELINE_RETENTION_MS)};
        if let Some(v) = input.value {
            base.insert("value", v);
        }
        self.store.update(&stream_markers::INFO,doc!{"channelID":&input.channel_id,"session_id":session.id,"key":format!("event:{}",input.event_id)},doc!{"$setOnInsert":base},true).await?;
        self.capture(
            &input.channel_id,
            &input.event_id,
            input.kind,
            input.at,
            Some(session),
            "",
            &input.label,
            input.value,
        )
        .await
    }
    #[allow(clippy::too_many_arguments)]
    async fn capture(
        &self,
        channel: &str,
        event: &str,
        kind: ActivityKind,
        at: DateTime,
        session: Option<Session>,
        key: &str,
        label: &str,
        value: Option<f64>,
    ) -> Result<(), Error> {
        self.activity
            .capture_stream_activity(&Capture {
                channel_id: channel.into(),
                event_id: event.into(),
                kind,
                occurred_at: Some(at),
                session,
                actor: String::new(),
                actor_label: String::new(),
                key: key.into(),
                label: label.into(),
                value,
                outcome: None,
                emotes: vec![],
            })
            .await
    }
    pub async fn list_timeline_streams(&self, channel: &str, page: u32) -> Result<Value, Error> {
        if page == 0 {
            return Err(Error::Invalid("page must be positive".into()));
        }
        let rows=self.store.find("streamsessions",doc!{"channelID":channel,"started_at":{"$gte":DateTime::from_millis(self.store.clock.now_ms()-TIMELINE_RETENTION_MS)}},doc!{"started_at":-1},21,u64::from(page-1)*20,3000).await?;
        Ok(
            value!({"streams":rows.iter().take(20).map(|d|{let mut r=select(d,&[("id","_id"),("startedAt","started_at"),("endedAt","ended_at"),("status","status")]);if let Some(Bson::ObjectId(id))=d.get("_id"){r.insert("id",id.to_hex());}json(&r)}).collect::<Vec<_>>(),"page":page,"hasMore":rows.len()>20}),
        )
    }
    pub async fn get_timeline_session(
        &self,
        channel: &str,
        id: ObjectId,
    ) -> Result<Option<Document>, Error> {
        let mut row=self.store.find("streamsessions",doc!{"_id":id,"channelID":channel,"started_at":{"$gte":DateTime::from_millis(self.store.clock.now_ms()-TIMELINE_RETENTION_MS)}},doc!{},1,0,1500).await?.into_iter().next();
        if let Some(row) = &mut row {
            for field in stream_sessions::HIDDEN {
                row.remove(*field);
            }
        }
        Ok(row)
    }
    pub async fn get_stream_timeline(
        &self,
        channel: &str,
        session_id: &str,
        tier: &str,
    ) -> Result<Value, Error> {
        let id = ObjectId::parse_str(session_id).map_err(|e| Error::Invalid(e.to_string()))?;
        let Some(session) = self.get_timeline_session(channel, id).await? else {
            return Ok(Value::Null);
        };
        let now = self.store.now();
        let start = date(&session, "started_at")?;
        let end = session.get_datetime("ended_at").copied().unwrap_or(now);
        let activity = self.activity.get_stream_activity(channel, id, tier).await?;
        let time = doc! {"$gte":start,"$lte":end};
        let snapshots = self
            .store
            .find(
                "streamviewersnapshots",
                doc! {"channelID":channel,"session_id":id,"captured_at":time.clone()},
                doc! {"captured_at":1},
                2001,
                0,
                3000,
            )
            .await?;
        let raids=self.store.find("domain_events",doc!{"channelID":channel,"source":"twitch-eventsub","type":"channel.raid.received","occurredAt":time,"expiresAt":{"$gt":now}},doc!{"occurredAt":1},101,0,1500).await?;
        let markers = self
            .store
            .find(
                "stream_markers",
                doc! {"channelID":channel,"session_id":id,"expiresAt":{"$gt":now}},
                doc! {"occurredAt":1,"_id":1},
                101,
                0,
                1500,
            )
            .await?;
        let projected = !activity["chatterStartedAt"].is_null();
        let participants = if projected {
            vec![]
        } else {
            self.store
                .find(
                    "stream_participants",
                    doc! {"channelID":channel,"session_id":id,"expiresAt":{"$gt":now}},
                    doc! {},
                    10001,
                    0,
                    1500,
                )
                .await?
        };
        let offset = |at: DateTime| {
            ((at.timestamp_millis() - start.timestamp_millis()) as f64 / 1000.0).max(0.0)
        };
        let mut events = Vec::<Value>::new();
        let mut points = Vec::new();
        for (index, row) in snapshots.iter().take(2000).enumerate() {
            let previous = index.checked_sub(1).and_then(|i| snapshots.get(i));
            let at = date(row, "captured_at")?;
            let seconds = (at.timestamp_millis()
                - previous
                    .map(|p| date(p, "captured_at"))
                    .transpose()?
                    .unwrap_or(start)
                    .timestamp_millis()) as f64
                / 1000.0;
            let delta = row.get("messages").map(js_number).unwrap_or(f64::NAN)
                - previous.map_or(0.0, |p| number(p, "messages"));
            let commands = row.get("commands").map(js_number).unwrap_or(f64::NAN)
                - previous.map_or(0.0, |p| number(p, "commands"));
            if let Some(prev) = previous {
                for (field, kind) in [("game_name", "game"), ("title", "title")] {
                    if row.get(field) != prev.get(field) {
                        let row_id = json(row)["_id"].as_str().unwrap_or_default().to_owned();
                        events.push(value!({"id":format!("{kind}:{row_id}"),"kind":kind,"offsetSeconds":offset(at),"label":json(row)[field]}));
                    }
                }
            }
            let mut point = select(
                row,
                &[
                    ("viewers", "viewers"),
                    ("title", "title"),
                    ("game", "game_name"),
                ],
            );
            point.insert("offsetSeconds", offset(at));
            point.insert(
                "messagesPerMinute",
                if seconds > 0.0 && delta >= 0.0 {
                    Bson::Double((delta / seconds * 600.0).round() / 10.0)
                } else {
                    Bson::Null
                },
            );
            point.insert(
                "commandsPerMinute",
                if tier != "free" && seconds > 0.0 && seconds <= 600.0 && commands >= 0.0 {
                    Bson::Double((commands / seconds * 600.0).round() / 10.0)
                } else {
                    Bson::Null
                },
            );
            point.insert("gap", previous.is_some() && seconds > 600.0);
            points.push(json(&point));
        }
        for row in raids.iter().take(100) {
            let raw = row
                .get_document("payload")
                .ok()
                .and_then(|p| p.get_document("event").ok());
            let label = raw
                .map(|r| {
                    if text(r, "from_broadcaster_user_name").is_empty() {
                        text(r, "from_broadcaster_user_login")
                    } else {
                        text(r, "from_broadcaster_user_name")
                    }
                })
                .unwrap_or_default();
            let viewers = raw
                .and_then(|r| r.get("viewers"))
                .map(js_number)
                .unwrap_or(0.0);
            events.push(value!({"id":format!("event:{}",text(row,"eventKey")),"kind":"raid","offsetSeconds":offset(date(row,"occurredAt")?),"label":label,"value":if viewers.is_nan(){0.0}else{viewers.max(0.0)}}));
        }
        for row in markers.iter().take(100) {
            let mut e = select(row, &[("kind", "kind"), ("label", "label")]);
            let raw = json(row);
            e.insert(
                "id",
                if text(row, "kind") == "raid" {
                    text(row, "key").to_owned()
                } else {
                    raw["_id"].as_str().unwrap_or_default().to_owned()
                },
            );
            e.insert("offsetSeconds", offset(date(row, "occurredAt")?));
            for field in ["value", "rewardID", "cost", "status"] {
                if (field == "value" || !text(row, "rewardID").is_empty())
                    && let Some(v) = row.get(field).filter(|v| !matches!(v, Bson::Null))
                {
                    e.insert(field, v.clone());
                }
            }
            events.push(json(&e));
        }
        let truncated = participants.len() > 10000;
        let mut counts = HashMap::<i64, f64>::new();
        if !truncated {
            for row in &participants {
                *counts.entry(number(row, "bucket") as i64).or_default() += 1.0;
            }
        }
        let tracking = activity["chatterStartedAt"]
            .as_str()
            .and_then(dima_text::parse_date)
            .map(DateTime::from_millis)
            .or_else(|| {
                session
                    .get_datetime("chat_tracking_started_at")
                    .ok()
                    .copied()
            })
            .map(offset);
        let mut projected_counts = HashMap::new();
        for row in activity["series"].as_array().into_iter().flatten() {
            if let Some(o) = row["offsetSeconds"].as_f64() {
                projected_counts
                    .insert((o / 300.0) as i64, row["chatters"].as_f64().unwrap_or(0.0));
            }
        }
        let duration = offset(end);
        let chatters=(0..((duration/300.0).ceil() as usize).min(2000)).map(|bucket|{let o=bucket as f64*300.0;value!({"offsetSeconds":o,"count":if !truncated&&tracking.is_some_and(|t|o>=t){Some(if projected{projected_counts.get(&(bucket as i64))}else{counts.get(&(bucket as i64))}.copied().unwrap_or(0.0))}else{None}})}).collect::<Vec<_>>();
        // Map.set replaces duplicates without moving their first position; stable time sorting follows.
        let mut dedup = Vec::<Value>::new();
        let mut positions = HashMap::<String, usize>::new();
        for event in events {
            let key = event["id"].as_str().unwrap_or_default().to_owned();
            if let Some(&index) = positions.get(&key) {
                dedup[index] = event;
            } else {
                positions.insert(key, dedup.len());
                dedup.push(event);
            }
        }
        dedup.sort_by(|a, b| {
            a["offsetSeconds"]
                .as_f64()
                .unwrap_or(0.0)
                .total_cmp(&b["offsetSeconds"].as_f64().unwrap_or(0.0))
        });
        let cursor = if markers.len() > 100 {
            let row = &markers[99];
            Some(format!(
                "{}|{}",
                dima_text::to_iso_string(date(row, "occurredAt")?.timestamp_millis())
                    .unwrap_or_default(),
                json(row)["_id"].as_str().unwrap_or_default()
            ))
        } else {
            None
        };
        let mut out_session = select(
            &session,
            &[
                ("startedAt", "started_at"),
                ("endedAt", "ended_at"),
                ("status", "status"),
            ],
        );
        out_session.insert("id", session_id);
        out_session.insert("durationSeconds", duration);
        Ok(
            value!({"session":json(&out_session),"points":points,"chatters":chatters,"events":dedup,"activity":activity,"markerPage":{"hasMore":markers.len()>100,"cursor":cursor},"coverage":{"retentionDays":90,"chatterTrackingStartedAt":session.get("chat_tracking_started_at").and_then(dima_store::mongo::json::bson_to_json_value).unwrap_or(Value::Null),"truncated":snapshots.len()>2000||truncated||activity["truncated"]==true||duration>600000.0,"momentsPartial":raids.len()>100||markers.len()>100},"asOf":dima_text::to_iso_string(now.timestamp_millis())}),
        )
    }
}
fn select(d: &Document, fields: &[(&str, &str)]) -> Document {
    fields
        .iter()
        .filter_map(|(dest, src)| d.get(*src).map(|v| ((*dest).to_owned(), v.clone())))
        .collect()
}
fn js_number(b: &Bson) -> f64 {
    match b {
        Bson::String(s) => dima_text::parse_number(s),
        Bson::Null => 0.0,
        Bson::Boolean(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        b => dima_store::mongo::number::read_number(b).unwrap_or(f64::NAN),
    }
}

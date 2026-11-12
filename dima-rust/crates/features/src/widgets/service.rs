//! MongoDB boundary for the DBD widget, used by routes, realtime and the feature cron.
//!
//! All mutations use the model's prepared writers. State writes compare `_id, revision`;
//! event writes also compare activation, poll writes the run ID and phase, token writes
//! the previous hash. Only owned fields are set; unknown top-level fields survive.
//! Losing a CAS reloads and recomputes. Receipts commit with their effects. Poll creation
//! runs only for the writer that committed the transition; recovery only reads Twitch.
//!
//! Intentional bounds absent from Node: requests 100 KiB/depth 32, state 4 MiB, 10,000
//! live event receipts (overflow fails delivery), effect/store deadlines in `WidgetConfig`.
//! The 1-second schedule belongs to P4-CRON-FEATURES; `settle_due` is one bounded tick.
use super::{events, model};
use crate::roulette::input::{MAX_SAFE_INTEGER, integer_number, text_str};
pub use crate::roulette::service::{ServiceError, TokenDocument};
use bson::{Bson, Document, doc};
use dima_core::{Clock, Random};
use dima_http::guard::BoxFuture;
use dima_model::{UpdateOptions, widget_channels as stored};
use dima_store::mongo::write::WriteError;
use dima_store::mongo::{
    MongoStore, WriteContext,
    number::{js_number, read_number},
};
use futures_util::TryStreamExt;
use serde_json::{Value, json};
use std::{future::IntoFuture, sync::Arc, time::Duration};
/// The poll effect implemented by the later command host; no command engine host dependency.
pub trait WidgetPolls: Send + Sync {
    /// Lookup current poll (`None`) or a specific ID. Raw Helix poll, or no data.
    fn get<'a>(
        &'a self,
        channel: &'a str,
        id: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Option<Value>, String>>;
    /// Execute `start.poll` with literal arguments, widgets scope and the pro grant.
    fn create<'a>(
        &'a self,
        channel: &'a str,
        request: PollRequest,
    ) -> BoxFuture<'a, Result<(), String>>;
}
/// Validated literal arguments for the host's `start.poll` effect.
#[derive(Clone, Debug)]
pub struct PollRequest {
    /// Poll title, including the run identity.
    pub title: String,
    /// Five localized option labels.
    pub options: Vec<String>,
    /// Poll duration.
    pub seconds: i64,
    /// Channel Points per extra vote; zero disables paid voting.
    pub points: i64,
    /// Scope name, a legacy DBD pack ID.
    pub pack_id: String,
}
/// Startup configuration; this crate never reads environment variables.
#[derive(Clone, Debug)]
pub struct WidgetConfig {
    /// Every MongoDB call; Node has no explicit timeout.
    pub store_deadline: Duration,
    /// Each host/Twitch effect, including a hung adapter.
    pub effect_deadline: Duration,
}
impl Default for WidgetConfig {
    fn default() -> Self {
        Self {
            store_deadline: Duration::from_secs(10),
            effect_deadline: Duration::from_secs(30),
        }
    }
}
/// Realtime observer tuple: revision, due time and token hash.
pub type WidgetVersion = (f64, Option<f64>, Option<String>);
/// Loaded state with the exact raw BSON retained for unchanged Mixed values.
#[derive(Clone)]
pub struct Loaded {
    /// Optimistic revision.
    pub revision: f64,
    /// Normalized state; callers must not persist it directly.
    pub state: Value,
    raw: Document,
}
/// DBD service; later routes and overlay sockets share this with the cron.
#[derive(Clone)]
pub struct WidgetService {
    mongo: MongoStore,
    clock: Arc<dyn Clock>,
    random: Arc<dyn Random>,
    polls: Arc<dyn WidgetPolls>,
    config: WidgetConfig,
}
fn invalid(message: &str) -> ServiceError {
    model::WidgetError::invalid(message).into()
}
fn busy() -> ServiceError {
    model::WidgetError::new("busy", "Widget is busy; retry with the same key", 409).into()
}
fn channel(id: &str) -> Result<(), ServiceError> {
    if id.is_empty() || id.len() > 30 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid("Invalid channel ID"));
    }
    Ok(())
}
fn hash(s: &str) -> String {
    dima_core::crypto::sha256(s).hex()
}
/// BSON to JSON, with integral JavaScript numbers represented as JSON integers.
/// This is internal; the raw BSON is retained separately for unchanged values.
pub(crate) fn from_bson(v: &Bson) -> Value {
    match v {
        Bson::Document(d) => {
            Value::Object(d.iter().map(|(k, v)| (k.clone(), from_bson(v))).collect())
        }
        Bson::Array(a) => a.iter().map(from_bson).collect(),
        v if read_number(v).is_some() => {
            let n = read_number(v).unwrap_or(0.0);
            if n.is_finite() && n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER as f64 {
                json!(n as i64)
            } else {
                json!(n)
            }
        }
        Bson::Null => Value::Null,
        Bson::Boolean(b) => (*b).into(),
        Bson::String(s) => s.clone().into(),
        other => other.clone().into_relaxed_extjson(),
    }
}
fn encode(v: &Value, old: Option<&Bson>) -> Bson {
    if let Some(old) = old.filter(|old| from_bson(old) == *v) {
        return old.clone();
    }
    match v {
        Value::Null => Bson::Null,
        Value::Bool(b) => Bson::Boolean(*b),
        Value::String(s) => Bson::String(s.clone()),
        Value::Number(n) => js_number(n.as_f64().unwrap_or(0.0)),
        Value::Array(a) => Bson::Array(
            a.iter()
                .enumerate()
                .map(|(i, v)| encode(v, old.and_then(Bson::as_array).and_then(|a| a.get(i))))
                .collect(),
        ),
        Value::Object(m) => Bson::Document(
            m.iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        encode(v, old.and_then(Bson::as_document).and_then(|d| d.get(k))),
                    )
                })
                .collect(),
        ),
    }
}
fn bound(v: &Value, bytes: usize) -> Result<(), ServiceError> {
    fn depth(v: &Value, n: usize) -> bool {
        if n > 32 {
            return false;
        }
        match v {
            Value::Array(a) => a.iter().all(|v| depth(v, n + 1)),
            Value::Object(m) => m.values().all(|v| depth(v, n + 1)),
            _ => true,
        }
    }
    if !depth(v, 0) || dima_text::to_js_json(v).len() > bytes {
        return Err(invalid("Widget data exceeds its size or depth limit"));
    }
    Ok(())
}
impl WidgetService {
    /// Wire explicit dependencies; the poll adapter is supplied by P4's host integration.
    pub fn new(
        mongo: MongoStore,
        clock: Arc<dyn Clock>,
        random: Arc<dyn Random>,
        polls: Arc<dyn WidgetPolls>,
        config: WidgetConfig,
    ) -> Self {
        Self {
            mongo,
            clock,
            random,
            polls,
            config,
        }
    }
    async fn within<T, E: std::fmt::Display>(
        &self,
        what: &str,
        future: impl IntoFuture<Output = Result<T, E>>,
    ) -> Result<T, ServiceError> {
        match tokio::time::timeout(self.config.store_deadline, future.into_future()).await {
            Ok(r) => r.map_err(ServiceError::store),
            Err(_) => Err(ServiceError::Store {
                message: format!("{what}: deadline exceeded"),
                outcome_unknown: true,
            }),
        }
    }
    async fn effect<T>(&self, future: BoxFuture<'_, Result<T, String>>) -> Result<T, String> {
        tokio::time::timeout(self.config.effect_deadline, future)
            .await
            .map_err(|_| "Widget poll deadline exceeded".to_owned())?
    }
    async fn cas(
        &self,
        id: &str,
        revision: f64,
        extra: Document,
        set: Document,
        increment: bool,
    ) -> Result<bool, ServiceError> {
        let mut filter = doc! {"_id":id,"revision":js_number(revision)};
        filter.extend(extra);
        let mut update = doc! {"$set":set};
        if increment {
            update.insert("$inc", doc! {"revision":1});
        }
        let prepared = stored::INFO.prepare_update(
            &filter,
            update,
            UpdateOptions::default(),
            &mut WriteContext::new(self.clock.now_ms()),
        )?;
        let concern = mongodb::options::WriteConcern::builder()
            .w(mongodb::options::Acknowledgment::Nodes(1))
            .journal(true)
            .build();
        let mut writes = self.mongo.writes(stored::COLLECTION).write_concern(concern);
        Ok(self
            .within("widget update", writes.update_one(&prepared))
            .await?
            .matched
            == 1)
    }
    /// Read without creating a document, validating it through the merged model.
    pub async fn read(&self, id: &str) -> Result<Option<Loaded>, ServiceError> {
        self.read_filtered(id, doc! {}).await
    }
    async fn read_filtered(
        &self,
        id: &str,
        extra: Document,
    ) -> Result<Option<Loaded>, ServiceError> {
        let mut filter = doc! {"_id":id};
        filter.extend(extra);
        channel(id)?;
        let Some(raw) = self
            .within(
                "widget read",
                self.mongo.documents(stored::COLLECTION).find_one(filter),
            )
            .await?
        else {
            return Ok(None);
        };
        let parsed: stored::WidgetChannel =
            dima_model::decode_document(&raw).map_err(ServiceError::store)?;
        let mut state = from_bson(
            raw.get("state")
                .ok_or_else(|| ServiceError::store("Widget state missing"))?,
        );
        model::normalize(&mut state)?;
        Ok(Some(Loaded {
            revision: parsed.revision.0,
            state,
            raw,
        }))
    }
    /// First use inserts the reference's defaults; duplicate `_id` means another creator won.
    pub async fn load(&self, id: &str) -> Result<Loaded, ServiceError> {
        if let Some(loaded) = self.read(id).await? {
            return Ok(loaded);
        }
        let input =
            doc! {"_id":id,"revision":0,"state":encode(&model::initial(),None),"receipts":[]};
        let prepared =
            stored::INFO.prepare_create(&input, &mut WriteContext::new(self.clock.now_ms()))?;
        let mut writes = self.mongo.writes(stored::COLLECTION);
        match tokio::time::timeout(self.config.store_deadline, writes.insert_one(&prepared)).await {
            Ok(Ok(())) => {}
            Ok(Err(WriteError::Driver(e))) if dima_store::mongo::error::is_duplicate_key(&e) => {}
            Ok(Err(e)) => return Err(e.into()),
            Err(_) => {
                return Err(ServiceError::Store {
                    message: "widget insert deadline exceeded".into(),
                    outcome_unknown: true,
                });
            }
        }
        self.read(id)
            .await?
            .ok_or_else(|| ServiceError::store("Widget disappeared after creation"))
    }
    /// Premium and Pro Twitch channel owners are entitled; no cached or environment plan.
    pub async fn has_premium(&self, id: &str) -> Result<bool, ServiceError> {
        channel(id)?;
        Ok(self.within("widget entitlement",self.mongo.documents("users").find_one(doc!{"accounts":{"$elemMatch":{"type":"twitch","id":id}},"plan_tier":{"$in":["premium","pro"]}}).projection(doc!{"_id":1})).await?.is_some())
    }
    /// Refuse a Free channel with the reference's 403.
    pub async fn require_premium(&self, id: &str) -> Result<(), ServiceError> {
        if !self.has_premium(id).await? {
            return Err(model::WidgetError::new(
                "premium_required",
                "Dead by Daylight widget requires Premium",
                403,
            )
            .into());
        }
        Ok(())
    }
    /// Execute one reference action. The caller supplies the raw idempotency key and If-Match.
    /// Returns `{replayed}`. A timeout may have committed: retry with the same key.
    pub async fn execute(
        &self,
        id: &str,
        action: &str,
        data: &Value,
        key: &str,
        revision: f64,
    ) -> Result<Value, ServiceError> {
        self.require_premium(id).await?;
        text_str(key, "Idempotency-Key", 128)?;
        integer_number(Some(revision), "If-Match", 0, MAX_SAFE_INTEGER)?;
        crate::roulette::input::object(data)?;
        bound(data, 100 * 1024)?;
        let fingerprint = hash(&dima_text::to_js_json(
            &json!({"action":action,"data":data}),
        ));
        let receipt_key = hash(key);
        for _ in 0..20 {
            let mut loaded = self.load(id).await?;
            let now = self.clock.now_ms();
            let old = from_bson(&Bson::Document(loaded.raw.clone()));
            let mut receipts: Vec<Value> = old["receipts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|r| {
                    now as f64 - r["at"].as_f64().unwrap_or(f64::NEG_INFINITY) < 86_400_000.0
                })
                .cloned()
                .collect();
            if let Some(r) = receipts.iter().find(|r| r["key"] == receipt_key) {
                if r["fingerprint"] != fingerprint {
                    return Err(model::WidgetError::new(
                        "idempotency_conflict",
                        "Key already used for a different action",
                        409,
                    )
                    .into());
                }
                return Ok(json!({"replayed":true}));
            }
            if loaded.revision != revision {
                return Err(model::WidgetError::new(
                    "revision_conflict",
                    "Widget changed; refresh before trying again",
                    409,
                )
                .into());
            }
            let event_settings = apply(&mut loaded.state, action, data, now, self.random.as_ref())?;
            bound(&loaded.state, 4 * 1024 * 1024)?;
            receipts.push(json!({"key":receipt_key,"fingerprint":fingerprint,"at":now}));
            if receipts.len() > 200 {
                receipts.drain(..receipts.len() - 200);
            }
            let mut set = doc! {"state":encode(&loaded.state,loaded.raw.get("state")),"dueAt":encode(&loaded.state["nextAt"],None),"receipts":encode(&json!(receipts),None)};
            if let Some(settings) = event_settings {
                set.insert("eventSettings", encode(&settings, None));
            }
            if self.cas(id, loaded.revision, doc! {}, set, true).await? {
                if matches!(action, "start" | "retry-poll")
                    && loaded.state["phase"] == "poll-starting"
                {
                    self.launch_poll(id, true).await?;
                }
                return Ok(json!({"replayed":false}));
            }
        }
        Err(busy())
    }
    /// Event settings and their revision, initializing the channel if necessary.
    pub async fn widget_event_settings(&self, id: &str) -> Result<Value, ServiceError> {
        let d = self.load(id).await?;
        Ok(
            json!({"revision":d.revision,"settings":d.raw.get("eventSettings").map(from_bson).unwrap_or_else(events::default_settings)}),
        )
    }
    /// Active targets only; never creates documents for inactive channels.
    pub async fn active_widget_event_targets(&self, id: &str) -> Result<Vec<Value>, ServiceError> {
        channel(id)?;
        let Some(d) = self
            .within(
                "active widget targets",
                self.mongo
                    .documents(stored::COLLECTION)
                    .find_one(
                        doc! {"_id":id,"eventSettings.enabled":true,"eventSettings.active":true},
                    )
                    .projection(doc! {"eventSettings":1}),
            )
            .await?
        else {
            return Ok(Vec::new());
        };
        let s = d.get("eventSettings").map(from_bson).unwrap_or(Value::Null);
        Ok(vec![
            json!({"id":id,"enabled":s["enabled"],"active":s["active"],"activeSince":s["activeSince"],"allowTestEvents":s["allowTestEvents"]}),
        ])
    }
    /// Apply a journal event atomically with its dedupe receipt; wrong channels do nothing.
    pub async fn apply_widget_event(
        &self,
        id: &str,
        event: &dima_events::envelope::Envelope,
    ) -> Result<(), ServiceError> {
        if event.channel_id.as_deref() != Some(id) {
            return Ok(());
        }
        text_str(&event.event_key, "event key", 256)?;
        for _ in 0..20 {
            let Some(mut d) = self
                .read_filtered(
                    id,
                    doc! {"eventSettings.enabled":true,"eventSettings.active":true},
                )
                .await?
            else {
                return Ok(());
            };
            let now = self.clock.now_ms();
            let settings = d
                .raw
                .get("eventSettings")
                .map(from_bson)
                .unwrap_or(Value::Null);
            if !events::eligible(&settings, event, now) || !self.has_premium(id).await? {
                return Ok(());
            }
            let old = d
                .raw
                .get("eventReceipts")
                .map(from_bson)
                .unwrap_or(json!([]));
            let rows = old.as_array().cloned().unwrap_or_default();
            if rows.iter().any(|r| r["key"] == event.event_key) {
                return Ok(());
            }
            if !events::apply_rules(
                &mut d.state,
                &settings["rules"],
                event,
                self.random.as_ref(),
            )? {
                return Ok(());
            }
            let mut receipts: Vec<Value> = rows
                .into_iter()
                .filter(|r| {
                    now as f64 - r["at"].as_f64().unwrap_or(f64::NEG_INFINITY) < 86_400_000.0
                })
                .collect();
            if receipts.len() >= 10000 {
                return Err(invalid("Widget event receipt capacity exceeded"));
            }
            receipts.push(json!({"key":event.event_key,"at":now}));
            bound(&d.state, 4 * 1024 * 1024)?;
            if self.cas(id,d.revision,doc!{"eventSettings.enabled":true,"eventSettings.active":true},doc!{"state":encode(&d.state,d.raw.get("state")),"eventReceipts":encode(&json!(receipts),None)},true).await?{return Ok(());}
        }
        Err(busy())
    }
    async fn launch_poll(&self, id: &str, create: bool) -> Result<(), ServiceError> {
        let Some(d) = self.read(id).await? else {
            return Ok(());
        };
        if d.state["phase"] != "poll-starting" {
            return Ok(());
        }
        if !self.has_premium(id).await? {
            return Ok(());
        }
        let s = &d.state;
        let title = s["run"]["pollTitle"].as_str().unwrap_or("");
        let result: Result<Value, String> = async {
            let mut poll = self.effect(self.polls.get(id, None)).await?;
            if (poll
                .as_ref()
                .is_none_or(|p| p["title"] != title || p["status"] == "TERMINATED"))
                && create
            {
                let label = if s["config"]["language"] == "es" {
                    "Carta"
                } else {
                    "Card"
                };
                let request = PollRequest {
                    title: title.to_owned(),
                    options: (1..=5).map(|n| format!("{label} {n}")).collect(),
                    seconds: s["config"]["pollSeconds"].as_i64().unwrap_or(30),
                    points: model::poll_points_per_vote(s).as_i64().unwrap_or(0),
                    pack_id: s["packId"].as_str().unwrap_or("").into(),
                };
                self.effect(self.polls.create(id, request)).await?;
                poll = self.effect(self.polls.get(id, None)).await?;
            }
            let p = poll
                .filter(|p| {
                    p["title"] == title
                        && p["status"] != "TERMINATED"
                        && p["choices"].as_array().is_some_and(|c| c.len() == 5)
                })
                .ok_or_else(|| {
                    "Could not confirm the widget poll. Check Twitch before retrying.".to_owned()
                })?;
            bound(&p, 100 * 1024).map_err(|_| "Invalid widget poll response".to_owned())?;
            Ok(p)
        }
        .await;
        let mut state = d.state.clone();
        let now = self.clock.now_ms();
        match result {
            Ok(p) => {
                state["phase"] = "polling".into();
                state["run"]["pollId"] = p["id"].clone();
                state["run"]["choiceIds"] = p["choices"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|c| c["id"].clone())
                    .collect();
                state["run"]["pollEndsAt"] =
                    (now + state["config"]["pollSeconds"].as_i64().unwrap_or(30) * 1000).into();
                state["run"]["error"] = Value::Null;
                state["nextAt"] = now.into();
            }
            Err(e) => {
                state["phase"] = "poll-error".into();
                state["run"]["error"] = dima_text::truncate_chars(&e, 300).into();
                state["nextAt"] = Value::Null;
            }
        }
        // Poll patches touch only poll-owned fields, but are fenced by the entire loaded revision.
        let mut set = Document::new();
        for path in ["phase", "nextAt"] {
            set.insert(format!("state.{path}"), encode(&state[path], None));
        }
        for path in ["pollId", "choiceIds", "pollEndsAt", "error"] {
            if state["run"][path] != d.state["run"][path] {
                set.insert(
                    format!("state.run.{path}"),
                    encode(&state["run"][path], None),
                );
            }
        }
        set.insert("dueAt", encode(&state["nextAt"], None));
        self.cas(
            id,
            d.revision,
            doc! {"state.run.id":encode(&s["run"]["id"],None),"state.phase":"poll-starting"},
            set,
            true,
        )
        .await?;
        Ok(())
    }
    /// Advance at most one committed timed transition, recomputing after a revision conflict.
    pub async fn advance(&self, id: &str) -> Result<(), ServiceError> {
        for _ in 0..10 {
            let mut d = self.load(id).await?;
            let now = self.clock.now_ms();
            let Some(at) = d.state["nextAt"].as_i64() else {
                return Ok(());
            };
            if at > now {
                return Ok(());
            }
            if !self.has_premium(id).await? {
                self.cas(
                    id,
                    d.revision,
                    doc! {},
                    doc! {"dueAt":js_number((now+60000) as f64)},
                    false,
                )
                .await?;
                return Ok(());
            }
            if d.state["phase"] == "poll-starting" {
                return self.launch_poll(id, false).await;
            }
            if d.state["phase"] == "polling" {
                let poll_id = d.state["run"]["pollId"].as_str();
                let result = self.effect(self.polls.get(id, poll_id)).await;
                match result {
                    Err(_) | Ok(None) => {
                        d.state["run"]["error"] = "Poll results temporarily unavailable".into();
                        d.state["nextAt"] = (now + 5000).into();
                    }
                    Ok(Some(p)) => {
                        bound(&p, 100 * 1024)?;
                        let choices = d.state["run"]["choiceIds"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default();
                        let found = p["choices"].as_array().cloned().unwrap_or_default();
                        let counts = |field: &str| -> Vec<i64> {
                            choices
                                .iter()
                                .map(|id| {
                                    found
                                        .iter()
                                        .find(|c| c["id"] == *id)
                                        .and_then(|c| {
                                            c[field]
                                                .as_f64()
                                                .filter(|n| {
                                                    n.is_finite()
                                                        && n.fract() == 0.0
                                                        && *n >= 0.0
                                                        && *n <= MAX_SAFE_INTEGER as f64
                                                })
                                                .map(|n| n as i64)
                                        })
                                        .unwrap_or(0)
                                })
                                .collect()
                        };
                        match p["status"].as_str().unwrap_or("") {
                            "COMPLETED" | "ARCHIVED" => {
                                if p["id"] != d.state["run"]["pollId"]
                                    || choices
                                        .iter()
                                        .any(|id| !found.iter().any(|c| c["id"] == *id))
                                {
                                    d.state["phase"] = "poll-error".into();
                                    d.state["run"]["error"] =
                                        "Unexpected Twitch poll result. No card was revealed."
                                            .into();
                                    d.state["nextAt"] = Value::Null;
                                } else {
                                    d.state["run"]["channelPointsVotes"] =
                                        json!(counts("channelPointsVotes"));
                                    model::reveal(
                                        &mut d.state,
                                        &counts("votes"),
                                        now,
                                        self.random.as_ref(),
                                    )?;
                                }
                            }
                            "TERMINATED" => {
                                d.state["phase"] = "poll-error".into();
                                d.state["run"]["error"] =
                                    "The Twitch poll was canceled. No card was revealed.".into();
                                d.state["nextAt"] = Value::Null;
                            }
                            _ => {
                                d.state["run"]["votes"] = json!(counts("votes"));
                                d.state["run"]["channelPointsVotes"] =
                                    json!(counts("channelPointsVotes"));
                                d.state["run"]["error"] = Value::Null;
                                d.state["nextAt"] = (now + 3000).into();
                            }
                        }
                    }
                }
            } else if !model::settle(&mut d.state, now, self.random.as_ref())? {
                return Ok(());
            }
            bound(&d.state, 4 * 1024 * 1024)?;
            if self.cas(id,d.revision,doc!{},doc!{"state":encode(&d.state,d.raw.get("state")),"dueAt":encode(&d.state["nextAt"],None)},true).await?{if d.state["phase"]=="poll-starting"{self.launch_poll(id,true).await?;}return Ok(());}
        }
        Ok(())
    }
    /// Snapshot after advancing; routes must authorize the caller separately.
    pub async fn snapshot(&self, id: &str) -> Result<Value, ServiceError> {
        self.advance(id).await?;
        let mut d = self.load(id).await?;
        let mut out = json!({"revision":d.revision,"serverTime":self.clock.now_ms()});
        if let Some(map) = out.as_object_mut() {
            map.extend(
                crate::roulette::input::object(&model::public_state(&mut d.state)?)?.clone(),
            );
        }
        Ok(out)
    }
    /// The cron tick: up to ten due channels, sorted by deadline, no sleeps or socket work.
    pub async fn settle_due(&self) -> Result<(), ServiceError> {
        let rows:Vec<Document>=self.within("widget due scan",async{self.mongo.documents(stored::COLLECTION).find(doc!{"dueAt":{"$ne":Bson::Null,"$lte":js_number(self.clock.now_ms() as f64)}}).projection(doc!{"_id":1}).sort(doc!{"dueAt":1}).limit(10).await?.try_collect::<Vec<Document>>().await}).await?;
        for row in rows {
            self.advance(row.get_str("_id").map_err(ServiceError::store)?)
                .await?;
        }
        Ok(())
    }
    /// Revision, next deadline and token hash for P4-RT-SOCKETS' 500 ms observer.
    /// This read never creates a document or advances its state.
    pub async fn version(&self, id: &str) -> Result<Option<WidgetVersion>, ServiceError> {
        channel(id)?;
        Ok(self
            .within(
                "widget version",
                self.mongo
                    .documents(stored::COLLECTION)
                    .find_one(doc! {"_id":id})
                    .projection(doc! {"revision":1,"dueAt":1,"tokenHash":1}),
            )
            .await?
            .map(|d| {
                (
                    d.get("revision").and_then(read_number).unwrap_or(0.0),
                    d.get("dueAt").and_then(read_number),
                    d.get_str("tokenHash").ok().map(str::to_owned),
                )
            }))
    }
    /// Token store read for P4-FEAT-OVERLAYS; entitlement is checked here.
    pub async fn token_document(&self, id: &str) -> Result<TokenDocument, ServiceError> {
        self.require_premium(id).await?;
        let d = self.load(id).await?;
        Ok(TokenDocument {
            token_hash: d.raw.get_str("tokenHash").ok().map(str::to_owned),
            overlay_token: d
                .raw
                .get("overlayToken")
                .filter(|b| !matches!(b, Bson::Null))
                .cloned(),
        })
    }
    /// Save an already hashed and encrypted token. Compare both revision and previous hash.
    /// `replace` increments the revision; legacy recovery preserves it, as Node does.
    pub async fn save_token(
        &self,
        id: &str,
        expected_hash: Option<&str>,
        token_hash: &str,
        encrypted: Bson,
        replace: bool,
    ) -> Result<bool, ServiceError> {
        self.require_premium(id).await?;
        if token_hash.len() != 64 || !token_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(invalid("Invalid token hash"));
        }
        let d = self.load(id).await?;
        let actual = d.raw.get_str("tokenHash").ok();
        if actual != expected_hash {
            return Ok(false);
        }
        let json = from_bson(&encrypted);
        bound(&json, 4096)?;
        self.cas(
            id,
            d.revision,
            doc! {"tokenHash":expected_hash.map_or(Bson::Null,Bson::from)},
            doc! {"tokenHash":token_hash,"overlayToken":encrypted},
            replace,
        )
        .await
    }
    /// Overlay handshake validation; the shared token helper owns best-effort legacy recovery.
    pub async fn authorize_overlay(&self, id: &str, token: &str) -> Result<bool, ServiceError> {
        if channel(id).is_err()
            || token.len() != 43
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Ok(false);
        }
        if !self.has_premium(id).await? {
            return Ok(false);
        }
        Ok(self
            .within(
                "widget overlay token",
                self.mongo
                    .documents(stored::COLLECTION)
                    .find_one(doc! {"_id":id,"tokenHash":hash(token)})
                    .projection(doc! {"_id":1}),
            )
            .await?
            .is_some())
    }
}
fn apply(
    s: &mut Value,
    action: &str,
    data: &Value,
    now: i64,
    random: &dyn Random,
) -> Result<Option<Value>, ServiceError> {
    let fields = crate::roulette::input::object(data)?;
    if ![
        "select",
        "configure",
        "start",
        "role",
        "layout",
        "progress",
        "events",
    ]
    .contains(&action)
        && !fields.is_empty()
    {
        return Err(invalid("This action does not accept settings"));
    }
    match action {
        "events" => return Ok(Some(events::settings(data, now)?)),
        "select" => {
            model::idle(s)?;
            if fields.keys().any(|k| k != "packId") {
                return Err(invalid("Unknown field"));
            }
            let id = crate::roulette::input::text(data.get("packId"), "packId", 120)?;
            s["packId"] = model::pack(&id)?["id"].clone();
            s["phase"] = "idle".into();
            s["run"] = Value::Null;
            s["nextAt"] = Value::Null;
        }
        "configure" => {
            model::idle(s)?;
            let mut merged = crate::roulette::input::object(&s["config"])?.clone();
            merged.extend(fields.clone());
            s["config"] = model::config(&merged.into())?;
            for role in ["killer", "survivor"] {
                s["wins"][role] = s["wins"][role]
                    .as_i64()
                    .unwrap_or(0)
                    .min(s["config"]["targets"][role].as_i64().unwrap_or(0))
                    .into();
            }
        }
        "role" => {
            model::idle(s)?;
            if fields.keys().any(|k| k != "role")
                || !matches!(data["role"].as_str(), Some("killer" | "survivor"))
            {
                return Err(invalid("Choose killer or survivor"));
            }
            s["packId"] = format!("dbd-{}-challenge", data["role"].as_str().unwrap_or("")).into();
            s["phase"] = "idle".into();
            s["run"] = Value::Null;
            s["nextAt"] = Value::Null;
        }
        "layout" => s["config"]["layout"] = model::layout(data)?,
        "progress" => {
            if fields
                .keys()
                .any(|k| !matches!(k.as_str(), "role" | "delta"))
                || !matches!(data["role"].as_str(), Some("killer" | "survivor"))
                || !matches!(data["delta"].as_f64(), Some(-1.0 | 1.0))
            {
                return Err(invalid("Invalid progress change"));
            }
            let role = data["role"].as_str().unwrap_or("");
            let wins = s["wins"][role].as_i64().unwrap_or(0);
            let target = s["config"]["targets"][role].as_i64().unwrap_or(0);
            s["wins"][role] = (wins + data["delta"].as_f64().unwrap_or(0.0) as i64)
                .clamp(0, target)
                .into();
        }
        "start" => {
            if fields.keys().any(|k| k != "mode")
                || data.get("mode").is_some_and(|v| {
                    !matches!(
                        v.as_str(),
                        Some("challenge" | "characters" | "perks" | "poll")
                    )
                })
            {
                return Err(invalid("Unknown widget operation"));
            }
            model::start(s, now, data["mode"].as_str(), random)?;
        }
        "show" => s["visible"] = true.into(),
        "hide" => s["visible"] = false.into(),
        "reset" => {
            if model::active(s) {
                return Err(model::WidgetError::new(
                    "busy",
                    "Wait for the current challenge to finish",
                    409,
                )
                .into());
            }
            s["phase"] = "idle".into();
            s["run"] = Value::Null;
            s["nextAt"] = Value::Null;
        }
        "retry-poll" => {
            if s["phase"] != "poll-error" || s["run"].is_null() {
                return Err(invalid("No failed poll to retry"));
            }
            s["phase"] = "poll-starting".into();
            s["nextAt"] = (now + 30000).into();
            s["run"]["error"] = Value::Null;
        }
        _ => return Err(invalid("Unknown widget action")),
    }
    Ok(None)
}

impl std::fmt::Debug for WidgetService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WidgetService")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}
impl dima_events::consumer::Handler for WidgetService {
    fn handle<'a>(
        &'a self,
        event: &'a dima_events::envelope::Envelope,
        _context: &'a dima_events::consumer::DeliveryContext,
    ) -> futures_util::future::BoxFuture<'a, dima_events::consumer::Outcome> {
        Box::pin(async move {
            use dima_events::consumer::Outcome;
            if event.topic != "channel"
                || event.schema_version != 1.0
                || !matches!(
                    event.source.as_str(),
                    "twitch-eventsub" | "twitch-eventsub-test"
                )
                || event.kind != "channel.bits.received"
            {
                return Outcome::Done;
            }
            let Some(channel) = event.channel_id.as_deref() else {
                return Outcome::Done;
            };
            match self.apply_widget_event(channel, event).await {
                Ok(()) => Outcome::Done,
                Err(e) => Outcome::Failed(e.to_string()),
            }
        })
    }
}

impl std::fmt::Debug for Loaded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Loaded")
            .field("revision", &self.revision)
            .finish_non_exhaustive()
    }
}

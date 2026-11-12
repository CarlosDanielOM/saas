//! `roulette/service.ts`: one `roulette_channels` document per channel is the atomic boundary
//! between the API, the bot and the cron.
//!
//! # Writes, and what each compares
//!
//! | Writer | Filter (what it compares) | What it sets |
//! |---|---|---|
//! | [`RouletteService::execute`] | `{_id, revision}` | `$set {actions, actionDueAt, state, dueAt, receipts}`, `$inc {revision: 1}` |
//! | [`RouletteService::snapshot`] (only when a draw completes or hides) | `{_id, revision}` | `$set {state, dueAt}`, `$inc {revision: 1}` |
//! | `claim_action` (`actions.rs`) | `{_id, revision}` | `$set {actions, actionDueAt}`, `$inc {revision: 1}` |
//! | `finish_action` (`actions.rs`) | `{_id, actions: {$elemMatch: {drawId, status: running}}}` | `actions.$.status`, `actions.$.finishedAt`, `$inc {revision: 1}` |
//! | [`RouletteService::save_token`] | `{_id, tokenHash: expected}` | `tokenHash`, `overlayToken` (and `$inc revision` on a replacement) |
//! | load (first use of a channel) | unique `_id` (a duplicate is ignored) | the empty document |
//! | native completion worker (P2-CRON-01) | `{_id, revision}` | `$set {state, dueAt}`, `$inc {revision: 1 (int32)}` |
//!
//! Every read-modify-write reloads and recomputes after a lost compare-and-set (20 attempts,
//! then 409 `busy`), so a winner drawn, completed or removed is decided by the one write that
//! won: a completion (winner removal, history) is part of the same write as the state it was
//! computed from, and a draw is stored with its winner action in one write.
//!
//! # Differences from the reference, on purpose
//!
//! - A store call that gets no answer within [`RouletteConfig::deadline`] is
//!   [`ServiceError::Store`] with `outcome_unknown` (the write may have landed); the caller
//!   retries with the same idempotency key, which replays the receipt.
//! - The state is a closed shape (the fields every writer stores, all the production copy
//!   holds): an unknown field inside `state` would not survive a write (none exists).
//! - Text limits count characters.

use std::sync::Arc;
use std::time::Duration;

use bson::{Bson, Document, doc};
use dima_core::{Clock, Random};
use dima_engine::syntax::SyntaxEngine;
use dima_model::roulette_channels::{
    self as stored, NewRouletteChannel, RouletteChannel, RouletteChannelStateContent,
};
use dima_model::values::Nullable;
use dima_model::{Private, UpdateOptions};
use dima_store::mongo::number::{JsNumber, js_number, read_number};
use dima_store::mongo::write::WriteError;
use dima_store::mongo::{MongoStore, WriteContext};
use serde_json::{Map, Value};

use super::input::{RouletteError, integer_number, text_str};
use super::model::{self, State};

/// Compare-and-set attempts of one operation.
pub const CAS_ATTEMPTS: usize = 20;
/// How long an idempotency receipt is honoured.
pub const RECEIPT_MS: f64 = 86_400_000.0;
/// Receipts kept.
pub const RECEIPTS_KEPT: usize = 200;
/// Finished winner actions kept (pending and running ones are all kept).
pub const FINISHED_ACTIONS_KEPT: usize = 100;
/// Pending and running winner actions allowed.
pub const MAX_OPEN_ACTIONS: usize = 100;
/// `JSON.stringify(state)` bytes allowed.
pub const MAX_STATE_BYTES: usize = 4 * 1024 * 1024;

/// Typed configuration.
#[derive(Clone, Debug)]
pub struct RouletteConfig {
    /// Deadline of each MongoDB call (the reference has none; Mongoose gives up buffering
    /// after 10 s).
    pub deadline: Duration,
    /// Deadline of one winner action's delivery (the reference has none).
    pub action_deadline: Duration,
}

impl Default for RouletteConfig {
    fn default() -> Self {
        Self {
            deadline: Duration::from_secs(10),
            action_deadline: Duration::from_secs(60),
        }
    }
}

/// What a roulette call can fail with.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ServiceError {
    /// The reference's refusal (code, message, status).
    #[error(transparent)]
    Refused(#[from] RouletteError),
    /// The store failed: the route's 500 `internal` ("Roulette operation failed"), the host
    /// functions' "storage temporarily unavailable".
    #[error("roulette store: {message}")]
    Store {
        /// What failed (no secrets, no user text).
        message: String,
        /// The write may have been applied (a deadline expired after it was sent).
        outcome_unknown: bool,
    },
}

impl ServiceError {
    pub(crate) fn store(message: impl std::fmt::Display) -> Self {
        Self::Store {
            message: message.to_string(),
            outcome_unknown: false,
        }
    }

    /// The refusal, if it is one.
    pub fn refused(&self) -> Option<&RouletteError> {
        match self {
            Self::Refused(error) => Some(error),
            Self::Store { .. } => None,
        }
    }
}

impl From<WriteError> for ServiceError {
    fn from(error: WriteError) -> Self {
        Self::store(error)
    }
}

impl From<dima_model::ModelError> for ServiceError {
    fn from(error: dima_model::ModelError) -> Self {
        Self::store(error)
    }
}

/// `Operation`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    /// Create a roulette.
    Create,
    /// Change its settings.
    Configure,
    /// Delete it.
    Delete,
    /// Add an item.
    Add,
    /// Import items.
    Import,
    /// Update an item.
    Update,
    /// Remove an item.
    Remove,
    /// Shuffle the copies.
    Shuffle,
    /// Make it the active one.
    Switch,
    /// Show the overlay.
    Show,
    /// Hide the overlay.
    Hide,
    /// Draw.
    Start,
}

impl Operation {
    /// The reference's name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Configure => "configure",
            Self::Delete => "delete",
            Self::Add => "add",
            Self::Import => "import",
            Self::Update => "update",
            Self::Remove => "remove",
            Self::Shuffle => "shuffle",
            Self::Switch => "switch",
            Self::Show => "show",
            Self::Hide => "hide",
            Self::Start => "start",
        }
    }

    /// From the reference's name.
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "create" => Self::Create,
            "configure" => Self::Configure,
            "delete" => Self::Delete,
            "add" => Self::Add,
            "import" => Self::Import,
            "update" => Self::Update,
            "remove" => Self::Remove,
            "shuffle" => Self::Shuffle,
            "switch" => Self::Switch,
            "show" => Self::Show,
            "hide" => Self::Hide,
            "start" => Self::Start,
            _ => return None,
        })
    }
}

/// `Action`: what a caller asks, as the route and the host functions build it (the key order
/// of its JSON, `operation, roulette, itemId, data`, feeds the receipt fingerprint).
#[derive(Clone, Debug, PartialEq)]
pub struct Action {
    /// The operation.
    pub operation: Operation,
    /// The roulette id or alias (`None`: the active one).
    pub roulette: Option<String>,
    /// The item.
    pub item_id: Option<String>,
    /// The body (settings, an item, an import).
    pub data: Option<Map<String, Value>>,
}

impl Action {
    /// An action with no roulette, item or data.
    pub fn new(operation: Operation) -> Self {
        Self {
            operation,
            roulette: None,
            item_id: None,
            data: None,
        }
    }

    fn to_json(&self, actor: Option<&DrawActor>) -> Value {
        let mut object = Map::new();
        object.insert("operation".into(), Value::from(self.operation.as_str()));
        if let Some(roulette) = &self.roulette {
            object.insert("roulette".into(), Value::from(roulette.clone()));
        }
        if let Some(item) = &self.item_id {
            object.insert("itemId".into(), Value::from(item.clone()));
        }
        if let Some(data) = &self.data {
            object.insert("data".into(), Value::Object(data.clone()));
        }
        if let Some(actor) = actor {
            object.insert("actor".into(), actor.to_json());
        }
        Value::Object(object)
    }

    fn data_field(&self, key: &str) -> Option<&Value> {
        self.data.as_ref().and_then(|d| d.get(key))
    }
}

/// `DrawActor`: who started a draw (from the authenticated API or the command's context only).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DrawActor {
    /// Twitch id (at most 100 characters).
    pub user_id: String,
    /// Login (at most 100).
    pub user_login: String,
    /// Display name (at most 120).
    pub user_display_name: String,
    /// The command's argument (at most 2000), set by the host function only.
    pub argument: Option<String>,
}

impl DrawActor {
    fn to_json(&self) -> Value {
        let mut actor = Map::new();
        actor.insert("userId".into(), Value::from(self.user_id.clone()));
        actor.insert("userLogin".into(), Value::from(self.user_login.clone()));
        actor.insert(
            "userDisplayName".into(),
            Value::from(self.user_display_name.clone()),
        );
        if let Some(argument) = &self.argument {
            actor.insert("argument".into(), Value::from(argument.clone()));
        }
        Value::Object(actor)
    }

    fn to_bson(&self) -> Bson {
        let mut actor = doc! {
            "userId": self.user_id.clone(),
            "userLogin": self.user_login.clone(),
            "userDisplayName": self.user_display_name.clone(),
        };
        if let Some(argument) = &self.argument {
            actor.insert("argument", argument.clone());
        }
        Bson::Document(actor)
    }

    /// A stored actor (`actions.$.actor`), as `job.actor?.userId ? job.actor : owner` reads it.
    pub fn from_bson(value: &Bson) -> Option<Self> {
        let actor = value.as_document()?;
        let text = |key: &str| actor.get_str(key).ok().map(str::to_owned);
        Some(Self {
            user_id: text("userId")?,
            user_login: text("userLogin").unwrap_or_default(),
            user_display_name: text("userDisplayName").unwrap_or_default(),
            argument: text("argument"),
        })
    }
}

/// What [`RouletteService::execute`] answers: `{ revision, result, replayed }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Executed {
    /// The revision after the write (or the stored one, for a replay).
    pub revision: i64,
    /// The operation's result (an id, an import count, or empty).
    pub result: String,
    /// Whether an idempotency receipt answered.
    pub replayed: bool,
}

impl Executed {
    /// As JSON.
    pub fn to_json(&self) -> Value {
        serde_json::json!({ "revision": self.revision, "result": self.result, "replayed": self.replayed })
    }
}

/// `WinnerAction` (`roulette/action-model.ts`).
#[derive(Clone, Debug, PartialEq)]
pub struct WinnerAction {
    /// The draw.
    pub draw_id: String,
    /// Its roulette.
    pub roulette_id: String,
    /// The winning item.
    pub item_id: String,
    /// Its label.
    pub label: String,
    /// The action's command language.
    pub source: String,
    /// When it runs (the end of the spin).
    pub due_at: f64,
    /// `pending` | `running` | `done` | `failed` | `skipped`.
    pub status: String,
    /// Who drew (raw: stored values of any shape survive).
    pub actor: Option<Bson>,
    /// When it was claimed.
    pub started_at: Option<f64>,
    /// When it finished.
    pub finished_at: Option<f64>,
}

impl WinnerAction {
    fn from_stored(entry: &stored::RouletteChannelActionsEntry) -> Self {
        Self {
            draw_id: entry.draw_id.clone(),
            roulette_id: entry.roulette_id.clone(),
            item_id: entry.item_id.clone(),
            label: entry.label.expose().clone(),
            source: entry.source.expose().clone(),
            due_at: entry.due_at.0,
            status: entry.status.clone(),
            actor: entry.actor.as_ref().map(|a| a.expose().0.clone()),
            started_at: entry.started_at.map(|n| n.0),
            finished_at: entry.finished_at.map(|n| n.0),
        }
    }

    pub(crate) fn to_bson(&self) -> Bson {
        let mut entry = doc! {
            "drawId": self.draw_id.clone(),
            "rouletteId": self.roulette_id.clone(),
            "itemId": self.item_id.clone(),
            "label": self.label.clone(),
            "source": self.source.clone(),
            "dueAt": js_number(self.due_at),
            "status": self.status.clone(),
        };
        if let Some(actor) = &self.actor {
            entry.insert("actor", actor.clone());
        }
        if let Some(at) = self.started_at {
            entry.insert("startedAt", js_number(at));
        }
        if let Some(at) = self.finished_at {
            entry.insert("finishedAt", js_number(at));
        }
        Bson::Document(entry)
    }

    fn open(&self) -> bool {
        self.status == "pending" || self.status == "running"
    }
}

/// `actionDue(actions)`: the earliest pending deadline.
pub fn action_due(actions: &[WinnerAction]) -> Option<f64> {
    actions
        .iter()
        .filter(|a| a.status == "pending")
        .map(|a| a.due_at)
        .reduce(f64::min)
}

/// A receipt (`receipts.$`).
#[derive(Clone, Debug, PartialEq)]
struct Receipt {
    key: String,
    fingerprint: String,
    result: String,
    at: f64,
}

/// One channel's document as the service reads it.
#[derive(Clone, Debug)]
pub struct Loaded {
    /// `revision` (a JavaScript number).
    pub revision: f64,
    /// `state`.
    pub state: State,
    /// `actions`.
    pub actions: Vec<WinnerAction>,
    receipts: Vec<Receipt>,
    /// `tokenHash`.
    pub token_hash: Option<String>,
    /// `dueAt`.
    pub due_at: Option<f64>,
}

/// `{ revision, serverTime, ...state, actionRuns }`.
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    /// The revision.
    pub revision: i64,
    /// The server's clock when it answered.
    pub server_time: i64,
    /// The state.
    pub state: State,
    /// The last 100 winner actions' `{ drawId, status }`.
    pub action_runs: Vec<(String, String)>,
}

impl Snapshot {
    /// The JSON the route and the dashboard read.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("revision".into(), Value::from(self.revision));
        object.insert("serverTime".into(), Value::from(self.server_time));
        if let Value::Object(state) = self.state.to_json() {
            object.extend(state);
        }
        let runs = self
            .action_runs
            .iter()
            .map(|(draw, status)| serde_json::json!({ "drawId": draw, "status": status }))
            .collect();
        object.insert("actionRuns".into(), Value::Array(runs));
        Value::Object(object)
    }

    /// `overlaySnapshot`: what an OBS token may see (no item actions).
    pub fn overlay_json(&self) -> Value {
        let active = self
            .state
            .roulettes
            .iter()
            .find(|r| Some(&r.id) == self.state.active_id.as_ref());
        let roulette = active.map_or(Value::Null, |r| {
            let mut value = serde_json::to_value(r).unwrap_or(Value::Null);
            if let Some(items) = value.get_mut("items").and_then(Value::as_array_mut) {
                for item in items {
                    if let Some(item) = item.as_object_mut() {
                        item.shift_remove("action");
                    }
                }
            }
            value
        });
        let state = self.state.to_json();
        serde_json::json!({
            "revision": self.revision,
            "serverTime": self.server_time,
            "visible": self.state.visible,
            "roulette": roulette,
            "draw": state["draw"],
            "hideAt": state["hideAt"],
        })
    }
}

/// The stored overlay token fields (`tokenHash`, `overlayToken`), for P4-FEAT-OVERLAYS's
/// `manageOverlayToken` / `readOverlayToken` / `rememberOverlayToken`.
#[derive(Clone, Debug, PartialEq)]
pub struct TokenDocument {
    /// `tokenHash`.
    pub token_hash: Option<String>,
    /// `overlayToken` (`{ iv, content }`, encrypted), raw.
    pub overlay_token: Option<Bson>,
}

/// The roulettes of every channel.
#[derive(Clone)]
pub struct RouletteService {
    pub(crate) mongo: MongoStore,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) random: Arc<dyn Random>,
    syntax: Arc<SyntaxEngine>,
    pub(crate) config: RouletteConfig,
}

/// `channel(value)`: `text(value, 'channel', 100)`; the raw id stays the key.
fn check_channel(channel: &str) -> Result<(), RouletteError> {
    text_str(channel, "channel", 100).map(|_| ())
}

fn sha256_hex(text: &str) -> String {
    dima_core::crypto::sha256(text).hex()
}

impl RouletteService {
    /// A service over `mongo`; `syntax` validates item actions (syntax only).
    pub fn new(
        mongo: MongoStore,
        clock: Arc<dyn Clock>,
        random: Arc<dyn Random>,
        syntax: Arc<SyntaxEngine>,
        config: RouletteConfig,
    ) -> Self {
        Self {
            mongo,
            clock,
            random,
            syntax,
            config,
        }
    }

    pub(crate) async fn within<T, E: std::fmt::Display>(
        &self,
        what: &str,
        future: impl IntoFuture<Output = Result<T, E>>,
    ) -> Result<T, ServiceError> {
        match tokio::time::timeout(self.config.deadline, future.into_future()).await {
            Ok(result) => result.map_err(ServiceError::store),
            Err(_) => Err(ServiceError::Store {
                message: format!(
                    "{what}: no answer within {} ms",
                    self.config.deadline.as_millis()
                ),
                outcome_unknown: true,
            }),
        }
    }

    /// A conditional update; `true` when it modified the document.
    pub(crate) async fn update(
        &self,
        what: &str,
        filter: Document,
        update: Document,
    ) -> Result<bool, ServiceError> {
        let mut ctx = WriteContext::new(self.clock.now_ms());
        let prepared =
            stored::INFO.prepare_update(&filter, update, UpdateOptions::default(), &mut ctx)?;
        let mut writes = self.mongo.writes(stored::COLLECTION);
        let outcome = self.within(what, writes.update_one(&prepared)).await?;
        Ok(outcome.modified > 0)
    }

    /// The stored document, or `None` (no document is created).
    pub async fn read(&self, channel: &str) -> Result<Option<Loaded>, ServiceError> {
        let raw = self
            .within(
                "roulette_channels.findById",
                self.mongo
                    .collection::<bson::RawDocumentBuf>(stored::COLLECTION)
                    .find_one(doc! { "_id": channel }),
            )
            .await?;
        let Some(raw) = raw else {
            return Ok(None);
        };
        let document: RouletteChannel = dima_model::decode(&raw).map_err(ServiceError::store)?;
        let state = match &document.state {
            Some(state) => State::from_bson(&state.expose().0).map_err(ServiceError::store)?,
            None => return Err(ServiceError::store("roulette channel without a state")),
        };
        Ok(Some(Loaded {
            revision: document.revision.0,
            state,
            actions: document
                .actions
                .expose()
                .iter()
                .flatten()
                .map(WinnerAction::from_stored)
                .collect(),
            receipts: document
                .receipts
                .iter()
                .flatten()
                .map(|r| Receipt {
                    key: r.key.clone(),
                    fingerprint: r.fingerprint.clone(),
                    result: r.result.clone(),
                    at: r.at.0,
                })
                .collect(),
            token_hash: document.token_hash.map(|t| t.expose().clone()),
            due_at: document.due_at.map(|n| n.0),
        }))
    }

    /// `load(channelId)`: the document, created empty on first use.
    pub async fn load(&self, channel: &str) -> Result<Loaded, ServiceError> {
        check_channel(channel)?;
        if let Some(loaded) = self.read(channel).await? {
            return Ok(loaded);
        }
        let empty = State::default().to_bson().map_err(ServiceError::store)?;
        let insert = NewRouletteChannel {
            actions: None,
            action_due_at: None,
            id: channel.to_owned(),
            revision: JsNumber(0.0),
            state: Private::from(RouletteChannelStateContent(Bson::Document(empty))),
            token_hash: Nullable::Null,
            overlay_token: None,
            due_at: Nullable::Null,
            receipts: Some(Vec::new()),
        }
        .prepare(&mut WriteContext::new(self.clock.now_ms()))?;
        let mut writes = self.mongo.writes(stored::COLLECTION);
        match tokio::time::timeout(self.config.deadline, writes.insert_one(&insert)).await {
            Ok(Ok(())) => {}
            Ok(Err(WriteError::Driver(error)))
                if dima_store::mongo::error::is_duplicate_key(&error) => {}
            Ok(Err(error)) => return Err(error.into()),
            Err(_) => {
                return Err(ServiceError::Store {
                    message: "roulette_channels.create: no answer in time".into(),
                    outcome_unknown: true,
                });
            }
        }
        self.read(channel)
            .await?
            .ok_or_else(|| ServiceError::store("roulette channel missing after creation"))
    }

    /// The syntax check of item actions (`parse(source).error`).
    fn check_actions(&self, action: &Action) -> Result<(), RouletteError> {
        if matches!(action.operation, Operation::Add | Operation::Update)
            && let Some(source) = action.data_field("action")
        {
            let source = super::input::action_source(source)?;
            if !source.is_empty() && self.syntax.parse(&source).is_err() {
                return Err(RouletteError::invalid_action(
                    "Invalid AST syntax in item action",
                    None,
                ));
            }
        }
        if action.operation == Operation::Import
            && let Some(Value::Array(items)) = action.data_field("items")
        {
            for (i, entry) in items.iter().enumerate() {
                if let Some(Value::String(source)) = entry.get("action") {
                    let trimmed = dima_text::trim(source);
                    if !trimmed.is_empty()
                        && dima_text::char_len(source) <= super::input::MAX_ACTION_CHARS
                        && self.syntax.parse(trimmed).is_err()
                    {
                        return Err(RouletteError::invalid_action(
                            &format!("Prize {}: Invalid AST syntax in item action", i + 1),
                            Some(i + 1),
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    /// `execute(channelId, action, requestKey, expectedRevision, actor)`: one operation on the
    /// channel's roulettes, by revision, idempotent per `request_key` for 24 hours.
    pub async fn execute(
        &self,
        channel: &str,
        action: &Action,
        request_key: Option<&str>,
        expected_revision: Option<f64>,
        actor: Option<&DrawActor>,
    ) -> Result<Executed, ServiceError> {
        self.check_actions(action)?;
        if let Some(actor) = actor {
            let long = |text: &str, max: usize| dima_text::char_len(text) > max;
            if long(&actor.user_id, 100)
                || long(&actor.user_login, 100)
                || long(&actor.user_display_name, 120)
                || actor.argument.as_deref().is_some_and(|a| long(a, 2000))
            {
                return Err(RouletteError::invalid("Invalid draw actor").into());
            }
        }
        if let Some(key) = request_key {
            text_str(key, "Idempotency-Key", 128)?;
        }
        if let Some(revision) = expected_revision {
            integer_number(
                Some(revision),
                "revision",
                0,
                super::input::MAX_SAFE_INTEGER,
            )?;
        }
        let fingerprint = sha256_hex(&dima_text::to_js_json(&action.to_json(actor)));
        let receipt_key = request_key.map(sha256_hex);
        for _ in 0..CAS_ATTEMPTS {
            let mut doc = self.load(channel).await?;
            let now = self.clock.now_ms() as f64;
            if let Some(key) = &receipt_key
                && let Some(receipt) = doc
                    .receipts
                    .iter()
                    .find(|r| &r.key == key && now - r.at < RECEIPT_MS)
            {
                if receipt.fingerprint != fingerprint {
                    return Err(RouletteError::new(
                        "idempotency_conflict",
                        "Idempotency key was used for a different action",
                        409,
                    )
                    .into());
                }
                return Ok(Executed {
                    revision: doc.revision as i64,
                    result: receipt.result.clone(),
                    replayed: true,
                });
            }
            if expected_revision.is_some_and(|r| r != doc.revision) {
                return Err(RouletteError::new(
                    "revision_conflict",
                    "State changed; refresh before saving",
                    409,
                )
                .into());
            }
            model::settle(&mut doc.state, now);
            let result = apply(&mut doc.state, action, now, self.random.as_ref())?;
            let mut actions = doc.actions;
            if action.operation == Operation::Start
                && let Some(draw) = doc.state.draw.as_ref()
            {
                let roulette = model::find(&doc.state, Some(&draw.roulette_id))?;
                let winner = roulette
                    .items
                    .iter()
                    .find(|i| i.id == draw.winner.item_id)
                    .ok_or_else(|| RouletteError::new("internal", "Winner not found", 500))?;
                if let Some(source) = winner.action.as_deref().filter(|s| !s.is_empty()) {
                    if actions.iter().filter(|a| a.open()).count() >= MAX_OPEN_ACTIONS {
                        return Err(RouletteError::new(
                            "capacity",
                            "Too many pending item actions",
                            400,
                        )
                        .into());
                    }
                    actions.push(WinnerAction {
                        draw_id: draw.id.clone(),
                        roulette_id: draw.roulette_id.clone(),
                        item_id: winner.id.clone(),
                        label: winner.label.clone(),
                        source: source.to_owned(),
                        due_at: draw.ends_at,
                        status: "pending".into(),
                        actor: actor.map(DrawActor::to_bson),
                        started_at: None,
                        finished_at: None,
                    });
                }
            }
            let finished: Vec<WinnerAction> =
                actions.iter().filter(|a| !a.open()).cloned().collect();
            let skip = finished.len().saturating_sub(FINISHED_ACTIONS_KEPT);
            let mut saved: Vec<WinnerAction> = finished.into_iter().skip(skip).collect();
            saved.extend(actions.into_iter().filter(WinnerAction::open));
            let aliases: Vec<&str> = doc
                .state
                .roulettes
                .iter()
                .map(|r| r.alias.as_str())
                .collect();
            let unique: std::collections::HashSet<&str> = aliases.iter().copied().collect();
            if unique.len() != aliases.len()
                || doc
                    .state
                    .roulettes
                    .iter()
                    .any(|r| aliases.contains(&r.id.as_str()))
            {
                return Err(RouletteError::new(
                    "alias_conflict",
                    "Alias already exists in this channel",
                    409,
                )
                .into());
            }
            if dima_text::to_js_json(&doc.state.to_json()).len() > MAX_STATE_BYTES {
                return Err(RouletteError::new(
                    "capacity",
                    "Channel roulette storage limit reached",
                    400,
                )
                .into());
            }
            let mut receipts: Vec<Receipt> = doc
                .receipts
                .into_iter()
                .filter(|r| now - r.at < RECEIPT_MS)
                .collect();
            if let Some(key) = &receipt_key {
                receipts.push(Receipt {
                    key: key.clone(),
                    fingerprint: fingerprint.clone(),
                    result: result.clone(),
                    at: now,
                });
            }
            let skip = receipts.len().saturating_sub(RECEIPTS_KEPT);
            let receipts: Vec<Bson> = receipts
                .into_iter()
                .skip(skip)
                .map(|r| {
                    Bson::Document(doc! { "key": r.key, "fingerprint": r.fingerprint, "result": r.result, "at": js_number(r.at) })
                })
                .collect();
            let state = doc.state.to_bson().map_err(ServiceError::store)?;
            let saved_bson: Vec<Bson> = saved.iter().map(WinnerAction::to_bson).collect();
            let won = self
                .update(
                    "roulette_channels.updateOne",
                    doc! { "_id": channel, "revision": js_number(doc.revision) },
                    doc! {
                        "$set": {
                            "actions": saved_bson,
                            "actionDueAt": action_due(&saved).map_or(Bson::Null, js_number),
                            "state": state,
                            "dueAt": doc.state.due().map_or(Bson::Null, js_number),
                            "receipts": receipts,
                        },
                        "$inc": { "revision": 1 },
                    },
                )
                .await?;
            if won {
                return Ok(Executed {
                    revision: doc.revision as i64 + 1,
                    result,
                    replayed: false,
                });
            }
        }
        Err(RouletteError::new(
            "busy",
            "Roulette is busy; retry with the same idempotency key",
            409,
        )
        .into())
    }

    /// `snapshot(channelId)`: the state, after completing a due draw (and hiding) in its own
    /// compare-and-set.
    pub async fn snapshot(&self, channel: &str) -> Result<Snapshot, ServiceError> {
        for _ in 0..CAS_ATTEMPTS {
            let mut doc = self.load(channel).await?;
            let runs = |actions: &[WinnerAction]| {
                let skip = actions.len().saturating_sub(100);
                actions
                    .iter()
                    .skip(skip)
                    .map(|a| (a.draw_id.clone(), a.status.clone()))
                    .collect::<Vec<_>>()
            };
            if !model::settle(&mut doc.state, self.clock.now_ms() as f64) {
                return Ok(Snapshot {
                    revision: doc.revision as i64,
                    server_time: self.clock.now_ms(),
                    action_runs: runs(&doc.actions),
                    state: doc.state,
                });
            }
            let state = doc.state.to_bson().map_err(ServiceError::store)?;
            let won = self
                .update(
                    "roulette_channels.updateOne",
                    doc! { "_id": channel, "revision": js_number(doc.revision) },
                    doc! {
                        "$set": { "state": state, "dueAt": doc.state.due().map_or(Bson::Null, js_number) },
                        "$inc": { "revision": 1 },
                    },
                )
                .await?;
            if won {
                return Ok(Snapshot {
                    revision: doc.revision as i64 + 1,
                    server_time: self.clock.now_ms(),
                    action_runs: runs(&doc.actions),
                    state: doc.state,
                });
            }
        }
        Err(RouletteError::new("busy", "Roulette is busy", 409).into())
    }

    /// `overlaySnapshot(channelId)` as JSON.
    pub async fn overlay_snapshot(&self, channel: &str) -> Result<Value, ServiceError> {
        Ok(self.snapshot(channel).await?.overlay_json())
    }

    /// `authorizeOverlay(id, token)` without the legacy-URL upgrade: whether `token` (43
    /// URL-safe characters) is the channel's overlay token. The caller then runs
    /// `rememberOverlayToken` (P4-FEAT-OVERLAYS) with [`Self::token_document`] and
    /// [`Self::save_token`], ignoring its failure as the reference does.
    pub async fn authorize_overlay(
        &self,
        channel: &str,
        token: &str,
    ) -> Result<bool, ServiceError> {
        if token.len() != 43
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Ok(false);
        }
        check_channel(channel)?;
        let found = self
            .within(
                "roulette_channels.exists",
                self.mongo
                    .documents(stored::COLLECTION)
                    .find_one(doc! { "_id": channel, "tokenHash": sha256_hex(token) })
                    .projection(doc! { "_id": 1 }),
            )
            .await?;
        Ok(found.is_some())
    }

    /// The overlay token store's `read()`: the token fields, after creating the document.
    pub async fn token_document(&self, channel: &str) -> Result<TokenDocument, ServiceError> {
        self.load(channel).await?;
        let found = self
            .within(
                "roulette_channels.findById",
                self.mongo
                    .documents(stored::COLLECTION)
                    .find_one(doc! { "_id": channel })
                    .projection(doc! { "tokenHash": 1, "overlayToken": 1 }),
            )
            .await?
            .ok_or_else(|| ServiceError::store("roulette channel missing"))?;
        Ok(TokenDocument {
            token_hash: found.get_str("tokenHash").ok().map(str::to_owned),
            overlay_token: found
                .get("overlayToken")
                .filter(|v| !matches!(v, Bson::Null))
                .cloned(),
        })
    }

    /// The overlay token store's `save(expectedHash, token, replace)`, with the token already
    /// hashed and encrypted (`storedOverlayToken`): `true` when the expected hash still held.
    pub async fn save_token(
        &self,
        channel: &str,
        expected_hash: Option<&str>,
        token_hash: &str,
        encrypted: Bson,
        replace: bool,
    ) -> Result<bool, ServiceError> {
        let mut update = doc! { "$set": { "tokenHash": token_hash, "overlayToken": encrypted } };
        if replace {
            update.insert("$inc", doc! { "revision": 1 });
        }
        let mut ctx = WriteContext::new(self.clock.now_ms());
        let filter =
            doc! { "_id": channel, "tokenHash": expected_hash.map_or(Bson::Null, Bson::from) };
        let prepared =
            stored::INFO.prepare_update(&filter, update, UpdateOptions::default(), &mut ctx)?;
        let mut writes = self.mongo.writes(stored::COLLECTION);
        let outcome = self
            .within("roulette_channels.updateOne", writes.update_one(&prepared))
            .await?;
        Ok(outcome.matched == 1)
    }

    /// The fields the overlay socket polls (`{ revision, dueAt, tokenHash }`), without creating
    /// the document.
    pub async fn version(
        &self,
        channel: &str,
    ) -> Result<Option<(f64, Option<f64>, Option<String>)>, ServiceError> {
        let found = self
            .within(
                "roulette_channels.findById",
                self.mongo
                    .documents(stored::COLLECTION)
                    .find_one(doc! { "_id": channel })
                    .projection(doc! { "revision": 1, "dueAt": 1, "tokenHash": 1 }),
            )
            .await?;
        Ok(found.map(|d| {
            (
                d.get("revision").and_then(read_number).unwrap_or(0.0),
                d.get("dueAt").and_then(read_number),
                d.get_str("tokenHash").ok().map(str::to_owned),
            )
        }))
    }
}

impl RouletteError {
    fn invalid_action(message: &str, row: Option<usize>) -> Self {
        let mut error = Self::new("invalid_action", message, 400);
        error.row = row;
        error
    }
}

/// `apply(state, action, now)`: the operation on the loaded state; its result text.
pub fn apply(
    state: &mut State,
    action: &Action,
    now: f64,
    random: &dyn Random,
) -> Result<String, RouletteError> {
    let empty = Map::new();
    let data = action.data.as_ref().unwrap_or(&empty);
    match action.operation {
        Operation::Create => {
            if state.roulettes.len() >= model::MAX_ROULETTES {
                return Err(RouletteError::new(
                    "capacity",
                    "A channel supports up to 20 saved roulettes",
                    400,
                ));
            }
            let roulette = model::create(data, random)?;
            let id = roulette.id.clone();
            state.roulettes.push(roulette);
            if state.active_id.is_none() {
                state.active_id = Some(id.clone());
            }
            return Ok(id);
        }
        Operation::Show | Operation::Hide => {
            if action.operation == Operation::Show {
                model::find(state, None)?;
            }
            state.visible = action.operation == Operation::Show;
            state.hide_at = None;
            return Ok(String::new());
        }
        _ => {}
    }
    let index = model::find_index(state, action.roulette.as_deref())?;
    let id = state
        .roulettes
        .get(index)
        .map(|r| r.id.clone())
        .unwrap_or_default();
    let item_id = || text_str(action.item_id.as_deref().unwrap_or(""), "itemId", 120);
    fn roulette(state: &mut State, index: usize) -> Result<&mut model::Roulette, RouletteError> {
        state.roulettes.get_mut(index).ok_or_else(|| {
            RouletteError::new("not_found", "Roulette not found in this channel", 404)
        })
    }
    match action.operation {
        Operation::Configure => {
            model::idle(state)?;
            model::configure(roulette(state, index)?, data)?;
            if state.active_id.as_deref() == Some(&id) {
                state.draw = None;
                state.hide_at = None;
            }
            Ok(id)
        }
        Operation::Delete => {
            model::idle(state)?;
            state.roulettes.remove(index);
            if state.active_id.as_deref() == Some(&id) {
                state.active_id = None;
                state.visible = false;
                state.draw = None;
                state.hide_at = None;
            }
            Ok(id)
        }
        Operation::Add => model::add(roulette(state, index)?, data, random),
        Operation::Import => {
            let replace = data.get("replace") == Some(&Value::Bool(true));
            if replace {
                model::idle(state)?;
            }
            let count = model::import_items(roulette(state, index)?, data, random)?;
            if replace && state.active_id.as_deref() == Some(&id) {
                state.draw = None;
                state.hide_at = None;
            }
            Ok(count.to_string())
        }
        Operation::Update => {
            let item = item_id()?;
            model::update_item(roulette(state, index)?, &item, data, random)
        }
        Operation::Remove => {
            let item = item_id()?;
            model::remove(roulette(state, index)?, &item)?;
            Ok(action.item_id.clone().unwrap_or_default())
        }
        Operation::Shuffle => {
            model::idle(state)?;
            model::shuffle(&mut roulette(state, index)?.order, random)?;
            Ok(id)
        }
        Operation::Switch => {
            model::idle(state)?;
            state.active_id = Some(id.clone());
            state.draw = None;
            state.hide_at = None;
            Ok(id)
        }
        Operation::Start => model::start(state, index, now, random),
        Operation::Create | Operation::Show | Operation::Hide => Ok(String::new()),
    }
}

//! Mongo-backed roulette channel service.
//!
//! Ports `dimabot/src/roulette/service.ts` and the overlay-token helpers it
//! calls from `dimabot/src/utils/overlay-token.ts`. One channel document in
//! `roulette_channels` is the atomic boundary. Compare-and-swap uses `_id`
//! plus the stored `revision` BSON value and `$inc revision`. Item scripts
//! are checked with `validate_action_field`. Winner-action delivery
//! (`actions.ts`) is not run here; pending rows are only stored.
//!
//! Overlay links use the canonical `utils::overlay_token` codec and its
//! `MongoOverlayTokenStore` compare-and-set adapter. The store is guarded by this
//! module's `load_channel` initializer, so a token read cannot race a missing
//! channel document, and a replacing save bumps `revision`. Authorizing an OBS
//! source checks the token shape, then the `_id + tokenHash` existence query,
//! then upgrades a hash-only link best-effort.
//!
//! Constructors take a database and a cipher. Nothing connects at import.

#![cfg(feature = "widgets-runtime")]

use crate::roulette_runtime::action_model::{
    ActionStatus, DrawActor, WinnerAction, validate_action_field, validate_actor,
};
use crate::roulette_runtime::model::{
    self, Draw, MAX_SAFE_INTEGER, Roulette, RouletteError, State, empty_state, fail, integer, text,
};
use crate::utils::bson_compat::{js_number, normalize_document};
use crate::utils::credential_crypto::CredentialCipher;
use crate::utils::js_string::JsString;
use crate::utils::lossless_json::JsonValue;
use crate::utils::overlay_token::{
    EnsureOverlayTokenDocument, MongoOverlayTokenStore, NativeOverlayTokenCodec, OverlayTokenCodec,
    OverlayTokenError, OverlayTokenStore, OverlayTokenView, StoreFuture, manage_overlay_token,
    read_overlay_token, remember_overlay_token, sha256_hex, token_shape,
};
use futures_util::TryStreamExt;
use mongodb::{
    Collection, Database, IndexModel,
    bson::{Bson, Document, doc, from_bson},
    error::{Error as MongoError, ErrorKind},
    options::IndexOptions,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    collections::HashSet,
    error::Error,
    fmt,
    future::Future,
    pin::Pin,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

/// Mongoose collection. `versionKey` is false in the source schema.
pub const COLLECTION: &str = "roulette_channels";
const CAS_ATTEMPTS: usize = 20;
const RECEIPT_WINDOW_MS: i64 = 86_400_000;
const STATE_BYTE_CAP: usize = 4 * 1024 * 1024;

type RepoFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, ServiceError>> + Send + 'a>>;

/// Domain failure or a storage failure whose text is for logs, not clients.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServiceError {
    Domain(RouletteError),
    Storage(String),
}

impl fmt::Display for ServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Domain(error) => error.fmt(formatter),
            Self::Storage(error) => formatter.write_str(error),
        }
    }
}

impl Error for ServiceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Domain(error) => Some(error),
            Self::Storage(_) => None,
        }
    }
}

impl From<RouletteError> for ServiceError {
    fn from(error: RouletteError) -> Self {
        Self::Domain(error)
    }
}

impl From<OverlayTokenError> for ServiceError {
    fn from(error: OverlayTokenError) -> Self {
        match error {
            OverlayTokenError::Rejected(rejection) => {
                Self::Domain(fail(rejection.code, rejection.message, rejection.status))
            }
            OverlayTokenError::Crypto(error) => Self::Storage(error.to_string()),
            OverlayTokenError::Store(error) => Self::Storage(error.to_string()),
        }
    }
}

/// Wire operation. Unknown names fail `invalid` / `Unknown roulette action`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouletteOperation {
    Create,
    Configure,
    Delete,
    Add,
    Update,
    Remove,
    Shuffle,
    Switch,
    Show,
    Hide,
    Start,
}

impl RouletteOperation {
    /// Source discriminant.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Configure => "configure",
            Self::Delete => "delete",
            Self::Add => "add",
            Self::Update => "update",
            Self::Remove => "remove",
            Self::Shuffle => "shuffle",
            Self::Switch => "switch",
            Self::Show => "show",
            Self::Hide => "hide",
            Self::Start => "start",
        }
    }

    /// Parse a wire name.
    pub fn parse(value: &str) -> Result<Self, RouletteError> {
        Ok(match value {
            "create" => Self::Create,
            "configure" => Self::Configure,
            "delete" => Self::Delete,
            "add" => Self::Add,
            "update" => Self::Update,
            "remove" => Self::Remove,
            "shuffle" => Self::Shuffle,
            "switch" => Self::Switch,
            "show" => Self::Show,
            "hide" => Self::Hide,
            "start" => Self::Start,
            _ => return Err(fail("invalid", "Unknown roulette action", 400)),
        })
    }
}

/// One command. Absent optional fields stay out of the idempotency fingerprint.
#[derive(Clone, Debug, PartialEq)]
pub struct Action {
    pub operation: RouletteOperation,
    pub roulette: Option<String>,
    pub item_id: Option<String>,
    pub data: Option<JsonValue>,
}

/// `{ revision, result, replayed }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ExecuteResult {
    pub revision: i64,
    pub result: String,
    pub replayed: bool,
}

/// One public action run: `{ drawId, status }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ActionRun {
    #[serde(rename = "drawId")]
    pub draw_id: String,
    pub status: ActionStatus,
}

/// Snapshot body before the HTTP route wraps it. Key order is the struct order.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RouletteSnapshot {
    pub revision: i64,
    #[serde(rename = "serverTime")]
    pub server_time: i64,
    #[serde(flatten)]
    pub state: State,
    #[serde(rename = "actionRuns")]
    pub action_runs: Vec<ActionRun>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct PublicItem {
    id: String,
    label: String,
    multiplier: i64,
    weight: i64,
    copies: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicRoulette {
    id: String,
    alias: String,
    name: String,
    design: model::Design,
    card_size: model::CardSize,
    colors: Vec<String>,
    duration_seconds: i64,
    settings: model::Settings,
    items: Vec<PublicItem>,
    order: Vec<String>,
}

/// OBS snapshot. Item scripts are omitted.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct OverlaySnapshot {
    pub revision: i64,
    #[serde(rename = "serverTime")]
    pub server_time: i64,
    pub visible: bool,
    pub roulette: Option<PublicRoulette>,
    pub draw: Option<Draw>,
    #[serde(rename = "hideAt")]
    pub hide_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Receipt {
    key: String,
    fingerprint: String,
    result: String,
    at: i64,
}

/// Loaded `roulette_channels` document. Compare-and-swap keeps `revision_bson`.
pub struct ChannelDoc {
    revision_bson: Bson,
    revision: i64,
    state: State,
    actions: Vec<WinnerAction>,
    receipts: Vec<Receipt>,
}

/// Earliest pending `dueAt`, or null when nothing is pending.
pub fn action_due(actions: &[WinnerAction]) -> Option<i64> {
    actions.iter().filter(|action| action.status == ActionStatus::Pending).map(|action| action.due_at).min()
}

/// Spin deadline while a draw is open, otherwise `hideAt`.
pub fn due_at(state: &State) -> Option<i64> {
    match &state.draw {
        Some(draw) if draw.completed_at.is_none() => Some(draw.ends_at),
        _ => state.hide_at,
    }
}

/// `now - at < 86400000`. An equal age is expired. A future stamp is fresh.
pub fn receipt_is_fresh(now: i64, at: i64) -> bool {
    now < at || now.saturating_sub(at) < RECEIPT_WINDOW_MS
}

/// Duplicate aliases, or any roulette id that appears in the alias list.
pub fn aliases_conflict(state: &State) -> bool {
    let aliases: Vec<&str> = state.roulettes.iter().map(|roulette| roulette.alias.as_str()).collect();
    let mut seen = HashSet::new();
    aliases.iter().any(|alias| !seen.insert(*alias))
        || state.roulettes.iter().any(|roulette| aliases.iter().any(|alias| *alias == roulette.id))
}

fn action_fingerprint_json(action: &Action, actor: Option<&DrawActor>) -> JsonValue {
    let mut fields = vec![(JsString::from("operation"), JsonValue::String(JsString::from(action.operation.as_str())))];
    if let Some(roulette) = &action.roulette {
        fields.push((JsString::from("roulette"), JsonValue::String(JsString::from(roulette.as_str()))));
    }
    if let Some(item_id) = &action.item_id {
        fields.push((JsString::from("itemId"), JsonValue::String(JsString::from(item_id.as_str()))));
    }
    if let Some(data) = &action.data {
        fields.push((JsString::from("data"), data.clone()));
    }
    if let Some(actor) = actor {
        let mut actor_fields = vec![
            (JsString::from("userId"), JsonValue::String(JsString::from(actor.user_id.as_str()))),
            (JsString::from("userLogin"), JsonValue::String(JsString::from(actor.user_login.as_str()))),
            (JsString::from("userDisplayName"), JsonValue::String(JsString::from(actor.user_display_name.as_str()))),
        ];
        if let Some(argument) = &actor.argument {
            actor_fields.push((JsString::from("argument"), JsonValue::String(JsString::from(argument.as_str()))));
        }
        fields.push((JsString::from("actor"), JsonValue::Object(actor_fields)));
    }
    JsonValue::Object(fields)
}

fn string_value(value: &str) -> JsonValue {
    JsonValue::String(JsString::from(value))
}

fn check_channel(channel_id: &str) -> Result<(), RouletteError> {
    text(&string_value(channel_id), "channel", 100).map(|_| ())
}

fn apply(state: &mut State, action: &Action, now: i64) -> Result<String, RouletteError> {
    let empty = JsonValue::Object(Vec::new());
    let data = action.data.as_ref().unwrap_or(&empty);
    if action.operation == RouletteOperation::Create {
        if state.roulettes.len() >= 20 {
            return Err(fail("capacity", "A channel supports up to 20 saved roulettes", 400));
        }
        let roulette = model::create(data)?;
        let id = roulette.id.clone();
        state.roulettes.push(roulette);
        if state.active_id.is_none() {
            state.active_id = Some(id.clone());
        }
        return Ok(id);
    }
    if matches!(action.operation, RouletteOperation::Show | RouletteOperation::Hide) {
        if action.operation == RouletteOperation::Show {
            model::find(state, None)?;
        }
        state.visible = action.operation == RouletteOperation::Show;
        state.hide_at = None;
        return Ok(String::new());
    }
    let index = model::find_index(state, action.roulette.as_deref())?;
    match action.operation {
        RouletteOperation::Configure => {
            model::idle(state)?;
            let id = state.roulettes[index].id.clone();
            model::configure(&mut state.roulettes[index], data)?;
            if state.active_id.as_deref() == Some(id.as_str()) {
                state.draw = None;
                state.hide_at = None;
            }
            Ok(id)
        }
        RouletteOperation::Delete => {
            model::idle(state)?;
            let id = state.roulettes[index].id.clone();
            state.roulettes.retain(|roulette| roulette.id != id);
            if state.active_id.as_deref() == Some(id.as_str()) {
                state.active_id = None;
                state.visible = false;
                state.draw = None;
                state.hide_at = None;
            }
            Ok(id)
        }
        RouletteOperation::Add => Ok(model::add(&mut state.roulettes[index], data)?.id),
        RouletteOperation::Update => {
            let raw = action.item_id.as_deref().unwrap_or("");
            let item_id = text(&string_value(raw), "itemId", 120)?;
            Ok(model::update_item(&mut state.roulettes[index], &item_id, data)?.id)
        }
        RouletteOperation::Remove => {
            let raw = action.item_id.clone().ok_or_else(|| fail("invalid", "itemId must contain 1–120 characters", 400))?;
            model::remove(&mut state.roulettes[index], &text(&string_value(&raw), "itemId", 120)?)?;
            Ok(raw)
        }
        RouletteOperation::Shuffle => {
            model::idle(state)?;
            let id = state.roulettes[index].id.clone();
            model::shuffle(&mut state.roulettes[index].order)?;
            Ok(id)
        }
        RouletteOperation::Switch => {
            model::idle(state)?;
            let id = state.roulettes[index].id.clone();
            state.active_id = Some(id.clone());
            state.draw = None;
            state.hide_at = None;
            Ok(id)
        }
        RouletteOperation::Start => Ok(model::start(state, index, now)?.id),
        RouletteOperation::Create | RouletteOperation::Show | RouletteOperation::Hide => {
            Err(fail("invalid", "Unknown roulette action", 400))
        }
    }
}

fn action_runs(actions: &[WinnerAction]) -> Vec<ActionRun> {
    let start = actions.len().saturating_sub(100);
    actions[start..]
        .iter()
        .map(|action| ActionRun { draw_id: action.draw_id.clone(), status: action.status })
        .collect()
}

pub(crate) fn unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

pub(crate) fn numeric_i64(value: &Bson) -> Option<i64> {
    match value {
        Bson::Int32(value) => Some(i64::from(*value)),
        Bson::Int64(value) => Some(*value),
        Bson::Double(value)
            if value.is_finite() && value.fract() == 0.0 && *value >= i64::MIN as f64 && *value <= i64::MAX as f64 =>
        {
            Some(*value as i64)
        }
        _ => None,
    }
}

fn promote_numbers(value: &mut Bson) {
    match value {
        Bson::Int32(number) => *value = Bson::Int64(i64::from(*number)),
        Bson::Double(number)
            if number.is_finite() && number.fract() == 0.0 && *number >= i64::MIN as f64 && *number <= i64::MAX as f64 =>
        {
            *value = Bson::Int64(*number as i64);
        }
        Bson::Document(document) => {
            for child in document.values_mut() {
                promote_numbers(child);
            }
        }
        Bson::Array(values) => {
            for child in values {
                promote_numbers(child);
            }
        }
        _ => {}
    }
}

pub(crate) fn from_state_bson<T: DeserializeOwned>(value: &Bson) -> Result<T, ServiceError> {
    let mut value = value.clone();
    promote_numbers(&mut value);
    from_bson(value).map_err(storage)
}

pub(crate) fn state_bson<T: Serialize>(value: &T) -> Result<Bson, ServiceError> {
    let mut bson = mongodb::bson::to_bson(value).map_err(storage)?;
    match &mut bson {
        Bson::Document(document) => normalize_document(document),
        Bson::Array(values) => {
            for value in values {
                if let Bson::Document(document) = value {
                    normalize_document(document);
                }
            }
        }
        _ => {}
    }
    Ok(bson)
}

pub(crate) fn is_duplicate(error: &mongodb::error::Error) -> bool {
    match error.kind.as_ref() {
        ErrorKind::Write(mongodb::error::WriteFailure::WriteError(write)) => write.code == 11000,
        ErrorKind::Command(command) => command.code == 11000,
        _ => false,
    }
}

/// Ensures the roulette channel document exists before a token read. Reuses the
/// module's existing [`load_channel`] initializer, so the token path inherits its
/// channel validation, `revision: 0` document creation, duplicate-key tolerance
/// and the initial `tokenHash: null`.
struct RouletteTokenGuard {
    channels: Collection<Document>,
    channel_id: String,
}

impl EnsureOverlayTokenDocument for RouletteTokenGuard {
    fn ensure<'a>(
        &'a self,
        _collection: &'a Collection<Document>,
        _id: &'a str,
    ) -> StoreFuture<'a, ()> {
        let channels = self.channels.clone();
        let channel_id = self.channel_id.clone();
        Box::pin(async move {
            load_channel(&channels, &channel_id)
                .await
                .map_err(|error| OverlayTokenError::Store(MongoError::custom(error.to_string())))?;
            Ok(())
        })
    }
}

/// Persistence seam. `MongoRouletteRepository` is the production adapter.
pub trait RouletteRepository: Send + Sync {
    fn load<'a>(&'a self, channel_id: &'a str) -> RepoFuture<'a, ChannelDoc>;
    fn update<'a>(&'a self, channel_id: &'a str, revision: Bson, update: Document) -> RepoFuture<'a, bool>;
    fn token_store(&self, channel_id: &str) -> Box<dyn OverlayTokenStore>;
    fn token_exists<'a>(&'a self, channel_id: &'a str, token_hash: &'a str) -> RepoFuture<'a, bool>;
    fn due_ids<'a>(&'a self, now: i64) -> RepoFuture<'a, Vec<String>>;
    fn install_indexes<'a>(&'a self) -> RepoFuture<'a, ()>;
}

/// Mongo adapter for `roulette_channels`.
#[derive(Clone)]
pub struct MongoRouletteRepository {
    channels: Collection<Document>,
}

impl MongoRouletteRepository {
    /// Uses the caller's database. Does not connect or create indexes.
    pub fn new(database: &Database) -> Self {
        Self { channels: database.collection(COLLECTION) }
    }
}

impl RouletteRepository for MongoRouletteRepository {
    fn load<'a>(&'a self, channel_id: &'a str) -> RepoFuture<'a, ChannelDoc> {
        let channels = self.channels.clone();
        let channel_id = channel_id.to_owned();
        Box::pin(async move { load_channel(&channels, &channel_id).await })
    }

    fn update<'a>(&'a self, channel_id: &'a str, revision: Bson, update: Document) -> RepoFuture<'a, bool> {
        let channels = self.channels.clone();
        let channel_id = channel_id.to_owned();
        Box::pin(async move {
            let saved = channels
                .update_one(doc! { "_id": channel_id, "revision": revision }, update)
                .await
                .map_err(storage)?;
            Ok(saved.modified_count > 0)
        })
    }

    fn token_store(&self, channel_id: &str) -> Box<dyn OverlayTokenStore> {
        Box::new(
            MongoOverlayTokenStore::new(self.channels.clone(), channel_id.to_owned())
                .incrementing_revision()
                .ensuring(Arc::new(RouletteTokenGuard {
                    channels: self.channels.clone(),
                    channel_id: channel_id.to_owned(),
                })),
        )
    }

    fn token_exists<'a>(&'a self, channel_id: &'a str, token_hash: &'a str) -> RepoFuture<'a, bool> {
        let channels = self.channels.clone();
        let channel_id = channel_id.to_owned();
        let token_hash = token_hash.to_owned();
        Box::pin(async move {
            Ok(channels
                .find_one(doc! { "_id": channel_id, "tokenHash": token_hash })
                .projection(doc! { "_id": 1 })
                .await
                .map_err(storage)?
                .is_some())
        })
    }

    fn due_ids<'a>(&'a self, now: i64) -> RepoFuture<'a, Vec<String>> {
        let channels = self.channels.clone();
        Box::pin(async move {
            let rows: Vec<Document> = channels
                .find(doc! { "dueAt": { "$ne": Bson::Null, "$lte": js_number(now as f64) } })
                .projection(doc! { "_id": 1 })
                .limit(100)
                .await
                .map_err(storage)?
                .try_collect()
                .await
                .map_err(storage)?;
            rows.into_iter()
                .map(|row| {
                    row.get("_id")
                        .and_then(Bson::as_str)
                        .map(str::to_owned)
                        .ok_or_else(|| storage("Roulette due row is missing a string _id"))
                })
                .collect()
        })
    }

    fn install_indexes<'a>(&'a self) -> RepoFuture<'a, ()> {
        let channels = self.channels.clone();
        Box::pin(async move {
            let indexes = [
                IndexModel::builder()
                    .keys(doc! { "dueAt": 1 })
                    .options(IndexOptions::builder().name("dueAt_1".to_owned()).build())
                    .build(),
                IndexModel::builder()
                    .keys(doc! { "actionDueAt": 1 })
                    .options(IndexOptions::builder().name("actionDueAt_1".to_owned()).build())
                    .build(),
            ];
            channels.create_indexes(indexes).await.map_err(storage)?;
            Ok(())
        })
    }
}

/// Channel roulette service. `native` wires Mongo and the canonical token codec.
#[derive(Clone)]
pub struct RouletteService {
    repo: Arc<dyn RouletteRepository>,
    codec: Arc<dyn OverlayTokenCodec>,
}

impl RouletteService {
    /// Production wiring. Does not connect and does not install indexes.
    pub fn native(database: Database, cipher: CredentialCipher) -> Self {
        Self::with_adapters(
            Arc::new(MongoRouletteRepository::new(&database)),
            Arc::new(NativeOverlayTokenCodec::new(cipher)),
        )
    }

    /// Test seam. The native adapter above remains the production implementation.
    pub fn with_adapters(repo: Arc<dyn RouletteRepository>, codec: Arc<dyn OverlayTokenCodec>) -> Self {
        Self { repo, codec }
    }

    /// Explicit composition root. Reads Mongo configuration only when called.
    pub async fn from_runtime(cipher: CredentialCipher) -> Result<Self, ServiceError> {
        let client = crate::utils::mongo::get_mongo_client().await.map_err(storage)?;
        let database = client.default_database().ok_or_else(|| storage("Missing database"))?;
        Ok(Self::native(database, cipher))
    }

    /// Create the source indexes. Not called from the constructor.
    pub async fn install_indexes(&self) -> Result<(), ServiceError> {
        self.repo.install_indexes().await
    }

    /// Apply one command with receipt replay, revision checks, and 20 CAS attempts.
    pub async fn execute(
        &self,
        channel_id: &str,
        action: &Action,
        request_key: Option<&str>,
        expected_revision: Option<i64>,
        actor: Option<&DrawActor>,
    ) -> Result<ExecuteResult, ServiceError> {
        if matches!(action.operation, RouletteOperation::Add | RouletteOperation::Update)
            && let Some(source) = action.data.as_ref().and_then(|data| data.get("action"))
        {
            validate_action_field(source)?;
        }
        if let Some(actor) = actor {
            validate_actor(actor)?;
        }
        if let Some(request_key) = request_key {
            text(&string_value(request_key), "Idempotency-Key", 128)?;
        }
        if let Some(revision) = expected_revision {
            integer(&JsonValue::Number(revision as f64), "revision", 0, MAX_SAFE_INTEGER)?;
        }
        let fingerprint = sha256_hex(&action_fingerprint_json(action, actor).to_json_string());
        let receipt_key = request_key.map(sha256_hex);
        for _ in 0..CAS_ATTEMPTS {
            let mut document = self.repo.load(channel_id).await?;
            let now = unix_millis();
            if let Some(receipt_key) = &receipt_key
                && let Some(receipt) = document
                    .receipts
                    .iter()
                    .find(|receipt| &receipt.key == receipt_key && receipt_is_fresh(now, receipt.at))
            {
                if receipt.fingerprint != fingerprint {
                    return Err(fail("idempotency_conflict", "Idempotency key was used for a different action", 409).into());
                }
                return Ok(ExecuteResult { revision: document.revision, result: receipt.result.clone(), replayed: true });
            }
            if let Some(expected) = expected_revision
                && expected != document.revision
            {
                return Err(fail("revision_conflict", "State changed; refresh before saving", 409).into());
            }
            model::settle(&mut document.state, now);
            let result = apply(&mut document.state, action, now)?;
            let mut actions = document.actions.clone();
            if action.operation == RouletteOperation::Start {
                let draw = document
                    .state
                    .draw
                    .clone()
                    .ok_or_else(|| fail("invalid", "Roulette state is missing the draw", 400))?;
                let winner = model::find(&document.state, Some(draw.roulette_id.as_str()))?
                    .items
                    .iter()
                    .find(|item| item.id == draw.winner.item_id)
                    .cloned()
                    .ok_or_else(|| fail("invalid", "Roulette state is missing the drawn item", 400))?;
                if !winner.action.is_empty() {
                    if actions.iter().filter(|row| matches!(row.status, ActionStatus::Pending | ActionStatus::Running)).count() >= 100 {
                        return Err(fail("capacity", "Too many pending item actions", 400).into());
                    }
                    actions.push(WinnerAction {
                        draw_id: draw.id,
                        roulette_id: draw.roulette_id,
                        item_id: winner.id,
                        label: winner.label,
                        source: winner.action,
                        due_at: draw.ends_at,
                        status: ActionStatus::Pending,
                        actor: actor.cloned(),
                        started_at: None,
                        finished_at: None,
                    });
                }
            }
            let retained: Vec<_> = actions
                .iter()
                .filter(|row| matches!(row.status, ActionStatus::Pending | ActionStatus::Running))
                .cloned()
                .collect();
            let recent: Vec<_> = actions
                .iter()
                .filter(|row| !matches!(row.status, ActionStatus::Pending | ActionStatus::Running))
                .cloned()
                .collect();
            let start = recent.len().saturating_sub(100);
            let mut saved_actions = recent[start..].to_vec();
            saved_actions.extend(retained);
            if aliases_conflict(&document.state) {
                return Err(fail("alias_conflict", "Alias already exists in this channel", 409).into());
            }
            if serde_json::to_string(&document.state).map_err(storage)?.len() > STATE_BYTE_CAP {
                return Err(fail("capacity", "Channel roulette storage limit reached", 400).into());
            }
            let mut receipts: Vec<_> = document.receipts.into_iter().filter(|receipt| receipt_is_fresh(now, receipt.at)).collect();
            if let Some(receipt_key) = &receipt_key {
                receipts.push(Receipt { key: receipt_key.clone(), fingerprint: fingerprint.clone(), result: result.clone(), at: now });
            }
            let start = receipts.len().saturating_sub(200);
            let receipts = receipts.split_off(start.min(receipts.len()));
            let mut update = doc! {
                "$set": {
                    "actions": state_bson(&saved_actions)?,
                    "actionDueAt": action_due(&saved_actions).map(|value| js_number(value as f64)).unwrap_or(Bson::Null),
                    "state": state_bson(&document.state)?,
                    "dueAt": due_at(&document.state).map(|value| js_number(value as f64)).unwrap_or(Bson::Null),
                    "receipts": state_bson(&receipts)?,
                },
                "$inc": { "revision": 1i32 },
            };
            if let Some(Bson::Document(set)) = update.get_mut("$set") {
                normalize_document(set);
            }
            if self.repo.update(channel_id, document.revision_bson, update).await? {
                return Ok(ExecuteResult { revision: document.revision + 1, result, replayed: false });
            }
        }
        Err(fail("busy", "Roulette is busy; retry with the same idempotency key", 409).into())
    }

    /// Settle an open draw, or return the current document when nothing is due.
    pub async fn snapshot(&self, channel_id: &str) -> Result<RouletteSnapshot, ServiceError> {
        for _ in 0..CAS_ATTEMPTS {
            let mut document = self.repo.load(channel_id).await?;
            let now = unix_millis();
            if !model::settle(&mut document.state, now) {
                return Ok(RouletteSnapshot {
                    revision: document.revision,
                    server_time: unix_millis(),
                    action_runs: action_runs(&document.actions),
                    state: document.state,
                });
            }
            let mut update = doc! {
                "$set": {
                    "state": state_bson(&document.state)?,
                    "dueAt": due_at(&document.state).map(|value| js_number(value as f64)).unwrap_or(Bson::Null),
                },
                "$inc": { "revision": 1i32 },
            };
            if let Some(Bson::Document(set)) = update.get_mut("$set") {
                normalize_document(set);
            }
            if self.repo.update(channel_id, document.revision_bson, update).await? {
                return Ok(RouletteSnapshot {
                    revision: document.revision + 1,
                    server_time: unix_millis(),
                    action_runs: action_runs(&document.actions),
                    state: document.state,
                });
            }
        }
        Err(fail("busy", "Roulette is busy", 409).into())
    }

    /// Current link, without a premium check.
    pub async fn overlay_token_state(&self, channel_id: &str) -> Result<OverlayTokenView, ServiceError> {
        check_channel(channel_id)?;
        Ok(read_overlay_token(self.repo.token_store(channel_id).as_ref(), self.codec.as_ref()).await?)
    }

    /// Create, recover, or rotate the link.
    pub async fn update_overlay_token(&self, channel_id: &str, input: &JsonValue) -> Result<OverlayTokenView, ServiceError> {
        check_channel(channel_id)?;
        Ok(manage_overlay_token(self.repo.token_store(channel_id).as_ref(), self.codec.as_ref(), input).await?)
    }

    /// Rotate using the version just read.
    pub async fn rotate_token(&self, channel_id: &str) -> Result<String, ServiceError> {
        let current = self.overlay_token_state(channel_id).await?;
        let version = match current.version {
            Some(version) => JsonValue::String(JsString::from(version.as_str())),
            None => JsonValue::Null,
        };
        let input = JsonValue::Object(vec![
            (JsString::from("rotate"), JsonValue::Bool(true)),
            (JsString::from("version"), version),
        ]);
        self.update_overlay_token(channel_id, &input)
            .await?
            .token
            .ok_or_else(|| storage("Rotated overlay token was not readable"))
    }

    /// OBS gate. A bad token is `false`. A bad channel id is a domain error.
    pub async fn authorize_overlay(&self, channel_id: &str, token: Option<&str>) -> Result<bool, ServiceError> {
        let Some(token) = token else {
            return Ok(false);
        };
        if !token_shape(token) {
            return Ok(false);
        }
        let channel_id = text(&string_value(channel_id), "channel", 100)?;
        let allowed = self.repo.token_exists(&channel_id, &self.codec.hash(token)).await?;
        if allowed {
            let _ = remember_overlay_token(self.repo.token_store(&channel_id).as_ref(), self.codec.as_ref(), token).await;
        }
        Ok(allowed)
    }

    /// Display snapshot with executable item scripts removed.
    pub async fn overlay_snapshot(&self, channel_id: &str) -> Result<OverlaySnapshot, ServiceError> {
        let snapshot = self.snapshot(channel_id).await?;
        let roulette = snapshot
            .state
            .active_id
            .as_ref()
            .and_then(|id| snapshot.state.roulettes.iter().find(|roulette| &roulette.id == id))
            .map(public_roulette);
        Ok(OverlaySnapshot {
            revision: snapshot.revision,
            server_time: snapshot.server_time,
            visible: snapshot.state.visible,
            roulette,
            draw: snapshot.state.draw,
            hide_at: snapshot.state.hide_at,
        })
    }

    /// Indexed due poll. No sort, at most 100 channels, then `snapshot` each.
    pub async fn settle_due(&self) -> Result<(), ServiceError> {
        for channel_id in self.repo.due_ids(unix_millis()).await? {
            self.snapshot(&channel_id).await?;
        }
        Ok(())
    }
}

fn public_roulette(roulette: &Roulette) -> PublicRoulette {
    PublicRoulette {
        id: roulette.id.clone(),
        alias: roulette.alias.clone(),
        name: roulette.name.clone(),
        design: roulette.design,
        card_size: roulette.card_size,
        colors: roulette.colors.clone(),
        duration_seconds: roulette.duration_seconds,
        settings: roulette.settings.clone(),
        items: roulette
            .items
            .iter()
            .map(|item| PublicItem {
                id: item.id.clone(),
                label: item.label.clone(),
                multiplier: item.multiplier,
                weight: item.weight,
                copies: item.copies.clone(),
            })
            .collect(),
        order: roulette.order.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::utils::overlay_token::base64url;

    #[test]
    fn empty_hash_and_zero_token_match_node() {
        assert_eq!(sha256_hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(base64url(&[0; 32]), "A".repeat(43));
        assert!(token_shape(&"A".repeat(43)));
        assert!(!token_shape(&"A".repeat(42)));
    }

    #[test]
    fn fingerprint_puts_the_actor_last_and_keeps_data_order() {
        let action = Action {
            operation: RouletteOperation::Add,
            roulette: Some("wheel".to_owned()),
            item_id: Some("item".to_owned()),
            data: Some(JsonValue::Object(vec![
                (JsString::from("label"), JsonValue::String(JsString::from("Prize"))),
                (JsString::from("weight"), JsonValue::Number(2.0)),
            ])),
        };
        let actor = DrawActor {
            user_id: "1".to_owned(),
            user_login: "ada".to_owned(),
            user_display_name: "Ada".to_owned(),
            argument: None,
        };
        assert_eq!(
            action_fingerprint_json(&action, Some(&actor)).to_json_string(),
            "{\"operation\":\"add\",\"roulette\":\"wheel\",\"itemId\":\"item\",\"data\":{\"label\":\"Prize\",\"weight\":2},\"actor\":{\"userId\":\"1\",\"userLogin\":\"ada\",\"userDisplayName\":\"Ada\"}}"
        );
    }

    #[test]
    fn deadlines_aliases_and_receipt_age_match_the_source() {
        let pending = WinnerAction {
            draw_id: "d".to_owned(),
            roulette_id: "r".to_owned(),
            item_id: "i".to_owned(),
            label: "L".to_owned(),
            source: String::new(),
            due_at: 30,
            status: ActionStatus::Pending,
            actor: None,
            started_at: None,
            finished_at: None,
        };
        let mut earlier = pending.clone();
        earlier.due_at = 10;
        let mut running = pending.clone();
        running.status = ActionStatus::Running;
        running.due_at = 1;
        assert_eq!(action_due(&[pending, earlier, running]), Some(10));
        assert_eq!(action_due(&[]), None);
        let mut state = empty_state();
        state.hide_at = Some(9);
        assert_eq!(due_at(&state), Some(9));
        state.draw = Some(Draw {
            id: "d".to_owned(),
            roulette_id: "r".to_owned(),
            started_at: 1,
            ends_at: 50,
            completed_at: None,
            winner: model::Slot { key: "k".to_owned(), item_id: "i".to_owned(), label: "L".to_owned(), weight: 1, copy: 1, multiplier: 1 },
            slots: Vec::new(),
            design: model::Design::Wheel,
            card_size: model::CardSize::Large,
            colors: Vec::new(),
            winner_action: model::WinnerPolicy::Keep,
            hide_after_seconds: None,
        });
        assert_eq!(due_at(&state), Some(50));
        let now = 1_000_000;
        assert!(!receipt_is_fresh(now, now - RECEIPT_WINDOW_MS));
        assert!(receipt_is_fresh(now, now - RECEIPT_WINDOW_MS + 1));
        state.roulettes.push(model::Roulette {
            id: "same".to_owned(),
            alias: "same".to_owned(),
            name: "One".to_owned(),
            design: model::Design::Wheel,
            card_size: model::CardSize::Large,
            colors: vec!["#cbbaff".to_owned()],
            duration_seconds: 4,
            settings: model::defaults(),
            items: Vec::new(),
            order: Vec::new(),
        });
        assert!(aliases_conflict(&state));
    }
}

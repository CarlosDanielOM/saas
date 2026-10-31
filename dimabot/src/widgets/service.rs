//! Mongo-backed Dead by Daylight widget service.
//!
//! Ports `dimabot/src/widgets/service.ts`. Collection `widget_channels` keeps
//! one document per channel. `execute` and `apply_widget_event` use a
//! journaled write concern (`w: 1`, `j: true`); other updates do not.
//! Idempotency receipts last 24 hours. A matching receipt returns before the
//! revision check.
//!
//! Poll creation follows the source `launchPoll`: the poll argument and the
//! source `start.poll` validation/error texts are reproduced by
//! [`WidgetStartPoll`], which is also the concrete `start.poll`
//! `AstFunctionCatalog` adapter when `ast-bot-runtime` is enabled. The AST
//! template runtime itself is not invoked here because its futures are
//! `!Send` and the Axum service path is `Send`. The AST source and parser
//! context are exposed for central runtime wiring; running the template
//! remains that runtime's responsibility.
//!
//! Writes that replace the whole `state` document preserve stored keys this
//! binary does not model (top level and object-valued nested fields), matching
//! the source's Mongoose `Mixed` document, except for values the action
//! replaces wholesale (a new `run`, a new `config`).
//!
//! Overlay links use the canonical `utils::overlay_token` codec and its
//! `MongoOverlayTokenStore` compare-and-set adapter. The store is guarded by the
//! module's existing `load_widget` initializer, so a token read cannot race a
//! missing channel document, and a replacing save bumps `revision`. Premium is
//! `users.plan_tier` in `premium` or `pro`, read through `PLAN_TIERS`.
//! Constructors take a database, a poll gateway, and a cipher.

#![cfg(feature = "widgets-runtime")]

use crate::domain_event_contracts::{DomainEventEnvelope, DomainEventFuture, DomainEventHandler};
use crate::functions::TwitchFunctions;
use crate::roulette_runtime::model::{MAX_SAFE_INTEGER, RouletteError, fail, integer, object, text};
use crate::roulette_runtime::service::{
    ServiceError, from_state_bson, is_duplicate, numeric_i64, receipt_is_fresh, state_bson,
    unix_millis,
};
use crate::schemas::users::PLAN_TIERS;
use crate::utils::bson_compat::js_number;
use crate::utils::credential_crypto::CredentialCipher;
use crate::utils::js_string::JsString;
use crate::utils::logger::Logger;
use crate::utils::lossless_json::JsonValue;
use crate::utils::overlay_token::{
    EnsureOverlayTokenDocument, MongoOverlayTokenStore, NativeOverlayTokenCodec, OverlayTokenCodec,
    OverlayTokenError, OverlayTokenStore, OverlayTokenView, StoreFuture, manage_overlay_token,
    read_overlay_token, remember_overlay_token, sha256_hex, token_shape,
};
use crate::widgets_runtime::event_model::{self, DbdEventSettings};
use crate::widgets_runtime::events::{self, WidgetEventAdapter, WidgetEventTarget};
use crate::widgets_runtime::model::{self, Language, Operation, Phase, PublicState, State};
use futures_util::TryStreamExt;
use mongodb::{
    Collection, Database, IndexModel,
    bson::{Bson, Document, doc},
    error::Error as MongoError,
    options::{Acknowledgment, CollectionOptions, IndexOptions, WriteConcern},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    error::Error,
    fmt,
    future::Future,
    pin::Pin,
    sync::Arc,
};

/// Mongoose collection. `versionKey` is false. Only `dueAt_1` is indexed.
pub const COLLECTION: &str = "widget_channels";
const EXECUTE_ATTEMPTS: usize = 20;
const ADVANCE_ATTEMPTS: usize = 10;

/// Return type of [`PollGateway`] calls. Public so adapters outside this module
/// can implement the trait.
pub type PollFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, WidgetServiceError>> + Send + 'a>>;
/// Return type of [`WidgetRepository`] calls. Public so adapters outside this
/// module can implement the trait.
pub type RepoFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, WidgetServiceError>> + Send + 'a>>;

/// Domain failure, storage failure, or a busy event delivery.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WidgetServiceError {
    Domain(RouletteError),
    Storage(String),
    Busy,
}

impl fmt::Display for WidgetServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Domain(error) => error.fmt(formatter),
            Self::Storage(error) => formatter.write_str(error),
            Self::Busy => formatter.write_str("Widget event state is busy; retry delivery"),
        }
    }
}

impl Error for WidgetServiceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Domain(error) => Some(error),
            _ => None,
        }
    }
}

impl From<RouletteError> for WidgetServiceError {
    fn from(error: RouletteError) -> Self {
        Self::Domain(error)
    }
}

impl From<ServiceError> for WidgetServiceError {
    fn from(error: ServiceError) -> Self {
        match error {
            ServiceError::Domain(error) => Self::Domain(error),
            ServiceError::Storage(error) => Self::Storage(error),
        }
    }
}

impl From<OverlayTokenError> for WidgetServiceError {
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

fn storage(error: impl fmt::Display) -> WidgetServiceError {
    WidgetServiceError::Storage(error.to_string())
}

/// `{ replayed }` from `execute`. The HTTP route returns a snapshot instead.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct WidgetExecuteResult {
    pub replayed: bool,
}

/// `{ revision, serverTime, ...publicState }`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WidgetSnapshot {
    pub revision: i64,
    #[serde(rename = "serverTime")]
    pub server_time: i64,
    #[serde(flatten)]
    pub state: PublicState,
}

/// `{ revision, settings }` for the events route.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WidgetEventSettingsView {
    pub revision: i64,
    pub settings: DbdEventSettings,
}

/// Wire action. The route rejects unknown names before `execute`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WidgetAction {
    Select,
    Configure,
    Start,
    Show,
    Hide,
    Reset,
    RetryPoll,
    Role,
    Layout,
    Progress,
    Events,
}

impl WidgetAction {
    /// Source discriminant, including `retry-poll`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Select => "select",
            Self::Configure => "configure",
            Self::Start => "start",
            Self::Show => "show",
            Self::Hide => "hide",
            Self::Reset => "reset",
            Self::RetryPoll => "retry-poll",
            Self::Role => "role",
            Self::Layout => "layout",
            Self::Progress => "progress",
            Self::Events => "events",
        }
    }

    /// Parse a wire name. `None` is an unknown action.
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "select" => Self::Select,
            "configure" => Self::Configure,
            "start" => Self::Start,
            "show" => Self::Show,
            "hide" => Self::Hide,
            "reset" => Self::Reset,
            "retry-poll" => Self::RetryPoll,
            "role" => Self::Role,
            "layout" => Self::Layout,
            "progress" => Self::Progress,
            "events" => Self::Events,
            _ => return None,
        })
    }

    fn accepts_body(self) -> bool {
        matches!(
            self,
            Self::Select | Self::Configure | Self::Start | Self::Role | Self::Layout | Self::Progress | Self::Events
        )
    }
}

/// `text(action, 'action')` then the allow-list. Unknown names use the source message.
pub fn parse_widget_action(value: &str) -> Result<WidgetAction, RouletteError> {
    let name = text(&JsonValue::String(JsString::from(value)), "action", 120)?;
    WidgetAction::parse(&name).ok_or_else(|| fail("invalid", "Unknown widget action", 400))
}

/// `text(channelID, 'channelID', 30)` for the route. The service then requires digits.
pub fn route_channel(value: &str) -> Result<String, RouletteError> {
    text(&JsonValue::String(JsString::from(value)), "channelID", 30)
}

/// `integer(Number(header), 'If-Match', 0)`. Missing is NaN. Empty is 0. Quotes stay.
pub fn if_match_revision(header: Option<&str>) -> Result<i64, RouletteError> {
    let number = match header {
        Some(value) => crate::utils::json_number::string_number(value),
        None => f64::NAN,
    };
    integer(&JsonValue::Number(number), "If-Match", 0, MAX_SAFE_INTEGER)
}

/// `Idempotency-Key` with the source 128-character cap.
pub fn idempotency_key(header: Option<&str>) -> Result<String, RouletteError> {
    text(&JsonValue::String(JsString::from(header.unwrap_or(""))), "Idempotency-Key", 128)
}

fn channel_id(id: &str) -> Result<(), RouletteError> {
    if (1..=30).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_digit()) {
        Ok(())
    } else {
        Err(fail("invalid", "Invalid channel ID", 400))
    }
}

/// Poll titles the widget would hand to `start.poll`: `Card n` or `Carta n`.
pub fn choice_titles(language: Language) -> Vec<String> {
    let label = if language == Language::Es { "Carta" } else { "Card" };
    (1..=5).map(|index| format!("{label} {index}")).collect()
}

/// JavaScript truthiness for the `error` fields these payloads carry.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0 && !number.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Confirmation gate from `launchPoll`: five choices, matching title, not terminated.
pub fn poll_is_confirmed(value: &Value, title: &str) -> bool {
    if value.get("error").is_some_and(js_truthy) {
        return false;
    }
    let Some(data) = value.get("data").and_then(Value::as_object) else {
        return false;
    };
    data.get("title").and_then(Value::as_str) == Some(title)
        && data.get("status").and_then(Value::as_str) != Some("TERMINATED")
        && data.get("choices").and_then(Value::as_array).is_some_and(|choices| choices.len() == 5)
}

/// `startPollHandler`'s empty-argument text (`channel.functions.ts`).
pub const START_POLL_USAGE: &str = "Usage: $(start.poll \"title;option1/option2;seconds\") — the whole argument must be wrapped in double quotes because ; is reserved syntax";

/// `startPollHandler`'s malformed-argument text.
pub const START_POLL_FORMAT: &str = "Invalid poll format. Use: $(start.poll \"title;option1/option2;seconds\") — the whole argument must be wrapped in double quotes because ; is reserved syntax";

/// `startPollHandler`'s Channel Points text.
pub const START_POLL_POINTS: &str = "Channel Points per vote must be a whole number from 0 to 1000000. Use 0 or omit the fourth part to disable extra votes.";

/// Parsed `start.poll` argument. The source handler splits the raw command
/// argument on `;` and `/`, so the widget's generated argument goes through the
/// same validation before any Helix write.
#[derive(Clone, Debug, PartialEq)]
pub struct StartPollCommand {
    pub title: String,
    pub options: Vec<String>,
    /// JavaScript `Number(durationRaw)`; finite and `> 0` after validation.
    pub duration: f64,
    /// Whole `0..=1000000`.
    pub points: i64,
}

/// `startPollHandler` validation, with the source texts. The caller passes the
/// same raw argument the AST handler would receive after `parseRawArgument`.
pub fn parse_start_poll(raw: &str) -> Result<StartPollCommand, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(START_POLL_USAGE.to_owned());
    }
    let parts: Vec<&str> = raw.split(';').map(str::trim).collect();
    let title = parts.first().copied().unwrap_or_default();
    let options_raw = parts.get(1).copied().unwrap_or_default();
    let duration_raw = parts.get(2).copied().unwrap_or_default();
    let points_raw = parts.get(3).copied().unwrap_or("0");
    let options: Vec<String> = options_raw
        .split('/')
        .map(str::trim)
        .filter(|option| !option.is_empty())
        .map(str::to_owned)
        .collect();
    let duration = crate::utils::json_number::string_number(duration_raw);
    if parts.len() < 3
        || parts.len() > 4
        || title.is_empty()
        || options.len() < 2
        || duration.is_nan()
        || duration <= 0.0
    {
        return Err(START_POLL_FORMAT.to_owned());
    }
    // `/^\d+$/`, then `Number.isInteger(points)`, `0..=1000000`.
    let points = crate::utils::json_number::string_number(points_raw);
    let digits = !points_raw.is_empty() && points_raw.bytes().all(|byte| byte.is_ascii_digit());
    if !digits || !points.is_finite() || points.fract() != 0.0 || points < 0.0 || points > 1_000_000.0 {
        return Err(START_POLL_POINTS.to_owned());
    }
    Ok(StartPollCommand { title: title.to_owned(), options, duration, points: points as i64 })
}

/// The exact `start.poll` argument `launchPoll` renders inside the AST source:
/// `title;Card 1/Card 2/.../Carta 1/...;pollSeconds;points`.
pub fn start_poll_argument(state: &State) -> Result<String, String> {
    let run = state.run.as_ref().ok_or_else(|| "No widget run".to_owned())?;
    let options = choice_titles(state.config.language).join("/");
    Ok(format!(
        "{};{};{};{}",
        run.poll_title,
        options,
        state.config.poll_seconds,
        model::poll_points_per_vote(state)
    ))
}

/// `$(start.poll ${JSON.stringify(argument)})`, byte-for-byte the source the
/// widget hands to `parseSpecialCommands`.
pub fn start_poll_source(state: &State) -> Result<String, String> {
    let argument = start_poll_argument(state)?;
    let quoted = serde_json::to_string(&argument).map_err(|error| error.to_string())?;
    Ok(format!("$(start.poll {quoted})"))
}

/// The Node BSON writer's number form for the Helix `duration` field. An
/// integral duration stays an integer; a non-integral one stays a float.
fn duration_value(duration: f64) -> Value {
    if duration.is_finite() && duration.fract() == 0.0 && duration.abs() <= MAX_SAFE_INTEGER as f64 {
        json!(duration as i64)
    } else {
        json!(duration)
    }
}

/// `Error starting poll: ${result.message}`.
fn poll_message(value: &Value) -> String {
    let message = match value.get("message") {
        Some(Value::String(message)) => message.clone(),
        Some(other) => other.to_string(),
        None => "undefined".to_owned(),
    };
    format!("Error starting poll: {message}")
}

/// `result.parsedText.slice(0, 300)` from `launchPoll`.
fn launch_text(text: String) -> String {
    JsString::from(text).slice(0, 300).to_utf8_lossy()
}

/// Concrete `start.poll` handler over the production [`PollGateway`].
///
/// `launchPoll` sends `$(start.poll "<argument>")` through
/// `parseSpecialCommands`. That parser is `!Send` (the native AST runtime is
/// `Rc`-based) while the Axum widgets service is `Send`, so the widget path
/// executes the same handler body directly. When `ast-bot-runtime` is enabled,
/// this type also implements `AstFunctionCatalog` so the team3 runtime can
/// serve `start.poll` with this exact validation and error text.
#[derive(Clone)]
pub struct WidgetStartPoll {
    polls: Arc<dyn PollGateway>,
}

impl WidgetStartPoll {
    /// Binds the concrete poll gateway.
    pub fn new(polls: Arc<dyn PollGateway>) -> Self {
        Self { polls }
    }

    /// Validate the raw argument and create the poll. `Err` is the source
    /// handler's display text, not a service error.
    pub async fn start(&self, channel_id: &str, raw: &str) -> Result<(), String> {
        let command = parse_start_poll(raw)?;
        let choices = Value::Array(
            command
                .options
                .iter()
                .map(|title| json!({ "title": title }))
                .collect(),
        );
        let duration = duration_value(command.duration);
        let created = self
            .polls
            .create_poll(channel_id, &command.title, &choices, &duration, false, command.points as f64)
            .await
            .map_err(|error| error.to_string())?;
        if created.get("error").is_some_and(js_truthy) {
            return Err(poll_message(&created));
        }
        Ok(())
    }
}

#[cfg(feature = "ast-bot-runtime")]
impl crate::utils::ast_runtime::AstFunctionCatalog for WidgetStartPoll {
    fn call<'a>(
        &'a self,
        scope: &crate::utils::ast_runtime::AstScope,
        name: &str,
        args: &[crate::utils::ast_evaluator::JsValue],
    ) -> crate::utils::ast_runtime::BoxFuture<
        'a,
        Result<crate::utils::ast_evaluator::JsValue, crate::utils::ast_runtime::AstRuntimeError>,
    > {
        // The trait does not tie `name`/`args`/`scope` to `'a`; own them before
        // boxing so the returned future only borrows `self`.
        let name = name.to_owned();
        let channel_id = scope.channel_id.clone();
        // `parseRawArgument`: `args.map(String).join(' ')`.
        let raw = args
            .iter()
            .map(|arg| crate::utils::ast_evaluator::js_string(arg).to_utf8().unwrap_or_default())
            .collect::<Vec<_>>()
            .join(" ");
        Box::pin(async move {
            if name != "start.poll" {
                return Err(crate::utils::ast_runtime::AstRuntimeError::Unsupported(format!(
                    "AST function `{name}` is not served by the widget poll adapter"
                )));
            }
            let text = match self.start(&channel_id, raw.trim()).await {
                Ok(()) => String::new(),
                Err(message) => message,
            };
            Ok(crate::utils::ast_evaluator::JsValue::string(text))
        })
    }
}

/// The exact `parseSpecialCommands` context `launchPoll` passes: `widgets`
/// scope, the pack as scope name, `pro` plan, level 10, literal arguments.
#[cfg(feature = "ast-bot-runtime")]
pub fn start_poll_context(
    channel_id: &str,
    pack_id: &str,
) -> crate::utils::ast_runtime::SpecialParserContext {
    crate::utils::ast_runtime::SpecialParserContext {
        channel_id: channel_id.to_owned(),
        scope_type: Some("widgets".to_owned()),
        scope_name: Some(pack_id.to_owned()),
        user_plan: Some("pro".to_owned()),
        user_level: Some(10.0),
        literal_arguments: true,
        ..Default::default()
    }
}

/// Helix poll lookup and creation. `TwitchPollGateway` is the production adapter.
pub trait PollGateway: Send + Sync {
    fn get_poll<'a>(&'a self, channel: &'a str, poll_id: Option<&'a str>, cache: bool) -> PollFuture<'a>;
    fn create_poll<'a>(
        &'a self,
        channel: &'a str,
        title: &'a str,
        choices: &'a Value,
        duration: &'a Value,
        cache: bool,
        channel_points_per_vote: f64,
    ) -> PollFuture<'a>;
}

/// Calls the already-ported `TwitchFunctions` poll methods. No second Helix client.
pub struct TwitchPollGateway {
    twitch: TwitchFunctions,
}

impl TwitchPollGateway {
    /// Stores the injected function host.
    pub fn new(twitch: TwitchFunctions) -> Self {
        Self { twitch }
    }
}

impl PollGateway for TwitchPollGateway {
    fn get_poll<'a>(&'a self, channel: &'a str, poll_id: Option<&'a str>, cache: bool) -> PollFuture<'a> {
        let channel = channel.to_owned();
        let poll_id = poll_id.map(str::to_owned);
        Box::pin(async move { Ok(self.twitch.get_poll(&channel, poll_id.as_deref(), cache).await) })
    }

    fn create_poll<'a>(
        &'a self,
        channel: &'a str,
        title: &'a str,
        choices: &'a Value,
        duration: &'a Value,
        cache: bool,
        channel_points_per_vote: f64,
    ) -> PollFuture<'a> {
        let channel = channel.to_owned();
        let title = title.to_owned();
        let choices = choices.clone();
        let duration = duration.clone();
        Box::pin(async move {
            Ok(self.twitch.create_poll(&channel, &title, &choices, &duration, cache, channel_points_per_vote).await)
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct WidgetReceipt {
    key: String,
    fingerprint: String,
    at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct EventReceipt {
    key: String,
    at: i64,
}

/// Loaded `widget_channels` document. Compare-and-swap keeps `revision_bson`.
///
/// `stored_state` is the original BSON `state` document. Whole-state writes use
/// it to keep keys this binary does not model, as the source's Mongoose
/// `Mixed` document does. Nested `$set` paths (`save_poll`) keep unknown
/// fields without help.
#[derive(Clone)]
pub struct WidgetDoc {
    revision_bson: Bson,
    revision: i64,
    state: State,
    stored_state: Document,
    receipts: Vec<WidgetReceipt>,
    event_settings: Option<DbdEventSettings>,
    event_receipts: Vec<EventReceipt>,
}

impl WidgetDoc {
    /// Decode a stored `widget_channels` document. Repository adapters need
    /// this to implement [`WidgetRepository`]; [`MongoWidgetRepository`] is the
    /// production caller.
    pub fn from_document(document: Document) -> Result<Self, WidgetServiceError> {
        decode_widget(document)
    }

    /// Serialize the in-memory state and merge it into the stored document.
    /// Paths in `replace` are written wholesale; object-valued siblings keep
    /// their unknown keys.
    fn state_bson_for_write(&self, replace: &[&str]) -> Result<Bson, WidgetServiceError> {
        let Bson::Document(incoming) = state_bson(&self.state)? else {
            return Err(storage("Widget state must serialize to a document"));
        };
        let mut merged = self.stored_state.clone();
        merge_document(&mut merged, incoming, "", replace);
        // The driver promotes safe Longs when the source reads the Mixed
        // document; write the same representation back, including unknown
        // keys.
        crate::utils::bson_compat::normalize_document(&mut merged);
        Ok(Bson::Document(merged))
    }
}

/// Recursively merge `incoming` over `target`. A dotted `replace` path is
/// written wholesale (for a new `run`, `config`, or `run.draw`); everything
/// else keeps unknown keys that exist only in `target`.
fn merge_document(target: &mut Document, incoming: Document, prefix: &str, replace: &[&str]) {
    for (key, value) in incoming {
        let path = if prefix.is_empty() { key.clone() } else { format!("{prefix}.{key}") };
        let previous = target.remove(key.as_str());
        match (previous, value) {
            (Some(Bson::Document(mut previous)), Bson::Document(incoming))
                if !replace.contains(&path.as_str()) =>
            {
                merge_document(&mut previous, incoming, &path, replace);
                target.insert(key, Bson::Document(previous));
            }
            (_, value) => {
                target.insert(key, value);
            }
        }
    }
}

/// Result of one `updateOne`. CAS uses `modified`. Token save uses `matched`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WriteOutcome {
    pub matched: bool,
    pub modified: bool,
}

/// Persistence seam. `MongoWidgetRepository` is the production adapter.
pub trait WidgetRepository: Send + Sync {
    fn load<'a>(&'a self, channel_id: &'a str) -> RepoFuture<'a, WidgetDoc>;
    fn update<'a>(&'a self, filter: Document, update: Document, journaled: bool) -> RepoFuture<'a, WriteOutcome>;
    fn token_store(&self, channel_id: &str) -> Box<dyn OverlayTokenStore>;
    fn token_exists<'a>(&'a self, channel_id: &'a str, token_hash: &'a str) -> RepoFuture<'a, bool>;
    fn has_premium<'a>(&'a self, channel_id: &'a str) -> RepoFuture<'a, bool>;
    fn active_target<'a>(&'a self, channel_id: &'a str) -> RepoFuture<'a, Option<WidgetEventTarget>>;
    fn find_active<'a>(&'a self, channel_id: &'a str) -> RepoFuture<'a, Option<WidgetDoc>>;
    fn due_ids<'a>(&'a self, now: i64) -> RepoFuture<'a, Vec<String>>;
    fn install_indexes<'a>(&'a self) -> RepoFuture<'a, ()>;
}

/// Mongo adapter for `widget_channels` plus the `users` premium query.
#[derive(Clone)]
pub struct MongoWidgetRepository {
    channels: Collection<Document>,
    journaled: Collection<Document>,
    users: Collection<Document>,
}

impl MongoWidgetRepository {
    /// Uses the caller's database. Does not connect or create indexes.
    pub fn new(database: &Database) -> Self {
        let concern = WriteConcern::builder().w(Acknowledgment::Nodes(1)).journal(true).build();
        let options = CollectionOptions::builder().write_concern(concern).build();
        Self {
            channels: database.collection(COLLECTION),
            journaled: database.collection_with_options(COLLECTION, options),
            users: crate::schemas::users::schema().native_collection(database),
        }
    }
}

fn premium_tiers() -> Vec<String> {
    PLAN_TIERS.iter().copied().filter(|tier| *tier != "free").map(str::to_owned).collect()
}

fn decode_widget(document: Document) -> Result<WidgetDoc, WidgetServiceError> {
    let revision_bson = document.get("revision").cloned().ok_or_else(|| storage("Missing widget revision"))?;
    let revision = numeric_i64(&revision_bson).ok_or_else(|| storage("Invalid widget revision"))?;
    let stored_state = match document.get("state") {
        Some(Bson::Document(state)) => state.clone(),
        Some(_) => return Err(storage("Invalid widget state")),
        None => return Err(storage("Missing widget state")),
    };
    let mut state: State = from_state_bson(&Bson::Document(stored_state.clone()))?;
    model::normalize(&mut state)?;
    let receipts = match document.get("receipts") {
        None | Some(Bson::Null) => Vec::new(),
        Some(value) => from_state_bson(value)?,
    };
    let event_settings = match document.get("eventSettings") {
        None | Some(Bson::Null) => None,
        Some(value) => Some(from_state_bson(value)?),
    };
    let event_receipts = match document.get("eventReceipts") {
        None | Some(Bson::Null) => Vec::new(),
        Some(value) => from_state_bson(value)?,
    };
    Ok(WidgetDoc { revision_bson, revision, state, stored_state, receipts, event_settings, event_receipts })
}

async fn load_widget(channels: &Collection<Document>, channel_id: &str) -> Result<WidgetDoc, WidgetServiceError> {
    channel_id(channel_id)?;
    if let Some(document) = channels
        .find_one(doc! { "_id": channel_id })
        .projection(doc! { "overlayToken": 0 })
        .await
        .map_err(storage)?
    {
        return decode_widget(document);
    }
    let insert = doc! {
        "_id": channel_id,
        "revision": 0i32,
        "state": state_bson(&model::initial())?,
        "receipts": [],
        "tokenHash": Bson::Null,
        "dueAt": Bson::Null,
        "eventReceipts": [],
    };
    match channels.insert_one(insert).await {
        Ok(_) => {}
        Err(error) if is_duplicate(&error) => {}
        Err(error) => return Err(storage(error)),
    }
    let document = channels
        .find_one(doc! { "_id": channel_id })
        .projection(doc! { "overlayToken": 0 })
        .await
        .map_err(storage)?
        .ok_or_else(|| storage("Widget channel disappeared after create"))?;
    decode_widget(document)
}

/// Ensures the widget channel document exists before a token read. Reuses the
/// module's existing [`load_widget`] initializer, so the token path inherits its
/// channel validation, `revision: 0` document creation, duplicate-key tolerance
/// and the initial `tokenHash: null`.
struct WidgetTokenGuard {
    channels: Collection<Document>,
    channel_id: String,
}

impl EnsureOverlayTokenDocument for WidgetTokenGuard {
    fn ensure<'a>(
        &'a self,
        _collection: &'a Collection<Document>,
        _id: &'a str,
    ) -> StoreFuture<'a, ()> {
        let channels = self.channels.clone();
        let channel_id = self.channel_id.clone();
        Box::pin(async move {
            load_widget(&channels, &channel_id)
                .await
                .map_err(|error| OverlayTokenError::Store(MongoError::custom(error.to_string())))?;
            Ok(())
        })
    }
}

impl WidgetRepository for MongoWidgetRepository {
    fn load<'a>(&'a self, channel_id: &'a str) -> RepoFuture<'a, WidgetDoc> {
        let channels = self.channels.clone();
        let channel_id = channel_id.to_owned();
        Box::pin(async move { load_widget(&channels, &channel_id).await })
    }

    fn update<'a>(&'a self, filter: Document, update: Document, journaled: bool) -> RepoFuture<'a, WriteOutcome> {
        let channels = if journaled { self.journaled.clone() } else { self.channels.clone() };
        Box::pin(async move {
            let saved = channels.update_one(filter, update).await.map_err(storage)?;
            Ok(WriteOutcome { matched: saved.matched_count == 1, modified: saved.modified_count > 0 })
        })
    }

    fn token_store(&self, channel_id: &str) -> Box<dyn OverlayTokenStore> {
        Box::new(
            MongoOverlayTokenStore::new(self.channels.clone(), channel_id.to_owned())
                .incrementing_revision()
                .ensuring(Arc::new(WidgetTokenGuard {
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

    fn has_premium<'a>(&'a self, channel_id: &'a str) -> RepoFuture<'a, bool> {
        let users = self.users.clone();
        let channel_id = channel_id.to_owned();
        Box::pin(async move {
            channel_id(&channel_id)?;
            let tiers = premium_tiers();
            Ok(users
                .find_one(doc! {
                    "accounts": { "$elemMatch": { "type": "twitch", "id": channel_id } },
                    "plan_tier": { "$in": tiers },
                })
                .projection(doc! { "_id": 1 })
                .await
                .map_err(storage)?
                .is_some())
        })
    }

    fn active_target<'a>(&'a self, channel_id: &'a str) -> RepoFuture<'a, Option<WidgetEventTarget>> {
        let channels = self.channels.clone();
        let channel_id = channel_id.to_owned();
        Box::pin(async move {
            channel_id(&channel_id)?;
            let Some(document) = channels
                .find_one(doc! { "_id": &channel_id, "eventSettings.enabled": true, "eventSettings.active": true })
                .projection(doc! { "eventSettings": 1 })
                .await
                .map_err(storage)?
            else {
                return Ok(None);
            };
            let Some(value) = document.get("eventSettings") else {
                return Ok(None);
            };
            let settings: DbdEventSettings = from_state_bson(value)?;
            Ok(Some(settings.target(&channel_id)))
        })
    }

    fn find_active<'a>(&'a self, channel_id: &'a str) -> RepoFuture<'a, Option<WidgetDoc>> {
        let channels = self.channels.clone();
        let channel_id = channel_id.to_owned();
        Box::pin(async move {
            let Some(document) = channels
                .find_one(doc! { "_id": channel_id, "eventSettings.enabled": true, "eventSettings.active": true })
                .await
                .map_err(storage)?
            else {
                return Ok(None);
            };
            if document.get("eventSettings").is_none() {
                return Ok(None);
            }
            Ok(Some(decode_widget(document)?))
        })
    }

    fn due_ids<'a>(&'a self, now: i64) -> RepoFuture<'a, Vec<String>> {
        let channels = self.channels.clone();
        Box::pin(async move {
            let rows: Vec<Document> = channels
                .find(doc! { "dueAt": { "$ne": Bson::Null, "$lte": js_number(now as f64) } })
                .projection(doc! { "_id": 1 })
                .sort(doc! { "dueAt": 1 })
                .limit(10)
                .await
                .map_err(storage)?
                .try_collect()
                .await
                .map_err(storage)?;
            rows.into_iter()
                .map(|row| row.get("_id").and_then(Bson::as_str).map(str::to_owned).ok_or_else(|| storage("Widget due row is missing a string _id")))
                .collect()
        })
    }

    fn install_indexes<'a>(&'a self) -> RepoFuture<'a, ()> {
        let channels = self.channels.clone();
        Box::pin(async move {
            let index = IndexModel::builder()
                .keys(doc! { "dueAt": 1 })
                .options(IndexOptions::builder().name("dueAt_1".to_owned()).build())
                .build();
            channels.create_index(index).await.map_err(storage)?;
            Ok(())
        })
    }
}

struct Inner {
    repo: Arc<dyn WidgetRepository>,
    polls: Arc<dyn PollGateway>,
    start_poll: WidgetStartPoll,
    codec: Arc<dyn OverlayTokenCodec>,
    logger: Option<Logger>,
}

/// Widget service. `native` wires Mongo, Twitch polls, and the canonical token codec.
#[derive(Clone)]
pub struct WidgetService {
    inner: Arc<Inner>,
}

impl WidgetService {
    /// Production wiring. `TwitchFunctions` is injected because this service does not build it.
    pub fn native(database: Database, twitch: TwitchFunctions, cipher: CredentialCipher, logger: Option<Logger>) -> Self {
        Self::with_adapters(
            Arc::new(MongoWidgetRepository::new(&database)),
            Arc::new(TwitchPollGateway::new(twitch)),
            Arc::new(NativeOverlayTokenCodec::new(cipher)),
            logger,
        )
    }

    /// Test seam. The native adapter above remains the production implementation.
    pub fn with_adapters(
        repo: Arc<dyn WidgetRepository>,
        polls: Arc<dyn PollGateway>,
        codec: Arc<dyn OverlayTokenCodec>,
        logger: Option<Logger>,
    ) -> Self {
        let start_poll = WidgetStartPoll::new(Arc::clone(&polls));
        Self { inner: Arc::new(Inner { repo, polls, start_poll, codec, logger }) }
    }

    /// Explicit composition root for the database. The poll host stays injected.
    pub async fn from_runtime(
        twitch: TwitchFunctions,
        cipher: CredentialCipher,
        logger: Option<Logger>,
    ) -> Result<Self, WidgetServiceError> {
        let client = crate::utils::mongo::get_mongo_client().await.map_err(storage)?;
        let database = client.default_database().ok_or_else(|| storage("Missing database"))?;
        Ok(Self::native(database, twitch, cipher, logger))
    }

    /// Logger used for unexpected HTTP failures. `None` means stderr.
    pub fn logger(&self) -> Option<&Logger> {
        self.inner.logger.as_ref()
    }

    /// Create `dueAt_1`. Not called from the constructor.
    pub async fn install_indexes(&self) -> Result<(), WidgetServiceError> {
        self.inner.repo.install_indexes().await
    }

    /// `hasPremium`.
    pub async fn has_premium(&self, channel_id: &str) -> Result<bool, WidgetServiceError> {
        self.inner.repo.has_premium(channel_id).await
    }

    /// `requirePremium`.
    pub async fn require_premium(&self, channel_id: &str) -> Result<(), WidgetServiceError> {
        if !self.has_premium(channel_id).await? {
            return Err(fail("premium_required", "Widgets Alpha requires Premium", 403).into());
        }
        Ok(())
    }

    /// Apply one widget action. Receipt replay wins before the `If-Match` revision check.
    pub async fn execute(
        &self,
        channel_id: &str,
        action: WidgetAction,
        body: &JsonValue,
        key: &str,
        revision: i64,
    ) -> Result<WidgetExecuteResult, WidgetServiceError> {
        self.require_premium(channel_id).await?;
        idempotency_key(Some(key))?;
        integer(&JsonValue::Number(revision as f64), "If-Match", 0, MAX_SAFE_INTEGER)?;
        object(body)?;
        let fingerprint = sha256_hex(
            &JsonValue::Object(vec![
                (JsString::from("action"), JsonValue::String(JsString::from(action.as_str()))),
                (JsString::from("data"), body.clone()),
            ])
            .to_json_string(),
        );
        let receipt_key = sha256_hex(key);
        for _ in 0..EXECUTE_ATTEMPTS {
            let mut document = self.inner.repo.load(channel_id).await?;
            let now = unix_millis();
            if let Some(receipt) = document.receipts.iter().find(|receipt| receipt.key == receipt_key && receipt_is_fresh(now, receipt.at)) {
                if receipt.fingerprint != fingerprint {
                    return Err(fail("idempotency_conflict", "Key already used for a different action", 409).into());
                }
                return Ok(WidgetExecuteResult { replayed: true });
            }
            if revision != document.revision {
                return Err(fail("revision_conflict", "Widget changed; refresh before trying again", 409).into());
            }
            let settings = apply_action(&mut document, action, body, now)?;
            let mut receipts: Vec<_> = std::mem::take(&mut document.receipts)
                .into_iter()
                .filter(|receipt| receipt_is_fresh(now, receipt.at))
                .collect();
            receipts.push(WidgetReceipt { key: receipt_key.clone(), fingerprint: fingerprint.clone(), at: now });
            let start = receipts.len().saturating_sub(200);
            let receipts = receipts.split_off(start.min(receipts.len()));
            // Actions that assign a brand-new object drop unknown keys in that
            // object, exactly like the source's plain object assignment.
            let replace: &[&str] = match action {
                WidgetAction::Select | WidgetAction::Role | WidgetAction::Start | WidgetAction::Reset => &["run"],
                WidgetAction::Configure => &["config"],
                WidgetAction::Layout => &["config.layout"],
                _ => &[],
            };
            let mut set = doc! {
                "state": document.state_bson_for_write(replace)?,
                "dueAt": document.state.next_at.map(|value| js_number(value as f64)).unwrap_or(Bson::Null),
                "receipts": state_bson(&receipts)?,
            };
            if let Some(settings) = settings {
                set.insert("eventSettings", state_bson(&settings)?);
            }
            let saved = self
                .inner
                .repo
                .update(
                    doc! { "_id": channel_id, "revision": document.revision_bson.clone() },
                    doc! { "$set": set, "$inc": { "revision": 1i32 } },
                    true,
                )
                .await?;
            if saved.modified {
                if matches!(action, WidgetAction::Start | WidgetAction::RetryPoll) && document.state.phase == Phase::PollStarting {
                    self.launch_poll(channel_id, &document.state, true).await?;
                }
                return Ok(WidgetExecuteResult { replayed: false });
            }
        }
        Err(fail("busy", "Widget is busy; retry with the same key", 409).into())
    }

    /// Stored rules, or the disabled default when the field is absent.
    pub async fn widget_event_settings(&self, channel_id: &str) -> Result<WidgetEventSettingsView, WidgetServiceError> {
        let document = self.inner.repo.load(channel_id).await?;
        Ok(WidgetEventSettingsView {
            revision: document.revision,
            settings: document.event_settings.unwrap_or_else(event_model::default_event_settings),
        })
    }

    /// Active target only. Does not create a channel document.
    pub async fn active_targets(&self, channel_id: &str) -> Result<Vec<WidgetEventTarget>, WidgetServiceError> {
        Ok(self.inner.repo.active_target(channel_id).await?.into_iter().collect())
    }

    /// Apply one bits event. A lost CAS is retried. Twenty misses is `Busy`, not a widget error.
    pub async fn apply_widget_event(&self, channel_id: &str, event: &DomainEventEnvelope) -> Result<(), WidgetServiceError> {
        if event.channel_id().and_then(Value::as_str) != Some(channel_id) {
            return Ok(());
        }
        for _ in 0..EXECUTE_ATTEMPTS {
            let Some(mut document) = self.inner.repo.find_active(channel_id).await? else {
                return Ok(());
            };
            let now = unix_millis();
            let Some(settings) = document.event_settings.clone() else {
                return Ok(());
            };
            if !events::widget_event_eligible(&settings.target(channel_id), event, now) || !self.has_premium(channel_id).await? {
                return Ok(());
            }
            let key = event.event_key().unwrap_or("").to_owned();
            if document.event_receipts.iter().any(|receipt| receipt.key == key) {
                return Ok(());
            }
            if !event_model::apply_dbd_event_rules(&mut document.state, &settings.rules, event)? {
                return Ok(());
            }
            let mut receipts: Vec<_> = std::mem::take(&mut document.event_receipts)
                .into_iter()
                .filter(|receipt| receipt_is_fresh(now, receipt.at))
                .collect();
            receipts.push(EventReceipt { key, at: now });
            let saved = self
                .inner
                .repo
                .update(
                    doc! {
                        "_id": channel_id,
                        "revision": document.revision_bson.clone(),
                        "eventSettings.enabled": true,
                        "eventSettings.active": true,
                    },
                    doc! {
                        "$set": { "state": document.state_bson_for_write(&[])?, "eventReceipts": state_bson(&receipts)? },
                        "$inc": { "revision": 1i32 },
                    },
                    true,
                )
                .await?;
            if saved.modified {
                return Ok(());
            }
        }
        Err(WidgetServiceError::Busy)
    }

    /// Advance one channel at most ten times. A missed CAS is not a client error.
    pub async fn advance(&self, channel_id: &str) -> Result<(), WidgetServiceError> {
        for _ in 0..ADVANCE_ATTEMPTS {
            let mut document = self.inner.repo.load(channel_id).await?;
            let now = unix_millis();
            if document.state.next_at.is_none_or(|due| due > now) {
                return Ok(());
            }
            if !self.has_premium(channel_id).await? {
                self.inner
                    .repo
                    .update(
                        doc! { "_id": channel_id, "revision": document.revision_bson.clone() },
                        doc! { "$set": { "dueAt": js_number((now + 60_000) as f64) } },
                        false,
                    )
                    .await?;
                return Ok(());
            }
            if document.state.phase == Phase::PollStarting {
                self.launch_poll(channel_id, &document.state, false).await?;
                return Ok(());
            }
            // Poll observation mutates the run in place. `settle` assigns a
            // fresh draw only from these phases; everywhere else the run and
            // its unknown keys stay in place.
            let replace: &[&str] = match document.state.phase {
                Phase::CharacterResult | Phase::Reveal | Phase::PerkResult => &["run.draw"],
                _ => &[],
            };
            let launch = if document.state.phase == Phase::Polling {
                observe_poll(self.inner.polls.as_ref(), channel_id, &mut document.state, now).await?;
                false
            } else {
                if !model::settle(&mut document.state, now)? {
                    return Ok(());
                }
                document.state.phase == Phase::PollStarting
            };
            let saved = self
                .inner
                .repo
                .update(
                    doc! { "_id": channel_id, "revision": document.revision_bson.clone() },
                    doc! {
                        "$set": {
                            "state": document.state_bson_for_write(replace)?,
                            "dueAt": document.state.next_at.map(|value| js_number(value as f64)).unwrap_or(Bson::Null),
                        },
                        "$inc": { "revision": 1i32 },
                    },
                    false,
                )
                .await?;
            if saved.modified {
                if launch {
                    self.launch_poll(channel_id, &document.state, true).await?;
                }
                return Ok(());
            }
        }
        Ok(())
    }

    /// `advance` then the public snapshot.
    pub async fn snapshot(&self, channel_id: &str) -> Result<WidgetSnapshot, WidgetServiceError> {
        self.advance(channel_id).await?;
        let document = self.inner.repo.load(channel_id).await?;
        Ok(WidgetSnapshot {
            revision: document.revision,
            server_time: unix_millis(),
            state: model::public_state(&document.state)?,
        })
    }

    /// Due channels, oldest first, at most ten. Each one is advanced, not snapshotted.
    pub async fn settle_due(&self) -> Result<(), WidgetServiceError> {
        for channel_id in self.inner.repo.due_ids(unix_millis()).await? {
            self.advance(&channel_id).await?;
        }
        Ok(())
    }

    /// Premium, then the current link.
    pub async fn overlay_token_state(&self, channel_id: &str) -> Result<OverlayTokenView, WidgetServiceError> {
        self.require_premium(channel_id).await?;
        Ok(read_overlay_token(self.inner.repo.token_store(channel_id).as_ref(), self.inner.codec.as_ref()).await?)
    }

    /// Premium, then create, recover, or rotate.
    pub async fn update_overlay_token(&self, channel_id: &str, input: &JsonValue) -> Result<OverlayTokenView, WidgetServiceError> {
        self.require_premium(channel_id).await?;
        Ok(manage_overlay_token(self.inner.repo.token_store(channel_id).as_ref(), self.inner.codec.as_ref(), input).await?)
    }

    /// Rotate using the version just read.
    pub async fn rotate_token(&self, channel_id: &str) -> Result<String, WidgetServiceError> {
        let current = self.overlay_token_state(channel_id).await?;
        let version = match current.version {
            Some(version) => JsonValue::String(JsString::from(version.as_str())),
            None => JsonValue::Null,
        };
        self.update_overlay_token(
            channel_id,
            &JsonValue::Object(vec![(JsString::from("rotate"), JsonValue::Bool(true)), (JsString::from("version"), version)]),
        )
        .await?
        .token
        .ok_or_else(|| storage("Rotated overlay token was not readable"))
    }

    /// OBS gate. A non-digit channel or a bad token is `false`, not a 400.
    pub async fn authorize_overlay(&self, channel_id: &str, token: Option<&str>) -> Result<bool, WidgetServiceError> {
        let Some(token) = token else {
            return Ok(false);
        };
        if channel_id(channel_id).is_err() || !token_shape(token) {
            return Ok(false);
        }
        let allowed = self.has_premium(channel_id).await? && self.inner.repo.token_exists(channel_id, &self.inner.codec.hash(token)).await?;
        if allowed {
            let _ = remember_overlay_token(self.inner.repo.token_store(channel_id).as_ref(), self.inner.codec.as_ref(), token).await;
        }
        Ok(allowed)
    }

    async fn launch_poll(&self, channel_id: &str, state: &State, create: bool) -> Result<(), WidgetServiceError> {
        match try_launch(self, channel_id, state, create).await {
            Ok(()) => Ok(()),
            Err(message) => save_poll(
                self.inner.repo.as_ref(),
                channel_id,
                state,
                doc! {
                    "state.phase": "poll-error",
                    "state.run.error": message,
                    "state.nextAt": Bson::Null,
                    "dueAt": Bson::Null,
                },
            )
            .await
            .map(|_| ()),
        }
    }
}

fn unknown_keys(body: &JsonValue, allowed: &[&str]) -> Result<bool, RouletteError> {
    Ok(object(body)?.iter().any(|(key, _)| key.as_str().is_none_or(|key| !allowed.contains(&key))))
}

fn json_text(value: Option<&JsonValue>) -> Option<&str> {
    value.and_then(|value| match value {
        JsonValue::String(value) => value.as_str(),
        _ => None,
    })
}

fn apply_action(document: &mut WidgetDoc, action: WidgetAction, body: &JsonValue, now: i64) -> Result<Option<DbdEventSettings>, RouletteError> {
    if !action.accepts_body() && !object(body)?.is_empty() {
        return Err(fail("invalid", "This action does not accept settings", 400));
    }
    let state = &mut document.state;
    match action {
        WidgetAction::Events => return Ok(Some(event_model::event_settings(body, now)?)),
        WidgetAction::Select => {
            model::idle(state)?;
            if unknown_keys(body, &["packId"])? {
                return Err(fail("invalid", "Unknown field", 400));
            }
            let pack_id = text(body.get("packId").unwrap_or(&JsonValue::Null), "packId", 120)?;
            state.pack_id = model::pack(&pack_id)?.id;
            state.phase = Phase::Idle;
            state.run = None;
            state.next_at = None;
        }
        WidgetAction::Configure => {
            model::idle(state)?;
            state.config = model::merge_config(&state.config, body)?;
            let targets = state.config.targets.clone().unwrap_or_else(model::default_targets);
            let wins = state.wins.get_or_insert_with(model::default_wins);
            wins.killer = wins.killer.min(targets.killer);
            wins.survivor = wins.survivor.min(targets.survivor);
        }
        WidgetAction::Role => {
            model::idle(state)?;
            let role = json_text(body.get("role"));
            if unknown_keys(body, &["role"])? || !matches!(role, Some("killer" | "survivor")) {
                return Err(fail("invalid", "Choose killer or survivor", 400));
            }
            state.pack_id = format!("dbd-{}-challenge", role.unwrap_or("killer"));
            state.phase = Phase::Idle;
            state.run = None;
            state.next_at = None;
        }
        WidgetAction::Layout => state.config.layout = Some(model::layout(body)?),
        WidgetAction::Progress => {
            let role = json_text(body.get("role"));
            let delta = match body.get("delta") {
                Some(JsonValue::Number(value)) if *value == 1.0 || *value == -1.0 => *value as i64,
                _ => return Err(fail("invalid", "Invalid progress change", 400)),
            };
            if unknown_keys(body, &["role", "delta"])? || !matches!(role, Some("killer" | "survivor")) {
                return Err(fail("invalid", "Invalid progress change", 400));
            }
            let targets = state.config.targets.clone().unwrap_or_else(model::default_targets);
            let wins = state.wins.get_or_insert_with(model::default_wins);
            let (slot, target) = if role == Some("survivor") { (&mut wins.survivor, targets.survivor) } else { (&mut wins.killer, targets.killer) };
            *slot = (*slot + delta).clamp(0, target);
        }
        WidgetAction::Start => {
            if unknown_keys(body, &["mode"])? {
                return Err(fail("invalid", "Unknown widget operation", 400));
            }
            let mode = match body.get("mode") {
                None => None,
                Some(value) => Some(json_text(Some(value)).and_then(Operation::parse).ok_or_else(|| fail("invalid", "Unknown widget operation", 400))?),
            };
            model::start(state, now, mode)?;
        }
        WidgetAction::Show => state.visible = true,
        WidgetAction::Hide => state.visible = false,
        WidgetAction::Reset => {
            if model::active(state) {
                return Err(fail("busy", "Wait for the current challenge to finish", 409));
            }
            state.phase = Phase::Idle;
            state.run = None;
            state.next_at = None;
        }
        WidgetAction::RetryPoll => {
            if state.phase != Phase::PollError || state.run.is_none() {
                return Err(fail("invalid", "No failed poll to retry", 400));
            }
            state.phase = Phase::PollStarting;
            state.next_at = Some(now + 30_000);
            if let Some(run) = state.run.as_mut() {
                run.error = None;
            }
        }
    }
    Ok(None)
}

fn choice_metric(choices: &Value, id: &str, field: &str) -> i64 {
    let Some(rows) = choices.as_array() else {
        return 0;
    };
    let Some(choice) = rows.iter().find(|choice| choice.get("id").and_then(Value::as_str) == Some(id)) else {
        return 0;
    };
    match choice.get(field) {
        Some(Value::Number(number)) => number.as_i64().or_else(|| number.as_f64().map(|value| value as i64)).unwrap_or(0),
        _ => 0,
    }
}

async fn observe_poll(polls: &dyn PollGateway, channel_id: &str, state: &mut State, now: i64) -> Result<(), WidgetServiceError> {
    if state.run.is_none() {
        return Err(storage("No widget run"));
    }
    let poll_id = state.run.as_ref().and_then(|run| run.poll_id.clone());
    let choice_ids = state.run.as_ref().map(|run| run.choice_ids.clone()).unwrap_or_default();
    let result = polls.get_poll(channel_id, poll_id.as_deref(), false).await?;
    // `result.error || !result.data`.
    let failed = result.get("error").is_some_and(js_truthy) || result.get("data").is_none_or(|data| !js_truthy(data));
    if failed {
        state.next_at = Some(now + 5_000);
        if let Some(run) = state.run.as_mut() {
            run.error = Some("Poll results temporarily unavailable".to_owned());
        }
        return Ok(());
    }
    let data = result.get("data").cloned().unwrap_or(Value::Null);
    let status = data.get("status").and_then(Value::as_str).unwrap_or("");
    let choices = data.get("choices").cloned().unwrap_or(Value::Null);
    if matches!(status, "COMPLETED" | "ARCHIVED") {
        if result_rejected(&data, poll_id.as_deref(), &choice_ids) {
            state.phase = Phase::PollError;
            state.next_at = None;
            if let Some(run) = state.run.as_mut() {
                run.error = Some("Unexpected Twitch poll result. No card was revealed.".to_owned());
            }
        } else {
            if let Some(run) = state.run.as_mut() {
                run.channel_points_votes = choice_ids.iter().map(|id| choice_metric(&choices, id, "channelPointsVotes")).collect();
            }
            let votes: Vec<i64> = choice_ids.iter().map(|id| choice_metric(&choices, id, "votes")).collect();
            model::reveal(state, &votes, now)?;
        }
    } else if status == "TERMINATED" {
        state.phase = Phase::PollError;
        state.next_at = None;
        if let Some(run) = state.run.as_mut() {
            run.error = Some("The Twitch poll was canceled. No card was revealed.".to_owned());
        }
    } else {
        let votes = choice_ids.iter().map(|id| choice_metric(&choices, id, "votes")).collect();
        let points = choice_ids.iter().map(|id| choice_metric(&choices, id, "channelPointsVotes")).collect();
        if let Some(run) = state.run.as_mut() {
            run.votes = votes;
            run.channel_points_votes = points;
            run.error = None;
        }
        state.next_at = Some(now + 3_000);
    }
    Ok(())
}

fn result_rejected(data: &Value, poll_id: Option<&str>, choice_ids: &[String]) -> bool {
    data.get("id").and_then(Value::as_str) != poll_id
        || choice_ids.iter().any(|id| {
            data.get("choices")
                .and_then(Value::as_array)
                .is_none_or(|choices| choices.iter().all(|choice| choice.get("id").and_then(Value::as_str) != Some(id.as_str())))
        })
}

async fn save_poll(repo: &dyn WidgetRepository, channel_id: &str, state: &State, set: Document) -> Result<(), WidgetServiceError> {
    let run_id = state.run.as_ref().map(|run| run.id.clone()).unwrap_or_default();
    repo.update(
        doc! { "_id": channel_id, "state.run.id": run_id, "state.phase": "poll-starting" },
        doc! { "$set": set, "$inc": { "revision": 1i32 } },
        false,
    )
    .await
    .map(|_| ())
}

async fn try_launch(service: &WidgetService, channel_id: &str, state: &State, create: bool) -> Result<(), String> {
    let run = state.run.as_ref().ok_or_else(|| "No widget run".to_owned())?;
    if !service.has_premium(channel_id).await.map_err(|error| error.to_string())? {
        return Ok(());
    }
    let mut poll = service.inner.polls.get_poll(channel_id, None, false).await.map_err(|error| error.to_string())?;
    let title_mismatch = poll.get("data").and_then(|data| data.get("title")).and_then(Value::as_str) != Some(run.poll_title.as_str());
    let terminated = poll.get("data").and_then(|data| data.get("status")).and_then(Value::as_str) == Some("TERMINATED");
    if (title_mismatch || terminated) && create {
        // `launchPoll`: `$(start.poll "<argument>")` through `start.poll`.
        let argument = start_poll_argument(state)?;
        service
            .inner
            .start_poll
            .start(channel_id, &argument)
            .await
            .map_err(launch_text)?;
        poll = service.inner.polls.get_poll(channel_id, None, false).await.map_err(|error| error.to_string())?;
    }
    if !poll_is_confirmed(&poll, &run.poll_title) {
        return Err("Could not confirm the widget poll. Check Twitch before retrying.".to_owned());
    }
    let data = poll.get("data").cloned().unwrap_or(Value::Null);
    let choice_ids: Vec<String> = data
        .get("choices")
        .and_then(Value::as_array)
        .map(|choices| choices.iter().filter_map(|choice| choice.get("id").and_then(Value::as_str).map(str::to_owned)).collect())
        .unwrap_or_default();
    let poll_id = data.get("id").and_then(Value::as_str).unwrap_or("").to_owned();
    let now = unix_millis();
    save_poll(
        service.inner.repo.as_ref(),
        channel_id,
        state,
        doc! {
            "state.phase": "polling",
            "state.run.pollId": poll_id,
            "state.run.choiceIds": choice_ids,
            "state.run.pollEndsAt": js_number((now + state.config.poll_seconds * 1000) as f64),
            "state.run.error": Bson::Null,
            "state.nextAt": js_number(now as f64),
            "dueAt": js_number(now as f64),
        },
    )
    .await
    .map_err(|error| error.to_string())
}

/// Concrete `dbd-challenge` adapter. Persistence stays in `WidgetService`.
pub struct DbdChallengeAdapter {
    service: WidgetService,
}

impl DbdChallengeAdapter {
    /// One adapter bound to the channel service.
    pub fn new(service: WidgetService) -> Self {
        Self { service }
    }
}

impl WidgetEventAdapter for DbdChallengeAdapter {
    fn id(&self) -> &str {
        "dbd-challenge"
    }

    fn event_types(&self) -> &[&str] {
        &["channel.bits.received"]
    }

    fn targets<'a>(&'a self, channel_id: &'a str) -> DomainEventFuture<'a, Vec<WidgetEventTarget>> {
        let service = self.service.clone();
        let channel_id = channel_id.to_owned();
        Box::pin(async move {
            service.active_targets(&channel_id).await.map_err(|error| -> Box<dyn Error + Send + Sync> { Box::new(error) })
        })
    }

    fn apply<'a>(&'a self, target: &'a WidgetEventTarget, event: &'a DomainEventEnvelope) -> DomainEventFuture<'a, ()> {
        let service = self.service.clone();
        let channel_id = target.id.clone();
        let event = event.clone();
        Box::pin(async move {
            service.apply_widget_event(&channel_id, &event).await.map_err(|error| -> Box<dyn Error + Send + Sync> { Box::new(error) })
        })
    }
}

/// The one production adapter registered for widget events.
pub fn widget_event_adapters(service: WidgetService) -> Vec<Arc<dyn WidgetEventAdapter>> {
    vec![Arc::new(DbdChallengeAdapter::new(service))]
}

/// Handler for the domain-event runtime. Duplicate ids fail at registration.
pub fn apply_widget_domain_event(service: WidgetService) -> Result<Arc<DomainEventHandler>, events::DuplicateAdapterError> {
    events::create_widget_event_handler(widget_event_adapters(service))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::credential_crypto::StoredCredential;
    use crate::utils::overlay_token::OverlayTokenDocument;

    #[test]
    fn card_labels_and_poll_confirmation_match_the_source() {
        assert_eq!(choice_titles(Language::En), vec!["Card 1", "Card 2", "Card 3", "Card 4", "Card 5"]);
        assert_eq!(choice_titles(Language::Es)[0], "Carta 1");
        let poll = json!({
            "error": false,
            "data": {
                "id": "p",
                "title": "DBD",
                "status": "ACTIVE",
                "choices": [{"id": "1"}, {"id": "2"}, {"id": "3"}, {"id": "4"}, {"id": "5"}]
            }
        });
        assert!(poll_is_confirmed(&poll, "DBD"));
        let terminated = json!({
            "error": false,
            "data": { "id": "p", "title": "DBD", "status": "TERMINATED", "choices": [1, 2, 3, 4, 5] }
        });
        assert!(!poll_is_confirmed(&terminated, "DBD"));
        assert_eq!(if_match_revision(Some("")).expect("empty"), 0);
        assert!(if_match_revision(None).is_err());
    }

    use crate::widgets_runtime::model::Run;
    use std::{collections::VecDeque, sync::Mutex};

    const CHANNEL: &str = "12345";
    const TITLE: &str = "DBD: Choose a card (abc12345)";

    #[derive(Clone, Debug)]
    struct CreateCall {
        channel: String,
        title: String,
        choices: Value,
        duration: Value,
        cache: bool,
        points: f64,
    }

    struct TestPolls {
        gets: Mutex<VecDeque<Value>>,
        creates: Mutex<Vec<CreateCall>>,
        create_result: Value,
    }

    impl TestPolls {
        fn new(gets: Vec<Value>, create_result: Value) -> Self {
            Self { gets: Mutex::new(gets.into()), creates: Mutex::new(Vec::new()), create_result }
        }

        fn creates(&self) -> std::sync::MutexGuard<'_, Vec<CreateCall>> {
            self.creates.lock().expect("poll creates")
        }
    }

    impl PollGateway for TestPolls {
        fn get_poll<'a>(&'a self, _channel: &'a str, _poll_id: Option<&'a str>, _cache: bool) -> PollFuture<'a> {
            let next = self
                .gets
                .lock()
                .expect("poll gets")
                .pop_front()
                .unwrap_or_else(|| json!({"error": true, "message": "not found"}));
            Box::pin(async move { Ok(next) })
        }

        fn create_poll<'a>(
            &'a self,
            channel: &'a str,
            title: &'a str,
            choices: &'a Value,
            duration: &'a Value,
            cache: bool,
            points: f64,
        ) -> PollFuture<'a> {
            self.creates.lock().expect("poll creates").push(CreateCall {
                channel: channel.to_owned(),
                title: title.to_owned(),
                choices: choices.clone(),
                duration: duration.clone(),
                cache,
                points,
            });
            let result = self.create_result.clone();
            Box::pin(async move { Ok(result) })
        }
    }

    struct TestRepo {
        document: Mutex<WidgetDoc>,
        updates: Mutex<Vec<(Document, Document, bool)>>,
    }

    impl TestRepo {
        fn new(document: WidgetDoc) -> Self {
            Self { document: Mutex::new(document), updates: Mutex::new(Vec::new()) }
        }

        fn updates(&self) -> std::sync::MutexGuard<'_, Vec<(Document, Document, bool)>> {
            self.updates.lock().expect("repo updates")
        }
    }

    impl WidgetRepository for TestRepo {
        fn load<'a>(&'a self, _channel_id: &'a str) -> RepoFuture<'a, WidgetDoc> {
            let document = self.document.lock().expect("repo document").clone();
            Box::pin(async move { Ok(document) })
        }

        fn update<'a>(&'a self, filter: Document, update: Document, journaled: bool) -> RepoFuture<'a, WriteOutcome> {
            self.updates.lock().expect("repo updates").push((filter, update, journaled));
            Box::pin(async move { Ok(WriteOutcome { matched: true, modified: true }) })
        }

        fn token_store(&self, _channel_id: &str) -> Box<dyn OverlayTokenStore> {
            Box::new(TestTokens)
        }

        fn token_exists<'a>(&'a self, _channel_id: &'a str, _token_hash: &'a str) -> RepoFuture<'a, bool> {
            Box::pin(async { Ok(false) })
        }

        fn has_premium<'a>(&'a self, _channel_id: &'a str) -> RepoFuture<'a, bool> {
            Box::pin(async { Ok(true) })
        }

        fn active_target<'a>(&'a self, _channel_id: &'a str) -> RepoFuture<'a, Option<WidgetEventTarget>> {
            Box::pin(async { Ok(None) })
        }

        fn find_active<'a>(&'a self, _channel_id: &'a str) -> RepoFuture<'a, Option<WidgetDoc>> {
            let document = self.document.lock().expect("repo document").clone();
            Box::pin(async move { Ok(Some(document)) })
        }

        fn due_ids<'a>(&'a self, _now: i64) -> RepoFuture<'a, Vec<String>> {
            Box::pin(async { Ok(Vec::new()) })
        }

        fn install_indexes<'a>(&'a self) -> RepoFuture<'a, ()> {
            Box::pin(async { Ok(()) })
        }
    }

    struct TestTokens;

    impl OverlayTokenStore for TestTokens {
        fn read(&self) -> StoreFuture<'_, OverlayTokenDocument> {
            Box::pin(async { Err(OverlayTokenError::Store(MongoError::custom("token store unused"))) })
        }

        fn save<'a>(
            &'a self,
            _expected_hash: Option<String>,
            _token_hash: String,
            _overlay_token: StoredCredential,
            _replace: bool,
        ) -> StoreFuture<'a, bool> {
            Box::pin(async { Err(OverlayTokenError::Store(MongoError::custom("token store unused"))) })
        }
    }

    struct TestCodec;

    impl OverlayTokenCodec for TestCodec {
        fn hash(&self, token: &str) -> String {
            format!("hash:{token}")
        }

        fn encrypt(&self, token: &str) -> Result<StoredCredential, crate::utils::credential_crypto::CredentialCryptoError> {
            Ok(StoredCredential { iv: None, content: Some(token.to_owned()) })
        }

        fn decrypt(
            &self,
            envelope: Option<&StoredCredential>,
        ) -> Result<Option<String>, crate::utils::credential_crypto::CredentialCryptoError> {
            Ok(envelope.and_then(|value| value.content.clone()))
        }

        fn random_token(&self) -> Result<String, crate::utils::credential_crypto::CredentialCryptoError> {
            Ok("token".to_owned())
        }
    }

    fn widget_state(phase: Phase, run: Option<Run>, next_at: Option<i64>) -> State {
        let mut state = model::initial();
        state.phase = phase;
        state.run = run;
        state.next_at = next_at;
        state
    }

    fn poll_run(title: &str) -> Run {
        Run {
            operation: Some(Operation::Poll),
            sequence: None,
            id: "run-1".to_owned(),
            character_id: None,
            perk_ids: Vec::new(),
            draw: None,
            cards: vec![0, 1, 2, 3, 4],
            votes: vec![0; 5],
            channel_points_votes: vec![0; 5],
            winning_card: None,
            perk_count: None,
            poll_id: None,
            choice_ids: Vec::new(),
            poll_title: title.to_owned(),
            poll_ends_at: None,
            joker: None,
            error: Some("previous failure".to_owned()),
        }
    }

    fn poll_choices() -> Value {
        json!([
            {"id": "1", "title": "Card 1", "votes": 0, "channelPointsVotes": 0},
            {"id": "2", "title": "Card 2", "votes": 0, "channelPointsVotes": 0},
            {"id": "3", "title": "Card 3", "votes": 0, "channelPointsVotes": 0},
            {"id": "4", "title": "Card 4", "votes": 0, "channelPointsVotes": 0},
            {"id": "5", "title": "Card 5", "votes": 0, "channelPointsVotes": 0}
        ])
    }

    fn confirmed_poll(title: &str) -> Value {
        json!({
            "error": false,
            "data": {
                "id": "poll-1",
                "title": title,
                "status": "ACTIVE",
                "choices": poll_choices()
            }
        })
    }

    fn created_poll(title: &str) -> Value {
        json!({
            "id": "poll-1",
            "title": title,
            "status": "ACTIVE",
            "choices": poll_choices()
        })
    }

    fn stored_document(state: &State, revision: i64) -> Document {
        doc! {
            "_id": CHANNEL,
            "revision": revision,
            "state": state_bson(state).expect("state"),
            "receipts": Bson::Array(Vec::new()),
            "tokenHash": Bson::Null,
            "dueAt": Bson::Null,
            "eventReceipts": Bson::Array(Vec::new()),
        }
    }

    fn widget_document(state: &State, revision: i64) -> WidgetDoc {
        WidgetDoc::from_document(stored_document(state, revision)).expect("widget document")
    }

    fn add_unknown_state_keys(document: &mut Document) {
        let Some(Bson::Document(state)) = document.get_mut("state") else { panic!("state document") };
        state.insert("futureFlag", "keep");
        let Some(Bson::Document(run)) = state.get_mut("run") else { panic!("run document") };
        run.insert("futureRunField", 7i32);
    }

    fn service(repo: &Arc<TestRepo>, polls: &Arc<TestPolls>) -> WidgetService {
        WidgetService::with_adapters(Arc::clone(repo), Arc::clone(polls), Arc::new(TestCodec), None)
    }

    #[tokio::test]
    async fn retry_poll_runs_start_poll_and_saves_the_polling_state() {
        let state = widget_state(Phase::PollError, Some(poll_run(TITLE)), None);
        let mut document = stored_document(&state, 3);
        add_unknown_state_keys(&mut document);
        let repo = Arc::new(TestRepo::new(WidgetDoc::from_document(document).expect("document")));
        let polls = Arc::new(TestPolls::new(
            vec![json!({"error": true, "message": "not found"}), confirmed_poll(TITLE)],
            created_poll(TITLE),
        ));
        service(&repo, &polls)
            .execute(CHANNEL, WidgetAction::RetryPoll, &JsonValue::Object(Vec::new()), "key-1", 3)
            .await
            .expect("execute");

        let creates = polls.creates();
        assert_eq!(creates.len(), 1);
        assert_eq!(creates[0].channel, CHANNEL);
        assert_eq!(creates[0].title, TITLE);
        assert_eq!(creates[0].duration, json!(30));
        assert_eq!(creates[0].points, 0.0);
        assert!(!creates[0].cache);
        assert_eq!(
            creates[0].choices,
            json!([
                {"title": "Card 1"},
                {"title": "Card 2"},
                {"title": "Card 3"},
                {"title": "Card 4"},
                {"title": "Card 5"}
            ])
        );
        drop(creates);

        let updates = repo.updates();
        assert_eq!(updates.len(), 2, "action CAS and the launch save");
        let cas = updates[0].1.get_document("$set").expect("$set").get_document("state").expect("state");
        assert_eq!(cas.get_str("futureFlag").expect("future flag"), "keep");
        assert_eq!(
            cas.get_document("run").expect("run").get_i32("futureRunField").expect("future run field"),
            7
        );

        let (filter, update, journaled) = &updates[1];
        assert!(!*journaled, "savePoll has no explicit journaled write concern");
        assert_eq!(filter.get_str("state.phase").expect("phase"), "poll-starting");
        assert_eq!(filter.get_str("state.run.id").expect("run"), "run-1");
        let set = update.get_document("$set").expect("$set");
        assert_eq!(set.get_str("state.phase").expect("phase"), "polling");
        assert_eq!(set.get_str("state.run.pollId").expect("poll"), "poll-1");
        assert_eq!(
            set.get_array("state.run.choiceIds").expect("choices"),
            &vec![
                Bson::String("1".to_owned()),
                Bson::String("2".to_owned()),
                Bson::String("3".to_owned()),
                Bson::String("4".to_owned()),
                Bson::String("5".to_owned())
            ]
        );
        assert!(set.get("state.run.pollEndsAt").is_some());
        assert!(set.get("state.nextAt").is_some());
        assert!(set.get("dueAt").is_some());
        assert_eq!(set.get("state.run.error"), Some(&Bson::Null));
    }

    #[tokio::test]
    async fn create_failure_saves_the_source_text_and_stops_before_polling() {
        let long = "x".repeat(400);
        let expected: String = format!("Error starting poll: {long}").chars().take(300).collect();
        let state = widget_state(Phase::PollError, Some(poll_run(TITLE)), None);
        let repo = Arc::new(TestRepo::new(widget_document(&state, 1)));
        let polls = Arc::new(TestPolls::new(
            vec![json!({"error": true, "message": "not found"})],
            json!({"error": true, "message": long}),
        ));
        service(&repo, &polls)
            .execute(CHANNEL, WidgetAction::RetryPoll, &JsonValue::Object(Vec::new()), "key-2", 1)
            .await
            .expect("execute");

        let updates = repo.updates();
        let set = updates.last().expect("save poll").1.get_document("$set").expect("$set");
        assert_eq!(set.get_str("state.phase").expect("phase"), "poll-error");
        assert_eq!(set.get_str("state.run.error").expect("error"), expected);
        assert_eq!(set.get("state.nextAt"), Some(&Bson::Null));
        assert_eq!(set.get("dueAt"), Some(&Bson::Null));
    }

    #[tokio::test]
    async fn unconfirmed_creation_saves_the_source_confirmation_error() {
        let state = widget_state(Phase::PollError, Some(poll_run(TITLE)), None);
        let repo = Arc::new(TestRepo::new(widget_document(&state, 1)));
        let other_title = json!({
            "error": false,
            "data": {
                "id": "poll-2",
                "title": "Other poll",
                "status": "ACTIVE",
                "choices": poll_choices()
            }
        });
        let polls = Arc::new(TestPolls::new(
            vec![json!({"error": true, "message": "not found"}), other_title],
            created_poll(TITLE),
        ));
        service(&repo, &polls)
            .execute(CHANNEL, WidgetAction::RetryPoll, &JsonValue::Object(Vec::new()), "key-3", 1)
            .await
            .expect("execute");

        let updates = repo.updates();
        let set = updates.last().expect("save poll").1.get_document("$set").expect("$set");
        assert_eq!(set.get_str("state.phase").expect("phase"), "poll-error");
        assert_eq!(
            set.get_str("state.run.error").expect("error"),
            "Could not confirm the widget poll. Check Twitch before retrying."
        );
    }

    #[tokio::test]
    async fn an_accepted_poll_is_recovered_without_creating_a_second_one() {
        let state = widget_state(Phase::PollError, Some(poll_run(TITLE)), None);
        let repo = Arc::new(TestRepo::new(widget_document(&state, 1)));
        let polls = Arc::new(TestPolls::new(
            vec![confirmed_poll(TITLE)],
            json!({"error": true, "message": "must not be called"}),
        ));
        service(&repo, &polls)
            .execute(CHANNEL, WidgetAction::RetryPoll, &JsonValue::Object(Vec::new()), "key-4", 1)
            .await
            .expect("execute");
        assert!(polls.creates().is_empty());
        let updates = repo.updates();
        let set = updates.last().expect("save poll").1.get_document("$set").expect("$set");
        assert_eq!(set.get_str("state.phase").expect("phase"), "polling");
        assert_eq!(set.get_str("state.run.pollId").expect("poll"), "poll-1");
    }

    #[tokio::test]
    async fn advancing_a_starting_poll_never_creates_a_second_one() {
        let state = widget_state(Phase::PollStarting, Some(poll_run(TITLE)), Some(0));
        let repo = Arc::new(TestRepo::new(widget_document(&state, 1)));
        let polls = Arc::new(TestPolls::new(
            vec![confirmed_poll("Other poll")],
            json!({"error": true, "message": "must not be called"}),
        ));
        service(&repo, &polls).advance(CHANNEL).await.expect("advance");
        assert!(polls.creates().is_empty());
        let updates = repo.updates();
        let set = updates.last().expect("save poll").1.get_document("$set").expect("$set");
        assert_eq!(set.get_str("state.phase").expect("phase"), "poll-error");
        assert_eq!(
            set.get_str("state.run.error").expect("error"),
            "Could not confirm the widget poll. Check Twitch before retrying."
        );
    }

    #[tokio::test]
    async fn polling_with_null_data_waits_and_stays_in_polling() {
        let mut state = widget_state(Phase::Polling, Some(poll_run(TITLE)), Some(0));
        {
            let run = state.run.as_mut().expect("run");
            run.poll_id = Some("poll-1".to_owned());
            run.choice_ids = vec!["1".to_owned(), "2".to_owned(), "3".to_owned(), "4".to_owned(), "5".to_owned()];
        }
        let repo = Arc::new(TestRepo::new(widget_document(&state, 1)));
        let polls = Arc::new(TestPolls::new(
            vec![json!({"error": false, "data": null})],
            json!({"error": true}),
        ));
        service(&repo, &polls).advance(CHANNEL).await.expect("advance");

        let updates = repo.updates();
        let set = updates.last().expect("state save").1.get_document("$set").expect("$set");
        let state = set.get_document("state").expect("state");
        assert_eq!(state.get_str("phase").expect("phase"), "polling");
        assert_eq!(
            state.get_document("run").expect("run").get_str("error").expect("error"),
            "Poll results temporarily unavailable"
        );
        assert!(state.get("nextAt").is_some());
    }

    #[tokio::test]
    async fn polling_results_reveal_and_keep_unknown_state_keys() {
        let mut state = widget_state(Phase::Polling, Some(poll_run(TITLE)), Some(0));
        {
            let run = state.run.as_mut().expect("run");
            run.poll_id = Some("poll-1".to_owned());
            run.choice_ids = vec!["1".to_owned(), "2".to_owned(), "3".to_owned(), "4".to_owned(), "5".to_owned()];
        }
        let mut document = stored_document(&state, 2);
        add_unknown_state_keys(&mut document);
        let repo = Arc::new(TestRepo::new(WidgetDoc::from_document(document).expect("document")));
        let completed = json!({
            "error": false,
            "data": {
                "id": "poll-1",
                "title": TITLE,
                "status": "COMPLETED",
                "choices": [
                    {"id": "1", "votes": 1, "channelPointsVotes": 10},
                    {"id": "2", "votes": 5, "channelPointsVotes": 20},
                    {"id": "3", "votes": 2, "channelPointsVotes": 30},
                    {"id": "4", "votes": 0, "channelPointsVotes": 40},
                    {"id": "5", "votes": 3, "channelPointsVotes": 50}
                ]
            }
        });
        let polls = Arc::new(TestPolls::new(vec![completed], json!({"error": true})));
        service(&repo, &polls).advance(CHANNEL).await.expect("advance");

        let updates = repo.updates();
        let set = updates.last().expect("state save").1.get_document("$set").expect("$set");
        let state = set.get_document("state").expect("state");
        assert_eq!(state.get_str("futureFlag").expect("future flag"), "keep");
        let run = state.get_document("run").expect("run");
        assert_eq!(run.get_i32("futureRunField").expect("future run field"), 7);
        assert_eq!(state.get_str("phase").expect("phase"), "reveal");
        assert_eq!(run.get_i32("winningCard").expect("winning card"), 1);
        assert_eq!(
            run.get_array("votes").expect("votes").to_vec(),
            vec![
                Bson::Int32(1),
                Bson::Int32(5),
                Bson::Int32(2),
                Bson::Int32(0),
                Bson::Int32(3)
            ]
        );
        assert_eq!(
            run.get_array("channelPointsVotes").expect("points").to_vec(),
            vec![
                Bson::Int32(10),
                Bson::Int32(20),
                Bson::Int32(30),
                Bson::Int32(40),
                Bson::Int32(50)
            ]
        );
    }
}

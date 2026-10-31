//! Durable winner-action claim and delivery.
//!
//! Ports `dimabot/src/roulette/actions.ts`. A claim is written before any
//! external effect and is never replayed: a crash after the claim leaves the
//! row `running`. Completion of an open draw goes through
//! [`RouletteService::snapshot`] before that claim, matching `snapshot()` in
//! the source.
//!
//! # Scheduling
//!
//! This module does not sleep. `actions.ts` has no timer. The one-second poll
//! lives in `dimabot/src/workers/roulette-actions.worker.ts`,
//! which is still the cron entrypoint (`roulette-actions` in
//! `cron.index.ts`):
//!
//! | Source wait | Owner | Why it stays there |
//! |---|---|---|
//! | `setTimeout(..., 1000)` after every `runDueActions()` pass, including a full batch, unless `--once` or a stop signal | TypeScript worker loop | Idle poll between passes. It is not inside the claim/delivery function. This port does not add it. |
//! | `SIGTERM` / `SIGINT` set `stopping` and finish the current pass | TypeScript worker | Orderly shutdown. Not a delivery delay. |
//! | `--dry-run` prints and does not call `runDueActions` | TypeScript worker | Process entry, not action logic. |
//! | `--once` runs one pass and skips the sleep | TypeScript worker | Same entrypoint. |
//!
//! One pass handles at most four channels, in `actionDueAt` order, and one
//! pending action per channel. A larger backlog waits for the next call.
//! That next call is the worker's job. Channels in a pass run one after
//! another because the AST runtime is not `Send`. The source starts the same
//! per-channel sequence with `Promise.all`. Each channel still does snapshot,
//! then claim, then execute, then finish. A snapshot or storage error skips
//! that channel's effects, continues the rest of the batch, and is returned
//! afterwards.
//!
//! `ROULETTE.md` mentions skipping an action after a Pro downgrade. `actions.ts`
//! does not. This port does not add that skip.
//!
//! # Adapters
//!
//! Delivery calls the shared AST runtime. `BotRuntime` implements
//! [`WinnerExecutor`]: it parses with `AstBodyParser` (`parse_special_commands`)
//! and sends with `BotRuntime::deliver`, which calls `deliver_ast_message`
//! through `TwitchChatSender` and the command executor. A caller passes that
//! runtime to [`run_due_actions`]. `TwitchStreamers::account_by_id` is the
//! owner lookup. A missing account becomes the source's `null` owner. Any
//! other directory error is logged and also treated as a missing owner, which
//! is `getTwitchAccountById`'s `catch`.
//!
//! The native delivery adapter stops on [`AstRuntimeError::Cancelled`] instead
//! of logging and continuing. The TypeScript `deliverAstMessage` has no
//! cancellation type, so a cancelled reference fails the winner action here.
//! Every other reference error keeps the adapter's log-and-continue rule.
//!
//! `parseSpecialCommands` returns rendered text when a placeholder fails and
//! when the template compiler records an expression error. It does not throw.
//! This port delivers that text. [`ActionError::Evaluation`] is only a parser
//! or delivery `Err`.
//!
//! `RouletteRepository::due_ids` reads draw `dueAt`, and `ChannelDoc` keeps
//! `actions` private. Claim and finish therefore use [`MongoActionStore`] on
//! the same `roulette_channels` collection. The `actionDueAt_1` index stays
//! with [`RouletteService::install_indexes`].

#![cfg(feature = "widgets-runtime")]

use std::{error::Error, fmt, sync::Arc};

use futures_util::TryStreamExt;
use mongodb::{
    Collection, Database,
    bson::{Bson, Document, doc},
};

use crate::utils::{
    ast_evaluator::JsValue,
    ast_runtime::{
        AstBodyParser, AstMessage, AstRuntimeError, SpecialParserContext,
        command::CommandStore,
        delivery::{DeliverySeams, deliver_ast_message},
        wiring::BotRuntime,
    },
    bson_compat::js_number,
    twitch_streamers::{DirectoryError, TwitchStreamers},
};

use super::{
    action_model::{ActionStatus, WinnerAction},
    service::{self, RouletteService, ServiceError, action_due},
};

/// Source `for (let attempt = 0; attempt < 20; attempt++)`.
pub const CLAIM_ATTEMPTS: usize = 20;

/// Source `limit(4)` on the `actionDueAt` query.
pub const DUE_ACTION_BATCH: i64 = 4;

/// Failure from claim, settlement, or delivery.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ActionError {
    /// MongoDB rejected a read or a write. The action row is unchanged when
    /// this happens before a successful claim.
    Storage(String),
    /// [`RouletteService::snapshot`] failed. The channel was not claimed.
    Settlement(ServiceError),
    /// The AST runtime failed before a successful delivery result.
    Evaluation(String),
    /// `deliverAstMessage` returned `{ error: true }`. The source throws
    /// `Winner action delivery failed`.
    Delivery,
}

impl fmt::Display for ActionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Storage(message) | Self::Evaluation(message) => formatter.write_str(message),
            Self::Settlement(error) => error.fmt(formatter),
            Self::Delivery => formatter.write_str("Winner action delivery failed"),
        }
    }
}

impl Error for ActionError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Settlement(error) => Some(error),
            _ => None,
        }
    }
}

fn storage(error: impl fmt::Display) -> ActionError {
    ActionError::Storage(error.to_string())
}

fn evaluation(error: AstRuntimeError) -> ActionError {
    ActionError::Evaluation(error.message().to_owned())
}

/// Clock for the query, the claim, and `finishedAt`. The source calls
/// `Date.now()` at each of those sites.
pub trait ActionClock {
    fn now_ms(&self) -> i64;
}

/// `Date.now()` via the roulette service clock.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemActionClock;

impl ActionClock for SystemActionClock {
    fn now_ms(&self) -> i64 {
        service::unix_millis()
    }
}

/// Loaded actions plus the revision BSON used for compare-and-set.
///
/// The revision value is not re-encoded. MongoDB equality is type-sensitive,
/// and the source filter uses the stored `revision` as read.
#[derive(Clone, Debug, PartialEq)]
pub struct ActionChannel {
    pub revision: Bson,
    pub actions: Vec<WinnerAction>,
}

/// Persistence for `claimAction` and the finish update. [`MongoActionStore`]
/// is the production adapter.
pub trait ActionStore {
    async fn due_channel_ids(&self, now: i64) -> Result<Vec<String>, ActionError>;

    async fn load_actions(&self, channel_id: &str) -> Result<Option<ActionChannel>, ActionError>;

    async fn claim_update(
        &self,
        channel_id: &str,
        revision: &Bson,
        actions: &[WinnerAction],
        action_due_at: Option<i64>,
    ) -> Result<bool, ActionError>;

    async fn finish_running(
        &self,
        channel_id: &str,
        draw_id: &str,
        status: ActionStatus,
        finished_at: i64,
    ) -> Result<(), ActionError>;
}

/// `snapshot(channelId)` before a claim. [`RouletteService`] is the production
/// adapter and settles removal in the same write as completion.
pub trait DrawSettlement {
    async fn snapshot(&self, channel_id: &str) -> Result<(), ActionError>;
}

impl DrawSettlement for RouletteService {
    async fn snapshot(&self, channel_id: &str) -> Result<(), ActionError> {
        RouletteService::snapshot(self, channel_id)
            .await
            .map(|_| ())
            .map_err(ActionError::Settlement)
    }
}

/// One winner-action execution. [`BotRuntime`] is the production adapter.
pub trait WinnerExecutor {
    async fn execute(&mut self, channel_id: &str, job: &WinnerAction) -> Result<(), ActionError>;
}

/// MongoDB adapter for `roulette_channels` action rows.
///
/// Construction does not connect and does not create indexes. A missing
/// channel is left missing: the source `findById` returns null and does not
/// insert.
#[derive(Clone)]
pub struct MongoActionStore {
    channels: Collection<Document>,
}

impl MongoActionStore {
    /// Uses the caller's database and the source collection name.
    pub fn new(database: &Database) -> Self {
        Self {
            channels: database.collection(service::COLLECTION),
        }
    }

    /// Source collection `roulette_channels`.
    pub fn collection_name() -> &'static str {
        service::COLLECTION
    }

    /// Explicit connection. Not called from [`run_due_actions`].
    ///
    /// The TypeScript label `getMongoDBConnection('roulette-actions')` is a
    /// debug name on the shared client. The native client reads `MONGO_URI`
    /// through [`crate::utils::mongo::get_mongo_client`].
    pub async fn from_runtime() -> Result<Self, ActionError> {
        let client = crate::utils::mongo::get_mongo_client().await.map_err(|error| storage(error))?;
        let database = client
            .default_database()
            .ok_or_else(|| ActionError::Storage("Missing database".to_owned()))?;
        Ok(Self::new(&database))
    }
}

impl ActionStore for MongoActionStore {
    async fn due_channel_ids(&self, now: i64) -> Result<Vec<String>, ActionError> {
        let rows: Vec<Document> = self
            .channels
            .find(doc! {
                "actionDueAt": { "$ne": Bson::Null, "$lte": js_number(now as f64) }
            })
            .projection(doc! { "_id": 1 })
            .sort(doc! { "actionDueAt": 1 })
            .limit(DUE_ACTION_BATCH)
            .await
            .map_err(|error| storage(error))?
            .try_collect()
            .await
            .map_err(|error| storage(error))?;
        rows.into_iter()
            .map(|row| {
                row.get("_id")
                    .and_then(Bson::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        ActionError::Storage(
                            "Roulette action row is missing a string _id".to_owned(),
                        )
                    })
            })
            .collect()
    }

    async fn load_actions(&self, channel_id: &str) -> Result<Option<ActionChannel>, ActionError> {
        let document = self
            .channels
            .find_one(doc! { "_id": channel_id })
            .await
            .map_err(|error| storage(error))?;
        document.map(decode_actions).transpose()
    }

    async fn claim_update(
        &self,
        channel_id: &str,
        revision: &Bson,
        actions: &[WinnerAction],
        action_due_at: Option<i64>,
    ) -> Result<bool, ActionError> {
        let actions = service::state_bson(actions).map_err(|error| storage(error))?;
        let saved = self
            .channels
            .update_one(
                doc! { "_id": channel_id, "revision": revision.clone() },
                doc! {
                    "$set": {
                        "actions": actions,
                        "actionDueAt": action_due_at
                            .map(|value| js_number(value as f64))
                            .unwrap_or(Bson::Null),
                    },
                    "$inc": { "revision": 1i32 },
                },
            )
            .await
            .map_err(|error| storage(error))?;
        Ok(saved.modified_count > 0)
    }

    async fn finish_running(
        &self,
        channel_id: &str,
        draw_id: &str,
        status: ActionStatus,
        finished_at: i64,
    ) -> Result<(), ActionError> {
        self.channels
            .update_one(
                doc! {
                    "_id": channel_id,
                    "actions": {
                        "$elemMatch": { "drawId": draw_id, "status": "running" }
                    },
                },
                doc! {
                    "$set": {
                        "actions.$.status": status.as_str(),
                        "actions.$.finishedAt": js_number(finished_at as f64),
                    },
                    "$inc": { "revision": 1i32 },
                },
            )
            .await
            .map_err(|error| storage(error))?;
        Ok(())
    }
}

fn decode_actions(document: Document) -> Result<ActionChannel, ActionError> {
    let revision = document
        .get("revision")
        .cloned()
        .ok_or_else(|| ActionError::Storage("Missing roulette revision".to_owned()))?;
    let actions = match document.get("actions") {
        None | Some(Bson::Null) => Vec::new(),
        Some(value) => service::from_state_bson(value).map_err(|error| storage(error))?,
    };
    Ok(ActionChannel { revision, actions })
}

/// First pending row with `dueAt <= now`, in array order.
///
/// The source uses `Array.find`, not the earliest `dueAt`.
pub fn due_action_index(actions: &[WinnerAction], now: i64) -> Option<usize> {
    actions
        .iter()
        .position(|action| action.status == ActionStatus::Pending && action.due_at <= now)
}

/// Claim one due action, or return `None` when there is nothing to claim or
/// all 20 compare-and-set attempts lose.
///
/// The returned job has `status: running` and `startedAt` set. A lost race
/// reloads the document. A storage error is not retried.
pub async fn claim_action<S: ActionStore>(
    store: &S,
    channel_id: &str,
    now: i64,
) -> Result<Option<WinnerAction>, ActionError> {
    for _ in 0..CLAIM_ATTEMPTS {
        let Some(mut channel) = store.load_actions(channel_id).await? else {
            return Ok(None);
        };
        let Some(index) = due_action_index(&channel.actions, now) else {
            return Ok(None);
        };
        channel.actions[index].status = ActionStatus::Running;
        channel.actions[index].started_at = Some(now);
        let claimed = channel.actions[index].clone();
        let revision = channel.revision.clone();
        let due = action_due(&channel.actions);
        if store
            .claim_update(channel_id, &revision, &channel.actions, due)
            .await?
        {
            return Ok(Some(claimed));
        }
    }
    Ok(None)
}

/// Process the current due batch.
///
/// `execute` errors become `failed` and are not returned. Snapshot, claim,
/// and finish errors are returned after the rest of the batch. An action that
/// was claimed is not executed again when finish fails: it stays `running`.
pub async fn run_due_actions<S, D, E, C>(
    store: &S,
    settlement: &D,
    executor: &mut E,
    clock: &C,
) -> Result<(), ActionError>
where
    S: ActionStore,
    D: DrawSettlement,
    E: WinnerExecutor,
    C: ActionClock,
{
    let mut first_error = None;
    let channel_ids = store.due_channel_ids(clock.now_ms()).await?;
    for channel_id in channel_ids {
        if let Err(error) = settlement.snapshot(&channel_id).await {
            remember(&mut first_error, error);
            continue;
        }
        let job = match claim_action(store, &channel_id, clock.now_ms()).await {
            Ok(job) => job,
            Err(error) => {
                remember(&mut first_error, error);
                continue;
            }
        };
        let Some(job) = job else {
            continue;
        };
        let status = match executor.execute(&channel_id, &job).await {
            Ok(()) => ActionStatus::Done,
            Err(_) => {
                eprintln!(
                    "Roulette winner action failed {{ channelId: {channel_id}, drawId: {} }}",
                    job.draw_id
                );
                ActionStatus::Failed
            }
        };
        if let Err(error) = store
            .finish_running(&channel_id, &job.draw_id, status, clock.now_ms())
            .await
        {
            remember(&mut first_error, error);
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn remember(slot: &mut Option<ActionError>, error: ActionError) {
    if slot.is_none() {
        *slot = Some(error);
    }
}

/// Owner fields `executeWinnerAction` reads. `name` fills both login and
/// display name when the saved actor has no user id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChannelOwner {
    pub name: String,
    pub plan_tier: String,
}

/// Streamer directory used to fill a missing actor. [`TwitchStreamers`] is
/// the production adapter.
pub trait ChannelOwnerDirectory {
    async fn owner(&self, channel_id: &str) -> Option<ChannelOwner>;
}

impl ChannelOwnerDirectory for TwitchStreamers {
    async fn owner(&self, channel_id: &str) -> Option<ChannelOwner> {
        directory_owner(self, channel_id).await
    }
}

/// `getTwitchAccountById`: a missing row is `null`. A thrown lookup is logged
/// and also becomes `null`, so delivery still runs with the channel fallback.
pub async fn directory_owner(
    directory: &TwitchStreamers,
    channel_id: &str,
) -> Option<ChannelOwner> {
    match directory.account_by_id(channel_id).await {
        Ok(account) => Some(ChannelOwner {
            name: account.metadata.name,
            plan_tier: account.metadata.plan_tier,
        }),
        Err(DirectoryError::Missing) => None,
        Err(error) => {
            eprintln!(
                "TwitchStreamers.getTwitchAccountById failed {{ id: {channel_id}, error: {} }}",
                directory_error_label(&error)
            );
            None
        }
    }
}

fn directory_error_label(error: &DirectoryError) -> &'static str {
    match error {
        DirectoryError::Missing => "missing",
        DirectoryError::Stale => "stale",
        DirectoryError::Busy => "busy",
        DirectoryError::InvalidInput => "invalid_input",
        DirectoryError::InvalidData => "invalid_data",
        DirectoryError::TooLarge => "too_large",
        DirectoryError::StoreUnavailable => "store_unavailable",
        DirectoryError::CacheUnavailable { .. } => "cache_unavailable",
        DirectoryError::DeadlineExceeded { .. } => "deadline_exceeded",
        DirectoryError::UnsupportedRefresh => "unsupported_refresh",
        DirectoryError::ReconciliationIncomplete { .. } => "reconciliation_incomplete",
        DirectoryError::Credentials(_) => "credentials",
    }
}

/// The actor passed to `parseSpecialCommands`.
///
/// An empty `userId` is falsy in JavaScript, so it uses the channel fallback.
/// The fallback does not keep an argument from the discarded actor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedActor {
    pub user_id: String,
    pub user_login: String,
    pub user_display_name: String,
    pub argument: String,
}

pub fn resolve_winner_actor(
    channel_id: &str,
    job: &WinnerAction,
    owner: Option<&ChannelOwner>,
) -> ResolvedActor {
    if let Some(actor) = job.actor.as_ref().filter(|actor| !actor.user_id.is_empty()) {
        return ResolvedActor {
            user_id: actor.user_id.clone(),
            user_login: actor.user_login.clone(),
            user_display_name: actor.user_display_name.clone(),
            argument: actor.argument.clone().unwrap_or_default(),
        };
    }
    let name = owner.map(|owner| owner.name.as_str()).unwrap_or("");
    ResolvedActor {
        user_id: channel_id.to_owned(),
        user_login: name.to_owned(),
        user_display_name: name.to_owned(),
        argument: String::new(),
    }
}

/// Parser context from `executeWinnerAction`. `userLevel` is 10 and arguments
/// stay literal. The plan comes from the owner even when the actor is saved.
pub fn winner_parser_context(
    channel_id: &str,
    job: &WinnerAction,
    owner: Option<&ChannelOwner>,
) -> SpecialParserContext {
    let actor = resolve_winner_actor(channel_id, job, owner);
    let plan = owner
        .map(|owner| owner.plan_tier.as_str())
        .unwrap_or("free");
    SpecialParserContext {
        channel_id: channel_id.to_owned(),
        scope_type: Some("roulette".to_owned()),
        scope_name: Some(job.roulette_id.clone()),
        user_plan: Some(plan.to_owned()),
        user_level: Some(10.0),
        literal_arguments: true,
        argument: Some(actor.argument),
        event_data: Some(JsValue::object(vec![
            ("chatter_user_id".into(), JsValue::string(actor.user_id)),
            ("chatter_user_login".into(), JsValue::string(actor.user_login)),
            (
                "chatter_user_name".into(),
                JsValue::string(actor.user_display_name),
            ),
        ])),
        variables: vec![
            ("roulette_id".to_owned(), job.roulette_id.clone()),
            ("roulette_draw_id".to_owned(), job.draw_id.clone()),
            ("roulette_item_id".to_owned(), job.item_id.clone()),
            ("roulette_item".to_owned(), job.label.clone()),
        ],
        ..Default::default()
    }
}

/// Render `job.source` and deliver it with the shared AST delivery loop.
///
/// `parser`, `sender`, and `runner` are the runtime seams. Production passes
/// them by using [`WinnerExecutor`] for [`BotRuntime`], which parses with the
/// real special-command parser and delivers with [`BotRuntime::deliver`].
pub async fn execute_winner_action<D, P, S, R>(
    directory: &D,
    parser: &mut P,
    sender: &mut S,
    runner: &mut R,
    channel_id: &str,
    job: &WinnerAction,
) -> Result<(), ActionError>
where
    D: ChannelOwnerDirectory + ?Sized,
    P: AstBodyParser,
    S: crate::utils::ast_runtime::ChatSender + ?Sized,
    R: crate::utils::ast_runtime::CommandRunner + ?Sized,
{
    let owner = directory.owner(channel_id).await;
    let context = winner_parser_context(channel_id, job, owner.as_ref());
    let rendered = parser.parse(&job.source, context).await.map_err(evaluation)?;
    let mut message = AstMessage {
        parsed_text: rendered.parsed_text,
        command_references: rendered.command_references,
    };
    let delivered = deliver_ast_message(
        channel_id,
        &mut message,
        true,
        DeliverySeams {
            sender,
            runner,
            logger: None,
        },
    )
    .await
    .map_err(evaluation)?;
    if delivered.error {
        return Err(ActionError::Delivery);
    }
    Ok(())
}

impl<S: CommandStore> WinnerExecutor for BotRuntime<S> {
    async fn execute(&mut self, channel_id: &str, job: &WinnerAction) -> Result<(), ActionError> {
        let directory = Arc::clone(self.directory());
        let owner = directory_owner(directory.as_ref(), channel_id).await;
        let context = winner_parser_context(channel_id, job, owner.as_ref());
        let rendered = AstBodyParser::parse(self, job.source.as_str(), context)
            .await
            .map_err(evaluation)?;
        let mut message = AstMessage {
            parsed_text: rendered.parsed_text,
            command_references: rendered.command_references,
        };
        let delivered = self
            .deliver(channel_id, &mut message, true)
            .await
            .map_err(evaluation)?;
        if delivered.error {
            return Err(ActionError::Delivery);
        }
        Ok(())
    }
}

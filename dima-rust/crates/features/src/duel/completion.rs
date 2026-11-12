//! `duel/completion.ts`: one tick of the duel loop (the cron's `duel` worker runs it every
//! 500 ms, P4-CRON-FEATURES): expired challenges, chat narration, the winner announcement, the
//! loser's timeout, the result, the completion; then due moderator restores.
//!
//! # The loser's timeout: at most once, never a moderator left demoted
//!
//! The timeout of one duel is claimed before anything is sent (`run.timeoutAttempted: false`
//! to `true`, compare-and-set): a crash or a lost answer after the claim never sends it again.
//! A failure is stored in `run.timeoutError`; a failure whose outcome is unknown (no answer in
//! time: Twitch may have applied it) says so (`Timeout outcome unknown: …`).
//!
//! A losing moderator cannot be timed out, so the reference demotes them first and restores
//! them afterwards. The life of a restore (`duel_moderator_restores`, `_id` = the run id):
//!
//! 1. Recorded **before** the demotion, due `timeout + 30 s` later. Nothing is demoted unless
//!    this write succeeded.
//! 2. Demotion fails or its outcome is unknown, the switch was turned off meanwhile, or the
//!    timeout fails: the restore is made due now.
//! 3. Timeout sent: due `timeout + 10 s` from now.
//! 4. Every tick, [`DuelCompletion::restore_due`] claims due rows (30 s lease), checks whether
//!    the user is a moderator (then the row is deleted) or adds them back and deletes the row.
//!    A failure makes it due again in 30 s and frees the lease. No retry limit, as the
//!    reference: a restore is retried until Twitch takes it.
//!
//! A kill at any step leaves: before the restore row, no demotion; after it, a row that the
//! loop will apply once due (at the latest `timeout + 30 s`), lease or not; after the re-add
//! but before the delete, a row the next attempt deletes once it sees the moderator.
//!
//! # Differences from the reference, on purpose
//!
//! - A narration phrase is claimed by compare-and-set on its index and posted only by the
//!   writer that moved it (the reference posts after an unconditional write, so two loops
//!   holding the lease at once could post it twice).
//! - Every Twitch call has [`super::service::DuelConfig::twitch_deadline`]; an unknown outcome is
//!   reported as unknown.
//! - Stored error texts are cut at 300 characters (the reference: 300 UTF-16 units).
//! - Failures are returned in the tick's [`TickReport`] for the caller to log (the reference
//!   logs them itself).

use std::sync::Arc;

use bson::{Bson, Document, doc};
use dima_http::guard::BoxFuture;
use dima_model::duel_moderator_restores::{self as restores, NewDuelModeratorRestore};
use dima_model::duel_widgets as stored;
use dima_model::{Private, UpdateOptions};
use dima_store::mongo::WriteContext;
use dima_store::mongo::number::{JsNumber, js_number, read_number};
use dima_store::mongo::update::Returned;
use dima_twitch::chat::{ChatOut, RenderScope};
use futures_util::TryStreamExt;

use super::model::DuelRun;
use super::service::{DuelDocument, DuelPhase, DuelService};
use crate::roulette::service::ServiceError;

/// Lease of a channel or a restore while one tick handles it.
pub const LEASE_MS: f64 = 30_000.0;
/// Channels and restores per tick.
pub const PER_TICK: i64 = 10;

/// A Twitch action that failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionFailure {
    /// The reference's message.
    pub message: String,
    /// No answer in time: Twitch may have applied it.
    pub outcome_unknown: bool,
}

/// The Twitch calls of a duel's completion, implemented over `dima_twitch` by
/// [`TwitchDuelModeration`]; tests script it.
pub trait DuelModeration: Send + Sync {
    /// `isEditorLoginCached`: editors are never timed out.
    fn is_editor<'a>(
        &'a self,
        channel: &'a str,
        login: &'a str,
    ) -> BoxFuture<'a, Result<bool, String>>;
    /// `getTwitchUserByLogin`: the user's id.
    fn user_id<'a>(&'a self, login: &'a str) -> BoxFuture<'a, Result<String, String>>;
    /// `getChannelModerators(channel, [user])`: whether the user moderates the channel.
    fn is_moderator<'a>(
        &'a self,
        channel: &'a str,
        user: &'a str,
    ) -> BoxFuture<'a, Result<bool, String>>;
    /// `removeChannelModerator`.
    fn remove_moderator<'a>(
        &'a self,
        channel: &'a str,
        user: &'a str,
    ) -> BoxFuture<'a, Result<(), ActionFailure>>;
    /// `ban(channel, user, bot, seconds, 'Duel')`: the timeout.
    fn timeout<'a>(
        &'a self,
        channel: &'a str,
        user: &'a str,
        seconds: f64,
    ) -> BoxFuture<'a, Result<(), ActionFailure>>;
    /// `addModerator`.
    fn add_moderator<'a>(
        &'a self,
        channel: &'a str,
        user: &'a str,
    ) -> BoxFuture<'a, Result<(), String>>;
}

/// What one tick did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TickReport {
    /// Channels handled.
    pub channels: usize,
    /// Restores attempted.
    pub restores: usize,
    /// Failures to log (`duel-completion`, `duel-record-result`, `duel-restore-moderator`).
    pub errors: Vec<String>,
}

/// The duel loop's body.
#[derive(Clone)]
pub struct DuelCompletion {
    service: DuelService,
    chat: Arc<dyn ChatOut>,
    moderation: Arc<dyn DuelModeration>,
}

fn cut(text: &str) -> String {
    dima_text::truncate_chars(text, 300).to_owned()
}

impl DuelCompletion {
    /// Over `service`, posting with `chat` (plain sends) and acting with `moderation`.
    pub fn new(
        service: DuelService,
        chat: Arc<dyn ChatOut>,
        moderation: Arc<dyn DuelModeration>,
    ) -> Self {
        Self {
            service,
            chat,
            moderation,
        }
    }

    fn now(&self) -> f64 {
        self.service.clock.now_ms() as f64
    }

    async fn twitch<T, E>(&self, future: BoxFuture<'_, Result<T, E>>) -> Result<T, ActionFailure>
    where
        E: Into<ActionFailure>,
    {
        match tokio::time::timeout(self.service.config.twitch_deadline, future).await {
            Ok(result) => result.map_err(Into::into),
            Err(_) => Err(ActionFailure {
                message: "Twitch did not answer in time".into(),
                outcome_unknown: true,
            }),
        }
    }

    /// `report(channel, run, field, error)`.
    async fn report(
        &self,
        channel: &str,
        run: &DuelRun,
        field: &str,
        message: &str,
        errors: &mut Vec<String>,
    ) {
        let path = format!("run.{field}");
        let result = self
            .service
            .update(
                "duel_widgets.updateOne",
                doc! { "_id": channel, "run.id": &run.id },
                doc! { "$set": { path: cut(message) }, "$inc": { "revision": 1 } },
            )
            .await;
        errors.push(format!(
            "duel-completion {channel} {} {field}: {message}",
            run.id
        ));
        if let Err(error) = result {
            errors.push(format!(
                "duel-completion {channel}: reporting failed: {error}"
            ));
        }
    }

    async fn restore_write(&self, filter: Document, update: Document) -> Result<(), ServiceError> {
        let mut ctx = WriteContext::new(self.service.clock.now_ms());
        let prepared =
            restores::INFO.prepare_update(&filter, update, UpdateOptions::default(), &mut ctx)?;
        let mut writes = self.service.mongo.writes(restores::COLLECTION);
        self.service
            .within(
                "duel_moderator_restores.updateOne",
                writes.update_one(&prepared),
            )
            .await?;
        Ok(())
    }

    async fn expedite(&self, run: &DuelRun) -> Result<(), ServiceError> {
        self.restore_write(
            doc! { "_id": &run.id },
            doc! { "$set": { "dueAt": js_number(self.now()) } },
        )
        .await
    }

    /// `timeoutLoser(channel, run)`. `Err` carries the message stored in `run.timeoutError`.
    async fn timeout_loser(&self, channel: &str, run: &DuelRun) -> Result<(), String> {
        let store = |e: ServiceError| e.to_string();
        let settings = self.service.load(channel).await.map_err(store)?.settings;
        if !settings.timeout_enabled || !run.timeout_enabled {
            return Ok(());
        }
        if run.enraged.as_ref().is_some_and(|e| *e != run.winner) {
            return Ok(());
        }
        let login = run.loser_login().to_owned();
        let editor = self
            .twitch(self.moderation.is_editor(channel, &login))
            .await
            .map_err(|f| f.message)?;
        if editor {
            return Ok(());
        }
        let user = self
            .twitch(self.moderation.user_id(&login))
            .await
            .map_err(|f| f.message)?;
        if user == channel || user == self.service.config.bot_id {
            return Ok(());
        }
        let moderator = self
            .twitch(self.moderation.is_moderator(channel, &user))
            .await
            .map_err(|f| f.message)?;
        if moderator {
            // The restore is recorded before the role is removed.
            let insert = NewDuelModeratorRestore {
                id: run.id.clone(),
                channel: channel.to_owned(),
                user_id: Private::from(user.clone()),
                due_at: JsNumber(self.now() + run.timeout_seconds * 1000.0 + 30_000.0),
                lease_until: None,
            }
            .prepare(&mut WriteContext::new(self.service.clock.now_ms()))
            .map_err(|e| e.to_string())?;
            let mut writes = self.service.mongo.writes(restores::COLLECTION);
            self.service
                .within("duel_moderator_restores.create", writes.insert_one(&insert))
                .await
                .map_err(store)?;
            if let Err(failure) = self
                .twitch(self.moderation.remove_moderator(channel, &user))
                .await
            {
                self.expedite(run).await.map_err(store)?;
                return Err(unknown_text(&failure));
            }
        }
        // The switch may have been turned off during the lookups and the demotion.
        if !self
            .service
            .load(channel)
            .await
            .map_err(store)?
            .settings
            .timeout_enabled
        {
            if moderator {
                self.expedite(run).await.map_err(store)?;
            }
            return Ok(());
        }
        if let Err(failure) = self
            .twitch(self.moderation.timeout(channel, &user, run.timeout_seconds))
            .await
        {
            if moderator {
                self.expedite(run).await.map_err(store)?;
            }
            return Err(unknown_text(&failure));
        }
        if moderator {
            let due = self.now() + run.timeout_seconds * 1000.0 + 10_000.0;
            self.restore_write(
                doc! { "_id": &run.id },
                doc! { "$set": { "dueAt": js_number(due) } },
            )
            .await
            .map_err(store)?;
        }
        Ok(())
    }

    async fn claim(&self, channel: &str, run: &DuelRun, flag: &str) -> Result<bool, ServiceError> {
        let path = format!("run.{flag}");
        let (_, modified) = self
            .service
            .update(
                "duel_widgets.updateOne",
                doc! { "_id": channel, "run.id": &run.id, path.clone(): false },
                doc! { "$set": { path: true }, "$inc": { "revision": 1 } },
            )
            .await?;
        Ok(modified > 0)
    }

    async fn post(&self, channel: &str, run: &DuelRun, text: &str, errors: &mut Vec<String>) {
        if let Err(error) = self.chat.send(&RenderScope::plain(channel), text).await {
            let message = error.message().unwrap_or("undefined").to_owned();
            self.report(channel, run, "announcementError", &message, errors)
                .await;
        }
    }

    /// One channel holding the lease.
    async fn settle_channel(
        &self,
        doc: DuelDocument,
        now: f64,
        errors: &mut Vec<String>,
    ) -> Result<(), ServiceError> {
        let id = doc.id.clone();
        if let Some(challenge) = doc.challenge.as_ref().filter(|c| c.expires_at <= now) {
            self.service
                .update("duel_widgets.updateOne", doc! { "_id": &id, "challenge.id": &challenge.id }, doc! { "$set": { "challenge": Bson::Null, "dueAt": Bson::Null }, "$inc": { "revision": 1 } })
                .await?;
            return Ok(());
        }
        let Some(mut run) = doc.run.filter(|r| r.completed_at.is_none()) else {
            self.service
                .update(
                    "duel_widgets.updateOne",
                    doc! { "_id": &id },
                    doc! { "$set": { "dueAt": Bson::Null } },
                )
                .await?;
            return Ok(());
        };
        if now < run.ends_at {
            let index = run.phrase_index;
            if let Some(phrase) = run
                .phrases
                .get(index as usize)
                .cloned()
                .filter(|p| p.at <= now)
            {
                run.phrase_index += 1.0;
                let (_, modified) = self
                    .service
                    .update(
                        "duel_widgets.updateOne",
                        doc! { "_id": &id, "run.id": &run.id, "run.phraseIndex": js_number(index) },
                        doc! { "$set": { "run.phraseIndex": js_number(run.phrase_index), "dueAt": js_number(run.next_deadline()) }, "$inc": { "revision": 1 } },
                    )
                    .await?;
                if modified > 0 {
                    self.post(&id, &run, &phrase.text, errors).await;
                }
            }
            return Ok(());
        }
        if !run.announcement_attempted && self.claim(&id, &run, "announcementAttempted").await? {
            let message = run.winner_message();
            self.post(&id, &run, &message, errors).await;
        }
        if !run.timeout_attempted
            && self.claim(&id, &run, "timeoutAttempted").await?
            && let Err(message) = self.timeout_loser(&id, &run).await
        {
            self.report(&id, &run, "timeoutError", &message, errors)
                .await;
        }
        let tracked = run.is_tracked();
        if tracked
            && let Err(error) = self
                .service
                .stats
                .record(&id, &run, self.service.clock.now_ms())
                .await
        {
            errors.push(format!("duel-record-result {id} {}: {error}", run.id));
            return Ok(());
        }
        let (_, modified) = self
            .service
            .update(
                "duel_widgets.updateOne",
                doc! { "_id": &id, "run.id": &run.id, "run.completedAt": Bson::Null },
                doc! { "$set": { "run.completedAt": js_number(self.now()), "dueAt": Bson::Null }, "$inc": { "revision": 1, "statsRevision": i32::from(tracked) } },
            )
            .await?;
        if modified > 0 {
            self.service.events.duel(&id, &run, DuelPhase::Ended);
        }
        Ok(())
    }

    /// `settleDuels()`: one tick.
    pub async fn tick(&self) -> Result<TickReport, ServiceError> {
        let mut report = TickReport::default();
        let now = self.now();
        let due = doc! { "dueAt": { "$ne": Bson::Null, "$lte": js_number(now) }, "leaseUntil": { "$lte": js_number(now) } };
        let rows: Vec<Document> = self
            .service
            .within("duel_widgets.find", async {
                self.service
                    .mongo
                    .documents(stored::COLLECTION)
                    .find(due.clone())
                    .projection(doc! { "_id": 1 })
                    .sort(doc! { "dueAt": 1 })
                    .limit(PER_TICK)
                    .await?
                    .try_collect()
                    .await
            })
            .await?;
        for row in rows {
            let Ok(id) = row.get_str("_id").map(str::to_owned) else {
                continue;
            };
            let mut filter = due.clone();
            filter.insert("_id", &id);
            let mut ctx = WriteContext::new(self.service.clock.now_ms());
            let prepared = stored::INFO.prepare_find_one_and_update(
                &filter,
                doc! { "$set": { "leaseUntil": js_number(now + LEASE_MS) } },
                UpdateOptions::default(),
                Returned::After,
                &mut ctx,
            )?;
            let mut writes = self.service.mongo.writes(stored::COLLECTION);
            let Some(leased) = self
                .service
                .within(
                    "duel_widgets.findOneAndUpdate",
                    writes.find_one_and_update(&prepared),
                )
                .await?
            else {
                continue;
            };
            report.channels += 1;
            let outcome = match DuelDocument::from_document(&leased) {
                Ok(doc) => self.settle_channel(doc, now, &mut report.errors).await,
                Err(error) => Err(error),
            };
            let released = self
                .service
                .update(
                    "duel_widgets.updateOne",
                    doc! { "_id": &id },
                    doc! { "$set": { "leaseUntil": 0 } },
                )
                .await;
            if let Err(error) = outcome {
                report.errors.push(format!("duel-completion {id}: {error}"));
            }
            released?;
        }
        self.restore_due(&mut report).await?;
        Ok(report)
    }

    /// The restore half of the tick: due moderator restores, retried until Twitch takes them.
    pub async fn restore_due(&self, report: &mut TickReport) -> Result<(), ServiceError> {
        let now = self.now();
        let rows: Vec<Document> = self
            .service
            .within("duel_moderator_restores.find", async {
                self.service
                    .mongo
                    .documents(restores::COLLECTION)
                    .find(doc! { "dueAt": { "$lte": js_number(now) }, "leaseUntil": { "$lte": js_number(now) } })
                    .limit(PER_TICK)
                    .await?
                    .try_collect()
                    .await
            })
            .await?;
        for row in rows {
            let (Ok(id), Ok(channel), Ok(user)) = (
                row.get_str("_id"),
                row.get_str("channel"),
                row.get_str("userId"),
            ) else {
                continue;
            };
            let now = self.now();
            let mut ctx = WriteContext::new(self.service.clock.now_ms());
            let claim = restores::INFO.prepare_update(
                &doc! { "_id": id, "leaseUntil": { "$lte": js_number(now) } },
                doc! { "$set": { "leaseUntil": js_number(now + LEASE_MS) } },
                UpdateOptions::default(),
                &mut ctx,
            )?;
            let mut writes = self.service.mongo.writes(restores::COLLECTION);
            if self
                .service
                .within(
                    "duel_moderator_restores.updateOne",
                    writes.update_one(&claim),
                )
                .await?
                .modified
                == 0
            {
                continue;
            }
            report.restores += 1;
            let attempt: Result<(), String> = async {
                if !self
                    .twitch(self.moderation.is_moderator(channel, user))
                    .await
                    .map_err(|f| f.message)?
                {
                    self.twitch(self.moderation.add_moderator(channel, user))
                        .await
                        .map_err(|f| f.message)?;
                }
                self.service
                    .within(
                        "duel_moderator_restores.deleteOne",
                        self.service
                            .mongo
                            .documents(restores::COLLECTION)
                            .delete_one(doc! { "_id": id }),
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(())
            }
            .await;
            if let Err(error) = attempt {
                report
                    .errors
                    .push(format!("duel-restore-moderator {channel}: {error}"));
                self.restore_write(
                    doc! { "_id": id },
                    doc! { "$set": { "dueAt": js_number(self.now() + 30_000.0), "leaseUntil": 0 } },
                )
                .await?;
            }
        }
        Ok(())
    }
}

fn unknown_text(failure: &ActionFailure) -> String {
    if failure.outcome_unknown {
        format!("Timeout outcome unknown: {}", failure.message)
    } else {
        failure.message.clone()
    }
}

impl From<String> for ActionFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            outcome_unknown: false,
        }
    }
}

/// `isEditorLoginCached(cache, channel, login)`, supplied by the wiring.
pub type EditorCheck =
    dyn Fn(String, String) -> BoxFuture<'static, Result<bool, String>> + Send + Sync;

/// [`DuelModeration`] over the Twitch wrappers of `dima_twitch` (bot token for the timeout,
/// the streamer's for the moderator list and changes), with the role cache's editor check
/// supplied by the caller (`dima_commands::permissions::is_editor_login_cached`).
pub struct TwitchDuelModeration {
    /// The Twitch base.
    pub twitch: dima_twitch::Twitch,
    /// The editor check.
    pub editors: Arc<EditorCheck>,
}

struct ByIdLookup;

impl dima_twitch::functions::channels::ModeratorUserLookup for ByIdLookup {
    fn lookup<'a>(
        &'a self,
        twitch: &'a dima_twitch::Twitch,
        user: &'a str,
    ) -> futures_util::future::BoxFuture<
        'a,
        Option<dima_twitch::functions::moderation::moderators::Moderator>,
    > {
        Box::pin(async move {
            let found = dima_twitch::functions::users::get_twitch_user_by_id(twitch, user).await;
            found.data.map(
                |u| dima_twitch::functions::moderation::moderators::Moderator {
                    user_id: u.id,
                    user_login: u.login,
                    user_name: u.display_name,
                },
            )
        })
    }
}

impl DuelModeration for TwitchDuelModeration {
    fn is_editor<'a>(
        &'a self,
        channel: &'a str,
        login: &'a str,
    ) -> BoxFuture<'a, Result<bool, String>> {
        (self.editors)(channel.to_owned(), login.to_owned())
    }

    fn user_id<'a>(&'a self, login: &'a str) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let found =
                dima_twitch::functions::users::get_twitch_user_by_login(&self.twitch, login, false)
                    .await;
            match found.data {
                Some(user) if !found.error => Ok(user.id),
                _ => Err(found.message.unwrap_or_default()),
            }
        })
    }

    fn is_moderator<'a>(
        &'a self,
        channel: &'a str,
        user: &'a str,
    ) -> BoxFuture<'a, Result<bool, String>> {
        Box::pin(async move {
            let found = dima_twitch::functions::moderation::get_channel_moderators(
                &self.twitch,
                channel,
                &[user.to_owned()],
                false,
            )
            .await
            .map_err(|e| e.message)?;
            Ok(found.data.iter().any(|m| m.user_id == user))
        })
    }

    fn remove_moderator<'a>(
        &'a self,
        channel: &'a str,
        user: &'a str,
    ) -> BoxFuture<'a, Result<(), ActionFailure>> {
        Box::pin(async move {
            let cancel = tokio_util::sync::CancellationToken::new();
            dima_twitch::functions::channels::remove_channel_moderator(
                &self.twitch,
                channel,
                user,
                &cancel,
            )
            .await
            .map(|_| ())
            .map_err(|e| ActionFailure {
                message: e.message,
                outcome_unknown: false,
            })
        })
    }

    fn timeout<'a>(
        &'a self,
        channel: &'a str,
        user: &'a str,
        seconds: f64,
    ) -> BoxFuture<'a, Result<(), ActionFailure>> {
        Box::pin(async move {
            let cancel = tokio_util::sync::CancellationToken::new();
            dima_twitch::functions::moderation::ban(
                &self.twitch,
                channel,
                user,
                dima_twitch::TWITCH_BOT_ACCOUNT_ID,
                Some(seconds),
                Some("Duel"),
                &cancel,
            )
            .await
            .map(|_| ())
            .map_err(|e| ActionFailure {
                message: e.failure.message,
                outcome_unknown: false,
            })
        })
    }

    fn add_moderator<'a>(
        &'a self,
        channel: &'a str,
        user: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            dima_twitch::functions::channels::add_moderator(
                &self.twitch,
                channel,
                Some(user),
                &ByIdLookup,
            )
            .await
            .map(|_| ())
            .map_err(|e| e.message)
        })
    }
}

/// The run of a stored document (tests).
pub fn stored_run(document: &Document) -> Option<DuelRun> {
    let run = document.get("run").filter(|r| !matches!(r, Bson::Null))?;
    bson::deserialize_from_bson(run.clone()).ok()
}

/// `leaseUntil` of a stored document (tests).
pub fn lease_of(document: &Document) -> f64 {
    document
        .get("leaseUntil")
        .and_then(read_number)
        .unwrap_or(0.0)
}

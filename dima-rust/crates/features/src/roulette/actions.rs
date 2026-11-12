//! `roulette/actions.ts`: winner actions, run once each after their spin ends.
//!
//! [`RouletteService::run_due_actions`] is one tick of the cron's loop (`roulette-actions`,
//! every 1 s, P4-CRON-FEATURES): at most 4 channels whose `actionDueAt` passed, oldest first,
//! handled concurrently. For each: complete the draw first ([`RouletteService::snapshot`], so a
//! winner removal is stored before any effect), claim one due action (`pending` to `running`,
//! by revision, *before* anything runs), run it, then mark it `done` or `failed`.
//!
//! At most once, as the reference: a claimed action is never run again. A process killed after
//! the claim leaves it `running` for good (it counts toward the 100 open actions); a delivery
//! whose outcome is unknown (its deadline expired) is `failed`. Nothing replays a viewer's
//! effect twice.

use std::sync::Arc;

use bson::{Bson, doc};
use dima_model::users::PlanTier;
use dima_store::mongo::number::js_number;
use dima_twitch::chat::{ChatOut, Rendering};
use futures_util::TryStreamExt;
use serde_json::{Map, Value};

use super::service::{
    CAS_ATTEMPTS, DrawActor, RouletteService, ServiceError, WinnerAction, action_due,
};

/// Channels handled per tick.
pub const DUE_CHANNELS: i64 = 4;

/// The channel owner, as `TwitchStreamers.getTwitchAccountById` gives it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChannelOwner {
    /// `name` (the login).
    pub name: String,
    /// `plan_tier`.
    pub plan: PlanTier,
}

/// The streamer directory, implemented over `dima_twitch` by the wiring package
/// (P4-CRON-FEATURES).
pub trait ChannelOwners: Send + Sync {
    /// The owner of `channel`, or `None` when the directory does not know it.
    fn owner<'a>(
        &'a self,
        channel: &'a str,
    ) -> dima_http::guard::BoxFuture<'a, Option<ChannelOwner>>;
}

/// Runs one claimed winner action.
pub trait WinnerActionRunner: Send + Sync {
    /// Runs `job` for `channel`; an error marks it `failed`.
    fn run<'a>(
        &'a self,
        channel: &'a str,
        job: &'a WinnerAction,
    ) -> dima_http::guard::BoxFuture<'a, Result<(), String>>;
}

/// `executeWinnerAction`: the action's text rendered as the roulette's command language and
/// delivered ([`ChatOut::deliver`]), with the drawer (or the owner) as the user.
pub struct ChatWinnerActions {
    /// Delivery (`dima_actions::delivery::ChatDelivery`).
    pub chat: Arc<dyn ChatOut>,
    /// The streamer directory.
    pub owners: Arc<dyn ChannelOwners>,
}

impl ChatWinnerActions {
    /// The rendering context `executeWinnerAction` builds.
    pub fn rendering(channel: &str, job: &WinnerAction, owner: Option<&ChannelOwner>) -> Rendering {
        let drawer = job
            .actor
            .as_ref()
            .and_then(DrawActor::from_bson)
            .filter(|a| !a.user_id.is_empty());
        let actor = drawer.unwrap_or_else(|| {
            let name = owner.map(|o| o.name.clone()).unwrap_or_default();
            DrawActor {
                user_id: channel.to_owned(),
                user_login: name.clone(),
                user_display_name: name,
                argument: None,
            }
        });
        let mut event = Map::new();
        event.insert("chatter_user_id".into(), Value::from(actor.user_id.clone()));
        event.insert(
            "chatter_user_login".into(),
            Value::from(actor.user_login.clone()),
        );
        event.insert(
            "chatter_user_name".into(),
            Value::from(actor.user_display_name.clone()),
        );
        Rendering {
            event_data: event,
            argument: Some(actor.argument.clone().unwrap_or_default()),
            literal_arguments: true,
            variables: vec![
                ("roulette_id".into(), job.roulette_id.clone()),
                ("roulette_draw_id".into(), job.draw_id.clone()),
                ("roulette_item_id".into(), job.item_id.clone()),
                ("roulette_item".into(), job.label.clone()),
            ],
            user_plan: Some(owner.map_or(PlanTier::Free, |o| o.plan)),
            user_level: Some(10.0),
            scope_type: Some("roulette".into()),
            scope_name: Some(job.roulette_id.clone()),
            ..Rendering::default()
        }
    }
}

impl WinnerActionRunner for ChatWinnerActions {
    fn run<'a>(
        &'a self,
        channel: &'a str,
        job: &'a WinnerAction,
    ) -> dima_http::guard::BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let owner = self.owners.owner(channel).await;
            let rendering = Self::rendering(channel, job, owner.as_ref());
            self.chat
                .deliver(channel, Some(&rendering), &job.source)
                .await
                .map_err(|_| "Winner action delivery failed".to_owned())
        })
    }
}

impl RouletteService {
    /// `claimAction(channelId, now)`: marks the first due pending action `running`, by
    /// revision, before anything runs. `None`: nothing due (or the document is gone).
    pub async fn claim_action(
        &self,
        channel: &str,
        now: f64,
    ) -> Result<Option<WinnerAction>, ServiceError> {
        for _ in 0..CAS_ATTEMPTS {
            let Some(doc) = self.read(channel).await? else {
                return Ok(None);
            };
            let mut actions = doc.actions;
            let Some(job) = actions
                .iter_mut()
                .find(|a| a.status == "pending" && a.due_at <= now)
            else {
                return Ok(None);
            };
            job.status = "running".into();
            job.started_at = Some(now);
            let claimed = job.clone();
            let stored: Vec<Bson> = actions.iter().map(WinnerAction::to_bson).collect();
            let won = self
                .update(
                    "roulette_channels.updateOne",
                    doc! { "_id": channel, "revision": js_number(doc.revision) },
                    doc! {
                        "$set": { "actions": stored, "actionDueAt": action_due(&actions).map_or(Bson::Null, js_number) },
                        "$inc": { "revision": 1 },
                    },
                )
                .await?;
            if won {
                return Ok(Some(claimed));
            }
        }
        Ok(None)
    }

    /// The finishing write: the running action of `draw_id` becomes `status`.
    pub async fn finish_action(
        &self,
        channel: &str,
        draw_id: &str,
        status: &str,
    ) -> Result<bool, ServiceError> {
        self.update(
            "roulette_channels.updateOne",
            doc! { "_id": channel, "actions": { "$elemMatch": { "drawId": draw_id, "status": "running" } } },
            doc! {
                "$set": { "actions.$.status": status, "actions.$.finishedAt": js_number(self.clock.now_ms() as f64) },
                "$inc": { "revision": 1 },
            },
        )
        .await
    }

    /// One channel: complete, claim, run, finish.
    async fn run_channel(
        &self,
        channel: &str,
        runner: &dyn WinnerActionRunner,
    ) -> Result<(), ServiceError> {
        self.snapshot(channel).await?;
        let Some(job) = self
            .claim_action(channel, self.clock.now_ms() as f64)
            .await?
        else {
            return Ok(());
        };
        let status = match tokio::time::timeout(
            self.config.action_deadline,
            runner.run(channel, &job),
        )
        .await
        {
            Ok(Ok(())) => "done",
            Ok(Err(_)) | Err(_) => "failed",
        };
        self.finish_action(channel, &job.draw_id, status).await?;
        Ok(())
    }

    /// `runDueActions`: one tick (see the module documentation). The first failure is
    /// returned after every channel of the tick finished.
    pub async fn run_due_actions(
        &self,
        runner: &dyn WinnerActionRunner,
    ) -> Result<usize, ServiceError> {
        let now = self.clock.now_ms() as f64;
        let rows: Vec<bson::Document> = self
            .within("roulette_channels.find", async {
                self.mongo
                    .documents(dima_model::roulette_channels::COLLECTION)
                    .find(doc! { "actionDueAt": { "$ne": Bson::Null, "$lte": js_number(now) } })
                    .projection(doc! { "_id": 1 })
                    .sort(doc! { "actionDueAt": 1 })
                    .limit(DUE_CHANNELS)
                    .await?
                    .try_collect()
                    .await
            })
            .await?;
        let channels: Vec<String> = rows
            .iter()
            .filter_map(|r| r.get_str("_id").ok().map(str::to_owned))
            .collect();
        let results =
            futures_util::future::join_all(channels.iter().map(|c| self.run_channel(c, runner)))
                .await;
        for result in results {
            result?;
        }
        Ok(channels.len())
    }
}

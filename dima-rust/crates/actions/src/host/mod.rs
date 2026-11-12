//! The engine's host: [`DimaHost`] implements [`dima_engine::host::Host`], the one door through
//! which an evaluation reaches chat, Twitch, the stores, timers, time and randomness.
//!
//! # The dispatch (P4-SKEL)
//!
//! [`Host::call`] forwards every [`HostFunction`] to one of four group modules, chosen by
//! [`Group::of`], a `match` over every variant with no wildcard, so a function added to the
//! engine fails to compile here until it is placed. The groups and their packages are the plan's
//! (`ledger/upper-layers.md` section 2.2):
//!
//! | Group | Functions | Module | Package |
//! |---|---:|---|---|
//! | [`Group::Moderation`] | 18 | [`moderation`] | P4-ACT-MOD |
//! | [`Group::Channel`] | 37 | [`channel`] | P4-ACT-CHANNEL |
//! | [`Group::Media`] | 43 | [`media`] | P4-ACT-MEDIA |
//! | [`Group::Ai`] | 1 | [`ai`] | P4-ACT-AI-A |
//!
//! Each group module exposes one entry function, `call(&mut DimaHost, HostCall) ->
//! Result<Value, HostError>`, and its own dependencies struct (`Deps`), a field of
//! [`HostDeps`]; a group package fills its module and its `Deps` and touches nothing else. Until
//! it does, its entry function answers [`ActionError::NotYetPorted`] for each of its functions.
//!
//! # What a group function gets
//!
//! The [`HostCall`]: the function, its evaluated arguments, the run's [`Context`](dima_engine::context::Context) (channel,
//! user id, login and name, plan, level, event data, scope, authorization), the run's effect
//! authority at that point (read it with [`effects`]) and the run's `randomuser` memory. And
//! the [`DimaHost`] it was called on:
//!
//! - [`DimaHost::deps`]: the process's handles ([`HostDeps`]: MongoDB, Dragonfly with its key
//!   prefix, Twitch with the streamer directory, the command cache, the wall clock, randomness,
//!   telemetry, and the group's own `Deps`);
//! - [`DimaHost::channel_id`] and [`DimaHost::event_user`]: the channel the run belongs to and
//!   the user its event names (what the reference's storage closures use);
//! - [`DimaHost::now_ms`]: `Date.now()` on the injected wall clock;
//! - [`DimaHost::chat`]: the process's [`ChatOut`] (rendering then posting, and the plain
//!   post), and [`DimaHost::runner`]: the [`CommandRunner`] (for the AI chat's tools). Both are
//!   `None` only for a host made without a delivery (tests of a group);
//! - [`DimaHost::required_goal_contribution`]: the error `goal.add` throws when a durable
//!   EventSub action's contribution could not be journaled; delivery recognises it and passes
//!   it on ([`dima_twitch::chat::ChatError::RequiredGoalContribution`]);
//! - [`Host::clock`] is the message's deadline clock (see below), not the wall clock.
//!
//! A group function must be cancellable (its future may be dropped at the message's deadline),
//! must bound every call it makes (deadlines on network and store calls), and must bound what it
//! returns (the engine charges it to the message, but it has to be held first).
//!
//! # "Not yet ported" is a thrown error
//!
//! The engine has exactly one failure kind for "this host cannot do that":
//! [`HostError`], what a thrown exception is in the reference. It stops the evaluation (the
//! reference's renderer catches nothing; its chat sender logs the failure and posts the text
//! unrendered). [`ActionError`] is this crate's typed reason, turned into a [`HostError`]
//! carrying its message at the trait boundary, so a function that is not ported yet fails
//! loudly instead of answering something plausible.
//!
//! # Storage, timers, effects (P4-ACT-CORE)
//!
//! The storage methods are [`storage`]'s (where each kind of variable lives is tabled there);
//! [`Host::schedule_timer`] writes through [`crate::timers`]; [`Host::fork_effect`] is
//! [`effects::fork_effect`]; [`Host::sleep`] waits on tokio's clock; `save_responses` does
//! nothing, as the reference's default does (no caller of the reference sets it).
//!
//! # Time
//!
//! [`Host::clock`] answers a [`DeadlineClock`]: the injected wall clock read once when the host
//! is made, plus the time elapsed since on tokio's monotonic clock. It cannot go back, so a
//! wall clock stepped backwards never extends a message's deadline. [`Host::alarm`] is
//! `tokio::time::sleep`: it always wakes, and dropping it cancels it; the engine races every
//! host call against it, so a host call that never answers ends at the message's deadline. In
//! tests with tokio's paused clock both move together.
//!
//! TypeScript of the dispatch: `utils/ast_parser/functions/index.ts` (`registerAllFunctions`)
//! and `utils/ast_parser/index.ts` (`parseAndEvaluate`), both P4-ACT-CORE's.

pub mod ai;
pub mod channel;
pub mod effects;
pub mod media;
pub mod moderation;
pub mod storage;

use crate::runner::CommandRunner;
use dima_commands::runtime::KeyPrefix;
use dima_commands::runtime::lookup::CommandCache;
use dima_core::{Clock, Random};
use dima_engine::context::{Effect, TimerSnapshot};
use dima_engine::host::{Host, HostCall, HostError, HostFunction, HostFuture};
use dima_engine::syntax::AstNode;
use dima_engine::value::Value;
use dima_store::dragonfly::Dragonfly;
use dima_store::mongo::MongoStore;
use dima_telemetry::Telemetry;
use dima_twitch::Twitch;
use dima_twitch::chat::ChatOut;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
pub use storage::{StorageConfig, VariableScope};

/// The four groups of effectful functions, one module and one package each (plan section 2.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Group {
    /// Timeouts, bans, VIPs and moderators, permits, chat modes: [`moderation`] (P4-ACT-MOD).
    Moderation,
    /// Twitch reads and channel writes, predictions, polls, announcements, pins, enabling
    /// commands and redemptions: [`channel`] (P4-ACT-CHANNEL).
    Channel,
    /// Overlays, roulettes, random users, clips, TTS, pets, widgets, goals, triggers:
    /// [`media`] (P4-ACT-MEDIA).
    Media,
    /// `$(ai)`: [`ai`] (P4-ACT-AI-A).
    Ai,
}

impl Group {
    /// Every group, in the plan's order.
    pub const ALL: [Group; 4] = [Group::Moderation, Group::Channel, Group::Media, Group::Ai];

    /// The group that runs `function`; `None` for [`HostFunction::Custom`], which no production
    /// registry holds (only the reference's own tests registered functions at run time).
    pub fn of(function: HostFunction) -> Option<Group> {
        use HostFunction as F;
        Some(match function {
            F::Warn
            | F::Vip
            | F::AddVip
            | F::ChannelAddVip
            | F::TwitchAddVip
            | F::Unvip
            | F::Ban
            | F::BanSelf
            | F::BanMod
            | F::Mod
            | F::AddMod
            | F::ChannelAddMod
            | F::TwitchAddMod
            | F::Unmod
            | F::Permit
            | F::ClearChat
            | F::EmoteOnly
            | F::BotMode => Group::Moderation,
            F::TwitchLive
            | F::TwitchSubs
            | F::TwitchTitle
            | F::TwitchGame
            | F::TwitchViewers
            | F::TwitchFollows
            | F::TwitchChannel
            | F::TwitchLogin
            | F::Raid
            | F::Unraid
            | F::SetTitle
            | F::SetGame
            | F::SetVoice
            | F::StartPrediction
            | F::GetPrediction
            | F::LockPrediction
            | F::EndPrediction
            | F::CancelPrediction
            | F::StartPoll
            | F::GetPoll
            | F::EndPoll
            | F::CancelPoll
            | F::Followage
            | F::Announce
            | F::Announcement
            | F::Shoutout
            | F::ChatAnnouncement
            | F::ChatSend
            | F::Pin
            | F::PinCreate
            | F::PinUpdate
            | F::PinDel
            | F::PinDelete
            | F::EnableCommand
            | F::DisableCommand
            | F::EnableRedemption
            | F::DisableRedemption => Group::Channel,
            F::OverlaySkip
            | F::OverlaySkipTwitch
            | F::OverlaySkipKick
            | F::OverlayPause
            | F::OverlayPauseTwitch
            | F::OverlayPauseKick
            | F::OverlayResume
            | F::OverlayResumeTwitch
            | F::OverlayResumeKick
            | F::OverlayClear
            | F::OverlayClearTwitch
            | F::OverlayClearKick
            | F::RouletteAdd
            | F::RouletteRemove
            | F::RouletteUpdate
            | F::RouletteShuffle
            | F::RouletteSwitch
            | F::RouletteShow
            | F::RouletteHide
            | F::RouletteStart
            | F::RouletteResult
            | F::RandomUser
            | F::ShowClip
            | F::CreateClip
            | F::TtsStatus
            | F::TtsConnected
            | F::TtsQueueLength
            | F::TtsSkip
            | F::TtsClear
            | F::TtsRefresh
            | F::TtsKokoro
            | F::Tts
            | F::TtsSpeak
            | F::TtsPiper
            | F::TtsAi
            | F::TtsClone
            | F::TtsFish
            | F::PetTalk
            | F::PetAsk
            | F::WidgetSignal
            | F::WidgetSignalTo
            | F::GoalAdd
            | F::TriggerSend => Group::Media,
            F::Ai => Group::Ai,
            F::Custom => return None,
        })
    }

    /// The group module's name.
    pub fn name(self) -> &'static str {
        match self {
            Group::Moderation => "moderation",
            Group::Channel => "channel",
            Group::Media => "media",
            Group::Ai => "ai",
        }
    }
}

/// Why [`DimaHost`] could not do what the engine asked. Each becomes a [`HostError`] with this
/// message at the [`Host`] boundary (the engine has no other failure kind for a host); the
/// message names the function, never a secret.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ActionError {
    /// The function's group module has not been filled by its package yet.
    #[error("$({}) is not ported yet", .0.name().unwrap_or("?"))]
    NotYetPorted(HostFunction),
    /// A storage method of the host (named as in [`Host`]) is not ported yet. No longer
    /// answered (P4-ACT-CORE ported them); kept for the group packages' tests.
    #[error("the command engine's {0} is not ported yet")]
    StorageNotYetPorted(&'static str),
    /// A function registered at run time ([`HostFunction::Custom`]) that this host does not
    /// know. No production registry has one.
    #[error("[Unknown function: {0}]")]
    Unregistered(String),
}

impl From<ActionError> for HostError {
    fn from(error: ActionError) -> Self {
        HostError::new(error.to_string())
    }
}

/// Everything [`DimaHost`] works with: one per process, shared by every evaluation.
///
/// The shared handles are P4-ACT-CORE's; each group module's [`moderation::Deps`],
/// [`channel::Deps`], [`media::Deps`] and [`ai::Deps`] belongs to that group's package, which
/// adds the handles it needs there (the features, moderation, AI, TTS and billing services).
/// The binaries build it at start-up (P4-BIN-BOT, P4-BIN-API, P2-CRON-01).
pub struct HostDeps {
    /// MongoDB: channel and viewer variables, command counters, the features' collections.
    pub mongo: MongoStore,
    /// Dragonfly (the Rust processes' logical database): cache variables, cooldowns, the
    /// carried `ast:timers:*` family.
    pub dragonfly: Dragonfly,
    /// [`Self::dragonfly`]'s key prefix for every key this crate builds (empty in production;
    /// tests give each run its own).
    pub keys: KeyPrefix,
    /// Twitch: Helix calls, the plain chat send and the streamer directory.
    pub twitch: Twitch,
    /// The command lookup and the counter writes (`dima-commands`).
    pub commands: CommandCache,
    /// The wall clock (`Date.now()`).
    pub clock: Arc<dyn Clock>,
    /// `Math.random()`, `crypto.randomUUID()` and friends of the command language (the
    /// placeholder variable names, timer ids, `$(random)`).
    pub random: Arc<dyn Random>,
    /// Logs (`None` in tests that do not look at them).
    pub telemetry: Option<Telemetry>,
    /// The storage's deadlines and bounds.
    pub storage: StorageConfig,
    /// The AST timers' limits and the in-process wake-up of the scheduler.
    pub timers: crate::timers::TimerQueue,
    /// The moderation group's handles (P4-ACT-MOD).
    pub moderation: moderation::Deps,
    /// The channel group's handles (P4-ACT-CHANNEL).
    pub channel: channel::Deps,
    /// The media group's handles (P4-ACT-MEDIA).
    pub media: media::Deps,
    /// The AI group's handles (P4-ACT-AI-A).
    pub ai: ai::Deps,
}

/// A clock that cannot go back: the wall clock read once, plus the time elapsed since on
/// tokio's monotonic clock. The engine measures a message's deadline with it
/// ([`Host::clock`]).
#[derive(Clone, Debug)]
pub struct DeadlineClock {
    wall_at_start: i64,
    start: tokio::time::Instant,
}

impl DeadlineClock {
    /// A clock that starts at `wall`'s current time.
    pub fn starting_at(wall: &dyn Clock) -> Self {
        Self {
            wall_at_start: wall.now_ms(),
            start: tokio::time::Instant::now(),
        }
    }
}

impl Clock for DeadlineClock {
    fn now_ms(&self) -> i64 {
        let elapsed = i64::try_from(self.start.elapsed().as_millis()).unwrap_or(i64::MAX);
        self.wall_at_start.saturating_add(elapsed)
    }
}

/// What the run tells its caller beyond the engine's answer.
#[derive(Debug, Default)]
pub(crate) struct HostSignals {
    /// `goal.add` threw `RequiredGoalContributionError`.
    pub(crate) required_goal: AtomicBool,
}

/// The process's chat delivery and command runner, as a host function sees them.
#[derive(Clone)]
pub(crate) struct Services {
    pub(crate) chat: Arc<dyn ChatOut>,
    pub(crate) runner: Arc<dyn CommandRunner>,
}

/// The host of one evaluation: what the engine calls for every effect. Cheap to make; the
/// delivery makes one per rendering (a command and each of its references get their own, as
/// each has its own event user in the reference).
pub struct DimaHost {
    deps: Arc<HostDeps>,
    channel_id: String,
    variables: VariableScope,
    clock: DeadlineClock,
    services: Option<Services>,
    signals: Arc<HostSignals>,
}

impl DimaHost {
    /// A host over the process's shared handles for no channel: variables are detached and no
    /// delivery is attached. For tests of a group module; evaluations go through
    /// [`crate::delivery::ChatDelivery`], which makes its hosts with [`DimaHost::for_channel`].
    pub fn new(deps: Arc<HostDeps>) -> Self {
        let clock = DeadlineClock::starting_at(deps.clock.as_ref());
        Self {
            deps,
            channel_id: String::new(),
            variables: VariableScope::Detached,
            clock,
            services: None,
            signals: Arc::default(),
        }
    }

    /// A host for a run of `channel_id` whose persistent variables are `variables`.
    pub fn for_channel(
        deps: Arc<HostDeps>,
        channel_id: impl Into<String>,
        variables: VariableScope,
    ) -> Self {
        let mut host = Self::new(deps);
        host.channel_id = channel_id.into();
        host.variables = variables;
        host
    }

    /// The same host with the process's chat delivery and command runner attached.
    pub(crate) fn with_services(mut self, services: Services) -> Self {
        self.services = Some(services);
        self
    }

    pub(crate) fn signals(&self) -> Arc<HostSignals> {
        Arc::clone(&self.signals)
    }

    /// The process's shared handles, for the group modules.
    pub fn deps(&self) -> &HostDeps {
        &self.deps
    }

    /// The shared handles, owned.
    pub fn deps_arc(&self) -> &Arc<HostDeps> {
        &self.deps
    }

    /// The channel the run belongs to (`''` for a host made with [`DimaHost::new`]).
    pub fn channel_id(&self) -> &str {
        &self.channel_id
    }

    /// The user id and login the run's event names (`extractUserInfo(eventData)`), which the
    /// viewer variables belong to; `None` for a detached run.
    pub fn event_user(&self) -> Option<(&str, &str)> {
        match &self.variables {
            VariableScope::Event {
                user_id,
                user_login,
            } => Some((user_id, user_login)),
            VariableScope::Detached => None,
        }
    }

    /// `Date.now()` on the injected wall clock.
    pub fn now_ms(&self) -> i64 {
        self.deps.clock.now_ms()
    }

    /// The process's chat delivery, for functions that post chat.
    pub fn chat(&self) -> Option<&Arc<dyn ChatOut>> {
        self.services.as_ref().map(|services| &services.chat)
    }

    /// The process's command runner, for the AI chat's tools.
    pub fn runner(&self) -> Option<&Arc<dyn CommandRunner>> {
        self.services.as_ref().map(|services| &services.runner)
    }

    /// The error `goal.add` throws for a durable EventSub action whose contribution could not
    /// be journaled (`RequiredGoalContributionError`): return it from the function; delivery
    /// lets it through to the caller so the event is retried.
    pub fn required_goal_contribution(&self) -> HostError {
        self.signals.required_goal.store(true, Ordering::SeqCst);
        HostError::new(
            dima_commands::runtime::goal_error::RequiredGoalContributionError.to_string(),
        )
    }
}

impl Host for DimaHost {
    fn clock(&self) -> &dyn Clock {
        &self.clock
    }

    fn random(&self) -> &dyn Random {
        self.deps.random.as_ref()
    }

    fn call<'a>(&'a mut self, call: HostCall<'a>) -> HostFuture<'a, Result<Value, HostError>> {
        Box::pin(async move {
            match Group::of(call.function) {
                Some(Group::Moderation) => moderation::call(self, call).await,
                Some(Group::Channel) => channel::call(self, call).await,
                Some(Group::Media) => media::call(self, call).await,
                Some(Group::Ai) => ai::call(self, call).await,
                None => Err(ActionError::Unregistered(call.name.to_owned()).into()),
            }
        })
    }

    fn alarm(&self, millis: u64) -> HostFuture<'static, ()> {
        Box::pin(tokio::time::sleep(Duration::from_millis(millis)))
    }

    fn sleep(&mut self, millis: u64) -> HostFuture<'_, ()> {
        Box::pin(tokio::time::sleep(Duration::from_millis(millis)))
    }

    fn cache_get<'a>(
        &'a mut self,
        key: &'a str,
    ) -> HostFuture<'a, Result<Option<String>, HostError>> {
        Box::pin(storage::cache_get(&self.deps, key))
    }

    fn cache_exists<'a>(&'a mut self, key: &'a str) -> HostFuture<'a, Result<bool, HostError>> {
        Box::pin(storage::cache_exists(&self.deps, key))
    }

    fn cache_set<'a>(
        &'a mut self,
        key: &'a str,
        value: &'a str,
    ) -> HostFuture<'a, Result<(), HostError>> {
        Box::pin(storage::cache_set(&self.deps, key, value))
    }

    fn cache_expire<'a>(
        &'a mut self,
        key: &'a str,
        seconds: u64,
    ) -> HostFuture<'a, Result<(), HostError>> {
        Box::pin(storage::cache_expire(&self.deps, key, seconds))
    }

    fn cache_delete<'a>(&'a mut self, key: &'a str) -> HostFuture<'a, Result<(), HostError>> {
        Box::pin(storage::cache_delete(&self.deps, key))
    }

    fn load_channel_variable<'a>(
        &'a mut self,
        name: &'a str,
    ) -> HostFuture<'a, Result<String, HostError>> {
        Box::pin(async move {
            Ok(match self.variables {
                VariableScope::Event { .. } => {
                    storage::load_channel_variable(&self.deps, &self.channel_id, name).await
                }
                VariableScope::Detached => String::new(),
            })
        })
    }

    fn save_channel_variable<'a>(
        &'a mut self,
        name: &'a str,
        value: &'a str,
    ) -> HostFuture<'a, Result<(), HostError>> {
        Box::pin(async move {
            if let VariableScope::Event { .. } = self.variables {
                storage::save_channel_variable(&self.deps, &self.channel_id, name, value).await;
            }
            Ok(())
        })
    }

    fn delete_channel_variable<'a>(
        &'a mut self,
        name: &'a str,
    ) -> HostFuture<'a, Result<(), HostError>> {
        Box::pin(async move {
            if let VariableScope::Event { .. } = self.variables {
                storage::delete_channel_variable(&self.deps, &self.channel_id, name).await;
            }
            Ok(())
        })
    }

    fn load_user_variable<'a>(
        &'a mut self,
        name: &'a str,
        target: Option<&'a str>,
    ) -> HostFuture<'a, Result<String, HostError>> {
        Box::pin(async move {
            Ok(match &self.variables {
                VariableScope::Event {
                    user_id,
                    user_login,
                } => {
                    storage::load_user_variable(
                        &self.deps,
                        &self.channel_id,
                        (user_id, user_login),
                        name,
                        target,
                    )
                    .await
                }
                VariableScope::Detached => String::new(),
            })
        })
    }

    fn save_user_variable<'a>(
        &'a mut self,
        name: &'a str,
        value: &'a str,
        target: Option<&'a str>,
    ) -> HostFuture<'a, Result<(), HostError>> {
        Box::pin(async move {
            if let VariableScope::Event {
                user_id,
                user_login,
            } = &self.variables
            {
                storage::save_user_variable(
                    &self.deps,
                    &self.channel_id,
                    (user_id, user_login),
                    name,
                    value,
                    target,
                )
                .await;
            }
            Ok(())
        })
    }

    fn delete_user_variable<'a>(
        &'a mut self,
        name: &'a str,
        target: Option<&'a str>,
    ) -> HostFuture<'a, Result<(), HostError>> {
        Box::pin(async move {
            if let VariableScope::Event {
                user_id,
                user_login,
            } = &self.variables
            {
                storage::delete_user_variable(
                    &self.deps,
                    &self.channel_id,
                    (user_id, user_login),
                    name,
                    target,
                )
                .await;
            }
            Ok(())
        })
    }

    fn save_responses<'a>(
        &'a mut self,
        _responses: &'a [String],
    ) -> HostFuture<'a, Result<(), HostError>> {
        Box::pin(async { Ok(()) })
    }

    fn schedule_timer<'a>(
        &'a mut self,
        seconds: f64,
        body: &'a [AstNode],
        snapshot: TimerSnapshot,
    ) -> HostFuture<'a, Result<(), HostError>> {
        Box::pin(async move {
            crate::timers::schedule(&self.deps, seconds, body, snapshot)
                .await
                .map(drop)
                .map_err(|error| {
                    if let Some(telemetry) = &self.deps.telemetry {
                        telemetry.error(
                            &serde_json::json!({
                                "message": "AST timer scheduling failed",
                                "channelID": self.channel_id,
                                "error": error.to_string(),
                            }),
                            dima_telemetry::LogOptions::console().channel(&self.channel_id),
                        );
                    }
                    HostError::new(error.to_string())
                })
        })
    }

    fn fork_effect(&mut self, effect: &Effect) -> Option<Effect> {
        effects::fork_effect(effect)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// The plan's table (`ledger/upper-layers.md` section 2.2), written once from it: every
    /// registered name of each group.
    const MODERATION: [&str; 18] = [
        "warn",
        "vip",
        "add.vip",
        "channel.add.vip",
        "twitch.add.vip",
        "unvip",
        "ban",
        "ban.self",
        "ban.mod",
        "mod",
        "add.mod",
        "channel.add.mod",
        "twitch.add.mod",
        "unmod",
        "permit",
        "clear.chat",
        "emoteonly",
        "bot.mode",
    ];
    const CHANNEL: [&str; 37] = [
        "twitch.live",
        "twitch.subs",
        "twitch.title",
        "twitch.game",
        "twitch.viewers",
        "twitch.follows",
        "twitch.channel",
        "twitch.login",
        "raid",
        "unraid",
        "set.title",
        "set.game",
        "set.voice",
        "start.prediction",
        "get.prediction",
        "lock.prediction",
        "end.prediction",
        "cancel.prediction",
        "start.poll",
        "get.poll",
        "end.poll",
        "cancel.poll",
        "followage",
        "announce",
        "announcement",
        "shoutout",
        "chat.announcement",
        "chat.send",
        "pin",
        "pin.create",
        "pin.update",
        "pin.del",
        "pin.delete",
        "enable.command",
        "disable.command",
        "enable.redemption",
        "disable.redemption",
    ];
    const MEDIA: [&str; 43] = [
        "overlay.skip",
        "overlay.skip.twitch",
        "overlay.skip.kick",
        "overlay.pause",
        "overlay.pause.twitch",
        "overlay.pause.kick",
        "overlay.resume",
        "overlay.resume.twitch",
        "overlay.resume.kick",
        "overlay.clear",
        "overlay.clear.twitch",
        "overlay.clear.kick",
        "roulette.add",
        "roulette.remove",
        "roulette.update",
        "roulette.shuffle",
        "roulette.switch",
        "roulette.show",
        "roulette.hide",
        "roulette.start",
        "roulette.result",
        "randomuser",
        "show.clip",
        "create.clip",
        "tts.status",
        "tts.connected",
        "tts.queue.length",
        "tts.skip",
        "tts.clear",
        "tts.refresh",
        "tts.kokoro",
        "tts",
        "tts.speak",
        "tts.piper",
        "tts.ai",
        "tts.clone",
        "tts.fish",
        "pet.talk",
        "pet.ask",
        "widget.signal",
        "widget.signal.to",
        "goal.add",
        "trigger.send",
    ];
    const AI: [&str; 1] = ["ai"];

    fn planned() -> [(Group, &'static [&'static str]); 4] {
        [
            (Group::Moderation, &MODERATION),
            (Group::Channel, &CHANNEL),
            (Group::Media, &MEDIA),
            (Group::Ai, &AI),
        ]
    }

    /// Every one of the 99 variants is routed to exactly one group, the plan's, and the groups
    /// hold 18, 37, 43 and 1.
    #[test]
    fn every_function_is_routed_to_exactly_one_group() {
        assert_eq!(HostFunction::ALL.len(), 99);
        let mut seen = HashSet::new();
        for (group, names) in planned() {
            let counted = HostFunction::ALL
                .iter()
                .filter(|function| Group::of(**function) == Some(group))
                .count();
            assert_eq!(counted, names.len(), "{}", group.name());
            for name in names {
                let function = HostFunction::from_name(name)
                    .unwrap_or_else(|| panic!("{name} is not a host function"));
                assert_eq!(Group::of(function), Some(group), "{name}");
                assert!(seen.insert(function), "{name} is listed twice");
            }
        }
        assert_eq!(seen.len(), HostFunction::ALL.len());
        for function in HostFunction::ALL {
            assert!(seen.contains(function), "{function:?} is in no group");
        }
        assert_eq!(
            planned().map(|(_, names)| names.len()),
            [18, 37, 43, 1],
            "the plan's counts"
        );
        assert_eq!(Group::of(HostFunction::Custom), None);
    }

    #[test]
    fn not_yet_ported_is_a_thrown_error_naming_the_function() {
        let error: HostError = ActionError::NotYetPorted(HostFunction::Ban).into();
        assert_eq!(error, HostError::new("$(ban) is not ported yet"));
        let error: HostError = ActionError::StorageNotYetPorted("cache_get").into();
        assert_eq!(
            error.message,
            "the command engine's cache_get is not ported yet"
        );
        let error: HostError = ActionError::Unregistered("say".into()).into();
        assert_eq!(error.message, "[Unknown function: say]");
    }

    #[test]
    fn group_names_are_the_module_names() {
        assert_eq!(
            Group::ALL.map(Group::name),
            ["moderation", "channel", "media", "ai"]
        );
    }
}

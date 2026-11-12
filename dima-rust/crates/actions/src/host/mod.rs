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
//! # "Not yet ported" is a thrown error
//!
//! The engine has exactly one failure kind for "this host cannot do that":
//! [`HostError`], what a thrown exception is in the reference. It stops the evaluation (the
//! reference's renderer catches nothing; its chat sender logs the failure and posts the text
//! unrendered). [`ActionError`] is this crate's typed reason, turned into a [`HostError`]
//! carrying its message at the trait boundary, so a function that is not ported yet fails
//! loudly instead of answering something plausible.
//!
//! # Storage (P4-ACT-CORE)
//!
//! The storage methods of the trait (cache variables, channel and viewer variables, responses,
//! [`Host::schedule_timer`], [`Host::fork_effect`]) and the effect authority they carry
//! (`utils/ast_parser/effects.ts`: minting, scoping and forking authority, the pet, goal and
//! widget-signal keys) are package P4-ACT-CORE's. Until it lands, every fallible storage method
//! answers [`ActionError::StorageNotYetPorted`]; [`Host::fork_effect`] answers `None` (no
//! authority for a command reference, the reference's answer when the run has none);
//! [`Host::sleep`] waits on the runtime's clock. [`Host::alarm`] keeps the engine's default (it
//! never fires) until P4-ACT-CORE implements it, as the bot must (`packages.md`, phase 7).
//!
//! TypeScript of the dispatch: `utils/ast_parser/functions/index.ts` (`registerAllFunctions`)
//! and `utils/ast_parser/index.ts` (`parseAndEvaluate`), both P4-ACT-CORE's.

pub mod ai;
pub mod channel;
pub mod media;
pub mod moderation;

use dima_core::{Clock, Random};
use dima_engine::context::{Effect, TimerSnapshot};
use dima_engine::host::{Host, HostCall, HostError, HostFunction, HostFuture};
use dima_engine::syntax::AstNode;
use dima_engine::value::Value;
use dima_store::dragonfly::Dragonfly;
use dima_store::mongo::MongoStore;
use dima_twitch::Twitch;
use std::sync::Arc;
use std::time::Duration;

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
    /// A storage method of the host (named as in [`Host`]) is not ported yet (P4-ACT-CORE).
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
    /// MongoDB: channel and viewer variables, responses, the features' collections.
    pub mongo: MongoStore,
    /// Dragonfly: cache variables, the carried `ast:timers:*` family, queues.
    pub dragonfly: Dragonfly,
    /// Twitch: Helix calls and the streamer directory.
    pub twitch: Twitch,
    /// The wall clock (`Date.now()`).
    pub clock: Arc<dyn Clock>,
    /// `Math.random()` and friends.
    pub random: Arc<dyn Random>,
    /// The moderation group's handles (P4-ACT-MOD).
    pub moderation: moderation::Deps,
    /// The channel group's handles (P4-ACT-CHANNEL).
    pub channel: channel::Deps,
    /// The media group's handles (P4-ACT-MEDIA).
    pub media: media::Deps,
    /// The AI group's handles (P4-ACT-AI-A).
    pub ai: ai::Deps,
}

/// The host of one evaluation: what the engine calls for every effect. Cheap to make (one
/// [`Arc`] clone); make one per message, as the per-run state P4-ACT-CORE adds (the message's
/// channel, its effect authority) belongs to one evaluation.
pub struct DimaHost {
    deps: Arc<HostDeps>,
}

impl DimaHost {
    /// A host over the process's shared handles.
    pub fn new(deps: Arc<HostDeps>) -> Self {
        Self { deps }
    }

    /// The process's shared handles, for the group modules.
    pub fn deps(&self) -> &HostDeps {
        &self.deps
    }

    /// The answer of a storage method that is not ported yet.
    fn storage<T>(method: &'static str) -> HostFuture<'static, Result<T, HostError>>
    where
        T: Send + 'static,
    {
        Box::pin(async move { Err(ActionError::StorageNotYetPorted(method).into()) })
    }
}

impl Host for DimaHost {
    fn clock(&self) -> &dyn Clock {
        self.deps.clock.as_ref()
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

    fn sleep(&mut self, millis: u64) -> HostFuture<'_, ()> {
        Box::pin(tokio::time::sleep(Duration::from_millis(millis)))
    }

    fn cache_get<'a>(
        &'a mut self,
        _key: &'a str,
    ) -> HostFuture<'a, Result<Option<String>, HostError>> {
        Self::storage("cache_get")
    }

    fn cache_exists<'a>(&'a mut self, _key: &'a str) -> HostFuture<'a, Result<bool, HostError>> {
        Self::storage("cache_exists")
    }

    fn cache_set<'a>(
        &'a mut self,
        _key: &'a str,
        _value: &'a str,
    ) -> HostFuture<'a, Result<(), HostError>> {
        Self::storage("cache_set")
    }

    fn cache_expire<'a>(
        &'a mut self,
        _key: &'a str,
        _seconds: u64,
    ) -> HostFuture<'a, Result<(), HostError>> {
        Self::storage("cache_expire")
    }

    fn cache_delete<'a>(&'a mut self, _key: &'a str) -> HostFuture<'a, Result<(), HostError>> {
        Self::storage("cache_delete")
    }

    fn load_channel_variable<'a>(
        &'a mut self,
        _name: &'a str,
    ) -> HostFuture<'a, Result<String, HostError>> {
        Self::storage("load_channel_variable")
    }

    fn save_channel_variable<'a>(
        &'a mut self,
        _name: &'a str,
        _value: &'a str,
    ) -> HostFuture<'a, Result<(), HostError>> {
        Self::storage("save_channel_variable")
    }

    fn delete_channel_variable<'a>(
        &'a mut self,
        _name: &'a str,
    ) -> HostFuture<'a, Result<(), HostError>> {
        Self::storage("delete_channel_variable")
    }

    fn load_user_variable<'a>(
        &'a mut self,
        _name: &'a str,
        _target: Option<&'a str>,
    ) -> HostFuture<'a, Result<String, HostError>> {
        Self::storage("load_user_variable")
    }

    fn save_user_variable<'a>(
        &'a mut self,
        _name: &'a str,
        _value: &'a str,
        _target: Option<&'a str>,
    ) -> HostFuture<'a, Result<(), HostError>> {
        Self::storage("save_user_variable")
    }

    fn delete_user_variable<'a>(
        &'a mut self,
        _name: &'a str,
        _target: Option<&'a str>,
    ) -> HostFuture<'a, Result<(), HostError>> {
        Self::storage("delete_user_variable")
    }

    fn save_responses<'a>(
        &'a mut self,
        _responses: &'a [String],
    ) -> HostFuture<'a, Result<(), HostError>> {
        Self::storage("save_responses")
    }

    fn schedule_timer<'a>(
        &'a mut self,
        _seconds: f64,
        _body: &'a [AstNode],
        _snapshot: TimerSnapshot,
    ) -> HostFuture<'a, Result<(), HostError>> {
        Self::storage("schedule_timer")
    }

    fn fork_effect(&mut self, _effect: &Effect) -> Option<Effect> {
        None
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

//! The host: everything an evaluation does outside the engine.
//!
//! Sending chat, calling Twitch, reading and writing variables in Dragonfly and MongoDB,
//! scheduling timers, forking effect authority, sleeping, the clock and randomness all go
//! through [`Host`]. The engine itself is pure: given the same host answers it computes the same
//! result.
//!
//! The trait is object-safe (`&mut dyn Host`) and every method returns a boxed `Send` future,
//! so an evaluation is `Send` and can run on a multi-threaded runtime. A later crate
//! (`dima-actions`) implements it without touching this one: every effectful function of the
//! reference is a [`HostFunction`] variant, so its `match` is checked for completeness.
//!
//! Errors: a [`HostError`] is what a thrown exception is in the reference. It fails the whole
//! evaluation, except where the reference catches it (removing a list item from a `*`/`**`
//! variable or a cache variable, scheduling a timer). A function's *answer* that reports a
//! problem (`Error: …`, `timer: …`) is an ordinary [`Value`].

use crate::context::{Context, Effect, RandomUserState, TimerSnapshot};
use crate::syntax::AstNode;
use crate::value::Value;
use dima_core::{Clock, Random};
use std::future::Future;
use std::pin::Pin;

/// A boxed future the host returns.
pub type HostFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A failure the reference would throw: the evaluation stops with it.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct HostError {
    /// What failed (never secrets or tokens).
    pub message: String,
}

impl HostError {
    /// A failure with `message`.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

macro_rules! host_functions {
    ($($variant:ident => $name:literal,)*) => {
        /// Every effectful function of the reference's registry, one variant per registered
        /// name (aliases included, so the host sees exactly what the command wrote), plus
        /// [`HostFunction::Custom`] for functions a caller registers itself.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum HostFunction {
            $(
                #[doc = concat!("`$(", $name, ")`")]
                $variant,
            )*
            /// A function registered at run time ([`crate::registry::Registry::register`]); the
            /// host dispatches on [`HostCall::name`].
            Custom,
        }

        impl HostFunction {
            /// Every built-in effectful function, in the reference's registration order.
            pub const ALL: &'static [HostFunction] = &[$(HostFunction::$variant,)*];

            /// The registered name (`None` for [`HostFunction::Custom`]).
            pub fn name(self) -> Option<&'static str> {
                match self {
                    $(HostFunction::$variant => Some($name),)*
                    HostFunction::Custom => None,
                }
            }

            /// The built-in function registered as `name`.
            pub fn from_name(name: &str) -> Option<Self> {
                match name {
                    $($name => Some(HostFunction::$variant),)*
                    _ => None,
                }
            }
        }
    };
}

host_functions! {
    OverlaySkip => "overlay.skip",
    OverlaySkipTwitch => "overlay.skip.twitch",
    OverlaySkipKick => "overlay.skip.kick",
    OverlayPause => "overlay.pause",
    OverlayPauseTwitch => "overlay.pause.twitch",
    OverlayPauseKick => "overlay.pause.kick",
    OverlayResume => "overlay.resume",
    OverlayResumeTwitch => "overlay.resume.twitch",
    OverlayResumeKick => "overlay.resume.kick",
    OverlayClear => "overlay.clear",
    OverlayClearTwitch => "overlay.clear.twitch",
    OverlayClearKick => "overlay.clear.kick",
    EnableCommand => "enable.command",
    DisableCommand => "disable.command",
    EnableRedemption => "enable.redemption",
    DisableRedemption => "disable.redemption",
    RouletteAdd => "roulette.add",
    RouletteRemove => "roulette.remove",
    RouletteUpdate => "roulette.update",
    RouletteShuffle => "roulette.shuffle",
    RouletteSwitch => "roulette.switch",
    RouletteShow => "roulette.show",
    RouletteHide => "roulette.hide",
    RouletteStart => "roulette.start",
    RouletteResult => "roulette.result",
    RandomUser => "randomuser",
    Warn => "warn",
    Vip => "vip",
    AddVip => "add.vip",
    ChannelAddVip => "channel.add.vip",
    TwitchAddVip => "twitch.add.vip",
    Unvip => "unvip",
    Ban => "ban",
    BanSelf => "ban.self",
    BanMod => "ban.mod",
    Mod => "mod",
    AddMod => "add.mod",
    ChannelAddMod => "channel.add.mod",
    TwitchAddMod => "twitch.add.mod",
    Unmod => "unmod",
    Permit => "permit",
    ClearChat => "clear.chat",
    EmoteOnly => "emoteonly",
    TwitchLive => "twitch.live",
    TwitchSubs => "twitch.subs",
    TwitchTitle => "twitch.title",
    TwitchGame => "twitch.game",
    TwitchViewers => "twitch.viewers",
    TwitchFollows => "twitch.follows",
    TwitchChannel => "twitch.channel",
    TwitchLogin => "twitch.login",
    Raid => "raid",
    Unraid => "unraid",
    SetTitle => "set.title",
    SetGame => "set.game",
    SetVoice => "set.voice",
    StartPrediction => "start.prediction",
    GetPrediction => "get.prediction",
    LockPrediction => "lock.prediction",
    EndPrediction => "end.prediction",
    CancelPrediction => "cancel.prediction",
    StartPoll => "start.poll",
    GetPoll => "get.poll",
    EndPoll => "end.poll",
    CancelPoll => "cancel.poll",
    Ai => "ai",
    ShowClip => "show.clip",
    CreateClip => "create.clip",
    Followage => "followage",
    TtsStatus => "tts.status",
    TtsConnected => "tts.connected",
    TtsQueueLength => "tts.queue.length",
    TtsSkip => "tts.skip",
    TtsClear => "tts.clear",
    TtsRefresh => "tts.refresh",
    TtsKokoro => "tts.kokoro",
    Tts => "tts",
    TtsSpeak => "tts.speak",
    TtsPiper => "tts.piper",
    TtsAi => "tts.ai",
    TtsClone => "tts.clone",
    TtsFish => "tts.fish",
    PetTalk => "pet.talk",
    PetAsk => "pet.ask",
    WidgetSignal => "widget.signal",
    WidgetSignalTo => "widget.signal.to",
    GoalAdd => "goal.add",
    TriggerSend => "trigger.send",
    Announce => "announce",
    Announcement => "announcement",
    Shoutout => "shoutout",
    ChatAnnouncement => "chat.announcement",
    ChatSend => "chat.send",
    BotMode => "bot.mode",
    Pin => "pin",
    PinCreate => "pin.create",
    PinUpdate => "pin.update",
    PinDel => "pin.del",
    PinDelete => "pin.delete",
}

/// One call of an effectful function: the reference's `handler(args, ctx)`.
pub struct HostCall<'a> {
    /// Which function.
    pub function: HostFunction,
    /// The name as written (needed for [`HostFunction::Custom`]).
    pub name: &'a str,
    /// The evaluated arguments, in order.
    pub args: Vec<Value>,
    /// The invocation.
    pub context: &'a Context,
    /// The effect authority at this point (absent inside a timer's duration, for instance).
    pub effect: Option<&'a Effect>,
    /// `randomUserState` of this run.
    pub random_user: &'a mut RandomUserState,
}

/// Where the engine sends every effect. See the module documentation.
pub trait Host: Send {
    /// The wall clock (`Date.now()`), for hosts and functions that need the time.
    fn clock(&self) -> &dyn Clock;

    /// `Math.random()` and friends.
    fn random(&self) -> &dyn Random;

    /// Runs an effectful function and returns its answer.
    fn call<'a>(&'a mut self, call: HostCall<'a>) -> HostFuture<'a, Result<Value, HostError>>;

    /// A test run ([`Context::simulation`]) asks this before every function call (and instead of
    /// evaluating a timer, with no arguments): `Some(value)` replaces the call, `None` runs it.
    /// Never asked in a real run.
    fn simulate<'a>(
        &'a mut self,
        name: &'a str,
        args: &'a [Value],
        context: &'a Context,
    ) -> HostFuture<'a, Result<Option<Value>, HostError>> {
        let _ = (name, args, context);
        Box::pin(async { Ok(None) })
    }

    /// Waits (`$(delay)`), at most 60 seconds.
    fn sleep(&mut self, millis: u64) -> HostFuture<'_, ()>;

    /// A cache variable's raw value (`GET`).
    fn cache_get<'a>(
        &'a mut self,
        key: &'a str,
    ) -> HostFuture<'a, Result<Option<String>, HostError>>;

    /// Whether a cache variable exists (`EXISTS`).
    fn cache_exists<'a>(&'a mut self, key: &'a str) -> HostFuture<'a, Result<bool, HostError>>;

    /// Stores a cache variable (`SET`).
    fn cache_set<'a>(
        &'a mut self,
        key: &'a str,
        value: &'a str,
    ) -> HostFuture<'a, Result<(), HostError>>;

    /// Sets a cache variable's expiry (`EXPIRE`); the engine always passes 86,400.
    fn cache_expire<'a>(
        &'a mut self,
        key: &'a str,
        seconds: u64,
    ) -> HostFuture<'a, Result<(), HostError>>;

    /// Deletes a cache variable (`DEL`).
    fn cache_delete<'a>(&'a mut self, key: &'a str) -> HostFuture<'a, Result<(), HostError>>;

    /// A channel variable (`*name`); empty when missing (`loadChannelVariable`).
    fn load_channel_variable<'a>(
        &'a mut self,
        name: &'a str,
    ) -> HostFuture<'a, Result<String, HostError>>;

    /// Stores a channel variable (`saveChannelVariable`).
    fn save_channel_variable<'a>(
        &'a mut self,
        name: &'a str,
        value: &'a str,
    ) -> HostFuture<'a, Result<(), HostError>>;

    /// Deletes a channel variable (`deleteChannelVariable`).
    fn delete_channel_variable<'a>(
        &'a mut self,
        name: &'a str,
    ) -> HostFuture<'a, Result<(), HostError>>;

    /// A viewer variable (`**name`) of the caller, or of `target` (the selector's text, trimmed;
    /// possibly empty); empty when missing (`loadUserVariable`).
    fn load_user_variable<'a>(
        &'a mut self,
        name: &'a str,
        target: Option<&'a str>,
    ) -> HostFuture<'a, Result<String, HostError>>;

    /// Stores a viewer variable (`saveUserVariable`).
    fn save_user_variable<'a>(
        &'a mut self,
        name: &'a str,
        value: &'a str,
        target: Option<&'a str>,
    ) -> HostFuture<'a, Result<(), HostError>>;

    /// Deletes a viewer variable (`deleteUserVariable`).
    fn delete_user_variable<'a>(
        &'a mut self,
        name: &'a str,
        target: Option<&'a str>,
    ) -> HostFuture<'a, Result<(), HostError>>;

    /// Stores the command's responses after `%(responses[] …)` changed them (`saveResponses`).
    fn save_responses<'a>(
        &'a mut self,
        responses: &'a [String],
    ) -> HostFuture<'a, Result<(), HostError>>;

    /// Schedules a timer: `body` (a root's children, unevaluated) runs after `seconds` with the
    /// snapshot as its context (`scheduleAstTimer`). An error is reported to chat as
    /// `timer: could not schedule timer`.
    fn schedule_timer<'a>(
        &'a mut self,
        seconds: f64,
        body: &'a [AstNode],
        snapshot: TimerSnapshot,
    ) -> HostFuture<'a, Result<(), HostError>>;

    /// `forkAstEffectContext`: a new branch of `effect` for a command reference, or `None`.
    fn fork_effect(&mut self, effect: &Effect) -> Option<Effect>;
}

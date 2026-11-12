//! Live effect authority (`utils/ast_parser/effects.ts`, 85 lines): what lets a run of command
//! language do things on behalf of a verified Twitch event (a pet talking, a goal contribution,
//! a widget signal), and the stable keys those actions are de-duplicated by.
//!
//! The engine carries authority as an opaque [`Effect`]; this module mints it, scopes it to the
//! stored configuration that runs, forks it for a command reference, and hands out the per-run
//! action keys. Only verified ingress mints it: the EventSub ingress for a chat message
//! (P4-CHAT-MESSAGE calls [`twitch_effect`] with a `chat-command` origin), the durable chat
//! announcement consumer (through [`dima_twitch::chat::EffectGrant`], minted by
//! [`crate::delivery::ChatDelivery`]). No parser or event payload infers it.
//!
//! # What is shared, as in the reference
//!
//! The reference keeps the state in a `WeakMap` and copies it on each mint with an object
//! spread: the copy has its own `path` and fresh counters, but shares `origin`, `actor` and the
//! widget-signal `budget` object with the state it came from. [`EffectAuthority`] does the same:
//! `origin` and `actor` are behind [`Arc`]s, the signal budget is one [`AtomicU32`] for every
//! scoped or forked copy of one run, and each authority's counters are its own.
//! [`fork_effect`] advances the parent's `next` counter (the reference's `state.next++`), so two
//! references of one run get `reference:0` and `reference:1`.
//!
//! # Stored identities
//!
//! The action keys are hashes of `JSON.stringify` of the path and a counter: the pet request,
//! goal contribution and widget signal stores de-duplicate by them, so they are computed exactly
//! as the reference computes them ([`dima_text::to_js_json`] of the same array, SHA-256, hex).
//! The badge texts of a chat actor are cut to 80 UTF-16 units as the reference's `slice(0, 80)`
//! does (they are hashed into a pet request's payload by `pets/admission.ts`), never inside a
//! character (charter section 4, identity row).
//!
//! Text limits of the validation (an origin id of 1 to 200, an actor id of 1 to 100, a display
//! name of at most 100, a chat message of 1 to 2,000) count UTF-16 units as the reference does:
//! they decide whether authority exists at all, and every real value is far inside them.

use dima_engine::context::Effect;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

/// `WIDGET_SIGNALS_PER_RUN`: widget signals one command run (with its references) may send.
pub const WIDGET_SIGNALS_PER_RUN: u32 = 5;

/// `origin.kind` of an authority this module mints.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OriginKind {
    /// A chat command (the EventSub `channel.chat.message` ingress).
    ChatCommand,
    /// Any other verified Twitch event (the durable chat announcements).
    TwitchEvent,
}

impl OriginKind {
    /// `chat-command` or `twitch-event`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ChatCommand => "chat-command",
            Self::TwitchEvent => "twitch-event",
        }
    }
}

/// `origin`: what happened, as the pet, goal and widget stores record it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EffectOrigin {
    /// `kind`.
    pub kind: OriginKind,
    /// `id`: the chat message id or the domain event's key.
    pub id: String,
    /// `occurredAt`, as given (ISO 8601).
    pub occurred_at: String,
}

/// `actor.chat`: the chat message an actor sent, for a `chat-command` origin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatActor {
    /// `login`.
    pub login: String,
    /// `message`: the chat text.
    pub message: String,
    /// `badges` as `(set_id, id, info)`.
    pub badges: Vec<(String, String, String)>,
}

/// `actor`: who acted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EffectActor {
    /// `userId`.
    pub user_id: String,
    /// `displayName`.
    pub display_name: String,
    /// `chat`, kept only when it passes the reference's checks.
    pub chat: Option<ChatActor>,
}

impl EffectActor {
    /// The actor as the reference's object (`{userId, displayName, chat?}`), for the stores
    /// that record it.
    pub fn to_json(&self) -> Value {
        let mut actor = json!({ "userId": self.user_id, "displayName": self.display_name });
        if let (Some(chat), Value::Object(map)) = (&self.chat, &mut actor) {
            let badges: Vec<Value> = chat
                .badges
                .iter()
                .map(|(set_id, id, info)| json!({ "set_id": set_id, "id": id, "info": info }))
                .collect();
            map.insert(
                "chat".into(),
                json!({ "login": chat.login, "message": chat.message, "badges": badges }),
            );
        }
        actor
    }
}

impl EffectOrigin {
    /// The origin as the reference's object (`{kind, id, occurredAt}`).
    pub fn to_json(&self) -> Value {
        json!({ "kind": self.kind.as_str(), "id": self.id, "occurredAt": self.occurred_at })
    }
}

#[derive(Debug, Default)]
struct Counters {
    next: u64,
    goal_next: u64,
    signal_next: u64,
}

/// `EffectState`: the authority behind an [`Effect`] this module minted.
#[derive(Debug)]
pub struct EffectAuthority {
    channel_id: String,
    origin: Arc<EffectOrigin>,
    actor: Arc<EffectActor>,
    path: Vec<String>,
    counters: Mutex<Counters>,
    signals: Arc<AtomicU32>,
}

impl EffectAuthority {
    /// The channel the authority belongs to.
    pub fn channel_id(&self) -> &str {
        &self.channel_id
    }

    /// The origin.
    pub fn origin(&self) -> &EffectOrigin {
        &self.origin
    }

    /// The actor.
    pub fn actor(&self) -> &EffectActor {
        &self.actor
    }

    /// The configuration path (`command:<id>`, `eventsub:<id>:<type>`, `reference:<n>`...).
    pub fn path(&self) -> &[String] {
        &self.path
    }

    fn counters(&self) -> std::sync::MutexGuard<'_, Counters> {
        self.counters.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A copy with `path` and fresh counters, sharing origin, actor and the signal budget.
    fn derive(&self, path: Vec<String>) -> Effect {
        Effect::new(Self {
            channel_id: self.channel_id.clone(),
            origin: Arc::clone(&self.origin),
            actor: Arc::clone(&self.actor),
            path,
            counters: Mutex::new(Counters::default()),
            signals: Arc::clone(&self.signals),
        })
    }
}

/// The input of [`twitch_effect`] (`Pick<AdmitPetActionInput, 'channelId' | 'origin' |
/// 'actor'>`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EffectInput {
    /// `channelId`.
    pub channel_id: String,
    /// `origin`.
    pub origin: EffectOrigin,
    /// `actor.userId`.
    pub actor_id: String,
    /// `actor.displayName`.
    pub actor_name: String,
    /// `actor.chat` as given (checked here).
    pub chat: Option<ChatActor>,
}

fn utf16(text: &str) -> usize {
    dima_text::utf16_len(text)
}

fn is_login(text: &str) -> bool {
    (1..=25).contains(&text.len())
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// `createTwitchEffectContext(input)`: authority for a verified Twitch event, or `None` when
/// the input fails one of the reference's checks (a channel id of 1 to 30 ASCII digits; an
/// origin id that is not blank and at most 200 long; a parsable `occurredAt`; an actor id that
/// is not blank and at most 100 long; a display name at most 100 long). A chat actor is kept
/// only for a `chat-command` origin with a login of 1 to 25 letters, digits or `_`, a message
/// of 1 to 2,000 and at most 50 badges, each text cut to 80.
pub fn twitch_effect(input: EffectInput) -> Option<Effect> {
    let EffectInput {
        channel_id,
        origin,
        actor_id,
        actor_name,
        chat,
    } = input;
    let channel_ok = (1..=30).contains(&channel_id.len())
        && channel_id.bytes().all(|byte| byte.is_ascii_digit());
    if !channel_ok
        || dima_text::trim(&origin.id).is_empty()
        || utf16(&origin.id) > 200
        || dima_text::parse_date(&origin.occurred_at).is_none()
        || dima_text::trim(&actor_id).is_empty()
        || utf16(&actor_id) > 100
        || utf16(&actor_name) > 100
    {
        return None;
    }
    let chat = chat.filter(|chat| {
        origin.kind == OriginKind::ChatCommand
            && is_login(&chat.login)
            && !chat.message.is_empty()
            && utf16(&chat.message) <= 2000
            && chat.badges.len() <= 50
    });
    let cut = |text: &str| dima_text::truncate_utf16_budget(text, 80).to_owned();
    let chat = chat.map(|chat| ChatActor {
        login: chat.login,
        message: chat.message,
        badges: chat
            .badges
            .iter()
            .map(|(set_id, id, info)| (cut(set_id), cut(id), cut(info)))
            .collect(),
    });
    Some(Effect::new(EffectAuthority {
        channel_id,
        origin: Arc::new(origin),
        actor: Arc::new(EffectActor {
            user_id: actor_id,
            display_name: actor_name,
            chat,
        }),
        path: Vec::new(),
        counters: Mutex::new(Counters::default()),
        signals: Arc::new(AtomicU32::new(0)),
    }))
}

/// The authority behind `effect`, when this module minted it.
pub fn authority(effect: Option<&Effect>) -> Option<&EffectAuthority> {
    effect.and_then(Effect::downcast_ref::<EffectAuthority>)
}

/// `scopeAstEffectContext(effect, channelId, configId)`: the authority for the stored
/// configuration `config_id` of `channel_id`, or `None` when there is none, it belongs to
/// another channel, or the configuration id is empty.
pub fn scope_effect(effect: Option<&Effect>, channel_id: &str, config_id: &str) -> Option<Effect> {
    let state = authority(effect)?;
    if state.channel_id != channel_id || config_id.is_empty() {
        return None;
    }
    let mut path = state.path.clone();
    path.push(config_id.to_owned());
    Some(state.derive(path))
}

/// `forkAstEffectContext(effect)`: a branch for a command reference (`reference:<n>`), taken
/// while the reference is evaluated; `None` when there is no authority or it was never scoped.
pub fn fork_effect(effect: &Effect) -> Option<Effect> {
    let state = authority(Some(effect))?;
    if state.path.is_empty() {
        return None;
    }
    let n = {
        let mut counters = state.counters();
        let n = counters.next;
        counters.next = n.saturating_add(1);
        n
    };
    let mut path = state.path.clone();
    path.push(format!("reference:{n}"));
    Some(state.derive(path))
}

/// `Number.isSafeInteger` of a counter.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

fn action_key(prefix: &str, parts: Value) -> String {
    let text = dima_text::to_js_json(&parts);
    format!("{prefix}:v1:{}", dima_core::crypto::sha256(text).hex())
}

/// What a pet, goal or widget action records about its provenance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionProvenance {
    /// `origin`, copied.
    pub origin: EffectOrigin,
    /// `actor`, copied.
    pub actor: EffectActor,
    /// The de-duplication key.
    pub action_key: String,
}

fn usable<'a>(effect: Option<&'a Effect>, channel_id: &str) -> Option<&'a EffectAuthority> {
    authority(effect).filter(|state| state.channel_id == channel_id && !state.path.is_empty())
}

/// `nextPetAction(effect, channelId)`: the next pet action's provenance and key
/// (`pet:v1:<sha256 of [path, n]>`).
pub fn next_pet_action(effect: Option<&Effect>, channel_id: &str) -> Option<ActionProvenance> {
    let state = usable(effect, channel_id)?;
    let n = {
        let mut counters = state.counters();
        if counters.next > MAX_SAFE_INTEGER {
            return None;
        }
        let n = counters.next;
        counters.next += 1;
        n
    };
    Some(ActionProvenance {
        origin: (*state.origin).clone(),
        actor: (*state.actor).clone(),
        action_key: action_key("pet", json!([state.path, n])),
    })
}

/// A goal contribution's provenance (`nextGoalContribution`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GoalProvenance {
    /// Origin, actor and `goal:v1:<sha256 of [path, n]>`.
    pub action: ActionProvenance,
    /// Whether the run comes from a stored EventSub configuration (`eventsub:` first in the
    /// path): such a contribution must be journaled or the event retried.
    pub eventsub_config: bool,
}

/// `nextGoalContribution(effect, channelId)`, which does not move the pet counter.
pub fn next_goal_contribution(effect: Option<&Effect>, channel_id: &str) -> Option<GoalProvenance> {
    let state = usable(effect, channel_id)?;
    let n = {
        let mut counters = state.counters();
        if counters.goal_next > MAX_SAFE_INTEGER {
            return None;
        }
        let n = counters.goal_next;
        counters.goal_next += 1;
        n
    };
    Some(GoalProvenance {
        action: ActionProvenance {
            origin: (*state.origin).clone(),
            actor: (*state.actor).clone(),
            action_key: action_key("goal", json!([state.path, n])),
        },
        eventsub_config: state
            .path
            .first()
            .is_some_and(|first| first.starts_with("eventsub:")),
    })
}

/// What [`next_widget_signal`] answers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WidgetSignal {
    /// The signal may go: its provenance and `signal:v1:<sha256 of [origin id, path, n]>`.
    Allowed(ActionProvenance),
    /// The run (references included) already sent [`WIDGET_SIGNALS_PER_RUN`].
    Limit,
}

/// `nextWidgetSignal(effect, channelId)`.
pub fn next_widget_signal(effect: Option<&Effect>, channel_id: &str) -> Option<WidgetSignal> {
    let state = usable(effect, channel_id)?;
    let mut counters = state.counters();
    if counters.signal_next > MAX_SAFE_INTEGER {
        return None;
    }
    let taken = state
        .signals
        .try_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
            (used < WIDGET_SIGNALS_PER_RUN).then_some(used + 1)
        });
    if taken.is_err() {
        return Some(WidgetSignal::Limit);
    }
    let n = counters.signal_next;
    counters.signal_next += 1;
    drop(counters);
    Some(WidgetSignal::Allowed(ActionProvenance {
        origin: (*state.origin).clone(),
        actor: (*state.actor).clone(),
        action_key: action_key("signal", json!([state.origin.id, state.path, n])),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(kind: OriginKind) -> EffectInput {
        EffectInput {
            channel_id: "1001".into(),
            origin: EffectOrigin {
                kind,
                id: "msg-1".into(),
                occurred_at: "2026-11-12T09:30:00.123Z".into(),
            },
            actor_id: "5001".into(),
            actor_name: "ViewerOne".into(),
            chat: Some(ChatActor {
                login: "viewerone".into(),
                message: "!hola 👋".into(),
                badges: vec![("subscriber".into(), "12".into(), "16".into())],
            }),
        }
    }

    /// Keys computed by Node for the same arrays (`createHash('sha256').update(JSON.stringify(x))
    /// .digest('hex')`), written here from the reference's formula.
    #[test]
    fn keys_hash_the_reference_json() {
        let effect = twitch_effect(input(OriginKind::ChatCommand)).unwrap();
        let scoped = scope_effect(Some(&effect), "1001", "command:abc").unwrap();
        let pet = next_pet_action(Some(&scoped), "1001").unwrap();
        let expected = dima_core::crypto::sha256(r#"[["command:abc"],0]"#).hex();
        assert_eq!(pet.action_key, format!("pet:v1:{expected}"));
        let second = next_pet_action(Some(&scoped), "1001").unwrap();
        let expected = dima_core::crypto::sha256(r#"[["command:abc"],1]"#).hex();
        assert_eq!(second.action_key, format!("pet:v1:{expected}"));
        let goal = next_goal_contribution(Some(&scoped), "1001").unwrap();
        let expected = dima_core::crypto::sha256(r#"[["command:abc"],0]"#).hex();
        assert_eq!(goal.action.action_key, format!("goal:v1:{expected}"));
        assert!(!goal.eventsub_config);
        let Some(WidgetSignal::Allowed(signal)) = next_widget_signal(Some(&scoped), "1001") else {
            panic!("allowed")
        };
        let expected = dima_core::crypto::sha256(r#"["msg-1",["command:abc"],0]"#).hex();
        assert_eq!(signal.action_key, format!("signal:v1:{expected}"));
        assert_eq!(
            signal.actor.to_json(),
            json!({"userId":"5001","displayName":"ViewerOne","chat":{"login":"viewerone","message":"!hola 👋","badges":[{"set_id":"subscriber","id":"12","info":"16"}]}})
        );
    }

    #[test]
    fn unscoped_authority_has_no_actions_and_no_fork() {
        let effect = twitch_effect(input(OriginKind::TwitchEvent)).unwrap();
        assert!(next_pet_action(Some(&effect), "1001").is_none());
        assert!(fork_effect(&effect).is_none());
        // A twitch-event origin never keeps the chat actor.
        assert_eq!(authority(Some(&effect)).unwrap().actor().chat, None);
        // Another channel, or an empty configuration id: none.
        assert!(scope_effect(Some(&effect), "1002", "command:x").is_none());
        assert!(scope_effect(Some(&effect), "1001", "").is_none());
        assert!(scope_effect(None, "1001", "command:x").is_none());
    }

    #[test]
    fn forks_number_the_references_of_one_run_and_share_the_signal_budget() {
        let effect = twitch_effect(input(OriginKind::ChatCommand)).unwrap();
        let scoped = scope_effect(Some(&effect), "1001", "eventsub:9:channel.follow").unwrap();
        let first = fork_effect(&scoped).unwrap();
        let second = fork_effect(&scoped).unwrap();
        assert_eq!(
            authority(Some(&first)).unwrap().path(),
            ["eventsub:9:channel.follow", "reference:0"]
        );
        assert_eq!(
            authority(Some(&second)).unwrap().path(),
            ["eventsub:9:channel.follow", "reference:1"]
        );
        assert!(
            next_goal_contribution(Some(&first), "1001")
                .unwrap()
                .eventsub_config
        );
        let mut allowed = 0;
        for effect in [&scoped, &first, &second, &scoped, &first, &second] {
            if let Some(WidgetSignal::Allowed(_)) = next_widget_signal(Some(effect), "1001") {
                allowed += 1;
            }
        }
        assert_eq!(allowed, WIDGET_SIGNALS_PER_RUN);
        assert_eq!(
            next_widget_signal(Some(&second), "1001"),
            Some(WidgetSignal::Limit)
        );
    }

    #[test]
    fn minting_checks_the_input() {
        let mut bad = input(OriginKind::ChatCommand);
        bad.channel_id = "12a".into();
        assert!(twitch_effect(bad).is_none());
        let mut bad = input(OriginKind::ChatCommand);
        bad.origin.occurred_at = "yesterday".into();
        assert!(twitch_effect(bad).is_none());
        let mut bad = input(OriginKind::ChatCommand);
        bad.actor_id = "  ".into();
        assert!(twitch_effect(bad).is_none());
        let mut bad = input(OriginKind::ChatCommand);
        bad.origin.id = "x".repeat(201);
        assert!(twitch_effect(bad).is_none());
        // A chat actor with an invalid login is dropped, the authority kept.
        let mut odd = input(OriginKind::ChatCommand);
        if let Some(chat) = odd.chat.as_mut() {
            chat.login = "not a login".into();
        }
        let effect = twitch_effect(odd).unwrap();
        assert_eq!(authority(Some(&effect)).unwrap().actor().chat, None);
        // Badge texts are cut to 80 UTF-16 units, never inside a character.
        let mut long = input(OriginKind::ChatCommand);
        if let Some(chat) = long.chat.as_mut() {
            chat.badges = vec![(
                format!("{}😀", "a".repeat(79)),
                String::new(),
                String::new(),
            )];
        }
        let effect = twitch_effect(long).unwrap();
        let chat = authority(Some(&effect))
            .unwrap()
            .actor()
            .chat
            .clone()
            .unwrap();
        assert_eq!(chat.badges[0].0, "a".repeat(79));
    }
}

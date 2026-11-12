//! Fakes of the duel's outside world (Twitch's wrappers, chat, the overlay presence, the widget
//! feed), logging every call in one list, in the recorder's format: `["user", login]`,
//! `["moderators", channel, user]`, `["remove", channel, user]`, `["ban", channel, user, bot,
//! seconds, "Duel"]`, `["add", channel, user]`, `["editor", channel, login]`, `["chat",
//! channel, text]`, `["presence.get" | "presence.del", channel]`, `["event", channel, run,
//! phase]`. A step's script says what each answers; a call can also be made to hang (for kill
//! tests) until the test drops it.
#![allow(dead_code, clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bson::doc;
use dima_core::{Clock, ManualClock, Random};
use dima_features::duel::{
    ActionFailure, DuelConfig, DuelEvents, DuelModeration, DuelPhase, DuelRun, DuelService,
    OverlayPresence,
};
use dima_features::roulette::ServiceError;
use dima_http::guard::BoxFuture;
use dima_store::mongo::MongoStore;
use dima_twitch::chat::{ChatError, ChatOut, RenderScope, Rendering, Sent};
use serde_json::{Value, json};

#[derive(Default)]
pub struct State {
    pub calls: Vec<Value>,
    pub script: Value,
    pub mods: BTreeSet<String>,
    pub presence: HashMap<String, Option<String>>,
    /// A call (by its first element) that never answers.
    pub hang: Option<String>,
}

#[derive(Clone)]
pub struct Shared {
    pub state: Arc<Mutex<State>>,
    pub mongo: MongoStore,
}

impl Shared {
    fn log(&self, call: Value) -> bool {
        let mut state = self.state.lock().unwrap();
        let hangs = state.hang.as_deref() == call[0].as_str();
        state.calls.push(call);
        hangs
    }

    fn script(&self, key: &str) -> Value {
        self.state.lock().unwrap().script[key].clone()
    }
}

async fn forever() {
    loop {
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}

pub struct FakeModeration(pub Shared);

impl DuelModeration for FakeModeration {
    fn is_editor<'a>(
        &'a self,
        channel: &'a str,
        login: &'a str,
    ) -> BoxFuture<'a, Result<bool, String>> {
        Box::pin(async move {
            if self.0.log(json!(["editor", channel, login])) {
                forever().await;
            }
            let editors = self.0.script("editors");
            Ok(editors
                .as_array()
                .is_some_and(|e| e.iter().any(|x| x.as_str() == Some(&login.to_lowercase()))))
        })
    }

    fn user_id<'a>(&'a self, login: &'a str) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            if self.0.log(json!(["user", login])) {
                forever().await;
            }
            self.0.script("users")[login]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "User not found".to_owned())
        })
    }

    fn is_moderator<'a>(
        &'a self,
        channel: &'a str,
        user: &'a str,
    ) -> BoxFuture<'a, Result<bool, String>> {
        Box::pin(async move {
            if self.0.log(json!(["moderators", channel, user])) {
                forever().await;
            }
            if self.0.script("moderatorsError").as_bool() == Some(true) {
                return Err("moderators failed".into());
            }
            Ok(self.0.state.lock().unwrap().mods.contains(user))
        })
    }

    fn remove_moderator<'a>(
        &'a self,
        channel: &'a str,
        user: &'a str,
    ) -> BoxFuture<'a, Result<(), ActionFailure>> {
        Box::pin(async move {
            let hangs = self.0.log(json!(["remove", channel, user]));
            if self.0.script("disableOnRemove").as_bool() == Some(true) {
                self.0
                    .mongo
                    .documents("duel_widgets")
                    .update_one(
                        doc! {"_id": channel},
                        doc! {"$set": {"settings.timeoutEnabled": false}},
                    )
                    .await
                    .unwrap();
            }
            if self.0.script("remove").as_str() == Some("error") {
                return Err(ActionFailure {
                    message: "remove failed".into(),
                    outcome_unknown: false,
                });
            }
            // Twitch applies the demotion; the answer may still be lost.
            self.0.state.lock().unwrap().mods.remove(user);
            if hangs {
                forever().await;
            }
            Ok(())
        })
    }

    fn timeout<'a>(
        &'a self,
        channel: &'a str,
        user: &'a str,
        seconds: f64,
    ) -> BoxFuture<'a, Result<(), ActionFailure>> {
        Box::pin(async move {
            let hangs = self.0.log(json!([
                "ban",
                channel,
                user,
                dima_twitch::TWITCH_BOT_ACCOUNT_ID,
                seconds,
                "Duel"
            ]));
            if hangs {
                forever().await;
            }
            if self.0.script("ban").as_str() == Some("error") {
                return Err(ActionFailure {
                    message: "ban failed".into(),
                    outcome_unknown: false,
                });
            }
            Ok(())
        })
    }

    fn add_moderator<'a>(
        &'a self,
        channel: &'a str,
        user: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let hangs = self.0.log(json!(["add", channel, user]));
            if self.0.script("add").as_str() == Some("error") {
                return Err("add failed".into());
            }
            self.0.state.lock().unwrap().mods.insert(user.to_owned());
            if hangs {
                forever().await;
            }
            Ok(())
        })
    }
}

pub struct FakeChat(pub Shared);

impl ChatOut for FakeChat {
    fn send<'a>(
        &'a self,
        scope: &'a RenderScope,
        text: &'a str,
    ) -> BoxFuture<'a, Result<Sent, ChatError>> {
        Box::pin(async move {
            assert!(scope.render.is_none(), "duel posts are plain");
            if self.0.log(json!(["chat", scope.channel_id, text])) {
                forever().await;
            }
            if self.0.script("chat").as_str() == Some("error") {
                return Err(ChatError::Rejected {
                    status: 500,
                    kind: None,
                    message: Some("chat failed".into()),
                });
            }
            Ok(Sent::Posted { message_id: None })
        })
    }

    fn deliver<'a>(
        &'a self,
        _: &'a str,
        _: Option<&'a Rendering>,
        _: &'a str,
    ) -> BoxFuture<'a, Result<(), ChatError>> {
        Box::pin(async { panic!("the duel never delivers command language") })
    }
}

pub struct FakePresence(pub Shared);

impl OverlayPresence for FakePresence {
    fn get<'a>(&'a self, channel: &'a str) -> BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(async move {
            self.0.log(json!(["presence.get", channel]));
            Ok(self
                .0
                .state
                .lock()
                .unwrap()
                .presence
                .get(channel)
                .cloned()
                .flatten())
        })
    }

    fn clear<'a>(&'a self, channel: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.0.log(json!(["presence.del", channel]));
            self.0
                .state
                .lock()
                .unwrap()
                .presence
                .insert(channel.to_owned(), None);
            Ok(())
        })
    }
}

pub struct FakeEvents(pub Shared);

impl DuelEvents for FakeEvents {
    fn duel(&self, channel: &str, run: &DuelRun, phase: DuelPhase) {
        let phase = match phase {
            DuelPhase::Started => "started",
            DuelPhase::Ended => "ended",
        };
        self.0.log(json!(["event", channel, run.id, phase]));
    }
}

pub struct Fakes {
    pub shared: Shared,
    pub moderation: Arc<FakeModeration>,
    pub chat: Arc<FakeChat>,
    pub presence: Arc<FakePresence>,
    pub events: Arc<FakeEvents>,
}

impl Fakes {
    pub fn new(mongo: MongoStore) -> Self {
        let shared = Shared {
            state: Arc::new(Mutex::new(State::default())),
            mongo,
        };
        Self {
            moderation: Arc::new(FakeModeration(shared.clone())),
            chat: Arc::new(FakeChat(shared.clone())),
            presence: Arc::new(FakePresence(shared.clone())),
            events: Arc::new(FakeEvents(shared.clone())),
            shared,
        }
    }

    pub fn service(
        &self,
        mongo: &MongoStore,
        clock: &ManualClock,
        random: Arc<dyn Random>,
    ) -> DuelService {
        self.service_with(mongo, Arc::new(clock.clone()), random)
    }

    pub fn service_with(
        &self,
        mongo: &MongoStore,
        clock: Arc<dyn Clock>,
        random: Arc<dyn Random>,
    ) -> DuelService {
        DuelService::new(
            mongo.clone(),
            clock,
            random,
            self.presence.clone(),
            self.events.clone(),
            DuelConfig {
                deadline: Duration::from_secs(60),
                twitch_deadline: Duration::from_secs(60),
                bot_id: dima_twitch::TWITCH_BOT_ACCOUNT_ID.into(),
            },
        )
    }

    /// Applies a step's script as the recorder does.
    pub fn prepare(&self, script: &Value) {
        let mut state = self.shared.state.lock().unwrap();
        state.calls.clear();
        state.script = script.clone();
        if let Some(presence) = script["presence"].as_object() {
            for (channel, value) in presence {
                let stored = (!value.is_null()).then(|| dima_text::to_js_json(value));
                state.presence.insert(channel.clone(), stored);
            }
        }
        if let Some(mods) = script["mods"].as_array() {
            state.mods = mods
                .iter()
                .filter_map(|m| m.as_str().map(str::to_owned))
                .collect();
        }
    }

    pub fn take_calls(&self) -> Vec<Value> {
        std::mem::take(&mut self.shared.state.lock().unwrap().calls)
    }

    pub fn mods(&self) -> Vec<String> {
        self.shared
            .state
            .lock()
            .unwrap()
            .mods
            .iter()
            .cloned()
            .collect()
    }
}

pub fn failure(error: ServiceError) -> Value {
    match error {
        ServiceError::Refused(e) => {
            json!({"error": {"code": e.code, "message": e.message, "status": e.status}})
        }
        ServiceError::Store { message, .. } => json!({"thrown": message}),
    }
}

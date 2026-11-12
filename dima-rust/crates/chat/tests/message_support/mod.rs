//! The harness of the message handler's store-backed tests: the local MongoDB and Dragonfly from
//! `tools/test-env`, a throwaway `dima_test_chat_<random>` database dropped even when a test fails,
//! Dragonfly logical database 11 with a unique key prefix removed afterwards, a Twitch mock on
//! `dima_http::testing::MockServer` (the app token and `POST /helix/chat/messages`), recording
//! fakes for every seam (moderation, the AI, built-ins, the widget feed, the site counter, product
//! events, the embedding queue) with the recorder's shapes, and the runtime the engine's stack
//! contract needs. Without the stores a test skips with a notice, unless
//! `DIMA_TEST_REQUIRE_STORES=1` (then it fails).
#![allow(dead_code, clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use anyhow::{Context as _, Result, bail};
use bson::{Bson, Document, doc};
use dima_actions::delivery::{ChatDelivery, DeliveryConfig};
use dima_actions::host::{HostDeps, StorageConfig, channel, media, moderation};
use dima_actions::metrics::{BotMetrics, MetricsConfig};
use dima_actions::product_events::CommandEvent;
use dima_actions::timers::TimerQueue;
use dima_ai::qdrant::{ChatEmbeddingQueue, Observer, QueuedChatMessage};
use dima_chat::ingress::{ChatEffectInput, HandlerOptions, Notification};
use dima_chat::message::seams::{
    AiChatRequest, AiError, AiPersonality, AiReply, AssistantTurn, BuiltinCall, BuiltinCommands,
    BuiltinError, BuiltinReply, ChatModeration, CommandTracker, HistoryLine, LegacyTags,
    ModerationInput, ModerationVerdict, PollAction, PredictionAction, SiteCounters, ThreadRequest,
    ThreadResolution, WidgetChatFeed,
};
use dima_chat::message::{KeywordCache, MessageConfig, MessageDeps, MessageHandler};
use dima_commands::keywords::SharedKeywordLoader;
use dima_commands::permissions::UserIdentity;
use dima_commands::runtime::KeyPrefix;
use dima_commands::runtime::keyword_store::{KeywordStoreConfig, StoreKeywordStorage};
use dima_commands::runtime::lookup::{CommandCache, CommandCacheConfig};
use dima_core::crypto::CredentialCipher;
use dima_core::{Clock, ManualClock, Random, SecretString, SeededRandom, Shutdown, SystemRandom};
use dima_engine::eval::Engine;
use dima_engine::registry::Registry;
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer, RecordedRequest};
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Hooks};
use dima_store::mongo::{MongoConfig, MongoStore};
use dima_stream::stream_activity::{Activities, Config as ActivityConfig};
use dima_stream::stream_sessions::StreamSessions;
use dima_twitch::events::RecordingEvents;
use dima_twitch::{KeySpace, Twitch, TwitchConfig, TwitchDeps};
use futures_util::future::BoxFuture;
use futures_util::{FutureExt, TryStreamExt};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const CLIENT_ID: &str = "test-client-id";
pub const CLIENT_SECRET: &str = "test-client-secret-value";
pub const TEST_SECRET_KEY: &str = "dima-chat-test-key";
/// The logical database the tests write.
pub const DATABASE: u8 = 11;
/// 2030-01-01T09:30:00.123Z: the recorder's frozen time.
pub const NOW_MS: i64 = 1_893_490_200_123;
/// The stack of every thread a test evaluates on.
pub const TEST_STACK: usize = 4 * 1024 * 1024;

pub fn stores_required() -> bool {
    std::env::var("DIMA_TEST_REQUIRE_STORES").is_ok_and(|value| value == "1")
}

fn missing<T>(what: &str) -> Result<Option<T>> {
    if stores_required() {
        bail!("{what} (DIMA_TEST_REQUIRE_STORES=1: a missing store fails the test)");
    }
    eprintln!("skipped: {what}");
    Ok(None)
}

pub fn random_suffix() -> String {
    let mut bytes = [0_u8; 6];
    let _ = SystemRandom.fill(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Runs `future` on a multi-threaded runtime whose threads (and the one that waits) are
/// registered with the engine's stack contract.
pub fn run<F>(future: F) -> F::Output
where
    F: Future + Send,
    F::Output: Send,
{
    dima_engine::stack::run_on_thread(TEST_STACK, || {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .thread_stack_size(TEST_STACK)
            .on_thread_start(|| dima_engine::stack::register_thread(TEST_STACK))
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(future)
    })
    .expect("a test thread")
}

pub async fn connect_dragonfly(database: u8) -> Result<Option<Dragonfly>> {
    let Ok(address) = std::env::var("DIMA_TEST_DRAGONFLY") else {
        return missing("DIMA_TEST_DRAGONFLY is not set (eval \"$(dima-rust/tools/test-env)\")");
    };
    let (host, port) = address
        .rsplit_once(':')
        .context("DIMA_TEST_DRAGONFLY is host:port")?;
    let config = DragonflyConfig::from_env_values(
        Some(host),
        Some(&format!("{port}/{database}")),
        "dima-chat-message-tests",
    );
    match Dragonfly::connect(config, Hooks::default()).await {
        Ok(dragonfly) => Ok(Some(dragonfly)),
        Err(error) => missing(&format!("the local Dragonfly cannot be reached: {error}")),
    }
}

pub async fn connect_mongo(database: &str) -> Result<Option<MongoStore>> {
    let Ok(uri) = std::env::var("DIMA_TEST_MONGO_URI") else {
        return missing("DIMA_TEST_MONGO_URI is not set (eval \"$(dima-rust/tools/test-env)\")");
    };
    let mut config = MongoConfig::new(uri);
    config.database = Some(database.to_owned());
    match MongoStore::connect(&config, None).await {
        Ok(store) => Ok(Some(store)),
        Err(error) => missing(&format!("the local MongoDB cannot be reached: {error}")),
    }
}

/// Deletes every key under `prefix`.
pub async fn clean_prefix(dragonfly: &Dragonfly, prefix: &str) -> Result<()> {
    let mut scan = dragonfly.scan(&format!("{prefix}*"), Some(500));
    while let Some(page) = scan.next_page().await? {
        for key in page {
            let key = String::from_utf8(key)?;
            dragonfly.del(&[&key]).await?;
        }
    }
    Ok(())
}

/// The stores of one test.
#[derive(Clone)]
pub struct Stores {
    pub mongo: MongoStore,
    pub dragonfly: Dragonfly,
    pub prefix: String,
    pub database: String,
}

impl Stores {
    /// `prefix + key`.
    pub fn key(&self, key: &str) -> String {
        format!("{}{key}", self.prefix)
    }
}

/// Runs `test` with fresh stores, then drops the database and the keys, whatever the outcome.
pub async fn with_stores<F, Fut>(test: F) -> Result<()>
where
    F: FnOnce(Stores) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let suffix = random_suffix();
    let database = format!("dima_test_chat_{suffix}");
    let Some(mongo) = connect_mongo(&database).await? else {
        return Ok(());
    };
    let Some(dragonfly) = connect_dragonfly(DATABASE).await? else {
        return Ok(());
    };
    let prefix = format!("dtcm{suffix}:");
    let stores = Stores {
        mongo: mongo.clone(),
        dragonfly: dragonfly.clone(),
        prefix: prefix.clone(),
        database,
    };
    let outcome = AssertUnwindSafe(test(stores)).catch_unwind().await;
    let dropped = mongo.database().drop().await;
    let cleaned = clean_prefix(&dragonfly, &prefix).await;
    match outcome {
        Ok(result) => {
            dropped.context("dropping the test database")?;
            cleaned.context("cleaning the test keys")?;
            result
        }
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

/// One chat post the mock received.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Post {
    pub channel: String,
    pub text: String,
    pub reply_to: Option<String>,
}

/// The Twitch mock: an app token, and chat posts recorded in order. `delay` holds every chat
/// post that long (a slow Twitch); `block` holds the posts of one channel until released.
#[derive(Clone)]
pub struct TwitchMock {
    pub server: Arc<MockServer>,
}

impl TwitchMock {
    pub async fn start() -> Result<Self> {
        let server = MockServer::start().await?;
        let posted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        server.fallback(move |request: &RecordedRequest| {
            if request.path() == "/oauth2/token" {
                return MockResponse::json(
                    200,
                    r#"{"access_token":"app-token-1","expires_in":5011271,"token_type":"bearer"}"#,
                );
            }
            if request.path() == "/helix/chat/messages" && request.method == "POST" {
                let n = posted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                return MockResponse::json(
                    200,
                    &json!({"data": [{"message_id": format!("msg-{n}"), "is_sent": true}]})
                        .to_string(),
                );
            }
            MockResponse::json(
                404,
                r#"{"error":"Not Found","status":404,"message":"unexpected"}"#,
            )
        });
        Ok(Self {
            server: Arc::new(server),
        })
    }

    /// Every chat post so far, in order.
    pub fn posts(&self) -> Vec<Post> {
        self.server
            .requests()
            .into_iter()
            .filter(|request| request.path() == "/helix/chat/messages")
            .map(|request| {
                let body: Value = serde_json::from_slice(&request.body).expect("JSON body");
                Post {
                    channel: body["broadcaster_id"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    text: body["message"].as_str().unwrap_or_default().to_owned(),
                    reply_to: body["reply_parent_message_id"].as_str().map(str::to_owned),
                }
            })
            .collect()
    }

    /// Requests other than the token and chat posts (none is expected).
    pub fn unexpected(&self) -> Vec<String> {
        self.server
            .requests()
            .into_iter()
            .filter(|request| !matches!(request.path(), "/oauth2/token" | "/helix/chat/messages"))
            .map(|request| format!("{} {}", request.method, request.target))
            .collect()
    }
}

pub fn cipher() -> CredentialCipher {
    CredentialCipher::new(TEST_SECRET_KEY).expect("test key")
}

/// The media group's request surface, never called.
pub struct NoBackend;

impl dima_twitch::functions::chats::speech::BackendApi for NoBackend {
    fn request(
        &self,
        _request: dima_twitch::functions::chats::speech::BackendRequest,
    ) -> dima_http::guard::BoxFuture<
        '_,
        Result<
            dima_twitch::functions::chats::speech::BackendReply,
            dima_twitch::functions::chats::speech::BackendError,
        >,
    > {
        Box::pin(async { Err(dima_twitch::functions::chats::speech::BackendError) })
    }
}

impl dima_twitch::functions::clips::ClipPublisher for NoBackend {
    fn publish<'a>(
        &'a self,
        _channel: &'a str,
        _data: &'a dima_twitch::functions::clips::ClipRequestData,
    ) -> dima_http::guard::BoxFuture<'a, Result<(), dima_twitch::functions::clips::ClipPublishError>>
    {
        Box::pin(async { Err(dima_twitch::functions::clips::ClipPublishError) })
    }
}

// ---------------------------------------------------------------------------------------------
// The recording fakes, with the recorder's shapes.

/// Calls by kind, in order.
#[derive(Clone, Default)]
pub struct Calls(Arc<Mutex<Vec<(String, Value)>>>);

impl Calls {
    pub fn push(&self, kind: &str, value: Value) {
        self.0.lock().expect("calls").push((kind.to_owned(), value));
    }

    pub fn by_kind(&self) -> BTreeMap<String, Vec<Value>> {
        let mut map: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for (kind, value) in self.0.lock().expect("calls").iter() {
            map.entry(kind.clone()).or_default().push(value.clone());
        }
        map
    }

    pub fn count(&self, kind: &str) -> usize {
        self.0
            .lock()
            .expect("calls")
            .iter()
            .filter(|(k, _)| k == kind)
            .count()
    }
}

/// A number as JavaScript prints it in JSON (integral values without a fraction).
pub fn num(value: f64) -> Value {
    dima_text::js_number_value(value)
}

fn identity_json(identity: &UserIdentity) -> Value {
    let mut tags: Vec<&str> = identity.tags().iter().map(|tag| tag.as_str()).collect();
    tags.sort_unstable();
    json!({"level": num(identity.level()), "tags": tags,
        "userId": identity.user_id(), "login": identity.login()})
}

/// What moderation answers, and when.
#[derive(Clone)]
pub struct FakeModeration {
    pub calls: Calls,
    pub verdict: ModerationVerdict,
    /// The messages of this channel wait for a permit (ordering and limit tests).
    pub gate: Option<(String, Arc<tokio::sync::Semaphore>)>,
}

impl ChatModeration for FakeModeration {
    fn moderate<'a>(&'a self, input: ModerationInput<'a>) -> BoxFuture<'a, ModerationVerdict> {
        Box::pin(async move {
            self.calls.push(
                "moderation",
                json!({"channelID": input.channel_id, "messageID": input.message.message_id,
                    "identity": identity_json(input.identity), "receivedAt": input.received_at_ms}),
            );
            if let Some((channel, gate)) = &self.gate
                && channel == input.channel_id
            {
                let _ = gate.acquire().await.map(|permit| permit.forget());
            }
            self.verdict
        })
    }
}

fn history_json(lines: &[HistoryLine]) -> Value {
    Value::Array(
        lines
            .iter()
            .map(|line| {
                let mut object = Map::new();
                object.insert("timestamp".into(), json!(line.timestamp));
                if let Some(badges) = &line.badges {
                    object.insert("badges".into(), json!(badges));
                }
                object.insert("username".into(), json!(line.username));
                object.insert("message".into(), json!(line.message));
                Value::Object(object)
            })
            .collect(),
    )
}

/// The recorder's AI configuration: `{personality, thread, answer}`.
#[derive(Clone, Default)]
pub struct FakeAi {
    pub calls: Calls,
    pub config: Value,
}

impl AiReply for FakeAi {
    fn personality<'a>(
        &'a self,
        channel_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<AiPersonality>, AiError>> {
        Box::pin(async move {
            self.calls
                .push("ai.personality", json!({"channelID": channel_id}));
            let personality = match self.config.get("personality") {
                None => Some(json!({"enabled": false})),
                Some(Value::Null) => None,
                Some(value) => Some(value.clone()),
            };
            Ok(personality.map(|value| AiPersonality {
                enabled: value.get("enabled").and_then(Value::as_bool),
                context_window: value.get("contextWindow").and_then(Value::as_i64),
            }))
        })
    }

    fn resolve_thread<'a>(
        &'a self,
        request: ThreadRequest<'a>,
    ) -> BoxFuture<'a, Result<ThreadResolution, AiError>> {
        Box::pin(async move {
            self.calls.push(
                "ai.thread",
                json!({"channelID": request.channel_id, "userID": request.user_id,
                    "username": request.username, "message": request.message,
                    "planTier": request.plan_tier, "sourceMessageId": request.source_message_id}),
            );
            let thread = self.config.get("thread").cloned().unwrap_or(Value::Null);
            Ok(ThreadResolution {
                thread_id: thread
                    .get("threadID")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                prompt_context: thread
                    .get("promptContext")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .map(|item| HistoryLine {
                                timestamp: item["timestamp"].as_i64().unwrap_or_default(),
                                badges: item
                                    .get("badges")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned),
                                username: item["username"].as_str().unwrap_or_default().to_owned(),
                                message: item["message"].as_str().unwrap_or_default().to_owned(),
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
    }

    fn chat<'a>(&'a self, request: AiChatRequest<'a>) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            let badges: Vec<Value> = request
                .badges
                .iter()
                .map(|b| json!({"set_id": b.set_id, "id": b.id, "info": b.info}))
                .collect();
            self.calls.push(
                "ai.chat",
                json!({"channelID": request.channel_id, "message": request.message,
                    "streamer": request.streamer_name, "history": history_json(&request.history),
                    "threadHistory": history_json(&request.thread_history),
                    "tags": {"badges": badges, "username": request.username,
                        "chatter_user_id": request.chatter_user_id, "userLevel": num(request.user_level)}}),
            );
            let answer = self.config.get("answer").cloned().unwrap_or(Value::Null);
            if answer.get("error").and_then(Value::as_bool).unwrap_or(true) {
                return None;
            }
            answer
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
    }

    fn append_assistant_turn<'a>(
        &'a self,
        turn: AssistantTurn<'a>,
    ) -> BoxFuture<'a, Result<(), AiError>> {
        Box::pin(async move {
            self.calls.push(
                "ai.append",
                json!({"channelID": turn.channel_id, "threadID": turn.thread_id, "message": turn.message,
                    "planTier": turn.plan_tier, "sourceMessageId": turn.source_message_id,
                    "delivered": turn.delivered}),
            );
            Ok(())
        })
    }
}

fn tags_json(tags: &LegacyTags) -> Value {
    json!({"id": tags.user_id, "username": tags.username, "display-name": tags.display_name,
        "user-id": tags.user_id, "mod": tags.is_mod})
}

/// A built-in call as the reference calls its function: `(function, positional arguments)`.
pub fn builtin_json(channel: &str, call: &BuiltinCall) -> (String, Value) {
    const MOD_ID: &str = "698614112";
    let args = match call {
        BuiltinCall::Sumimetro {
            login,
            argument,
            command,
        } => json!([channel, login, argument, command]),
        BuiltinCall::Promo { streamer } => json!([channel, streamer, true]),
        BuiltinCall::Shoutout { target } => json!([channel, target, "purple", MOD_ID, true]),
        BuiltinCall::Announcement { sender_id, text } => json!([channel, sender_id, text]),
        BuiltinCall::Ruletarusa { login, is_mod } => json!([channel, login, is_mod]),
        BuiltinCall::Amor { tags, target } => json!([tags_json(tags), target]),
        BuiltinCall::DisableCommand { name } | BuiltinCall::EnableCommand { name } => {
            json!([channel, name])
        }
        BuiltinCall::CreateCommand { argument } => json!([channel, argument]),
        BuiltinCall::DeleteCommand {
            argument,
            user_level,
        }
        | BuiltinCall::EditCommand {
            argument,
            user_level,
        } => json!([channel, argument, num(*user_level)]),
        BuiltinCall::ClearChat { moderator_id } => json!([channel, moderator_id]),
        BuiltinCall::CommandList { identity } => {
            json!([channel, {"level": num(identity.level()), "tags": {},
            "userId": identity.user_id(), "login": identity.login()}])
        }
        BuiltinCall::Followage { login } => json!([channel, login]),
        BuiltinCall::Title {
            argument,
            user_level,
            command_level,
            tag_mode,
        }
        | BuiltinCall::Game {
            argument,
            user_level,
            command_level,
            tag_mode,
        } => {
            json!([
                channel,
                argument,
                num(*user_level),
                num(*command_level),
                tag_mode
            ])
        }
        BuiltinCall::AddModerator { target } | BuiltinCall::RemoveModerator { target } => {
            json!([channel, target])
        }
        BuiltinCall::CreateClip { argument } | BuiltinCall::OnlyEmotes { argument } => {
            json!([channel, argument])
        }
        BuiltinCall::Vanish { tags } => json!([channel, tags_json(tags), MOD_ID]),
        BuiltinCall::Duel {
            login,
            is_mod,
            argument,
        } => json!([channel, login, is_mod, argument, MOD_ID]),
        BuiltinCall::AddVip { argument, tags } => json!([channel, argument, tags_json(tags)]),
        BuiltinCall::RemoveVip { target } => json!([channel, target]),
        BuiltinCall::Poll { action, argument } => {
            let action = match action {
                PollAction::Create => "CREATE",
                PollAction::End => "END",
                PollAction::Archive => "ARCHIVE",
                PollAction::Terminate => "TERMINATE",
            };
            json!([action, channel, argument])
        }
        BuiltinCall::Prediction { action, argument } => {
            let action = match action {
                PredictionAction::Create => "CREATE",
                PredictionAction::Resolved => "RESOLVED",
                PredictionAction::Canceled => "CANCELED",
                PredictionAction::Locked => "LOCKED",
            };
            json!([action, channel, argument])
        }
        BuiltinCall::TimerCreate {
            name,
            frequency,
            message,
        } => json!([channel, name, num(*frequency), message]),
        BuiltinCall::TimerEdit {
            name,
            frequency,
            message,
        } => {
            json!([channel, name, frequency.map(num), message])
        }
        BuiltinCall::TimerDelete { name } => json!([channel, name]),
        BuiltinCall::TimerList => json!([channel]),
    };
    let function = match call {
        BuiltinCall::Shoutout { .. } => "handleShoutoutCommand",
        BuiltinCall::Announcement { .. } => "sendAnnouncement",
        other => other.function(),
    };
    (function.to_owned(), args)
}

/// The recorder's built-in answers: `{name: {error, message} | {throws}}`; by default
/// `{error: false, message: '<name> answered'}`.
#[derive(Clone, Default)]
pub struct FakeBuiltins {
    pub calls: Calls,
    pub answers: Value,
}

impl BuiltinCommands for FakeBuiltins {
    fn run<'a>(
        &'a self,
        channel_id: &'a str,
        call: BuiltinCall,
    ) -> BoxFuture<'a, Result<BuiltinReply, BuiltinError>> {
        Box::pin(async move {
            let (function, args) = builtin_json(channel_id, &call);
            self.calls
                .push("builtin", json!({"function": function, "args": args}));
            match self.answers.get(&function) {
                Some(answer) => {
                    if let Some(thrown) = answer.get("throws").and_then(Value::as_str) {
                        return Err(BuiltinError(thrown.to_owned()));
                    }
                    Ok(BuiltinReply {
                        error: answer
                            .get("error")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        message: answer
                            .get("message")
                            .and_then(Value::as_str)
                            .filter(|message| !message.is_empty())
                            .map(str::to_owned),
                    })
                }
                None => Ok(BuiltinReply {
                    error: false,
                    message: Some(format!("{function} answered")),
                }),
            }
        })
    }
}

/// The widget feed, the site counter, product events and the embedding queue.
#[derive(Clone, Default)]
pub struct FakeOutputs {
    pub calls: Calls,
}

impl WidgetChatFeed for FakeOutputs {
    fn publish_chat(&self, channel_id: &str, event: &Value) {
        self.calls.push(
            "feed",
            json!({"channelID": channel_id, "type": "chat", "messageID": event.get("message_id")}),
        );
    }
}

impl SiteCounters for FakeOutputs {
    fn increment<'a>(
        &'a self,
        filter: &'static str,
        value: i64,
    ) -> BoxFuture<'a, Result<(), String>> {
        self.calls
            .push("site", json!({"filter": filter, "value": value}));
        Box::pin(async { Ok(()) })
    }
}

impl CommandTracker for FakeOutputs {
    fn track_command(&self, event: &CommandEvent) {
        let mut object = Map::new();
        object.insert("channelID".into(), json!(event.channel_id));
        object.insert("channelName".into(), json!(event.channel_name));
        object.insert("command".into(), json!(event.command));
        object.insert("status".into(), json!(event.status));
        object.insert("userID".into(), json!(event.user_id));
        object.insert("username".into(), json!(event.username));
        if let Some(arguments) = &event.arguments {
            object.insert("arguments".into(), json!(arguments));
        }
        if let Some(error) = &event.error_message {
            object.insert("errorMessage".into(), json!(error));
        }
        self.calls.push("product.command", Value::Object(object));
    }
}

impl ChatEmbeddingQueue for FakeOutputs {
    fn add_message(&self, message: QueuedChatMessage) -> bool {
        self.calls.push(
            "embedding",
            json!({"channel_id": message.channel_id, "channel_name": message.channel_name,
                "message": message.text, "username": message.username, "user_id": message.user_id,
                "timestamp": num(message.timestamp)}),
        );
        true
    }
}

impl Observer for FakeOutputs {
    fn error(&self, operation: &str) {
        self.calls
            .push("embedding.refused", json!({"operation": operation}));
    }
}

// ---------------------------------------------------------------------------------------------
// The handler.

/// One process: the handler and its handles on the shared stores and mock.
pub struct Process {
    pub handler: MessageHandler,
    pub delivery: Arc<ChatDelivery>,
    pub calls: Calls,
    pub metrics: BotMetrics,
    pub metrics_prefix: String,
    pub clock: ManualClock,
    pub shutdown: Shutdown,
}

/// What the seams answer in a case.
#[derive(Clone)]
pub struct Seams {
    pub moderation: ModerationVerdict,
    pub moderation_gate: Option<(String, Arc<tokio::sync::Semaphore>)>,
    pub ai: Value,
    pub builtins: Value,
}

impl Default for Seams {
    fn default() -> Self {
        Self {
            moderation: ModerationVerdict::Pass,
            moderation_gate: None,
            ai: Value::Object(Map::new()),
            builtins: Value::Object(Map::new()),
        }
    }
}

/// Production limits with generous deadlines (a busy machine must not fail a test).
pub fn test_config() -> MessageConfig {
    MessageConfig {
        admission_wait: Duration::from_secs(120),
        message_deadline: Duration::from_secs(120),
        store_deadline: Duration::from_secs(30),
        ..MessageConfig::default()
    }
}

/// A process whose command language draws from `random`.
pub fn process(
    stores: &Stores,
    twitch: &TwitchMock,
    random: Arc<dyn Random>,
    seams: Seams,
    config: MessageConfig,
    name: &str,
) -> Result<Process> {
    let clock = ManualClock::new(NOW_MS);
    let clock_dyn: Arc<dyn Clock> = Arc::new(clock.clone());
    let shutdown = Shutdown::new();
    let mut twitch_config = TwitchConfig::new(CLIENT_ID, SecretString::from(CLIENT_SECRET));
    twitch_config.keys = KeySpace::prefixed(stores.prefix.clone());
    let helix = twitch
        .server
        .provider(dima_twitch::helix_provider(CLIENT_ID))?;
    let oauth = twitch.server.provider(dima_twitch::oauth_provider())?;
    let http = HttpClient::builder()
        .shutdown(shutdown.clone())
        .clock(Arc::clone(&clock_dyn))
        .build()?;
    let exchange_http =
        dima_twitch::exchange_client(HttpClient::builder().clock(Arc::clone(&clock_dyn)))?;
    let twitch_client = Twitch::new(
        twitch_config,
        TwitchDeps {
            http,
            exchange_http,
            helix,
            oauth,
            mongo: stores.mongo.clone(),
            dragonfly: stores.dragonfly.clone(),
            cipher: cipher(),
            clock: Arc::clone(&clock_dyn),
            random: Arc::new(SystemRandom),
            events: Arc::new(RecordingEvents::default()),
            shutdown: shutdown.clone(),
        },
    );
    let keys = KeyPrefix::new(stores.prefix.clone());
    let runtime_stores = dima_commands::runtime::Stores {
        mongo: stores.mongo.clone(),
        dragonfly: stores.dragonfly.clone(),
        keys: keys.clone(),
    };
    let commands = CommandCache::new(
        runtime_stores.clone(),
        Arc::clone(&clock_dyn),
        Arc::new(SystemRandom),
        CommandCacheConfig::default(),
    );
    let deps = Arc::new(HostDeps {
        mongo: stores.mongo.clone(),
        dragonfly: stores.dragonfly.clone(),
        keys,
        twitch: twitch_client,
        commands,
        clock: Arc::clone(&clock_dyn),
        random,
        telemetry: None,
        storage: StorageConfig::default(),
        timers: TimerQueue::new(),
        moderation: moderation::Deps::default(),
        channel: channel::Deps::default(),
        media: media::Deps {
            backend: Arc::new(NoBackend),
            clips: Arc::new(NoBackend),
        },
        ai: dima_actions::host::ai::Deps::default(),
    });
    let delivery = ChatDelivery::with_config(
        Arc::clone(&deps),
        Arc::new(Engine::new(Registry::standard(), Default::default())),
        DeliveryConfig::default(),
    );
    let calls = Calls::default();
    let outputs = Arc::new(FakeOutputs {
        calls: calls.clone(),
    });
    let storage = Arc::new(StoreKeywordStorage::new(
        runtime_stores,
        Arc::clone(&clock_dyn),
        Arc::new(SystemRandom),
        KeywordStoreConfig::default(),
    ));
    let keywords: Arc<KeywordCache> = Arc::new(KeywordCache::new(
        SharedKeywordLoader { storage },
        Arc::clone(&clock_dyn),
    ));
    let metrics_prefix = format!("{}{name}:metrics:bot", stores.prefix);
    let metrics = BotMetrics::new(
        MetricsConfig::from_env_values(None, None, Some(&metrics_prefix), None),
        stores.dragonfly.clone(),
        Arc::clone(&clock_dyn),
        None,
    );
    let handler = MessageHandler::new(
        MessageDeps {
            delivery: Arc::clone(&delivery),
            sessions: StreamSessions::new(stores.mongo.clone(), Arc::clone(&clock_dyn))?,
            activity: Activities::new(
                stores.mongo.clone(),
                Arc::clone(&clock_dyn),
                ActivityConfig::default(),
            )?,
            keywords,
            metrics: metrics.clone(),
            tracker: outputs.clone(),
            site: outputs.clone(),
            embeddings: outputs.clone(),
            embedding_observer: outputs.clone(),
            moderation: Arc::new(FakeModeration {
                calls: calls.clone(),
                verdict: seams.moderation,
                gate: seams.moderation_gate,
            }),
            ai: Arc::new(FakeAi {
                calls: calls.clone(),
                config: seams.ai,
            }),
            builtins: Arc::new(FakeBuiltins {
                calls: calls.clone(),
                answers: seams.builtins,
            }),
            feed: outputs,
        },
        config,
    );
    Ok(Process {
        handler,
        delivery,
        calls,
        metrics,
        metrics_prefix,
        clock,
        shutdown,
    })
}

impl Process {
    /// The message metrics so far: `{started, ended, failed}`.
    pub async fn message_metrics(&self, stores: &Stores) -> Result<Value> {
        self.metrics.flush().await;
        let key = format!("{}:runtime:cumulative", self.metrics_prefix);
        let mut command = redis::cmd("HGETALL");
        command.arg(&key);
        let fields: HashMap<String, String> = stores.dragonfly.query(&command).await?;
        let get = |name: &str| {
            fields
                .get(name)
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(0)
        };
        Ok(
            json!({"started": get("messageHandlerStarted"), "ended": get("messageHandlerCompleted"),
            "failed": get("messageHandlerErrors")}),
        )
    }
}

/// The ingress's notification of a chat message `event` (the verified ingress's chat effect
/// input included).
pub fn notification(event: &Value, timestamp: &str) -> Notification {
    let value = dima_events::value::Value::from_json(event);
    let channel = event["broadcaster_user_id"].as_str().unwrap_or_default();
    let subscription = json!({"id": format!("sub-{channel}"), "status": "enabled",
        "type": "channel.chat.message", "version": "1",
        "condition": {"broadcaster_user_id": channel, "user_id": "698614112"},
        "transport": {"method": "webhook", "callback": "https://example.invalid/eventsub"},
        "created_at": timestamp, "cost": 0});
    let subscription = match dima_events::value::Value::from_json(&subscription) {
        dima_events::value::Value::Object(object) => object,
        _ => dima_events::value::Object::new(),
    };
    Notification {
        message_id: format!("delivery-{}", random_suffix()),
        message_timestamp: timestamp.to_owned(),
        subscription_type: "channel.chat.message".into(),
        subscription,
        options: HandlerOptions {
            chat_effect: Some(ChatEffectInput::from_event(&value, timestamp)),
            ..HandlerOptions::default()
        },
        event: value,
    }
}

/// Canonical extended JSON to BSON.
pub fn bson_of(value: &Value) -> Bson {
    Bson::try_from(value.clone()).expect("extended JSON")
}

/// Inserts canonical extended JSON documents.
pub async fn insert(stores: &Stores, collection: &str, documents: &Value) -> Result<()> {
    let documents: Vec<Document> = documents
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| match bson_of(item) {
                    Bson::Document(document) => Some(document),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    if !documents.is_empty() {
        stores
            .mongo
            .documents(collection)
            .insert_many(documents)
            .await?;
    }
    Ok(())
}

/// Every document of every collection but `users` and `eventsubs`, canonical, sorted by `_id`.
pub async fn mongo_state(stores: &Stores, channels: &[String]) -> Result<BTreeMap<String, Value>> {
    let mut state = BTreeMap::new();
    for name in stores.mongo.database().list_collection_names().await? {
        if matches!(name.as_str(), "users" | "eventsubs") {
            continue;
        }
        let documents: Vec<Document> = stores
            .mongo
            .documents(&name)
            .find(doc! { "channelID": { "$in": channels } })
            .sort(doc! { "_id": 1 })
            .await?
            .try_collect()
            .await?;
        if !documents.is_empty() {
            state.insert(
                name,
                Value::Array(
                    documents
                        .into_iter()
                        .map(|d| Bson::Document(d).into_canonical_extjson())
                        .collect(),
                ),
            );
        }
    }
    Ok(state)
}

/// The handler's keys of `channels`: chat history, the shared cooldown gate, cache variables.
pub async fn dragonfly_state(
    stores: &Stores,
    channels: &[String],
    started: tokio::time::Instant,
) -> Result<BTreeMap<String, Value>> {
    let mut state = BTreeMap::new();
    for channel in channels {
        let history_key = format!("twitch:{channel}:chat:history");
        let mut command = redis::cmd("LRANGE");
        command.arg(stores.key(&history_key)).arg(0).arg(-1);
        let items: Vec<String> = stores.dragonfly.query(&command).await?;
        if !items.is_empty() {
            state.insert(
                history_key,
                Value::Array(
                    items
                        .iter()
                        .map(|item| serde_json::from_str(item).unwrap_or(Value::Null))
                        .collect(),
                ),
            );
        }
        for pattern in [
            format!("command:execution:cooldown:{channel}:*"),
            format!("twitch:{channel}:variable:*"),
        ] {
            let mut scan = stores.dragonfly.scan(&stores.key(&pattern), Some(500));
            let mut keys = Vec::new();
            while let Some(page) = scan.next_page().await? {
                for key in page {
                    keys.push(String::from_utf8(key)?);
                }
            }
            keys.sort();
            keys.dedup();
            for key in keys {
                let mut pttl = redis::cmd("PTTL");
                pttl.arg(&key);
                let pttl: i64 = stores.dragonfly.query(&pttl).await?;
                let elapsed = i64::try_from(started.elapsed().as_millis()).unwrap_or(0);
                let ttl = if pttl < 0 {
                    pttl
                } else {
                    (pttl + elapsed + 50) / 1000
                };
                let mut kind = redis::cmd("TYPE");
                kind.arg(&key);
                let kind: String = stores.dragonfly.query(&kind).await?;
                let value = stores
                    .dragonfly
                    .get(&key)
                    .await
                    .ok()
                    .flatten()
                    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
                let bare = key.strip_prefix(&stores.prefix).unwrap_or(&key).to_owned();
                state.insert(bare, json!({"type": kind, "value": value, "ttl": ttl}));
            }
        }
    }
    Ok(state)
}

/// Numbers compared by value (an integral double equals the integer), recursively.
pub fn normalized(value: &Value) -> Value {
    match value {
        Value::Number(number) => num(number.as_f64().unwrap_or(f64::NAN)),
        Value::Array(items) => Value::Array(items.iter().map(normalized).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), normalized(value)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// A seeded generator for the command language.
pub fn seeded(seed: u64) -> Arc<dyn Random> {
    Arc::new(SeededRandom::new(seed))
}

// ---------------------------------------------------------------------------------------------
// Seeds and events for the behaviour tests.

/// A streamer with one Twitch account, as sign-up stores it.
pub async fn seed_channel(stores: &Stores, id: &str, plan: &str, live: bool) -> Result<()> {
    stores
        .mongo
        .documents("users")
        .insert_one(doc! {
            "_id": bson::oid::ObjectId::new(), "name": format!("Canal{id}"), "email": format!("canal{id}@example.invalid"),
            "accounts": [{ "_id": bson::oid::ObjectId::new(), "type": "twitch", "id": id, "name": format!("canal{id}"),
                "email": format!("canal{id}@example.invalid"), "actived": true, "chat_enabled": true,
                "has_permissions": true, "up_to_date_permissions": true }],
            "plan_tier": plan, "language": "es", "__v": 0,
            "created_at": bson::DateTime::from_millis(NOW_MS - 86_400_000),
            "updated_at": bson::DateTime::from_millis(NOW_MS - 86_400_000),
        })
        .await?;
    if live {
        stores
            .mongo
            .documents("streamsessions")
            .insert_one(doc! {
                "_id": bson::oid::ObjectId::new(), "channelID": id, "status": "live",
                "started_at": bson::DateTime::from_millis(NOW_MS - 3_600_000), "ended_at": Bson::Null,
                "messages": 0, "commands": 0, "__v": 0,
            })
            .await?;
    }
    Ok(())
}

/// A custom command as the dashboard stores it.
pub async fn seed_command(
    stores: &Stores,
    channel: &str,
    cmd: &str,
    message: &str,
    cooldown: i32,
) -> Result<bson::oid::ObjectId> {
    let id = bson::oid::ObjectId::new();
    stores
        .mongo
        .documents("commands")
        .insert_one(doc! {
            "_id": id, "channelID": channel, "channel": format!("canal{channel}"), "name": cmd, "cmd": cmd,
            "func": "custom", "message": message, "type": "command", "platform": "twitch", "reserved": false,
            "cooldown": cooldown, "count": 0, "userLevelName": "everyone", "userLevel": 0, "enabled": true, "__v": 0,
        })
        .await?;
    Ok(id)
}

/// A chat message of a viewer (`chatter` is `(id, login)`), with a fresh message id.
pub fn chat_event(channel: &str, chatter: (&str, &str), text: &str) -> Value {
    json!({
        "broadcaster_user_id": channel, "broadcaster_user_login": format!("canal{channel}"),
        "broadcaster_user_name": format!("Canal{channel}"),
        "chatter_user_id": chatter.0, "chatter_user_login": chatter.1, "chatter_user_name": chatter.1,
        "message_id": format!("m-{}", random_suffix()),
        "message": {"text": text, "fragments": [{"type": "text", "text": text}]},
        "color": "", "badges": [], "message_type": "text", "cheer": null, "reply": null,
        "source_broadcaster_user_id": null,
    })
}

/// The stored count of a command.
pub async fn count_of(stores: &Stores, id: bson::oid::ObjectId) -> Result<Option<Bson>> {
    Ok(stores
        .mongo
        .documents("commands")
        .find_one(doc! { "_id": id })
        .await?
        .and_then(|document| document.get("count").cloned()))
}

/// Waits until `check` holds (every 5 ms, at most 60 s, so a busy machine cannot fail it).
pub async fn eventually<F>(what: &str, mut check: F) -> Result<()>
where
    F: FnMut() -> bool,
{
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    while !check() {
        if tokio::time::Instant::now() >= deadline {
            bail!("timed out waiting until {what}");
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    Ok(())
}

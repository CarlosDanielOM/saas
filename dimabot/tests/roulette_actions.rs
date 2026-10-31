#![cfg(feature = "widgets-runtime")]

//! Source-parity checks for roulette winner-action claim and delivery.
//!
//! This lane does not run them. They compile once `widgets-runtime` exists and
//! pulls the shared AST runtime, and once `lib.rs` exports `roulette_runtime`.

use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet, VecDeque},
    future::Future,
    rc::Rc,
    sync::{Arc, Mutex},
    time::Duration,
};

use dima_rust::roulette_runtime::{
    actions::{
        ActionChannel, ActionClock, ActionError, ActionStore, CLAIM_ATTEMPTS, ChannelOwner,
        ChannelOwnerDirectory, DUE_ACTION_BATCH, DrawSettlement, MongoActionStore, WinnerExecutor,
        claim_action, directory_owner, execute_winner_action, resolve_winner_actor,
        run_due_actions, winner_parser_context,
    },
    service::{self, ServiceError, action_due},
    ActionStatus, DrawActor, WinnerAction,
};
use dima_rust::utils::{
    ast_evaluator::{
        CommandRefBudget, CommandReference, CommandReferenceState, Context, Engine, EvalError,
        Host, HostFuture, HostRequest, JsString, JsValue,
    },
    ast_runtime::{
        AstBodyParser, AstRuntimeError, AstScope, BoxFuture, ChatSender, CommandExecutionResult,
        CommandRunner, ScopedAstHost, SendResult, SpecialParserContext, SpecialParserResult,
        parser::parse_special_commands,
    },
    twitch::AccessToken,
    twitch_streamers::{
        CachedStreamer, DirectoryCache, DirectoryConfig, DirectoryError, DirectoryFuture,
        DirectorySnapshot, IdPage, MetadataPage, MetadataStore, StreamerAccount, StreamerCredentials,
        StreamerMetadata, TwitchStreamers,
    },
    twitch_tokens::{CachedAccount, SystemTokenClock},
};
use mongodb::bson::Bson;

fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/roulette_actions_cases.json")).expect("roulette action fixture")
}

fn block_on<T>(future: impl Future<Output = T>) -> T {
    // The AST runtime is `Rc`-based. `#[tokio::test]` requires `Send`.
    tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("current-thread runtime")
        .block_on(future)
}

fn status_from(text: &str) -> ActionStatus {
    match text {
        "pending" => ActionStatus::Pending,
        "running" => ActionStatus::Running,
        "done" => ActionStatus::Done,
        "failed" => ActionStatus::Failed,
        "skipped" => ActionStatus::Skipped,
        other => panic!("unknown action status {other}"),
    }
}

fn optional_i64(value: &serde_json::Value) -> Option<i64> {
    if value.is_null() {
        None
    } else {
        Some(value.as_i64().expect("integer timestamp"))
    }
}

fn action_from(value: &serde_json::Value) -> WinnerAction {
    let actor = value.get("actor").and_then(|actor| {
        if actor.is_null() {
            None
        } else {
            Some(DrawActor {
                user_id: actor["userId"].as_str().expect("userId").to_owned(),
                user_login: actor["userLogin"].as_str().expect("userLogin").to_owned(),
                user_display_name: actor["userDisplayName"]
                    .as_str()
                    .expect("userDisplayName")
                    .to_owned(),
                argument: match actor.get("argument") {
                    None | Some(serde_json::Value::Null) => None,
                    Some(argument) => Some(argument.as_str().expect("argument").to_owned()),
                },
            })
        }
    });
    WinnerAction {
        draw_id: value["drawId"].as_str().expect("drawId").to_owned(),
        roulette_id: value
            .get("rouletteId")
            .and_then(|item| item.as_str())
            .unwrap_or("wheel")
            .to_owned(),
        item_id: value
            .get("itemId")
            .and_then(|item| item.as_str())
            .unwrap_or("item")
            .to_owned(),
        label: value
            .get("label")
            .and_then(|item| item.as_str())
            .unwrap_or("Prize")
            .to_owned(),
        source: value
            .get("source")
            .and_then(|item| item.as_str())
            .unwrap_or("plain text")
            .to_owned(),
        due_at: value["dueAt"].as_i64().expect("dueAt"),
        status: status_from(value["status"].as_str().expect("status")),
        actor,
        started_at: value.get("startedAt").and_then(optional_i64),
        finished_at: value.get("finishedAt").and_then(optional_i64),
    }
}

fn pending(draw_id: &str, due_at: i64) -> WinnerAction {
    WinnerAction {
        draw_id: draw_id.to_owned(),
        roulette_id: "wheel".to_owned(),
        item_id: "item".to_owned(),
        label: "Prize".to_owned(),
        source: "plain text".to_owned(),
        due_at,
        status: ActionStatus::Pending,
        actor: None,
        started_at: None,
        finished_at: None,
    }
}

fn saved_actor(argument: &str) -> DrawActor {
    DrawActor {
        user_id: "user-1".to_owned(),
        user_login: "ada".to_owned(),
        user_display_name: "Ada".to_owned(),
        argument: Some(argument.to_owned()),
    }
}

fn js_text(value: &JsValue) -> String {
    match value {
        JsValue::String(text) => text.to_utf8().expect("utf-8 js string"),
        other => panic!("expected a string, got {other:?}"),
    }
}

#[derive(Clone, Default)]
struct Trace(Arc<Mutex<Vec<String>>>);

impl Trace {
    fn push(&self, event: impl Into<String>) {
        self.0.lock().expect("trace").push(event.into());
    }

    fn list(&self) -> Vec<String> {
        self.0.lock().expect("trace").clone()
    }
}

struct Row {
    revision: Bson,
    actions: Vec<WinnerAction>,
    action_due_at: Option<i64>,
    reject_claims: u32,
    clear_on_reject: bool,
    claim_updates: u32,
}

struct Memory {
    rows: BTreeMap<String, Row>,
    load_error: Option<String>,
    due_error: Option<String>,
    finish_fail: BTreeSet<String>,
    last_claim: Option<Vec<WinnerAction>>,
}

struct MemoryStore {
    inner: RefCell<Memory>,
    trace: Trace,
}

impl MemoryStore {
    fn new(trace: Trace) -> Self {
        Self {
            inner: RefCell::new(Memory {
                rows: BTreeMap::new(),
                load_error: None,
                due_error: None,
                finish_fail: BTreeSet::new(),
                last_claim: None,
            }),
            trace,
        }
    }

    fn seed(&self, id: &str, revision: i32, actions: Vec<WinnerAction>) {
        let action_due_at = action_due(&actions);
        self.insert(id, revision, actions, action_due_at, 0, false);
    }

    fn insert_due(&self, id: &str, action_due_at: Option<i64>) {
        self.insert(id, 1, Vec::new(), action_due_at, 0, false);
    }

    fn insert(
        &self,
        id: &str,
        revision: i32,
        actions: Vec<WinnerAction>,
        action_due_at: Option<i64>,
        reject_claims: u32,
        clear_on_reject: bool,
    ) {
        self.inner.borrow_mut().rows.insert(
            id.to_owned(),
            Row {
                revision: Bson::Int32(revision),
                actions,
                action_due_at,
                reject_claims,
                clear_on_reject,
                claim_updates: 0,
            },
        );
    }

    fn row(&self, id: &str) -> Option<(Bson, Vec<WinnerAction>, Option<i64>, u32)> {
        let inner = self.inner.borrow();
        inner.rows.get(id).map(|row| {
            (
                row.revision.clone(),
                row.actions.clone(),
                row.action_due_at,
                row.claim_updates,
            )
        })
    }

    fn contains(&self, id: &str) -> bool {
        self.inner.borrow().rows.contains_key(id)
    }

    fn last_claim(&self) -> Option<Vec<WinnerAction>> {
        self.inner.borrow().last_claim.clone()
    }

    fn fail_load(&self, message: &str) {
        self.inner.borrow_mut().load_error = Some(message.to_owned());
    }

    fn fail_due(&self, message: &str) {
        self.inner.borrow_mut().due_error = Some(message.to_owned());
    }

    fn fail_finish(&self, id: &str) {
        self.inner.borrow_mut().finish_fail.insert(id.to_owned());
    }

    fn set_due(&self, id: &str, action_due_at: Option<i64>) {
        let mut inner = self.inner.borrow_mut();
        inner.rows.get_mut(id).expect("channel").action_due_at = action_due_at;
    }
}

fn bump(revision: &Bson) -> Bson {
    match revision {
        Bson::Int32(value) => Bson::Int32(value + 1),
        other => panic!("claim must keep the stored revision BSON type, got {other:?}"),
    }
}

impl ActionStore for MemoryStore {
    async fn due_channel_ids(&self, now: i64) -> Result<Vec<String>, ActionError> {
        let inner = self.inner.borrow();
        if let Some(message) = &inner.due_error {
            return Err(ActionError::Storage(message.clone()));
        }
        let mut due: Vec<(i64, String)> = inner
            .rows
            .iter()
            .filter_map(|(id, row)| row.action_due_at.filter(|due| *due <= now).map(|due| (due, id.clone())))
            .collect();
        drop(inner);
        due.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
        due.truncate(DUE_ACTION_BATCH as usize);
        Ok(due.into_iter().map(|(_, id)| id).collect())
    }

    async fn load_actions(&self, channel_id: &str) -> Result<Option<ActionChannel>, ActionError> {
        let inner = self.inner.borrow();
        if let Some(message) = &inner.load_error {
            return Err(ActionError::Storage(message.clone()));
        }
        Ok(inner.rows.get(channel_id).map(|row| ActionChannel {
            revision: row.revision.clone(),
            actions: row.actions.clone(),
        }))
    }

    async fn claim_update(
        &self,
        channel_id: &str,
        revision: &Bson,
        actions: &[WinnerAction],
        action_due_at: Option<i64>,
    ) -> Result<bool, ActionError> {
        let claimed = {
            let mut inner = self.inner.borrow_mut();
            let Some(row) = inner.rows.get_mut(channel_id) else {
                return Ok(false);
            };
            row.claim_updates += 1;
            if row.reject_claims > 0 {
                row.reject_claims -= 1;
                row.revision = bump(&row.revision);
                if row.clear_on_reject {
                    row.actions.clear();
                    row.action_due_at = None;
                }
                None
            } else if &row.revision != revision {
                None
            } else {
                row.actions = actions.to_vec();
                row.action_due_at = action_due_at;
                row.revision = bump(revision);
                Some(actions.to_vec())
            }
        };
        match claimed {
            Some(actions) => {
                self.inner.borrow_mut().last_claim = Some(actions);
                self.trace.push(format!("claim:{channel_id}:ok"));
                Ok(true)
            }
            None => {
                self.trace.push(format!("claim:{channel_id}:miss"));
                Ok(false)
            }
        }
    }

    async fn finish_running(
        &self,
        channel_id: &str,
        draw_id: &str,
        status: ActionStatus,
        finished_at: i64,
    ) -> Result<(), ActionError> {
        let failed = {
            let mut inner = self.inner.borrow_mut();
            if inner.finish_fail.contains(channel_id) {
                true
            } else if let Some(row) = inner.rows.get_mut(channel_id) {
                if let Some(action) = row.actions.iter_mut().find(|action| {
                    action.draw_id == draw_id && action.status == ActionStatus::Running
                }) {
                    action.status = status;
                    action.finished_at = Some(finished_at);
                    row.revision = bump(&row.revision);
                }
                false
            } else {
                false
            }
        };
        if failed {
            self.trace.push(format!("finish:{channel_id}:error"));
            return Err(ActionError::Storage("finish failed".to_owned()));
        }
        self.trace
            .push(format!("finish:{channel_id}:{}", status.as_str()));
        Ok(())
    }
}

struct StepClock {
    steps: RefCell<VecDeque<i64>>,
}

impl StepClock {
    fn new(steps: &[i64]) -> Self {
        Self {
            steps: RefCell::new(steps.iter().copied().collect()),
        }
    }
}

impl ActionClock for StepClock {
    fn now_ms(&self) -> i64 {
        self.steps
            .borrow_mut()
            .pop_front()
            .expect("action clock exhausted")
    }
}

struct Snapshots {
    fail: BTreeSet<String>,
    trace: Trace,
}

impl DrawSettlement for Snapshots {
    async fn snapshot(&self, channel_id: &str) -> Result<(), ActionError> {
        self.trace.push(format!("snapshot:{channel_id}"));
        if self.fail.contains(channel_id) {
            Err(ActionError::Settlement(ServiceError::Storage("busy".to_owned())))
        } else {
            Ok(())
        }
    }
}

struct Exec {
    fail: bool,
    trace: Trace,
}

impl WinnerExecutor for Exec {
    async fn execute(&mut self, channel_id: &str, job: &WinnerAction) -> Result<(), ActionError> {
        self.trace
            .push(format!("execute:{channel_id}:{}", job.draw_id));
        assert_eq!(job.status, ActionStatus::Running, "execute sees the claim");
        if self.fail {
            Err(ActionError::Delivery)
        } else {
            Ok(())
        }
    }
}

fn snapshots(trace: Trace) -> Snapshots {
    Snapshots {
        fail: BTreeSet::new(),
        trace,
    }
}

#[test]
fn fixture_pins_batch_limits_and_collection() {
    let fixture = fixture();
    assert_eq!(fixture["claimAttempts"].as_u64(), Some(CLAIM_ATTEMPTS as u64));
    assert_eq!(fixture["dueBatch"].as_i64(), Some(DUE_ACTION_BATCH));
    assert_eq!(fixture["pollSleepMs"].as_u64(), Some(1000));
    assert_eq!(fixture["rustBatchSleepMs"].as_u64(), Some(0));
    assert_eq!(fixture["collection"].as_str(), Some("roulette_channels"));
    assert_eq!(MongoActionStore::collection_name(), service::COLLECTION);
    assert_eq!(MongoActionStore::collection_name(), "roulette_channels");
}

#[test]
fn worker_owns_the_one_second_poll() {
    let actions = include_str!("../src/roulette/actions.rs");
    let worker = include_str!("../src/workers/roulette-actions.worker.ts");
    assert!(actions.contains("This module does not sleep."));
    assert!(!actions.contains("tokio::time"));
    assert!(!actions.contains("std::thread::sleep"));
    assert!(!actions.contains("setTimeout(resolve, 1000)"));
    assert!(actions.contains("for _ in 0..CLAIM_ATTEMPTS"));
    assert!(actions.contains("\"revision\": revision.clone()"));
    assert!(actions.contains("modified_count > 0"));
    assert!(actions.contains("\"$elemMatch\": { \"drawId\": draw_id, \"status\": \"running\" }"));
    assert!(actions.contains("\"actionDueAt\": { \"$ne\": Bson::Null, \"$lte\": js_number(now as f64) }"));
    assert!(worker.contains("setTimeout(resolve, 1000)"));
    assert!(worker.contains("runDueActions"));
    assert!(worker.contains("--once"));
    assert!(worker.contains("--dry-run"));
}

#[test]
fn production_path_calls_the_shared_ast_runtime() {
    let actions = include_str!("../src/roulette/actions.rs");
    assert!(actions.contains("impl<S: CommandStore> WinnerExecutor for BotRuntime<S>"));
    assert!(actions.contains("AstBodyParser::parse"));
    assert!(actions.contains(".deliver("));
    assert!(actions.contains("deliver_ast_message"));
    assert!(actions.contains("directory_owner"));
}

#[test]
fn winner_actor_and_parser_context_match_execute_winner_action() {
    let owner = ChannelOwner {
        name: "Owner".to_owned(),
        plan_tier: "pro".to_owned(),
    };
    let mut saved = pending("draw", 1);
    saved.actor = Some(saved_actor("kept"));
    let actor = resolve_winner_actor("123", &saved, Some(&owner));
    assert_eq!(actor.user_id, "user-1");
    assert_eq!(actor.user_login, "ada");
    assert_eq!(actor.user_display_name, "Ada");
    assert_eq!(actor.argument, "kept");
    let context = winner_parser_context("123", &saved, Some(&owner));
    assert_eq!(context.channel_id, "123");
    assert_eq!(context.scope_type.as_deref(), Some("roulette"));
    assert_eq!(context.scope_name.as_deref(), Some("wheel"));
    assert_eq!(context.user_plan.as_deref(), Some("pro"));
    assert_eq!(context.user_level, Some(10.0));
    assert!(context.literal_arguments);
    assert_eq!(context.argument.as_deref(), Some("kept"));
    assert_eq!(
        context.variables,
        vec![
            ("roulette_id".to_owned(), "wheel".to_owned()),
            ("roulette_draw_id".to_owned(), "draw".to_owned()),
            ("roulette_item_id".to_owned(), "item".to_owned()),
            ("roulette_item".to_owned(), "Prize".to_owned()),
        ]
    );
    let event = context.event_data.expect("event data");
    assert_eq!(js_text(&event.get("chatter_user_id")), "user-1");
    assert_eq!(js_text(&event.get("chatter_user_login")), "ada");
    assert_eq!(js_text(&event.get("chatter_user_name")), "Ada");

    let mut blank = pending("draw", 1);
    blank.actor = Some(DrawActor {
        user_id: String::new(),
        user_login: "ada".to_owned(),
        user_display_name: "Ada".to_owned(),
        argument: Some("dropped".to_owned()),
    });
    let fallback = resolve_winner_actor("123", &blank, Some(&owner));
    assert_eq!(fallback.user_id, "123");
    assert_eq!(fallback.user_login, "Owner");
    assert_eq!(fallback.user_display_name, "Owner");
    assert_eq!(fallback.argument, "");
    let mut whitespace = blank.clone();
    whitespace.actor.as_mut().expect("actor").user_id = " ".to_owned();
    whitespace.actor.as_mut().expect("actor").argument = Some("kept".to_owned());
    let spaced = resolve_winner_actor("123", &whitespace, None);
    assert_eq!(spaced.user_id, " ");
    assert_eq!(spaced.argument, "kept");

    let anonymous = resolve_winner_actor("123", &pending("draw", 1), None);
    assert_eq!(anonymous.user_id, "123");
    assert_eq!(anonymous.user_login, "");
    assert_eq!(anonymous.user_display_name, "");
    let free = winner_parser_context("123", &pending("draw", 1), None);
    assert_eq!(free.user_plan.as_deref(), Some("free"));
    assert_eq!(free.argument.as_deref(), Some(""));
}

#[tokio::test]
async fn claim_cases_follow_the_source() {
    for case in fixture()["claimCases"].as_array().expect("claimCases") {
        let name = case["name"].as_str().expect("name");
        let channel_id = case["channelId"].as_str().expect("channelId");
        let now = case["now"].as_i64().expect("now");
        let store = MemoryStore::new(Trace::default());
        let before = case
            .get("actions")
            .and_then(|value| value.as_array())
            .map(|actions| actions.iter().map(action_from).collect::<Vec<_>>())
            .unwrap_or_default();
        if !case.get("missing").and_then(|value| value.as_bool()).unwrap_or(false) {
            store.insert(
                channel_id,
                case["revision"].as_i64().expect("revision") as i32,
                before.clone(),
                action_due(&before),
                case.get("rejectClaims").and_then(|value| value.as_u64()).unwrap_or(0) as u32,
                case.get("clearOnReject").and_then(|value| value.as_bool()).unwrap_or(false),
            );
        }

        let claimed = claim_action(&store, channel_id, now).await.expect(name);
        let expect = &case["expect"];
        let claimed_id = match &expect["claimedDrawId"] {
            serde_json::Value::Null => None,
            serde_json::Value::String(id) => Some(id.as_str()),
            other => panic!("{name}: claimedDrawId {other}"),
        };
        assert_eq!(claimed.as_ref().map(|job| job.draw_id.as_str()), claimed_id, "{name}");
        if case.get("missing").and_then(|value| value.as_bool()).unwrap_or(false) {
            assert!(!store.contains(channel_id), "{name}");
            continue;
        }

        let (revision, actions, due, updates) = store.row(channel_id).expect(name);
        assert_eq!(
            revision,
            Bson::Int32(expect["revision"].as_i64().expect("revision") as i32),
            "{name}"
        );
        assert_eq!(updates, expect["claimUpdates"].as_u64().expect("claimUpdates") as u32, "{name}");
        assert_eq!(due, optional_i64(&expect["actionDueAt"]), "{name}");
        assert_eq!(due, action_due(&actions), "{name}");
        if expect.get("cleared").and_then(|value| value.as_bool()).unwrap_or(false) {
            assert!(actions.is_empty(), "{name}");
            assert!(claimed.is_none(), "{name}");
            continue;
        }
        let Some(draw_id) = claimed_id else {
            assert_eq!(actions, before, "{name}");
            continue;
        };
        let job = claimed.expect(name);
        let input = before.iter().find(|action| action.draw_id == draw_id).expect(name);
        assert_eq!(job.status, ActionStatus::Running, "{name}");
        assert_eq!(job.started_at, Some(now), "{name}");
        assert_eq!(job.actor, input.actor, "{name}");
        assert_eq!(job.due_at, input.due_at, "{name}");
        assert_eq!(job.source, input.source, "{name}");
        assert_eq!(job.roulette_id, input.roulette_id, "{name}");
        assert_eq!(job.label, input.label, "{name}");
        for action in &actions {
            if action.draw_id == draw_id {
                assert_eq!(action.status, ActionStatus::Running, "{name}");
                assert_eq!(action.started_at, Some(now), "{name}");
                assert_eq!(action.actor, input.actor, "{name}");
            } else {
                let original = before.iter().find(|item| item.draw_id == action.draw_id).expect(name);
                assert_eq!(action, original, "{name}");
            }
        }
    }
}

#[tokio::test]
async fn due_channels_follow_stored_action_due_at() {
    let store = MemoryStore::new(Trace::default());
    store.insert_due("b", Some(10));
    store.insert_due("a", Some(10));
    store.insert_due("c", Some(5));
    store.insert_due("d", None);
    store.insert_due("e", Some(30));
    store.insert_due("f", Some(40));
    store.insert_due("g", Some(50));
    store.insert_due("h", Some(500));
    assert_eq!(
        store.due_channel_ids(100).await.expect("due ids"),
        vec!["c".to_owned(), "a".to_owned(), "b".to_owned(), "e".to_owned()]
    );
}

#[tokio::test]
async fn run_due_actions_claims_one_job_then_the_next() {
    let trace = Trace::default();
    let store = MemoryStore::new(trace.clone());
    store.seed(
        "123",
        1,
        vec![pending("first", 100), pending("second", 200)],
    );
    let settlement = snapshots(trace.clone());
    let mut executor = Exec {
        fail: false,
        trace: trace.clone(),
    };
    let clock = StepClock::new(&[100, 100, 250, 300, 300, 400]);

    run_due_actions(&store, &settlement, &mut executor, &clock)
        .await
        .expect("first pass");
    let (_, actions, due, _) = store.row("123").expect("channel");
    assert_eq!(actions[0].status, ActionStatus::Done);
    assert_eq!(actions[0].started_at, Some(100));
    assert_eq!(actions[0].finished_at, Some(250));
    assert_eq!(actions[1].status, ActionStatus::Pending);
    assert_eq!(due, Some(200));
    let claimed = store.last_claim().expect("claim");
    assert_eq!(claimed[0].status, ActionStatus::Running);
    assert_eq!(claimed[0].draw_id, "first");

    run_due_actions(&store, &settlement, &mut executor, &clock)
        .await
        .expect("second pass");
    let (_, actions, due, _) = store.row("123").expect("channel");
    assert_eq!(actions[1].status, ActionStatus::Done);
    assert_eq!(actions[1].started_at, Some(300));
    assert_eq!(actions[1].finished_at, Some(400));
    assert_eq!(due, None);
    assert_eq!(
        trace.list(),
        vec![
            "snapshot:123",
            "claim:123:ok",
            "execute:123:first",
            "finish:123:done",
            "snapshot:123",
            "claim:123:ok",
            "execute:123:second",
            "finish:123:done",
        ]
    );
}

#[tokio::test]
async fn execute_error_marks_failed_and_is_not_replayed() {
    let trace = Trace::default();
    let store = MemoryStore::new(trace.clone());
    store.seed("123", 1, vec![pending("draw", 1)]);
    let settlement = snapshots(trace.clone());
    let mut executor = Exec {
        fail: true,
        trace: trace.clone(),
    };
    let clock = StepClock::new(&[100, 110, 120, 900]);

    run_due_actions(&store, &settlement, &mut executor, &clock)
        .await
        .expect("execute errors stay inside the pass");
    let (_, actions, due, _) = store.row("123").expect("channel");
    assert_eq!(actions[0].status, ActionStatus::Failed);
    assert_eq!(actions[0].started_at, Some(110));
    assert_eq!(actions[0].finished_at, Some(120));
    assert_eq!(due, None);

    run_due_actions(&store, &settlement, &mut executor, &clock)
        .await
        .expect("second pass");
    assert_eq!(
        trace.list(),
        [
            "snapshot:123",
            "claim:123:ok",
            "execute:123:draw",
            "finish:123:failed",
        ]
    );
}

#[tokio::test]
async fn snapshot_error_does_not_claim_and_stays_first() {
    let trace = Trace::default();
    let store = MemoryStore::new(trace.clone());
    store.seed("a", 1, vec![pending("early", 10)]);
    store.seed("b", 4, vec![pending("only", 20)]);
    store.fail_finish("b");
    let mut settlement = snapshots(trace.clone());
    settlement.fail.insert("a".to_owned());
    let mut executor = Exec {
        fail: false,
        trace: trace.clone(),
    };

    let error = run_due_actions(&store, &settlement, &mut executor, &StepClock::new(&[100, 110, 120]))
        .await
        .expect_err("snapshot error");
    assert_eq!(
        error,
        ActionError::Settlement(ServiceError::Storage("busy".to_owned()))
    );
    let (revision, actions, _, updates) = store.row("a").expect("a");
    assert_eq!(revision, Bson::Int32(1));
    assert_eq!(updates, 0);
    assert_eq!(actions[0].status, ActionStatus::Pending);
    assert_eq!(actions[0].started_at, None);
    let (_, actions, _, _) = store.row("b").expect("b");
    assert_eq!(actions[0].status, ActionStatus::Running);
    assert_eq!(actions[0].started_at, Some(110));
    assert_eq!(actions[0].finished_at, None);
    assert_eq!(
        trace.list(),
        [
            "snapshot:a",
            "snapshot:b",
            "claim:b:ok",
            "execute:b:only",
            "finish:b:error",
        ]
    );
}

#[tokio::test]
async fn finish_error_leaves_the_claim_running() {
    let trace = Trace::default();
    let store = MemoryStore::new(trace.clone());
    store.seed("123", 2, vec![pending("draw", 1)]);
    store.fail_finish("123");
    let settlement = snapshots(trace.clone());
    let mut executor = Exec {
        fail: false,
        trace: trace.clone(),
    };
    let clock = StepClock::new(&[100, 100, 250, 900]);

    let error = run_due_actions(&store, &settlement, &mut executor, &clock)
        .await
        .expect_err("finish");
    assert_eq!(error, ActionError::Storage("finish failed".to_owned()));
    let (_, actions, due, _) = store.row("123").expect("channel");
    assert_eq!(actions[0].status, ActionStatus::Running);
    assert_eq!(actions[0].started_at, Some(100));
    assert_eq!(actions[0].finished_at, None);
    assert_eq!(due, None);

    run_due_actions(&store, &settlement, &mut executor, &clock)
        .await
        .expect("running row is not due again");
    assert_eq!(trace.list().iter().filter(|event| event.starts_with("execute:")).count(), 1);
}

#[tokio::test]
async fn stale_action_due_at_snapshots_without_a_job() {
    let trace = Trace::default();
    let store = MemoryStore::new(trace.clone());
    let mut running = pending("draw", 500);
    running.status = ActionStatus::Running;
    running.started_at = Some(1);
    store.seed("123", 1, vec![running]);
    store.set_due("123", Some(50));
    let settlement = snapshots(trace.clone());
    let mut executor = Exec {
        fail: false,
        trace: trace.clone(),
    };

    run_due_actions(&store, &settlement, &mut executor, &StepClock::new(&[100, 100]))
        .await
        .expect("no job");
    assert_eq!(trace.list(), ["snapshot:123"]);
    assert!(store.last_claim().is_none());
}

#[tokio::test]
async fn storage_errors_before_a_claim_leave_the_job_pending() {
    let trace = Trace::default();
    let due_store = MemoryStore::new(trace.clone());
    due_store.seed("123", 1, vec![pending("draw", 1)]);
    due_store.fail_due("due down");
    let settlement = snapshots(trace.clone());
    let mut executor = Exec {
        fail: false,
        trace: trace.clone(),
    };
    let error = run_due_actions(&due_store, &settlement, &mut executor, &StepClock::new(&[1]))
        .await
        .expect_err("due query");
    assert_eq!(error, ActionError::Storage("due down".to_owned()));
    assert!(trace.list().is_empty());
    assert_eq!(due_store.row("123").expect("row").1[0].status, ActionStatus::Pending);

    let trace = Trace::default();
    let store = MemoryStore::new(trace.clone());
    store.seed("123", 1, vec![pending("draw", 1)]);
    store.fail_load("load down");
    let settlement = snapshots(trace.clone());
    let mut executor = Exec {
        fail: false,
        trace,
    };
    let error = run_due_actions(&store, &settlement, &mut executor, &StepClock::new(&[10, 20]))
        .await
        .expect_err("load");
    assert_eq!(error, ActionError::Storage("load down".to_owned()));
    let (_, actions, due, updates) = store.row("123").expect("row");
    assert_eq!(actions[0].status, ActionStatus::Pending);
    assert_eq!(actions[0].started_at, None);
    assert_eq!(due, Some(1));
    assert_eq!(updates, 0);
}

fn missing<'a, T: Send + 'a>() -> DirectoryFuture<'a, T> {
    Box::pin(async { Err(DirectoryError::Missing) })
}

struct Unused;

impl MetadataStore for Unused {
    fn account<'a>(&'a self, _: &'a str) -> DirectoryFuture<'a, Option<StreamerMetadata>> {
        missing()
    }
    fn page<'a>(&'a self, _: Option<&'a str>, _: usize) -> DirectoryFuture<'a, MetadataPage> {
        missing()
    }
}

impl StreamerCredentials for Unused {
    fn snapshot<'a>(&'a self, _: &'a str) -> DirectoryFuture<'a, CachedAccount> {
        missing()
    }
    fn token<'a>(&'a self, _: &'a str) -> DirectoryFuture<'a, AccessToken> {
        missing()
    }
}

struct Cache {
    present: Option<StreamerAccount>,
    unavailable: bool,
}

impl DirectoryCache for Cache {
    fn revision(&self) -> DirectoryFuture<'_, String> {
        missing()
    }
    fn observe<'a>(&'a self, _: &'a str) -> DirectoryFuture<'a, DirectorySnapshot> {
        missing()
    }
    fn read_accounts<'a>(&'a self, ids: &'a [String]) -> DirectoryFuture<'a, Vec<CachedStreamer>> {
        // `Ok(CachedStreamer::Missing)` falls through to a timed refresh.
        // `Err(Missing)` is the source's null owner and does not start that timer.
        if self.unavailable {
            return Box::pin(async { Err(DirectoryError::StoreUnavailable) });
        }
        let Some(account) = self.present.clone() else {
            return Box::pin(async { Err(DirectoryError::Missing) });
        };
        let id = account.metadata.id.clone();
        Box::pin(async move {
            if ids.len() == 1 && ids[0] == id {
                Ok(vec![CachedStreamer::Present(account)])
            } else {
                Err(DirectoryError::Missing)
            }
        })
    }
    fn publish<'a>(
        &'a self,
        _: &'a StreamerMetadata,
        _: &'a DirectorySnapshot,
        _: Option<&'a str>,
    ) -> DirectoryFuture<'a, String> {
        missing()
    }
    fn evict<'a>(
        &'a self,
        _: &'a str,
        _: &'a DirectorySnapshot,
        _: Option<&'a str>,
    ) -> DirectoryFuture<'a, bool> {
        missing()
    }
    fn ids<'a>(&'a self, _: u64, _: usize) -> DirectoryFuture<'a, IdPage> {
        missing()
    }
    fn hash_ids<'a>(&'a self, _: u64, _: usize) -> DirectoryFuture<'a, IdPage> {
        missing()
    }
    fn validate<'a>(&'a self, _: &'a str, _: &'a [(String, String)]) -> DirectoryFuture<'a, bool> {
        missing()
    }
    fn validate_ids<'a>(&'a self, _: &'a str, _: &'a [String]) -> DirectoryFuture<'a, bool> {
        missing()
    }
    fn validate_accounts<'a>(
        &'a self,
        _: &'a str,
        _: &'a [StreamerAccount],
    ) -> DirectoryFuture<'a, bool> {
        missing()
    }
    fn acquire_lease<'a>(&'a self, _: &'a str, _: Duration) -> DirectoryFuture<'a, bool> {
        missing()
    }
    fn release_lease<'a>(&'a self, _: &'a str) -> DirectoryFuture<'a, ()> {
        missing()
    }
    fn kick_credentials<'a>(&'a self, _: &'a str) -> DirectoryFuture<'a, Option<CachedAccount>> {
        missing()
    }
}

fn streamer(id: &str, name: &str, plan: &str) -> StreamerAccount {
    StreamerAccount {
        metadata: StreamerMetadata {
            id: id.to_owned(),
            name: name.to_owned(),
            email: String::new(),
            plan_tier: plan.to_owned(),
            plan_tier_until: String::new(),
            polar_sh_customer_id: String::new(),
            actived: "true".to_owned(),
            chat_enabled: "true".to_owned(),
            plan_version: String::new(),
        },
        access_token: String::new(),
        refresh_token: String::new(),
        expires_at: String::new(),
        has_permissions: "false".to_owned(),
        up_to_date_permissions: "false".to_owned(),
    }
}

fn directory(cache: Cache) -> TwitchStreamers {
    TwitchStreamers::new(
        Arc::new(Unused),
        Arc::new(cache),
        Arc::new(Unused),
        Arc::new(SystemTokenClock::default()),
        DirectoryConfig::default(),
    )
    .expect("directory fixture")
}

#[tokio::test]
async fn directory_owner_reads_the_present_cache_and_swallows_other_errors() {
    let present = directory(Cache {
        present: Some(streamer("123", "Ada", "pro")),
        unavailable: false,
    });
    assert_eq!(
        directory_owner(&present, "123").await,
        Some(ChannelOwner {
            name: "Ada".to_owned(),
            plan_tier: "pro".to_owned(),
        })
    );
    assert_eq!(directory_owner(&present, "999").await, None);

    let missing = directory(Cache {
        present: None,
        unavailable: false,
    });
    assert_eq!(directory_owner(&missing, "123").await, None);

    let unavailable = directory(Cache {
        present: Some(streamer("123", "Ada", "pro")),
        unavailable: true,
    });
    assert_eq!(directory_owner(&unavailable, "123").await, None);
}

struct QuietHost;

impl Host for QuietHost {
    fn execute<'a>(&'a mut self, _: HostRequest, _: Context) -> HostFuture<'a> {
        Box::pin(async { Err(EvalError::new("unexpected host call")) })
    }
    fn random(&mut self) -> Result<f64, EvalError> {
        Err(EvalError::new("unexpected random call"))
    }
}

impl ScopedAstHost for QuietHost {
    fn set_scope(&mut self, _: AstScope) {}
}

struct CaptureParser {
    result: Result<SpecialParserResult, AstRuntimeError>,
    captured: RefCell<Option<SpecialParserContext>>,
}

impl AstBodyParser for CaptureParser {
    fn parse<'a>(
        &'a mut self,
        _: &'a str,
        context: SpecialParserContext,
    ) -> BoxFuture<'a, Result<SpecialParserResult, AstRuntimeError>> {
        self.captured.replace(Some(context));
        let result = self.result.clone();
        Box::pin(async move { result })
    }
}

struct LiveParser {
    engine: Engine,
    host: QuietHost,
    directory: TwitchStreamers,
}

impl AstBodyParser for LiveParser {
    fn parse<'a>(
        &'a mut self,
        text: &'a str,
        context: SpecialParserContext,
    ) -> BoxFuture<'a, Result<SpecialParserResult, AstRuntimeError>> {
        parse_special_commands(&self.engine, &mut self.host, &self.directory, text, context)
    }
}

struct FakeSender {
    sent: Vec<(String, String)>,
    fail_text: Option<String>,
}

impl ChatSender for FakeSender {
    fn send<'a>(
        &'a mut self,
        channel_id: &'a str,
        text: &'a str,
    ) -> BoxFuture<'a, Result<SendResult, AstRuntimeError>> {
        Box::pin(async move {
            self.sent.push((channel_id.to_owned(), text.to_owned()));
            if self.fail_text.as_deref() == Some(text) {
                Ok(SendResult::failure("send rejected", 500))
            } else {
                Ok(SendResult::ok("sent"))
            }
        })
    }
}

enum RunStep {
    Ok,
    Flagged,
    Fail(AstRuntimeError),
}

struct FakeRunner {
    calls: Vec<String>,
    step: RunStep,
}

impl CommandRunner for FakeRunner {
    fn execute<'a>(
        &'a mut self,
        request: &'a CommandReference,
    ) -> BoxFuture<'a, Result<CommandExecutionResult, AstRuntimeError>> {
        Box::pin(async move {
            self.calls.push(request.command_name.clone());
            match &self.step {
                RunStep::Ok => Ok(CommandExecutionResult {
                    error: false,
                    message: "nested".to_owned(),
                    status: Some(200),
                    type_name: "success".to_owned(),
                    command_references: Vec::new(),
                }),
                RunStep::Flagged => Ok(CommandExecutionResult {
                    error: true,
                    message: "disabled".to_owned(),
                    status: Some(400),
                    type_name: "command_disabled".to_owned(),
                    command_references: Vec::new(),
                }),
                RunStep::Fail(error) => Err(error.clone()),
            }
        })
    }
}

fn reference(command_name: &str) -> CommandReference {
    CommandReference {
        effect_context: None,
        channel_id: "123".to_owned(),
        command_name: command_name.to_owned(),
        argument: JsString::from(""),
        event_data: JsValue::Undefined,
        authorization: JsValue::Undefined,
        state: CommandReferenceState {
            visited_commands: Vec::new(),
            command_ref_depth: 0.0,
            command_ref_budget: Rc::new(RefCell::new(CommandRefBudget { remaining: 50.0 })),
            timer_depth: None,
        },
    }
}

fn rendered(text: &str, references: Vec<CommandReference>) -> SpecialParserResult {
    SpecialParserResult {
        parsed_text: text.to_owned(),
        command_references: references,
        ..Default::default()
    }
}

struct Pipeline<P> {
    directory: TwitchStreamers,
    parser: P,
    sender: FakeSender,
    runner: FakeRunner,
}

impl<P: AstBodyParser> WinnerExecutor for Pipeline<P> {
    async fn execute(&mut self, channel_id: &str, job: &WinnerAction) -> Result<(), ActionError> {
        execute_winner_action(
            &self.directory,
            &mut self.parser,
            &mut self.sender,
            &mut self.runner,
            channel_id,
            job,
        )
        .await
    }
}

fn missing_directory() -> TwitchStreamers {
    directory(Cache {
        present: None,
        unavailable: false,
    })
}

#[test]
fn execute_passes_the_directory_owner_into_the_parser() {
    let directory = directory(Cache {
        present: Some(streamer("123", "Ada", "pro")),
        unavailable: false,
    });
    let mut job = pending("draw", 1);
    job.actor = Some(saved_actor("kept"));
    let mut parser = CaptureParser {
        result: Ok(rendered("rendered", Vec::new())),
        captured: RefCell::new(None),
    };
    let mut sender = FakeSender {
        sent: Vec::new(),
        fail_text: None,
    };
    let mut runner = FakeRunner {
        calls: Vec::new(),
        step: RunStep::Ok,
    };
    block_on(execute_winner_action(
        &directory,
        &mut parser,
        &mut sender,
        &mut runner,
        "123",
        &job,
    ))
    .expect("delivery");
    let context = parser.captured.borrow().clone().expect("context");
    assert_eq!(context.user_plan.as_deref(), Some("pro"));
    assert_eq!(context.user_level, Some(10.0));
    assert_eq!(context.scope_type.as_deref(), Some("roulette"));
    assert_eq!(context.argument.as_deref(), Some("kept"));
    assert_eq!(
        js_text(&context.event_data.expect("event").get("chatter_user_id")),
        "user-1"
    );
    assert_eq!(sender.sent, vec![("123".to_owned(), "rendered".to_owned())]);
    assert!(runner.calls.is_empty());
}

#[test]
fn empty_user_id_falls_back_inside_execute() {
    let mut job = pending("draw", 1);
    job.actor = Some(DrawActor {
        user_id: String::new(),
        user_login: "ada".to_owned(),
        user_display_name: "Ada".to_owned(),
        argument: Some("dropped".to_owned()),
    });
    let mut parser = CaptureParser {
        result: Ok(rendered("rendered", Vec::new())),
        captured: RefCell::new(None),
    };
    let mut sender = FakeSender {
        sent: Vec::new(),
        fail_text: None,
    };
    let mut runner = FakeRunner {
        calls: Vec::new(),
        step: RunStep::Ok,
    };
    block_on(execute_winner_action(
        &missing_directory(),
        &mut parser,
        &mut sender,
        &mut runner,
        "123",
        &job,
    ))
    .expect("fallback delivery");
    let context = parser.captured.borrow().clone().expect("context");
    assert_eq!(context.user_plan.as_deref(), Some("free"));
    assert_eq!(context.argument.as_deref(), Some(""));
    let event = context.event_data.expect("event");
    assert_eq!(js_text(&event.get("chatter_user_id")), "123");
    assert_eq!(js_text(&event.get("chatter_user_login")), "");
    assert_eq!(js_text(&event.get("chatter_user_name")), "");
}

#[test]
fn live_parser_delivers_plain_text() {
    let directory = missing_directory();
    let mut parser = LiveParser {
        engine: Engine::default(),
        host: QuietHost,
        directory: directory.clone(),
    };
    let mut sender = FakeSender {
        sent: Vec::new(),
        fail_text: None,
    };
    let mut runner = FakeRunner {
        calls: Vec::new(),
        step: RunStep::Ok,
    };
    let mut job = pending("draw", 1);
    job.source = "hello winner".to_owned();
    block_on(execute_winner_action(
        &directory,
        &mut parser,
        &mut sender,
        &mut runner,
        "123",
        &job,
    ))
    .expect("plain text");
    assert_eq!(sender.sent, vec![("123".to_owned(), "hello winner".to_owned())]);
    assert!(runner.calls.is_empty());
}

#[test]
fn placeholder_errors_are_delivered_as_text() {
    let directory = missing_directory();
    let mut parser = LiveParser {
        engine: Engine::default(),
        host: QuietHost,
        directory: directory.clone(),
    };
    let mut sender = FakeSender {
        sent: Vec::new(),
        fail_text: None,
    };
    let mut runner = FakeRunner {
        calls: Vec::new(),
        step: RunStep::Ok,
    };
    let mut job = pending("draw", 1);
    job.source = "&t &p1".to_owned();
    block_on(execute_winner_action(
        &directory,
        &mut parser,
        &mut sender,
        &mut runner,
        "123",
        &job,
    ))
    .expect("placeholder text");
    assert_eq!(
        sender.sent,
        vec![(
            "123".to_owned(),
            "[Parser error: cannot create new &pN after &t]".to_owned()
        )]
    );
    assert!(runner.calls.is_empty());
}

#[test]
fn delivery_adapter_failures() {
    let directory = missing_directory();
    let mut sender = FakeSender {
        sent: Vec::new(),
        fail_text: Some("outer".to_owned()),
    };
    let mut runner = FakeRunner {
        calls: Vec::new(),
        step: RunStep::Ok,
    };
    let mut parser = CaptureParser {
        result: Ok(rendered("outer", vec![reference("spin")])),
        captured: RefCell::new(None),
    };
    let error = block_on(execute_winner_action(
        &directory,
        &mut parser,
        &mut sender,
        &mut runner,
        "123",
        &pending("draw", 1),
    ))
    .expect_err("sender");
    assert_eq!(error, ActionError::Delivery);
    assert_eq!(error.to_string(), "Winner action delivery failed");
    assert!(runner.calls.is_empty());
    assert_eq!(sender.sent.len(), 1);

    let mut sender = FakeSender {
        sent: Vec::new(),
        fail_text: None,
    };
    let mut runner = FakeRunner {
        calls: Vec::new(),
        step: RunStep::Flagged,
    };
    let mut parser = CaptureParser {
        result: Ok(rendered("outer", vec![reference("spin")])),
        captured: RefCell::new(None),
    };
    block_on(execute_winner_action(
        &directory,
        &mut parser,
        &mut sender,
        &mut runner,
        "123",
        &pending("draw", 1),
    ))
    .expect("flagged reference continues");
    assert_eq!(runner.calls, vec!["spin".to_owned()]);
    assert_eq!(sender.sent, vec![("123".to_owned(), "outer".to_owned())]);

    let mut sender = FakeSender {
        sent: Vec::new(),
        fail_text: None,
    };
    let mut runner = FakeRunner {
        calls: Vec::new(),
        step: RunStep::Fail(AstRuntimeError::Host("boom".to_owned())),
    };
    let mut parser = CaptureParser {
        result: Ok(rendered("outer", vec![reference("spin")])),
        captured: RefCell::new(None),
    };
    block_on(execute_winner_action(
        &directory,
        &mut parser,
        &mut sender,
        &mut runner,
        "123",
        &pending("draw", 1),
    ))
    .expect("host errors are logged and continued");
    assert_eq!(runner.calls, vec!["spin".to_owned()]);
    assert_eq!(sender.sent, vec![("123".to_owned(), "outer".to_owned())]);

    let mut sender = FakeSender {
        sent: Vec::new(),
        fail_text: None,
    };
    let mut runner = FakeRunner {
        calls: Vec::new(),
        step: RunStep::Fail(AstRuntimeError::Cancelled),
    };
    let mut parser = CaptureParser {
        result: Ok(rendered("outer", vec![reference("spin")])),
        captured: RefCell::new(None),
    };
    let error = block_on(execute_winner_action(
        &directory,
        &mut parser,
        &mut sender,
        &mut runner,
        "123",
        &pending("draw", 1),
    ))
    .expect_err("cancelled reference");
    assert_eq!(error, ActionError::Evaluation("cancelled".to_owned()));
    assert_eq!(sender.sent, vec![("123".to_owned(), "outer".to_owned())]);
    assert_eq!(runner.calls, vec!["spin".to_owned()]);

    let mut sender = FakeSender {
        sent: Vec::new(),
        fail_text: None,
    };
    let mut runner = FakeRunner {
        calls: Vec::new(),
        step: RunStep::Ok,
    };
    let mut parser = CaptureParser {
        result: Err(AstRuntimeError::Syntax("bad source".to_owned())),
        captured: RefCell::new(None),
    };
    let error = block_on(execute_winner_action(
        &directory,
        &mut parser,
        &mut sender,
        &mut runner,
        "123",
        &pending("draw", 1),
    ))
    .expect_err("parser");
    assert_eq!(error, ActionError::Evaluation("bad source".to_owned()));
    assert!(sender.sent.is_empty());
    assert!(runner.calls.is_empty());
}

#[test]
fn run_due_actions_delivers_with_the_live_parser() {
    let trace = Trace::default();
    let store = MemoryStore::new(trace.clone());
    let mut job = pending("draw", 1);
    job.source = "hello winner".to_owned();
    store.seed("123", 1, vec![job]);
    let directory = missing_directory();
    let mut pipeline = Pipeline {
        parser: LiveParser {
            engine: Engine::default(),
            host: QuietHost,
            directory: directory.clone(),
        },
        directory,
        sender: FakeSender {
            sent: Vec::new(),
            fail_text: None,
        },
        runner: FakeRunner {
            calls: Vec::new(),
            step: RunStep::Ok,
        },
    };
    block_on(run_due_actions(
        &store,
        &snapshots(trace),
        &mut pipeline,
        &StepClock::new(&[100, 100, 250]),
    ))
    .expect("delivered");
    let (_, actions, due, _) = store.row("123").expect("channel");
    assert_eq!(actions[0].status, ActionStatus::Done);
    assert_eq!(actions[0].started_at, Some(100));
    assert_eq!(actions[0].finished_at, Some(250));
    assert_eq!(due, None);
    assert_eq!(
        pipeline.sender.sent,
        vec![("123".to_owned(), "hello winner".to_owned())]
    );
    assert_eq!(
        store.last_claim().expect("claim")[0].status,
        ActionStatus::Running
    );
}

#[test]
fn run_due_actions_records_a_delivery_failure() {
    let trace = Trace::default();
    let store = MemoryStore::new(trace.clone());
    store.seed("123", 1, vec![pending("draw", 1)]);
    let directory = missing_directory();
    let mut pipeline = Pipeline {
        parser: CaptureParser {
            result: Ok(rendered("bad", Vec::new())),
            captured: RefCell::new(None),
        },
        directory,
        sender: FakeSender {
            sent: Vec::new(),
            fail_text: Some("bad".to_owned()),
        },
        runner: FakeRunner {
            calls: Vec::new(),
            step: RunStep::Ok,
        },
    };
    let clock = StepClock::new(&[100, 110, 120, 900]);
    block_on(run_due_actions(
        &store,
        &snapshots(trace.clone()),
        &mut pipeline,
        &clock,
    ))
    .expect("delivery failure is stored");
    let (_, actions, _, _) = store.row("123").expect("channel");
    assert_eq!(actions[0].status, ActionStatus::Failed);
    assert_eq!(actions[0].finished_at, Some(120));
    assert_eq!(pipeline.sender.sent.len(), 1);
    assert!(pipeline.runner.calls.is_empty());

    block_on(run_due_actions(
        &store,
        &snapshots(trace.clone()),
        &mut pipeline,
        &clock,
    ))
    .expect("failed row is not replayed");
    assert_eq!(pipeline.sender.sent.len(), 1);
}

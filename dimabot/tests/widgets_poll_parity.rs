#![cfg(feature = "widgets-runtime")]
//! Source-oracle checks for the widget poll launch path.
//!
//! Sources under test:
//!
//! - `dimabot/src/widgets/service.ts` (`launchPoll`, `advance`).
//! - `dimabot/src/utils/ast_parser/functions/channel.functions.ts`
//!   (`startPollHandler`, `registerFunction('start.poll', …)`).
//!
//! The AST template runtime is `!Send`; the widget service is an Axum service.
//! These cases therefore pin the concrete `start.poll` adapter
//! ([`WidgetStartPoll`]) and its reusable `AstFunctionCatalog` surface, not a
//! full `parseSpecialCommands` render. Authoring note: `widgets-runtime` and
//! `dima_rust::widgets` are not declared yet; the central wiring is required
//! before this target compiles. No database, network, or wall clock is used.

use std::sync::{Arc, Mutex};

use dima_rust::widgets::{
    model::{self, Language, Run, State},
    service::{
        choice_titles, parse_start_poll, start_poll_argument, start_poll_source, PollFuture,
        PollGateway, WidgetServiceError, WidgetStartPoll, START_POLL_FORMAT, START_POLL_POINTS,
        START_POLL_USAGE,
    },
};
use serde_json::{Value, json};

const CASES: &str = include_str!("fixtures/widgets_poll_parity_cases.json");
const CHANNEL: &str = "12345";

#[derive(Clone, Debug)]
struct CreateCall {
    channel: String,
    title: String,
    choices: Value,
    duration: Value,
    cache: bool,
    points: f64,
}

struct RecordingPolls {
    creates: Mutex<Vec<CreateCall>>,
    result: Value,
}

impl RecordingPolls {
    fn new(result: Value) -> Self {
        Self { creates: Mutex::new(Vec::new()), result }
    }

    fn calls(&self) -> std::sync::MutexGuard<'_, Vec<CreateCall>> {
        self.creates.lock().expect("poll creates")
    }
}

impl PollGateway for RecordingPolls {
    fn get_poll<'a>(&'a self, _channel: &'a str, _poll_id: Option<&'a str>, _cache: bool) -> PollFuture<'a> {
        Box::pin(async { Err(WidgetServiceError::Storage("get_poll is not used by start.poll".to_owned())) })
    }

    fn create_poll<'a>(
        &'a self,
        channel: &'a str,
        title: &'a str,
        choices: &'a Value,
        duration: &'a Value,
        cache: bool,
        points: f64,
    ) -> PollFuture<'a> {
        self.creates.lock().expect("poll creates").push(CreateCall {
            channel: channel.to_owned(),
            title: title.to_owned(),
            choices: choices.clone(),
            duration: duration.clone(),
            cache,
            points,
        });
        let result = self.result.clone();
        Box::pin(async move { Ok(result) })
    }
}

fn recorded(result: Value) -> (Arc<RecordingPolls>, WidgetStartPoll) {
    let polls = Arc::new(RecordingPolls::new(result));
    let gateway: Arc<dyn PollGateway> = polls.clone();
    (polls, WidgetStartPoll::new(gateway))
}

fn expected_error(kind: &str) -> &'static str {
    match kind {
        "usage" => START_POLL_USAGE,
        "format" => START_POLL_FORMAT,
        "points" => START_POLL_POINTS,
        other => panic!("unknown fixture error kind {other}"),
    }
}

#[test]
fn fixture_cases_match_the_start_poll_handler() {
    let cases: Value = serde_json::from_str(CASES).expect("widgets poll fixture");
    let cases = cases.get("cases").and_then(Value::as_array).expect("fixture cases");
    for case in cases {
        let name = case.get("name").and_then(Value::as_str).expect("case name");
        let argument = case.get("argument").and_then(Value::as_str).expect("argument");
        let parsed = parse_start_poll(argument);
        if let Some(kind) = case.get("error").and_then(Value::as_str) {
            assert_eq!(parsed.expect_err(name), expected_error(kind), "{name}");
            continue;
        }
        let command = parsed.unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(command.title, case.get("title").and_then(Value::as_str).expect("title"), "{name}");
        let options: Vec<String> = case
            .get("options")
            .and_then(Value::as_array)
            .expect("options")
            .iter()
            .map(|option| option.as_str().expect("option").to_owned())
            .collect();
        assert_eq!(command.options, options, "{name}");
        assert_eq!(command.duration, case.get("duration").and_then(Value::as_f64).expect("duration"), "{name}");
        assert_eq!(command.points, case.get("points").and_then(Value::as_i64).expect("points"), "{name}");
    }
}

fn poll_state(language: Language, voting: bool, joker: bool) -> State {
    let mut state = model::initial();
    state.config.language = language;
    state.config.poll_seconds = 30;
    state.config.channel_points_voting = voting;
    state.config.channel_points_per_vote = 250;
    state.config.joker_chance = 100;
    state.config.joker_points_per_vote = 500;
    state.run = Some(Run {
        operation: Some(model::Operation::Poll),
        sequence: None,
        id: "run-1".to_owned(),
        character_id: None,
        perk_ids: Vec::new(),
        draw: None,
        cards: vec![0, 1, 2, 3, 4],
        votes: vec![0; 5],
        channel_points_votes: vec![0; 5],
        winning_card: None,
        perk_count: None,
        poll_id: None,
        choice_ids: Vec::new(),
        poll_title: "DBD: Choose a card (abc12345)".to_owned(),
        poll_ends_at: None,
        joker: joker.then_some(true),
        error: None,
    });
    state
}

#[test]
fn launch_argument_and_ast_source_match_the_typescript_interpolation() {
    let state = poll_state(Language::En, false, false);
    assert_eq!(
        start_poll_argument(&state).expect("argument"),
        "DBD: Choose a card (abc12345);Card 1/Card 2/Card 3/Card 4/Card 5;30;0"
    );
    assert_eq!(
        start_poll_source(&state).expect("source"),
        r#"$(start.poll "DBD: Choose a card (abc12345);Card 1/Card 2/Card 3/Card 4/Card 5;30;0")"#
    );

    let voting = poll_state(Language::En, true, false);
    assert_eq!(
        start_poll_argument(&voting).expect("voting argument"),
        "DBD: Choose a card (abc12345);Card 1/Card 2/Card 3/Card 4/Card 5;30;250"
    );

    let joker = poll_state(Language::En, true, true);
    assert_eq!(
        start_poll_argument(&joker).expect("joker argument"),
        "DBD: Choose a card (abc12345);Card 1/Card 2/Card 3/Card 4/Card 5;30;500"
    );

    let spanish = poll_state(Language::Es, false, false);
    assert_eq!(
        start_poll_argument(&spanish).expect("spanish argument"),
        "DBD: Choose a card (abc12345);Carta 1/Carta 2/Carta 3/Carta 4/Carta 5;30;0"
    );

    assert_eq!(choice_titles(Language::En).len(), 5);
    assert_eq!(choice_titles(Language::Es)[0], "Carta 1");
}

#[test]
fn launch_source_json_escapes_like_json_stringify() {
    let mut state = poll_state(Language::En, false, false);
    state.run.as_mut().expect("run").poll_title = "A \"quoted\" card;with \\ slash".to_owned();
    assert_eq!(
        start_poll_source(&state).expect("source"),
        r#"$(start.poll "A \"quoted\" card;with \\ slash;Card 1/Card 2/Card 3/Card 4/Card 5;30;0")"#
    );
}

#[tokio::test]
async fn start_poll_adapter_creates_the_source_choices_and_reports_source_errors() {
    let (polls, adapter) = recorded(json!({"id": "poll-1"}));
    adapter
        .start(
            CHANNEL,
            "DBD: Choose a card (abc12345);Card 1/Card 2/Card 3/Card 4/Card 5;30;100",
        )
        .await
        .expect("start poll");
    let calls = polls.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].channel, CHANNEL);
    assert_eq!(calls[0].title, "DBD: Choose a card (abc12345)");
    assert_eq!(
        calls[0].choices,
        json!([
            {"title": "Card 1"},
            {"title": "Card 2"},
            {"title": "Card 3"},
            {"title": "Card 4"},
            {"title": "Card 5"}
        ])
    );
    assert_eq!(calls[0].duration, json!(30));
    assert_eq!(calls[0].duration.as_i64(), Some(30), "integral seconds stay integers");
    assert_eq!(calls[0].points, 100.0);
    assert!(!calls[0].cache);
    drop(calls);

    let (failing_polls, failing) = recorded(json!({"error": true, "message": "boom"}));
    assert_eq!(
        failing.start(CHANNEL, "Question;A/B;30;0").await.expect_err("create error"),
        "Error starting poll: boom"
    );
    assert_eq!(failing_polls.calls().len(), 1);

    let (invalid_polls, invalid) = recorded(json!({"id": "poll-1"}));
    assert_eq!(invalid.start(CHANNEL, "Question;A;30").await.expect_err("format"), START_POLL_FORMAT);
    assert_eq!(invalid.start(CHANNEL, "   ").await.expect_err("usage"), START_POLL_USAGE);
    assert!(invalid_polls.calls().is_empty());
}

#[cfg(feature = "ast-bot-runtime")]
#[test]
fn ast_context_matches_launch_poll() {
    let context = dima_rust::widgets::service::start_poll_context(CHANNEL, "dbd-killer-challenge");
    assert_eq!(context.channel_id, CHANNEL);
    assert_eq!(context.scope_type.as_deref(), Some("widgets"));
    assert_eq!(context.scope_name.as_deref(), Some("dbd-killer-challenge"));
    assert_eq!(context.user_plan.as_deref(), Some("pro"));
    assert_eq!(context.user_level, Some(10.0));
    assert!(context.literal_arguments);
}

#[cfg(feature = "ast-bot-runtime")]
#[tokio::test]
async fn ast_catalog_start_poll_uses_the_same_handler_and_refuses_other_functions() {
    use dima_rust::utils::{
        ast_evaluator::{JsValue, js_string},
        ast_runtime::{AstFunctionCatalog, AstRuntimeError, AstScope},
    };

    let (polls, adapter) = recorded(json!({"id": "poll-1"}));
    let scope = AstScope::new(CHANNEL);
    let value = AstFunctionCatalog::call(
        &adapter,
        &scope,
        "start.poll",
        &[JsValue::string("Question;A/B;30;0")],
    )
    .await
    .expect("catalog call");
    assert_eq!(js_string(&value).to_utf8().expect("text"), "");
    assert_eq!(polls.calls().len(), 1);

    // The source handler returns its validation text; it does not throw.
    let invalid = AstFunctionCatalog::call(
        &adapter,
        &scope,
        "start.poll",
        &[JsValue::string("Question;A;30")],
    )
    .await
    .expect("validation text");
    assert_eq!(js_string(&invalid).to_utf8().expect("text"), START_POLL_FORMAT);
    assert_eq!(polls.calls().len(), 1);

    let error = AstFunctionCatalog::call(&adapter, &scope, "get.poll", &[])
        .await
        .expect_err("unsupported function");
    assert!(matches!(error, AstRuntimeError::Unsupported(_)));
}

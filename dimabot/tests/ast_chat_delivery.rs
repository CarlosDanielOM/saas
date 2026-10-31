#![cfg(feature = "ast-bot-runtime")]

//! Behavioural checks for the native AST chat delivery loop
//! ([`dima_rust::utils::ast_runtime::delivery`]).
//!
//! In-memory fakes only: no MongoDB, Redis, Twitch client, network or Docker.
//! Each case pins one of the source's operational rules
//! (`dimabot/src/utils/ast_command_delivery.ts`).

use std::{cell::RefCell, collections::VecDeque, rc::Rc};

use dima_rust::utils::{
    ast_evaluator::{
        CommandRefBudget, CommandReference, CommandReferenceState, JsString, JsValue,
    },
    ast_runtime::{
        AstMessage, AstRuntimeError, BoxFuture, ChatSender, CommandExecutionResult, CommandRunner,
        SendResult,
        delivery::{AST_MESSAGE_DELIVERED, DeliverySeams, deliver_ast_message},
    },
};

type EventLog = Rc<RefCell<Vec<String>>>;

enum Step {
    Reply(CommandExecutionResult),
    Fail(AstRuntimeError),
}

struct FakeSender {
    log: EventLog,
    fail_text: Option<String>,
}

impl FakeSender {
    fn new(log: EventLog) -> Self {
        Self {
            log,
            fail_text: None,
        }
    }

    fn failing_on(log: EventLog, text: &str) -> Self {
        Self {
            log,
            fail_text: Some(text.to_owned()),
        }
    }
}

impl ChatSender for FakeSender {
    fn send<'a>(
        &'a mut self,
        channel_id: &'a str,
        text: &'a str,
    ) -> BoxFuture<'a, Result<SendResult, AstRuntimeError>> {
        Box::pin(async move {
            self.log
                .borrow_mut()
                .push(format!("send {channel_id} {text}"));
            if self.fail_text.as_deref() == Some(text) {
                return Ok(SendResult::failure("send rejected", 500));
            }
            Ok(SendResult::ok("sent"))
        })
    }
}

struct FakeRunner {
    log: EventLog,
    steps: VecDeque<Step>,
}

impl FakeRunner {
    fn new(log: EventLog, steps: Vec<Step>) -> Self {
        Self {
            log,
            steps: steps.into(),
        }
    }
}

impl CommandRunner for FakeRunner {
    fn execute<'a>(
        &'a mut self,
        request: &'a CommandReference,
    ) -> BoxFuture<'a, Result<CommandExecutionResult, AstRuntimeError>> {
        Box::pin(async move {
            self.log
                .borrow_mut()
                .push(format!("exec {}", request.command_name));
            match self.steps.pop_front() {
                Some(Step::Reply(result)) => Ok(result),
                Some(Step::Fail(error)) => Err(error),
                None => Err(AstRuntimeError::Rejected(
                    "fake runner has no step left".into(),
                )),
            }
        })
    }
}

fn reference(channel_id: &str, command_name: &str) -> CommandReference {
    CommandReference {
        effect_context: None,
        channel_id: channel_id.to_owned(),
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

fn reply(message: &str, command_references: Vec<CommandReference>) -> CommandExecutionResult {
    CommandExecutionResult {
        error: false,
        message: message.to_owned(),
        status: Some(200),
        type_name: "success".into(),
        command_references,
    }
}

fn failed_reference(message: &str) -> CommandExecutionResult {
    CommandExecutionResult {
        error: true,
        message: message.to_owned(),
        status: Some(400),
        type_name: "command_disabled".into(),
        command_references: Vec::new(),
    }
}

/// The outer text is sent before any reference executes.
#[tokio::test]
async fn outer_text_precedes_reference_execution() {
    let log: EventLog = Rc::new(RefCell::new(Vec::new()));
    let mut sender = FakeSender::new(Rc::clone(&log));
    let mut runner = FakeRunner::new(
        Rc::clone(&log),
        vec![Step::Reply(reply("nested", Vec::new()))],
    );
    let mut message = AstMessage {
        parsed_text: "  hello  ".into(),
        command_references: vec![reference("channel-b", "poke")],
    };

    let result = deliver_ast_message(
        "channel-a",
        &mut message,
        true,
        DeliverySeams::new(&mut sender, &mut runner),
    )
    .await
    .expect("delivery succeeds");

    assert!(!result.error);
    assert_eq!(result.message, AST_MESSAGE_DELIVERED);
    assert_eq!(result.status, Some(200));
    assert_eq!(
        *log.borrow(),
        vec![
            "send channel-a hello".to_owned(),
            "exec poke".to_owned(),
            "send channel-b nested".to_owned(),
        ]
    );
}

/// An empty outer message still dispatches its references.
#[tokio::test]
async fn empty_outer_text_still_dispatches_references() {
    let log: EventLog = Rc::new(RefCell::new(Vec::new()));
    let mut sender = FakeSender::new(Rc::clone(&log));
    let mut runner = FakeRunner::new(
        Rc::clone(&log),
        vec![Step::Reply(reply("", Vec::new()))],
    );
    let mut message = AstMessage {
        parsed_text: "   ".into(),
        command_references: vec![reference("channel-b", "poke")],
    };

    let result = deliver_ast_message(
        "channel-a",
        &mut message,
        true,
        DeliverySeams::new(&mut sender, &mut runner),
    )
    .await
    .expect("delivery succeeds");

    assert_eq!(result.message, AST_MESSAGE_DELIVERED);
    // The blank outer text is never sent; the reference still runs.
    assert_eq!(*log.borrow(), vec!["exec poke".to_owned()]);
}

/// A failing outer send stops reference execution entirely.
#[tokio::test]
async fn failing_outer_send_skips_references() {
    let log: EventLog = Rc::new(RefCell::new(Vec::new()));
    let mut sender = FakeSender::failing_on(Rc::clone(&log), "boom");
    let mut runner = FakeRunner::new(
        Rc::clone(&log),
        vec![Step::Reply(reply("nested", Vec::new()))],
    );
    let mut message = AstMessage {
        parsed_text: "boom".into(),
        command_references: vec![reference("channel-b", "poke")],
    };

    let result = deliver_ast_message(
        "channel-a",
        &mut message,
        true,
        DeliverySeams::new(&mut sender, &mut runner),
    )
    .await
    .expect("the send failure is a result, not a runtime error");

    assert!(result.error);
    assert_eq!(result.message, "send rejected");
    assert_eq!(result.status, Some(500));
    assert_eq!(*log.borrow(), vec!["send channel-a boom".to_owned()]);
    // The reference was never dispatched, so its step is still queued.
    assert_eq!(runner.steps.len(), 1);
}

/// A failing reference does not abort the remaining references, whether it
/// reports `error == true` or fails as a runtime error.
#[tokio::test]
async fn failing_reference_continues_with_the_rest() {
    let log: EventLog = Rc::new(RefCell::new(Vec::new()));
    let mut sender = FakeSender::new(Rc::clone(&log));
    let mut runner = FakeRunner::new(
        Rc::clone(&log),
        vec![
            Step::Reply(failed_reference("disabled")),
            Step::Fail(AstRuntimeError::Rejected("exploded".into())),
            Step::Reply(reply("last", Vec::new())),
        ],
    );
    let mut message = AstMessage {
        parsed_text: String::new(),
        command_references: vec![
            reference("channel-b", "first"),
            reference("channel-c", "second"),
            reference("channel-d", "third"),
        ],
    };

    let result = deliver_ast_message(
        "channel-a",
        &mut message,
        true,
        DeliverySeams::new(&mut sender, &mut runner),
    )
    .await
    .expect("reference failures never abort delivery");

    assert!(!result.error);
    assert_eq!(result.message, AST_MESSAGE_DELIVERED);
    assert_eq!(
        *log.borrow(),
        vec![
            "exec first".to_owned(),
            "exec second".to_owned(),
            "exec third".to_owned(),
            "send channel-d last".to_owned(),
        ]
    );
}

/// The reference queue is drained once, so a second delivery sends nothing.
#[tokio::test]
async fn reference_queue_is_drained_once() {
    let log: EventLog = Rc::new(RefCell::new(Vec::new()));
    let mut sender = FakeSender::new(Rc::clone(&log));
    let mut runner = FakeRunner::new(
        Rc::clone(&log),
        vec![Step::Reply(reply("nested", Vec::new()))],
    );
    // Reference delivery always runs with an empty rendered text, so only the
    // drained queue can produce work on a second pass.
    let mut message = AstMessage {
        parsed_text: String::new(),
        command_references: vec![reference("channel-b", "poke")],
    };

    deliver_ast_message(
        "channel-a",
        &mut message,
        true,
        DeliverySeams::new(&mut sender, &mut runner),
    )
    .await
    .expect("first delivery succeeds");

    assert!(message.command_references.is_empty());
    assert_eq!(
        *log.borrow(),
        vec![
            "exec poke".to_owned(),
            "send channel-b nested".to_owned(),
        ]
    );

    // The queue is empty, so a second pass dispatches nothing.
    let second = deliver_ast_message(
        "channel-a",
        &mut message,
        true,
        DeliverySeams::new(&mut sender, &mut runner),
    )
    .await
    .expect("second delivery succeeds");

    assert_eq!(second.message, AST_MESSAGE_DELIVERED);
    assert_eq!(
        *log.borrow(),
        vec![
            "exec poke".to_owned(),
            "send channel-b nested".to_owned(),
        ]
    );
    // The single queued step was consumed exactly once.
    assert!(runner.steps.is_empty());
}

/// Nested references are delivered in authored order, each under its own
/// referenced channel.
#[tokio::test]
async fn nested_references_keep_order_and_channels() {
    let log: EventLog = Rc::new(RefCell::new(Vec::new()));
    let mut sender = FakeSender::new(Rc::clone(&log));
    let mut runner = FakeRunner::new(
        Rc::clone(&log),
        vec![
            Step::Reply(reply(
                "one",
                vec![
                    reference("channel-c", "kid-one"),
                    reference("channel-d", "kid-two"),
                ],
            )),
            Step::Reply(reply("kid-text-one", Vec::new())),
            Step::Reply(reply("kid-text-two", Vec::new())),
            Step::Reply(reply("two", Vec::new())),
        ],
    );
    let mut message = AstMessage {
        parsed_text: "hello".into(),
        command_references: vec![
            reference("channel-b", "outer-one"),
            reference("channel-e", "outer-two"),
        ],
    };

    let result = deliver_ast_message(
        "channel-a",
        &mut message,
        true,
        DeliverySeams::new(&mut sender, &mut runner),
    )
    .await
    .expect("delivery succeeds");

    assert_eq!(result.message, AST_MESSAGE_DELIVERED);
    assert_eq!(
        *log.borrow(),
        vec![
            "send channel-a hello".to_owned(),
            "exec outer-one".to_owned(),
            "send channel-b one".to_owned(),
            "exec kid-one".to_owned(),
            "send channel-c kid-text-one".to_owned(),
            "exec kid-two".to_owned(),
            "send channel-d kid-text-two".to_owned(),
            "exec outer-two".to_owned(),
            "send channel-e two".to_owned(),
        ]
    );
}

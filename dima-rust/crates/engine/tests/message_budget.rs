//! One budget per message (`dima_engine::eval::MessageBudget`): the command a message runs and
//! every command reference it starts, at any depth, draw their work, host calls, memory and
//! output from one budget of the per-run figures times `EvalLimits::message_factor`; each run
//! keeps its own limits too.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod memory;

use dima_engine::context::{Context, Plan, State};
use dima_engine::eval::{EvalError, EvalLimits, EvalStats, LimitKind, MessageLimits, PerPlan};
use memory::{Delivery, MemoryHost, block_on, deliver, engine_with};
use std::collections::HashMap;

fn context() -> Context {
    Context {
        broadcaster_id: "1".into(),
        user_id: "1".into(),
        user_login: "caller".into(),
        user_plan: Plan::Pro,
        enforce_function_permissions: false,
        command_name: "top".into(),
        ..Context::default()
    }
}

/// What `source` costs as a message of its own.
fn cost(source: &str) -> (EvalStats, usize) {
    let engine = engine_with(&[]);
    let template = engine.compile(source).unwrap();
    let mut host = MemoryHost::new(1);
    let rendered =
        block_on(engine.render(&template, &context(), State::default(), &mut host)).unwrap();
    (rendered.stats, rendered.text.len())
}

/// `top` starts four references to `heavy`, which costs about two thirds of a run's limit:
/// each fits its own run; the message's budget (twice a run's) holds the top and two of them.
fn four_references(heavy: &str, limits: EvalLimits) -> Delivery {
    let engine = engine_with(&[]).with_limits(limits);
    let commands = HashMap::from([("heavy".to_owned(), heavy.to_owned())]);
    let mut host = MemoryHost::new(1);
    deliver(
        &engine,
        &commands,
        "#(heavy) #(heavy) #(heavy) #(heavy)",
        &context(),
        &mut host,
    )
}

fn marker(kind: LimitKind) -> String {
    format!("[Parse error: {}]", kind.message())
}

/// The runs of a delivery: the top, two full references, the third stopped midway with
/// `kind` (each of its later expressions too), the fourth refused.
fn assert_stopped_at_third(delivery: &Delivery, kind: LimitKind) {
    let runs = &delivery.runs;
    assert_eq!(runs.len(), 5, "{runs:?}");
    for (name, outcome) in &runs[..3] {
        let text = outcome.as_ref().unwrap();
        assert!(!text.contains("[Parse error"), "{name}: {text}");
    }
    let third = runs[3].1.as_ref().unwrap();
    assert!(third.contains(&marker(kind)), "{third}");
    assert_eq!(runs[4].1, Err(EvalError::Limit(kind)));
    assert_eq!(delivery.budget.stopped(), Some(kind));
}

const WORK: &str = "*(for #i = 0; #i < 40; #i++ { *(for #j = 0; #j < 40; #j++ { *(1 + #j) }) })";

#[test]
fn a_message_and_its_references_share_one_work_budget() {
    let (stats, _) = cost(WORK);
    let heavy = format!("{WORK} after *(1 + 1)");
    let limits = EvalLimits {
        steps: PerPlan::all(stats.steps * 3 / 2),
        message_factor: 2,
        ..EvalLimits::default()
    };
    let delivery = four_references(&heavy, limits);
    assert_stopped_at_third(&delivery, LimitKind::Steps);
    // Once the message stopped, the run's later expressions stop too.
    let third = delivery.runs[3].1.as_ref().unwrap();
    assert_eq!(
        third.matches(&marker(LimitKind::Steps)).count(),
        2,
        "{third}"
    );
    let usage = delivery.budget.usage();
    assert!(usage.steps <= stats.steps * 3, "{usage:?}");
    // Each run alone stays within its own limit: without the shared budget all four complete.
    let alone = EvalLimits {
        message_factor: 100,
        ..limits
    };
    let delivery = four_references(&heavy, alone);
    assert!(delivery.runs.iter().all(|(_, outcome)| {
        outcome
            .as_ref()
            .is_ok_and(|text| !text.contains("[Parse error"))
    }));
}

#[test]
fn a_message_and_its_references_share_one_host_call_budget() {
    let calls = "*(for #i = 0; #i < 40; #i++ { %(#x #i) })";
    let (stats, _) = cost(calls);
    let limits = EvalLimits {
        // The top makes no host call: three references would fit exactly.
        host_calls: PerPlan::all(stats.host_calls * 3 / 2 - 1),
        message_factor: 2,
        ..EvalLimits::default()
    };
    let delivery = four_references(calls, limits);
    assert_stopped_at_third(&delivery, LimitKind::HostCalls);
    assert!(delivery.budget.usage().host_calls <= stats.host_calls * 3);
}

#[test]
fn a_message_and_its_references_share_one_memory_budget() {
    let keeps = format!("%(big {})", "m".repeat(1000));
    let limits = EvalLimits {
        memory_bytes: 1500,
        message_factor: 2,
        ..EvalLimits::default()
    };
    let delivery = four_references(&keeps, limits);
    assert_stopped_at_third(&delivery, LimitKind::Memory);
    assert!(delivery.budget.usage().memory_bytes <= 3000);
}

#[test]
fn a_message_and_its_references_share_one_output_budget() {
    let says = "o".repeat(1000);
    let limits = EvalLimits {
        text_bytes: 1500,
        message_factor: 2,
        ..EvalLimits::default()
    };
    let delivery = four_references(&says, limits);
    // The top's three spaces, two references, and what fits of the third, then the limit.
    let runs = &delivery.runs;
    assert_eq!(runs.len(), 5, "{runs:?}");
    let third = runs[3].1.as_ref().unwrap();
    let kept = 3000 - 3 - 2000;
    assert_eq!(
        *third,
        format!("{}{}", "o".repeat(kept), marker(LimitKind::TextSize))
    );
    assert_eq!(runs[4].1, Err(EvalError::Limit(LimitKind::TextSize)));
    assert_eq!(delivery.budget.usage().output_bytes, 3000);
}

#[test]
fn references_carry_the_message_budget_and_a_new_message_starts_a_new_one() {
    let engine = engine_with(&[]);
    let template = engine.compile("#(a) #(b)").unwrap();
    let mut host = MemoryHost::new(1);
    let first =
        block_on(engine.render(&template, &context(), State::default(), &mut host)).unwrap();
    let second =
        block_on(engine.render(&template, &context(), State::default(), &mut host)).unwrap();
    assert_eq!(first.state.command_references.len(), 2);
    for reference in &first.state.command_references {
        assert!(reference.state.message.same(&first.budget));
    }
    assert!(!first.budget.same(&second.budget));
    assert_eq!(
        first.budget.limits(),
        MessageLimits::of(&EvalLimits::default(), Plan::Pro)
    );
}

#[test]
fn a_reference_keeps_its_own_limits() {
    let (stats, _) = cost(WORK);
    let limits = EvalLimits {
        steps: PerPlan::all(stats.steps / 2),
        message_factor: 10,
        ..EvalLimits::default()
    };
    let delivery = four_references(WORK, limits);
    // Every reference stops at its own limit; the message's budget has room for all of them.
    assert_eq!(delivery.runs.len(), 5);
    for (_, outcome) in &delivery.runs[1..] {
        assert_eq!(*outcome.as_ref().unwrap(), marker(LimitKind::Steps));
    }
    assert_eq!(delivery.budget.stopped(), None);
}

// ---- the deadline ----

fn deadline_limits(millis: u64) -> EvalLimits {
    EvalLimits {
        deadline_ms: PerPlan::all(millis),
        ..EvalLimits::default()
    }
}

#[test]
fn a_message_stops_at_its_deadline() {
    // `slow` takes four seconds of the host's clock; the message has ten.
    let engine = engine_with(&[("slow", None)]).with_limits(deadline_limits(10_000));
    let host = MemoryHost::new(1);
    let clock = host.clock.now.clone();
    let mut host = host.answer("slow", move |_, _| {
        clock.advance(4_000);
        dima_engine::value::Value::Text("done".into())
    });
    let commands = HashMap::from([("r".to_owned(), "$(slow) then *(1 + 1)".to_owned())]);
    let delivery = deliver(
        &engine,
        &commands,
        "#(r) #(r) #(r) #(r)",
        &context(),
        &mut host,
    );
    let runs = &delivery.runs;
    assert_eq!(runs.len(), 5, "{runs:?}");
    assert_eq!(*runs[1].1.as_ref().unwrap(), "done then 2");
    assert_eq!(*runs[2].1.as_ref().unwrap(), "done then 2");
    // The third call ends past the deadline: its answer is dropped, and the run's later
    // expressions stop too.
    let stopped = marker(LimitKind::Deadline);
    assert_eq!(
        *runs[3].1.as_ref().unwrap(),
        format!("{stopped} then {stopped}")
    );
    assert_eq!(runs[4].1, Err(EvalError::Limit(LimitKind::Deadline)));
    assert_eq!(delivery.budget.stopped(), Some(LimitKind::Deadline));
}

#[test]
fn a_host_call_in_flight_is_dropped_at_the_deadline() {
    let engine = engine_with(&[("hang", None)]).with_limits(deadline_limits(10_000));
    let template = engine.compile("a $(hang) b *(1 + 1)").unwrap();
    let mut host = MemoryHost::new(1);
    // The call moves the clock eleven seconds on and never answers.
    host.hang = Some(("hang", 11_000));
    let rendered =
        block_on(engine.render(&template, &context(), State::default(), &mut host)).unwrap();
    let stopped = marker(LimitKind::Deadline);
    assert_eq!(rendered.text, format!("a {stopped} b {stopped}"));
    assert!(
        host.hung_call_dropped
            .load(std::sync::atomic::Ordering::SeqCst)
    );
}

#[test]
fn a_delay_is_cut_at_the_deadline() {
    let engine = engine_with(&[]).with_limits(deadline_limits(10_000));
    let template = engine.compile("$(delay 6) one $(delay 6) two").unwrap();
    let mut host = MemoryHost::new(1);
    host.sleep_moves_clock = true;
    let rendered =
        block_on(engine.render(&template, &context(), State::default(), &mut host)).unwrap();
    let stopped = marker(LimitKind::Deadline);
    assert_eq!(rendered.text, format!(" one {stopped} two"));
}

#[test]
fn work_reads_the_clock_once_per_lease_and_stops_at_the_deadline() {
    use std::sync::atomic::Ordering::SeqCst;
    let (stats, _) = cost(WORK);
    assert_eq!(stats.host_calls, 0);
    let engine = engine_with(&[]).with_limits(deadline_limits(10_000));
    let template = engine.compile(WORK).unwrap();
    let mut host = MemoryHost::new(1);
    host.clock.tick.store(1, SeqCst);
    let rendered =
        block_on(engine.render(&template, &context(), State::default(), &mut host)).unwrap();
    assert!(!rendered.text.contains("[Parse error"));
    // One read when the message starts, one per lease of 1,024 units.
    let reads = host.clock.reads.load(SeqCst);
    assert_eq!(
        reads,
        1 + stats.steps.div_ceil(1024),
        "{} steps",
        stats.steps
    );
    // With a clock that moves a second per read, the same work passes ten seconds.
    let mut host = MemoryHost::new(1);
    host.clock.tick.store(1_000, SeqCst);
    let rendered =
        block_on(engine.render(&template, &context(), State::default(), &mut host)).unwrap();
    assert_eq!(rendered.text, marker(LimitKind::Deadline));
    assert_eq!(host.clock.reads.load(SeqCst), 11);
}

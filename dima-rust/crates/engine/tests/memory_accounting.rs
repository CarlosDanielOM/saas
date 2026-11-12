//! What a command builds is charged before it is built: the response list (written by index
//! or appended to) and the values read from storage (re-check R1 to R3 of
//! `ledger/reviews/engine-evaluator-2026-11-11.md`, each with the review's own command).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod memory;

use dima_engine::context::{Context, Plan, State};
use dima_engine::eval::{EvalLimits, LimitKind, Rendered};
use memory::{MemoryHost, engine_with, render};

fn context() -> Context {
    Context {
        broadcaster_id: "1".into(),
        user_id: "1".into(),
        user_login: "caller".into(),
        user_plan: Plan::Pro,
        enforce_function_permissions: false,
        ..Context::default()
    }
}

fn marker(kind: LimitKind) -> String {
    format!("[Parse error: {}]", kind.message())
}

fn run(limits: EvalLimits, host: &mut MemoryHost, source: &str) -> Rendered {
    let engine = engine_with(&[]).with_limits(limits);
    render(&engine, source, &context(), State::default(), host)
}

/// `%(x a)`, then `x` doubled `doublings` times: `x` is 2^doublings bytes of `a`.
fn doubled(doublings: usize) -> String {
    let mut text = String::from("%(x a)");
    for _ in 0..doublings {
        text.push_str(" %(x \"${%(x)}${%(x)}\")");
    }
    text
}

fn total_len(items: &[String]) -> usize {
    items.iter().map(String::len).sum()
}

/// R1: a loop of 100 `%(responses[] "")`, then a loop of 100 `%(responses[#i] %(x))` with `x`
/// 131,072 bytes. Before the fix: 13,107,200 bytes of responses with 131,073 bytes charged.
const R1_LOOPS: &str = "*(for #i = 0; #i < 100; #i++ { %(responses[] \"\") }) \
                        *(for #i = 0; #i < 100; #i++ { %(responses[#i] %(x)) })";

#[test]
fn a_response_written_by_index_is_charged_before_it_replaces_a_slot() {
    let limits = EvalLimits::default();
    let mut host = MemoryHost::new(1);
    let rendered = run(limits, &mut host, &format!("{} {R1_LOOPS}", doubled(17)));
    let responses = &rendered.state.command_responses;
    let usage = rendered.budget.usage();
    println!(
        "R1: {} bytes in {} responses, {} bytes charged, {} steps; {:?}",
        total_len(responses),
        responses.len(),
        usage.memory_bytes,
        rendered.stats.steps,
        rendered.text.get(rendered.text.len().saturating_sub(80)..)
    );
    // The third write would take the list past the text budget: refused, nothing changed.
    assert!(
        rendered.text.ends_with(&marker(LimitKind::TextSize)),
        "{}",
        rendered.text.len()
    );
    assert_eq!(responses.len(), 100);
    assert_eq!(total_len(responses), 2 * 131_072);
    assert!(total_len(responses) <= limits.text_bytes);
    assert_eq!(host.responses, *responses);
    // What is kept is charged: the variable and both full slots.
    assert!(usage.memory_bytes as usize >= 3 * 131_072, "{usage:?}");

    // With a smaller memory budget the first replacement does not fit: nothing changes.
    let small = EvalLimits {
        memory_bytes: 200 * 1024,
        ..EvalLimits::default()
    };
    let mut host = MemoryHost::new(1);
    let rendered = run(small, &mut host, &format!("{} {R1_LOOPS}", doubled(17)));
    assert!(
        rendered.text.ends_with(&marker(LimitKind::Memory)),
        "{}",
        rendered.text
    );
    let responses = &rendered.state.command_responses;
    assert_eq!(responses.len(), 100);
    assert_eq!(total_len(responses), 0);
    assert_eq!(host.responses, *responses);
    assert!(rendered.budget.usage().memory_bytes <= small.memory_bytes as u64 * 2);
}

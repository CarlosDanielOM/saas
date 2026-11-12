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

/// `l` stored as a channel variable: a list holding a list of 1,024 empty strings.
fn r2_host() -> MemoryHost {
    let mut host = MemoryHost::new(1);
    let inner = vec!["\"\""; 1024].join(",");
    host.channel.insert("l".into(), format!("[[{inner}]]"));
    host
}

/// R2: a loop of 100 `%(responses[] %(*l[0]))`. Before the fix: 102,400 entries with 3,076
/// bytes charged, each append rescanning the list.
const R2: &str = "*(for #i = 0; #i < 100; #i++ { %(responses[] %(*l[0])) })";

#[test]
fn every_response_entry_costs_something_and_the_list_has_a_limit() {
    // The default entry limit refuses the first append of 1,024 entries: nothing is added.
    let limits = EvalLimits::default();
    let mut host = r2_host();
    let rendered = run(limits, &mut host, R2);
    let usage = rendered.budget.usage();
    println!(
        "R2 (default limits): {} entries, {} bytes charged, {} steps; {}",
        rendered.state.command_responses.len(),
        usage.memory_bytes,
        rendered.stats.steps,
        rendered.text
    );
    assert_eq!(rendered.text, marker(LimitKind::Memory));
    assert!(rendered.state.command_responses.is_empty());
    assert!(host.responses.is_empty());
    assert!(limits.response_entries < 1024);

    // Without the entry limit, the 102,400 empty entries are each charged their overhead and
    // their serialised size (two bytes).
    let unlimited = EvalLimits {
        response_entries: usize::MAX,
        ..EvalLimits::default()
    };
    let mut host = r2_host();
    let rendered = run(unlimited, &mut host, R2);
    let usage = rendered.budget.usage();
    let entries = rendered.state.command_responses.len();
    println!(
        "R2 (no entry limit): {entries} entries, {} bytes charged, {} steps; {}",
        usage.memory_bytes, rendered.stats.steps, rendered.text
    );
    assert_eq!(entries, 102_400);
    let per_entry = (dima_engine::eval::KEPT_ENTRY_BYTES + 2) as u64;
    assert!(usage.memory_bytes >= 102_400 * per_entry, "{usage:?}");

    // Appending many entries at once is charged for all of them before any is added.
    let tight = EvalLimits {
        response_entries: usize::MAX,
        memory_bytes: 1024 * dima_engine::eval::KEPT_ENTRY_BYTES,
        ..EvalLimits::default()
    };
    let mut host = r2_host();
    let rendered = run(tight, &mut host, R2);
    assert_eq!(rendered.text, marker(LimitKind::Memory));
    assert!(rendered.state.command_responses.is_empty());
    assert!(host.responses.is_empty());

    // One at a time, the list stops at the entry limit exactly.
    let few = EvalLimits {
        response_entries: 150,
        ..EvalLimits::default()
    };
    let mut host = MemoryHost::new(1);
    let rendered = run(
        few,
        &mut host,
        "*(for #i = 0; #i < 100; #i++ { *(for #j = 0; #j < 2; #j++ { %(responses[] \"\") }) })",
    );
    assert_eq!(rendered.text, marker(LimitKind::Memory));
    assert_eq!(rendered.state.command_responses.len(), 150);
    assert_eq!(host.responses.len(), 150);
}

#[test]
fn kept_entries_and_reference_arguments_cost_their_overhead() {
    let overhead = dima_engine::eval::KEPT_ENTRY_BYTES as u64;
    // Two empty memory variables with one-byte names.
    let mut host = MemoryHost::new(1);
    let rendered = run(EvalLimits::default(), &mut host, "%(a \"\") %(b \"\")");
    assert_eq!(rendered.budget.usage().memory_bytes, 2 * (1 + overhead));
    // A command reference with no argument keeps its entry and its event data.
    let mut host = MemoryHost::new(1);
    let rendered = run(EvalLimits::default(), &mut host, "#(other)");
    assert_eq!(rendered.state.command_references.len(), 1);
    assert!(rendered.budget.usage().memory_bytes > overhead);
}

//! Built-in functions and aggregates cannot allocate past the text budget: a result over it is
//! the limit error, raised before the allocation.
//!
//! Allocation is measured as the process's peak resident memory (`VmHWM`), reset before each
//! case through `/proc/self/clear_refs`. A counting global allocator would need `unsafe`, which
//! the workspace forbids in every target of every crate (`unsafe_code = "forbid"` cannot be
//! lowered by a local `allow`). Every byte these functions allocate is written, so the resident
//! peak sees it. This binary has one test, so nothing else runs in the process meanwhile.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod memory;

use dima_engine::context::{Context, Plan, State};
use dima_engine::eval::{EvalLimits, LimitKind};
use memory::{MemoryHost, TEST_STACK, engine_with};

/// The process's peak resident memory, in bytes.
fn peak_resident() -> usize {
    let status = std::fs::read_to_string("/proc/self/status").unwrap();
    let line = status
        .lines()
        .find(|line| line.starts_with("VmHWM:"))
        .unwrap();
    let kib: usize = line
        .trim_start_matches("VmHWM:")
        .trim()
        .trim_end_matches("kB")
        .trim()
        .parse()
        .unwrap();
    kib * 1024
}

/// Resets the peak to the current resident size.
fn reset_peak() {
    std::fs::write("/proc/self/clear_refs", "5").unwrap();
}

/// `%(x a)`, then `x` doubled `doublings` times: `x` is 2^doublings bytes of `a`.
fn doubled(doublings: usize) -> String {
    let mut text = String::from("%(x a)");
    for _ in 0..doublings {
        text.push_str(" %(x \"${%(x)}${%(x)}\")");
    }
    text
}

/// Renders `source` with `text_bytes` as the budget; returns the output and the growth of the
/// peak resident memory over the render.
fn measure(text_bytes: usize, source: &str) -> (String, usize) {
    // The memory budget keeps its default ratio to the text budget (16 to 1).
    let engine = engine_with(&[]).with_limits(EvalLimits {
        text_bytes,
        memory_bytes: 16 * text_bytes,
        ..EvalLimits::default()
    });
    let template = engine.compile(source).unwrap();
    let context = Context {
        user_plan: Plan::Pro,
        ..Context::default()
    };
    let mut host = MemoryHost::new(1);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    // Warm up with a small command: the runtime, the registry and the regex tables are
    // allocated once. The measured command itself runs cold.
    let warm = engine
        .compile("%(w a) $(upper %(w)) $(title %(w)) $(replace a b %(w)) %(l %[%(w)])")
        .unwrap();
    drop(runtime.block_on(engine.render(&warm, &context, State::default(), &mut host)));
    reset_peak();
    let before = peak_resident();
    let rendered = runtime
        .block_on(engine.render(&template, &context, State::default(), &mut host))
        .unwrap();
    let growth = peak_resident().saturating_sub(before);
    (rendered.text, growth)
}

fn limit_text(kind: LimitKind) -> String {
    format!("[Parse error: {}]", kind.message())
}

#[test]
fn builtins_and_aggregates_stay_within_a_small_multiple_of_the_budget() {
    // On a registered thread (the stack contract, `dima_engine::stack`).
    dima_engine::stack::run_on_thread(TEST_STACK, check).unwrap();
}

fn check() {
    // Reduced budget first: before the fix, this `replace` built 256 MiB.
    let small = 16 * 1024;
    let text = LimitKind::TextSize;
    let cases: Vec<(&str, LimitKind, String)> = vec![
        // The review's case: two 2^k-byte arguments, every byte replaced by the whole text.
        (
            "replace",
            text,
            format!("{} $(replace a %(x) %(x))", doubled(14)),
        ),
        // Joins of many in-budget arguments (each builtin joins its arguments).
        (
            "upper",
            text,
            format!("{} $(upper {})", doubled(14), "%(x) ".repeat(64)),
        ),
        (
            "slice",
            text,
            format!("{} $(slice 0 {})", doubled(14), "%(x) ".repeat(64)),
        ),
        // A list built item by item.
        (
            "list",
            text,
            format!("{} %(l %[{}])", doubled(14), vec!["%(x)"; 64].join(",")),
        ),
        // A command reference's argument.
        (
            "reference",
            text,
            format!("{} #(other {})", doubled(14), "%(x) ".repeat(64)),
        ),
        // Variables assembled from parts: each in budget, together far over it.
        (
            "variables",
            LimitKind::Memory,
            format!(
                "{} {}",
                doubled(14),
                (0..256)
                    .map(|n| format!("%(v{n} %(x))"))
                    .collect::<Vec<_>>()
                    .join(" ")
            ),
        ),
        // Case mapping that grows: `ŉ` (2 bytes) uppercases to `ʼN` (3 bytes).
        (
            "upper-grows",
            text,
            format!(
                "%(y ŉ) {} $(upper %(y))",
                (0..13)
                    .map(|_| " %(y \"${%(y)}${%(y)}\")")
                    .collect::<String>()
            ),
        ),
    ];
    for (name, kind, source) in &cases {
        let (text, growth) = measure(small, source);
        println!("{name}: peak +{growth} bytes, budget {small}");
        assert!(
            text.ends_with(&limit_text(*kind)),
            "{name}: {:?}",
            text.get(text.len().saturating_sub(120)..)
        );
        assert!(
            growth <= 64 * small,
            "{name}: the peak grew by {growth} bytes for a {small}-byte budget"
        );
    }
    // The review's case at the default budget (256 KiB): a 64 GiB result before the fix.
    let default = EvalLimits::default().text_bytes;
    let (text, growth) = measure(default, &format!("{} $(replace a %(x) %(x))", doubled(18)));
    println!("replace at the default budget: peak +{growth} bytes, budget {default}");
    assert!(
        text.ends_with(&limit_text(LimitKind::TextSize)),
        "{:?}",
        text.get(..80)
    );
    assert!(
        growth <= 64 * default,
        "the peak grew by {growth} bytes for a {default}-byte budget"
    );
}

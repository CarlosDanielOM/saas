//! Input and work budgets: the text the parser gets has viewer arguments substituted, so it may
//! be longer than a stored command; budgets follow the input's length.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "support/placeholders.rs"]
mod placeholders;

use dima_engine::syntax::{
    DiagnosticCode, MAX_ARGUMENT_CHARS, MAX_INPUT_CHARS, MAX_SOURCE_CHARS, SegmentStep,
    SyntaxEngine,
};

#[test]
fn substitution_follows_the_reference() {
    let resolve = |text: &str, argument: &str| placeholders::resolve(text, argument, false);
    assert_eq!(
        resolve("a &p2 &p1 b", " x  y z ").as_deref(),
        Some("a y x b")
    );
    assert_eq!(resolve("&p1 &t", "x y z").as_deref(), Some("x y z"));
    assert_eq!(
        resolve("&t|&t &tx &p0", "x y").as_deref(),
        Some("x y|x y &tx ")
    );
    assert_eq!(resolve("&t &p3", "x y z"), None, "a new &pN after &t");
    assert_eq!(resolve("&p3 &t &p3", "x y z").as_deref(), Some("z  z"));
    assert_eq!(
        placeholders::resolve("&p1 &t", "x y", true).as_deref(),
        Some(
            "%(cmd_arg_00000000000000000000000000000000_0) \
             %(cmd_arg_00000000000000000000000000000000_1)"
        )
    );
    assert_eq!(placeholders::worst_case("&p1-&t&p22", "ab"), "ab-abab");
}

#[test]
fn a_stored_command_with_a_long_argument_parses_past_the_source_limit() {
    let engine = SyntaxEngine::default();
    let stored = "$(say &p1) ".repeat(30);
    assert!(engine.check_source(&stored).is_ok());
    let argument = "x".repeat(400);
    let text = placeholders::resolve(&stored, &argument, false).unwrap();
    assert!(
        dima_text::char_len(&text) > MAX_SOURCE_CHARS,
        "{}",
        text.len()
    );
    let plan = engine
        .compile_template(&text)
        .expect("the reference renders it");
    let programs = plan
        .segments()
        .iter()
        .filter(|segment| matches!(segment.step(), SegmentStep::Program(_)))
        .count();
    assert_eq!(programs, 30);
    assert!(engine.parse(&text).is_ok());
}

#[test]
fn the_input_budget_is_the_worst_substitution_of_a_stored_command() {
    // `&t` is the shortest placeholder and takes the whole argument.
    assert_eq!(
        MAX_INPUT_CHARS,
        MAX_SOURCE_CHARS / "&t".len() * MAX_ARGUMENT_CHARS
    );
    let engine = SyntaxEngine::default();
    let stored = "&t".repeat(MAX_SOURCE_CHARS / 2);
    assert!(engine.check_source(&stored).is_ok());
    let argument = "😀".repeat(MAX_ARGUMENT_CHARS);
    let text = placeholders::resolve(&stored, &argument, false).unwrap();
    assert_eq!(dima_text::char_len(&text), MAX_INPUT_CHARS);
    assert!(engine.compile_template(&text).is_ok());
    assert!(engine.parse(&text).is_ok());
    let over = format!("{text}x");
    for error in [
        engine.parse(&over).unwrap_err(),
        engine.scan_template(&over).unwrap_err(),
        engine.compile_template(&over).unwrap_err(),
    ] {
        assert_eq!(error.code, DiagnosticCode::InputLimit);
    }
}

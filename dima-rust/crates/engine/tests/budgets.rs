//! Input and work budgets: the text the parser gets has viewer arguments substituted, so it may
//! be longer than a stored command; budgets follow the input's length.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "support/placeholders.rs"]
mod placeholders;

use dima_engine::syntax::{
    BUDGET_BASE, DiagnosticCode, MAX_ARGUMENT_CHARS, MAX_INPUT_CHARS, MAX_SOURCE_CHARS,
    NODES_PER_INPUT_BYTE, SegmentStep, SyntaxEngine, TOKENS_PER_INPUT_BYTE, WORK_BASE,
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

/// Programs of a compiled plan that did not parse.
fn failures(engine: &SyntaxEngine, text: &str) -> Vec<String> {
    let plan = engine
        .compile_template(text)
        .expect("within the input limit");
    plan.segments()
        .iter()
        .filter_map(|segment| match segment.step() {
            SegmentStep::ParseError(error) if error.is_resource_limit() => Some(format!(
                "{:?} in {}",
                error.code,
                segment.segment().text(text)
            )),
            _ => None,
        })
        .collect()
}

#[test]
fn many_expressions_under_the_source_limit_all_compile() {
    let engine = SyntaxEngine::default();
    // 6,006 characters and 4,004 nodes: the earlier fixed 4,000-node budget refused the plan.
    let text = "*(1+1)".repeat(1_001);
    let plan = engine.compile_template(&text).unwrap();
    assert_eq!(plan.segments().len(), 1_001);
    assert!(plan.stats().nodes >= 4_004);
    assert!(failures(&engine, &text).is_empty());
    assert!(engine.parse(&text).is_ok());
    // Literal arguments: 5,000 placeholders become 5,000 variable reads.
    let stored = "&t".repeat(MAX_SOURCE_CHARS / 2);
    let literal = placeholders::resolve(&stored, "a b", true).unwrap();
    assert!(dima_text::char_len(&literal) <= 5_000 * 48);
    assert!(failures(&engine, &literal).is_empty());
    assert!(engine.parse(&literal).is_ok());
}

/// The densest shapes, repeated up to the source limit: nothing fails on a budget, and the
/// counters stay within the budgets derived from the length.
#[test]
fn dense_text_under_the_source_limit_never_hits_a_budget() {
    let engine = SyntaxEngine::default();
    let dense = [
        "*(1?)",
        "*(?)",
        "*(1?:)",
        "*(1+)",
        "*(-)",
        "*()",
        "$()",
        "#(x)",
        "^(a)",
        "%(a)",
        "*(%[,])",
        "*(%[\"])",
        "*(\"${}\")",
        "*(\"${1?}\")",
        "*(for #i=;;{})",
        "*(for #i in {})",
        "*(%[1?,2?,3?])",
        "*(1?1?1?1?)",
        "*(%(a[1?]))",
        "*(%[a][1?])",
        "$(a 1? 2? 3?)",
        "*(#i=)",
        "*(#i+=1?)",
    ];
    for unit in dense {
        let text = unit.repeat(MAX_SOURCE_CHARS / unit.len());
        let wrapped = format!("*({})", unit.repeat((MAX_SOURCE_CHARS - 3) / unit.len()));
        for source in [&text, &wrapped] {
            assert!(failures(&engine, source).is_empty(), "{unit}");
            let program = engine
                .parse(source)
                .unwrap_or_else(|error| panic!("{unit}: {error:?}"));
            let stats = program.stats();
            let bytes = source.len();
            assert!(
                stats.tokens <= bytes * TOKENS_PER_INPUT_BYTE + BUDGET_BASE,
                "{unit}"
            );
            assert!(
                stats.nodes <= bytes * NODES_PER_INPUT_BYTE + BUDGET_BASE,
                "{unit}: {} nodes, {bytes} bytes",
                stats.nodes
            );
        }
    }
}

/// The work budget covers the quadratic shapes within the source limit: templates nested in
/// templates (each level is lexed again) and loops nested in loop bodies (each body is scanned
/// again), the worst with an emoji payload that makes every level long in bytes.
#[test]
fn nested_templates_and_loops_under_the_source_limit_fit_the_work_budget() {
    let engine = SyntaxEngine::default();
    let template = |levels: usize, payload: &str| {
        format!(
            "*({}{payload}{})",
            "\"${".repeat(levels),
            "}\"".repeat(levels)
        )
    };
    let mut worst = 0;
    for levels in [100, 400, 800, 950, 1_100, 1_600, 1_990] {
        let payload_chars = MAX_SOURCE_CHARS - 3 - 5 * levels;
        for unit in ["😀", "x"] {
            let source = template(levels, &unit.repeat(payload_chars));
            assert!(dima_text::char_len(&source) <= MAX_SOURCE_CHARS);
            let program = engine
                .parse(&source)
                .unwrap_or_else(|error| panic!("{levels} levels of {unit}: {error:?}"));
            let stats = program.stats();
            worst = worst.max(stats.lexed_bytes + stats.array_indexed_bytes);
            assert!(failures(&engine, &source).is_empty());
        }
    }
    assert!(worst > 10_000_000 && worst < WORK_BASE / 2, "{worst}");
    let loops = |levels: usize| {
        format!(
            "*(for #i in %(x) {{ {}x{} }})",
            "*(for #j in %(y) { ".repeat(levels),
            " })".repeat(levels)
        )
    };
    let levels = (MAX_SOURCE_CHARS - 30) / 22;
    let source = loops(levels);
    assert!(dima_text::char_len(&source) <= MAX_SOURCE_CHARS);
    assert!(engine.parse(&source).is_ok());
    assert!(failures(&engine, &source).is_empty());
}

/// Longer, substituted text gets a work budget linear in its length: deep templates around a
/// long payload stop with a work-limit diagnostic for that segment instead of quadratic time.
#[test]
fn work_stays_linear_in_long_substituted_text() {
    let engine = SyntaxEngine::default();
    let text = format!(
        "{}{}{}",
        "\"${".repeat(2_000),
        "😀".repeat(MAX_INPUT_CHARS / 2),
        "}\"".repeat(2_000)
    );
    let source = format!("a *({text}) $(user)");
    let started = std::time::Instant::now();
    let plan = engine.compile_template(&source).unwrap();
    let steps: Vec<_> = plan.segments().iter().map(|s| s.step()).collect();
    assert!(
        matches!(steps[1], SegmentStep::ParseError(e) if e.code == DiagnosticCode::WorkLimit),
        "{:?}",
        steps[1]
    );
    assert!(matches!(steps[3], SegmentStep::Program(_)));
    assert!(started.elapsed().as_secs() < 60);
}

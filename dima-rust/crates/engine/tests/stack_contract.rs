//! The stack contract (`dima_engine::stack`), proven in a debug build, where a level of
//! recursion costs several times what it costs in a release build.
//!
//! Parsing: every recursive cycle of the parser's call graph (enumerated below from
//! `syntax/parser.rs`, one shape per cycle) is parsed at the nesting limit and one past it, on a
//! thread with a 1 MiB stack, and again with the stack used down to exactly
//! [`PARSE_STACK_BYTES`] left. Evaluation: the deepest tree of every kind of node is evaluated
//! the same way with [`EVAL_STACK_BYTES`] left and a host that uses [`HOST_STACK_BYTES`] of
//! stack in every call, at the bottom of the tree; a tree one level deeper is refused; on a small
//! thread, or one that is not registered, the same evaluation is a clean [`EvalError::Stack`].
//! A broken contract here is a crash of the test binary, not a failed assertion.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod memory;

use dima_engine::context::{Context, Plan, State};
use dima_engine::eval::{EvalError, LimitKind, MAX_EVAL_NESTING, Rendered};
use dima_engine::stack::{
    EVAL_STACK_BYTES, HOST_STACK_BYTES, PARSE_STACK_BYTES, remaining, run_on_thread,
};
use dima_engine::syntax::{
    AstNode, CompiledProgram, CompiledTemplate, DiagnosticCode, MAX_NESTING, SegmentStep,
    SyntaxEngine, UnaryOp,
};
use memory::{MemoryHost, burn_in_host_calls, engine_with};

const MIB: usize = 1024 * 1024;

/// Stack below the parser's last level check (leaf frames: literals, tokens, node building).
const PARSE_LEAF_MARGIN: usize = 32 * 1024;

/// One shape per recursive cycle of the parser (`syntax/parser.rs`), as `(name, open, inner,
/// close)`: `open` repeated `n` times, `inner`, then `close` repeated `n` times. Edges marked
/// `+1` raise the nesting counter; every cycle has at least one.
const PARSE_SHAPES: &[(&str, &str, &str, &str)] = &[
    // atom -(+1)-> star -> atom: parentheses.
    ("parentheses", "(", "1", ")"),
    // atom -(+1)-> atom: unary operators.
    ("unary", "- ", "1", ""),
    // star -(+1)-> star: a ternary's alternate and consequent (binary right operands too).
    ("ternary-alternate", "0 ? 1 : ", "1", ""),
    ("ternary-consequent", "1 ? ", "1", " : 0"),
    // star -> atom -> expression -(+1)-> definition (compute) -> star.
    ("compute", "*(", "1", ")"),
    // definition -> call -> expression -(+1)-> definition: function and command arguments.
    ("function-argument", "$(upper ", "x", ")"),
    ("command-argument", "#(cmd ", "x", ")"),
    // definition -> variable -> expression -(+1)-> definition: a viewer selector.
    ("selector", "%(**a(", "x", "))"),
    // definition -> variable -> expression -(+1)-> definition: an assigned value.
    ("assignment", "%(a ", "x", ")"),
    // definition -> variable -> star -> atom -> expression -(+1)-> definition: a list index
    // (the review's chain), and the same through `^(` and `%del(`.
    ("index", "%(*l[", "0", "])"),
    ("exists-index", "^(*l[", "0", "])"),
    ("delete-index", "%del(*l[", "0", "])"),
    // definition -> for_loop -> nodes -> expression -(+1)-> definition: a loop body.
    ("loop-body", "*(for #i in x { ", "x", " })"),
    // definition -> for_loop -> single -> star -> atom -> expression -(+1)-> definition: a
    // loop's header (iterable, and a range's three parts).
    ("loop-iterable", "*(for #i in ", "x", " { x })"),
    ("loop-range", "*(for #i = ", "0", "; #i < 1; #i++ { x })"),
    // expression -(+1)-> array -> star -> atom -> expression: list items (the lexer's own
    // recursion, lex -(+1)-> lex, runs first over the same nesting), and a list's index.
    ("list-item", "%[", "1", "]"),
    ("list-index", "%[1][", "0", "]"),
    // expression -(+1)-> template -> tokenize, star -> atom -> expression: interpolations.
    ("interpolation", "\"${", "1", "}\""),
    ("interpolation-escaped", "\"${\\\"${", "1", "}\\\"}\""),
    // expression -> loop_variable -(+1)-> star -> atom -> loop_variable: loop assignments.
    ("loop-assignment", "#i = ", "1", ""),
    // template -> tokenize -> lex -(+1)-> lex: lists inside an interpolation.
    ("interpolated-list", "\"${%[", "1", "]}\""),
];

/// A shape `n` levels deep, as one expression: anything that is not one is wrapped in `*( … )`.
fn shape(open: &str, inner: &str, close: &str, n: usize) -> String {
    let body = format!("{}{inner}{}", open.repeat(n), close.repeat(n));
    let expression = ["$(", "%(", "^(", "#(", "%del(", "*("]
        .iter()
        .any(|start| open.starts_with(start));
    if expression {
        body
    } else {
        format!("*({body})")
    }
}

/// How a parse at some depth ended.
#[derive(Debug, PartialEq)]
enum Parsed {
    /// Parsed, and how much stack it used.
    Program(usize),
    /// The nesting limit refused it (a diagnostic, or an interpolation showing its text).
    Refused,
}

fn caught_in_interpolation(program: &CompiledProgram) -> bool {
    serde_json::to_string(&program.to_value())
        .unwrap()
        .contains("[Parse error: ")
}

fn parse_at(engine: &SyntaxEngine, text: &str) -> Parsed {
    match engine.parse(text) {
        Ok(program) if caught_in_interpolation(&program) => Parsed::Refused,
        Ok(program) => Parsed::Program(program.stats().stack_bytes),
        Err(error) => {
            assert_eq!(error.code, DiagnosticCode::NestingLimit, "{error:?}");
            Parsed::Refused
        }
    }
}

/// Uses stack until about `left` bytes remain, then runs `work`.
#[inline(never)]
fn with_stack_left<T>(left: usize, work: impl FnOnce() -> T) -> T {
    let room = remaining().unwrap();
    if room <= left + 8 * 1024 {
        assert!(room >= left, "overshot: {room} left, {left} wanted");
        return work();
    }
    let pad = [0u8; 4 * 1024];
    std::hint::black_box(&pad);
    with_stack_left(left, work)
}

/// The deepest `n` that parses, and the stack it used; `n + 1` is refused.
fn deepest(
    engine: &SyntaxEngine,
    name: &str,
    open: &str,
    inner: &str,
    close: &str,
) -> (usize, usize) {
    let mut n = 0;
    let mut used = 0;
    while let Parsed::Program(stack) = parse_at(engine, &shape(open, inner, close, n + 1)) {
        n += 1;
        used = stack;
        assert!(n <= MAX_NESTING, "{name}: no nesting limit");
    }
    // Every cycle raises the counter at most three times a level.
    assert!(n >= MAX_NESTING / 3 - 1, "{name}: only {n} levels");
    (n, used)
}

#[test]
fn parsing_fits_its_stack_at_the_nesting_limit() {
    run_on_thread(MIB, || {
        assert!(
            remaining().unwrap() >= PARSE_STACK_BYTES,
            "1 MiB parses in place"
        );
        let engine = SyntaxEngine::default();
        let mut report = Vec::new();
        for (name, open, inner, close) in PARSE_SHAPES {
            let (n, used) = deepest(&engine, name, open, inner, close);
            report.push(format!("{name}: {n} levels, {used} bytes"));
            assert!(
                used + PARSE_LEAF_MARGIN <= PARSE_STACK_BYTES,
                "{name}: {used} bytes at {n} levels"
            );
            // At the limit and one past it, with exactly the contract's stack left.
            let at_limit = shape(open, inner, close, n);
            let past = shape(open, inner, close, n + 1);
            with_stack_left(PARSE_STACK_BYTES, || {
                assert!(matches!(parse_at(&engine, &at_limit), Parsed::Program(_)));
                assert_eq!(parse_at(&engine, &past), Parsed::Refused);
                // A template compiles each expression as its own program.
                let plan = engine
                    .compile_template(&format!("a {past} b {at_limit}"))
                    .unwrap();
                let steps: Vec<_> = plan.segments().iter().map(|s| s.step()).collect();
                assert!(matches!(steps.last(), Some(SegmentStep::Program(_))));
            });
        }
        println!("{}", report.join("\n"));
    })
    .unwrap();
}

#[test]
fn a_thread_without_room_parses_on_a_thread_of_its_own() {
    let engine = SyntaxEngine::default();
    let (open, inner, close) = ("*(for #i in ", "x", " { x })");
    // This test's own thread is not registered.
    assert_eq!(remaining(), None);
    let (n, _) = deepest(&engine, "loop-iterable", open, inner, close);
    assert_eq!(
        parse_at(&engine, &shape(open, inner, close, n + 1)),
        Parsed::Refused
    );
    // A registered thread with less than the contract's stack left.
    run_on_thread(256 * 1024, || {
        assert!(remaining().unwrap() < PARSE_STACK_BYTES);
        let (deep, _) = deepest(&engine, "loop-iterable", open, inner, close);
        assert_eq!(deep, n);
    })
    .unwrap();
}

// ---- evaluation ----

/// What the bottom of every evaluated tree does: reads a stored list nested
/// [`MAX_JSON_NESTING`](dima_engine::json::MAX_JSON_NESTING) deep (a host call and the JSON
/// reader), and appends its first item to it (the list converted to text, written as JSON and
/// saved: another host call), the values dropped on the way.
const LEAF: &str = "%(*deep[] %(*deep[0]))";

/// Evaluation shapes: the parser's, plus timers (a timer's duration is evaluated). Loops run at
/// most four deep (the Pro plan), so the bottom of a deeper loop shape never runs.
fn eval_shapes() -> Vec<(&'static str, &'static str, &'static str, bool)> {
    let mut shapes: Vec<_> = PARSE_SHAPES
        .iter()
        .map(|(name, open, _, close)| {
            let in_loops = matches!(*name, "loop-body" | "loop-iterable" | "loop-range");
            (*name, *open, *close, !in_loops)
        })
        .collect();
    shapes.push(("timer-duration", "$(timer ", " body)", true));
    shapes
}

fn eval_context() -> Context {
    Context {
        broadcaster_id: "123".into(),
        user_plan: Plan::Pro,
        user_login: "caller".into(),
        ..Context::default()
    }
}

fn eval_host() -> MemoryHost {
    let mut host = MemoryHost::new(1);
    let depth = dima_engine::json::MAX_JSON_NESTING;
    let deep = format!("{}1{}", "[".repeat(depth), "]".repeat(depth));
    host.channel.insert("deep".into(), deep);
    host.channel.insert("l".into(), "[\"0\",\"1\"]".into());
    host
}

/// Polls `inner` with about `left` bytes of stack left (the stack is used down to it first).
struct AtStackLeft<F> {
    inner: std::pin::Pin<Box<F>>,
    left: Option<usize>,
}

impl<F: std::future::Future> std::future::Future for AtStackLeft<F> {
    type Output = F::Output;

    fn poll(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<F::Output> {
        let this = self.get_mut();
        match this.left {
            // A little above the contract, for this adapter's own frames.
            Some(left) => with_stack_left(left + 2 * 1024, || this.inner.as_mut().poll(cx)),
            None => this.inner.as_mut().poll(cx),
        }
    }
}

/// Renders `template` on the current thread, every poll made with about `left` bytes of stack
/// left when given; the output and whether the bottom ran.
fn render_at(
    template: &CompiledTemplate,
    left: Option<usize>,
) -> (Result<Rendered, EvalError>, bool) {
    let engine = engine_with(&[]);
    let mut host = eval_host();
    let before = host.channel["deep"].clone();
    let context = eval_context();
    let future = AtStackLeft {
        inner: Box::pin(engine.render_message(template, &context, State::default(), &mut host)),
        left,
    };
    let rendered = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(future);
    (rendered, host.channel["deep"] != before)
}

fn render_here(template: &CompiledTemplate) -> (Result<Rendered, EvalError>, bool) {
    render_at(template, None)
}

/// The deepest tree of every shape, compiled.
fn deepest_trees() -> Vec<(&'static str, CompiledTemplate, bool)> {
    let engine = engine_with(&[]);
    let syntax = SyntaxEngine::default();
    eval_shapes()
        .into_iter()
        .map(|(name, open, close, bottom_runs)| {
            let (n, _) = deepest(&syntax, name, open, LEAF, close);
            let template = engine.compile(&shape(open, LEAF, close, n)).unwrap();
            (name, template, bottom_runs)
        })
        .collect()
}

/// A tree `height` levels high (unary operators around a literal), as the parser never makes
/// one past its limit.
fn tower(height: usize) -> AstNode {
    let mut node = AstNode::Literal { value: "1".into() };
    for _ in 1..height {
        node = AstNode::Unary {
            operator: UnaryOp::Minus,
            argument: Box::new(node),
        };
    }
    node
}

#[test]
fn evaluation_fits_its_stack_at_the_nesting_limit() {
    run_on_thread(MIB, || {
        burn_in_host_calls(HOST_STACK_BYTES);
        assert!(remaining().unwrap() >= EVAL_STACK_BYTES);
        let limit = format!("[Parse error: {}]", LimitKind::Nesting.message());
        let mut report = Vec::new();
        for (name, template, bottom_runs) in deepest_trees() {
            let (rendered, ran) = render_here(&template);
            let rendered = rendered.unwrap();
            assert!(!rendered.text.contains(&limit), "{name}: {}", rendered.text);
            assert_eq!(ran, bottom_runs, "{name}: the bottom of the tree");
            report.push(format!("{name}: {} bytes", rendered.stats.stack_bytes));
            // Again with the contract's stack left at every poll.
            let (again, ran) = render_at(&template, Some(EVAL_STACK_BYTES));
            assert!(!again.unwrap().text.contains(&limit), "{name}");
            assert_eq!(ran, bottom_runs, "{name}: the bottom of the tree");
        }
        println!("{}", report.join("\n"));
        // A tree one level past the limit (read back from storage, say) is refused before it
        // runs; one at the limit runs.
        let engine = engine_with(&[]);
        let evaluate = |height: usize| {
            let mut host = eval_host();
            tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(engine.evaluate_message(
                    &tower(height),
                    &eval_context(),
                    State::default(),
                    &mut host,
                ))
                .map(|done| done.value)
        };
        assert!(evaluate(MAX_EVAL_NESTING).is_ok());
        assert_eq!(
            evaluate(MAX_EVAL_NESTING + 1).unwrap_err(),
            EvalError::Limit(LimitKind::Nesting)
        );
    })
    .unwrap();
}

#[test]
fn a_caller_that_breaks_the_contract_gets_an_error() {
    let trees = deepest_trees();
    // A registered thread too small for the contract.
    run_on_thread(256 * 1024, || {
        for (name, template, _) in &trees {
            let (rendered, ran) = render_here(template);
            assert_eq!(rendered.unwrap_err(), EvalError::Stack, "{name}");
            assert!(!ran, "{name}: nothing ran");
        }
    })
    .unwrap();
    // A thread that is not registered (this test's own).
    let (rendered, ran) = render_here(&trees[0].1);
    assert_eq!(rendered.unwrap_err(), EvalError::Stack);
    assert!(!ran);
}

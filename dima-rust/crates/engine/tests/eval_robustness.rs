//! Evaluator limits and fuzz-style property checks: arbitrary command text and arbitrary stored
//! values never panic, never exceed a limit, and evaluate deterministically for a fixed clock and
//! random seed. Also: an evaluation is `Send` and runs many at once on a multi-threaded runtime.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod memory;

use dima_engine::context::{Context, Plan, State};
use dima_engine::eval::{Engine, EvalLimits, LimitKind};
use dima_engine::value::Value;
use memory::{MemoryHost, block_on, engine_with, render};
use std::panic::{AssertUnwindSafe, catch_unwind};

/// xorshift64*: deterministic, no dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len())]
    }
}

/// Pieces of the language, glued at random.
const PIECES: &[&str] = &[
    "$(",
    "%(",
    "*(",
    "^(",
    "%del(",
    "#(",
    ")",
    "(",
    "[",
    "]",
    "{",
    "}",
    "%[",
    "\"",
    "\\",
    "${",
    ",",
    ";",
    "?",
    ":",
    "+",
    "-",
    "*",
    "/",
    "%",
    "==",
    "<",
    ">=",
    "~=",
    " ",
    " ",
    "#i",
    "#i++",
    "#i = 0",
    "for ",
    " in ",
    "x",
    "list",
    "*v",
    "**u",
    "#c",
    "##c",
    "[]",
    "[0]",
    "[-1]",
    "[random]",
    ".length",
    "responses",
    "1",
    "0",
    "3.5",
    "-2",
    "1e3",
    "😀",
    "é",
    "İ",
    "ß",
    "upper ",
    "lower ",
    "title ",
    "capitalize ",
    "length ",
    "slice ",
    "replace ",
    "user ",
    "touser ",
    "random ",
    "count ",
    "scount",
    "break",
    "continue",
    "timer ",
    "delay ",
    "raid.viewers",
    "sub.tier",
    "ban.time",
    "say ",
    "true",
    "false",
    "null",
];

/// Whole statements that do work: loops, list growth, text growth.
const PROGRAMS: &[&str] = &[
    "*(for #i = 0; #i < 100; #i++ { %(list[] #i) })",
    "*(for #i = 0; #i < 100; #i++ { *(for #j = 0; #j < 100; #j++ { %(n *(%(n) + 1)) }) })",
    "%(t ab) *(for #i = 0; #i < 100; #i++ { %(t \"${%(t)}${%(t)}\") })",
    "*(for #x in %(list[]) { $(upper #x) })",
    "%(**u(x) 1) %(##c 2) %(*v 3) ^(**u) %del(*v[0]) %(list[random])",
    "$(say %(list[]) $(length %(list[])))",
    "#(other a b) #(other)",
];

fn random_text(rng: &mut Rng) -> String {
    let mut text = String::new();
    for _ in 0..rng.below(40) {
        text.push_str(rng.pick(PIECES));
    }
    if rng.below(3) == 0 {
        text.push_str(rng.pick(PROGRAMS));
    }
    text
}

const STORED: &[&str] = &[
    "",
    "[]",
    "[1,2,3]",
    "not json",
    "{\"a\":1}",
    "[[1,[2,[3]]],{\"10\":1,\"b\":null}]",
    "\"text\"",
    "[\"\\ud800\",\"😀\"]",
    "1e400",
    "[1e400]",
    "null",
    "[true,false,null,-0,1.5]",
];

fn host(rng: &mut Rng) -> MemoryHost {
    let mut host = MemoryHost::new(rng.next()).answer("say", |args, _| {
        Value::Text(
            args.iter()
                .map(|a| a.to_text_or_empty().into_owned())
                .collect::<Vec<_>>()
                .join(" "),
        )
    });
    for name in ["list", "v", "u", "c"] {
        let value = rng.pick(STORED).to_owned();
        host.channel.insert(name.into(), value.clone());
        host.users.insert(format!("{name}:caller"), value.clone());
        host.cache
            .insert(format!("twitch:1:variable:{name}"), value);
    }
    host
}

fn context(rng: &mut Rng) -> Context {
    Context {
        broadcaster_id: "1".into(),
        user_id: "2".into(),
        user_login: "caller".into(),
        user_display_name: "Caller😀".into(),
        user_plan: [Plan::Free, Plan::Premium, Plan::Pro][rng.below(3)],
        argument: Some("arg 😀".into()),
        ..Context::default()
    }
}

fn small_limits() -> EvalLimits {
    EvalLimits {
        steps: 20_000,
        host_calls: 300,
        text_bytes: 16 * 1024,
        ..EvalLimits::default()
    }
}

#[test]
fn arbitrary_text_and_stored_values_never_panic_or_exceed_limits_and_are_deterministic() {
    let limits = small_limits();
    let engine = engine_with(&[("say", None)]).with_limits(limits);
    let mut rng = Rng(0x5eed_1234_abcd_0001);
    for round in 0..3_000 {
        let source = random_text(&mut rng);
        let seed = rng.next();
        let run = |seed: u64| {
            let mut rng = Rng(seed);
            let context = context(&mut rng);
            let mut host = host(&mut rng);
            let outcome = catch_unwind(AssertUnwindSafe(|| {
                let template = engine.compile(&source)?;
                Ok::<_, dima_engine::syntax::Diagnostic>(block_on(engine.render(
                    &template,
                    &context,
                    State::default(),
                    &mut host,
                )))
            }));
            let outcome = outcome.unwrap_or_else(|_| panic!("panic on round {round}: {source:?}"));
            match outcome {
                Ok(Ok(rendered)) => {
                    assert!(rendered.stats.steps <= limits.steps + 1, "{source:?}");
                    assert!(
                        rendered.stats.host_calls <= limits.host_calls + 1,
                        "{source:?}"
                    );
                    assert!(rendered.text.len() <= limits.text_bytes + 64, "{source:?}");
                    format!(
                        "{}|{}|{:?}",
                        rendered.text, rendered.state.count, host.recorded.calls
                    )
                }
                Ok(Err(error)) => format!("error {error}"),
                Err(diagnostic) => format!("diagnostic {}", diagnostic.message),
            }
        };
        assert_eq!(run(seed), run(seed), "nondeterministic: {source:?}");
    }
}

fn render_with(engine: &Engine, source: &str, plan: Plan) -> String {
    let context = Context {
        user_plan: plan,
        ..Context::default()
    };
    render(
        engine,
        source,
        &context,
        State::default(),
        &mut MemoryHost::new(1),
    )
    .text
}

#[test]
fn a_limit_stops_one_expression_and_rendering_goes_on() {
    let engine = engine_with(&[]).with_limits(small_limits());
    let nested = "*(for #a = 0; #a < 100; #a++ { *(for #b = 0; #b < 100; #b++ { *(for #c = 0; #c < 100; #c++ { %(n *(%(n) + 1)) }) }) })";
    let text = render_with(&engine, &format!("before {nested} after %(n)"), Plan::Pro);
    assert!(
        text.starts_with(&format!(
            "before [Parse error: {}]",
            LimitKind::Steps.message()
        )),
        "{text}"
    );
    // Once spent, every later expression reports the limit; text segments still print.
    assert!(
        text.ends_with(&format!(
            "after [Parse error: {}]",
            LimitKind::Steps.message()
        )),
        "{text}"
    );

    let doubling = "%(t ab) *(for #i = 0; #i < 100; #i++ { %(t \"${%(t)}${%(t)}\") }) done";
    let text = render_with(&engine, doubling, Plan::Pro);
    assert!(
        text.contains(LimitKind::TextSize.message()) && text.ends_with(" done"),
        "{text}"
    );

    let calls = "*(for #i = 0; #i < 100; #i++ { *(for #j = 0; #j < 100; #j++ { %(##x #j) }) }) end";
    let text = render_with(&engine, calls, Plan::Pro);
    assert!(
        text.contains(LimitKind::HostCalls.message()) && text.ends_with(" end"),
        "{text}"
    );
}

#[test]
fn the_default_limits_leave_ordinary_commands_alone() {
    let engine = engine_with(&[]);
    let source = "*(for #i = 0; #i < 100; #i++ { %(list[] #i) }) %(list[].length) *(for #x in %(list[]) { %(sum *(%(sum) + #x)) }) %(sum)";
    assert_eq!(render_with(&engine, source, Plan::Pro).trim(), "100  4950");
}

#[test]
fn deep_nodes_are_refused_not_recursed() {
    let engine = engine_with(&[]);
    let mut node = dima_engine::syntax::AstNode::Literal { value: "x".into() };
    for _ in 0..10_000 {
        node = dima_engine::syntax::AstNode::Unary {
            operator: dima_engine::syntax::UnaryOp::Minus,
            argument: Box::new(node),
        };
    }
    let result = block_on(engine.evaluate(
        &node,
        &Context::default(),
        State::default(),
        &mut MemoryHost::new(1),
    ));
    assert_eq!(
        result.unwrap_err(),
        dima_engine::eval::EvalError::Limit(LimitKind::Nesting)
    );
    // Dropping a deep node must not overflow either: unwind it iteratively.
    let mut node = node;
    while let dima_engine::syntax::AstNode::Unary { argument, .. } = node {
        node = *argument;
    }
}

fn assert_send<T: Send>(_: &T) {}

#[test]
fn evaluations_are_send_and_run_concurrently() {
    let engine = std::sync::Arc::new(engine_with(&[]));
    let template = std::sync::Arc::new(
        engine
            .compile("$(upper $(user)) %(*n *(%(*n) + 1)) %(*n)")
            .unwrap(),
    );
    {
        let context = Context::default();
        let mut host = MemoryHost::new(1);
        let future = engine.render(&template, &context, State::default(), &mut host);
        assert_send(&future);
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .build()
        .unwrap();
    let outputs: Vec<String> = runtime.block_on(async {
        let mut tasks = Vec::new();
        for n in 0..64 {
            let (engine, template) = (engine.clone(), template.clone());
            tasks.push(tokio::spawn(async move {
                let context = Context {
                    user_display_name: format!("viewer{n}"),
                    user_plan: Plan::Pro,
                    ..Context::default()
                };
                let mut host = MemoryHost::new(n);
                host.channel.insert("n".into(), n.to_string());
                engine
                    .render(&template, &context, State::default(), &mut host)
                    .await
                    .unwrap()
                    .text
            }));
        }
        let mut outputs = Vec::new();
        for task in tasks {
            outputs.push(task.await.unwrap());
        }
        outputs
    });
    for (n, output) in outputs.iter().enumerate() {
        assert_eq!(output, &format!("VIEWER{n}  {}", n + 1));
    }
}

#[test]
fn stored_lists_with_lone_surrogate_escapes_read_as_replacement_characters() {
    // Text rule 3: old stored data with an unpaired surrogate escape is made valid where read.
    let engine = engine_with(&[]);
    let mut host = MemoryHost::new(1);
    host.channel.insert(
        "list".into(),
        r#"["a\ud800b","\udc00","😀\ud83d\ude00"]"#.into(),
    );
    let context = Context {
        user_plan: Plan::Premium,
        ..Context::default()
    };
    let text = render(
        &engine,
        "%(*list[0])|%(*list[1])|%(*list[2])|%(*list[])|%(*list[].length)",
        &context,
        State::default(),
        &mut host,
    )
    .text;
    assert_eq!(
        text,
        "a\u{fffd}b|\u{fffd}|😀😀|[\"a\u{fffd}b\",\"\u{fffd}\",\"😀😀\"]|3"
    );
    render(
        &engine,
        "%(*list[] new)",
        &context,
        State::default(),
        &mut host,
    );
    assert_eq!(
        host.channel["list"],
        "[\"a\u{fffd}b\",\"\u{fffd}\",\"😀😀\",\"new\"]"
    );
}

#[test]
fn a_tree_16000_levels_deep_is_an_error_text_not_a_stack_overflow() {
    let engine = engine_with(&[]);
    let nested = |levels: usize| format!("{}x{}", "$(upper ".repeat(levels), ")".repeat(levels));
    // The parser accepts it (up to MAX_NESTING levels, parsed on its own thread).
    let template = engine
        .compile(&format!("before {} after *(1 + 1)", nested(16_000)))
        .unwrap();
    let rendered = render_template(&engine, &template);
    let expected = format!(
        "before [Parse error: {}] after 2",
        LimitKind::Nesting.message()
    );
    assert!(
        rendered == expected,
        "got {} bytes: {:?}",
        rendered.len(),
        rendered.get(..200)
    );
    // The same through evaluate(), and nothing in the tree ran.
    let program = engine
        .parse(&format!("%(ran yes) {}", nested(16_000)))
        .unwrap();
    let result = block_on(engine.evaluate_program(
        &program,
        &Context::default(),
        State::default(),
        &mut MemoryHost::new(1),
    ));
    assert_eq!(
        result.unwrap_err(),
        dima_engine::eval::EvalError::Limit(LimitKind::Nesting)
    );
    // Below the limit, every kind of nesting either evaluates or stops with the same error
    // text; none may overflow the test thread's 2 MiB stack (a debug build spends several
    // kilobytes per level, so some kinds reach the stack guard before 256 levels).
    let wrap = |open: &str, inner: &str, close: &str, levels: usize| {
        format!("{}{inner}{}", open.repeat(levels), close.repeat(levels))
    };
    let limit_text = format!("[Parse error: {}]", LimitKind::Nesting.message());
    for (open, inner, close, levels, value) in [
        ("$(upper ", "x", ")", 255, "X"),
        // List-index chains stay at 100 levels: the parser itself overflows a 2 MiB debug
        // stack at about 130 of them (its 128-level inline ceiling), before evaluation.
        ("%(*l[", "0", "])", 100, "0"),
        ("%del(*l[", "0", "])", 100, ""),
        ("^(*l[", "0", "])", 100, "false"),
        ("%(a ", "x", ")", 255, ""),
        ("%(**u(", "caller", "))", 255, ""),
        ("*(1 ? ", "x", " : 0)", 255, "x"),
        ("*(1 + ", "1", ")", 255, "256"),
        ("#(", "x", ")", 255, ""),
        ("*(\"${", "x", "}\")", 120, "x"),
    ] {
        let source = wrap(open, inner, close, levels);
        let context = Context {
            user_plan: Plan::Pro,
            user_login: "caller".into(),
            ..Context::default()
        };
        let mut host = MemoryHost::new(1);
        host.channel.insert("l".into(), "[\"0\",\"1\"]".into());
        let text = render(&engine, &source, &context, State::default(), &mut host).text;
        assert!(
            text == value || text == limit_text,
            "{open}: {:?}",
            text.get(..80)
        );
        let shallow = wrap(open, inner, close, 40);
        let text = render(&engine, &shallow, &context, State::default(), &mut host).text;
        assert!(text != limit_text, "{open} at 40 levels");
    }
    assert!(render_with(&engine, &nested(300), Plan::Pro).contains(LimitKind::Nesting.message()));
}

fn render_template(engine: &Engine, template: &dima_engine::syntax::CompiledTemplate) -> String {
    let mut host = MemoryHost::new(1);
    block_on(engine.render(template, &Context::default(), State::default(), &mut host))
        .unwrap()
        .text
}

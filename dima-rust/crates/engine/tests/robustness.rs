//! Limits, hardening and fuzz-style checks: arbitrary UTF-8 input never panics, never exceeds
//! the limits, and round-trips where the reference round-trips.

// Test helpers outside `#[test]` functions: a failed expectation is a failed test.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use dima_engine::blocks::{
    BlockKind, BlockNode, BlockRoot, IdMaker, MAX_BLOCK_DEPTH, MAX_BLOCK_NODES, MAX_COMMAND_TEXT,
    compile_blocks, import_command_text_with, read_block_root, shape_eq_root,
};
use dima_engine::syntax::{
    AstNode, BUDGET_BASE, Diagnostic, DiagnosticCode, GrammarBuilder, HARD_JSON_NESTING_CEILING,
    Limits, MAX_NESTING, NODES_PER_INPUT_BYTE, SegmentKind, SegmentStep, Span, SyntaxEngine,
    SyntaxHandler, TOKENS_PER_INPUT_BYTE,
};
use serde_json::Value;
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
    "'",
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
    "#",
    "##",
    "**",
    "=",
    "==",
    "<",
    ">",
    "!=",
    "~=",
    ".",
    " ",
    "  ",
    "\n",
    "\t",
    "for ",
    " in ",
    "#i",
    "random",
    "length",
    "http://x/",
    "user",
    "say",
    "x",
    "1",
    "5.5",
    "😀",
    "𐐀",
    "👨‍👩‍👧‍👦",
    "é",
    "e\u{301}",
    "שלום",
    "مرحبا",
    "\u{feff}",
    "\u{a0}",
    "\u{85}",
    "\u{3000}",
    "\u{0}",
    "\u{fffd}",
    "\u{202e}",
    "\\$",
    "\\)",
    "\\\\",
];

fn soup(rng: &mut Rng, max_pieces: usize) -> String {
    let count = rng.below(max_pieces + 1);
    (0..count).map(|_| rng.pick(PIECES)).collect()
}

fn on_boundary(source: &str, span: Span) -> bool {
    span.start <= span.end && source.get(span.start..span.end).is_some()
}

fn check_diagnostic(source: &str, error: &Diagnostic) {
    assert!(on_boundary(source, error.span), "{error:?} in {source:?}");
    assert!(!error.message.is_empty());
}

fn json_depth(value: &Value) -> usize {
    match value {
        Value::Array(items) => 1 + items.iter().map(json_depth).max().unwrap_or(0),
        Value::Object(map) => 1 + map.values().map(json_depth).max().unwrap_or(0),
        _ => 0,
    }
}

/// A program's counters stay within its fixed caps and within the budgets derived from its
/// length (which the parser must never need more than); a tree whose JSON a bounded reader can
/// read back round-trips. Deeper trees are not serialized here: serializing recurses.
fn check_program(program: &dima_engine::syntax::CompiledProgram, limits: Limits) {
    let stats = program.stats();
    let bytes = program.source().len();
    assert!(stats.nodes <= limits.nodes);
    assert!(stats.tokens <= limits.tokens);
    assert!(
        stats.nodes <= NODES_PER_INPUT_BYTE * bytes + BUDGET_BASE,
        "{} nodes for {bytes} bytes: {}",
        stats.nodes,
        dima_text::truncate_chars(program.source(), 80)
    );
    assert!(
        stats.tokens <= TOKENS_PER_INPUT_BYTE * bytes + BUDGET_BASE,
        "{} tokens for {bytes} bytes",
        stats.tokens
    );
    if program.check_json_depth().is_err() {
        return;
    }
    let value = program.to_value();
    assert!(json_depth(&value) < HARD_JSON_NESTING_CEILING);
    let text = serde_json::to_string(&value).expect("serialises");
    let back: AstNode = serde_json::from_str(&text).expect("the bounded reader accepts it");
    assert_eq!(&back, program.root());
}

fn exercise_syntax(engine: &SyntaxEngine, source: &str) {
    match engine.parse(source) {
        Ok(program) => check_program(&program, engine.limits()),
        Err(error) => check_diagnostic(source, &error),
    }
    match engine.scan_template(source) {
        Ok(segments) => {
            let mut at = 0;
            for (i, segment) in segments.iter().enumerate() {
                assert_eq!(segment.span.start, at, "contiguous segments in {source:?}");
                assert!(on_boundary(source, segment.span));
                if segment.kind == SegmentKind::Unclosed {
                    assert_eq!(i, segments.len() - 1, "unclosed ends the scan");
                }
                at = segment.span.end;
            }
            assert_eq!(at, source.len(), "segments cover {source:?}");
        }
        Err(error) => check_diagnostic(source, &error),
    }
    match engine.compile_template(source) {
        Ok(plan) => {
            assert!(plan.stats().tokens <= engine.limits().tokens);
            assert!(plan.stats().nodes <= engine.limits().nodes);
            for segment in plan.segments() {
                match segment.step() {
                    SegmentStep::Program(program) => {
                        check_program(program, engine.limits());
                        assert_eq!(program.source(), segment.segment().text(source));
                    }
                    SegmentStep::ParseError(error) | SegmentStep::Unclosed(error) => {
                        check_diagnostic(source, error);
                    }
                    SegmentStep::Text => {}
                }
            }
        }
        Err(error) => {
            assert!(error.is_resource_limit(), "{error:?}");
            check_diagnostic(source, &error);
        }
    }
}

fn depth(node: &BlockNode) -> usize {
    let value = node.to_value();
    fn walk(value: &Value) -> usize {
        match value {
            Value::Object(map) => {
                let own = usize::from(map.get("id").is_some() && map.get("type").is_some());
                own + map.values().map(walk).max().unwrap_or(0)
            }
            Value::Array(items) => items.iter().map(walk).max().unwrap_or(0),
            _ => 0,
        }
    }
    walk(&value)
}

fn count(root: &BlockRoot) -> usize {
    fn walk(value: &Value) -> usize {
        match value {
            Value::Object(map) => {
                usize::from(map.get("id").is_some() && map.get("type").is_some())
                    + map.values().map(walk).sum::<usize>()
            }
            Value::Array(items) => items.iter().map(walk).sum(),
            _ => 0,
        }
    }
    root.children.iter().map(|c| walk(&c.to_value())).sum()
}

/// Import, save, import the saved text again: where the reference round-trips (the import
/// saves), the saved text reads back as the same blocks and saves to the same text.
fn exercise_blocks(text: &str, seed: u64) {
    let mut ids = IdMaker::new("i", &seed.to_string());
    let Ok(imported) = import_command_text_with(text, &mut ids) else {
        assert!(dima_text::char_len(text) > MAX_COMMAND_TEXT);
        return;
    };
    let raw: Vec<&str> = imported
        .root
        .children
        .iter()
        .filter_map(|c| match &c.kind {
            BlockKind::Raw { source } => Some(source.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(raw.len(), imported.advanced_count);
    let mut cursor = 0;
    for piece in &raw {
        let at = text
            .get(cursor..)
            .and_then(|rest| rest.find(piece))
            .expect("raw pieces keep their exact text, in order");
        cursor += at + piece.len();
    }
    let wire = imported.root.to_value();
    let Ok(saved) = compile_blocks(&wire) else {
        return;
    };
    assert!(dima_text::char_len(&saved.text) <= MAX_COMMAND_TEXT);
    assert!(count(&saved.root) <= MAX_BLOCK_NODES);
    assert!(
        saved
            .root
            .children
            .iter()
            .all(|c| depth(c) <= MAX_BLOCK_DEPTH)
    );
    let again = import_command_text_with(&saved.text, &mut IdMaker::new("j", ""))
        .expect("saved text imports");
    assert!(
        shape_eq_root(&again.root, &saved.root),
        "{text:?} saved as {:?} reads back differently",
        saved.text
    );
    let resaved = compile_blocks(&again.root.to_value()).expect("re-saves");
    assert_eq!(
        resaved.text, saved.text,
        "saving is idempotent for {text:?}"
    );
}

#[test]
fn arbitrary_utf8_syntax_never_panics_and_respects_every_limit() {
    let engine = SyntaxEngine::default();
    let tight = engine.clone().with_limits(Limits {
        source_chars: 200,
        input_chars: 200,
        tokens: 40,
        nodes: 30,
        nesting: 6,
    });
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    for round in 0..4_000u64 {
        let source = soup(&mut rng, if round % 50 == 0 { 2_000 } else { 60 });
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            exercise_syntax(&engine, &source);
            exercise_syntax(&tight, &source);
            exercise_blocks(&source, round);
        }));
        assert!(outcome.is_ok(), "panicked on {source:?}");
    }
}

#[test]
fn deep_nesting_parses_like_the_reference_and_stops_at_the_ceiling() {
    // Runs on the test harness's ordinary thread (2 MiB): deep programs are parsed on their own
    // stack and their trees are freed without recursion.
    let engine = SyntaxEngine::default();
    let n = 4_000;
    let inputs = [
        "$(".repeat(n),
        format!("{}x{}", "$(s ".repeat(n), ")".repeat(n)),
        format!("{}1{}", "%[".repeat(n), "]".repeat(n)),
        format!("*({}1{})", "(".repeat(n), ")".repeat(n)),
        format!("*({}1)", "-".repeat(n)),
        format!("*({}1)", "1 ? ".repeat(n)),
        format!("*({})", vec!["1"; n].join(" + ")),
        "\"${".repeat(n),
        format!("{}{}", "\"${\\\"".repeat(1_000), "}\"".repeat(1_000)),
        format!(
            "*(for #i in %(x) {{ {}x{} }})",
            "*(for #j in %(y) { ".repeat(500),
            " })".repeat(500)
        ),
        format!("%(**a({}x{}))", "%(**a(".repeat(n / 4), "))".repeat(n / 4)),
        "{".repeat(n),
        "😀(".repeat(n),
    ];
    for source in &inputs {
        let outcome = catch_unwind(AssertUnwindSafe(|| exercise_syntax(&engine, source)));
        assert!(
            outcome.is_ok(),
            "panicked on {}…",
            dima_text::truncate_chars(source, 40)
        );
        let outcome = catch_unwind(AssertUnwindSafe(|| exercise_blocks(source, 1)));
        assert!(
            outcome.is_ok(),
            "blocks panicked on {}…",
            dima_text::truncate_chars(source, 40)
        );
    }
    // Within the 10,000-character source limit, what the reference parses parses here too
    // (it parses 5,632 parentheses, 7,673 ternary branches, 11,264 unary operators, 2,048
    // arrays in a fresh Node 24 stack).
    for source in [
        format!("*({}1{})", "(".repeat(4_998), ")".repeat(4_998)),
        format!("*({}1)", "1?".repeat(4_998)),
        format!("*({}1)", "-+".repeat(4_998)),
        format!("{}1{}", "%[".repeat(2_048), "]".repeat(2_048)),
        format!("{}x{}", "$(s ".repeat(1_999), ")".repeat(1_999)),
    ] {
        assert!(dima_text::char_len(&source) <= 10_000);
        let program = engine.parse(&source).unwrap_or_else(|error| {
            panic!("{error:?}: {}", dima_text::truncate_chars(&source, 30))
        });
        let plan = engine.compile_template(&format!("*({source})")).unwrap();
        assert!(matches!(plan.segments()[0].step(), SegmentStep::Program(_)));
        drop((program.clone(), plan.clone()));
    }
    // Past the ceiling: a nesting diagnostic, at the top level and per template segment.
    let deep = format!("*({}1)", "-+".repeat(MAX_NESTING / 2 + 10));
    assert_eq!(
        engine.parse(&deep).unwrap_err().code,
        DiagnosticCode::NestingLimit
    );
    let plan = engine
        .compile_template(&format!("a {deep} $(user)"))
        .unwrap();
    let steps: Vec<_> = plan.segments().iter().map(|s| s.step()).collect();
    assert!(
        matches!(steps[1], SegmentStep::ParseError(e) if e.code == DiagnosticCode::NestingLimit)
    );
    assert!(matches!(steps[3], SegmentStep::Program(_)));
    // Inside an interpolation the reference catches its stack overflow and shows the text.
    let program = engine.parse(&format!("\"${{{deep}}}\"")).unwrap();
    let shown = format!("[Parse error: {deep}]");
    assert_eq!(
        program.to_value()["children"][0]["segments"][0]["value"],
        shown.as_str()
    );
    let raised = engine.with_limits(Limits {
        nesting: usize::MAX,
        ..Limits::default()
    });
    assert_eq!(raised.limits().nesting, MAX_NESTING, "the ceiling holds");
}

/// A JSON text with random structure, string escapes that include unpaired surrogates, astral
/// characters, nulls, numbers and very deep nesting. `budget` bounds the values written, so the
/// text stays small whatever the dice say; `chain` makes one narrow, very deep branch.
fn random_json(rng: &mut Rng, depth: usize, budget: &mut usize, chain: usize, out: &mut String) {
    const TYPES: &[&str] = &[
        "literal",
        "raw",
        "function",
        "commandRef",
        "getVar",
        "setVar",
        "exists",
        "deleteVar",
        "binary",
        "unary",
        "ternary",
        "template",
        "arrayLiteral",
        "loopVar",
        "loopAssign",
        "forLoop",
        "group",
        "root",
        "nope",
    ];
    const KEYS: &[&str] = &[
        "id",
        "type",
        "value",
        "source",
        "name",
        "args",
        "commandName",
        "storage",
        "accessor",
        "userSelector",
        "operator",
        "left",
        "right",
        "argument",
        "test",
        "consequent",
        "alternate",
        "parts",
        "items",
        "loopVar",
        "mode",
        "init",
        "condition",
        "update",
        "iterable",
        "body",
        "children",
        "index",
    ];
    const STRINGS: &[&str] = &[
        "x",
        "say",
        "user",
        "memory",
        "dbUser",
        "cacheUser",
        "+",
        "==",
        "++",
        "range",
        "foreach",
        "index",
        "append",
        "clear",
        "😀",
        "𐐀",
        "\\ud83d",
        "\\ude00",
        "\\ud83d\\ude00",
        "\\udfff\\ud800",
        "$(x)",
        "\\\\$",
        "a b",
        "e\u{301}",
        "שלום",
        "!so",
        "\\u0000",
        "\\n",
        "\\\"",
    ];
    let roll = rng.below(10);
    *budget = budget.saturating_sub(1);
    if depth < chain {
        out.push_str("{\"id\":\"c\",\"type\":\"function\",\"name\":\"s\",\"args\":[");
        random_json(rng, depth + 1, budget, chain, out);
        out.push_str("]}");
        return;
    }
    if *budget == 0 || depth > 12 || (depth > 2 && roll < 3) {
        match rng.below(5) {
            0 => out.push_str("null"),
            1 => out.push_str("12"),
            2 => out.push_str("[]"),
            _ => {
                out.push('"');
                let n = rng.below(4) + 1;
                for _ in 0..n {
                    out.push_str(rng.pick(STRINGS));
                }
                out.push('"');
            }
        }
        return;
    }
    if roll < 4 {
        out.push('[');
        for i in 0..rng.below(4) {
            if i > 0 {
                out.push(',');
            }
            random_json(rng, depth + 1, budget, chain, out);
        }
        out.push(']');
        return;
    }
    out.push('{');
    out.push_str("\"type\":\"");
    out.push_str(rng.pick(TYPES));
    out.push('"');
    for _ in 0..rng.below(6) {
        out.push_str(",\"");
        out.push_str(rng.pick(KEYS));
        out.push_str("\":");
        random_json(rng, depth + 1, budget, chain, out);
    }
    out.push('}');
}

#[test]
fn untrusted_block_json_never_panics_and_saves_only_within_limits() {
    let mut rng = Rng(0xdead_beef_cafe_f00d);
    let mut saved = 0;
    for _ in 0..3_000 {
        let mut text = String::from("{\"id\":\"r\",\"type\":\"root\",\"children\":[");
        for i in 0..rng.below(4) {
            if i > 0 {
                text.push(',');
            }
            let mut budget = 60;
            let chain = if rng.below(10) == 0 {
                rng.below(300)
            } else {
                0
            };
            random_json(&mut rng, 0, &mut budget, chain, &mut text);
        }
        text.push_str("]}");
        // The API edge: unpaired surrogate escapes become U+FFFD; the bounded reader refuses
        // nesting beyond its limit.
        let clean = dima_text::sanitize_lone_surrogates(text.as_bytes());
        let Ok(value) = serde_json::from_slice::<Value>(&clean) else {
            continue;
        };
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            if let Ok(root) = read_block_root(&value) {
                assert!(count(&root) <= MAX_BLOCK_NODES);
                assert!(root.children.iter().all(|c| depth(c) <= MAX_BLOCK_DEPTH));
            }
            compile_blocks(&value).ok()
        }));
        let Ok(compiled) = outcome else {
            panic!("panicked on {text}");
        };
        if let Some(compiled) = compiled {
            saved += 1;
            assert!(dima_text::char_len(&compiled.text) <= MAX_COMMAND_TEXT);
        }
    }
    assert!(
        saved > 10,
        "the generator should produce some valid trees ({saved})"
    );
}

#[test]
fn corpus_trees_with_unpaired_surrogate_escapes_never_panic() {
    let raw = include_bytes!("fixtures/ast_blocks_cases.json");
    let clean = dima_text::sanitize_lone_surrogates(raw);
    let corpus: Value = serde_json::from_slice(&clean).expect("the corpus is JSON");
    let mut rng = Rng(0x0123_4567_89ab_cdef);
    let mut compiled = 0;
    for case in corpus["cases"].as_array().into_iter().flatten() {
        if case["operation"] != "compile" {
            continue;
        }
        let text = case["input"].to_string();
        for escape in ["\\ud83d", "\\ude00", "\\udbff\\udbff", "\\ud83d\\ude00"] {
            // Put the escape right after a few string openings (`:"` starts a value).
            let mut mutated = String::with_capacity(text.len() + 64);
            for (i, piece) in text.split(":\"").enumerate() {
                if i > 0 {
                    mutated.push_str(":\"");
                    if rng.below(3) == 0 {
                        mutated.push_str(escape);
                    }
                }
                mutated.push_str(piece);
            }
            let clean = dima_text::sanitize_lone_surrogates(mutated.as_bytes());
            let Ok(value) = serde_json::from_slice::<Value>(&clean) else {
                continue;
            };
            let outcome = catch_unwind(AssertUnwindSafe(|| compile_blocks(&value).ok()));
            let Ok(result) = outcome else {
                panic!("panicked on {mutated}");
            };
            if let Some(result) = result {
                compiled += 1;
                assert!(dima_text::char_len(&result.text) <= MAX_COMMAND_TEXT);
            }
        }
    }
    assert!(compiled > 50, "{compiled}");
}

#[test]
fn deep_and_wide_block_trees_stop_at_the_limits() {
    let mut node = serde_json::json!({"id": "leaf", "type": "literal", "value": "x"});
    for i in 0..200 {
        node = serde_json::json!({"id": format!("f{i}"), "type": "function", "name": "s", "args": [node]});
    }
    let deep = serde_json::json!({"id": "r", "type": "root", "children": [node]});
    // serde_json's recursion limit is the edge's guard; built directly the tree is refused here.
    assert_eq!(
        read_block_root(&deep).unwrap_err().message,
        "Blocks are nested too deeply."
    );
    let wide: Vec<Value> = (0..5_000)
        .map(|i| serde_json::json!({"id": format!("w{i}"), "type": "literal", "value": "😀"}))
        .collect();
    let wide = serde_json::json!({"id": "r", "type": "root", "children": wide});
    assert_eq!(
        compile_blocks(&wide).unwrap_err().message,
        "Too many blocks (limit 4000)."
    );
}

#[test]
fn where_the_reference_throws_the_port_reports_or_parses() {
    let engine = SyntaxEngine::default();
    // `parseVarName(undefined)`: a variable introducer that ends an array item.
    for source in ["%[%(]", "%[^(]", "%[%del(]", "%[ %(]"] {
        let error = engine.parse(source).unwrap_err();
        assert_eq!(error.code, DiagnosticCode::MissingVariableName, "{source}");
    }
    // `unescapeLiteral(undefined)`: a per-viewer selector left open at the end of an item.
    for source in ["%[%(##x(]", "%[^(**x(]", "*(%[%del(##x(])"] {
        let error = engine.parse(source).unwrap_err();
        assert_eq!(error.code, DiagnosticCode::MissingUserSelector, "{source}");
        assert_eq!(source.get(error.span.start..error.span.end), Some("("));
    }
    // Inside an interpolation the reference catches the throw and shows the expression.
    for (source, shown) in [
        ("\"${%[%(]}\"", "[Parse error: %[%(]]"),
        ("*(\"${%[%(##x(]}\")", "[Parse error: %[%(##x(]]"),
    ] {
        let program = engine.parse(source).expect("parses");
        let segments = serde_json::json!([{"type": "text", "value": shown}]);
        assert_eq!(
            program.to_value()["children"][0]["segments"],
            segments,
            "{source}"
        );
    }
}

#[test]
fn budgets_are_per_segment_and_cover_nested_regions() {
    let engine = SyntaxEngine::default();
    let source = "$(user) $(user) $(user)";
    let plan = engine.compile_template(source).unwrap();
    let one = engine.compile_template("$(user)").unwrap().stats();
    assert_eq!(plan.stats().tokens, one.tokens * 3);
    assert_eq!(plan.stats().nodes, one.nodes * 3);
    // A cap one below a segment's need fails every segment on its own, not the plan.
    for limits in [
        Limits {
            tokens: one.tokens - 1,
            ..Limits::default()
        },
        Limits {
            nodes: one.nodes - 1,
            ..Limits::default()
        },
    ] {
        let plan = engine
            .clone()
            .with_limits(limits)
            .compile_template(source)
            .unwrap();
        for segment in plan.segments() {
            match segment.step() {
                SegmentStep::ParseError(error) => assert!(error.is_resource_limit()),
                SegmentStep::Text => {}
                other => panic!("{other:?}"),
            }
        }
    }
    // One expression over a cap does not fail the others.
    let mixed = "$(user) $(say a b c d e f) $(user)";
    let capped = engine.clone().with_limits(Limits {
        nodes: one.nodes,
        ..Limits::default()
    });
    let plan = capped.compile_template(mixed).unwrap();
    let steps: Vec<_> = plan.segments().iter().map(|s| s.step()).collect();
    assert!(matches!(steps[0], SegmentStep::Program(_)));
    assert!(matches!(steps[2], SegmentStep::ParseError(e) if e.code == DiagnosticCode::NodeLimit));
    assert!(matches!(steps[4], SegmentStep::Program(_)));
    for nested in ["%[%[1,2],%[3,4]]", "\"${1}${2}${3}\""] {
        let stats = engine.parse(nested).unwrap().stats();
        let tokens = engine.clone().with_limits(Limits {
            tokens: stats.tokens - 1,
            ..Limits::default()
        });
        assert_eq!(
            tokens.parse(nested).unwrap_err().code,
            DiagnosticCode::TokenLimit
        );
        let nodes = engine.clone().with_limits(Limits {
            nodes: stats.nodes - 1,
            ..Limits::default()
        });
        assert_eq!(
            nodes.parse(nested).unwrap_err().code,
            DiagnosticCode::NodeLimit
        );
    }
    for limits in [
        Limits {
            tokens: 0,
            ..Limits::default()
        },
        Limits {
            nodes: 0,
            ..Limits::default()
        },
        Limits {
            nesting: 0,
            ..Limits::default()
        },
    ] {
        let error = engine
            .clone()
            .with_limits(limits)
            .parse("$(user)")
            .unwrap_err();
        assert!(error.is_resource_limit());
    }
    // Arrays are indexed once per region, not once per ancestor.
    let stats = engine.parse("%[%[%[1,2],3],4]").unwrap().stats();
    assert_eq!(stats.arrays, 3);
}

#[test]
fn arrays_nest_like_the_reference_and_the_json_depth_is_checked_on_request() {
    let engine = SyntaxEngine::default();
    // Each nested array adds two JSON containers (the node and its `items`). The reference
    // parses 2,048 nested arrays; a caller that stores a tree as JSON asks for the check.
    let wrapped = |n: usize| format!("{}1{}", "%[".repeat(n), "]".repeat(n));
    let mut readable = 0;
    for n in (1..=80).chain([2_048]) {
        let program = engine.parse(&wrapped(n)).unwrap();
        match program.check_json_depth() {
            Ok(()) => {
                readable = n;
                let text = serde_json::to_string(&program.to_value()).unwrap();
                assert!(serde_json::from_str::<Value>(&text).is_ok(), "depth {n}");
            }
            Err(error) => {
                assert_eq!(error.code, DiagnosticCode::NestingLimit);
                assert_eq!(
                    error.message,
                    "AST JSON serialization nesting limit exceeded"
                );
            }
        }
    }
    assert_eq!(readable, 62);
}

#[test]
fn compiled_plans_record_their_source_grammar_and_limits() {
    let source = "Hi $(user)!";
    let engine = SyntaxEngine::default();
    let plan = engine.compile_template(source).unwrap();
    assert!(plan.matches_source(source));
    assert!(plan.is_compatible_with(&SyntaxEngine::default(), source));
    assert!(!plan.is_compatible_with(&engine, "Hi $(user)! "));
    let other = engine.clone().with_limits(Limits {
        nodes: 10,
        ..Limits::default()
    });
    assert!(!plan.is_compatible_with(&other, source));
    let grammar = GrammarBuilder::default()
        .register("$$(", ")", SyntaxHandler::Function)
        .build()
        .unwrap();
    let extended = SyntaxEngine::new(grammar, Limits::default());
    assert!(!plan.is_compatible_with(&extended, source));
}

#[test]
fn grammar_extensions_keep_the_reference_rules() {
    assert!(
        GrammarBuilder::default()
            .register("%[x(", ")", SyntaxHandler::Function)
            .build()
            .is_err()
    );
    for bad in ["x", "a b(", "@(", "@("] {
        let end = if bad == "@(" { "]" } else { ")" };
        assert!(
            GrammarBuilder::default()
                .register(bad, end, SyntaxHandler::Function)
                .build()
                .is_err(),
            "{bad}"
        );
    }
    let grammar = GrammarBuilder::default()
        .register("@(", ")", SyntaxHandler::Variable)
        .build()
        .unwrap();
    let engine = SyntaxEngine::new(grammar, Limits::default());
    let program = engine.parse("@(x 1)").unwrap();
    assert!(matches!(program.children(), [AstNode::SetVar { .. }]));
    let segments = engine.scan_template("hi @(x) \\@(y)").unwrap();
    let kinds: Vec<_> = segments.iter().map(|s| s.kind).collect();
    assert_eq!(
        kinds,
        [SegmentKind::Text, SegmentKind::Expr, SegmentKind::Text]
    );
}

#[test]
fn imports_are_bounded_by_the_syntax_limits() {
    // 12,000-character expressions written back from 10,000 characters of text still read:
    // the reference imports this, then fails to save it (too long).
    let text = format!("*(\"{}\")", "$(x)".repeat(2_400));
    let imported = import_command_text_with(&text, &mut IdMaker::new("i", "")).unwrap();
    assert_eq!(imported.advanced_count, 0);
    let error = compile_blocks(&imported.root.to_value()).unwrap_err();
    assert_eq!(
        error.message,
        "This command is too long (12000 of 10000 characters)."
    );
}

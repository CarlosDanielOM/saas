//! The syntax corpus (`fixtures/ast_syntax_cases.json`, generated from today's TypeScript by
//! `fixtures/ast_syntax_reference.mjs` under Node 24) run against `dima_engine::syntax`.
//!
//! Every case must give the TypeScript result (`expected.legacy`: the reference's AST or error
//! message, plus the generator's UTF-16 location of the error). The intended differences are
//! stated once each, in [`Expected`]:
//!
//! 1. positions: the port's spans are byte offsets; [`Span::to_utf16`] must give the recorded
//!    UTF-16 span exactly;
//! 2. the source limit: a source over 10,000 characters is a `SOURCE_LIMIT` diagnostic covering
//!    the whole source (the reference has no limit and parses it).
//!
//! Everything else is compared exactly.

use dima_engine::syntax::{
    AstNode, CompiledProgram, Diagnostic, Limits, SegmentKind, SegmentStep, SourceSegment, Span,
    SyntaxEngine, unescape_literal, unescape_rendered_text,
};
use serde_json::{Value, json};

fn corpus() -> Value {
    let raw = include_bytes!("fixtures/ast_syntax_cases.json");
    // A recorded string may hold half of a surrogate pair; the API edge replaces it with U+FFFD.
    let clean = dima_text::sanitize_lone_surrogates(raw);
    serde_json::from_slice(&clean).expect("the corpus is JSON")
}

thread_local! {
    /// Off only to count the cases where the conversion changes a number.
    static CONVERT: std::cell::Cell<bool> = const { std::cell::Cell::new(true) };
}

/// Difference 1: a byte span, as the UTF-16 span a JavaScript client would get.
fn span_value(source: &str, span: Span) -> Value {
    if !CONVERT.with(std::cell::Cell::get) {
        return json!({"start": span.start, "end": span.end});
    }
    let units = span.to_utf16(source);
    json!({"start": units.start, "end": units.end})
}

fn diagnostic_value(source: &str, diagnostic: &Diagnostic) -> Value {
    json!({
        "code": diagnostic.code.as_str(),
        "message": diagnostic.message,
        "span": span_value(source, diagnostic.span),
    })
}

fn program_value(source: &str, result: Result<&CompiledProgram, &Diagnostic>) -> Value {
    match result {
        Ok(program) => json!({"outcome": "program", "ast": program.to_value()}),
        Err(error) => json!({"outcome": "diagnostic", "diagnostic": diagnostic_value(source, error)}),
    }
}

fn segment_value(source: &str, segment: SourceSegment) -> Value {
    let text = segment.text(source);
    let field = if segment.kind == SegmentKind::Text {
        "text"
    } else {
        "source"
    };
    json!({"kind": segment.kind.as_str(), field: text, "span": span_value(source, segment.span)})
}

/// What the port gives for a case, in the corpus's shape (spans converted to UTF-16 units).
fn actual(engine: &SyntaxEngine, case: &Value) -> Value {
    let input = &case["input"];
    let source = input["source"].as_str().unwrap_or_default();
    match case["operation"].as_str().unwrap_or_default() {
        "parse" => program_value(source, engine.parse(source).as_ref()),
        "scan" => match engine.scan_template(source) {
            Ok(segments) => {
                json!({"segments": segments.iter().map(|s| segment_value(source, *s)).collect::<Vec<_>>()})
            }
            Err(error) => json!({"error": diagnostic_value(source, &error)}),
        },
        "compiled-template" => match engine.compile_template(source) {
            Ok(plan) => {
                let segments: Vec<_> = plan
                    .segments()
                    .iter()
                    .map(|plan| {
                        let mut value = segment_value(source, plan.segment());
                        match plan.step() {
                            SegmentStep::Text => {}
                            SegmentStep::Program(program) => {
                                value["program"] = program_value(source, Ok(program));
                            }
                            SegmentStep::ParseError(error) => {
                                value["program"] = program_value(source, Err(error));
                            }
                            SegmentStep::Unclosed(error) => {
                                value["diagnostic"] = diagnostic_value(source, error);
                            }
                        }
                        value
                    })
                    .collect();
                json!({"segments": segments})
            }
            Err(error) => json!({"error": diagnostic_value(source, &error)}),
        },
        "unescape" => {
            let value = input["value"].as_str().unwrap_or_default();
            match input["surface"].as_str() {
                Some("rendered") => json!({"value": unescape_rendered_text(value)}),
                _ => json!({"value": unescape_literal(value)}),
            }
        }
        other => json!({"unknown operation": other}),
    }
}

/// Which rule gives a case's expectation.
#[derive(Debug, PartialEq, Eq)]
enum Expected {
    /// The recorded TypeScript result, with recorded UTF-16 spans.
    Recorded,
    /// Difference 2: the source is over the character limit.
    SourceLimit,
}

fn rule(source: &str) -> Expected {
    if dima_text::char_len(source) > Limits::default().source_chars {
        Expected::SourceLimit
    } else {
        Expected::Recorded
    }
}

fn expectation(case: &Value) -> Value {
    let source = case["input"]["source"].as_str().unwrap_or_default();
    match (rule(source), case["operation"].as_str().unwrap_or_default()) {
        (Expected::SourceLimit, operation) => {
            let error = json!({
                "code": "SOURCE_LIMIT",
                "message": "Source character limit exceeded",
                "span": {"start": 0, "end": dima_text::utf16_len(source)},
            });
            if operation == "parse" {
                json!({"outcome": "diagnostic", "diagnostic": error})
            } else {
                json!({"error": error})
            }
        }
        (Expected::Recorded, _) => case["expected"]["legacy"].clone(),
    }
}

/// The recorded expectation, stripped of the generator's spans and codes, is the untouched
/// TypeScript result (`source`): the expectations are not edited, only located.
fn recorded_matches_source(case: &Value) -> bool {
    let strip_parse = |value: &Value| match value["outcome"].as_str() {
        Some("program") => json!({"ast": value["ast"]}),
        _ => json!({"ast": {"type": "root", "children": []}, "error": value["diagnostic"]["message"]}),
    };
    let legacy = &case["expected"]["legacy"];
    let stripped = match case["operation"].as_str().unwrap_or_default() {
        "parse" => strip_parse(legacy),
        "scan" | "compiled-template" => {
            let segments: Vec<_> = legacy["segments"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|segment| {
                    let mut segment = segment.clone();
                    if let Some(object) = segment.as_object_mut() {
                        object.remove("span");
                        object.remove("diagnostic");
                        if let Some(program) = object.remove("program") {
                            object.insert("parse".into(), strip_parse(&program));
                        }
                    }
                    segment
                })
                .collect();
            json!({"segments": segments})
        }
        _ => legacy.clone(),
    };
    stripped == case["source"]
}

#[test]
fn every_corpus_case_gives_the_typescript_result() {
    let corpus = corpus();
    let cases = corpus["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 1260, "regenerate the test's counts with the corpus");
    let engine = SyntaxEngine::default();
    let mut failures = Vec::new();
    let mut source_limit = 0;
    let mut converted_spans = 0;
    for case in cases {
        let name = case["name"].as_str().unwrap_or_default();
        let source = case["input"]["source"].as_str().unwrap_or_default();
        match case["parity"].as_str() {
            Some("source-throw-hardened") => {
                // The reference throws a TypeError; the recorded legacy result is the port's
                // `MISSING_VARIABLE_NAME` diagnostic (see `DiagnosticCode::MissingVariableName`).
                assert_eq!(
                    case["source"]["thrown"]["name"], "TypeError",
                    "{name}: only TypeErrors are hardened"
                );
                assert_eq!(
                    case["expected"]["legacy"]["diagnostic"]["code"],
                    "MISSING_VARIABLE_NAME"
                );
            }
            _ => {
                if !recorded_matches_source(case) {
                    failures.push(format!("{name}: recorded expectation drifted from the source"));
                }
            }
        }
        if rule(source) == Expected::SourceLimit {
            source_limit += 1;
        } else {
            CONVERT.with(|convert| convert.set(false));
            let in_bytes = actual(&engine, case);
            CONVERT.with(|convert| convert.set(true));
            if in_bytes != actual(&engine, case) {
                converted_spans += 1;
            }
        }
        let expected = expectation(case);
        let actual = actual(&engine, case);
        if actual != expected {
            failures.push(format!(
                "{name}\n  expected {}\n  actual   {}",
                truncate(&expected),
                truncate(&actual)
            ));
        }
    }
    for failure in failures.iter().take(20) {
        eprintln!("{failure}");
    }
    assert!(failures.is_empty(), "{} corpus mismatches", failures.len());
    // The intended differences and how many cases they touch.
    assert_eq!(source_limit, 6, "cases over the 10,000-character source limit");
    assert_eq!(converted_spans, 27, "cases whose byte spans differ from UTF-16 spans");
}

fn truncate(value: &Value) -> String {
    let text = value.to_string();
    dima_text::truncate_chars(&text, 600).to_owned()
}

#[test]
fn recorded_asts_round_trip_through_the_typed_shape() {
    let corpus = corpus();
    let mut checked = 0;
    let mut stack: Vec<&Value> = vec![&corpus["cases"]];
    while let Some(value) = stack.pop() {
        match value {
            Value::Object(object) => {
                for (key, child) in object {
                    if key == "ast" {
                        let node: AstNode = serde_json::from_value(child.clone())
                            .unwrap_or_else(|error| panic!("{error}: {child}"));
                        assert_eq!(&node.to_value(), child);
                        checked += 1;
                    } else {
                        stack.push(child);
                    }
                }
            }
            Value::Array(items) => stack.extend(items),
            _ => {}
        }
    }
    assert!(checked > 2000, "{checked}");
}

#[test]
fn the_source_limit_counts_characters_and_reports_bytes() {
    let engine = SyntaxEngine::default();
    let at_limit = "😀".repeat(10_000);
    assert!(engine.parse(&at_limit).is_ok(), "10,000 emoji are 10,000 characters");
    let over = "😀".repeat(10_001);
    let error = engine.parse(&over).unwrap_err();
    assert_eq!(error.message, "Source character limit exceeded");
    assert_eq!(error.span, Span { start: 0, end: over.len() });
    assert_eq!(error.span.to_utf16(&over).end, 20_002);
    let small = engine.with_limits(Limits {
        source_chars: 2,
        ..Limits::default()
    });
    assert!(small.parse("😀é").is_ok());
    assert!(small.parse("e\u{301}x").is_err(), "a combining mark is its own character");
}

#[test]
fn byte_spans_never_split_a_character_and_convert_to_javascript_offsets() {
    let engine = SyntaxEngine::default();
    let source = "😀 )";
    let error = engine.parse(source).unwrap_err();
    assert_eq!(error.span, Span { start: 5, end: 6 });
    assert_eq!(source.get(error.span.start..error.span.end), Some(")"));
    assert_eq!(error.span.to_utf16(source).start, 3);
    let segments = engine.scan_template("😀 $(user)!").unwrap();
    assert_eq!(segments[1].span, Span { start: 5, end: 12 });
    assert_eq!(segments[1].text("😀 $(user)!"), "$(user)");
    let template = "שלום $(say %[a, b) ok";
    let plan = engine.compile_template(template).unwrap();
    let SegmentStep::ParseError(error) = plan.segments()[1].step() else {
        panic!("expected a parse error");
    };
    assert_eq!(error.message, "Unclosed array literal");
    assert_eq!(template.get(error.span.start..error.span.end), Some("%[a, b)"));
}

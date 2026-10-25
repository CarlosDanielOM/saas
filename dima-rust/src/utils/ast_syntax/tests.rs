use super::*;
use serde_json::{Value, json};

fn parsed(input: &str) -> Value {
    SyntaxEngine::default().parse(input).unwrap().to_value()
}
fn child(input: &str) -> Value {
    parsed(input)["children"][0].clone()
}

#[test]
fn persisted_root_fields_and_omissions_match_source() {
    assert_eq!(
        parsed("%(**score(alice)[1] 7)"),
        json!({"type":"root","children":[{
            "type":"setVar","name":"**score","storage":"dbUser",
            "userSelector":{"type":"literal","value":"alice"},
            "accessor":{"type":"setIndex","index":{"type":"literal","value":"1"}},
            "value":{"type":"literal","value":"7"}
        }]})
    );
    assert_eq!(
        child("%(#queue[])"),
        json!({"type":"getVar","name":"#queue","storage":"cache","accessor":{"type":"array"}})
    );
    assert_eq!(
        child("%(**queue[] item)"),
        json!({"type":"setVar","name":"**queue","storage":"dbUser","accessor":{"type":"append"},"value":{"type":"literal","value":"item"}})
    );
    assert_eq!(
        child("^(##queue[random])")["accessor"],
        json!({"type":"random"})
    );
    assert_eq!(child("%del(*queue[1+1])")["accessor"]["type"], "remove");
    assert_eq!(child("%del(queue[])")["accessor"], json!({"type":"clear"}));
    let omitted = child("%(name)");
    assert!(omitted.get("accessor").is_none());
    assert!(omitted.get("userSelector").is_none());
    assert_eq!(omitted["name"], "name");
    assert_eq!(omitted["storage"], "memory");
}

#[test]
fn program_and_chat_grammars_remain_distinct() {
    assert_eq!(
        parsed("hello world")["children"].as_array().unwrap().len(),
        2
    );
    let segments = SyntaxEngine::default()
        .scan_template("hello world $(say hi)!")
        .unwrap();
    assert_eq!(segments.len(), 3);
    assert!(matches!(&segments[0], SourceSegment::Text { text, .. } if text == "hello world "));
    assert!(matches!(&segments[1], SourceSegment::Expr { source, .. } if source == "$(say hi)"));
    assert_eq!(segments[2].raw_text(), "!");
}

#[test]
fn apostrophes_are_text_except_real_array_quotes() {
    let improved = SyntaxEngine::default();
    let legacy = SyntaxEngine::typescript_compatible();
    assert!(matches!(
        &improved.scan_template("$(say don't panic)").unwrap()[0],
        SourceSegment::Expr { .. }
    ));
    assert!(matches!(
        &legacy.scan_template("$(say don't panic)").unwrap()[0],
        SourceSegment::Unclosed { .. }
    ));
    assert_eq!(
        child("%[it's, two]")["items"],
        json!([{"type":"literal","value":"it's"},{"type":"literal","value":"two"}])
    );
    assert_eq!(
        child("%['one,two', three]")["items"][0],
        json!({"type":"literal","value":"'one,two'"})
    );
    assert_eq!(
        legacy.parse("%[it's, two]").unwrap_err().message,
        "Unclosed array literal"
    );
    assert_eq!(
        improved.scan_template("$(say 'one)two') tail").unwrap()[0].raw_text(),
        "$(say 'one)two')"
    );
    let segments = improved.scan_template("$(say %[')', two]) tail").unwrap();
    assert_eq!(segments[0].raw_text(), "$(say %[')', two])");
    assert_eq!(segments[1].raw_text(), " tail");
}

#[test]
fn array_scanning_respects_escaped_delimiters() {
    assert_eq!(child(r"%[one\], two]")["items"][0]["value"], "one]");
    let segments = SyntaxEngine::default()
        .scan_template(r"$(say %[one\], two]) tail")
        .unwrap();
    assert_eq!(segments[0].raw_text(), r"$(say %[one\], two])");
    assert_eq!(segments[1].raw_text(), " tail");
    assert_eq!(
        SyntaxEngine::typescript_compatible()
            .parse(r"%[one\], two]")
            .unwrap_err()
            .message,
        "Unexpected closing \"]\""
    );
}

#[test]
fn improved_chat_quotes_follow_tokenizer_interpolation_boundaries() {
    let engine = SyntaxEngine::default();
    let legacy = SyntaxEngine::typescript_compatible();
    for expression in [
        r#"$(say "${")"}")"#,
        r#"$(say "${"${")"}"}")"#,
        r#"$(say "${\")\"}")"#,
        r#"$(say "${"\{)\}"}")"#,
        r#"$(say "left \" ) ${")"} right")"#,
    ] {
        let expected = engine.parse(expression).unwrap().to_value();
        assert_eq!(legacy.parse(expression).unwrap().to_value(), expected);
        let source = format!("{expression} tail");
        let end = expression.encode_utf16().count();
        assert_eq!(
            engine.scan_template(&source).unwrap(),
            vec![
                SourceSegment::Expr {
                    source: expression.into(),
                    span: SourceSpan { start: 0, end },
                },
                SourceSegment::Text {
                    text: " tail".into(),
                    span: SourceSpan {
                        start: end,
                        end: end + 5,
                    },
                },
            ],
            "{source}"
        );
        let plan = engine.compile_template(&source).unwrap();
        let program = plan.segments()[0].program().unwrap().as_ref().unwrap();
        assert_eq!(program.source(), expression);
        assert_eq!(program.to_value(), expected);
    }
    let legacy_segments = legacy.scan_template(r#"$(say "${")"}") tail"#).unwrap();
    assert_eq!(legacy_segments.len(), 2);
    assert_eq!(legacy_segments[0].raw_text(), r#"$(say "${")"#);
    assert_eq!(legacy_segments[1].raw_text(), r#""}") tail"#);
    assert_eq!(
        child(r#"$(say "${")"}")"#)["args"][0]["segments"][0]["node"],
        json!({"type":"template","segments":[{"type":"text","value":")"}]})
    );
}

#[test]
fn improved_array_quotes_share_interpolation_boundaries() {
    let engine = SyntaxEngine::default();
    for (expression, quoted) in [
        (r#"$(say %["${"]"}", two])"#, r#""${"]"}""#),
        (r#"$(say %["${","}", two])"#, r#""${","}""#),
        (r#"$(say %["${"${"],)"}"}", two])"#, r#""${"${"],)"}"}""#),
        (r#"$(say %["${"\{],)\}"}", two])"#, r#""${"\{],)\}"}""#),
    ] {
        let program = engine.parse(expression).unwrap();
        assert_eq!(
            program.to_value()["children"][0]["args"][0]["items"],
            json!([child(quoted), {"type":"literal","value":"two"}]),
            "{expression}"
        );
        let source = format!("{expression} tail");
        let segments = engine.scan_template(&source).unwrap();
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].raw_text(), expression);
        assert_eq!(segments[1].raw_text(), " tail");
        let plan = engine.compile_template(&source).unwrap();
        assert_eq!(
            plan.segments()[0]
                .program()
                .unwrap()
                .as_ref()
                .unwrap()
                .root(),
            program.root()
        );
    }
    let legacy = SyntaxEngine::typescript_compatible();
    assert_eq!(
        legacy.parse(r#"%["${"]"}", two]"#).unwrap_err().message,
        "Unexpected closing \"]\""
    );
    assert_eq!(
        legacy.parse(r#"%["${","}", two]"#).unwrap().to_value()["children"][0]["items"],
        json!([
            {"type":"literal","value":""},
            {"type":"template","segments":[{"type":"text","value":"}"}]},
            {"type":"literal","value":"two"}
        ])
    );
}

#[test]
fn unclosed_interpolated_quotes_keep_closing_parens_inside_the_segment() {
    let engine = SyntaxEngine::default();
    for (source, code) in [
        (r#"$(say "${")"}) tail"#, DiagnosticCode::UnclosedQuote),
        (r#"$(say "${")"") tail"#, DiagnosticCode::UnclosedQuote),
        (r#"$(say "${1\}") tail"#, DiagnosticCode::UnclosedQuote),
        (r#"$(say "escaped \") tail"#, DiagnosticCode::UnclosedQuote),
        (r#"$(say %["${"]"}) tail"#, DiagnosticCode::UnclosedArray),
    ] {
        assert_eq!(engine.parse(source).unwrap_err().code, code, "{source}");
        let span = SourceSpan {
            start: 0,
            end: source.encode_utf16().count(),
        };
        assert_eq!(
            engine.scan_template(source).unwrap(),
            vec![SourceSegment::Unclosed {
                source: source.into(),
                span,
            }],
            "{source}"
        );
        let plan = engine.compile_template(source).unwrap();
        assert!(plan.segments()[0].program().is_none());
        let error = plan.segments()[0].diagnostic().unwrap();
        assert_eq!(error.code, DiagnosticCode::UnclosedExpression);
        assert_eq!(error.span, span);
    }
    let plan = engine
        .compile_template(r#"$(say %["${"]"}", two) tail"#)
        .unwrap();
    assert_eq!(plan.segments().len(), 2);
    assert_eq!(plan.segments()[1].source_segment().raw_text(), " tail");
    assert_eq!(
        plan.segments()[0].diagnostic().unwrap().code,
        DiagnosticCode::UnclosedArray
    );
}

#[test]
fn inner_errors_and_remaining_tokens_have_precise_diagnostics() {
    let engine = SyntaxEngine::default();
    let nested = engine.parse("%[%(x]").unwrap_err();
    assert_eq!(nested.code, DiagnosticCode::UnclosedDelimiter);
    assert_eq!(nested.message, "Unclosed \"%(\"");
    assert_eq!(nested.span, SourceSpan { start: 2, end: 4 });
    let trailing = engine.parse("\"${1 2}\"").unwrap_err();
    assert_eq!(trailing.code, DiagnosticCode::UnexpectedToken);
    assert_eq!(trailing.span, SourceSpan { start: 5, end: 6 });
    assert!(engine.parse("%[one two]").is_err());
    let legacy = SyntaxEngine::typescript_compatible();
    assert!(legacy.parse("%[%(x]").is_ok());
    assert_eq!(
        legacy.parse("\"${1 2}\"").unwrap().to_value()["children"][0]["segments"][0]["node"]["value"],
        "1"
    );
    assert!(legacy.parse("%[one two]").is_ok());
    let message = legacy.parse("\"${1]}\"").unwrap().to_value();
    assert_eq!(
        message["children"][0]["segments"][0]["value"],
        "[Parse error: Unexpected closing \"]\"]"
    );
}

#[test]
fn interpolation_parser_failures_keep_the_legacy_error_literal_channel() {
    let source = r#""${%[%(]}""#;
    let legacy = SyntaxEngine::typescript_compatible();
    assert_eq!(
        legacy.parse(source).unwrap().to_value(),
        json!({"type":"root","children":[{"type":"template","segments":[{
            "type":"text","value":"[Parse error: %[%(]]"
        }]}]})
    );
    assert_eq!(
        SyntaxEngine::default().parse(source).unwrap_err(),
        Diagnostic {
            code: DiagnosticCode::UnclosedDelimiter,
            message: "Unclosed \"%(\"".into(),
            span: SourceSpan { start: 5, end: 7 },
        }
    );
    for (limits, code) in [
        (
            Limits {
                tokens: 1,
                ..Limits::default()
            },
            DiagnosticCode::TokenLimit,
        ),
        (
            Limits {
                nodes: 0,
                ..Limits::default()
            },
            DiagnosticCode::NodeLimit,
        ),
    ] {
        assert_eq!(
            legacy
                .clone()
                .with_limits(limits)
                .parse(r#""${1}""#)
                .unwrap_err()
                .code,
            code
        );
    }
}

#[test]
fn overlapping_introducers_agree_in_programs_and_compiled_plans() {
    let grammar = GrammarBuilder::default()
        .register("$((", ")", SyntaxHandler::Function)
        .build()
        .unwrap();
    let engine = SyntaxEngine::new(grammar.clone(), SyntaxProfile::Improved, Limits::default());
    for (source, ordinary) in [
        ("$((user)", "$(user)"),
        ("$(say $((user))", "$(say $(user))"),
        ("$((say $((user))", "$(say $(user))"),
        ("$(say %[$((user), x])", "$(say %[$(user), x])"),
    ] {
        let expected = SyntaxEngine::default().parse(ordinary).unwrap().to_value();
        assert_eq!(engine.parse(source).unwrap().to_value(), expected);
        let plan = engine.compile_template(source).unwrap();
        assert_eq!(plan.segments().len(), 1);
        assert_eq!(
            plan.segments()[0]
                .program()
                .unwrap()
                .as_ref()
                .unwrap()
                .to_value(),
            expected
        );
    }
    let legacy = SyntaxEngine::new(
        grammar,
        SyntaxProfile::TypeScriptCompatible,
        Limits::default(),
    );
    assert_eq!(
        legacy.parse("$((user)").unwrap_err().message,
        "Unclosed \"$(\""
    );
}

#[test]
fn url_shaped_introducers_make_progress_and_never_emit_empty_tokens() {
    let grammar = GrammarBuilder::default()
        .register("http://(", ")", SyntaxHandler::Function)
        .register("https://(", ")", SyntaxHandler::Function)
        .build()
        .unwrap();
    for profile in [SyntaxProfile::Improved, SyntaxProfile::TypeScriptCompatible] {
        let engine = SyntaxEngine::new(grammar.clone(), profile, Limits::default());
        for source in ["http://(user)", "https://(user)"] {
            assert_eq!(engine.parse(source).unwrap().to_value(), parsed("$(user)"));
            let view = View::original(Source::new(source, Limits::default()).unwrap());
            let tokens = lexer::tokenize(
                view,
                0..source.len(),
                &grammar,
                profile,
                &mut Budget::new(Limits::default()),
                0,
            )
            .unwrap();
            assert_eq!(tokens.tokens.len(), 3);
            assert!(tokens.tokens.iter().all(|token| !token.bytes.is_empty()));
        }
        assert_eq!(
            engine
                .parse("https://example.test/a?q=1")
                .unwrap()
                .to_value(),
            parsed("https://example.test/a?q=1")
        );
    }
}

#[test]
fn precedence_sequence_slots_empty_ternaries_and_loop_literals_are_preserved() {
    let tree = child("*(1+2*3==7 ? yes : no)");
    assert_eq!(tree["type"], "ternary");
    assert_eq!(tree["test"]["operator"], "==");
    assert_eq!(tree["test"]["left"]["right"]["operator"], "*");
    assert_eq!(child("*(1 ?:)")["consequent"]["value"], "");
    assert_eq!(child("*(1 ?:)")["alternate"]["value"], "");
    assert_eq!(child("*(1 ? yes)")["alternate"]["value"], "");
    // Assignment consumes exactly one source expression slot; trailing words
    // remain root siblings rather than silently becoming an implicit sequence.
    assert_eq!(
        parsed("%(message hello world)")["children"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        child("*(for wrong in %[1] {$(say hi)})")["value"],
        "[Loop error: invalid loop variable]"
    );
    assert_eq!(
        child("#(hello one (two))")["args"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
}

#[test]
fn arrays_accessors_loops_functions_urls_and_templates() {
    assert_eq!(
        child("%[1, %[2,3], 4][].length")["accessor"],
        json!({"type":"length"})
    );
    assert_eq!(
        child("%[1,2][random]")["accessor"],
        json!({"type":"random"})
    );
    assert_eq!(child("%[1,2][-1]")["accessor"]["index"]["type"], "unary");
    let loop_node = child("*(for #i = 0; #i < 3; #i++ {$(say #i)})");
    assert_eq!(loop_node["type"], "forLoop");
    assert_eq!(loop_node["mode"], "range");
    assert_eq!(loop_node["init"]["operator"], "=");
    assert_eq!(
        loop_node["update"],
        json!({"type":"loopAssign","name":"i","operator":"++"})
    );
    assert_eq!(child("*(for #item in %[a,b] {#item})")["mode"], "foreach");
    let url = child("$(say https://example.test/a?q=1)");
    assert_eq!(url["name"], "say");
    assert_eq!(url["args"][0]["value"], "https://example.test/a?q=1");
    assert_eq!(child("$(some.function hello)")["name"], "some.function");
    assert_eq!(
        child(r#""hello\n${1+2}""#)["segments"][0]["value"],
        "hello\n"
    );
}

#[test]
fn escaped_templates_retain_legacy_interpolation_policy() {
    let node = child(r#""\${1}""#);
    assert_eq!(node["segments"][0], json!({"type":"text","value":"\\"}));
    assert_eq!(node["segments"][1]["type"], "expr");
    assert_eq!(
        unescape_rendered_text(r"\$(literal) \% \* \# \^ \)"),
        "$(literal) % * # ^ \\)"
    );
    let scanned = SyntaxEngine::default()
        .scan_template(r"\$(literal) $(say hi)")
        .unwrap();
    assert_eq!(scanned[0].raw_text(), r"\$(literal) ");
}

#[test]
fn utf16_ranges_include_surrogate_pairs_and_decoded_offsets() {
    let error = SyntaxEngine::default().parse("😀 ]").unwrap_err();
    assert_eq!(error.span, SourceSpan { start: 3, end: 4 });
    let error = SyntaxEngine::default()
        .parse("\"😀\\n${1 2}\"")
        .unwrap_err();
    assert_eq!(error.span, SourceSpan { start: 9, end: 10 });
    let scan = SyntaxEngine::default()
        .scan_template("😀 $(say ñ)")
        .unwrap();
    assert_eq!(scan[0].span(), SourceSpan { start: 0, end: 3 });
    assert_eq!(scan[1].span(), SourceSpan { start: 3, end: 11 });
    assert_eq!(child("\u{feff}hello\u{00a0}")["value"], "hello");
    assert_eq!(child("\u{0085}hello")["value"], "\u{0085}hello");
}

#[test]
fn interpolated_scanner_ranges_and_errors_use_original_utf16_offsets() {
    let engine = SyntaxEngine::default();
    let source = r#"😀 $(say "${"ñ😀)"}") tail 🦀"#;
    let segments = engine.scan_template(source).unwrap();
    assert_eq!(segments.len(), 3);
    assert_eq!(segments[0].span(), SourceSpan { start: 0, end: 3 });
    assert_eq!(segments[1].span(), SourceSpan { start: 3, end: 21 });
    assert_eq!(segments[2].span(), SourceSpan { start: 21, end: 29 });
    assert_eq!(segments[1].raw_text(), r#"$(say "${"ñ😀)"}")"#);
    let plan = engine.compile_template(source).unwrap();
    assert_eq!(
        plan.segments()[1]
            .program()
            .unwrap()
            .as_ref()
            .unwrap()
            .source(),
        segments[1].raw_text()
    );
    let source = r#"😀 $(say "a\n${\"😀)\" 2}") tail"#;
    let plan = engine.compile_template(source).unwrap();
    assert_eq!(plan.segments().len(), 3);
    let error = plan.segments()[1].diagnostic().unwrap();
    assert_eq!(error.code, DiagnosticCode::UnexpectedToken);
    assert_eq!(error.span, SourceSpan { start: 23, end: 24 });
    for (source, nesting) in [(r#"$(say "${1}")"#, 2), (r#"$(say %["${1}"])"#, 3)] {
        let bounded = engine.clone().with_limits(Limits {
            nesting,
            ..Limits::default()
        });
        assert_eq!(
            bounded.scan_template(source).unwrap_err().code,
            DiagnosticCode::NestingLimit
        );
        assert_eq!(
            bounded.compile_template(source).unwrap_err().code,
            DiagnosticCode::NestingLimit
        );
    }
}

#[test]
fn bounded_source_tokens_nodes_depth_and_shared_segment_budgets() {
    let engine = SyntaxEngine::default();
    let tiny = engine.clone().with_limits(Limits {
        source_utf16: 1,
        ..Limits::default()
    });
    assert_eq!(
        tiny.parse("😀").unwrap_err().code,
        DiagnosticCode::SourceLimit
    );
    let tiny = engine.clone().with_limits(Limits {
        tokens: 2,
        ..Limits::default()
    });
    assert_eq!(
        tiny.parse("one two three").unwrap_err().code,
        DiagnosticCode::TokenLimit
    );
    let tiny = engine.clone().with_limits(Limits {
        nodes: 2,
        ..Limits::default()
    });
    assert_eq!(
        tiny.parse("one two").unwrap_err().code,
        DiagnosticCode::NodeLimit
    );
    let tiny = engine.clone().with_limits(Limits {
        tokens: 7,
        ..Limits::default()
    });
    assert_eq!(
        tiny.compile_template("$(say one) $(say two)")
            .unwrap_err()
            .code,
        DiagnosticCode::TokenLimit
    );
    let tiny = engine.clone().with_limits(Limits {
        tokens: 3,
        ..Limits::default()
    });
    assert_eq!(
        tiny.parse("%[a,%[b,c]]").unwrap_err().code,
        DiagnosticCode::TokenLimit
    );
    let tiny = engine.with_limits(Limits {
        nesting: 4,
        ..Limits::default()
    });
    assert_eq!(
        tiny.parse("*(- - - - - 1)").unwrap_err().code,
        DiagnosticCode::NestingLimit
    );
    assert_eq!(
        tiny.parse("%[%[%[%[%[a]]]]]").unwrap_err().code,
        DiagnosticCode::NestingLimit
    );
    let hard = SyntaxEngine::typescript_compatible().with_limits(Limits {
        nesting: usize::MAX,
        ..Limits::default()
    });
    assert_eq!(hard.limits().nesting, HARD_NESTING_CEILING);
    let deep = format!(
        "{}x{}",
        "$(say ".repeat(HARD_NESTING_CEILING + 1),
        ")".repeat(HARD_NESTING_CEILING + 1)
    );
    assert_eq!(
        hard.parse(&deep).unwrap_err().code,
        DiagnosticCode::NestingLimit
    );
    assert_eq!(
        hard.scan_template(&deep).unwrap_err().code,
        DiagnosticCode::NestingLimit
    );
}

#[test]
fn compiled_plans_preserve_error_order_and_share_exact_source() {
    let engine = SyntaxEngine::default();
    let source = "before $(say %[%(x]) then $(say ok) tail $(say";
    let plan = engine.compile_template(source).unwrap();
    assert!(plan.matches_source(source));
    assert!(!plan.matches_source("changed"));
    assert!(plan.is_compatible_with(&engine, source));
    assert!(!plan.is_compatible_with(&SyntaxEngine::typescript_compatible(), source));
    assert!(!plan.is_compatible_with(
        &engine.clone().with_limits(Limits {
            tokens: 99,
            ..Limits::default()
        }),
        source
    ));
    assert_eq!(plan.segments().len(), 6);
    assert!(plan.segments()[1].program().unwrap().is_err());
    assert!(plan.segments()[3].program().unwrap().is_ok());
    assert_eq!(
        plan.segments()[5].diagnostic().unwrap().code,
        DiagnosticCode::UnclosedExpression
    );
    let stats = plan.stats();
    for _ in 0..5 {
        // Traversal consumes immutable stored programs, with no parse and no
        // output/context state to leak between future evaluator executions.
        assert_eq!(
            plan.segments()[3]
                .program()
                .unwrap()
                .as_ref()
                .unwrap()
                .source(),
            "$(say ok)"
        );
    }
    assert_eq!(plan.stats(), stats);
}

#[test]
fn grammar_aliases_and_grammar_identity_are_prepared_once() {
    let grammar = GrammarBuilder::default()
        .register("@(", ")", SyntaxHandler::Function)
        .build()
        .unwrap();
    let engine = SyntaxEngine::new(grammar, SyntaxProfile::Improved, Limits::default());
    assert_eq!(
        engine.parse("@(say hi)").unwrap().to_value()["children"][0]["name"],
        "say"
    );
    let plan = engine.compile_template("@(say hi)").unwrap();
    assert!(plan.is_compatible_with(&engine, "@(say hi)"));
    assert!(!plan.is_compatible_with(&SyntaxEngine::default(), "@(say hi)"));
    let other = GrammarBuilder::default()
        .register("@(", ")", SyntaxHandler::CommandRef)
        .build()
        .unwrap();
    let other = SyntaxEngine::new(other, SyntaxProfile::Improved, Limits::default());
    assert!(!plan.is_compatible_with(&other, "@(say hi)"));
    assert!(
        GrammarBuilder::default()
            .register("oops", ")", SyntaxHandler::Function)
            .build()
            .is_err()
    );
}

#[test]
fn grammar_reserves_array_prefix_while_accepting_other_percent_aliases() {
    for start in ["%[(", "%[alias(", "%[[(", "%[😀("] {
        let error = GrammarBuilder::default()
            .register(start, ")", SyntaxHandler::Function)
            .build()
            .unwrap_err();
        assert_eq!(error.code, DiagnosticCode::InvalidGrammar);
        assert_eq!(
            error.message,
            "Syntax introducers cannot start with reserved array prefix '%['"
        );
        assert_eq!(error.span, SourceSpan::default());
    }
    let grammar = GrammarBuilder::default()
        .register("%alias(", ")", SyntaxHandler::Function)
        .build()
        .unwrap();
    let defaults = PreparedGrammar::default();
    assert_eq!(&grammar.definitions()[..6], defaults.definitions());
    for profile in [SyntaxProfile::Improved, SyntaxProfile::TypeScriptCompatible] {
        let engine = SyntaxEngine::new(grammar.clone(), profile, Limits::default());
        assert_eq!(
            engine.parse("%alias(user)").unwrap().to_value(),
            parsed("$(user)")
        );
        assert_eq!(
            engine.parse("%(name)").unwrap().to_value(),
            parsed("%(name)")
        );
        let plan = engine.compile_template("%alias(user) tail").unwrap();
        assert_eq!(plan.segments().len(), 2);
        assert!(plan.segments()[0].program().unwrap().is_ok());
        assert_eq!(plan.segments()[1].source_segment().raw_text(), " tail");
    }
    let engine = SyntaxEngine::new(grammar, SyntaxProfile::Improved, Limits::default());
    assert_eq!(
        engine
            .parse("$(say %[%alias(user), two])")
            .unwrap()
            .to_value(),
        parsed("$(say %[$(user), two])")
    );
}

#[test]
fn prepared_byte_dispatch_preserves_order_longest_match_and_complete_identity() {
    let builder = GrammarBuilder::default()
        .register("@(", ")", SyntaxHandler::Function)
        .register("@((", ")", SyntaxHandler::Function)
        .register("é(", ")", SyntaxHandler::Function)
        .register("ê(", ")", SyntaxHandler::Function);
    let grammar = builder.clone().build().unwrap();
    for byte in 0..=u8::MAX {
        assert_eq!(
            grammar.candidate_byte(byte),
            grammar
                .definitions()
                .iter()
                .any(|d| d.start_token.as_bytes()[0] == byte)
        );
    }
    assert_eq!(grammar.match_start("@((user)", 0, false), Some(6));
    assert_eq!(grammar.match_start("@((user)", 0, true), Some(7));
    assert_eq!(grammar.match_start("é(user)", 0, true), Some(8));
    assert_eq!(grammar.match_start("ê(user)", 0, true), Some(9));
    assert_eq!(grammar.match_start("ë(user)", 0, true), None);
    assert_eq!(grammar.match_start("plain", 0, true), None);
    assert_eq!(grammar.match_start("", 0, true), None);
    let engine = SyntaxEngine::new(grammar, SyntaxProfile::Improved, Limits::default());
    let source = "😀 ë(plain) é(user) ê(user) tail 🦀";
    let segments = engine.scan_template(source).unwrap();
    assert_eq!(segments.len(), 5);
    assert_eq!(segments[0].raw_text(), "😀 ë(plain) ");
    assert_eq!(segments[1].raw_text(), "é(user)");
    assert_eq!(segments[3].raw_text(), "ê(user)");
    assert_eq!(segments[4].raw_text(), " tail 🦀");
    let plan = engine.compile_template("@(user)").unwrap();
    let same = SyntaxEngine::new(
        builder.clone().build().unwrap(),
        SyntaxProfile::Improved,
        Limits::default(),
    );
    assert!(plan.is_compatible_with(&same, "@(user)"));
    let replaced = builder
        .register("@(", ")", SyntaxHandler::CommandRef)
        .build()
        .unwrap();
    assert_eq!(replaced.definitions()[6].handler, SyntaxHandler::CommandRef);
    let replaced = SyntaxEngine::new(replaced, SyntaxProfile::Improved, Limits::default());
    assert!(!plan.is_compatible_with(&replaced, "@(user)"));
    let reordered = GrammarBuilder::default()
        .register("@((", ")", SyntaxHandler::Function)
        .register("@(", ")", SyntaxHandler::Function)
        .register("é(", ")", SyntaxHandler::Function)
        .register("ê(", ")", SyntaxHandler::Function)
        .build()
        .unwrap();
    assert_eq!(reordered.match_start("@((user)", 0, false), Some(6));
    let reordered = SyntaxEngine::new(reordered, SyntaxProfile::Improved, Limits::default());
    assert!(!plan.is_compatible_with(&reordered, "@(user)"));
}

#[test]
fn nested_array_work_is_counted_once_per_region_not_per_ancestor() {
    let source = format!("{}x{}", "%[".repeat(32), "]".repeat(32));
    let program = SyntaxEngine::default().parse(&source).unwrap();
    assert_eq!(program.stats().arrays, 32);
    assert_eq!(program.stats().tokens, 33);
    assert_eq!(program.stats().array_indexed_bytes, source.len());
    assert_eq!(program.stats().lexed_bytes, source.len());
}

#[test]
fn tokenizer_errors_keep_source_messages_and_priority() {
    let engine = SyntaxEngine::typescript_compatible();
    for (input, message) in [
        ("$(say", "Unclosed \"$(\""),
        ("]", "Unexpected closing \"]\""),
        ("%[x", "Unclosed array literal"),
        ("\"x", "Unclosed quoted string"),
        (") \"x", "Unclosed quoted string"),
    ] {
        assert_eq!(engine.parse(input).unwrap_err().message, message);
    }
}

#[test]
fn compiled_plan_work_counters_expose_scanner_and_lexer_passes() {
    let source = "$(say %[%[x]])";
    let plan = SyntaxEngine::default().compile_template(source).unwrap();
    // Two arrays in each of two real indexing passes, not four AST arrays.
    assert_eq!(plan.stats().arrays, 4);
    assert_eq!(plan.stats().array_indexed_bytes, "%[%[x]]".len() * 2);
    assert_eq!(plan.stats().lexed_bytes, source.len());
    let program = plan.segments()[0].program().unwrap().as_ref().unwrap();
    assert_eq!(program.stats().arrays, 2);
    assert_eq!(program.stats().array_indexed_bytes, "%[%[x]]".len());
}

fn assert_persisted_roundtrip(program: &CompiledProgram) {
    let json = serde_json::to_string(program.root()).unwrap();
    let restored: AstNode = serde_json::from_str(&json).unwrap();
    assert_eq!(&restored, program.root());
}

fn serialized_container_depth(node: &AstNode) -> usize {
    let json = serde_json::to_string(node).unwrap();
    let (mut quoted, mut escaped) = (false, false);
    let (mut depth, mut maximum) = (0, 0);
    for byte in json.bytes() {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
        } else if byte == b'"' {
            quoted = true;
        } else if byte == b'{' || byte == b'[' {
            depth += 1;
            maximum = maximum.max(depth);
        } else if byte == b'}' || byte == b']' {
            depth -= 1;
        }
    }
    maximum
}

#[test]
fn persisted_json_counts_field_arrays_templates_and_accessors() {
    for (source, depth) in [
        ("", 2),
        ("word", 3),
        ("$(user)", 4),
        ("$(say word)", 5),
        ("#(command word)", 5),
        ("*(1+2)", 4),
        ("*(-1)", 4),
        ("*(1?2:3)", 4),
        (r#""text""#, 5),
        (r#""${1}""#, 6),
        (r#""${%(name[1])}""#, 8),
        ("%(name)", 3),
        ("%(name[1])", 5),
        ("%(name[1] 2)", 5),
        ("^(##name(alice)[1])", 5),
        ("%del(##name(alice)[1])", 5),
        ("%[1]", 5),
        ("%[1][%(index)]", 5),
        ("#name", 3),
        ("#name++", 3),
        ("#name=1", 4),
        ("*(for #i in %[1] {$(say #i)})", 7),
        ("*(for #i=0; #i<2; #i++ {#i})", 5),
    ] {
        for engine in [
            SyntaxEngine::default(),
            SyntaxEngine::typescript_compatible(),
        ] {
            let program = engine.parse(source).unwrap();
            assert_eq!(
                persistence::json_container_depth(program.root()),
                depth,
                "{source}"
            );
            assert_eq!(
                serialized_container_depth(program.root()),
                depth,
                "{source}"
            );
            assert_persisted_roundtrip(&program);
        }
    }
    for node in [
        AstNode::Template {
            segments: Vec::new(),
        },
        AstNode::Custom {
            custom_type: "fixture".into(),
            data: json!({"nested":[{"empty":[]}]}),
        },
    ] {
        assert_eq!(
            persistence::json_container_depth(&node),
            serialized_container_depth(&node)
        );
    }
}

#[test]
fn persisted_json_obeys_the_exact_standard_reader_boundary() {
    const MAX_ALLOWED_CONTAINERS: usize = HARD_JSON_NESTING_CEILING - 1;
    assert_eq!(HARD_JSON_NESTING_CEILING, 128);
    assert_eq!(MAX_ALLOWED_CONTAINERS, 127);
    for engine in [
        SyntaxEngine::default(),
        SyntaxEngine::typescript_compatible(),
    ] {
        for count in [60, 62] {
            let source = format!("{}x{}", "%[".repeat(count), "]".repeat(count));
            let program = engine.parse(&source).unwrap();
            assert_eq!(
                persistence::json_container_depth(program.root()),
                count * 2 + 3
            );
            assert_persisted_roundtrip(&program);
            if count == 62 {
                assert_eq!(
                    serialized_container_depth(program.root()),
                    MAX_ALLOWED_CONTAINERS
                );
            }
        }
        for count in [63, 64] {
            let source = format!("{}x{}", "%[".repeat(count), "]".repeat(count));
            let error = engine.parse(&source).unwrap_err();
            assert_eq!(error.code, DiagnosticCode::NestingLimit);
            assert_eq!(
                error.message,
                "AST JSON serialization nesting limit exceeded"
            );
            assert_eq!(
                error.span,
                SourceSpan {
                    start: 0,
                    end: source.len()
                }
            );
        }
        let source = format!("{}{}", "$(say ".repeat(63), ")".repeat(63));
        assert_eq!(
            engine.parse(&source).unwrap_err().code,
            DiagnosticCode::NestingLimit
        );
        assert_eq!(
            engine.compile_template(&source).unwrap_err().code,
            DiagnosticCode::NestingLimit
        );
    }

    // Empty innermost args produce exactly 128 containers; adding no AST node
    // still consumes a JSON array wrapper in the standard reader's budget.
    let mut nested = AstNode::Function {
        name: "say".into(),
        args: Vec::new(),
    };
    for _ in 1..63 {
        nested = AstNode::Function {
            name: "say".into(),
            args: vec![nested],
        };
    }
    let root = AstNode::Root {
        children: vec![nested],
    };
    assert_eq!(
        persistence::json_container_depth(&root),
        HARD_JSON_NESTING_CEILING
    );
    assert_eq!(serialized_container_depth(&root), HARD_JSON_NESTING_CEILING);
    let json = serde_json::to_string(&root).unwrap();
    assert!(serde_json::from_str::<AstNode>(&json).is_err());
    assert_eq!(
        persistence::validate(&root, SourceSpan::default())
            .unwrap_err()
            .code,
        DiagnosticCode::NestingLimit
    );
}

#[test]
fn json_nesting_is_independent_of_configured_ast_depth_and_width() {
    for (source, nesting) in [("word", 2), ("%[x]", 3), (r#""${x}""#, 3)] {
        let engine = SyntaxEngine::default().with_limits(Limits {
            nesting,
            ..Limits::default()
        });
        let program = engine.parse(source).unwrap();
        assert!(persistence::json_container_depth(program.root()) > nesting);
        assert_persisted_roundtrip(&program);
    }
    for source in [
        "word ".repeat(512),
        format!("%[{}]", ["x"; 512].join(",")),
        format!("$(say {})", "word ".repeat(512)),
        format!("\"{}\"", "${x}".repeat(512)),
    ] {
        let program = SyntaxEngine::default().parse(&source).unwrap();
        assert!(persistence::json_container_depth(program.root()) <= 6);
        assert_persisted_roundtrip(&program);
    }
}

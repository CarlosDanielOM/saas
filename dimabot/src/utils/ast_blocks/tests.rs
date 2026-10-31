use super::*;
use crate::utils::ast_syntax::{
    AstNode, JsString, PersistedJsString, SyntaxEngine, TemplateSegment,
};
use serde_json::{Value, json};

fn lit(value: &str) -> Value {
    json!({"type":"literal","value":value})
}
fn function(name: &str, args: Vec<Value>) -> Value {
    json!({"type":"function","name":name,"args":args})
}
fn root(children: Vec<Value>) -> Value {
    json!({"type":"root","id":"root","children":children})
}
fn compile(children: Vec<Value>) -> String {
    compile_blocks_owned(root(children))
        .expect("valid blocks")
        .text
}
fn get(name: &str, storage: &str) -> Value {
    json!({"type":"getVar","name":name,"storage":storage})
}

#[test]
fn plain_chat_and_escaping_match_source() {
    assert_eq!(
        compile(vec![
            lit("Hello "),
            function("user", vec![]),
            lit("! :) welcome   back")
        ]),
        "Hello $(user)! :) welcome   back"
    );
    assert_eq!(
        compile(vec![lit("type $(user) to see")]),
        "type \\$(user) to see"
    );
    let imported = import_command_text("type \\$(user) to see").unwrap();
    assert!(
        matches!(&imported.root.children[0].kind,BlockKind::Literal {value} if value=="type $(user) to see")
    );
    assert_eq!(imported.advanced_count, 0);
}
#[test]
fn arguments_use_source_quoting_and_reserved_words() {
    assert_eq!(
        compile(vec![function(
            "say",
            vec![lit("hello there"), lit("-5"), lit("ok")]
        )]),
        "$(say \"hello there\" \"-5\" ok)"
    );
    assert_eq!(
        compile(vec![function("say", vec![lit("don't panic")])]),
        "$(say \"don't panic\")"
    );
    assert_eq!(
        compile(vec![function(
            "say",
            vec![lit("for"), lit("IN"), lit("random")]
        )]),
        "$(say \"for\" \"IN\" \"random\")"
    );
}
#[test]
fn death_counter_matches_source() {
    let set = json!({"type":"setVar","name":"deaths","storage":"db","value":{"type":"binary","operator":"+","left":get("deaths","db"),"right":lit("1")}});
    assert_eq!(
        compile(vec![set, lit("Deaths: "), get("deaths", "db")]),
        "%(*deaths *(%(*deaths) + 1))Deaths: %(*deaths)"
    );
}
#[test]
fn ternary_group_becomes_template() {
    let tree = json!({"type":"ternary","test":{"type":"binary","operator":"==","left":function("user",vec![]),"right":lit("cdom201")},"consequent":lit("Welcome back, boss"),"alternate":{"type":"group","children":[lit("Hi "),function("user",vec![])]}});
    assert_eq!(
        compile(vec![tree]),
        "*(($(user) == cdom201) ? \"Welcome back, boss\" : \"Hi ${$(user)}\")"
    );
}
#[test]
fn variables_accessors_and_arrays_match_source() {
    assert_eq!(
        compile(vec![
            json!({"type":"getVar","name":"points","storage":"dbUser","userSelector":function("touser",vec![])})
        ]),
        "%(**points($(touser)))"
    );
    assert_eq!(
        compile(vec![
            json!({"type":"setVar","name":"list","storage":"memory","accessor":{"type":"append"},"value":{"type":"arrayLiteral","items":[lit("one"),lit("two words")]}})
        ]),
        "%(list[] %[one, \"two words\"])"
    );
    assert_eq!(
        compile(vec![
            json!({"type":"getVar","name":"list","storage":"memory","accessor":{"type":"index","index":lit("0")}})
        ]),
        "%(list[0])"
    );
    assert_eq!(
        compile(vec![
            json!({"type":"getVar","name":"list","storage":"cache","accessor":{"type":"random"}})
        ]),
        "%(#list[random])"
    );
    assert_eq!(
        compile(vec![
            json!({"type":"deleteVar","name":"list","storage":"db","accessor":{"type":"clear"}})
        ]),
        "%del(*list[])"
    );
    for storage in ["memory", "cache", "cacheUser", "db", "dbUser"] {
        let compiled = compile_blocks_owned(root(vec![get("n", storage)])).unwrap();
        assert_eq!(stored_blocks(compiled.root).v, 1);
    }
}
#[test]
fn loop_source_is_unchanged() {
    let tree = json!({"type":"forLoop","loopVar":"i","mode":"range","init":{"type":"loopAssign","name":"i","operator":"=","value":lit("0")},"condition":{"type":"binary","operator":"<","left":{"type":"loopVar","name":"i"},"right":lit("3")},"update":{"type":"loopAssign","name":"i","operator":"++"},"body":[function("say",vec![lit("ping"),json!({"type":"loopVar","name":"i"})]) ]});
    assert_eq!(
        compile(vec![tree]),
        "*(for #i = 0; #i < 3; #i++ { $(say ping #i) })"
    );
}
#[test]
fn source_import_corpus_saves() {
    for source in [
        "$(user) hugs $(touser) <3",
        "*($(random 6) == 0 ? \"BANG! ${$(user)} is out\" : \"click... survives\")",
        "%(*deaths *(%(*deaths) + 1))Deaths so far: %(*deaths)",
        "Thanks for the raid $(raid.channel)! #(so $(raid.channel))",
        "*(for #i = 0; #i < 3; #i++ { $(say ping #i) })",
        "*(for #x in %(list[]) { $(say #x) })",
        "^(*seen) &t %del(##tmp(&p1)) *(-1 + 2)",
    ] {
        let imported = import_command_text(source).unwrap();
        assert_eq!(imported.advanced_count, 0, "{source}");
        assert!(
            imported.diagnostics.is_empty(),
            "{source}: {:?}",
            imported.diagnostics
        );
        let saved = compile_blocks_owned(imported.root.to_value()).unwrap();
        assert_eq!(
            import_command_text(&saved.text)
                .unwrap()
                .root
                .children
                .len(),
            imported.root.children.len(),
            "{source}"
        );
    }
}
#[test]
fn raw_and_unclosed_source_are_byte_exact() {
    for source in [
        "hi %(pen $(randomuser) extra) bye",
        "$(say %[%(]) ) tail",
        "$(say %[%(])",
        "hello $(never closes",
    ] {
        let imported = import_command_text(source).unwrap();
        assert!(imported.advanced_count > 0, "{source}");
        assert_eq!(
            compile_blocks_owned(imported.root.to_value()).unwrap().text,
            source
        );
    }
    let error = compile_blocks_owned(root(vec![
        json!({"type":"raw","id":"r2","source":"just text"}),
    ]))
    .unwrap_err();
    assert_eq!(error.code, BlocksErrorCode::InvalidRaw);
    assert_eq!(error.block_id.as_deref(), Some("r2"));
    assert_eq!(error.path, "/children/0/source");
}
#[test]
fn validation_error_order_and_precise_paths() {
    let error = compile_blocks_owned(root(vec![
        json!({"id":"empty-if","type":"binary","operator":"==","left":null,"right":lit("x")}),
    ]))
    .unwrap_err();
    assert_eq!(error.message, "Fill in the left side.");
    assert_eq!(error.block_id.as_deref(), Some("empty-if"));
    assert_eq!(error.path, "/children/0/left");
    let error = compile_blocks_owned(root(vec![function(
        "say",
        vec![json!({"id":"r1","type":"raw","source":"$(x)"})],
    )]))
    .unwrap_err();
    assert_eq!(error.code, BlocksErrorCode::RawNotTopLevel);
    assert_eq!(error.block_id.as_deref(), Some("r1"));
    assert_eq!(error.path, "/children/0/args/0");
    let error = read_block_root_owned(root(vec![
        json!({"type":"setVar","storage":"wrong","name":"bad name","value":null}),
    ]))
    .unwrap_err();
    assert_eq!(error.code, BlocksErrorCode::InvalidStorage);
    assert_eq!(
        compile_blocks_owned(root(vec![])).unwrap_err().code,
        BlocksErrorCode::EmptyRoot
    );
    assert_eq!(
        read_block_root_owned(json!({"type":"root"}))
            .unwrap_err()
            .code,
        BlocksErrorCode::BrokenRoot
    );
    assert_eq!(
        compile_blocks_owned(root(vec![get("bad name", "memory")]))
            .unwrap_err()
            .code,
        BlocksErrorCode::InvalidName
    );
}
#[test]
fn ids_repair_in_root_first_source_order_and_drop_unknown_fields() {
    let input = json!({"type":"root","id":"s1","unknown":"drop","children":[{"type":"literal","id":"same","value":"a ","unknown":true},{"type":"function","id":"same","name":"user","args":[]},{"type":"literal","id":"s2","value":"x"}]});
    let tree = read_block_root_owned(input).unwrap();
    assert_eq!(tree.id, "s1");
    assert_eq!(tree.children[0].id, "same");
    assert_eq!(tree.children[1].id, "s2");
    assert_eq!(tree.children[2].id, "s3");
    assert!(tree.to_value().get("unknown").is_none());
    assert!(tree.children[0].to_value().get("unknown").is_none());
    let mut factory = || "same".to_owned();
    let imported = BlocksEngine::default()
        .import_command_text_with_id_factory("$(user) $(user)", &mut factory)
        .unwrap();
    let ids: Vec<_> = imported
        .root
        .children
        .iter()
        .map(|n| n.id.as_str())
        .chain(std::iter::once(imported.root.id.as_str()))
        .collect();
    let unique: std::collections::HashSet<_> = ids.iter().collect();
    assert_eq!(ids.len(), unique.len());
    let engine = BlocksEngine::default();
    let a = engine
        .import_command_text_with_namespace("$(user)", "fixture_")
        .unwrap();
    let b = engine
        .import_command_text_with_namespace("$(user)", "fixture_")
        .unwrap();
    assert_eq!(a.root.to_value(), b.root.to_value());
    assert_eq!(
        engine
            .import_command_text_with_namespace("x", "bad namespace")
            .unwrap_err()
            .code,
        BlocksErrorCode::InvalidNamespace
    );
}
#[test]
fn javascript_unicode_categories_utf16_and_dollar_anchor() {
    assert!(read_block_root_owned(root(vec![get("Å四Ⅻ²𐐀", "memory")])).is_ok());
    for name in [
        "x\u{0301}",
        "x\u{200c}",
        "x\n",
        "x\r",
        "x\r\n",
        "x\u{2028}",
        "x\u{2029}",
    ] {
        assert_eq!(
            read_block_root_owned(root(vec![get(name, "memory")]))
                .unwrap_err()
                .code,
            BlocksErrorCode::InvalidName,
            "{name:?}"
        );
    }
    assert!(read_block_root_owned(root(vec![get(&"𐐀".repeat(32), "memory")])).is_ok());
    assert_eq!(
        read_block_root_owned(root(vec![get(&"𐐀".repeat(33), "memory")]))
            .unwrap_err()
            .code,
        BlocksErrorCode::StringLimit
    );
    for suffix in ["\n", "\r", "\r\n", "\u{2028}", "\u{2029}"] {
        let name = format!("ok{suffix}");
        assert_eq!(
            read_block_root_owned(root(vec![function(&name, vec![])]))
                .unwrap_err()
                .code,
            BlocksErrorCode::InvalidName
        );
        let tree =
            read_block_root_owned(root(vec![json!({"id":name,"type":"literal","value":"x"})]))
                .unwrap();
        assert_eq!(tree.children[0].id, "s1");
    }
    assert!(
        read_block_root_owned(root(vec![
            json!({"type":"commandRef","commandName":"x\u{0085}","args":[]})
        ]))
        .is_ok()
    );
    assert_eq!(
        compile(vec![lit(&"😀".repeat(5000))])
            .encode_utf16()
            .count(),
        10_000
    );
    assert_eq!(
        import_command_text(&"😀".repeat(5001)).unwrap_err().code,
        BlocksErrorCode::TextLimit
    );
}
#[test]
fn node_quota_counts_pre_normalization_and_synthesized_children() {
    let mut children = vec![lit(""); MAX_BLOCK_NODES];
    children[0] = lit("x");
    let saved = compile_blocks_owned(root(children)).unwrap();
    assert_eq!(saved.text, "x");
    assert_eq!(saved.stats.validated_nodes, 7500);
    let error = read_block_root_owned(root(vec![lit(""); MAX_BLOCK_NODES + 1])).unwrap_err();
    assert_eq!(error.code, BlocksErrorCode::NodeLimit);
    assert_eq!(error.path, "/children/7500");
    let mut children = vec![lit(""); MAX_BLOCK_NODES - 4];
    children.push(json!({"type":"ternary","test":lit("1")}));
    assert!(read_block_root_owned(root(children)).is_ok());
    let mut children = vec![lit(""); MAX_BLOCK_NODES - 3];
    children.push(json!({"type":"ternary","test":lit("1")}));
    let error = read_block_root_owned(root(children)).unwrap_err();
    assert_eq!(error.code, BlocksErrorCode::NodeLimit);
    assert!(error.path.ends_with("/alternate"));
    // Accessor wrapper is not a node, and neither is the root.
    let mut children = vec![lit(""); MAX_BLOCK_NODES - 2];
    children.push(json!({"type":"getVar","storage":"memory","name":"x","accessor":{"type":"index","index":lit("0")}}));
    assert!(read_block_root_owned(root(children)).is_ok());
}
#[test]
fn imported_invalid_names_depth_and_expansion_fall_back_safely() {
    let nested = format!("{}x{}", "$(s ".repeat(48), ")".repeat(48));
    for source in [nested, "$(123)".to_owned()] {
        let imported = import_command_text(&source).unwrap();
        assert!(imported.advanced_count > 0, "{source}");
        assert!(
            imported.diagnostics.is_empty(),
            "{:?}",
            imported.diagnostics
        );
        assert_eq!(
            compile_blocks_owned(imported.root.to_value()).unwrap().text,
            source
        );
    }
    let source = "*(1?2:3)".repeat(1100);
    let imported = import_command_text(&source).unwrap();
    assert!(imported.advanced_count > 0);
    let raw_count = imported
        .root
        .children
        .iter()
        .filter(|node| matches!(&node.kind, BlockKind::Raw { .. }))
        .count();
    assert_eq!(raw_count, imported.advanced_count);
    assert!(imported.diagnostics.is_empty());
    assert!(imported.stats.validated_nodes > 4000);
    let saved = compile_blocks_owned(imported.root.to_value()).unwrap();
    assert!(saved.text.encode_utf16().count() <= MAX_COMMAND_TEXT);
}
#[test]
fn bounded_writer_counts_full_rejected_output_without_retaining_it() {
    let input = root(
        (0..50)
            .map(|_| function("say", vec![lit(&"\"".repeat(1000))]))
            .collect(),
    );
    let tree = normalize_root(read_block_root_owned(input.clone()).unwrap());
    let mut w = Writer::new(rules());
    w.root(&tree).unwrap();
    assert_eq!(w.units, 100450);
    assert!(w.retained <= MAX_COMMAND_TEXT);
    let mut stats = BlocksStats::default();
    let error = w.finish(&mut stats).unwrap_err();
    assert_eq!(stats.output_units, 100450);
    assert!(stats.retained_output_units <= 10_000);
    assert_eq!(error.code, BlocksErrorCode::OutputLimit);
    assert_eq!(
        error.message,
        "This command is too long (100450 of 10000 characters)."
    );
    assert!(error.path.contains("/args/0/value"));
    assert_eq!(
        compile_blocks_owned(input).unwrap_err().message,
        error.message
    );
}
#[test]
fn literal_interpolation_and_merged_provenance_point_at_actual_value() {
    for arg in [
        json!({"id":"actual","type":"literal","value":"${1}"}),
        json!({"id":"container","type":"template","parts":[{"id":"first","type":"literal","value":"a"},{"id":"actual","type":"literal","value":"${1}"}]}),
    ] {
        let error = compile_blocks_owned(root(vec![function("say", vec![arg])])).unwrap_err();
        assert_eq!(error.code, BlocksErrorCode::RoundTripMismatch);
        assert_eq!(error.block_id.as_deref(), Some("actual"));
        assert!(error.path.ends_with("/value"));
        if error.path.contains("/parts/") {
            assert_eq!(error.path, "/children/0/args/0/parts/1/value");
        }
    }
    let input = root(vec![
        json!({"id":"first","type":"literal","value":"a"}),
        json!({"id":"actual","type":"literal","value":"price \\$5"}),
    ]);
    let error = compile_blocks_owned(input).unwrap_err();
    assert_eq!(error.code, BlocksErrorCode::LiteralEscape);
    assert_eq!(error.block_id.as_deref(), Some("actual"));
    assert_eq!(error.path, "/children/1/value");
    let tree=normalize_root(read_block_root_owned(root(vec![function("say",vec![json!({"id":"container","type":"template","parts":[{"id":"actual","type":"literal","value":"${1}"}]})])])).unwrap());
    assert_eq!(tree.to_value()["children"][0]["args"][0]["id"], "container");
    assert!(tree.to_value().to_string().find("text_pieces").is_none());
}
#[test]
fn exact_source_reuse_has_no_verification_trees_or_comparisons() {
    let source = "$(user)$(touser)".repeat(250);
    let imported = import_command_text(&source).unwrap();
    assert_eq!(imported.advanced_count, 0);
    assert_eq!(imported.stats.parse_calls, 2);
    assert_eq!(imported.stats.cache_hits, 998);
    assert_eq!(imported.stats.structural_comparisons, 0);
    assert_eq!(imported.stats.validated_nodes, 500);
    assert!(imported.stats.syntax_nodes_charged >= 1000);
    assert_eq!(imported.root.children.len(), 500);
    let ids: std::collections::HashSet<_> = imported.root.children.iter().map(|n| &n.id).collect();
    assert_eq!(ids.len(), 500);
}
#[test]
fn changed_canonical_source_reparses_and_checks_structure() {
    let imported = import_command_text("$(say \"hello\")").unwrap();
    assert_eq!(imported.stats.parse_calls, 2);
    assert_eq!(imported.stats.structural_comparisons, 1);
    assert_eq!(
        compile_blocks_owned(imported.root.to_value()).unwrap().text,
        "$(say hello)"
    );
    let source = "$(say \"hello\")".repeat(500);
    let imported = import_command_text(&source).unwrap();
    assert_eq!(imported.stats.parse_calls, 2);
    assert_eq!(imported.stats.structural_comparisons, 500);
    assert_eq!(imported.stats.cache_hits, 998);
}
#[test]
fn operation_cache_is_private_and_hits_charge_aggregate_limits() {
    let engine = BlocksEngine::default();
    let mut op = Operation::new(&engine.syntax);
    assert!(op.program("$(user)").unwrap().is_some());
    let before = op.stats.syntax_nodes_charged;
    assert!(op.program("$(user)").unwrap().is_some());
    assert_eq!(op.stats.syntax_nodes_charged, 2 * before);
    assert_eq!(op.stats.parse_calls, 1);
    assert_eq!(op.stats.cache_hits, 1);
    op.stats.syntax_nodes_charged = WORK_NODES;
    assert_eq!(
        op.program("$(user)").unwrap_err().code,
        BlocksErrorCode::SyntaxLimit
    );
    let a = import_command_text("$(user)").unwrap();
    let b = import_command_text("$(user)").unwrap();
    assert_eq!(a.stats.parse_calls, 1);
    assert_eq!(b.stats.parse_calls, 1);
}
#[test]
fn owned_reader_moves_strings_and_structural_comparison_ignores_ids() {
    let text = "owned value".to_owned();
    let ptr = text.as_ptr();
    let tree =
        read_block_root_owned(root(vec![json!({"type":"literal","value":"placeholder"})])).unwrap();
    drop(tree);
    let input = Value::Object(serde_json::Map::from_iter([
        ("type".into(), Value::String("root".into())),
        (
            "children".into(),
            Value::Array(vec![Value::Object(serde_json::Map::from_iter([
                ("type".into(), Value::String("literal".into())),
                ("value".into(), Value::String(text)),
            ]))]),
        ),
    ]));
    let tree = read_block_root_owned(input).unwrap();
    let BlockKind::Literal { value } = &tree.children[0].kind else {
        panic!("literal")
    };
    assert_eq!(value.as_ptr(), ptr);
    let a = BlockNode::new("a", BlockKind::Literal { value: "x".into() });
    let b = BlockNode::new("b", BlockKind::Literal { value: "x".into() });
    assert!(structural_eq(&a, &b));
    assert_eq!(
        BlocksEngine::default().profile(),
        SyntaxProfile::TypeScriptCompatible
    );
}
#[test]
fn unavoidable_text_quirks_report_diagnostics() {
    let imported = import_command_text("price \\$5").unwrap();
    assert_eq!(imported.diagnostics.len(), 0); // source unescape is representable as price $5
    let imported = import_command_text("price \\\\$5").unwrap();
    assert_eq!(imported.diagnostics[0].code, BlocksErrorCode::LiteralEscape);
    let imported = import_command_text("").unwrap();
    assert_eq!(imported.diagnostics[0].code, BlocksErrorCode::EmptyRoot);
}

#[test]
fn root_context_import_falls_back_only_the_affected_expression() {
    let source = format!("*(\"{}\")", "$(x)".repeat(2400));
    let imported = import_command_text(&source).unwrap();
    assert_eq!(imported.advanced_count, 1);
    assert!(imported.diagnostics.is_empty());
    assert!(
        matches!(&imported.root.children[0].kind, BlockKind::Raw { source: raw } if raw == &source)
    );
    assert_eq!(
        compile_blocks_owned(imported.root.to_value()).unwrap().text,
        source
    );

    let source = r#"*("\\")$(user)"#;
    let imported = import_command_text(source).unwrap();
    assert_eq!(imported.advanced_count, 1);
    assert!(imported.diagnostics.is_empty());
    assert!(
        matches!(&imported.root.children[0].kind, BlockKind::Raw { source } if source == r#"*("\\")"#)
    );
    assert!(
        matches!(&imported.root.children[1].kind, BlockKind::Function { name, .. } if name == "user")
    );
    assert_eq!(
        compile_blocks_owned(imported.root.to_value()).unwrap().text,
        source
    );

    let imported = import_command_text(r#"*(hello)*("\\")$(user)"#).unwrap();
    assert_eq!(imported.advanced_count, 1);
    assert!(
        matches!(&imported.root.children[0].kind, BlockKind::Literal { value } if value == "hello")
    );
    assert!(imported.diagnostics.is_empty());
    assert!(compile_blocks_owned(imported.root.to_value()).is_ok());
}

#[test]
fn root_boundary_summaries_keep_safe_literal_runs_editable() {
    let imported = import_command_text(r#"*("\\")*("\\")$(user)"#).unwrap();
    assert_eq!(imported.advanced_count, 0);
    assert!(imported.diagnostics.is_empty());
    assert!(compile_blocks_owned(imported.root.to_value()).is_ok());

    // Even slash pieces should stay editable when the earlier odd contributor
    // is repaired. No repeated scanning/cloning of the growing prefix is needed.
    let source = format!(r#"*("\\"){}$(user)"#, r#"*("\\\\")"#.repeat(100));
    let imported = import_command_text(&source).unwrap();
    assert_eq!(imported.advanced_count, 1);
    assert!(imported.diagnostics.is_empty());
    assert!(compile_blocks_owned(imported.root.to_value()).is_ok());

    // A literal start token split across source expressions must be escaped
    // exactly as it will be after adjacent literal normalization.
    let imported = import_command_text(r#"*("$")*("(x)")"#).unwrap();
    assert_eq!(imported.advanced_count, 0);
    assert!(imported.diagnostics.is_empty());
    assert_eq!(
        compile_blocks_owned(imported.root.to_value()).unwrap().text,
        r"\$(x)"
    );
}

#[test]
fn transient_quoted_template_does_not_use_a_block_depth_level() {
    let mut leaf = lit("two words");
    for _ in 0..47 {
        leaf = function("s", vec![leaf]);
    }
    let saved = compile_blocks_owned(root(vec![leaf])).unwrap();
    assert_eq!(saved.text.encode_utf16().count(), 246);
    let imported = import_command_text(&saved.text).unwrap();
    assert_eq!(imported.advanced_count, 0);
    assert!(imported.diagnostics.is_empty());
    assert_eq!(
        compile_blocks_owned(imported.root.to_value()).unwrap().text,
        saved.text
    );

    let mut leaf = lit("two words");
    for _ in 0..48 {
        leaf = function("s", vec![leaf]);
    }
    assert_eq!(
        compile_blocks_owned(root(vec![leaf])).unwrap_err().code,
        BlocksErrorCode::DepthLimit
    );
}

#[test]
fn output_limit_uses_the_actual_merged_literal_piece_and_utf16_offset() {
    for (first, actual) in [
        ("a".repeat(5000), "b".repeat(5001)),
        ("😀".repeat(2500), "b".repeat(5001)),
        ("a".repeat(9999), "😀".to_owned()),
    ] {
        let error = compile_blocks_owned(root(vec![
            json!({"type":"literal","id":"first","value":first}),
            json!({"type":"literal","id":"actual","value":actual}),
        ]))
        .unwrap_err();
        assert_eq!(error.code, BlocksErrorCode::OutputLimit);
        assert_eq!(error.block_id.as_deref(), Some("actual"));
        assert_eq!(error.path, "/children/1/value");
        assert_eq!(
            error.message,
            "This command is too long (10001 of 10000 characters)."
        );
    }
    let argument = json!({"type":"template","id":"container","parts":[
        {"type":"literal","id":"first","value":"a".repeat(5000)},
        {"type":"literal","id":"actual","value":"b".repeat(5001)},
    ]});
    let error = compile_blocks_owned(root(vec![function("say", vec![argument])])).unwrap_err();
    assert_eq!(error.block_id.as_deref(), Some("actual"));
    assert_eq!(error.path, "/children/0/args/0/parts/1/value");
}

fn lossless_literal(units: &[u16]) -> Value {
    json!({"type":"literalUtf16","value":units})
}

#[test]
fn version1_json_and_utf8_entrypoints_stay_unchanged() {
    let tree = read_block_root_owned(root(vec![
        json!({"id":"greet","type":"literal","value":"Hello "}),
        function("user", vec![]),
    ]))
    .unwrap();
    let stored = stored_blocks(tree);
    assert_eq!(stored.v, BLOCKS_VERSION);
    assert_eq!(stored.v, 1);
    let value = serde_json::to_value(&stored).unwrap();
    assert_eq!(value["v"], 1);
    assert_eq!(value["root"]["type"], "root");
    assert_eq!(value["root"]["children"][0]["type"], "literal");
    assert!(!serde_json::to_string(&value).unwrap().contains("literalUtf16"));
    let restored: StoredBlocks = serde_json::from_value(value).unwrap();
    assert_eq!(restored.v, 1);
    assert_eq!(
        compile_blocks_owned(restored.root.to_value()).unwrap().text,
        "Hello $(user)"
    );
    assert_eq!(
        root_to_source(&restored.root).unwrap(),
        "Hello $(user)"
    );

    let ast = AstNode::Literal {
        value: "plain".into(),
    };
    let mut ids = id_maker();
    let block = ast_to_block(&ast, &mut ids).unwrap();
    assert!(matches!(&block.kind, BlockKind::Literal { value } if value == "plain"));
    assert_eq!(block_to_ast(&block).unwrap(), ast);
}

#[test]
fn lossless_literal_roundtrips_units_through_storage_source_and_ast() {
    for units in [
        vec![0x41, 0xd800, 0x42],
        vec![0x41, 0xdc00, 0x42],
        vec![0xd800, 0xdc00, 0xd800],
        vec![0xdc00, 0xd800],
    ] {
        let input = root(vec![lossless_literal(&units)]);
        let tree = read_block_root_owned(input.clone()).unwrap();
        let BlockKind::LiteralUtf16 { value } = &tree.children[0].kind else {
            panic!("lossless literal")
        };
        assert_eq!(value.0.units(), units.as_slice());
        assert!(value.0.to_utf8().is_err());

        let stored = stored_blocks_lossless(tree);
        assert_eq!(stored.v, BLOCKS_LOSSLESS_VERSION);
        let json = serde_json::to_value(&stored).unwrap();
        assert_eq!(json["v"], 2);
        assert_eq!(json["root"]["children"][0]["type"], "literalUtf16");
        assert_eq!(json["root"]["children"][0]["value"], json!(&units));

        let restored: StoredBlocks = serde_json::from_value(json).unwrap();
        let read = read_block_root_owned(restored.root.to_value()).unwrap();
        assert_eq!(
            root_to_source_utf16(&read).unwrap().units(),
            units.as_slice()
        );
        let ast = block_root_to_ast(&read).unwrap();
        let AstNode::Root { children } = ast else {
            panic!("root")
        };
        let AstNode::LiteralUtf16 { value } = &children[0] else {
            panic!("literalUtf16")
        };
        assert_eq!(value.0.units(), units.as_slice());

        let error = compile_blocks_owned(input).unwrap_err();
        assert_eq!(error.code, BlocksErrorCode::UnpairedSurrogate);
        assert_eq!(error.path, "/children/0/value");
        assert_eq!(
            root_to_source(&read).unwrap_err().code,
            BlocksErrorCode::UnpairedSurrogate
        );
        assert_eq!(
            top_level(&read.children[0]).unwrap_err().code,
            BlocksErrorCode::UnpairedSurrogate
        );
    }
}

#[test]
fn lossless_template_text_reverses_to_the_same_ast() {
    for lone in [0xd800, 0xdc00] {
        let function = AstNode::Function {
            name: "say".into(),
            args: vec![AstNode::Template {
                segments: vec![
                    TemplateSegment::Text {
                        value: "Hi ".into(),
                    },
                    TemplateSegment::TextUtf16 {
                        value: PersistedJsString(JsString::from_units(vec![
                            0x41, lone, 0x42,
                        ])),
                    },
                ],
            }],
        };
        let mut ids = id_maker();
        let block = ast_to_block(&function, &mut ids).unwrap();
        let BlockKind::Function { args, .. } = &block.kind else {
            panic!("function")
        };
        let BlockKind::Template { parts } = &args[0].kind else {
            panic!("template")
        };
        assert!(matches!(&parts[0].kind, BlockKind::Literal { .. }));
        assert!(matches!(&parts[1].kind, BlockKind::LiteralUtf16 { .. }));

        let tree = normalize_root(BlockRoot {
            id: "root".into(),
            kind: RootTag::Root,
            children: vec![block],
        });
        let stored = stored_blocks_lossless(tree);
        let restored: StoredBlocks =
            serde_json::from_value(serde_json::to_value(&stored).unwrap()).unwrap();
        let read = read_block_root_owned(restored.root.to_value()).unwrap();
        let source = root_to_source_utf16(&read).unwrap();
        let mut expected: Vec<u16> = "$(say \"Hi ".encode_utf16().collect();
        expected.extend([0x41, lone, 0x42]);
        expected.extend("\")".encode_utf16());
        assert_eq!(source.units(), expected.as_slice());
        assert_eq!(
            block_root_to_ast(&read).unwrap(),
            AstNode::Root {
                children: vec![function]
            }
        );
    }
}

#[test]
fn utf8_representable_units_keep_the_version1_block_and_ast_forms() {
    let ast = AstNode::LiteralUtf16 {
        value: PersistedJsString(JsString::from_units(vec![
            0x41, 0xd83d, 0xde00,
        ])),
    };
    let mut ids = id_maker();
    let block = ast_to_block(&ast, &mut ids).unwrap();
    assert!(matches!(&block.kind, BlockKind::Literal { value } if value == "A😀"));
    assert_eq!(
        block_to_ast(&block).unwrap(),
        AstNode::Literal {
            value: "A😀".into()
        }
    );
    let read = read_block_root_owned(root(vec![lossless_literal(&[0x41, 0x42])])).unwrap();
    assert!(matches!(&read.children[0].kind, BlockKind::Literal { value } if value == "AB"));
}

#[test]
fn lossless_reader_enforces_exact_units_and_existing_limits() {
    for value in [
        json!([65, -1]),
        json!([70000]),
        json!(["A"]),
        json!("AB"),
        Value::Null,
    ] {
        let error = read_block_root_owned(root(vec![json!({
            "id":"lossless",
            "type":"literalUtf16",
            "value":value,
        })]))
        .unwrap_err();
        assert_eq!(error.code, BlocksErrorCode::InvalidUtf16);
        assert_eq!(error.block_id.as_deref(), Some("lossless"));
        assert_eq!(error.path, "/children/0/value");
    }
    let max = read_block_root_owned(root(vec![lossless_literal(&vec![
        0xd800u16;
        MAX_COMMAND_TEXT
    ])]))
    .unwrap();
    assert!(matches!(&max.children[0].kind, BlockKind::LiteralUtf16 { .. }));
    let error = read_block_root_owned(root(vec![lossless_literal(&vec![
        0xd800u16;
        MAX_COMMAND_TEXT + 1
    ])]))
    .unwrap_err();
    assert_eq!(error.code, BlocksErrorCode::StringLimit);
    assert_eq!(error.path, "/children/0/value");
}

#[test]
fn source_rejected_identifiers_stay_explicitly_unrepresentable() {
    let imported = import_command_text("$(1bad)").unwrap();
    assert_eq!(imported.advanced_count, 1);
    assert!(
        matches!(&imported.root.children[0].kind, BlockKind::Raw { source } if source == "$(1bad)")
    );
    assert_eq!(
        compile_blocks_owned(imported.root.to_value()).unwrap().text,
        "$(1bad)"
    );

    let error = read_block_root_owned(root(vec![
        json!({"id":"bad-function","type":"function","name":"1bad","args":[]}),
    ]))
    .unwrap_err();
    assert_eq!(error.code, BlocksErrorCode::InvalidName);
    assert_eq!(error.block_id.as_deref(), Some("bad-function"));
    assert_eq!(error.path, "/children/0/name");

    // The source grammar does not invent a typed name for this call; the
    // block importer therefore keeps the original source as an advanced piece
    // instead of claiming a structured function round trip.
    let program = SyntaxEngine::default().parse("$(1bad)").unwrap();
    let AstNode::Root { children } = program.root() else {
        panic!("root")
    };
    assert!(matches!(&children[0], AstNode::Function { name, .. } if name.is_empty()));

    let imported = import_command_text("%(1bad)").unwrap();
    assert_eq!(imported.advanced_count, 1);
    assert!(
        matches!(&imported.root.children[0].kind, BlockKind::Raw { source } if source == "%(1bad)")
    );
    let error = read_block_root_owned(root(vec![get("1bad", "memory")])).unwrap_err();
    assert_eq!(error.code, BlocksErrorCode::InvalidName);
    assert_eq!(error.path, "/children/0/name");

    let raw = BlockNode::new(
        "raw",
        BlockKind::Raw {
            source: "$(user)".into(),
        },
    );
    assert_eq!(
        block_to_ast(&raw).unwrap_err().to_string(),
        "advanced source pieces have no AST form"
    );
}

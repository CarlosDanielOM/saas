//! The reference's own tests for these files, ported: `ast_blocks/ast_blocks.test.ts` (all 12)
//! and the parse-only assertions of `ast_parser/{syntax_errors,parens,arrays,ternary,loop}.test.ts`
//! (their evaluation halves belong to the evaluator package). Names follow the originals.

// Test helpers outside `#[test]` functions: a failed expectation is a failed test.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use dima_engine::blocks::{
    BlockKind, BlocksError, IdMaker, MAX_COMMAND_TEXT, compile_blocks, import_command_text,
};
use dima_engine::syntax::{AstNode, SegmentStep, SyntaxEngine};
use serde_json::{Value, json};
use std::cell::Cell;

thread_local!(static SEQ: Cell<u32> = const { Cell::new(0) });

fn id() -> String {
    SEQ.with(|seq| {
        seq.set(seq.get() + 1);
        format!("t{}", seq.get())
    })
}
fn lit(value: &str) -> Value {
    json!({"id": id(), "type": "literal", "value": value})
}
fn func(name: &str, args: Vec<Value>) -> Value {
    json!({"id": id(), "type": "function", "name": name, "args": args})
}
fn get_var(name: &str, storage: &str, extra: Value) -> Value {
    let mut node = json!({"id": id(), "type": "getVar", "name": name, "storage": storage});
    merge(&mut node, extra);
    node
}
fn set_var(name: &str, value: Value, storage: &str, extra: Value) -> Value {
    let mut node =
        json!({"id": id(), "type": "setVar", "name": name, "storage": storage, "value": value});
    merge(&mut node, extra);
    node
}
fn binary(left: Value, operator: &str, right: Value) -> Value {
    json!({"id": id(), "type": "binary", "operator": operator, "left": left, "right": right})
}
fn root(children: Vec<Value>) -> Value {
    json!({"id": id(), "type": "root", "children": children})
}
fn merge(node: &mut Value, extra: Value) {
    if let (Some(node), Value::Object(extra)) = (node.as_object_mut(), extra) {
        node.extend(extra);
    }
}
fn compile(children: Vec<Value>) -> String {
    compile_blocks(&root(children)).expect("compiles").text
}
fn error(input: &Value) -> BlocksError {
    compile_blocks(input).expect_err("rejected")
}

// ---- ast_blocks.test.ts ----------------------------------------------------------------------

#[test]
fn plain_text_stays_exactly_as_typed_smileys_and_spacing_included() {
    assert_eq!(
        compile(vec![
            lit("Hello "),
            func("user", vec![]),
            lit("! :) welcome   back")
        ]),
        "Hello $(user)! :) welcome   back"
    );
}

#[test]
fn text_that_looks_like_an_expression_is_escaped_so_chat_shows_it() {
    assert_eq!(
        compile(vec![lit("type $(user) to see")]),
        "type \\$(user) to see"
    );
    let back = import_command_text("type \\$(user) to see").expect("imports");
    let kinds: Vec<_> = back.root.children.iter().map(|c| &c.kind).collect();
    assert!(
        matches!(kinds.as_slice(), [BlockKind::Literal { value }] if value == "type $(user) to see")
    );
}

#[test]
fn function_arguments_with_spaces_or_symbols_are_quoted() {
    assert_eq!(
        compile(vec![func(
            "say",
            vec![lit("hello there"), lit("-5"), lit("ok")]
        )]),
        "$(say \"hello there\" \"-5\" ok)"
    );
}

#[test]
fn death_counter_and_its_reply() {
    let text = compile(vec![
        set_var(
            "deaths",
            binary(get_var("deaths", "db", json!({})), "+", lit("1")),
            "db",
            json!({}),
        ),
        lit("Deaths: "),
        get_var("deaths", "db", json!({})),
    ]);
    assert_eq!(text, "%(*deaths *(%(*deaths) + 1))Deaths: %(*deaths)");
}

#[test]
fn if_else_with_a_group_branch_becomes_quoted_text_with_interpolation() {
    let ternary = json!({
        "id": id(), "type": "ternary",
        "test": binary(func("user", vec![]), "==", lit("cdom201")),
        "consequent": lit("Welcome back, boss"),
        "alternate": {"id": id(), "type": "group", "children": [lit("Hi "), func("user", vec![])]},
    });
    assert_eq!(
        compile(vec![ternary]),
        "*(($(user) == cdom201) ? \"Welcome back, boss\" : \"Hi ${$(user)}\")"
    );
}

#[test]
fn per_viewer_variables_lists_and_list_items() {
    assert_eq!(
        compile(vec![get_var(
            "points",
            "dbUser",
            json!({"userSelector": func("touser", vec![])})
        )]),
        "%(**points($(touser)))"
    );
    let list = json!({"id": id(), "type": "arrayLiteral", "items": [lit("one"), lit("two words")]});
    assert_eq!(
        compile(vec![set_var(
            "list",
            list,
            "memory",
            json!({"accessor": {"type": "append"}})
        )]),
        "%(list[] %[one, \"two words\"])"
    );
    assert_eq!(
        compile(vec![get_var(
            "list",
            "memory",
            json!({"accessor": {"type": "index", "index": lit("0")}})
        )]),
        "%(list[0])"
    );
    assert_eq!(
        compile(vec![get_var(
            "list",
            "cache",
            json!({"accessor": {"type": "random"}})
        )]),
        "%(#list[random])"
    );
    let delete = json!({"id": id(), "type": "deleteVar", "name": "list", "storage": "db", "accessor": {"type": "clear"}});
    assert_eq!(compile(vec![delete]), "%del(*list[])");
}

#[test]
fn repeat_loops_keep_the_real_loop_syntax() {
    let loop_var = || json!({"id": id(), "type": "loopVar", "name": "i"});
    let looped = json!({
        "id": id(), "type": "forLoop", "loopVar": "i", "mode": "range",
        "init": {"id": id(), "type": "loopAssign", "name": "i", "operator": "=", "value": lit("0")},
        "condition": binary(loop_var(), "<", lit("3")),
        "update": {"id": id(), "type": "loopAssign", "name": "i", "operator": "++"},
        "body": [func("say", vec![lit("ping"), loop_var()])],
    });
    assert_eq!(
        compile(vec![looped]),
        "*(for #i = 0; #i < 3; #i++ { $(say ping #i) })"
    );
}

#[test]
fn imported_commands_come_back_as_the_same_text_meaning() {
    let sources = [
        "$(user) hugs $(touser) <3",
        "*($(random 6) == 0 ? \"BANG! ${$(user)} is out\" : \"click... survives\")",
        "%(*deaths *(%(*deaths) + 1))Deaths so far: %(*deaths)",
        "Thanks for the raid $(raid.channel)! #(so $(raid.channel))",
        "*(for #i = 0; #i < 3; #i++ { $(say ping #i) })",
        "*(for #x in %(list[]) { $(say #x) })",
        "^(*seen) &t %del(##tmp(&p1)) *(-1 + 2)",
    ];
    for source in sources {
        let imported = import_command_text(source).expect("imports");
        assert_eq!(imported.advanced_count, 0, "{source}");
        let wire = serde_json::to_value(&imported.root).expect("serialises");
        let compiled = compile_blocks(&wire).expect("compiles");
        let again = import_command_text(&compiled.text).expect("imports");
        assert_eq!(
            again.root.children.len(),
            imported.root.children.len(),
            "{source}"
        );
    }
}

#[test]
fn unclear_expressions_stay_as_advanced_pieces_with_their_exact_text() {
    let imported = import_command_text("hi %(pen $(randomuser) extra) bye").expect("imports");
    assert_eq!(imported.advanced_count, 1);
    let raw = imported
        .root
        .children
        .iter()
        .find_map(|c| match &c.kind {
            BlockKind::Raw { source } => Some(source.as_str()),
            _ => None,
        })
        .expect("a raw piece");
    assert_eq!(raw, "%(pen $(randomuser) extra)");
    let wire = serde_json::to_value(&imported.root).expect("serialises");
    assert_eq!(
        compile_blocks(&wire).expect("compiles").text,
        "hi %(pen $(randomuser) extra) bye"
    );
}

#[test]
fn save_errors_point_at_the_block() {
    let empty = json!({"id": "empty-if", "type": "binary", "operator": "==", "left": null, "right": lit("x")});
    assert_eq!(
        error(&root(vec![empty])).block_id.as_deref(),
        Some("empty-if")
    );
    let raw = json!({"id": "r1", "type": "raw", "source": "$(x)"});
    assert_eq!(
        error(&root(vec![func("say", vec![raw])]))
            .block_id
            .as_deref(),
        Some("r1")
    );
    error(&root(vec![get_var("bad name", "memory", json!({}))]));
    error(&root(vec![lit("price \\$5")]));
    let long = "x".repeat(MAX_COMMAND_TEXT + 1);
    assert!(error(&root(vec![lit(&long)])).message.contains("too long"));
    assert!(error(&root(vec![])).message.contains("at least one block"));
    error(&json!({"type": "root"}));
}

#[test]
fn a_raw_piece_edited_into_plain_text_is_rejected() {
    let raw = json!({"id": "r2", "type": "raw", "source": "just text"});
    assert_eq!(error(&root(vec![raw])).block_id.as_deref(), Some("r2"));
}

#[test]
fn ids_are_kept_and_missing_or_duplicate_ids_are_replaced() {
    let input = json!({"id": "r", "type": "root", "children": [
        {"id": "same", "type": "literal", "value": "a "},
        {"id": "same", "type": "function", "name": "user", "args": []},
    ]});
    let saved = compile_blocks(&input).expect("compiles").root;
    assert_eq!(saved.children[0].id, "same");
    assert_ne!(saved.children[1].id, "same");
}

// ---- ast_parser/*.test.ts, the parse-only assertions -----------------------------------------

fn parse_error(source: &str) -> Option<String> {
    SyntaxEngine::default()
        .parse(source)
        .err()
        .map(|e| e.message)
}

#[test]
fn unclosed_ast_calls_quotes_and_arrays_report_parse_errors() {
    for source in ["$(user", "%(x", "\"unterminated", "%[one,two"] {
        let message = parse_error(source).unwrap_or_default().to_lowercase();
        assert!(message.contains("unclosed"), "{source}: {message}");
    }
}

#[test]
fn extra_closing_delimiters_report_parse_errors() {
    for source in ["$(user))", "%(x])", "*(1 + 2))"] {
        let message = parse_error(source).unwrap_or_default().to_lowercase();
        assert!(
            message.contains("unexpected closing"),
            "{source}: {message}"
        );
    }
}

#[test]
fn valid_nested_syntax_and_a_url_remain_valid() {
    for source in [
        "$(say score (5-3))",
        "%(items[0])",
        "$(say https://example.com/path)",
    ] {
        assert_eq!(parse_error(source), None, "{source}");
    }
}

#[test]
fn authored_templates_surface_an_unclosed_ast_call() {
    let plan = SyntaxEngine::default()
        .compile_template("before $(user")
        .expect("compiles");
    assert!(
        matches!(plan.segments()[1].step(), SegmentStep::Unclosed(e) if e.message == "Unclosed expression")
    );
}

#[test]
fn authored_templates_surface_errors_inside_a_balanced_expression() {
    let plan = SyntaxEngine::default()
        .compile_template("before $(say %[one,two)")
        .expect("compiles");
    assert!(
        matches!(plan.segments()[1].step(), SegmentStep::ParseError(e) if e.message == "Unclosed array literal")
    );
}

#[test]
fn template_interpolation_surfaces_malformed_inner_ast() {
    let program = SyntaxEngine::default()
        .parse("\"Hello ${%(x}\"")
        .expect("parses");
    let text = program.to_value().to_string();
    assert!(
        text.contains("[Parse error: Unclosed \\\"%(\\\"]"),
        "{text}"
    );
}

#[test]
fn balanced_and_escaped_parens_inside_function_args() {
    let engine = SyntaxEngine::default();
    for source in [
        "$(say score (5-3))",
        "$(say a (b (c)) d)",
        "$(say hi :\\))",
        "$(say a\\;b)",
        "$(say what\\?)",
        "$(say \\(x\\))",
        "$(say a\\\\b)",
        "%(mood :\\))",
        "$(say \"(quoted)\")",
    ] {
        assert!(engine.parse(source).is_ok(), "{source}");
    }
    assert_eq!(
        parse_error("$(say unbalanced (oops)").as_deref(),
        Some("Unclosed \"$(\"")
    );
}

#[test]
fn literal_arrays_decimals_and_member_access_parse() {
    let engine = SyntaxEngine::default();
    let first =
        |source: &str| -> AstNode { engine.parse(source).expect("parses").children()[0].clone() };
    assert!(matches!(
        first("%[1,2,3][0]"),
        AstNode::ArrayLiteral {
            accessor: Some(_),
            ..
        }
    ));
    assert!(matches!(first("*(5.5 + 1)"), AstNode::Binary { .. }));
    let AstNode::Function { args, .. } = first("$(say x.length)") else {
        panic!("a call");
    };
    assert_eq!(args.len(), 3, "the dot is split from the names");
}

#[test]
fn supports_an_empty_consequent_in_a_ternary_expression() {
    let program = SyntaxEngine::default()
        .parse("*(^(sumiso) ? : %(sumiso 42))")
        .expect("parses");
    let [AstNode::Ternary { consequent, .. }] = program.children() else {
        panic!("a ternary");
    };
    assert!(matches!(&**consequent, AstNode::Literal { value } if value.is_empty()));
}

#[test]
fn del_with_cache_variable_syntax_is_parsed_correctly() {
    let program = SyntaxEngine::default()
        .parse("%del(#cachevar)")
        .expect("parses");
    assert!(matches!(program.children(), [AstNode::DeleteVar { .. }]));
}

#[test]
fn imports_are_deterministic_with_injected_ids() {
    let text = "$(user) and %(*deaths)";
    let a = dima_engine::blocks::import_command_text_with(text, &mut IdMaker::new("i", "ab12"))
        .expect("imports");
    let b = dima_engine::blocks::import_command_text_with(text, &mut IdMaker::new("i", "ab12"))
        .expect("imports");
    assert_eq!(a, b);
    assert_eq!(a.root.children[0].id, "iab121");
    // The root takes the last id, as `importCommandText` builds it after its children.
    assert_eq!(a.root.id, "iab124");
}

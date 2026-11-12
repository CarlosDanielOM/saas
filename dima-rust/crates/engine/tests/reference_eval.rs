//! The reference's own evaluator tests, ported (same names where practical): `loop.test.ts`,
//! `ternary.test.ts`, `parens.test.ts`, `arrays.test.ts`, `timer.test.ts`, `user_scope*.test.ts`,
//! `syntax_errors.test.ts`, `permission_gate*.test.ts`, `persistent_delete.test.ts` and the
//! engine half of `command_references.test.ts` (delivery and the command handler belong to
//! `dima-actions`). The string, user and EventSub function tests are lifted into the pure corpus
//! by its generator.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod memory;

use dima_engine::context::{Authorization, Context, Origin, Plan, RoleTag, State};
use dima_engine::syntax::AstNode;
use dima_engine::value::Value;
use memory::{MemoryHost, block_on, engine_with, evaluate, render, text, with_variable};

fn default_engine() -> dima_engine::eval::Engine {
    engine_with(&[("say", None), ("noop", None), ("probe", None)])
}

fn host() -> MemoryHost {
    MemoryHost::new(7)
        .answer("say", |args, _| {
            Value::Text(
                args.iter()
                    .map(|a| a.to_text_or_empty().into_owned())
                    .collect::<Vec<_>>()
                    .join(" "),
            )
        })
        .answer("noop", |_, _| Value::empty())
}

fn run(source: &str, state: State) -> String {
    let engine = default_engine();
    text(&evaluate(
        &engine,
        source,
        &Context::default(),
        state,
        &mut host(),
    ))
}

fn items() -> State {
    with_variable("items", r#"["a","b","c"]"#)
}

// ---- loop.test.ts ----

#[test]
fn foreach_loop_iterates_over_stored_array_values() {
    assert_eq!(
        run(
            "*(for #item in %(items[]) { %(out[] #item) }) %(out[])",
            items()
        ),
        r#"["a","b","c"]"#
    );
}

#[test]
fn range_loop_appends_incremented_values() {
    assert_eq!(
        run(
            "*(for #i = 0; #i < 3; #i++ { %(out[] #i) }) %(out[])",
            State::default()
        ),
        r#"["0","1","2"]"#
    );
}

#[test]
fn continue_skips_the_current_iteration_body() {
    assert_eq!(
        run(
            "*(for #i = 0; #i < 5; #i++ { *(#i == 2 ? $(continue) : \"\") %(out[] #i) }) %(out[])",
            State::default()
        ),
        r#"["0","1","3","4"]"#
    );
}

#[test]
fn break_exits_the_innermost_loop() {
    assert_eq!(
        run(
            "*(for #i = 0; #i < 6; #i++ { *(#i == 3 ? $(break) : \"\") %(out[] #i) }) %(out[])",
            State::default()
        ),
        r#"["0","1","2"]"#
    );
}

#[test]
fn free_plan_truncates_loops_at_25_iterations() {
    let engine = default_engine();
    let context = Context {
        user_plan: Plan::Free,
        ..Context::default()
    };
    let done = evaluate(
        &engine,
        "*(for #i = 0; #i < 40; #i++ { %(out[] #i) }) %(out[].length)",
        &context,
        State::default(),
        &mut host(),
    );
    assert_eq!(text(&done), "25");
}

#[test]
fn bare_loop_variable_outside_a_loop_remains_literal_text() {
    assert_eq!(run("#count", State::default()), "#count");
}

#[test]
fn array_length_accessor_works_with_explicit_array_syntax() {
    assert_eq!(
        run(
            "%(items[].length)",
            with_variable("items", r#"["x","y","z","w"]"#)
        ),
        "4"
    );
}

#[test]
fn del_deletes_entire_memory_variable() {
    assert_eq!(
        run("%del(count) %(count)", with_variable("count", "42")),
        ""
    );
}

#[test]
fn del_removes_array_index() {
    assert_eq!(run("%del(items[1]) %(items[])", items()), r#"["a","c"]"#);
}

#[test]
fn del_clears_entire_array() {
    assert_eq!(run("%del(items[]) %(items[])", items()), "[]");
}

#[test]
fn del_on_non_existent_variable_does_not_error() {
    assert_eq!(
        run("%del(nonexistent) %(nonexistent)", State::default()),
        ""
    );
}

#[test]
fn del_with_cache_variable_syntax_is_parsed_correctly() {
    let program = default_engine().parse("%del(#cachevar)").unwrap();
    assert!(matches!(
        program.children().first(),
        Some(AstNode::DeleteVar { .. })
    ));
}

// ---- ternary.test.ts ----

#[test]
fn supports_an_empty_consequent_in_a_ternary_expression() {
    let engine = default_engine();
    let done = evaluate(
        &engine,
        "*(^(sumiso) ? : %(sumiso 42))",
        &Context::default(),
        with_variable("sumiso", "17"),
        &mut host(),
    );
    assert_eq!(text(&done), "");
    assert_eq!(
        done.state.variables.get("sumiso").map(String::as_str),
        Some("17")
    );
}

// ---- parens.test.ts ----

#[test]
fn parens_and_escapes_in_function_arguments() {
    for (source, expected) in [
        ("$(say score (5-3))", "score ( 5 - 3 )"),
        ("$(say nested ((deep)) end)", "nested ( ( deep ) ) end"),
        ("$(say hello \\:\\))", "hello :)"),
        ("$(say smiley \\; done)", "smiley ; done"),
        ("$(say what\\?)", "what?"),
        ("$(say escaped \\( and \\) here)", "escaped ( and ) here"),
        ("$(say backslash \\\\)", "backslash \\"),
        ("%(mood \\:\\)) %(mood)", ":)"),
        ("$(say \"quoted :) here\")", "quoted :) here"),
        ("$(noop %(a 1) %(a 2)) %(a)", "2"),
        ("$(say hello world) tail", "hello world tail"),
    ] {
        assert_eq!(run(source, State::default()), expected, "{source}");
    }
}

#[test]
fn unbalanced_open_paren_reports_a_parse_error() {
    let error = default_engine()
        .parse("$(say unbalanced (oops)")
        .unwrap_err();
    assert!(
        error.message.to_lowercase().contains("unclosed"),
        "{}",
        error.message
    );
}

// ---- arrays.test.ts ----

#[test]
fn array_accessors_and_decimals() {
    for (source, expected) in [
        ("%[apple, banana, cherry][1]", "banana"),
        ("%[a, b][].length", "2"),
        ("%[x, y, z][-1]", "z"),
        ("%[1,2,3]", "1,2,3"),
        ("*(%[1,2,3][].length * 1.5)", "4.5"),
        ("*(5.5 > 5 ? \"yes\" : \"no\")", "yes"),
        ("*(1.5 + 2.25)", "3.75"),
        ("*(5abc == 5 ? \"yes\" : \"no\")", "no"),
        ("*(5 == 5 ? \"yes\" : \"no\")", "yes"),
    ] {
        assert_eq!(run(source, State::default()), expected, "{source}");
    }
    for (source, expected) in [
        ("%(items[-1])", "c"),
        ("%(items[-3])", "a"),
        ("%(items[-4])", ""),
        ("%(items[*(1+1)])", "c"),
        ("^(items[-1])", "true"),
        ("^(items[-9])", "false"),
        ("%del(items[-1]) %(items[])", r#"["a","b"]"#),
        ("%(items[-1] ZZZ) %(items[])", r#"["a","b","ZZZ"]"#),
        ("%(items[].length)", "3"),
    ] {
        assert_eq!(run(source, items()), expected, "{source}");
    }
}

// ---- timer.test.ts ----

fn timer_context() -> Context {
    Context {
        broadcaster_id: "test".into(),
        user_id: "viewer".into(),
        ..Context::default()
    }
}

fn timer_args(engine: &dima_engine::eval::Engine, source: &str) -> Vec<AstNode> {
    match engine.parse(source).unwrap().children().first() {
        Some(AstNode::Function { args, .. }) => args.clone(),
        other => panic!("{other:?}"),
    }
}

#[test]
fn timer_defers_nested_actions_and_returns_no_immediate_body_text() {
    let engine = engine_with(&[("timer.testaction", None)]);
    let mut host = MemoryHost::new(1);
    let args = timer_args(&engine, "$(timer 300 5 minutes over $(timer.testaction))");
    let done =
        block_on(engine.evaluate_timer(&args, &timer_context(), State::default(), &mut host))
            .unwrap();
    assert_eq!(text(&done), "");
    assert!(host.recorded.calls.is_empty());
    let (seconds, body, _) = host.recorded.timers.pop().unwrap();
    assert_eq!(seconds, 300.0);
    let root = AstNode::Root { children: body };
    let later =
        block_on(engine.evaluate(&root, &timer_context(), State::default(), &mut host)).unwrap();
    assert_eq!(text(&later), "5 minutes over");
    assert_eq!(host.recorded.calls.len(), 1);
}

#[test]
fn duration_can_be_computed_while_the_body_remains_lazy() {
    let engine = default_engine();
    let mut host = MemoryHost::new(1);
    let args = timer_args(&engine, "$(timer %(seconds) \"Time is up!\")");
    block_on(engine.evaluate_timer(
        &args,
        &timer_context(),
        with_variable("seconds", "300"),
        &mut host,
    ))
    .unwrap();
    assert_eq!(host.recorded.timers.first().map(|t| t.0), Some(300.0));
}

#[test]
fn rejects_invalid_timer_without_scheduling() {
    let engine = engine_with(&[("timer.testaction", None)]);
    for source in [
        "$(timer)",
        "$(timer 300)",
        "$(timer -1 $(timer.testaction))",
        "$(timer 0 $(timer.testaction))",
        "$(timer nope $(timer.testaction))",
        "$(timer 604801 $(timer.testaction))",
        "$(timer Infinity hi)",
    ] {
        let mut host = MemoryHost::new(1);
        let args = timer_args(&engine, source);
        let done =
            block_on(engine.evaluate_timer(&args, &timer_context(), State::default(), &mut host))
                .unwrap();
        assert!(text(&done).starts_with("timer:"), "{source}");
        assert!(host.recorded.timers.is_empty(), "{source}");
    }
}

#[test]
fn nesting_and_channel_validation_do_not_execute_the_timer_body() {
    let engine = engine_with(&[("timer.testaction", None)]);
    let args = timer_args(&engine, "$(timer 300 $(timer.testaction))");
    for context in [
        Context {
            timer_depth: Some(5),
            ..timer_context()
        },
        Context {
            broadcaster_id: String::new(),
            ..timer_context()
        },
        Context {
            platform: "youtube".into(),
            ..timer_context()
        },
    ] {
        let mut host = MemoryHost::new(1);
        let done =
            block_on(engine.evaluate_timer(&args, &context, State::default(), &mut host)).unwrap();
        assert!(text(&done).starts_with("timer:"));
        assert!(host.recorded.timers.is_empty() && host.recorded.calls.is_empty());
    }
}

#[test]
fn cache_snapshot_preserves_identity_authorization_variables_and_loop_values_without_callbacks() {
    let engine = default_engine();
    let context = Context {
        authorization: Some(Authorization {
            origin: Origin::Llm,
            audit_origin: None,
            identity: Some(Value::object(vec![
                ("level".into(), Value::Number(1.0)),
                ("tags".into(), Value::List(vec![Value::text("subscriber")])),
            ])),
        }),
        ..timer_context()
    };
    let mut state = with_variable("name", "Original");
    state.loop_vars.insert("i".into(), "3".into());
    let snapshot = engine.snapshot(&context, &state);
    let saved: serde_json::Value =
        serde_json::from_slice(&dima_text::to_js_json_from(&snapshot).unwrap()).unwrap();
    assert_eq!(
        saved["variables"],
        serde_json::json!([["name", "Original"]])
    );
    assert_eq!(saved["loopVars"], serde_json::json!([["i", "3"]]));
    assert_eq!(saved["enforceFunctionPermissions"], true);
    assert_eq!(
        saved["authorization"],
        serde_json::json!({"origin": "llm", "identity": {"level": 1, "tags": ["subscriber"]}})
    );
    assert_eq!(saved["timerDepth"], 1);
    assert!(saved.get("saveUserVariable").is_none());
    // The snapshot reads back as the same data (a carried key family).
    let back: dima_engine::context::TimerSnapshot = serde_json::from_value(saved).unwrap();
    assert_eq!(back, snapshot);
}

#[test]
fn deferred_restricted_actions_retain_the_original_caller_permission_gate() {
    let engine = engine_with(&[("timer.restricted", Some(7.0))]);
    let mut host = MemoryHost::new(1);
    let args = timer_args(&engine, "$(timer 300 $(timer.restricted))");
    block_on(engine.evaluate_timer(&args, &timer_context(), State::default(), &mut host)).unwrap();
    let (_, body, _) = host.recorded.timers.pop().unwrap();
    let later = block_on(engine.evaluate(
        &AstNode::Root { children: body },
        &timer_context(),
        State::default(),
        &mut host,
    ))
    .unwrap();
    assert!(text(&later).to_lowercase().contains("permission denied"));
    assert!(host.recorded.calls.is_empty());
}

#[test]
fn a_failed_schedule_is_reported_in_chat() {
    let engine = default_engine();
    let mut host = MemoryHost::new(1);
    host.schedule_fails = true;
    let done = render(
        &engine,
        "a $(timer 5 later) b",
        &timer_context(),
        State::default(),
        &mut host,
    );
    assert_eq!(done.text, "a timer: could not schedule timer b");
}

// ---- user_scope.test.ts, user_scope_cache.test.ts ----

#[test]
fn persistent_user_variables_keep_selected_users_separate_in_one_evaluation() {
    let engine = default_engine();
    let mut host = MemoryHost::new(1);
    host.users.insert("score:alice".into(), "AliceValue".into());
    host.users.insert("score:bob".into(), "BobValue".into());
    let context = Context {
        user_id: "caller-id".into(),
        user_login: "caller".into(),
        user_plan: Plan::Premium,
        ..Context::default()
    };
    let source =
        "%(**score(alice)) %(**score(bob)) %(**score(alice) 7) %(**score(alice)) %(**score(bob))";
    let done = evaluate(&engine, source, &context, State::default(), &mut host);
    assert_eq!(text(&done), "AliceValue BobValue 7 BobValue");
    assert_eq!(host.users.get("score:alice").map(String::as_str), Some("7"));
    assert_eq!(
        host.users.get("score:bob").map(String::as_str),
        Some("BobValue")
    );
}

#[test]
fn selected_user_cache_writes_do_not_overwrite_the_caller() {
    let engine = default_engine();
    let mut host = MemoryHost::new(1);
    let context = Context {
        broadcaster_id: "channel".into(),
        scope_name: "command".into(),
        user_id: "caller-id".into(),
        user_login: "caller".into(),
        ..Context::default()
    };
    let done = evaluate(
        &engine,
        "%(##score 3) %(##score(alice) 7) %(##score) %(##score(alice))",
        &context,
        State::default(),
        &mut host,
    );
    assert_eq!(text(&done), "3 7");
    assert_eq!(
        host.cache
            .get("twitch:channel:variable:score:id:caller-id")
            .map(String::as_str),
        Some("3")
    );
    assert_eq!(
        host.cache
            .get("twitch:channel:variable:score:login:alice")
            .map(String::as_str),
        Some("7")
    );
}

// ---- syntax_errors.test.ts ----

#[test]
fn syntax_errors_surface_in_place() {
    let engine = default_engine();
    for source in ["$(user", "%(x", "\"unterminated", "%[one,two"] {
        assert!(
            engine
                .parse(source)
                .unwrap_err()
                .message
                .to_lowercase()
                .contains("unclosed"),
            "{source}"
        );
    }
    for source in ["$(user))", "%(x])", "*(1 + 2))"] {
        assert!(
            engine
                .parse(source)
                .unwrap_err()
                .message
                .to_lowercase()
                .contains("unexpected closing"),
            "{source}"
        );
    }
    for source in [
        "$(say score (5-3))",
        "%(items[0])",
        "$(say https://example.com/path)",
    ] {
        assert!(engine.parse(source).is_ok(), "{source}");
    }
    let rendered = render(
        &engine,
        "before $(user",
        &Context::default(),
        State::default(),
        &mut host(),
    );
    assert!(
        rendered.text.contains("[Parse error:")
            && rendered.text.to_lowercase().contains("unclosed")
    );
    let rendered = render(
        &engine,
        "before $(say %[one,two)",
        &Context::default(),
        State::default(),
        &mut host(),
    );
    assert!(
        rendered.text.to_lowercase().contains("unclosed array"),
        "{}",
        rendered.text
    );
    let inner = run("\"Hello ${%(x}\"", State::default());
    assert!(
        inner.contains("[Parse error:") && inner.to_lowercase().contains("unclosed"),
        "{inner}"
    );
}

// ---- permission_gate.test.ts, permission_gate_authored.test.ts ----

fn gated(source: &str, level: f64, enforce: bool) -> (String, usize) {
    let engine = engine_with(&[
        ("test.gated7", Some(7.0)),
        ("test.gated8", Some(8.0)),
        ("test.ungated", None),
    ]);
    let mut host = MemoryHost::new(1)
        .answer("test.ungated", |_, _| Value::text("ran-ok"))
        .answer("test.gated7", |_, _| Value::text("ran-ok"));
    let context = Context {
        user_level: level,
        enforce_function_permissions: enforce,
        ..Context::default()
    };
    let done = evaluate(&engine, source, &context, State::default(), &mut host);
    (text(&done), host.recorded.calls.len())
}

#[test]
fn permission_gate_denies_before_the_handler_runs() {
    let (value, calls) = gated("$(set.title hijacked title)", 1.0, true);
    assert!(
        value.starts_with("Error: permission denied")
            && value.contains("set.title")
            && value.contains("userlevel 7")
    );
    assert_eq!(calls, 0);
    let (value, _) = gated("$(test.gated7)", 1.0, true);
    assert!(value.starts_with("Error: permission denied") && value.contains("userlevel 7"));
    let (value, _) = gated("$(test.gated8)", 7.0, true);
    assert!(value.starts_with("Error: permission denied"));
    assert_eq!(gated("$(test.ungated)", 1.0, true).0, "ran-ok");
}

#[test]
fn authored_templates_are_not_gated_by_function_levels() {
    assert!(
        gated("$(test.gated7)", 1.0, true)
            .0
            .starts_with("Error: permission denied")
    );
    assert_eq!(gated("$(test.gated7)", 1.0, false).0, "ran-ok");
    assert_eq!(gated("$(test.gated7)", 10.0, false).0, "ran-ok");
}

// ---- persistent_delete.test.ts ----

#[test]
fn deleting_a_persistent_channel_variable_removes_the_stored_value() {
    let engine = default_engine();
    let mut host = MemoryHost::new(1);
    host.channel.insert("score".into(), "42".into());
    let context = Context {
        user_plan: Plan::Premium,
        ..Context::default()
    };
    evaluate(
        &engine,
        "%del(*score)",
        &context,
        State::default(),
        &mut host,
    );
    let done = evaluate(&engine, "^(*score)", &context, State::default(), &mut host);
    assert!(!host.channel.contains_key("score"));
    assert_eq!(text(&done), "false");
}

#[test]
fn deleting_and_editing_a_selected_user_array_affects_only_that_user() {
    let engine = default_engine();
    let mut host = MemoryHost::new(1);
    host.users
        .insert("items:alice".into(), r#"["a","b"]"#.into());
    host.users.insert("items:bob".into(), r#"["x","y"]"#.into());
    let context = Context {
        user_plan: Plan::Premium,
        user_id: "caller-id".into(),
        user_login: "caller".into(),
        ..Context::default()
    };
    evaluate(
        &engine,
        "%del(**items(bob)[0])",
        &context,
        State::default(),
        &mut host,
    );
    assert_eq!(
        host.users.get("items:bob").map(String::as_str),
        Some(r#"["y"]"#)
    );
    assert_eq!(
        host.users.get("items:alice").map(String::as_str),
        Some(r#"["a","b"]"#)
    );
    evaluate(
        &engine,
        "%del(**items(alice))",
        &context,
        State::default(),
        &mut host,
    );
    assert!(!host.users.contains_key("items:alice"));
}

// ---- command_references.test.ts (the engine's half) ----

#[test]
fn a_reference_is_deferred_never_substituted() {
    let engine = default_engine();
    let mut host = host();
    let context = Context {
        broadcaster_id: "fixture".into(),
        ..Context::default()
    };
    let done = render(
        &engine,
        "Join us on: #(discord)",
        &context,
        State::default(),
        &mut host,
    );
    assert_eq!(done.text, "Join us on: ");
    let reference = &done.state.command_references[0];
    assert_eq!(reference.command_name, "discord");
    assert_eq!(reference.state.visited_commands, ["fixture:discord"]);
    assert_eq!(reference.state.command_ref_depth, 1);
    assert!(host.recorded.calls.is_empty());
}

#[test]
fn recursion_depth_and_the_shared_budget_stop_references() {
    let engine = default_engine();
    // A command already on the call path is not referenced again.
    let visited = Context {
        broadcaster_id: "fixture".into(),
        visited_commands: vec!["fixture:loop".into()],
        ..Context::default()
    };
    assert!(
        render(
            &engine,
            "Once #(loop)",
            &visited,
            State::default(),
            &mut host()
        )
        .state
        .command_references
        .is_empty()
    );
    // The fifth nested reference is the last.
    let deep = Context {
        command_ref_depth: Some(5),
        ..Context::default()
    };
    assert!(
        render(&engine, "#(next)", &deep, State::default(), &mut host())
            .state
            .command_references
            .is_empty()
    );
    // One budget for the whole call tree: 50 references, then nothing.
    let context = Context::default();
    let done = render(
        &engine,
        &"#(a) ".repeat(60),
        &context,
        State::default(),
        &mut host(),
    );
    assert_eq!(done.state.command_references.len(), 50);
    assert_eq!(context.budget.remaining(), 0);
    assert!(
        done.state
            .command_references
            .iter()
            .all(|r| r.state.budget.same(&context.budget))
    );
}

#[test]
fn references_keep_their_arguments_unevaluated_text() {
    let engine = default_engine();
    let mut host = host().answer("probe", |_, _| Value::text("executed"));
    let done = render(
        &engine,
        "#(echo \"$(probe)\")",
        &Context::default(),
        State::default(),
        &mut host,
    );
    assert_eq!(done.state.command_references[0].argument, "$(probe)");
    assert!(host.recorded.calls.is_empty());
}

#[test]
fn llm_references_retain_the_requesting_chatters_authority() {
    let engine = default_engine();
    let context = Context {
        broadcaster_id: "fixture".into(),
        user_level: 1.0,
        authorization: Some(Authorization {
            origin: Origin::Llm,
            audit_origin: None,
            identity: Some(Value::object(vec![
                ("level".into(), Value::Number(1.0)),
                ("tags".into(), Value::List(vec![])),
            ])),
        }),
        ..Context::default()
    };
    let done = render(
        &engine,
        "#(restricted)",
        &context,
        State::default(),
        &mut host(),
    );
    let authorization = &done.state.command_references[0].authorization;
    assert_eq!(authorization.identity.level, 1);
    assert_eq!(authorization.identity.tags, [RoleTag::Everyone]);
    let authored = Context {
        enforce_function_permissions: false,
        ..context
    };
    let done = render(
        &engine,
        "#(restricted)",
        &authored,
        State::default(),
        &mut host(),
    );
    assert_eq!(
        done.state.command_references[0]
            .authorization
            .identity
            .level,
        10
    );
}

// ---- render.ts ----

#[test]
fn render_threads_state_and_stops_at_an_unclosed_expression() {
    let engine = default_engine();
    let done = render(
        &engine,
        "a%(v x)b%(v)c $(say y) $(missing",
        &Context::default(),
        State::default(),
        &mut host(),
    );
    assert_eq!(done.text, "abxc y [Parse error: Unclosed expression]");
    let done = render(
        &engine,
        "literal \\$(escaped) *(1 + 2)",
        &Context::default(),
        State::default(),
        &mut host(),
    );
    assert_eq!(done.text, "literal \\$(escaped) 3");
}

#[test]
fn delay_validates_then_asks_the_host_to_wait() {
    let engine = default_engine();
    let mut host = host();
    let done = render(
        &engine,
        "$(delay 1.5)|$(delay 61)|$(delay x)|$(delay)",
        &Context::default(),
        State::default(),
        &mut host,
    );
    assert_eq!(
        done.text,
        "|delay: must be between 0 and 60 seconds|delay: \"x\" is not a valid number|delay: missing argument (seconds)"
    );
    assert_eq!(host.recorded.sleeps, [1500]);
}

#[test]
fn ban_event_template_renders_the_timeout_duration() {
    let engine = default_engine();
    let context = Context {
        event_data: Value::object(vec![
            ("user_name".into(), Value::text("Spammer")),
            ("is_permanent".into(), Value::Bool(false)),
            ("banned_at".into(), Value::text("2026-01-01T00:00:00Z")),
            ("ends_at".into(), Value::text("2026-01-01T00:10:00Z")),
        ]),
        ..Context::default()
    };
    let done = render(
        &engine,
        "Timed out for $(ban.time)s",
        &context,
        State::default(),
        &mut host(),
    );
    assert_eq!(done.text, "Timed out for 600s");
}

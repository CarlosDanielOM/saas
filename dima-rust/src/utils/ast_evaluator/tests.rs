use super::*;
use crate::utils::ast_syntax::{ArrayAccessor, AstNode, VariableStorage};
use std::{
    cell::RefCell,
    future::Future,
    rc::Rc,
    task::{Context as TaskContext, Poll, Waker},
};
fn run<T>(future: impl Future<Output = T>) -> T {
    let mut context = TaskContext::from_waker(Waker::noop());
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(v) = future.as_mut().poll(&mut context) {
            return v;
        }
    }
}
#[derive(Default)]
struct Fake {
    events: Vec<HostRequest>,
    timers: Vec<JsValue>,
    calls: usize,
}
impl Host for Fake {
    fn execute<'a>(&'a mut self, request: HostRequest, context: Context) -> HostFuture<'a> {
        self.events.push(request.clone());
        self.calls += 1;
        Box::pin(async move {
            match request {
                HostRequest::Function { name, args } => match name.as_str() {
                    "typed" => Ok(JsValue::Number(-0.0)),
                    "first" => {
                        context.borrow_mut().count += 1.0;
                        Ok(JsValue::string("0"))
                    }
                    "throw" => Err(EvalError::new("host failed")),
                    "mutate" => {
                        context
                            .borrow()
                            .variables
                            .borrow_mut()
                            .insert("a".into(), JsValue::string("[9]"));
                        Ok(JsValue::string("0"))
                    }
                    "echo" => Ok(args.first().cloned().unwrap_or_default()),
                    _ => Ok(JsValue::string("called")),
                },
                HostRequest::LoadChannelVariable { .. } => Ok(JsValue::string("[1,2,3]")),
                HostRequest::CacheGet { .. } => Ok(JsValue::Null),
                HostRequest::CacheExists { .. } => Ok(JsValue::Number(0.0)),
                HostRequest::ScheduleTimer { .. } => {
                    assert!(context.borrow().effect_context.is_none());
                    self.timers.push(snapshot_timer_context(&context));
                    Ok(JsValue::Undefined)
                }
                _ => Ok(JsValue::Undefined),
            }
        })
    }
    fn random(&mut self) -> Result<f64, EvalError> {
        Ok(0.5)
    }
}
fn lit(value: &str) -> AstNode {
    AstNode::Literal {
        value: value.into(),
    }
}
fn function(name: &str, args: Vec<AstNode>) -> AstNode {
    AstNode::Function {
        name: name.into(),
        args,
    }
}
fn engine() -> Engine {
    let mut r = FunctionRegistry::with_context_builtins();
    for name in ["typed", "first", "throw", "mutate", "echo"] {
        r.register(name, None);
    }
    r.register(
        "gated",
        Some(FunctionMetadata {
            min_user_level: Some(7.0),
            ..Default::default()
        }),
    );
    Engine::new(r)
}
fn text(value: &JsValue) -> String {
    js_string(value).to_utf8().unwrap()
}
#[test]
fn typed_values_and_utf16() {
    assert_eq!(JsString::from("😀").len(), 2);
    let lone = JsString::from_units(vec![0xd800]);
    assert!(lone.to_utf8().is_err());
    assert_eq!(
        json_stringify(&JsValue::String(lone.clone()))
            .unwrap()
            .unwrap()
            .to_utf8()
            .unwrap(),
        "\"\\ud800\""
    );
    let parsed = json_parse(&"\"\\ud800\"".into()).unwrap();
    assert_eq!(js_string(&parsed), lone);
    assert_eq!(text(&JsValue::Number(-0.0)), "0");
    assert_eq!(JsValue::Number(-0.0).to_typed_json()["value"], "-0");
    assert_eq!(
        text(&JsValue::array(vec![
            JsValue::Null,
            JsValue::Undefined,
            JsValue::Boolean(false)
        ])),
        ",,false"
    );
}
#[test]
fn json_order_rounding_and_deep_values() {
    let value = json_parse(&r#"{"z":1,"10":2,"2":3,"a":4,"z":5}"#.into()).unwrap();
    assert_eq!(
        json_stringify(&value).unwrap().unwrap().to_utf8().unwrap(),
        r#"{"2":3,"10":2,"z":5,"a":4}"#
    );
    assert_eq!(
        to_number(&JsValue::string("0o1706467650045030172466317145567324")),
        1.1966040324345679e30
    );
    let raw = format!("{}0{}", "[".repeat(256), "]".repeat(256));
    let value = json_parse(&raw.clone().into()).unwrap();
    assert_eq!(
        json_stringify(&value).unwrap().unwrap().to_utf8().unwrap(),
        raw
    );
    assert_eq!(value::number_string(1e21), "1e+21");
    assert_eq!(value::number_string(1e-7), "1e-7");
}
#[test]
fn args_precede_permission_gate_but_ref_guards_precede_args() {
    let e = engine();
    let c = ExecutionContext::default().into_context();
    let mut h = Fake::default();
    let arg = function("first", vec![]);
    let r = run(e.evaluate(&function("gated", vec![arg.clone()]), c.clone(), &mut h)).unwrap();
    assert!(text(&r.value).contains("permission denied"));
    assert_eq!(c.borrow().count, 1.0);
    assert_eq!(h.calls, 1);
    c.borrow_mut().command_ref_depth = Some(5.0);
    let r = run(e.evaluate(
        &AstNode::CommandRef {
            command_name: "no".into(),
            args: vec![arg],
        },
        c.clone(),
        &mut h,
    ))
    .unwrap();
    assert_eq!(text(&r.value), "");
    assert_eq!(c.borrow().count, 1.0);
    assert_eq!(h.calls, 1);
}
#[test]
fn typed_handler_results_stay_typed_and_host_errors_throw() {
    let e = engine();
    let mut h = Fake::default();
    let r = run(e.evaluate(
        &function("typed", vec![]),
        ExecutionContext::default().into_context(),
        &mut h,
    ))
    .unwrap();
    assert!(matches!(r.value,JsValue::Number(n)if n==0.0&&n.is_sign_negative()));
    assert_eq!(r.stats.host_futures, 1);
    assert_eq!(r.stats.node_futures, 0);
    assert!(
        run(e.evaluate(
            &function("throw", vec![]),
            ExecutionContext::default().into_context(),
            &mut h
        ))
        .is_err()
    );
}
#[test]
fn array_memo_is_request_local_and_reads_stay_live() {
    let e = engine();
    let mut h = Fake::default();
    let node = AstNode::GetVar {
        name: "a".into(),
        storage: VariableStorage::Db,
        accessor: Some(ArrayAccessor::Length),
        user_selector: None,
    };
    let root = AstNode::Root {
        children: vec![node.clone(); 5],
    };
    let c = ExecutionContext::default().into_context();
    let r = run(e.evaluate(&root, c, &mut h)).unwrap();
    assert_eq!(text(&r.value), "3 3 3 3 3");
    assert_eq!(h.calls, 1);
    assert_eq!(r.stats.array_decodes, 1);
    assert_eq!(r.stats.array_cache_hits, 4);
    let c = ExecutionContext::default().into_context();
    c.borrow()
        .variables
        .borrow_mut()
        .insert("a".into(), JsValue::string("[1,2]"));
    let node = AstNode::GetVar {
        name: "a".into(),
        storage: VariableStorage::Memory,
        accessor: Some(ArrayAccessor::Index {
            index: Box::new(function("mutate", vec![])),
        }),
        user_selector: None,
    };
    let r = run(e.evaluate(&node, c.clone(), &mut h)).unwrap();
    assert_eq!(text(&r.value), "1");
    assert_eq!(text(c.borrow().variables.borrow().get("a").unwrap()), "[9]");
}
#[test]
fn failed_free_db_append_does_not_mutate_cached_array() {
    let e = engine();
    let mut h = Fake::default();
    let root = AstNode::Root {
        children: vec![
            AstNode::GetVar {
                name: "a".into(),
                storage: VariableStorage::Db,
                accessor: Some(ArrayAccessor::Length),
                user_selector: None,
            },
            AstNode::SetVar {
                name: "a".into(),
                storage: VariableStorage::Db,
                value: Box::new(lit("x")),
                accessor: Some(ArrayAccessor::Append),
                user_selector: None,
            },
            AstNode::GetVar {
                name: "a".into(),
                storage: VariableStorage::Db,
                accessor: Some(ArrayAccessor::Length),
                user_selector: None,
            },
        ],
    };
    let r = run(e.evaluate(&root, ExecutionContext::default().into_context(), &mut h)).unwrap();
    assert_eq!(text(&r.value), "3 3");
    assert_eq!(h.calls, 1);
}
#[test]
fn timers_strip_authority_restore_caller_and_leave_body_lazy() {
    let e = engine();
    let mut h = Fake::default();
    let c = ExecutionContext {
        broadcaster_id: "123".into(),
        effect_context: Some(EffectToken::from_host(7u32)),
        ..Default::default()
    }
    .into_context();
    let original = c.borrow().effect_context.clone().unwrap();
    let timer = function("timer", vec![lit("2"), function("throw", vec![])]);
    let r = run(e.evaluate(&timer, c, &mut h)).unwrap();
    assert_eq!(text(&r.value), "");
    assert_eq!(h.timers.len(), 1);
    assert!(
        r.context
            .borrow()
            .effect_context
            .as_ref()
            .unwrap()
            .same_identity(&original)
    );
    assert!(matches!(
        h.timers[0].get("effectContext"),
        JsValue::Undefined
    ));
}
#[test]
fn compiled_render_reuse_has_fresh_stats_and_root_join_differs() {
    let e = engine();
    let plan = e.compile_template("hello $(echo x)!").unwrap();
    for _ in 0..2 {
        let mut h = Fake::default();
        let r = run(e.render(&plan, ExecutionContext::default().into_context(), &mut h)).unwrap();
        assert_eq!(r.text.to_utf8().unwrap(), "hello x!");
        assert_eq!(r.stats.host_calls, 1);
    }
    let mut h = Fake::default();
    let r = run(e.evaluate(
        &AstNode::Root {
            children: vec![lit("a"), lit(""), lit("b")],
        },
        ExecutionContext::default().into_context(),
        &mut h,
    ))
    .unwrap();
    assert_eq!(text(&r.value), "a b");
}
#[test]
fn loop_scope_is_restored_and_read_only_body_does_not_copy_maps() {
    let e = engine();
    let c = ExecutionContext::default().into_context();
    let outer = c.borrow().loop_vars.clone().unwrap();
    for i in 0..100 {
        outer.insert(format!("seed{i}"), "v".into());
    }
    let node = AstNode::ForLoop {
        loop_var: "i".into(),
        mode: "foreach".into(),
        init: None,
        condition: None,
        update: None,
        iterable: Some(Box::new(AstNode::ArrayLiteral {
            items: vec![lit("a"), lit("b")],
            accessor: None,
        })),
        body: vec![lit("ignored"); 30],
    };
    let mut h = Fake::default();
    let r = run(e.evaluate(&node, c, &mut h)).unwrap();
    assert!(
        r.context
            .borrow()
            .loop_vars
            .as_ref()
            .unwrap()
            .same_identity(&outer)
    );
    assert_eq!(r.stats.loop_iterations, 2);
    assert!(r.stats.loop_map_copies <= 2);
    assert_eq!(r.stats.node_futures, 0);
    assert_eq!(r.stats.host_futures, 0);
}
#[test]
fn cache_name_prefix_is_stripped_once() {
    let e = engine();
    let c = ExecutionContext {
        broadcaster_id: "123".into(),
        user_id: "456".into(),
        user_login: "login".into(),
        ..Default::default()
    }
    .into_context();
    let mut h = Fake::default();
    let node = AstNode::GetVar {
        name: "####score".into(),
        storage: VariableStorage::CacheUser,
        accessor: None,
        user_selector: None,
    };
    run(e.evaluate(&node, c, &mut h)).unwrap();
    let HostRequest::CacheGet { key } = &h.events[0] else {
        panic!("get expected")
    };
    assert_eq!(key.to_utf8().unwrap(), "twitch:123:variable:##score:id:456");
}
#[test]
fn snapshot_copies_entries_but_shares_response_array() {
    let c = ExecutionContext::default().into_context();
    c.borrow()
        .variables
        .borrow_mut()
        .insert("a".into(), JsValue::string("old"));
    let snapshot = snapshot_timer_context(&c);
    c.borrow()
        .variables
        .borrow_mut()
        .insert("a".into(), JsValue::string("new"));
    c.borrow()
        .command_responses
        .borrow_mut()
        .push(JsValue::string("later"));
    assert_eq!(
        json_stringify(&snapshot.get("variables"))
            .unwrap()
            .unwrap()
            .to_utf8()
            .unwrap(),
        "[[\"a\",\"old\"]]"
    );
    let JsValue::Array(responses) = snapshot.get("commandResponses") else {
        panic!()
    };
    assert!(Rc::ptr_eq(&responses, &c.borrow().command_responses));
    assert_eq!(responses.borrow().len(), 1);
}
#[test]
fn arbitrary_deep_ast_is_rejected_before_any_host() {
    let e = engine();
    let mut node = lit("x");
    for _ in 0..130 {
        node = AstNode::Unary {
            operator: "+".into(),
            argument: Box::new(node),
        };
    }
    let mut h = Fake::default();
    assert!(run(e.evaluate(&node, ExecutionContext::default().into_context(), &mut h)).is_err());
    assert_eq!(h.calls, 0);
}
#[test]
fn cyclic_json_throws() {
    let value = JsValue::Array(Rc::new(RefCell::new(Vec::new())));
    if let JsValue::Array(a) = &value {
        a.borrow_mut().push(value.clone());
    }
    assert_eq!(json_stringify(&value).unwrap_err().name, "TypeError");
    if let JsValue::Array(a) = value {
        a.borrow_mut().clear();
    }
}

#[test]
fn timer_snapshot_shares_aliases_but_copies_visited() {
    let c = ExecutionContext::default().into_context();
    c.borrow_mut().visited_commands = Some(Rc::new(RefCell::new(vec!["old".into()])));
    let snapshot = snapshot_timer_context(&c);
    c.borrow()
        .scope_aliases
        .borrow_mut()
        .push(JsValue::string("alias"));
    c.borrow()
        .visited_commands
        .as_ref()
        .unwrap()
        .borrow_mut()
        .push("later".into());
    assert_eq!(
        json_stringify(&snapshot.get("scopeAliases"))
            .unwrap()
            .unwrap()
            .to_utf8()
            .unwrap(),
        "[\"alias\"]"
    );
    assert_eq!(
        json_stringify(&snapshot.get("visitedCommands"))
            .unwrap()
            .unwrap()
            .to_utf8()
            .unwrap(),
        "[\"old\"]"
    );
}

#[test]
fn explicit_improved_syntax_reuses_plan_without_weakening_compatibility() {
    use crate::utils::ast_syntax::SyntaxEngine;

    let syntax = SyntaxEngine::default();
    let source = "reply $(echo don't)";
    let plan = syntax.compile_template(source).unwrap();
    let improved = Engine::with_syntax(engine().registry().clone(), syntax);
    assert!(plan.matches_source(source));
    assert!(plan.is_compatible_with(improved.syntax(), source));
    assert!(!plan.matches_source("reply $(echo changed)"));
    assert!(!plan.is_compatible_with(improved.syntax(), "reply $(echo changed)"));

    let mut host = Fake::default();
    let rendered =
        run(improved.render(&plan, ExecutionContext::default().into_context(), &mut host)).unwrap();
    assert_eq!(rendered.text.to_utf8().unwrap(), "reply don't");
    assert_eq!(host.calls, 1);

    let mut rejected_host = Fake::default();
    let error = run(Engine::default().render(
        &plan,
        ExecutionContext::default().into_context(),
        &mut rejected_host,
    ))
    .unwrap_err();
    assert_eq!(
        error.message,
        "Incompatible compiled template profile or grammar"
    );
    assert_eq!(rejected_host.calls, 0);
}

#[test]
fn db_user_memo_preserves_surrogates_through_load_save_exists_and_delete() {
    struct UserHost {
        selector: JsString,
        stored: Option<JsString>,
        calls: Vec<&'static str>,
    }
    impl Host for UserHost {
        fn execute<'a>(&'a mut self, request: HostRequest, _context: Context) -> HostFuture<'a> {
            Box::pin(async move {
                match request {
                    HostRequest::LoadUserVariable {
                        name,
                        target_user_login,
                    } => {
                        assert_eq!(name, "score");
                        assert_eq!(target_user_login.as_ref(), Some(&self.selector));
                        self.calls.push("load");
                        Ok(self
                            .stored
                            .clone()
                            .map(JsValue::String)
                            .unwrap_or(JsValue::Null))
                    }
                    HostRequest::SaveUserVariable {
                        name,
                        value,
                        target_user_login,
                    } => {
                        assert_eq!(name, "score");
                        assert_eq!(target_user_login.as_ref(), Some(&self.selector));
                        self.calls.push("save");
                        self.stored = Some(value);
                        Ok(JsValue::Undefined)
                    }
                    HostRequest::DeleteUserVariable {
                        name,
                        target_user_login,
                    } => {
                        assert_eq!(name, "score");
                        assert_eq!(target_user_login.as_ref(), Some(&self.selector));
                        self.calls.push("delete");
                        self.stored = None;
                        Ok(JsValue::Undefined)
                    }
                    _ => panic!("unexpected operation"),
                }
            })
        }
        fn random(&mut self) -> Result<f64, EvalError> {
            panic!("unexpected random request")
        }
    }

    let selector = JsString::from_units(vec![64, 65, 0xd800, 66]);
    let target = Some(selector.clone());
    let mut key = JsString::from("login:a");
    key.push(&JsString::from_units(vec![0xd800]));
    key.push(&"b:score".into());
    let context = ExecutionContext {
        user_plan: "premium".into(),
        user_login: "caller".into(),
        ..Default::default()
    }
    .into_context();
    let mut host = UserHost {
        selector,
        stored: Some("loaded".into()),
        calls: Vec::new(),
    };
    let mut stats = EvalStats::default();
    let storage = VariableStorage::DbUser;
    assert_eq!(
        run(storage::read(
            &mut host, &mut stats, "**score", storage, &context, &target
        ))
        .unwrap(),
        JsString::from("loaded")
    );
    assert_eq!(
        context.borrow().user_command_variables.borrow().get(&key),
        Some(&JsString::from("loaded"))
    );
    assert!(
        run(storage::exists(
            &mut host, &mut stats, "**score", storage, &context, &target
        ))
        .unwrap()
    );
    run(storage::save(
        &mut host,
        &mut stats,
        "**score",
        storage,
        "saved".into(),
        &context,
        &target,
    ))
    .unwrap();
    assert_eq!(
        run(storage::read(
            &mut host, &mut stats, "**score", storage, &context, &target
        ))
        .unwrap(),
        JsString::from("saved")
    );
    assert_eq!(host.calls, vec!["load", "save"]);
    run(storage::delete(
        &mut host, &mut stats, "**score", storage, &context, &target,
    ))
    .unwrap();
    assert!(
        !context
            .borrow()
            .user_command_variables
            .borrow()
            .contains_key(&key)
    );
    assert!(
        !run(storage::exists(
            &mut host, &mut stats, "**score", storage, &context, &target
        ))
        .unwrap()
    );
    host.stored = Some("reloaded".into());
    assert_eq!(
        run(storage::read(
            &mut host, &mut stats, "**score", storage, &context, &target
        ))
        .unwrap(),
        JsString::from("reloaded")
    );
    assert_eq!(host.calls, vec!["load", "save", "delete", "load", "load"]);
    assert_eq!(
        context
            .borrow()
            .user_command_variables
            .borrow()
            .iter()
            .map(|(k, _)| k.clone())
            .collect::<Vec<_>>(),
        vec![key]
    );
}

#[test]
fn reference_spread_copies_enumerable_entries_and_shares_contained_values() {
    let engine = Engine::default();
    let node = AstNode::CommandRef {
        command_name: "next".into(),
        args: Vec::new(),
    };
    let contained = JsValue::object(vec![("value".into(), JsValue::string("before"))]);
    let array = JsValue::array(vec![contained.clone()]);
    let context = ExecutionContext {
        broadcaster_id: "123".into(),
        event_data: array.clone(),
        ..Default::default()
    }
    .into_context();
    let mut host = Fake::default();
    run(engine.evaluate(&node, context.clone(), &mut host)).unwrap();
    let queued = context.borrow().command_references.borrow()[0]
        .event_data
        .clone();
    let JsValue::Object(original_child) = &contained else {
        panic!("object expected")
    };
    let JsValue::Object(queued_child) = queued.get("0") else {
        panic!("object expected")
    };
    assert!(Rc::ptr_eq(original_child, &queued_child));
    contained.set("value", JsValue::string("after"));
    assert_eq!(text(&queued.get("0").get("value")), "after");
    let JsValue::Array(array) = array else {
        panic!("array expected")
    };
    array.borrow_mut().push(JsValue::string("later"));
    assert!(matches!(queued.get("1"), JsValue::Undefined));

    let units = vec![65, 0xd83d, 0xde00, 0xd800];
    context.borrow_mut().event_data = JsValue::String(JsString::from_units(units.clone()));
    run(engine.evaluate(&node, context.clone(), &mut host)).unwrap();
    let queued = context.borrow().command_references.borrow()[1]
        .event_data
        .clone();
    for (i, unit) in units.into_iter().enumerate() {
        assert_eq!(js_string(&queued.get(&i.to_string())).units(), &[unit]);
    }
    let JsValue::Object(entries) = queued else {
        panic!("object expected")
    };
    assert_eq!(
        entries
            .borrow()
            .iter()
            .map(|(key, _)| key.to_utf8().unwrap())
            .collect::<Vec<_>>(),
        vec![
            "0",
            "1",
            "2",
            "3",
            "chatter_user_id",
            "chatter_user_login",
            "chatter_user_name"
        ]
    );

    context.borrow_mut().event_data = JsValue::object(vec![
        ("chatter_user_login".into(), JsValue::string("old")),
        ("nested".into(), contained),
        ("2".into(), JsValue::string("indexed")),
    ]);
    run(engine.evaluate(&node, context.clone(), &mut host)).unwrap();
    let queued = context.borrow().command_references.borrow()[2]
        .event_data
        .clone();
    let JsValue::Object(entries) = queued else {
        panic!("object expected")
    };
    assert_eq!(
        entries
            .borrow()
            .iter()
            .map(|(key, _)| key.to_utf8().unwrap())
            .collect::<Vec<_>>(),
        vec![
            "2",
            "chatter_user_login",
            "nested",
            "chatter_user_id",
            "chatter_user_name"
        ]
    );
    assert_eq!(text(&entries.borrow()[1].1), "123");
    assert_eq!(host.calls, 0);
}

#[test]
fn object_get_compares_borrowed_utf16_keys_and_keeps_first_match_identity() {
    let child = JsValue::object(vec![("value".into(), JsValue::Number(7.0))]);
    let object = JsValue::object(vec![
        (JsString::from_units(vec![0xd800]), JsValue::string("lone")),
        ("😀".into(), child.clone()),
        ("é".into(), JsValue::string("composed")),
        ("e\u{301}".into(), JsValue::string("decomposed")),
        ("😀".into(), JsValue::string("duplicate")),
        ("".into(), JsValue::Boolean(false)),
    ]);
    let JsValue::Object(original) = child else {
        panic!("object")
    };
    let JsValue::Object(found) = object.get("😀") else {
        panic!("first matching value")
    };
    assert!(Rc::ptr_eq(&original, &found));
    assert_eq!(text(&object.get("é")), "composed");
    assert_eq!(text(&object.get("e\u{301}")), "decomposed");
    assert!(matches!(object.get(""), JsValue::Boolean(false)));
    assert!(matches!(object.get("\u{fffd}"), JsValue::Undefined));
    assert!(matches!(object.get("absent"), JsValue::Undefined));
    assert!(matches!(JsValue::Null.get("key"), JsValue::Undefined));
    let JsValue::Object(entries) = object else {
        panic!("object")
    };
    assert_eq!(entries.borrow().len(), 6);
    assert_eq!(entries.borrow()[0].0.units(), &[0xd800]);
}

#[test]
fn count_uses_raw_argument_truthiness_without_changing_legacy_coercion() {
    let engine = Engine::new(FunctionRegistry::with_context_builtins());
    for (argument_override, expected) in [
        (None, "7"),
        (Some(JsValue::Null), "0"),
        (Some(JsValue::Undefined), "0"),
        (Some(JsValue::Boolean(false)), "0"),
        (Some(JsValue::array(vec![])), "0"),
        (Some(JsValue::array(vec![JsValue::string("+5")])), "5"),
        (
            Some(JsValue::object(vec![("toString".into(), JsValue::Null)])),
            "0",
        ),
    ] {
        let context = ExecutionContext {
            argument: Some("7".into()),
            argument_override,
            ..Default::default()
        }
        .into_context();
        let mut host = Fake::default();
        let result =
            run(engine.evaluate(&function("count", vec![]), context.clone(), &mut host)).unwrap();
        assert_eq!(text(&result.value), expected);
        assert_eq!(context.borrow().count_modified, Some(true));
        assert_eq!(host.calls, 0);
        assert_eq!(result.stats.host_futures, 0);
        let before = context.borrow().count;
        run(engine.evaluate(
            &function("count", vec![lit("2")]),
            context.clone(),
            &mut host,
        ))
        .unwrap();
        assert_eq!(context.borrow().count, before + 2.0);
    }
}

#[test]
fn command_reference_preserves_truthy_raw_display_and_falls_back_for_nullish() {
    let engine = Engine::default();
    let raw_array = JsValue::array(vec![]);
    for (display_override, expected) in [
        (None, JsValue::string("typed")),
        (Some(JsValue::Null), JsValue::string("login")),
        (Some(JsValue::Undefined), JsValue::string("login")),
        (Some(JsValue::Boolean(false)), JsValue::string("login")),
        (Some(raw_array.clone()), raw_array.clone()),
    ] {
        let context = ExecutionContext {
            broadcaster_id: "channel".into(),
            user_login: "login".into(),
            user_display_name: "typed".into(),
            user_display_name_override: display_override,
            ..Default::default()
        }
        .into_context();
        let node = AstNode::CommandRef {
            command_name: "next".into(),
            args: vec![],
        };
        let mut host = Fake::default();
        run(engine.evaluate(&node, context.clone(), &mut host)).unwrap();
        let display = context.borrow().command_references.borrow()[0]
            .event_data
            .get("chatter_user_name");
        assert_eq!(display.to_typed_json(), expected.to_typed_json());
        if let (JsValue::Array(expected), JsValue::Array(actual)) = (expected, display) {
            assert!(Rc::ptr_eq(&expected, &actual));
        }
        assert_eq!(host.calls, 0);
    }
}

use super::super::value::js_string;
use super::super::{
    Engine, ExecutionContext, FunctionMetadata, FunctionRegistry, HostFuture, HostRequest,
};
use super::*;
use crate::utils::ast_syntax::{ArrayAccessor, AstNode};
use std::{
    collections::VecDeque,
    future::Future,
    rc::Rc,
    task::{Context as TaskContext, Poll, Waker},
};

fn run<T>(future: impl Future<Output = T>) -> T {
    let mut context = TaskContext::from_waker(Waker::noop());
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
    }
}
#[derive(Default)]
struct TraceHost {
    events: Vec<String>,
    randoms: VecDeque<Result<f64, EvalError>>,
}
impl Host for TraceHost {
    fn execute<'a>(&'a mut self, request: HostRequest, context: Context) -> HostFuture<'a> {
        let HostRequest::Function { name, args } = request else {
            panic!("unexpected effect")
        };
        self.events.push(format!(
            "{name}:{}",
            args.first()
                .map(js_string)
                .unwrap_or_default()
                .to_utf8()
                .unwrap()
        ));
        context.borrow_mut().count += 1.0;
        Box::pin(async move {
            Ok(args
                .first()
                .cloned()
                .unwrap_or_else(|| JsValue::string("custom")))
        })
    }
    fn random(&mut self) -> Result<f64, EvalError> {
        self.events.push("random".into());
        self.randoms.pop_front().unwrap_or(Ok(0.5))
    }
}
fn lit(text: &str) -> AstNode {
    AstNode::Literal { value: text.into() }
}
fn function(name: &str, args: Vec<AstNode>) -> AstNode {
    AstNode::Function {
        name: name.into(),
        args,
    }
}
fn values(args: &[&str]) -> Vec<JsValue> {
    args.iter().map(|text| JsValue::string(*text)).collect()
}
fn text_call(name: &str, args: &[JsValue], context: &ExecutionContext) -> JsString {
    let function = definitions()
        .into_iter()
        .find(|entry| entry.0 == name)
        .unwrap()
        .1;
    let mut host = TraceHost::default();
    let mut stats = EvalStats::default();
    let result = dispatch(
        function,
        args,
        &context.clone().into_context(),
        &mut host,
        &mut stats,
    )
    .unwrap();
    assert_eq!(stats.host_futures, 0);
    js_string(&result)
}
fn assert_call(name: &str, args: &[&str], expected: &str) {
    assert_eq!(
        text_call(name, &values(args), &ExecutionContext::default()),
        JsString::from(expected)
    );
}
fn event(json: serde_json::Value) -> ExecutionContext {
    ExecutionContext {
        event_data: JsValue::from_json(&json),
        ..Default::default()
    }
}

#[test]
fn exactly_27_explicit_registrations_and_context_composition() {
    let names = [
        "upper",
        "lower",
        "title",
        "capitalize",
        "trim",
        "length",
        "slice",
        "replace",
        "user",
        "touser",
        "random",
        "twitch.modiversary",
        "twitch.streak",
        "raid.channel",
        "raid.login",
        "raid.viewers",
        "cheer.amount",
        "cheer.message",
        "sub.tier",
        "sub.months",
        "gifted.user",
        "hypetrain.progress",
        "hypetrain.level",
        "hypetrain.end",
        "shoutout.channel",
        "reward.input",
        "redemption.input",
    ];
    assert_eq!(FunctionRegistry::default().entries().count(), 0);
    let mut registry = FunctionRegistry::with_pure_builtins();
    assert_eq!(
        registry
            .entries()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        names
    );
    assert_eq!(
        registry
            .metadata("redemption.input")
            .unwrap()
            .alias_of
            .as_deref(),
        Some("reward.input")
    );
    assert_eq!(
        registry.metadata("redemption.input").unwrap().syntax,
        "reward.input"
    );
    assert!(registry.metadata("user").unwrap().surfaces.is_none());
    assert_eq!(
        registry
            .metadata("upper")
            .unwrap()
            .surfaces
            .as_ref()
            .unwrap(),
        &["authoring"]
    );
    assert_eq!(
        registry.metadata("user").unwrap().examples.last().unwrap(),
        "user ignore symbols numbers"
    );
    for name in [
        "count",
        "scount",
        "bits",
        "break",
        "continue",
        "randomuser",
        "timer",
        "tts",
    ] {
        assert!(registry.get(name).is_none());
    }
    registry.register_pure_builtins();
    assert_eq!(registry.entries().count(), 27);
    let mut combined = FunctionRegistry::with_context_builtins();
    assert_eq!(combined.entries().count(), 5);
    combined.register("extra", None);
    combined.register_pure_builtins();
    assert_eq!(combined.entries().count(), 33);
    assert_eq!(
        combined
            .entries()
            .take(6)
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        ["count", "scount", "bits", "break", "continue", "extra"]
    );
}

#[test]
fn every_native_name_executes_without_host_function_futures_or_context_changes() {
    let engine = Engine::new(FunctionRegistry::with_pure_builtins());
    let context = ExecutionContext {
        user_display_name: "Caller".into(),
        count: 42.0,
        ..Default::default()
    }
    .into_context();
    let variables = context.borrow().variables.clone();
    let budget = context.borrow().command_ref_budget.clone();
    let mut host = TraceHost::default();
    let expected = [
        ("upper", ""),
        ("lower", ""),
        ("title", ""),
        ("capitalize", ""),
        ("trim", ""),
        ("length", "0"),
        ("slice", ""),
        ("replace", ""),
        ("user", "Caller"),
        ("touser", "Caller"),
        ("random", "50"),
        ("twitch.modiversary", "0"),
        ("twitch.streak", "0"),
        ("raid.channel", "unknown"),
        ("raid.login", "unknown"),
        ("raid.viewers", "0"),
        ("cheer.amount", "0"),
        ("cheer.message", ""),
        ("sub.tier", "unknown"),
        ("sub.months", "0"),
        ("gifted.user", "unknown"),
        ("hypetrain.progress", "0"),
        ("hypetrain.level", "0"),
        ("hypetrain.end", "unknown"),
        ("shoutout.channel", "unknown"),
        ("reward.input", ""),
        ("redemption.input", ""),
    ];
    for (name, expected) in expected {
        let result =
            run(engine.evaluate(&function(name, vec![]), context.clone(), &mut host)).unwrap();
        assert_eq!(js_string(&result.value), JsString::from(expected), "{name}");
        assert!(Rc::ptr_eq(&result.context, &context));
        assert_eq!(result.stats.host_futures, 0, "{name}");
        assert_eq!(
            result.stats.host_calls,
            u64::from(name == "random"),
            "{name}"
        );
    }
    assert_eq!(host.events, ["random"]);
    assert_eq!(context.borrow().count, 42.0);
    assert_eq!(context.borrow().count_modified, Some(false));
    assert!(Rc::ptr_eq(&variables, &context.borrow().variables));
    assert!(Rc::ptr_eq(&budget, &context.borrow().command_ref_budget));
}

#[test]
fn override_preserves_metadata_and_order_and_switches_to_host() {
    let mut registry = FunctionRegistry::with_pure_builtins();
    let metadata = serde_json::to_value(registry.metadata("upper")).unwrap();
    registry.register("upper", None);
    assert_eq!(
        serde_json::to_value(registry.metadata("upper")).unwrap(),
        metadata
    );
    assert_eq!(registry.entries().next().unwrap().name, "upper");
    assert_eq!(registry.entries().count(), 27);
    let engine = Engine::new(registry);
    let mut host = TraceHost::default();
    let result = run(engine.evaluate(
        &function("upper", vec![lit("raw")]),
        ExecutionContext::default().into_context(),
        &mut host,
    ))
    .unwrap();
    assert_eq!(js_string(&result.value), JsString::from("raw"));
    assert_eq!(result.stats.host_futures, 1);
    assert_eq!(host.events, ["upper:raw"]);

    let mut registry = FunctionRegistry::with_pure_builtins();
    registry.register(
        "upper",
        Some(FunctionMetadata {
            min_user_level: Some(7.0),
            ..Default::default()
        }),
    );
    let engine = Engine::new(registry);
    let mut host = TraceHost::default();
    let result = run(engine.evaluate(
        &function("upper", vec![]),
        ExecutionContext::default().into_context(),
        &mut host,
    ))
    .unwrap();
    assert!(
        js_string(&result.value)
            .to_utf8()
            .unwrap()
            .contains("requires moderator")
    );
    assert!(host.events.is_empty());
}

#[test]
fn all_arguments_are_sequential_before_native_permission_gate_and_dispatch() {
    let mut registry = FunctionRegistry::with_pure_builtins();
    registry.register("arg", None);
    let engine = Engine::new(registry);
    let node = function(
        "upper",
        vec![
            function("arg", vec![lit("a")]),
            function("arg", vec![lit("b")]),
        ],
    );
    // The nested functions permit level 0 through their explicit metadata,
    // while the native outer function still requires the default level 1.
    let mut registry = engine.registry().clone();
    registry.register(
        "arg",
        Some(FunctionMetadata {
            min_user_level: Some(0.0),
            ..Default::default()
        }),
    );
    let engine = Engine::new(registry);
    let context = ExecutionContext {
        user_level: 0.0,
        ..Default::default()
    }
    .into_context();
    let mut host = TraceHost::default();
    let result = run(engine.evaluate(&node, context.clone(), &mut host)).unwrap();
    assert!(
        js_string(&result.value)
            .to_utf8()
            .unwrap()
            .contains("permission denied")
    );
    assert_eq!(host.events, ["arg:a", "arg:b"]);
    assert_eq!(context.borrow().count, 2.0);
    assert_eq!(result.stats.host_futures, 2);
    context.borrow_mut().enforce_function_permissions = false;
    let result = run(engine.evaluate(&node, context.clone(), &mut host)).unwrap();
    assert_eq!(js_string(&result.value), JsString::from("A B"));
    assert_eq!(context.borrow().count, 4.0);
    assert_eq!(result.stats.host_futures, 2);
    assert!(Rc::ptr_eq(&context, &result.context));
}

#[test]
fn string_join_coercions_gaps_and_utf16_slice_boundaries() {
    let context = ExecutionContext::default();
    let args = [
        JsValue::Null,
        JsValue::string("😀"),
        JsValue::Undefined,
        JsValue::string(""),
    ];
    assert_eq!(text_call("length", &args, &context), JsString::from("5"));
    let mut sliced = values(&["1", "2"]);
    sliced.extend_from_slice(&args);
    assert_eq!(text_call("slice", &sliced, &context).units(), &[0xd83d]);
    sliced[0] = JsValue::string("2");
    sliced[1] = JsValue::string("4");
    assert_eq!(text_call("slice", &sliced, &context).units(), &[0xde00, 32]);
    let args = [
        JsValue::Null,
        JsValue::Boolean(false),
        JsValue::Number(-0.0),
        JsValue::array(vec![JsValue::Null, JsValue::string("x")]),
    ];
    assert_eq!(
        text_call("upper", &args, &context),
        JsString::from(" FALSE 0 ,X")
    );
    assert_call("slice", &["-", "5", "hello", "world"], "world");
    assert_call("slice", &["0", "-", "6", "hello", "world"], "hello");
    assert_call("slice", &["-", "-2", "hello"], "hello"); // '--2' parses to NaN, fallback start 0.
    assert_call("slice", &["2", "-", "-2", "hello"], "llo"); // end fallback is full length.
    assert_call("slice", &["9", "2", "hello"], "");
    assert_call("slice", &["+1", "hello"], "");
    assert_call("slice", &["1.5", "hello"], "");
    assert_call("slice", &["0", "", "x", ""], " x ");
    assert_call("trim", &["\u{feff}\u{a0}x\u{85}"], "x\u{85}");
}

#[test]
fn case_expansion_contextual_sigma_and_title_word_boundaries() {
    assert_call("upper", &["Straße", "ﬃ", "İ"], "STRASSE FFI İ");
    assert_call("lower", &["ΟΣ", "İ"], "ος i\u{307}");
    assert_call("capitalize", &["ßTEST"], "SSTEST");
    assert_call("capitalize", &["𐐨ABC"], "𐐨ABC");
    assert_call(
        "title",
        &["HELLO-world !NEXT", "\u{301}ABC\u{feff}DEF\u{85}GHI"],
        "Hello-world !next \u{301}abc\u{feff}Def\u{85}ghi",
    );
    let lone = JsValue::String(JsString::from_units(vec![0xd800, 0x039f, 0x03a3, 0xdc00]));
    assert_eq!(
        text_call("lower", &[lone], &ExecutionContext::default()).units(),
        &[0xd800, 0x03bf, 0x03c2, 0xdc00]
    );
}

#[test]
fn literal_replace_does_not_expand_dollars_rescan_or_overlap() {
    assert_call("replace", &["aa", "$&$$", "aaaaa"], "$&$$$&$$a");
    assert_call("replace", &["a", "aa", "aaa"], "aaaaaa");
    assert_call("replace", &["", "x", "hello"], "hello");
    assert_call("replace", &["ana", "x", "banana"], "bxna");
    assert_call("replace", &["a b", "Z", "a", "b", "a", "b"], "Z Z");
    let text = format!("{}b", "a".repeat(8192));
    let search = format!("{}b", "a".repeat(1024));
    assert_eq!(
        text_call(
            "replace",
            &values(&[&search, "X", &text]),
            &ExecutionContext::default()
        ),
        JsString::from(format!("{}X", "a".repeat(7168)))
    );
    let args = [
        JsValue::String(JsString::from_units(vec![0xde00])),
        JsValue::string("$&"),
        JsValue::string("😀"),
    ];
    assert_eq!(
        text_call("replace", &args, &ExecutionContext::default()).units(),
        &[0xd83d, 36, 38]
    );
}

#[test]
fn filters_stream_quoted_tokens_exact_categories_and_invalid_lists() {
    let context = event(serde_json::json!({"chatter_user_name":"A_\u{0345}Ⅻ٢²😀Z"}));
    assert_eq!(
        text_call(
            "user",
            &values(&["IGNORE\u{feff}symbols", "numbers", "symbols"]),
            &context
        ),
        JsString::from("A\u{0345}Z")
    );
    assert_eq!(
        text_call("user", &values(&["ignore", "symbols"]), &context),
        JsString::from("A\u{0345}Ⅻ٢²Z")
    );
    assert_eq!(
        text_call("user", &values(&["ignore", "numbers"]), &context),
        JsString::from("A_\u{0345}😀Z")
    );
    for args in [
        vec!["ignore"],
        vec!["symbols", "numbers"],
        vec!["ignore symbols constructor"],
        vec!["ignore symbols __proto__"],
        vec!["ignore\u{85}symbols"],
    ] {
        assert_eq!(
            text_call("user", &values(&args), &context),
            JsString::from("A_\u{0345}Ⅻ٢²😀Z")
        );
    }
    for name in ["\u{0345}", "\u{0301}", "Ⅻ٢²", "😀_!!!"] {
        let context = event(serde_json::json!({"chatter_user_name":name}));
        assert_eq!(
            text_call("user", &values(&["ignore symbols numbers"]), &context),
            JsString::from("viewer")
        );
    }
    // A Unicode Letter_Number is N, not L, even though Alphabetic is true.
    assert_call("title", &["ⅫHELLO"], "ⅻhello");
    let context = ExecutionContext {
        event_data: JsValue::object(vec![(
            "chatter_user_name".into(),
            JsValue::String(JsString::from_units(vec![65, 0xd800, 49])),
        )]),
        ..Default::default()
    };
    assert_eq!(
        text_call("user", &values(&["ignore numbers"]), &context).units(),
        &[65, 0xd800]
    );
    assert_eq!(
        text_call("user", &values(&["ignore symbols"]), &context),
        JsString::from("A1")
    );
}

#[test]
fn user_priority_and_touser_string_only_escape() {
    let mut context = ExecutionContext {
        user_display_name: "display".into(),
        user_login: "login".into(),
        event_data: JsValue::from_json(
            &serde_json::json!({"chatter_user_name":17,"chatter_user_login":"event-login"}),
        ),
        extra_context: JsValue::from_json(
            &serde_json::json!({"userName":"extra","userLogin":"extra-login"}),
        ),
        ..Default::default()
    };
    for expected in [
        "17",
        "event-login",
        "extra",
        "extra-login",
        "display",
        "login",
        "",
    ] {
        assert_eq!(text_call("user", &[], &context), JsString::from(expected));
        match expected {
            "17" => context
                .event_data
                .set("chatter_user_name", JsValue::Boolean(false)),
            "event-login" => context.event_data = JsValue::Undefined,
            "extra" => context.extra_context.set("userName", JsValue::Null),
            "extra-login" => context.extra_context = JsValue::Undefined,
            "display" => context.user_display_name.clear(),
            "login" => context.user_login.clear(),
            _ => {}
        }
    }
    context.user_display_name = "raw$%*".into();
    assert_eq!(text_call("touser", &[], &context), JsString::from("raw$%*"));
    context.argument = Some("ctx$%*".into());
    assert_eq!(
        text_call("touser", &[JsValue::Number(0.0)], &context),
        JsString::from("ctx\\$\\%\\*")
    );
    assert_eq!(
        text_call("touser", &values(&["$%*\\$"]), &context),
        JsString::from("\\$\\%\\*\\\\$")
    );
    assert_eq!(
        text_call(
            "touser",
            &[JsValue::array(vec![JsValue::string("$%*")])],
            &context
        ),
        JsString::from("$%*")
    );
    assert_eq!(
        text_call("touser", &[JsValue::Boolean(true)], &context),
        JsString::from("true")
    );
    assert_eq!(
        text_call("touser", &[JsValue::array(vec![])], &context),
        JsString::default()
    );
}

#[test]
fn eventsub_preserves_precedence_types_untrimmed_strings_and_numeric_blanks() {
    let context = event(serde_json::json!({
        "raid_direction":"outgoing", "to_broadcaster_user_name":"  Dest  ", "to_broadcaster_user_login":"dest",
        "from_broadcaster_user_name":"Origin", "viewers":"  ", "cheer":{"bits":"999"}, "bits":"0x10",
        "message":{"text":"  "}, "cumulative_months":"", "streak_months":99,
        "tier":" TiEr_-2 ", "recipient_user_name":false, "recipient_user_login":" gift ",
        "progress":false, "total":"2.5", "goal":99, "level":"0b11", "ends_at":"\u{feff}", "ended_at":" end ",
        "user_input":"  ", "reward_input":" raw "
    }));
    for (name, expected) in [
        ("raid.channel", "  Dest  "),
        ("raid.login", "dest"),
        ("raid.viewers", "0"),
        ("cheer.amount", "16"),
        ("cheer.message", "  "),
        ("sub.months", "0"),
        ("sub.tier", "Tier 2"),
        ("gifted.user", " gift "),
        ("hypetrain.progress", "2.5"),
        ("hypetrain.level", "3"),
        ("hypetrain.end", " end "),
        ("shoutout.channel", "Origin"),
        ("reward.input", " raw "),
        ("redemption.input", " raw "),
    ] {
        assert_eq!(
            text_call(name, &[], &context),
            JsString::from(expected),
            "{name}"
        );
    }
    for number in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        context.event_data.set(
            "cheer",
            JsValue::object(vec![("bits".into(), JsValue::Number(number))]),
        );
        assert_eq!(
            text_call("cheer.amount", &[], &context),
            JsString::from(number_string(number))
        );
        context.event_data.set("viewers", JsValue::Number(number));
        assert_eq!(
            text_call("raid.viewers", &[], &context),
            JsString::from("0")
        );
    }
    context.event_data.set("is_prime", JsValue::Boolean(false));
    context.event_data.set("prime", JsValue::Boolean(true));
    assert_eq!(
        text_call("sub.tier", &[], &context),
        JsString::from("Tier 2")
    );
    context
        .event_data
        .set("plan_name", JsValue::string("surprise PRIME plan"));
    assert_eq!(
        text_call("sub.tier", &[], &context),
        JsString::from("Prime")
    );
    context.event_data.set("plan_name", JsValue::Undefined);
    context.event_data.set("tier", JsValue::string(" odd "));
    assert_eq!(
        text_call("sub.tier", &[], &context),
        JsString::from(" odd ")
    );
}

#[test]
fn safe_event_counts_reject_strings_fractions_arrays_and_unsafe_numbers() {
    for (name, object, key) in [
        ("twitch.streak", "watch_streak", "streak_count"),
        ("twitch.modiversary", "modiversary", "months"),
    ] {
        let context = ExecutionContext {
            event_data: JsValue::object(vec![]),
            ..Default::default()
        };
        for invalid in [
            JsValue::string("24"),
            JsValue::Number(-1.0),
            JsValue::Number(1.5),
            JsValue::Number(f64::NAN),
            JsValue::Number(f64::INFINITY),
            JsValue::Number(9007199254740992.0),
            JsValue::Null,
        ] {
            context
                .event_data
                .set(object, JsValue::object(vec![(key.into(), invalid)]));
            assert_eq!(text_call(name, &[], &context), JsString::from("0"));
        }
        context
            .event_data
            .set(object, JsValue::array(vec![JsValue::Number(24.0)]));
        assert_eq!(text_call(name, &[], &context), JsString::from("0"));
        for (number, expected) in [
            (24.0, "24"),
            (-0.0, "0"),
            (9007199254740991.0, "9007199254740991"),
        ] {
            context.event_data.set(
                object,
                JsValue::object(vec![(key.into(), JsValue::Number(number))]),
            );
            assert_eq!(text_call(name, &[], &context), JsString::from(expected));
        }
    }
}

#[test]
fn rng_decimal_defaults_negative_max_and_unclamped_host_math() {
    for (arg, expected) in [
        ("0", "50"),
        ("-0", "50"),
        ("0x20", "50"),
        ("12tail", "6"),
        ("-5", "-3"),
        ("2.9", "1"),
        ("Infinity", "50"),
        ("\u{feff}9", "4"),
    ] {
        assert_call("random", &[arg], expected);
    }
    for (random, expected) in [
        (1.0, "10"),
        (-0.1, "-1"),
        (f64::NAN, "NaN"),
        (f64::INFINITY, "Infinity"),
    ] {
        let mut host = TraceHost {
            randoms: VecDeque::from([Ok(random)]),
            ..Default::default()
        };
        let mut stats = EvalStats::default();
        let result = dispatch(
            PureFunction::Random,
            &values(&["10"]),
            &ExecutionContext::default().into_context(),
            &mut host,
            &mut stats,
        )
        .unwrap();
        assert_eq!(js_string(&result), JsString::from(expected));
        assert_eq!(stats.host_calls, 1);
        assert_eq!(stats.host_futures, 0);
    }
}

#[test]
fn random_order_matches_array_rng_and_errors_use_existing_vm_path() {
    let mut registry = FunctionRegistry::with_context_builtins();
    registry.register_pure_builtins();
    let engine = Engine::new(registry);
    let array = AstNode::ArrayLiteral {
        items: vec![lit("left"), lit("right")],
        accessor: Some(ArrayAccessor::Random),
    };
    let node = AstNode::Root {
        children: vec![
            function("random", vec![function("random", vec![lit("10")])]),
            array,
            function("scount", vec![]),
        ],
    };
    let context = ExecutionContext::default().into_context();
    let mut host = TraceHost {
        randoms: VecDeque::from([Ok(0.8), Ok(0.5), Ok(0.1)]),
        ..Default::default()
    };
    let result = run(engine.evaluate(&node, context.clone(), &mut host)).unwrap();
    assert_eq!(js_string(&result.value), JsString::from("4 left 1"));
    assert_eq!(host.events, ["random", "random", "random"]);
    assert_eq!(result.stats.host_calls, 3);
    assert_eq!(result.stats.host_futures, 0);
    assert_eq!(context.borrow().count, 1.0);
    host.randoms
        .push_back(Err(EvalError::new("rng unavailable")));
    let result = run(engine.evaluate(&function("random", vec![]), context, &mut host));
    assert_eq!(result.unwrap_err().message, "rng unavailable");
}

#[test]
fn unicode_17_source_assignments_are_not_lost_by_locked_regex_16_tables() {
    for character in ['\u{88f}', '\u{a7ce}', '\u{11db0}', '\u{33430}'] {
        assert_eq!(categories(character), (true, false, false));
    }
    for character in ['\u{1acf}', '\u{11b60}', '\u{1e6e3}'] {
        assert_eq!(categories(character), (false, true, false));
    }
    for character in ['\u{11de0}', '\u{16ff4}'] {
        assert_eq!(categories(character), (false, false, true));
    }
    // Alphabetic-but-not-L and numeric forms must keep their exact categories.
    assert_eq!(categories('\u{0345}'), (false, true, false));
    assert_eq!(categories('Ⅻ'), (false, false, true));
    assert_eq!(categories('²'), (false, false, true));
    let context = event(serde_json::json!({"chatter_user_name":"\u{88f}_\u{11b60}\u{11de0}"}));
    assert_eq!(
        text_call("user", &values(&["ignore symbols numbers"]), &context),
        JsString::from("\u{88f}\u{11b60}")
    );
    assert_call("title", &["\u{a7ce}WORD"], "\u{a7ce}word");
    assert_call("lower", &["\u{a7ce}"], "\u{a7cf}");
    assert_call("upper", &["\u{a7cf}"], "\u{a7ce}");
}

#[test]
fn native_context_reads_do_not_request_mutable_context_borrows() {
    let context =
        event(serde_json::json!({"chatter_user_name":"Reader", "bits":12})).into_context();
    let shared = context.borrow();
    let mut host = TraceHost::default();
    let mut stats = EvalStats::default();
    for (function, expected) in [
        (PureFunction::User, "Reader"),
        (PureFunction::ToUser, "Reader"),
        (PureFunction::CheerAmount, "12"),
    ] {
        let result = dispatch(function, &[], &context, &mut host, &mut stats).unwrap();
        assert_eq!(js_string(&result), JsString::from(expected));
    }
    assert_eq!(shared.count, 0.0);
    assert_eq!(stats.host_calls, 0);
    assert_eq!(stats.host_futures, 0);
}

fn bad_to_string(value: JsValue) -> JsValue {
    JsValue::object(vec![("toString".into(), value)])
}
fn coercion_error() -> EvalError {
    EvalError {
        name: "TypeError".into(),
        message: "Cannot convert object to primitive value".into(),
    }
}

#[test]
fn checked_plain_data_coercion_distinguishes_absent_and_undefined_own_keys() {
    for value in [JsValue::Null, JsValue::Number(3.0), JsValue::Undefined] {
        let bad = bad_to_string(value);
        assert_eq!(checked_string(&bad).unwrap_err(), coercion_error());
        assert_eq!(
            checked_string(&JsValue::array(vec![bad])).unwrap_err(),
            coercion_error()
        );
    }
    let ordinary = JsValue::object(vec![
        ("valueOf".into(), JsValue::Number(3.0)),
        ("irrelevant".into(), bad_to_string(JsValue::Null)),
    ]);
    assert_eq!(
        checked_string(&ordinary).unwrap().as_ref(),
        &JsString::from("[object Object]")
    );
    let string = JsValue::string("borrowed");
    assert!(matches!(
        checked_string(&string).unwrap(),
        std::borrow::Cow::Borrowed(_)
    ));
    assert_eq!(
        checked_string(&JsValue::Null).unwrap().as_ref(),
        &JsString::from("null")
    );
    assert!(string_arg(&JsValue::Null).unwrap().is_empty());
}

#[test]
fn checked_array_coercion_preserves_cycles_nullish_gaps_and_utf16() {
    let array = JsValue::array(vec![]);
    let JsValue::Array(items) = &array else {
        panic!("array expected")
    };
    items.borrow_mut().extend([
        JsValue::Null,
        array.clone(),
        JsValue::String(JsString::from_units(vec![0xd800])),
        JsValue::Undefined,
    ]);
    assert_eq!(
        checked_string(&array).unwrap().units(),
        &[44, 44, 0xd800, 44]
    );
    items
        .borrow_mut()
        .push(JsValue::array(vec![bad_to_string(JsValue::Null)]));
    assert_eq!(checked_string(&array).unwrap_err(), coercion_error());
    items.borrow_mut().clear();
}

#[test]
fn all_coercing_pure_families_throw_without_rng_or_host_function_calls() {
    let context = ExecutionContext::default().into_context();
    for function in [
        PureFunction::Upper,
        PureFunction::Lower,
        PureFunction::Title,
        PureFunction::Capitalize,
        PureFunction::Trim,
        PureFunction::Length,
        PureFunction::Slice,
        PureFunction::Replace,
        PureFunction::User,
        PureFunction::ToUser,
        PureFunction::Random,
    ] {
        let bad = bad_to_string(JsValue::Undefined);
        let args = match function {
            PureFunction::Slice => vec![JsValue::string("0"), bad],
            PureFunction::Replace => vec![JsValue::string(""), bad, JsValue::string("text")],
            PureFunction::User => vec![JsValue::string("unknown"), bad],
            _ => vec![bad],
        };
        let mut host = TraceHost::default();
        let mut stats = EvalStats::default();
        assert_eq!(
            dispatch(function, &args, &context, &mut host, &mut stats).unwrap_err(),
            coercion_error(),
            "{function:?}"
        );
        assert!(host.events.is_empty(), "{function:?}");
        assert_eq!(stats.host_calls, 0);
        assert_eq!(stats.host_futures, 0);
    }
}

#[test]
fn slice_and_replace_coerce_only_at_the_source_boundaries() {
    let context = ExecutionContext::default();
    let bad = bad_to_string(JsValue::Null);
    for prefix in [vec!["invalid"], vec!["-", "invalid"]] {
        let mut args = values(&prefix);
        args.push(bad.clone());
        assert_eq!(text_call("slice", &args, &context), JsString::default());
    }
    let mut host = TraceHost::default();
    let mut stats = EvalStats::default();
    let context = context.into_context();
    for args in [
        vec![JsValue::string("-"), bad.clone()],
        vec![JsValue::string("0"), JsValue::string("0"), bad.clone()],
    ] {
        assert_eq!(
            dispatch(PureFunction::Slice, &args, &context, &mut host, &mut stats).unwrap_err(),
            coercion_error()
        );
    }
    for args in [
        vec![JsValue::string(""), bad.clone()],
        vec![JsValue::string(""), JsValue::string("x"), bad],
    ] {
        assert_eq!(
            dispatch(
                PureFunction::Replace,
                &args,
                &context,
                &mut host,
                &mut stats
            )
            .unwrap_err(),
            coercion_error()
        );
    }
}

#[test]
fn user_filter_keeps_coercing_after_invalid_syntax_and_checks_name_first() {
    let context = ExecutionContext::default().into_context();
    let mut host = TraceHost::default();
    let mut stats = EvalStats::default();
    for prefix in [
        vec!["unknown"],
        vec!["ignore", "unknown"],
        vec!["ignore", "symbols", "unknown"],
    ] {
        let mut args = values(&prefix);
        args.push(bad_to_string(JsValue::Null));
        assert_eq!(
            dispatch(PureFunction::User, &args, &context, &mut host, &mut stats).unwrap_err(),
            coercion_error()
        );
    }
    context.borrow_mut().event_data = JsValue::object(vec![(
        "chatter_user_name".into(),
        bad_to_string(JsValue::Null),
    )]);
    assert_eq!(
        dispatch(PureFunction::User, &[], &context, &mut host, &mut stats).unwrap_err(),
        coercion_error()
    );
}

#[test]
fn raw_context_overrides_keep_source_truthiness_type_and_string_only_escaping() {
    let mut context = ExecutionContext {
        argument: Some("stale$".into()),
        user_display_name: "stale-display".into(),
        user_login: "login".into(),
        user_display_name_override: Some(JsValue::Null),
        ..Default::default()
    };
    assert_eq!(text_call("user", &[], &context), JsString::from("login"));
    for raw in [
        JsValue::Null,
        JsValue::Undefined,
        JsValue::Boolean(false),
        JsValue::Number(0.0),
    ] {
        context.argument_override = Some(raw);
        assert_eq!(text_call("touser", &[], &context), JsString::from("login"));
    }
    context.argument_override = Some(JsValue::array(vec![]));
    assert_eq!(text_call("touser", &[], &context), JsString::default());
    context.argument_override = Some(JsValue::array(vec![JsValue::string("$x")]));
    assert_eq!(text_call("touser", &[], &context), JsString::from("$x"));
    context.argument_override = None;
    assert_eq!(
        text_call("touser", &[], &context),
        JsString::from("stale\\$")
    );
    context.user_display_name_override = Some(JsValue::Number(17.0));
    let context = context.into_context();
    let mut host = TraceHost::default();
    let mut stats = EvalStats::default();
    let result = dispatch(PureFunction::User, &[], &context, &mut host, &mut stats).unwrap();
    assert!(matches!(result, JsValue::Number(number) if number == 17.0));
    let error = dispatch(
        PureFunction::User,
        &values(&["ignore symbols"]),
        &context,
        &mut host,
        &mut stats,
    )
    .unwrap_err();
    assert_eq!(error.name, "TypeError");
    assert_eq!(error.message, "name is not iterable");
}

#[test]
fn raw_display_arrays_follow_source_iteration_and_preserve_unfiltered_identity() {
    let display = JsValue::array(values(&["A!", "B2", "\u{301}"]));
    let context = ExecutionContext {
        user_display_name_override: Some(display.clone()),
        ..Default::default()
    };
    assert_eq!(
        text_call("user", &values(&["ignore symbols numbers"]), &context),
        JsString::from("A!\u{301}")
    );
    let context = context.into_context();
    let result = dispatch(
        PureFunction::User,
        &[],
        &context,
        &mut TraceHost::default(),
        &mut EvalStats::default(),
    )
    .unwrap();
    let (JsValue::Array(original), JsValue::Array(result)) = (display, result) else {
        panic!("raw array expected")
    };
    assert!(Rc::ptr_eq(&original, &result));
}

#[test]
fn coercion_failures_follow_all_argument_evaluation_but_not_permission_denial() {
    #[derive(Default)]
    struct ArgumentHost(Vec<String>);
    impl Host for ArgumentHost {
        fn execute<'a>(&'a mut self, request: HostRequest, context: Context) -> HostFuture<'a> {
            let HostRequest::Function { name, .. } = request else {
                panic!("function expected")
            };
            self.0.push(name.clone());
            context.borrow_mut().count += 1.0;
            Box::pin(async move {
                Ok(if name == "bad" {
                    bad_to_string(JsValue::Null)
                } else {
                    JsValue::string("later")
                })
            })
        }
        fn random(&mut self) -> Result<f64, EvalError> {
            panic!("no RNG expected")
        }
    }
    let mut registry = FunctionRegistry::with_pure_builtins();
    for name in ["bad", "later"] {
        registry.register(
            name,
            Some(FunctionMetadata {
                min_user_level: Some(0.0),
                ..Default::default()
            }),
        );
    }
    let engine = Engine::new(registry);
    let context = ExecutionContext::default().into_context();
    let mut host = ArgumentHost::default();
    let node = function(
        "upper",
        vec![function("bad", vec![]), function("later", vec![])],
    );
    assert_eq!(
        run(engine.evaluate(&node, context.clone(), &mut host)).unwrap_err(),
        coercion_error()
    );
    assert_eq!(host.0, ["bad", "later"]);
    assert_eq!(context.borrow().count, 2.0);
    context.borrow_mut().user_level = 0.0;
    let result = run(engine.evaluate(&node, context.clone(), &mut host)).unwrap();
    assert!(
        js_string(&result.value)
            .to_utf8()
            .unwrap()
            .contains("permission denied")
    );
    assert_eq!(host.0, ["bad", "later", "bad", "later"]);
    assert_eq!(context.borrow().count, 4.0);
    assert_eq!(result.stats.host_futures, 2);
}

#[test]
fn removing_numbers_can_join_lone_surrogates_into_a_letter() {
    let context = ExecutionContext {
        event_data: JsValue::object(vec![(
            "chatter_user_name".into(),
            JsValue::String(JsString::from_units(vec![0xd801, 49, 0xdc00])),
        )]),
        ..Default::default()
    };
    assert_eq!(
        text_call("user", &values(&["ignore numbers"]), &context).units(),
        &[0xd801, 0xdc00]
    );
}

// Only the lead invokes this example, in its capped isolated release runtime.
#[cfg(not(feature = "ast-evaluator"))]
fn main() {
    eprintln!("Enable --no-default-features --features ast-evaluator");
}

#[cfg(feature = "ast-evaluator")]
fn main() {
    if let Err(error) = benchmark::run() {
        eprintln!("ast_evaluator_bench: {error}");
        std::process::exit(1);
    }
}

#[cfg(feature = "ast-evaluator")]
pub mod support {
    use serde_json::Value;
    use std::{
        future::Future,
        sync::Arc,
        task::{Context, Poll, Wake, Waker},
    };

    // A local future executor: fake host operations may suspend and wake, with
    // no Tokio runtime, network, clocks or service initialization.
    pub fn block_on<F: Future>(future: F) -> F::Output {
        struct ThreadWake(std::thread::Thread);
        impl Wake for ThreadWake {
            fn wake(self: Arc<Self>) {
                self.0.unpark();
            }
            fn wake_by_ref(self: &Arc<Self>) {
                self.0.unpark();
            }
        }
        let waker = Waker::from(Arc::new(ThreadWake(std::thread::current())));
        let mut context = Context::from_waker(&waker);
        let mut future = std::pin::pin!(future);
        loop {
            match future.as_mut().poll(&mut context) {
                Poll::Ready(value) => return value,
                Poll::Pending => std::thread::park(),
            }
        }
    }

    // Hash raw bytes, not a JSON representation or hex-encoded bytes. This
    // independent helper avoids adding a dependency solely for benchmark IO.
    pub fn sha256_hex(bytes: &[u8]) -> String {
        const K: [u32; 64] = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
            0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
            0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
            0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
            0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
            0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
            0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
            0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
            0xc67178f2,
        ];
        let mut state = [
            0x6a09e667u32,
            0xbb67ae85,
            0x3c6ef372,
            0xa54ff53a,
            0x510e527f,
            0x9b05688c,
            0x1f83d9ab,
            0x5be0cd19,
        ];
        let mut padded = bytes.to_vec();
        padded.push(0x80);
        while padded.len() % 64 != 56 {
            padded.push(0);
        }
        padded.extend_from_slice(&(bytes.len() as u64 * 8).to_be_bytes());
        for chunk in padded.as_chunks::<64>().0 {
            let mut words = [0u32; 64];
            for (index, word) in chunk.as_chunks::<4>().0.iter().enumerate() {
                words[index] = u32::from_be_bytes(*word);
            }
            for i in 16..64 {
                let a = words[i - 15].rotate_right(7)
                    ^ words[i - 15].rotate_right(18)
                    ^ (words[i - 15] >> 3);
                let b = words[i - 2].rotate_right(17)
                    ^ words[i - 2].rotate_right(19)
                    ^ (words[i - 2] >> 10);
                words[i] = words[i - 16]
                    .wrapping_add(a)
                    .wrapping_add(words[i - 7])
                    .wrapping_add(b);
            }
            let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
            for i in 0..64 {
                let x = h
                    .wrapping_add(e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25))
                    .wrapping_add((e & f) ^ (!e & g))
                    .wrapping_add(K[i])
                    .wrapping_add(words[i]);
                let y = (a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22))
                    .wrapping_add((a & b) ^ (a & c) ^ (b & c));
                h = g;
                g = f;
                f = e;
                e = d.wrapping_add(x);
                d = c;
                c = b;
                b = a;
                a = x.wrapping_add(y);
            }
            for (slot, word) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
                *slot = slot.wrapping_add(word);
            }
        }
        state.iter().map(|word| format!("{word:08x}")).collect()
    }

    // Stable JSON-tree FNV1a UTF8 fingerprint. Keys sorted, array order exact.
    // Byte SHA256 provenance remains separate and is never compared to this.
    pub fn fingerprint(value: &Value) -> String {
        fn feed(hash: &mut u32, text: &str) {
            for byte in text.as_bytes() {
                *hash = (*hash ^ u32::from(*byte)).wrapping_mul(16_777_619);
            }
        }
        fn walk(hash: &mut u32, value: &Value) {
            match value {
                Value::Array(items) => {
                    feed(hash, "[");
                    for item in items {
                        walk(hash, item);
                    }
                    feed(hash, "]");
                }
                Value::Object(object) => {
                    feed(hash, "{");
                    let mut keys: Vec<_> = object.keys().collect();
                    keys.sort();
                    for key in keys {
                        feed(hash, key);
                        feed(hash, ":");
                        walk(hash, &object[key]);
                    }
                    feed(hash, "}");
                }
                Value::Number(value) => {
                    feed(
                        hash,
                        &format!(
                            "f64:{:016x}",
                            value.as_f64().expect("JSON number").to_bits()
                        ),
                    );
                    feed(hash, ";");
                }
                _ => {
                    feed(hash, &value.to_string());
                    feed(hash, ";");
                }
            }
        }
        let mut hash = 2_166_136_261;
        walk(&mut hash, value);
        format!("{hash:08x}")
    }
}

#[cfg(feature = "ast-evaluator")]
pub mod adapter {
    use super::support::block_on;
    use dima_rust::utils::{
        ast_evaluator::*,
        ast_syntax::{AstNode, CompiledProgram, CompiledTemplate},
    };
    use serde::{
        Deserialize,
        de::{self, MapAccess, SeqAccess, Visitor},
    };
    use serde_json::{Value, json, value::RawValue};
    use std::{cell::RefCell, fmt, rc::Rc};

    fn string(value: &str) -> JsValue {
        JsValue::string(JsString::from(value))
    }
    fn object(entries: Vec<(&str, JsValue)>) -> JsValue {
        JsValue::object(
            entries
                .into_iter()
                .map(|(key, value)| (JsString::from(key), value))
                .collect(),
        )
    }
    fn array(values: Vec<JsValue>) -> JsValue {
        JsValue::array(values)
    }
    fn entries(value: &JsValue) -> Vec<(String, JsValue)> {
        match value {
            JsValue::Object(values) => values
                .borrow()
                .iter()
                .map(|(key, value)| (key.to_utf8().expect("fixture UTF8 key"), value.clone()))
                .collect(),
            _ => Vec::new(),
        }
    }
    fn items(value: &JsValue) -> Vec<JsValue> {
        match value {
            JsValue::Array(values) => values.borrow().clone(),
            _ => Vec::new(),
        }
    }
    fn field(value: &JsValue, key: &str) -> JsValue {
        entries(value)
            .into_iter()
            .find_map(|(name, value)| (name == key).then_some(value))
            .unwrap_or(JsValue::Undefined)
    }
    fn text(value: &JsValue) -> String {
        js_string(value).to_utf8().expect("fixture UTF8 boundary")
    }
    fn optional_number(value: &JsValue) -> Option<f64> {
        match value {
            JsValue::Number(n) => Some(*n),
            _ => None,
        }
    }
    fn deep_clone(value: &JsValue) -> JsValue {
        match value {
            JsValue::Array(values) => array(values.borrow().iter().map(deep_clone).collect()),
            JsValue::Object(values) => JsValue::object(
                values
                    .borrow()
                    .iter()
                    .map(|(key, value)| (key.clone(), deep_clone(value)))
                    .collect(),
            ),
            _ => value.clone(),
        }
    }

    // Decode directly from ordered wire JSON. A serde_json::Value roundtrip
    // would sort keys and change ordinary JS object observations/coercion.
    struct OrderedJs(JsValue);
    impl<'de> Deserialize<'de> for OrderedJs {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            struct OrderedVisitor;
            impl<'de> Visitor<'de> for OrderedVisitor {
                type Value = OrderedJs;
                fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                    f.write_str("ordered JavaScript data")
                }
                fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                    Ok(OrderedJs(JsValue::Null))
                }
                fn visit_bool<E: de::Error>(self, value: bool) -> Result<Self::Value, E> {
                    Ok(OrderedJs(JsValue::Boolean(value)))
                }
                fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
                    Ok(OrderedJs(JsValue::Number(value as f64)))
                }
                fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
                    Ok(OrderedJs(JsValue::Number(value as f64)))
                }
                fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
                    Ok(OrderedJs(JsValue::Number(value)))
                }
                fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                    Ok(OrderedJs(string(value)))
                }
                fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                    let mut result = Vec::new();
                    while let Some(OrderedJs(value)) = seq.next_element()? {
                        result.push(value);
                    }
                    Ok(OrderedJs(array(result)))
                }
                fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                    let mut result = Vec::new();
                    while let Some((key, OrderedJs(value))) =
                        map.next_entry::<String, OrderedJs>()?
                    {
                        result.push((JsString::from(key.as_str()), value));
                    }
                    if result.len() == 1 && result[0].0.units() == JsString::from("$utf16").units()
                    {
                        let units = items(&result[0].1)
                            .iter()
                            .map(|value| optional_number(value).expect("UTF16 numeric unit") as u16)
                            .collect();
                        return Ok(OrderedJs(JsValue::String(JsString::from_units(units))));
                    }
                    if result.len() == 1 && result[0].0.units() == JsString::from("$object").units()
                    {
                        let values = items(&result[0].1)
                            .into_iter()
                            .map(|pair| {
                                let pair = items(&pair);
                                (key_string(&pair[0]), pair[1].clone())
                            })
                            .collect();
                        return Ok(OrderedJs(JsValue::object(values)));
                    }
                    if result.len() == 1 && result[0].0.units() == JsString::from("$value").units()
                    {
                        return Ok(OrderedJs(match text(&result[0].1).as_str() {
                            "undefined" => JsValue::Undefined,
                            "NaN" => JsValue::Number(f64::NAN),
                            "Infinity" => JsValue::Number(f64::INFINITY),
                            "-Infinity" => JsValue::Number(f64::NEG_INFINITY),
                            "-0" => JsValue::Number(-0.0),
                            other => {
                                return Err(de::Error::custom(format!(
                                    "unsupported plain-data fixture marker {other}"
                                )));
                            }
                        }));
                    }
                    Ok(OrderedJs(JsValue::object(result)))
                }
            }
            deserializer.deserialize_any(OrderedVisitor)
        }
    }
    fn ordered(raw: Option<&RawValue>) -> Result<JsValue, serde_json::Error> {
        raw.map_or_else(
            || Ok(object(Vec::new())),
            |value| serde_json::from_str::<OrderedJs>(value.get()).map(|value| value.0),
        )
    }
    // The fixture key union is decoded only at map/$object key boundaries.
    // A {utf16:[...]} object in an ordinary VALUE position stays an object.
    fn key_string(value: &JsValue) -> JsString {
        if let JsValue::String(value) = value {
            return value.clone();
        }
        let fields = entries(value);
        assert!(
            fields.len() == 1 && fields[0].0 == "utf16",
            "fixture key must be a string or UTF16 key marker"
        );
        JsString::from_units(
            items(&fields[0].1)
                .iter()
                .map(|value| optional_number(value).expect("UTF16 numeric key unit") as u16)
                .collect(),
        )
    }
    fn unicode_pairs(value: &JsValue) -> Vec<(JsString, JsValue)> {
        items(value)
            .into_iter()
            .map(|pair| {
                let pair = items(&pair);
                (key_string(&pair[0]), pair[1].clone())
            })
            .collect()
    }
    fn pairs(value: &JsValue) -> Vec<(String, JsValue)> {
        unicode_pairs(value)
            .into_iter()
            .map(|(key, value)| (key.to_utf8().expect("fixture UTF8 map key"), value))
            .collect()
    }
    fn map_values(value: &JsValue) -> SharedMap<JsValue> {
        let mut result = OrderedMap::new();
        for (key, value) in pairs(value) {
            result.insert(key, value);
        }
        Rc::new(RefCell::new(result))
    }
    fn map_strings(value: &JsValue) -> SharedMap<JsString> {
        let mut result = OrderedMap::new();
        for (key, value) in pairs(value) {
            result.insert(key, js_string(&value));
        }
        Rc::new(RefCell::new(result))
    }
    fn map_user_strings(value: &JsValue) -> SharedMap<JsString, JsString> {
        let mut result = OrderedMap::new();
        for (key, value) in unicode_pairs(value) {
            result.insert(key, js_string(&value));
        }
        Rc::new(RefCell::new(result))
    }
    #[derive(Clone)]
    struct SyntheticEffect {
        path: Vec<String>,
        next: Rc<RefCell<u64>>,
        channel: String,
    }

    fn fresh_context(input: &JsValue) -> Context {
        let mut context = ExecutionContext {
            broadcaster_id: "123".into(),
            user_id: "456".into(),
            user_login: "caller".into(),
            user_display_name: "Caller".into(),
            ..ExecutionContext::default()
        };
        let input = deep_clone(input);
        for (key, value) in entries(&input) {
            match key.as_str() {
                "variables" => context.variables = map_values(&value),
                "arrays" => context.arrays = map_values(&value),
                "commandVariables" => context.command_variables = map_strings(&value),
                "userCommandVariables" => context.user_command_variables = map_user_strings(&value),
                "loopVars" => {
                    let vars = LoopVars::default();
                    for (key, value) in pairs(&value) {
                        vars.insert(key, js_string(&value));
                    }
                    context.loop_vars = Some(vars);
                }
                "broadcasterId" => context.broadcaster_id = text(&value),
                "userId" => context.user_id = text(&value),
                "userLogin" => context.user_login = text(&value),
                "userDisplayName" => context.user_display_name = text(&value),
                "userPlan" => context.user_plan = text(&value),
                "platform" => context.platform = text(&value),
                "scopeType" => context.scope_type = text(&value),
                "scopeName" => context.scope_name = text(&value),
                "commandName" => context.command_name = text(&value),
                "commandId" => context.command_id = text(&value),
                "userLevel" => {
                    context.user_level = optional_number(&value).expect("numeric user level")
                }
                "count" => context.count = optional_number(&value).expect("numeric count"),
                "countModified" => {
                    context.count_modified = match value {
                        JsValue::Boolean(value) => Some(value),
                        _ => None,
                    }
                }
                "enforceFunctionPermissions" => {
                    context.enforce_function_permissions = !matches!(value, JsValue::Boolean(false))
                }
                "argument" => {
                    context.argument = match value {
                        JsValue::Undefined => None,
                        _ => Some(js_string(&value)),
                    }
                }
                "authorization" => context.authorization = value,
                "eventData" => context.event_data = value,
                "eventsubData" => context.eventsub_data = value,
                "extraContext" => context.extra_context = value,
                "streamer" => context.streamer = value,
                "scopeAliases" => context.scope_aliases = Rc::new(RefCell::new(items(&value))),
                "commandResponses" => {
                    context.command_responses = Rc::new(RefCell::new(items(&value)))
                }
                "commandRefBudget" => {
                    context.command_ref_budget.borrow_mut().remaining =
                        optional_number(&field(&value, "remaining")).expect("numeric budget")
                }
                "visitedCommands" => {
                    context.visited_commands = Some(Rc::new(RefCell::new(
                        items(&value).iter().map(text).collect(),
                    )))
                }
                "commandRefDepth" => context.command_ref_depth = optional_number(&value),
                "loopDepth" => context.loop_depth = optional_number(&value),
                "timerDepth" => context.timer_depth = optional_number(&value),
                "loopExit" => {
                    context.loop_exit = match text(&value).as_str() {
                        "break" => Some(LoopExit::Break),
                        "continue" => Some(LoopExit::Continue),
                        _ => None,
                    }
                }
                "effect" | "effectContext" => {}
                other => panic!("unhandled context fixture field {other}"),
            }
        }
        if matches!(field(&input, "effect"), JsValue::Boolean(true)) {
            context.effect_context = Some(EffectToken::from_host(SyntheticEffect {
                path: vec!["fixture-config".into()],
                next: Rc::new(RefCell::new(0)),
                channel: context.broadcaster_id.clone(),
            }));
        }
        context.into_context()
    }

    pub fn engine() -> Engine {
        configured_engine(false)
    }
    fn configured_engine(context_builtins: bool) -> Engine {
        let mut registry = if context_builtins {
            FunctionRegistry::with_context_builtins()
        } else {
            FunctionRegistry::default()
        };
        for name in [
            "fixture.echo",
            "fixture.value",
            "fixture.count",
            "fixture.write",
            "fixture.throw",
            "fixture.gated7",
            "fixture.gated8",
            "break",
            "continue",
            "fixture.effect",
        ] {
            if context_builtins && matches!(name, "break" | "continue") {
                continue;
            }
            let level = match name {
                "fixture.gated7" => Some(7.0),
                "fixture.gated8" => Some(8.0),
                _ => None,
            };
            registry.register(
                name,
                level.map(|level| FunctionMetadata {
                    min_user_level: Some(level),
                    ..FunctionMetadata::default()
                }),
            );
        }
        Engine::new(registry)
    }

    fn scalar_values(context: &Context) -> Vec<(&'static str, JsValue)> {
        let ctx = context.borrow();
        vec![
            ("broadcasterId", string(&ctx.broadcaster_id)),
            ("userId", string(&ctx.user_id)),
            ("userLogin", string(&ctx.user_login)),
            ("userDisplayName", string(&ctx.user_display_name)),
            ("userPlan", string(&ctx.user_plan)),
            ("userLevel", JsValue::Number(ctx.user_level)),
            (
                "enforceFunctionPermissions",
                JsValue::Boolean(ctx.enforce_function_permissions),
            ),
            ("authorization", ctx.authorization.clone()),
            (
                "argument",
                ctx.argument
                    .clone()
                    .map(JsValue::String)
                    .unwrap_or(JsValue::Undefined),
            ),
            ("count", JsValue::Number(ctx.count)),
            (
                "countModified",
                ctx.count_modified
                    .map(JsValue::Boolean)
                    .unwrap_or(JsValue::Undefined),
            ),
            ("eventData", ctx.event_data.clone()),
            ("eventsubData", ctx.eventsub_data.clone()),
            ("extraContext", ctx.extra_context.clone()),
            ("streamer", ctx.streamer.clone()),
            ("platform", string(&ctx.platform)),
            ("scopeType", string(&ctx.scope_type)),
            ("scopeName", string(&ctx.scope_name)),
            ("scopeAliases", JsValue::Array(ctx.scope_aliases.clone())),
            ("commandName", string(&ctx.command_name)),
            ("commandId", string(&ctx.command_id)),
            (
                "loopExit",
                ctx.loop_exit
                    .as_ref()
                    .map(|value| {
                        string(match value {
                            LoopExit::Break => "break",
                            LoopExit::Continue => "continue",
                        })
                    })
                    .unwrap_or(JsValue::Undefined),
            ),
            (
                "loopDepth",
                ctx.loop_depth
                    .map(JsValue::Number)
                    .unwrap_or(JsValue::Undefined),
            ),
            (
                "timerDepth",
                ctx.timer_depth
                    .map(JsValue::Number)
                    .unwrap_or(JsValue::Undefined),
            ),
            (
                "commandRefDepth",
                ctx.command_ref_depth
                    .map(JsValue::Number)
                    .unwrap_or(JsValue::Undefined),
            ),
        ]
    }

    pub struct FakeHost {
        pub events: Vec<JsValue>,
        cache: Vec<(String, JsValue)>,
        db: Vec<(String, JsValue)>,
        db_user: Vec<(JsString, JsValue)>,
        seed: u32,
        scheduler_throws: bool,
        user_login: String,
        return_value: JsValue,
        throw_on: Option<String>,
        timers: Vec<TimerCapture>,
        pub suspend_once: bool,
    }
    struct TimerCapture {
        seconds: f64,
        body: JsValue,
        snapshot: JsValue,
        identity: JsValue,
    }
    fn get<K: PartialEq>(values: &[(K, JsValue)], key: &K) -> Option<JsValue> {
        values
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
    }
    fn put<K: PartialEq>(values: &mut Vec<(K, JsValue)>, key: K, value: JsValue) {
        if let Some((_, slot)) = values.iter_mut().find(|(name, _)| name == &key) {
            *slot = value;
        } else {
            values.push((key, value));
        }
    }
    fn remove<K: PartialEq>(values: &mut Vec<(K, JsValue)>, key: &K) -> bool {
        if let Some(index) = values.iter().position(|(name, _)| name == key) {
            values.remove(index);
            true
        } else {
            false
        }
    }
    fn encoded_map(values: &[(String, JsValue)]) -> Value {
        Value::Array(
            values
                .iter()
                .map(|(key, value)| json!([key, value.to_typed_json()]))
                .collect(),
        )
    }
    fn encoded_key(key: &JsString) -> Value {
        match key.to_utf8() {
            Ok(value) => Value::String(value),
            Err(_) => json!({"utf16": key.units()}),
        }
    }
    fn encoded_unicode_map(values: &[(JsString, JsValue)]) -> Value {
        Value::Array(
            values
                .iter()
                .map(|(key, value)| json!([encoded_key(key), value.to_typed_json()]))
                .collect(),
        )
    }
    impl FakeHost {
        fn fresh(input: &JsValue, context: &Context) -> Self {
            let input = deep_clone(input);
            Self {
                events: Vec::new(),
                timers: Vec::new(),
                return_value: field(&input, "returnValue"),
                throw_on: match field(&input, "throwOn") {
                    JsValue::String(value) => Some(value.to_utf8().expect("fixture event name")),
                    _ => None,
                },
                cache: pairs(&field(&input, "cache")),
                db: pairs(&field(&input, "db")),
                db_user: unicode_pairs(&field(&input, "dbUser")),
                seed: optional_number(&field(&input, "randomSeed")).unwrap_or(1.0) as u32,
                scheduler_throws: matches!(
                    field(&input, "schedulerThrows"),
                    JsValue::Boolean(true)
                ),
                user_login: context.borrow().user_login.clone(),
                suspend_once: false,
            }
        }
        fn db_user_key(&self, name: &str, target: Option<JsString>) -> JsString {
            let mut key = JsString::from(format!("{name}:"));
            key.push(&target.unwrap_or_else(|| JsString::from(self.user_login.as_str())));
            key
        }
        fn event(&mut self, name: &str, args: Vec<JsValue>) -> Result<(), EvalError> {
            let mut values = vec![string(name)];
            values.extend(args);
            self.events.push(array(values));
            if self.throw_on.as_deref() == Some(name) {
                return Err(EvalError::new(format!("fixture host failure: {name}")));
            }
            Ok(())
        }
        fn effect_action(&mut self, context: &Context) -> Result<JsValue, EvalError> {
            let ctx = context.borrow();
            let effect = ctx
                .effect_context
                .as_ref()
                .and_then(|token| token.downcast_ref::<SyntheticEffect>());
            let value = if let Some(effect) = effect
                .filter(|effect| effect.channel == ctx.broadcaster_id && !effect.path.is_empty())
            {
                let next = *effect.next.borrow();
                *effect.next.borrow_mut() += 1;
                // This JSON serialization is the handler's actual semantics,
                // matching effects.ts, never benchmark output normalization.
                let input =
                    serde_json::to_string(&json!([effect.path, next])).expect("effect data");
                self.event(
                    "deterministic fake host event: effect hash",
                    vec![string("sha256"), string(&input), string("hex")],
                )?;
                object(vec![
                    (
                        "origin",
                        object(vec![
                            ("id", string("fixture-event")),
                            ("kind", string("chat-command")),
                            ("occurredAt", string("2026-01-01T00:00:00.000Z")),
                        ]),
                    ),
                    (
                        "actor",
                        object(vec![
                            ("userId", string("456")),
                            ("displayName", string("Caller")),
                        ]),
                    ),
                    ("actionKey", string(&format!("pet:v1:fixture-hash:{input}"))),
                ])
            } else {
                JsValue::Undefined
            };
            self.event(
                "deterministic fake host event: effect action",
                vec![value.clone()],
            )?;
            Ok(value)
        }
        fn perform(
            &mut self,
            request: HostRequest,
            context: Context,
        ) -> Result<JsValue, EvalError> {
            use HostRequest::*;
            match request {
                Function { name, args } => {
                    self.event("handler", vec![string(&name), array(args.clone())])?;
                    match name.as_str() {
                        "fixture.echo" => Ok(string(
                            &args
                                .iter()
                                .map(|value| text(&nullish_string_value(value)))
                                .collect::<Vec<_>>()
                                .join("|"),
                        )),
                        "fixture.value" => Ok(args
                            .first()
                            .cloned()
                            .unwrap_or_else(|| self.return_value.clone())),
                        "fixture.count" => {
                            let mut ctx = context.borrow_mut();
                            ctx.count += 1.0;
                            ctx.count_modified = Some(true);
                            Ok(JsValue::String(js_string(&JsValue::Number(ctx.count))))
                        }
                        "fixture.write" => {
                            let key = text(args.first().unwrap_or(&JsValue::Undefined));
                            let value = args.get(1).cloned().unwrap_or(JsValue::Undefined);
                            context
                                .borrow()
                                .variables
                                .borrow_mut()
                                .insert(key, value.clone());
                            Ok(value)
                        }
                        "fixture.throw" => Err(EvalError {
                            name: "TypeError".into(),
                            message: "fixture handler throw".into(),
                        }),
                        "fixture.gated7" => Ok(string("ran-7")),
                        "fixture.gated8" => Ok(string("ran-8")),
                        "break" | "continue" => {
                            let mut ctx = context.borrow_mut();
                            if ctx.loop_depth.unwrap_or(0.0) > 0.0 {
                                ctx.loop_exit = Some(if name == "break" {
                                    LoopExit::Break
                                } else {
                                    LoopExit::Continue
                                });
                            }
                            Ok(string(""))
                        }
                        "fixture.effect" => self.effect_action(&context),
                        _ => Err(EvalError::new(format!("unregistered fake handler {name}"))),
                    }
                }
                CacheGet { key } => {
                    self.event("cache.get", vec![JsValue::String(key.clone())])?;
                    Ok(get(&self.cache, &key.to_utf8()?).unwrap_or(JsValue::Null))
                }
                CacheExists { key } => {
                    self.event("cache.exists", vec![JsValue::String(key.clone())])?;
                    Ok(JsValue::Number(
                        if get(&self.cache, &key.to_utf8()?).is_some() {
                            1.0
                        } else {
                            0.0
                        },
                    ))
                }
                CacheSet { key, value } => {
                    self.event(
                        "cache.set",
                        vec![JsValue::String(key.clone()), JsValue::String(value.clone())],
                    )?;
                    put(&mut self.cache, key.to_utf8()?, JsValue::String(value));
                    Ok(string("OK"))
                }
                CacheExpire { key, seconds } => {
                    self.event(
                        "cache.expire",
                        vec![
                            JsValue::String(key.clone()),
                            JsValue::Number(seconds as f64),
                        ],
                    )?;
                    Ok(JsValue::Number(
                        if get(&self.cache, &key.to_utf8()?).is_some() {
                            1.0
                        } else {
                            0.0
                        },
                    ))
                }
                CacheDelete { key } => {
                    self.event("cache.del", vec![JsValue::String(key.clone())])?;
                    Ok(JsValue::Number(
                        if remove(&mut self.cache, &key.to_utf8()?) {
                            1.0
                        } else {
                            0.0
                        },
                    ))
                }
                LoadChannelVariable { name } => {
                    self.event("db.load", vec![string(&name)])?;
                    Ok(get(&self.db, &name).unwrap_or_else(|| string("")))
                }
                SaveChannelVariable { name, value } => {
                    self.event(
                        "db.save",
                        vec![string(&name), JsValue::String(value.clone())],
                    )?;
                    put(&mut self.db, name, JsValue::String(value));
                    Ok(JsValue::Undefined)
                }
                DeleteChannelVariable { name } => {
                    self.event("db.delete", vec![string(&name)])?;
                    remove(&mut self.db, &name);
                    Ok(JsValue::Undefined)
                }
                LoadUserVariable {
                    name,
                    target_user_login,
                } => {
                    let target = target_user_login
                        .clone()
                        .map(JsValue::String)
                        .unwrap_or(JsValue::Undefined);
                    self.event("dbUser.load", vec![string(&name), target])?;
                    let key = self.db_user_key(&name, target_user_login);
                    Ok(get(&self.db_user, &key).unwrap_or_else(|| string("")))
                }
                SaveUserVariable {
                    name,
                    value,
                    target_user_login,
                } => {
                    let target = target_user_login
                        .clone()
                        .map(JsValue::String)
                        .unwrap_or(JsValue::Undefined);
                    self.event(
                        "dbUser.save",
                        vec![string(&name), JsValue::String(value.clone()), target],
                    )?;
                    let key = self.db_user_key(&name, target_user_login);
                    put(&mut self.db_user, key, JsValue::String(value));
                    Ok(JsValue::Undefined)
                }
                DeleteUserVariable {
                    name,
                    target_user_login,
                } => {
                    let target = target_user_login
                        .clone()
                        .map(JsValue::String)
                        .unwrap_or(JsValue::Undefined);
                    self.event("dbUser.delete", vec![string(&name), target])?;
                    let key = self.db_user_key(&name, target_user_login);
                    remove(&mut self.db_user, &key);
                    Ok(JsValue::Undefined)
                }
                SaveResponses => {
                    self.event(
                        "responses.save",
                        vec![array(context.borrow().command_responses.borrow().clone())],
                    )?;
                    Ok(JsValue::Undefined)
                }
                ScheduleTimer { seconds, body } => {
                    let snapshot = snapshot_timer_context(&context);
                    let body = JsValue::from_json(&body.to_value());
                    let identity = object(vec![
                        ("budgetCopied", JsValue::Boolean(true)),
                        ("responsesShared", JsValue::Boolean(true)),
                        ("variableEntriesCopied", JsValue::Boolean(true)),
                        (
                            "effectStripped",
                            JsValue::Boolean(context.borrow().effect_context.is_none()),
                        ),
                        ("callbacksOmitted", JsValue::Boolean(true)),
                        ("commandVariablesOmitted", JsValue::Boolean(true)),
                    ]);
                    self.timers.push(TimerCapture {
                        seconds,
                        body: body.clone(),
                        snapshot: snapshot.clone(),
                        identity: identity.clone(),
                    });
                    self.event(
                        "timer.schedule",
                        vec![JsValue::Number(seconds), body, snapshot, identity],
                    )?;
                    if self.scheduler_throws {
                        Err(EvalError::new("fixture scheduler failure"))
                    } else {
                        Ok(JsValue::Undefined)
                    }
                }
            }
        }
    }
    fn nullish_string_value(value: &JsValue) -> JsValue {
        if matches!(value, JsValue::Null | JsValue::Undefined) {
            string("")
        } else {
            value.clone()
        }
    }
    impl Host for FakeHost {
        fn execute<'a>(&'a mut self, request: HostRequest, context: Context) -> HostFuture<'a> {
            Box::pin(async move {
                if self.suspend_once {
                    let mut pending = true;
                    std::future::poll_fn(|ctx| {
                        if pending {
                            pending = false;
                            ctx.waker().wake_by_ref();
                            std::task::Poll::Pending
                        } else {
                            std::task::Poll::Ready(())
                        }
                    })
                    .await;
                }
                self.perform(request, context)
            })
        }
        fn random(&mut self) -> Result<f64, EvalError> {
            self.seed = self
                .seed
                .wrapping_mul(1_664_525)
                .wrapping_add(1_013_904_223);
            let value = f64::from(self.seed) / 4_294_967_296.0;
            self.event("random", vec![JsValue::Number(value)])?;
            Ok(value)
        }
        fn fork_effect(&mut self, effect: &EffectToken) -> Option<EffectToken> {
            let effect = effect.downcast_ref::<SyntheticEffect>()?;
            let mut path = effect.path.clone();
            let next = *effect.next.borrow();
            *effect.next.borrow_mut() += 1;
            path.push(format!("reference:{next}"));
            Some(EffectToken::from_host(SyntheticEffect {
                path,
                next: Rc::new(RefCell::new(0)),
                channel: effect.channel.clone(),
            }))
        }
    }

    #[derive(Deserialize)]
    struct Input {
        #[serde(default = "default_operation")]
        operation: String,
        #[serde(default, rename = "contextBuiltins")]
        context_builtins: bool,
        ast: Option<Box<RawValue>>,
        text: Option<String>,
        context: Option<Box<RawValue>>,
        host: Option<Box<RawValue>>,
    }
    fn default_operation() -> String {
        "evaluate".into()
    }
    enum Prepared {
        Ast(AstNode),
        Program(CompiledProgram),
        Template(CompiledTemplate),
        Snapshot,
        ParseError(String),
    }
    pub struct PreparedCase {
        engine: Engine,
        prepared: Prepared,
        context: JsValue,
        host: JsValue,
        baseline: Rc<Vec<(&'static str, Value)>>,
    }
    pub struct RawObservation {
        pub result: Result<EvalResult, EvalError>,
        pub initial: Context,
        pub host: FakeHost,
        baseline: Rc<Vec<(&'static str, Value)>>,
        parse_error: Option<String>,
    }
    impl PreparedCase {
        pub fn new(raw: &str) -> Result<Self, Box<dyn std::error::Error>> {
            let input: Input = serde_json::from_str(raw)?;
            let engine = configured_engine(input.context_builtins);
            let context = ordered(input.context.as_deref())?;
            let host = ordered(input.host.as_deref())?;
            let baseline = Rc::new(
                scalar_values(&fresh_context(&context))
                    .into_iter()
                    .map(|(key, value)| (key, value.to_typed_json()))
                    .collect(),
            );
            let prepared = match input.operation.as_str() {
                "evaluate" | "timer" => Prepared::Ast(serde_json::from_str(
                    input.ast.as_ref().ok_or("missing AST")?.get(),
                )?),
                "parseEvaluate" => {
                    match engine.compile_program(input.text.as_deref().ok_or("missing text")?) {
                        Ok(value) => Prepared::Program(value),
                        Err(error) => Prepared::ParseError(error.message),
                    }
                }
                "render" | "preparedRender" => Prepared::Template(
                    engine.compile_template(input.text.as_deref().ok_or("missing text")?)?,
                ),
                "snapshot" => Prepared::Snapshot,
                other => return Err(format!("unsupported fixture operation {other}").into()),
            };
            Ok(Self {
                engine,
                prepared,
                context,
                host,
                baseline,
            })
        }
        pub fn run(&self, suspend: bool) -> RawObservation {
            let initial = fresh_context(&self.context);
            let mut host = FakeHost::fresh(&self.host, &initial);
            host.suspend_once = suspend;
            let mut parse_error = None;
            let result = match &self.prepared {
                Prepared::Ast(ast) => {
                    block_on(self.engine.evaluate(ast, initial.clone(), &mut host))
                }
                Prepared::Program(program) => block_on(self.engine.evaluate_program(
                    program,
                    initial.clone(),
                    &mut host,
                )),
                Prepared::Template(template) => {
                    block_on(self.engine.render(template, initial.clone(), &mut host)).map(
                        |result| EvalResult {
                            value: JsValue::String(result.text),
                            context: result.context,
                            stats: result.stats,
                        },
                    )
                }
                Prepared::Snapshot => Ok(EvalResult {
                    value: snapshot_timer_context(&initial),
                    context: initial.clone(),
                    stats: EvalStats::default(),
                }),
                Prepared::ParseError(error) => {
                    parse_error = Some(error.clone());
                    Ok(EvalResult {
                        value: JsValue::Undefined,
                        context: initial.clone(),
                        stats: EvalStats::default(),
                    })
                }
            };
            RawObservation {
                result,
                initial,
                host,
                baseline: self.baseline.clone(),
                parse_error,
            }
        }
        pub fn engine(&self) -> &Engine {
            &self.engine
        }
    }
    fn observe_context(context: &Context, raw: &RawObservation) -> Value {
        let scalar_deltas: Vec<_> = scalar_values(context)
            .into_iter()
            .filter_map(|(key, value)| {
                let value = value.to_typed_json();
                (raw.baseline
                    .iter()
                    .find(|(name, _)| *name == key)
                    .map(|(_, baseline)| baseline)
                    != Some(&value))
                .then(|| json!([key, value]))
            })
            .collect();
        let ctx = context.borrow();
        let initial = raw.initial.borrow();
        let values_map = |map: &SharedMap<JsValue>| -> Value {
            Value::Array(
                map.borrow()
                    .iter()
                    .map(|(key, value)| json!([key, value.to_typed_json()]))
                    .collect(),
            )
        };
        let strings_map = |map: &SharedMap<JsString>| -> Value {
            Value::Array(
                map.borrow()
                    .iter()
                    .map(|(key, value)| {
                        json!([key, JsValue::String(value.clone()).to_typed_json()])
                    })
                    .collect(),
            )
        };
        let user_strings_map = |map: &SharedMap<JsString, JsString>| -> Value {
            Value::Array(
                map.borrow()
                    .iter()
                    .map(|(key, value)| {
                        json!([
                            encoded_key(key),
                            JsValue::String(value.clone()).to_typed_json()
                        ])
                    })
                    .collect(),
            )
        };
        let loop_vars = ctx
            .loop_vars
            .as_ref()
            .map(|vars| vars.iter())
            .unwrap_or_default();
        let refs = ctx.command_references.borrow();
        let references: Vec<_> = refs
            .iter()
            .map(|reference| {
                object(vec![
                    (
                        "effectContext",
                        if reference.effect_context.is_some() {
                            object(vec![("authority", string("isolated-source-synthetic"))])
                        } else {
                            JsValue::Undefined
                        },
                    ),
                    ("channelID", string(&reference.channel_id)),
                    ("commandName", string(&reference.command_name)),
                    ("argument", JsValue::String(reference.argument.clone())),
                    ("eventData", reference.event_data.clone()),
                    ("authorization", reference.authorization.clone()),
                    ("state", reference.state.to_value()),
                ])
            })
            .collect();
        json!({"scalarDeltas":scalar_deltas,"maps":{
            "variables":values_map(&ctx.variables),"arrays":values_map(&ctx.arrays),"commandVariables":strings_map(&ctx.command_variables),"userCommandVariables":user_strings_map(&ctx.user_command_variables),
            "loopVars":loop_vars.iter().map(|(key,value)|json!([key,JsValue::String(value.clone()).to_typed_json()])).collect::<Vec<_>>()},
            "commandResponses":array(ctx.command_responses.borrow().clone()).to_typed_json(),"commandReferences":array(references).to_typed_json(),
            "budget":object(vec![("remaining",JsValue::Number(ctx.command_ref_budget.borrow().remaining))]).to_typed_json(),
            "visitedCommands":array(ctx.visited_commands.as_ref().map(|values|values.borrow().iter().map(|value|string(value)).collect()).unwrap_or_default()).to_typed_json(),
            "identity":{"sameLoopVars":match (&ctx.loop_vars,&initial.loop_vars){(Some(a),Some(b))=>a.same_identity(b),(None,None)=>true,_=>false},"sameContext":Rc::ptr_eq(context,&raw.initial),"sameVariables":Rc::ptr_eq(&ctx.variables,&initial.variables),"sameBudget":Rc::ptr_eq(&ctx.command_ref_budget,&initial.command_ref_budget),
                "referenceBudgetsShared":refs.iter().map(|reference|Rc::ptr_eq(&reference.state.command_ref_budget,&ctx.command_ref_budget)).collect::<Vec<_>>()}})
    }
    pub fn normalize(raw: &RawObservation) -> Value {
        let context = raw
            .result
            .as_ref()
            .map(|result| result.context.clone())
            .unwrap_or_else(|_| raw.initial.clone());
        let mut result = match &raw.result {
            Err(error) => {
                json!({"outcome":"thrown","error":{"name":error.name,"message":error.message}})
            }
            Ok(value) => {
                if let Some(error) = &raw.parse_error {
                    json!({"outcome":"parse-error","error":error})
                } else {
                    json!({"outcome":"returned","value":value.value.to_typed_json()})
                }
            }
        };
        result["context"] = observe_context(&context, raw);
        result["initialContext"] = observe_context(&raw.initial, raw);
        let timers: Vec<_> = raw
            .host
            .timers
            .iter()
            .map(|timer| {
                object(vec![
                    ("seconds", JsValue::Number(timer.seconds)),
                    ("body", timer.body.clone()),
                    ("snapshot", timer.snapshot.clone()),
                    ("identity", timer.identity.clone()),
                    (
                        "after",
                        object(vec![
                            (
                                "snapshotBudget",
                                field(&field(&timer.snapshot, "commandRefBudget"), "remaining"),
                            ),
                            (
                                "callerBudget",
                                JsValue::Number(
                                    context.borrow().command_ref_budget.borrow().remaining,
                                ),
                            ),
                            ("snapshotVariables", field(&timer.snapshot, "variables")),
                            (
                                "snapshotResponses",
                                field(&timer.snapshot, "commandResponses"),
                            ),
                        ]),
                    ),
                ])
                .to_typed_json()
            })
            .collect();
        result["host"] = json!({"events":raw.host.events.iter().map(JsValue::to_typed_json).collect::<Vec<_>>(),"cache":encoded_map(&raw.host.cache),"db":encoded_map(&raw.host.db),"dbUser":encoded_unicode_map(&raw.host.db_user),"timers":timers});
        project(&mut result);
        result
    }
    // Only persisted timer AST OBJECT FIELD order is structural. Child arrays
    // retain order. Ordinary data/JsValue objects are never canonicalized.
    fn canonical_ast(value: &mut Value) {
        if value["type"] == "object" {
            if let Some(entries) = value["value"].as_array_mut() {
                entries.sort_by(|a, b| a[0].as_str().cmp(&b[0].as_str()));
                for entry in entries {
                    canonical_ast(&mut entry[1]);
                }
            }
        } else if value["type"] == "array"
            && let Some(items) = value["value"].as_array_mut()
        {
            for item in items {
                canonical_ast(item);
            }
        }
    }
    fn typed_field_mut<'a>(value: &'a mut Value, key: &str) -> Option<&'a mut Value> {
        value
            .get_mut("value")?
            .as_array_mut()?
            .iter_mut()
            .find(|entry| entry[0] == key)
            .map(|entry| &mut entry[1])
    }
    pub fn canonical_numbers(value: &mut Value) {
        match value {
            Value::Number(number) => {
                let n = number.as_f64().expect("JSON numeric data");
                if n.fract() == 0.0 {
                    if n >= i64::MIN as f64 && n < 9_223_372_036_854_775_808.0 {
                        *value = json!(n as i64);
                    } else if (0.0..18_446_744_073_709_551_616.0).contains(&n) {
                        *value = json!(n as u64);
                    }
                }
            }
            Value::Array(items) => {
                for item in items {
                    canonical_numbers(item);
                }
            }
            Value::Object(object) => {
                for item in object.values_mut() {
                    canonical_numbers(item);
                }
            }
            _ => {}
        }
    }
    pub fn project(value: &mut Value) {
        canonical_numbers(value);
        if let Some(events) = value["host"]["events"].as_array_mut() {
            events.retain(|event| {
                let name = event["value"][0]["value"].as_str();
                name != Some("cache.client")
                    && !(name == Some("console.error")
                        && event["value"][1]["value"] == "AST timer scheduling failed")
            });
            for event in events {
                if event["value"][0]["value"] == "timer.schedule" {
                    canonical_ast(&mut event["value"][2]);
                }
            }
        }
        if let Some(timers) = value["host"]["timers"].as_array_mut() {
            for timer in timers {
                if let Some(body) = typed_field_mut(timer, "body") {
                    canonical_ast(body);
                }
            }
        }
    }
}

#[cfg(feature = "ast-evaluator")]
mod benchmark {
    use super::{
        adapter::{PreparedCase, normalize, project},
        support::{fingerprint, sha256_hex},
    };
    use serde::Deserialize;
    use serde_json::{Value, json, value::RawValue};
    use std::{
        error::Error,
        hint::black_box,
        io::Read,
        time::{Duration, Instant},
    };
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Requests {
        version: u32,
        iterations: usize,
        warmup: usize,
        batches: usize,
        profile: String,
        fingerprint_encoding: String,
        #[serde(default)]
        iteration_reason: Option<String>,
        sources: Value,
        corpus_sha256_hex: String,
        manifest_sha256_hex: String,
        typescript_version: String,
        fixtures: Vec<Fixture>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Fixture {
        name: String,
        operation: String,
        description: String,
        input: Box<RawValue>,
        preparation: Value,
        expected: Option<Value>,
        expected_fingerprint_fnv1a_utf8: Option<String>,
        excluded_reason: Option<String>,
    }
    fn median(values: &[f64]) -> f64 {
        let mut sorted = values.to_vec();
        sorted.sort_by(f64::total_cmp);
        let mid = sorted.len() / 2;
        if sorted.len() % 2 == 1 {
            sorted[mid]
        } else {
            (sorted[mid - 1] + sorted[mid]) / 2.0
        }
    }
    pub fn run() -> Result<(), Box<dyn Error>> {
        if cfg!(debug_assertions) {
            return Err("benchmark requires --release".into());
        }
        let mut args = std::env::args().skip(1);
        let mut path = None;
        let mut runtime_version = None;
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--requests" => path = Some(args.next().ok_or("missing requests path")?),
                "--runtime-version" => {
                    runtime_version = Some(args.next().ok_or("missing compiler version")?)
                }
                _ => return Err(format!("unknown argument {arg}").into()),
            }
        }
        let runtime_version = runtime_version
            .ok_or("supply --runtime-version with the lead's exact rustc --version record")?;
        let mut bytes = Vec::new();
        std::fs::File::open(path.ok_or("--requests required")?)?
            .take(4_000_001)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 4_000_000 {
            return Err("request exceeds 4MB".into());
        }
        let requests: Requests = serde_json::from_slice(&bytes)?;
        if requests.version != 1
            || requests.profile != "typescript_compatible"
            || requests.fingerprint_encoding != "json-tree-fnv1a-utf8-f64be-v1"
            || !(1..=100_000).contains(&requests.iterations)
            || requests.warmup > 1000
            || !(1..=20).contains(&requests.batches)
            || requests.fixtures.is_empty()
            || requests.fixtures.len() > 64
        {
            return Err("invalid request bounds/profile".into());
        }
        if requests.iterations != 50
            && requests
                .iteration_reason
                .as_ref()
                .is_none_or(|value| value.is_empty())
        {
            return Err("nonstandard iteration count requires a reason".into());
        }
        let corpus = include_bytes!("../tests/fixtures/ast_evaluator_cases.json");
        if sha256_hex(corpus) != requests.corpus_sha256_hex {
            return Err("request/candidate corpus byte SHA256 differs".into());
        }
        let manifest: Value = serde_json::from_slice(corpus)?;
        if manifest["manifestHash"] != requests.manifest_sha256_hex
            || manifest["sourceHashes"] != requests.sources
        {
            return Err("request/candidate source or manifest identity differs".into());
        }
        let started = Instant::now();
        let mut measurements = Vec::new();
        let mut names = std::collections::BTreeSet::new();
        for fixture in &requests.fixtures {
            if !names.insert(&fixture.name) {
                return Err("duplicate fixture name".into());
            }
            if let Some(reason) = &fixture.excluded_reason {
                measurements.push(json!({"fixture":fixture.name,"excluded_reason":reason}));
                continue;
            }
            if !matches!(
                fixture.operation.as_str(),
                "evaluate" | "parseEvaluate" | "preparedRender"
            ) {
                return Err(format!("unsupported timed workload {}", fixture.name).into());
            }
            let prepared = PreparedCase::new(fixture.input.get())?;
            let mut expected = fixture
                .expected
                .clone()
                .ok_or("missing expected source result")?;
            project(&mut expected);
            let preflight = normalize(&prepared.run(false));
            if preflight != expected {
                return Err(format!(
                    "preflight {} expected={expected} actual={preflight}",
                    fixture.name
                )
                .into());
            }
            let expected_fingerprint = fixture
                .expected_fingerprint_fnv1a_utf8
                .as_deref()
                .ok_or("missing fingerprint")?;
            if fingerprint(&preflight) != expected_fingerprint {
                return Err(format!("preflight fingerprint {}", fixture.name).into());
            }
            for _ in 0..requests.warmup {
                black_box(prepared.run(false));
                if started.elapsed() > Duration::from_secs(120) {
                    return Err("total exceeded 120 seconds".into());
                }
            }
            let mut durations = Vec::new();
            let mut exact = Vec::new();
            for batch in 0..requests.batches {
                let mut last = None;
                let begin = Instant::now();
                for _ in 0..requests.iterations {
                    last = Some(black_box(prepared.run(false)));
                    if begin.elapsed() > Duration::from_secs(5) {
                        return Err("batch exceeded five seconds".into());
                    }
                    if started.elapsed() > Duration::from_secs(120) {
                        return Err("total exceeded 120 seconds".into());
                    }
                }
                let elapsed = begin.elapsed();
                if elapsed > Duration::from_secs(5) {
                    return Err("batch exceeded five seconds".into());
                }
                durations.push(elapsed.as_nanos());
                let actual = normalize(&last.expect("at least one iteration"));
                if actual != expected {
                    return Err(format!(
                        "postflight {}, batch {batch}, expected={expected} actual={actual}",
                        fixture.name
                    )
                    .into());
                }
                let checksum = fingerprint(&actual);
                if checksum != expected_fingerprint {
                    return Err(
                        format!("postflight fingerprint {}, batch {batch}", fixture.name).into(),
                    );
                }
                exact.push(json!({"batch":batch,"matched":true,"fingerprint_fnv1a_utf8":checksum}));
                if started.elapsed() > Duration::from_secs(120) {
                    return Err("total exceeded 120 seconds".into());
                }
            }
            let per_op: Vec<_> = durations
                .iter()
                .map(|value| *value as f64 / requests.iterations as f64)
                .collect();
            measurements.push(json!({"fixture":fixture.name,"operation":fixture.operation,"description":fixture.description,
                "method":"Rust prepared AST/template evaluation, fresh context/fakehost/RNG per operation","preparation":fixture.preparation,
                "iterations":requests.iterations,"warmup":requests.warmup,"batches":requests.batches,"durations_ns":durations,"ns_per_op":per_op,
                "median_ns_per_op":median(&per_op),"fingerprint_fnv1a_utf8":expected_fingerprint,"exact_case_outcomes":exact}));
        }
        let binary = std::fs::read(std::env::current_exe()?)?;
        let runner_sha256_hex = sha256_hex(&binary);
        let request_sha256_hex = sha256_hex(&bytes);
        if started.elapsed() > Duration::from_secs(120) {
            return Err("total exceeded 120 seconds".into());
        }
        println!(
            "{}",
            json!({"version":1,"runtime":runtime_version,"build_profile":"release","profile":requests.profile,"fingerprint_encoding":requests.fingerprint_encoding,
            "request_sha256_hex":request_sha256_hex,"runner_sha256_hex":runner_sha256_hex,"corpus_sha256_hex":requests.corpus_sha256_hex,
            "manifest_sha256_hex":requests.manifest_sha256_hex,"sources":requests.sources,"typescript_version":requests.typescript_version,"measurements":measurements})
        );
        Ok(())
    }
}

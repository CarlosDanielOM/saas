use super::{
    Context, JsValue, LoopExit,
    context::OrderedMap,
    value::{js_string, js_truthy, number_string, parse_int},
};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionMetadata {
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub syntax: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub examples: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_user_level: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keywords: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias_of: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deprecated: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destructive: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surfaces: Option<Vec<String>>,
}
#[derive(Clone, Copy, Debug)]
pub(crate) enum DispatchKind {
    Host,
    Context,
    #[cfg(feature = "ast-pure-functions")]
    Pure(super::pure::PureFunction),
}
#[derive(Clone, Debug)]
pub struct RegisteredFunction {
    pub name: String,
    pub metadata: Option<FunctionMetadata>,
    pub(crate) dispatch: DispatchKind,
}
#[derive(Clone, Debug, Default)]
pub struct FunctionRegistry {
    entries: OrderedMap<RegisteredFunction>,
}
impl FunctionRegistry {
    pub fn register(&mut self, name: impl Into<String>, metadata: Option<FunctionMetadata>) {
        let name = name.into();
        let metadata =
            metadata.or_else(|| self.entries.get(&name).and_then(|e| e.metadata.clone()));
        self.entries.insert(
            name.clone(),
            RegisteredFunction {
                name,
                metadata,
                dispatch: DispatchKind::Host,
            },
        );
    }
    /// Installs only the 27 pure string, user, random and EventSub names.
    #[cfg(feature = "ast-pure-functions")]
    pub fn with_pure_builtins() -> Self {
        let mut registry = Self::default();
        registry.register_pure_builtins();
        registry
    }
    /// Adds the pure families to this registry, retaining unrelated entries.
    #[cfg(feature = "ast-pure-functions")]
    pub fn register_pure_builtins(&mut self) {
        for (name, function, metadata) in super::pure::definitions() {
            self.entries.insert(
                name.into(),
                RegisteredFunction {
                    name: name.into(),
                    metadata: Some(metadata),
                    dispatch: DispatchKind::Pure(function),
                },
            );
        }
    }
    pub fn metadata(&self, name: &str) -> Option<&FunctionMetadata> {
        self.entries.get(name).and_then(|e| e.metadata.as_ref())
    }
    pub fn entries(&self) -> impl Iterator<Item = &RegisteredFunction> {
        self.entries.iter().map(|(_, v)| v)
    }
    pub(crate) fn get(&self, name: &str) -> Option<&RegisteredFunction> {
        self.entries.get(name)
    }
    /// Explicit opt-in: only count, scount, bits, break and continue. No random,
    /// delay, Twitch, string, eventsub or user family is implicitly installed.
    pub fn with_context_builtins() -> Self {
        let mut r = Self::default();
        for (name, category, description, syntax, examples, keywords) in [
            (
                "count",
                "counters",
                "Persistent per-command counter: adds the increment to the stored count and returns the new value.",
                "count [increment]",
                vec!["count", "count 5", "count +3"],
                vec![
                    "counter",
                    "contador",
                    "increment",
                    "times used",
                    "veces usado",
                ],
            ),
            (
                "scount",
                "counters",
                "Simple counter: increments the per-command count by 1 and returns the new value.",
                "scount",
                vec!["scount"],
                vec!["counter", "contador", "increment by one"],
            ),
            (
                "bits",
                "counters",
                "Returns the bits amount of the current cheer event context (0 outside cheer events).",
                "bits",
                vec!["bits"],
                vec!["bits", "cheer", "cheer amount"],
            ),
            (
                "break",
                "flow",
                "Exits the current loop immediately.",
                "break",
                vec!["break"],
                vec!["break", "exit loop", "salir del bucle"],
            ),
            (
                "continue",
                "flow",
                "Skips the rest of the current loop iteration and continues with the next one.",
                "continue",
                vec!["continue"],
                vec!["continue", "skip iteration", "continuar bucle"],
            ),
        ] {
            r.entries.insert(
                name.into(),
                RegisteredFunction {
                    name: name.into(),
                    dispatch: DispatchKind::Context,
                    metadata: Some(FunctionMetadata {
                        description: description.into(),
                        syntax: syntax.into(),
                        category: category.into(),
                        examples: examples.into_iter().map(String::from).collect(),
                        keywords: Some(keywords.into_iter().map(String::from).collect()),
                        surfaces: Some(vec!["authoring".into()]),
                        ..Default::default()
                    }),
                },
            );
        }
        r
    }
}
pub(crate) fn builtin(name: &str, args: &[JsValue], context: &Context) -> JsValue {
    let mut c = context.borrow_mut();
    match name {
        "count" => {
            let v = args
                .first()
                .filter(|v| js_truthy(v))
                .cloned()
                .or_else(|| {
                    let argument = c.effective_argument();
                    js_truthy(&argument).then_some(argument)
                })
                .unwrap_or_else(|| JsValue::string("0"));
            // Preserve the existing count coercer contract. The raw override
            // changes fallback selection, not this builtin's infallible coercion.
            let mut s = js_string(&v);
            if s != super::JsString::from("0") {
                s = super::JsString::from_units(
                    s.units().iter().copied().filter(|c| *c != 43).collect(),
                );
            }
            let n = parse_int(&s);
            c.count += if n.is_nan() || n == 0.0 { 0.0 } else { n };
            c.count_modified = Some(true);
            JsValue::string(number_string(c.count))
        }
        "scount" => {
            c.count += 1.0;
            c.count_modified = Some(true);
            JsValue::string(number_string(c.count))
        }
        "bits" => {
            let v = c.extra_context.get("bits");
            if matches!(v, JsValue::Undefined) {
                JsValue::string("0")
            } else {
                JsValue::String(js_string(&v))
            }
        }
        "break" => {
            c.loop_exit = Some(LoopExit::Break);
            JsValue::string("")
        }
        "continue" => {
            c.loop_exit = Some(LoopExit::Continue);
            JsValue::string("")
        }
        _ => JsValue::Undefined,
    }
}

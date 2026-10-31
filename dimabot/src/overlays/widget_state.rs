//! Widget state selection, authorization and projection from `widget-state.ts`.
//! Only visible, valid state widgets are selected. Provider reads are shared per
//! channel and source within a read scope and remain coalesced while in flight.
//! Each source is dispatched concurrently, its projected result is staged before
//! publication, a denial clears the selected keys without a read, and any
//! failure is isolated to its source without leaking provider errors.

use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

use futures_util::future::join_all;
use tokio::sync::OnceCell;

use crate::utils::{
    js_string::JsString,
    lossless_json::{truthy, JsonValue},
};

use super::widget_contract::{
    get_widget_definition, valid_revision, valid_widget_module_config, WidgetDefinition,
    WidgetDelivery, WidgetPlacement, WidgetStateEntry, WidgetStateSnapshot, WidgetStates,
};

/// Widget information used for a state read.
#[derive(Clone, Debug, PartialEq)]
pub struct StateWidget {
    /// Lossless serialized widget fields.
    pub raw: Vec<(JsString, JsonValue)>,
}

impl StateWidget {
    /// Treat a saved widget object as state input.
    pub fn from_json(value: &JsonValue) -> Option<Self> {
        match value {
            JsonValue::Object(fields) => Some(Self { raw: fields.clone() }),
            _ => None,
        }
    }

    /// Read a widget field with JavaScript object semantics (last value wins).
    pub fn field(&self, name: &str) -> Option<&JsonValue> {
        self.raw
            .iter()
            .rev()
            .find(|(key, _)| key.as_str() == Some(name))
            .map(|(_, value)| value)
    }
}

/// Source and state keys selected by visible, valid widgets.
pub type WidgetStateSelection = BTreeMap<&'static str, BTreeSet<&'static str>>;

/// Complete widget instances selected for one source.
#[derive(Clone, Debug, PartialEq)]
pub struct WidgetSourceSelection {
    /// Required state keys.
    pub keys: BTreeSet<&'static str>,
    /// Every complete widget instance that selects this source, in widget order.
    pub widgets: Vec<StateWidget>,
}

/// Source selections used by the registry.
pub type WidgetSourceSelections = BTreeMap<&'static str, WidgetSourceSelection>;

/// Identify required sources and keys without contacting a provider.
pub fn select_widgets(widgets: &[StateWidget]) -> WidgetStateSelection {
    select_widgets_with(widgets, get_widget_definition)
}

/// Select widgets using a caller-supplied module definition lookup.
pub fn select_widgets_with(
    widgets: &[StateWidget],
    definition_for: impl Fn(&str) -> Option<&'static WidgetDefinition>,
) -> WidgetStateSelection {
    select_widget_sources_with(widgets, definition_for)
        .into_iter()
        .map(|(source, selection)| (source, selection.keys))
        .collect()
}

/// Select complete widget instances grouped by state source.
pub fn select_widget_sources(widgets: &[StateWidget]) -> WidgetSourceSelections {
    select_widget_sources_with(widgets, get_widget_definition)
}

/// Select complete widget instances using a caller-supplied definition lookup.
pub fn select_widget_sources_with(
    widgets: &[StateWidget],
    definition_for: impl Fn(&str) -> Option<&'static WidgetDefinition>,
) -> WidgetSourceSelections {
    let mut selected = WidgetSourceSelections::new();
    for widget in widgets {
        if !widget.field("visible").is_some_and(truthy) {
            continue;
        }
        if !valid_widget_module_config(&widget.raw, WidgetPlacement::Scene) {
            continue;
        }
        let Some(JsonValue::String(kind)) = widget.field("kind") else {
            continue;
        };
        let Some(kind) = kind.as_str() else {
            continue;
        };
        let Some(definition) = definition_for(kind) else {
            continue;
        };
        if definition.delivery != WidgetDelivery::State {
            continue;
        }
        let Some(binding) = definition.state else {
            continue;
        };
        let entry = selected
            .entry(binding.source)
            .or_insert_with(|| WidgetSourceSelection {
                keys: BTreeSet::new(),
                widgets: Vec::new(),
            });
        entry.keys.insert(binding.state_key);
        entry.widgets.push(widget.clone());
    }
    selected
}

/// Project only requested keys from one successful source result.
pub fn project_states(keys: &BTreeSet<&str>, source: &WidgetStates) -> WidgetStates {
    keys.iter()
        .map(|key| {
            (
                (*key).to_owned(),
                source
                    .get(*key)
                    .cloned()
                    .unwrap_or_else(WidgetStateEntry::cleared),
            )
        })
        .collect()
}

/// An explicit access denial clears each selected key, without reading the
/// provider.
pub fn denied_states(keys: &BTreeSet<&str>) -> WidgetStates {
    project_states(keys, &WidgetStates::new())
}

fn projected_is_valid(keys: &BTreeSet<&str>, states: &WidgetStates) -> bool {
    keys.iter().all(|key| {
        states
            .get(*key)
            .is_none_or(|entry| valid_revision(entry.revision))
    })
}

type SharedRead = Arc<OnceCell<Result<WidgetStates, String>>>;

/// Private marker for an unavailable source; the provider error is never
/// exposed to clients.
struct SourceFailure;

/// Future used by a state source; provider failures are isolated by the registry.
pub type StateFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

/// A public aggregate provider. Authorization runs before its shared read.
/// `now_ms` is the polling cycle time supplied by the caller instead of an
/// internal `Date.now()` read.
pub trait WidgetStateSource: Send + Sync {
    /// Stable source identifier.
    fn source(&self) -> &str;

    /// Decide whether these selected widgets may read this source.
    fn authorize<'a>(
        &'a self,
        _channel: &'a str,
        _widgets: &'a [StateWidget],
    ) -> StateFuture<'a, bool> {
        Box::pin(async { Ok(true) })
    }

    /// Read sanitized public aggregate state.
    fn snapshot<'a>(&'a self, channel: &'a str, now_ms: i64) -> StateFuture<'a, WidgetStates>;

    /// Project the shared source read to the complete selected widget configs.
    fn project(
        &self,
        state: WidgetStates,
        _widgets: &[StateWidget],
    ) -> Result<WidgetStates, String> {
        Ok(state)
    }
}

/// Per-cycle cache that retains successful and failed reads until the cycle ends.
#[derive(Default)]
pub struct WidgetStateReadScope {
    reads: Mutex<BTreeMap<String, SharedRead>>,
}

/// Native widget state registry with shared in-flight reads.
pub struct WidgetStateRegistry {
    sources: BTreeMap<String, Arc<dyn WidgetStateSource>>,
    pending: Mutex<BTreeMap<String, SharedRead>>,
    definition_for: fn(&str) -> Option<&'static WidgetDefinition>,
}

impl WidgetStateRegistry {
    /// Construct with explicit providers, rejecting duplicate source IDs.
    pub fn with_sources(sources: Vec<Arc<dyn WidgetStateSource>>) -> Result<Self, String> {
        let mut registered = BTreeMap::new();
        for source in sources {
            let name = source.source().to_owned();
            if registered.insert(name.clone(), source).is_some() {
                return Err(format!("Duplicate widget state source: {name}"));
            }
        }
        Ok(Self {
            sources: registered,
            pending: Mutex::new(BTreeMap::new()),
            definition_for: get_widget_definition,
        })
    }

    /// Override definition resolution while retaining registered config
    /// validation.
    pub fn with_definition_lookup(
        mut self,
        lookup: fn(&str) -> Option<&'static WidgetDefinition>,
    ) -> Self {
        self.definition_for = lookup;
        self
    }

    /// Start a bounded read cycle.
    pub fn create_read_scope(&self) -> WidgetStateReadScope {
        WidgetStateReadScope::default()
    }

    async fn source_read(
        &self,
        channel: &str,
        source: &dyn WidgetStateSource,
        now_ms: i64,
        scope: &WidgetStateReadScope,
    ) -> Result<WidgetStates, String> {
        let key = serde_json::to_string(&(channel, source.source()))
            .map_err(|_| "invalid state key".to_owned())?;
        let cell = {
            let mut scoped = scope
                .reads
                .lock()
                .map_err(|_| "read scope unavailable".to_owned())?;
            if let Some(cell) = scoped.get(&key) {
                cell.clone()
            } else {
                let mut pending = self
                    .pending
                    .lock()
                    .map_err(|_| "state registry unavailable".to_owned())?;
                let cell = pending.entry(key.clone()).or_default().clone();
                scoped.insert(key.clone(), cell.clone());
                cell
            }
        };
        let result = (*cell
            .get_or_init(|| source.snapshot(channel, now_ms))
            .await)
            .clone();
        if let Ok(mut pending) = self.pending.lock() {
            if pending
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, &cell))
            {
                pending.remove(&key);
            }
        }
        result
    }

    async fn read_source(
        &self,
        channel: &str,
        source: &str,
        selection: &WidgetSourceSelection,
        scope: &WidgetStateReadScope,
        now_ms: i64,
    ) -> Result<WidgetStates, SourceFailure> {
        let Some(provider) = self.sources.get(source) else {
            return Err(SourceFailure);
        };
        match provider.authorize(channel, &selection.widgets).await {
            Ok(false) => return Ok(denied_states(&selection.keys)),
            Err(_error) => return Err(SourceFailure),
            Ok(true) => {}
        }
        let states = self
            .source_read(channel, provider.as_ref(), now_ms, scope)
            .await
            .map_err(|_error| SourceFailure)?;
        let projected = provider
            .project(states, &selection.widgets)
            .map_err(|_error| SourceFailure)?;
        if !projected_is_valid(&selection.keys, &projected) {
            return Err(SourceFailure);
        }
        Ok(project_states(&selection.keys, &projected))
    }

    /// Read selected widget states, isolating a failing provider without leaking
    /// its errors. Sources are dispatched concurrently; model output is merged in
    /// deterministic source order. `now_ms` is the polling-cycle clock supplied by
    /// the caller and becomes `serverTime`.
    pub async fn snapshot(
        &self,
        channel: &str,
        widgets: &[StateWidget],
        scope: &WidgetStateReadScope,
        now_ms: i64,
    ) -> WidgetStateSnapshot {
        let selection = select_widget_sources_with(widgets, self.definition_for);
        let outcomes = join_all(selection.into_iter().map(|(source, selection)| async move {
            (
                source,
                self.read_source(channel, source, &selection, scope, now_ms)
                    .await,
            )
        }))
        .await;
        let mut widget_states = WidgetStates::new();
        let mut failed_sources = Vec::new();
        for (source, result) in outcomes {
            match result {
                Ok(states) => widget_states.extend(states),
                Err(_failure) => failed_sources.push(source.to_owned()),
            }
        }
        WidgetStateSnapshot {
            widget_states,
            server_time: now_ms,
            failed_sources,
        }
    }

    /// Read once with a fresh scope, matching the source's default parameter.
    pub async fn snapshot_once(
        &self,
        channel: &str,
        widgets: &[StateWidget],
        now_ms: i64,
    ) -> WidgetStateSnapshot {
        let scope = self.create_read_scope();
        self.snapshot(channel, widgets, &scope, now_ms).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overlays::widget_contract::MAX_SAFE_REVISION;
    use crate::utils::lossless_json::parse_json;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    type Selected = Vec<Vec<StateWidget>>;

    fn widget(kind: &str, visible: bool) -> StateWidget {
        StateWidget {
            raw: vec![
                ("kind".into(), JsonValue::String(kind.into())),
                ("visible".into(), JsonValue::Bool(visible)),
            ],
        }
    }

    fn widget_with(kind: &str, id: &str, config: JsonValue) -> StateWidget {
        StateWidget {
            raw: vec![
                ("id".into(), JsonValue::String(id.into())),
                ("kind".into(), JsonValue::String(kind.into())),
                ("visible".into(), JsonValue::Bool(true)),
                ("config".into(), config),
            ],
        }
    }

    fn channel_state(channel: &str) -> JsonValue {
        JsonValue::Object(vec![(
            "channel".into(),
            JsonValue::String(channel.into()),
        )])
    }

    fn instance_pairs(widgets: &[StateWidget]) -> JsonValue {
        JsonValue::Array(
            widgets
                .iter()
                .map(|widget| {
                    let id = widget.field("id").cloned().unwrap_or(JsonValue::Null);
                    let config = widget.field("config").cloned().unwrap_or(JsonValue::Null);
                    JsonValue::Array(vec![id, config])
                })
                .collect(),
        )
    }

    #[test]
    fn only_visible_valid_state_widgets_are_selected_with_complete_instances() {
        let poll_a = widget("poll", true);
        let mut poll_b = widget("poll", true);
        poll_b
            .raw
            .insert(0, ("id".into(), JsonValue::String("poll-b".into())));
        let selection = select_widget_sources_with(
            &[
                poll_a.clone(),
                poll_b.clone(),
                widget("prediction", false),
                widget("text", true),
                widget("poll", false),
            ],
            get_widget_definition,
        );
        let entry = selection
            .get("twitch-interactions")
            .expect("interaction source");
        assert_eq!(entry.keys, BTreeSet::from(["poll"]));
        assert_eq!(entry.widgets, vec![poll_a, poll_b]);
        assert_eq!(select_widgets(&[]), WidgetStateSelection::new());
        assert_eq!(
            select_widgets(&[widget("poll", true), widget("prediction", true)])
                .get("twitch-interactions"),
            Some(&BTreeSet::from(["poll", "prediction"]))
        );
        assert!(select_widget_sources(&[widget("poll", true)])
            .contains_key("twitch-interactions"));
    }

    #[test]
    fn saved_widget_objects_are_state_inputs() {
        let value = parse_json(
            r#"{"kind":"poll","visible":true,"config":{"interactionDesign":"card"}}"#,
        )
        .expect("json");
        let widget = StateWidget::from_json(&value).expect("object");
        assert_eq!(
            widget.field("kind"),
            Some(&JsonValue::String(JsString::from("poll")))
        );
        assert_eq!(
            widget.field("config"),
            Some(&JsonValue::Object(vec![(
                "interactionDesign".into(),
                JsonValue::String("card".into()),
            )]))
        );
        assert_eq!(StateWidget::from_json(&JsonValue::Null), None);
    }

    struct Tracking {
        reads: Arc<Mutex<Vec<String>>>,
    }

    impl WidgetStateSource for Tracking {
        fn source(&self) -> &str {
            "twitch-interactions"
        }

        fn snapshot<'a>(&'a self, channel: &'a str, _now_ms: i64) -> StateFuture<'a, WidgetStates> {
            Box::pin(async move {
                self.reads
                    .lock()
                    .map_err(|_| "fixture lock".to_owned())?
                    .push(channel.to_owned());
                Ok(WidgetStates::from([
                    (
                        "poll".into(),
                        WidgetStateEntry {
                            revision: 7.0,
                            state: channel_state(channel),
                        },
                    ),
                    (
                        "prediction".into(),
                        WidgetStateEntry {
                            revision: 3.0,
                            state: JsonValue::Object(vec![(
                                "secret".into(),
                                JsonValue::String("not-selected".into()),
                            )]),
                        },
                    ),
                    (
                        "unrelated".into(),
                        WidgetStateEntry {
                            revision: 8.0,
                            state: JsonValue::String("private".into()),
                        },
                    ),
                ]))
            })
        }
    }

    #[tokio::test]
    async fn visible_selected_modules_share_reads_across_instances_peers_and_cycles() {
        let reads = Arc::new(Mutex::new(Vec::new()));
        let source: Arc<dyn WidgetStateSource> = Arc::new(Tracking {
            reads: reads.clone(),
        });
        let registry = WidgetStateRegistry::with_sources(vec![source]).expect("one source");
        let scope = registry.create_read_scope();
        let first = [
            widget("poll", true),
            widget("poll", true),
            widget("prediction", false),
        ];
        let second = [widget("poll", true)];
        let (a, b) = tokio::join!(
            registry.snapshot("a", &first, &scope, 1),
            registry.snapshot("a", &second, &scope, 1),
        );
        assert_eq!(*reads.lock().expect("fixture lock"), vec!["a"]);
        assert_eq!(a.widget_states, b.widget_states);
        assert_eq!(
            a.widget_states,
            WidgetStates::from([(
                "poll".into(),
                WidgetStateEntry {
                    revision: 7.0,
                    state: channel_state("a"),
                }
            )])
        );
        let serialized = a.to_json().to_json_string();
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("private"));

        registry.snapshot("a", &second, &scope, 1).await;
        assert_eq!(*reads.lock().expect("fixture lock"), vec!["a"]);
        registry.snapshot("b", &second, &scope, 2).await;
        assert_eq!(*reads.lock().expect("fixture lock"), vec!["a", "b"]);
        registry.snapshot_once("a", &second, 3).await;
        assert_eq!(*reads.lock().expect("fixture lock"), vec!["a", "b", "a"]);

        let invalid = [
            widget("poll", false),
            StateWidget {
                raw: vec![
                    ("kind".into(), JsonValue::String("poll".into())),
                    ("visible".into(), JsonValue::Bool(true)),
                    ("configVersion".into(), JsonValue::Number(2.0)),
                ],
            },
            StateWidget {
                raw: vec![
                    ("kind".into(), JsonValue::String("poll".into())),
                    ("visible".into(), JsonValue::Bool(true)),
                    (
                        "config".into(),
                        JsonValue::Object(vec![("unknown".into(), JsonValue::Bool(true))]),
                    ),
                ],
            },
        ];
        registry.snapshot_once("a", &invalid, 4).await;
        assert_eq!(*reads.lock().expect("fixture lock"), vec!["a", "b", "a"]);
    }

    #[tokio::test]
    async fn successful_missing_states_explicitly_clear_while_revisions_and_null_remain_intact() {
        struct Missing;

        impl WidgetStateSource for Missing {
            fn source(&self) -> &str {
                "twitch-interactions"
            }

            fn snapshot<'a>(
                &'a self,
                _channel: &'a str,
                _now_ms: i64,
            ) -> StateFuture<'a, WidgetStates> {
                Box::pin(async {
                    Ok(WidgetStates::from([(
                        "poll".into(),
                        WidgetStateEntry {
                            revision: 9.0,
                            state: JsonValue::Null,
                        },
                    )]))
                })
            }
        }

        let source: Arc<dyn WidgetStateSource> = Arc::new(Missing);
        let registry = WidgetStateRegistry::with_sources(vec![source]).expect("one source");
        let scope = registry.create_read_scope();
        let result = registry
            .snapshot(
                "a",
                &[widget("poll", true), widget("prediction", true)],
                &scope,
                10,
            )
            .await;
        assert_eq!(
            result.widget_states,
            WidgetStates::from([
                (
                    "poll".into(),
                    WidgetStateEntry {
                        revision: 9.0,
                        state: JsonValue::Null,
                    },
                ),
                ("prediction".into(), WidgetStateEntry::cleared()),
            ])
        );
        assert!(result.failed_sources.is_empty());
        assert_eq!(result.server_time, 10);
        assert!(registry
            .snapshot("a", &[], &scope, 11)
            .await
            .widget_states
            .is_empty());
    }

    struct Flaky {
        fail: Arc<AtomicBool>,
        reads: Arc<AtomicUsize>,
    }

    impl WidgetStateSource for Flaky {
        fn source(&self) -> &str {
            "twitch-interactions"
        }

        fn snapshot<'a>(
            &'a self,
            _channel: &'a str,
            _now_ms: i64,
        ) -> StateFuture<'a, WidgetStates> {
            Box::pin(async move {
                self.reads.fetch_add(1, Ordering::SeqCst);
                if self.fail.load(Ordering::SeqCst) {
                    return Err("private provider detail".into());
                }
                Ok(WidgetStates::from([(
                    "poll".into(),
                    WidgetStateEntry {
                        revision: 4.0,
                        state: JsonValue::String("recovered".into()),
                    },
                )]))
            })
        }
    }

    struct Healthy {
        reads: Arc<AtomicUsize>,
    }

    impl WidgetStateSource for Healthy {
        fn source(&self) -> &str {
            "test-other-source"
        }

        fn snapshot<'a>(
            &'a self,
            _channel: &'a str,
            _now_ms: i64,
        ) -> StateFuture<'a, WidgetStates> {
            Box::pin(async move {
                self.reads.fetch_add(1, Ordering::SeqCst);
                Ok(WidgetStates::from([(
                    "prediction".into(),
                    WidgetStateEntry {
                        revision: 2.0,
                        state: JsonValue::String("healthy".into()),
                    },
                )]))
            })
        }
    }

    static OTHER_PREDICTION: WidgetDefinition =
        crate::overlays::widget_contract::PREDICTION_DEFINITION
            .with_state("test-other-source", "prediction");

    fn lookup(kind: &str) -> Option<&'static WidgetDefinition> {
        if kind == "prediction" {
            Some(&OTHER_PREDICTION)
        } else {
            get_widget_definition(kind)
        }
    }

    #[tokio::test]
    async fn failed_source_is_isolated_and_failed_in_flight_reads_release_for_a_fresh_cycle() {
        let fail = Arc::new(AtomicBool::new(true));
        let flaky_reads = Arc::new(AtomicUsize::new(0));
        let healthy_reads = Arc::new(AtomicUsize::new(0));
        let flaky: Arc<dyn WidgetStateSource> = Arc::new(Flaky {
            fail: fail.clone(),
            reads: flaky_reads.clone(),
        });
        let healthy: Arc<dyn WidgetStateSource> = Arc::new(Healthy {
            reads: healthy_reads.clone(),
        });
        let registry = WidgetStateRegistry::with_sources(vec![flaky, healthy])
            .expect("sources")
            .with_definition_lookup(lookup);
        let scope = registry.create_read_scope();
        let complete = [widget("poll", true), widget("prediction", true)];
        let partial = [widget("poll", true)];
        let (a, b) = tokio::join!(
            registry.snapshot("a", &complete, &scope, 0),
            registry.snapshot("a", &partial, &scope, 0),
        );
        assert_eq!(flaky_reads.load(Ordering::SeqCst), 1);
        assert_eq!(a.failed_sources, vec!["twitch-interactions"]);
        assert_eq!(b.failed_sources, a.failed_sources);
        assert_eq!(
            a.widget_states,
            WidgetStates::from([(
                "prediction".into(),
                WidgetStateEntry {
                    revision: 2.0,
                    state: JsonValue::String("healthy".into()),
                }
            )])
        );
        let serialized = a.to_json().to_json_string();
        assert!(!serialized.contains("private"));
        assert!(!serialized.contains("provider detail"));

        fail.store(false, Ordering::SeqCst);
        let retry = registry.snapshot_once("a", &partial, 1).await;
        assert_eq!(retry.widget_states["poll"].revision, 4.0);
        assert_eq!(flaky_reads.load(Ordering::SeqCst), 2);
        assert_eq!(healthy_reads.load(Ordering::SeqCst), 1);
    }

    struct Gated {
        reads: Arc<AtomicUsize>,
        projects: Arc<AtomicUsize>,
        selected: Arc<Mutex<Selected>>,
    }

    impl WidgetStateSource for Gated {
        fn source(&self) -> &str {
            "twitch-interactions"
        }

        fn authorize<'a>(
            &'a self,
            channel: &'a str,
            _widgets: &'a [StateWidget],
        ) -> StateFuture<'a, bool> {
            let allowed = channel == "allowed";
            Box::pin(async move { Ok(allowed) })
        }

        fn snapshot<'a>(
            &'a self,
            _channel: &'a str,
            _now_ms: i64,
        ) -> StateFuture<'a, WidgetStates> {
            Box::pin(async move {
                self.reads.fetch_add(1, Ordering::SeqCst);
                Ok(WidgetStates::from([(
                    "poll".into(),
                    WidgetStateEntry {
                        revision: 1.0,
                        state: JsonValue::String("shared".into()),
                    },
                )]))
            })
        }

        fn project(
            &self,
            mut state: WidgetStates,
            widgets: &[StateWidget],
        ) -> Result<WidgetStates, String> {
            self.projects.fetch_add(1, Ordering::SeqCst);
            self.selected
                .lock()
                .map_err(|_| "fixture lock".to_owned())?
                .push(widgets.to_vec());
            state.insert(
                "poll".into(),
                WidgetStateEntry {
                    revision: 1.0,
                    state: instance_pairs(widgets),
                },
            );
            Ok(state)
        }
    }

    #[tokio::test]
    async fn access_checks_precede_reads_and_projection_receives_complete_selected_configs() {
        let reads = Arc::new(AtomicUsize::new(0));
        let projects = Arc::new(AtomicUsize::new(0));
        let selected: Arc<Mutex<Selected>> = Arc::new(Mutex::new(Vec::new()));
        let source: Arc<dyn WidgetStateSource> = Arc::new(Gated {
            reads: reads.clone(),
            projects: projects.clone(),
            selected: selected.clone(),
        });
        let registry = WidgetStateRegistry::with_sources(vec![source]).expect("one source");

        let denied_widgets = [widget("poll", true)];
        let denied = registry
            .snapshot_once("denied", &denied_widgets, 0)
            .await;
        assert!(denied.failed_sources.is_empty());
        assert_eq!(
            denied.widget_states,
            WidgetStates::from([("poll".into(), WidgetStateEntry::cleared())])
        );
        assert_eq!(reads.load(Ordering::SeqCst), 0);
        assert_eq!(projects.load(Ordering::SeqCst), 0);

        let first = widget_with(
            "poll",
            "poll-a",
            parse_json(r#"{"interactionDesign":"compact"}"#).expect("json"),
        );
        let second = widget_with(
            "poll",
            "poll-b",
            parse_json(r#"{"interactionDesign":"card"}"#).expect("json"),
        );
        let result = registry
            .snapshot_once(
                "allowed",
                &[first.clone(), second.clone(), widget("prediction", false)],
                1,
            )
            .await;
        assert_eq!(
            *selected.lock().expect("fixture lock"),
            vec![vec![first, second]]
        );
        assert_eq!(projects.load(Ordering::SeqCst), 1);
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert_eq!(
            result.widget_states["poll"],
            WidgetStateEntry {
                revision: 1.0,
                state: JsonValue::Array(vec![
                    JsonValue::Array(vec![
                        JsonValue::String("poll-a".into()),
                        parse_json(r#"{"interactionDesign":"compact"}"#).expect("json"),
                    ]),
                    JsonValue::Array(vec![
                        JsonValue::String("poll-b".into()),
                        parse_json(r#"{"interactionDesign":"card"}"#).expect("json"),
                    ]),
                ]),
            }
        );
    }

    struct Oversized;

    impl WidgetStateSource for Oversized {
        fn source(&self) -> &str {
            "twitch-interactions"
        }

        fn snapshot<'a>(
            &'a self,
            _channel: &'a str,
            _now_ms: i64,
        ) -> StateFuture<'a, WidgetStates> {
            Box::pin(async {
                Ok(WidgetStates::from([
                    (
                        "poll".into(),
                        WidgetStateEntry {
                            revision: 5.0,
                            state: JsonValue::String("leak".into()),
                        },
                    ),
                    (
                        "prediction".into(),
                        WidgetStateEntry {
                            revision: MAX_SAFE_REVISION as f64 + 1.0,
                            state: JsonValue::String("bad".into()),
                        },
                    ),
                ]))
            })
        }
    }

    #[tokio::test]
    async fn unknown_sources_and_invalid_revisions_are_isolated_without_partial_state() {
        let empty = WidgetStateRegistry::with_sources(vec![]).expect("empty registry");
        let missing = empty
            .snapshot_once("a", &[widget("poll", true)], 0)
            .await;
        assert!(missing.widget_states.is_empty());
        assert_eq!(missing.failed_sources, vec!["twitch-interactions"]);

        let source: Arc<dyn WidgetStateSource> = Arc::new(Oversized);
        let registry = WidgetStateRegistry::with_sources(vec![source]).expect("one source");
        let result = registry
            .snapshot_once("a", &[widget("poll", true), widget("prediction", true)], 0)
            .await;
        assert!(result.widget_states.is_empty());
        assert_eq!(result.failed_sources, vec!["twitch-interactions"]);
    }

    struct ExtraInvalid;

    impl WidgetStateSource for ExtraInvalid {
        fn source(&self) -> &str {
            "twitch-interactions"
        }

        fn snapshot<'a>(
            &'a self,
            _channel: &'a str,
            _now_ms: i64,
        ) -> StateFuture<'a, WidgetStates> {
            Box::pin(async {
                Ok(WidgetStates::from([
                    (
                        "poll".into(),
                        WidgetStateEntry {
                            revision: 5.0,
                            state: JsonValue::String("published".into()),
                        },
                    ),
                    (
                        "unrelated".into(),
                        WidgetStateEntry {
                            revision: MAX_SAFE_REVISION as f64 + 1.0,
                            state: JsonValue::String("ignored".into()),
                        },
                    ),
                ]))
            })
        }
    }

    #[tokio::test]
    async fn unselected_invalid_entries_do_not_fail_a_selected_source() {
        let source: Arc<dyn WidgetStateSource> = Arc::new(ExtraInvalid);
        let registry = WidgetStateRegistry::with_sources(vec![source]).expect("one source");
        let result = registry
            .snapshot_once("a", &[widget("poll", true)], 0)
            .await;
        assert!(result.failed_sources.is_empty());
        assert_eq!(
            result.widget_states,
            WidgetStates::from([(
                "poll".into(),
                WidgetStateEntry {
                    revision: 5.0,
                    state: JsonValue::String("published".into()),
                }
            )])
        );
    }

    struct MixedRevisions;

    impl WidgetStateSource for MixedRevisions {
        fn source(&self) -> &str {
            "twitch-interactions"
        }

        fn snapshot<'a>(
            &'a self,
            _channel: &'a str,
            _now_ms: i64,
        ) -> StateFuture<'a, WidgetStates> {
            Box::pin(async {
                Ok(WidgetStates::from([
                    (
                        "poll".into(),
                        WidgetStateEntry {
                            revision: 7.0,
                            state: JsonValue::String("poll".into()),
                        },
                    ),
                    (
                        "prediction".into(),
                        WidgetStateEntry {
                            revision: -1.0,
                            state: JsonValue::String("invalid".into()),
                        },
                    ),
                ]))
            })
        }
    }

    #[tokio::test]
    async fn invalid_unselected_revisions_do_not_fail_and_selected_ones_fail_the_source() {
        let source: Arc<dyn WidgetStateSource> = Arc::new(MixedRevisions);
        let registry = WidgetStateRegistry::with_sources(vec![source]).expect("one source");
        let poll_only = registry
            .snapshot_once("a", &[widget("poll", true)], 0)
            .await;
        assert!(poll_only.failed_sources.is_empty());
        assert_eq!(poll_only.widget_states["poll"].revision, 7.0);

        let both = registry
            .snapshot_once("a", &[widget("poll", true), widget("prediction", true)], 0)
            .await;
        assert!(both.widget_states.is_empty());
        assert_eq!(both.failed_sources, vec!["twitch-interactions"]);
    }

    struct FailingProject;

    impl WidgetStateSource for FailingProject {
        fn source(&self) -> &str {
            "twitch-interactions"
        }

        fn snapshot<'a>(
            &'a self,
            _channel: &'a str,
            _now_ms: i64,
        ) -> StateFuture<'a, WidgetStates> {
            Box::pin(async {
                Ok(WidgetStates::from([(
                    "poll".into(),
                    WidgetStateEntry {
                        revision: 1.0,
                        state: JsonValue::String("staged".into()),
                    },
                )]))
            })
        }

        fn project(
            &self,
            _state: WidgetStates,
            _widgets: &[StateWidget],
        ) -> Result<WidgetStates, String> {
            Err("private projection detail".into())
        }
    }

    #[tokio::test]
    async fn projection_failures_publish_nothing_and_keep_the_error_private() {
        let source: Arc<dyn WidgetStateSource> = Arc::new(FailingProject);
        let registry = WidgetStateRegistry::with_sources(vec![source]).expect("one source");
        let result = registry
            .snapshot_once("a", &[widget("poll", true)], 0)
            .await;
        assert!(result.widget_states.is_empty());
        assert_eq!(result.failed_sources, vec!["twitch-interactions"]);
        assert!(!result.to_json().to_json_string().contains("private"));
    }

    struct BrokenAuth {
        reads: Arc<AtomicUsize>,
    }

    impl WidgetStateSource for BrokenAuth {
        fn source(&self) -> &str {
            "twitch-interactions"
        }

        fn authorize<'a>(
            &'a self,
            _channel: &'a str,
            _widgets: &'a [StateWidget],
        ) -> StateFuture<'a, bool> {
            Box::pin(async { Err("access unavailable".into()) })
        }

        fn snapshot<'a>(
            &'a self,
            _channel: &'a str,
            _now_ms: i64,
        ) -> StateFuture<'a, WidgetStates> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(WidgetStates::new()) })
        }
    }

    #[tokio::test]
    async fn a_failed_authorization_is_transient_and_does_not_clear_state() {
        let reads = Arc::new(AtomicUsize::new(0));
        let source: Arc<dyn WidgetStateSource> = Arc::new(BrokenAuth {
            reads: reads.clone(),
        });
        let registry = WidgetStateRegistry::with_sources(vec![source]).expect("one source");
        let result = registry
            .snapshot_once("a", &[widget("poll", true)], 0)
            .await;
        assert_eq!(reads.load(Ordering::SeqCst), 0);
        assert!(result.widget_states.is_empty());
        assert_eq!(result.failed_sources, vec!["twitch-interactions"]);
    }

    #[test]
    fn duplicate_sources_are_rejected() {
        struct Duplicate;

        impl WidgetStateSource for Duplicate {
            fn source(&self) -> &str {
                "twitch-interactions"
            }

            fn snapshot<'a>(
                &'a self,
                _channel: &'a str,
                _now_ms: i64,
            ) -> StateFuture<'a, WidgetStates> {
                Box::pin(async { Ok(WidgetStates::new()) })
            }
        }

        let first: Arc<dyn WidgetStateSource> = Arc::new(Duplicate);
        let second: Arc<dyn WidgetStateSource> = Arc::new(Duplicate);
        let error = match WidgetStateRegistry::with_sources(vec![first, second]) {
            Ok(_) => panic!("duplicate sources must be rejected"),
            Err(error) => error,
        };
        assert_eq!(error, "Duplicate widget state source: twitch-interactions");
    }
}

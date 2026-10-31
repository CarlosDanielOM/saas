#![cfg(feature = "overlays-runtime")]
//! Source-oracle scenarios for `src/overlays/widget-state.test.ts` and the
//! portable contract in `widget-contract.ts`.
//!
//! Authoring note: `dima_rust::overlays` is not declared until the central
//! `src/lib.rs` / `Cargo.toml` `overlays-runtime` patch lands. Enabling the
//! feature without that patch makes this target fail to compile, matching
//! `tests/announcement_chat.rs`.
//!
//! The concrete Mongo `InteractionStateSource` conversion is covered by its
//! module tests. These scenarios exercise only the injected-provider seam that
//! the source registry defines; no database, network, or environment access is
//! used.

use std::{
    collections::BTreeSet,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

use dima_rust::{
    overlays::{
        widget_contract::{
            get_widget_definition, parse_widget_module_config, valid_widget_module_config,
            widget_kinds, ParsedWidgetModuleConfig, WidgetDefinition, WidgetPlacement,
            WidgetStateEntry, WidgetStates, MAX_SAFE_REVISION, PREDICTION_DEFINITION,
            WIDGET_DEFINITIONS,
        },
        widget_state::{StateFuture, StateWidget, WidgetStateRegistry, WidgetStateSource},
    },
    utils::{
        js_string::JsString,
        lossless_json::{parse_json, JsonValue},
    },
};

const CASES: &str = include_str!("fixtures/overlay_widget_contract_cases.json");

fn raw_widget(kind: &str, visible: bool) -> Vec<(JsString, JsonValue)> {
    vec![
        (
            JsString::from("kind"),
            JsonValue::String(JsString::from(kind)),
        ),
        (JsString::from("visible"), JsonValue::Bool(visible)),
    ]
}

fn state_widget(kind: &str, visible: bool) -> StateWidget {
    StateWidget {
        raw: raw_widget(kind, visible),
    }
}

fn state_widget_with(
    kind: &str,
    visible: bool,
    extra: impl IntoIterator<Item = (&'static str, JsonValue)>,
) -> StateWidget {
    let mut raw = raw_widget(kind, visible);
    for (key, value) in extra {
        put(&mut raw, JsString::from(key), value);
    }
    StateWidget { raw }
}

fn put(fields: &mut Vec<(JsString, JsonValue)>, key: JsString, value: JsonValue) {
    if let Some(existing) = fields.iter_mut().find(|(candidate, _)| *candidate == key) {
        existing.1 = value;
    } else {
        fields.push((key, value));
    }
}

fn string_field<'a>(value: &'a JsonValue, key: &str) -> &'a str {
    match value.get(key) {
        Some(JsonValue::String(text)) => text.as_str().expect("fixture strings are UTF-8"),
        _ => panic!("fixture field {key}"),
    }
}

fn placement(name: &str) -> WidgetPlacement {
    match name {
        "scene" => WidgetPlacement::Scene,
        "design" => WidgetPlacement::Design,
        _ => panic!("fixture placement {name}"),
    }
}

fn channel_state(channel: &str) -> JsonValue {
    JsonValue::Object(vec![(
        "channel".into(),
        JsonValue::String(channel.into()),
    )])
}

#[test]
fn fixture_cases_match_registered_module_validation() {
    let cases = parse_json(CASES).expect("fixture json");
    let cases = match cases.get("cases") {
        Some(JsonValue::Array(cases)) => cases,
        _ => panic!("fixture cases"),
    };
    for case in cases {
        let name = string_field(case, "name");
        let kind = string_field(case, "kind");
        let at = placement(string_field(case, "placement"));
        let mut raw = raw_widget(kind, true);
        if let Some(JsonValue::Object(fields)) = case.get("fields") {
            for (key, value) in fields {
                put(&mut raw, key.clone(), value.clone());
            }
        }
        let expected = matches!(case.get("valid"), Some(JsonValue::Bool(true)));
        assert_eq!(
            valid_widget_module_config(&raw, at),
            expected,
            "{name}"
        );
    }
}

#[test]
fn portable_definitions_preserve_placement_legacy_config_versions_and_strict_module_fields() {
    let unique: BTreeSet<_> = WIDGET_DEFINITIONS
        .iter()
        .map(|definition| definition.kind)
        .collect();
    assert_eq!(unique.len(), WIDGET_DEFINITIONS.len());
    assert!(widget_kinds(WidgetPlacement::Scene).contains(&"text"));
    assert!(!widget_kinds(WidgetPlacement::Scene).contains(&"animation"));
    assert!(widget_kinds(WidgetPlacement::Design).contains(&"animation"));
    assert!(!widget_kinds(WidgetPlacement::Design).contains(&"poll"));
    assert!(get_widget_definition("constructor").is_none());

    let mut raw = raw_widget("poll", true);
    put(
        &mut raw,
        JsString::from("configVersion"),
        JsonValue::Number(1.0),
    );
    put(
        &mut raw,
        JsString::from("interactionDesign"),
        JsonValue::String("compact".into()),
    );
    put(
        &mut raw,
        JsString::from("config"),
        parse_json(r#"{"interactionDesign":"card"}"#).expect("json"),
    );
    put(
        &mut raw,
        JsString::from("discarded"),
        JsonValue::String("secret".into()),
    );
    let parsed = parse_widget_module_config(&raw, WidgetPlacement::Scene).expect("valid poll");
    assert_eq!(
        parsed,
        ParsedWidgetModuleConfig {
            config_version: Some(1),
            config: Some(vec![(
                JsString::from("interactionDesign"),
                JsonValue::String("card".into()),
            )]),
            legacy: vec![(
                JsString::from("interactionDesign"),
                JsonValue::String("compact".into()),
            )],
        }
    );
    if let Some((_, JsonValue::Object(fields))) = raw
        .iter_mut()
        .find(|(key, _)| key.as_str() == Some("config"))
    {
        fields[0].1 = JsonValue::String("compact".into());
    }
    assert_eq!(
        parsed.config,
        Some(vec![(
            JsString::from("interactionDesign"),
            JsonValue::String("card".into()),
        )])
    );
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
async fn visible_selected_modules_share_source_reads_across_instances_peers_with_channel_and_cycle_boundaries(
) {
    let reads = Arc::new(Mutex::new(Vec::new()));
    let source: Arc<dyn WidgetStateSource> = Arc::new(Tracking {
        reads: reads.clone(),
    });
    let registry = WidgetStateRegistry::with_sources(vec![source]).expect("source");
    let scope = registry.create_read_scope();
    let first = [
        state_widget("poll", true),
        state_widget_with("poll", true, [("id", JsonValue::String("poll-b".into()))]),
        state_widget("prediction", false),
    ];
    let second = [state_widget("poll", true)];
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
        state_widget("poll", false),
        state_widget_with("poll", true, [("configVersion", JsonValue::Number(2.0))]),
        state_widget_with(
            "poll",
            true,
            [(
                "config",
                JsonValue::Object(vec![("unknown".into(), JsonValue::Bool(true))]),
            )],
        ),
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
    let registry = WidgetStateRegistry::with_sources(vec![source]).expect("source");
    let result = registry
        .snapshot_once(
            "a",
            &[state_widget("poll", true), state_widget("prediction", true)],
            0,
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
            (
                "prediction".into(),
                WidgetStateEntry {
                    revision: 0.0,
                    state: JsonValue::Null,
                },
            ),
        ])
    );
    assert!(registry
        .snapshot_once("a", &[], 0)
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

    fn snapshot<'a>(&'a self, _channel: &'a str, _now_ms: i64) -> StateFuture<'a, WidgetStates> {
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

    fn snapshot<'a>(&'a self, _channel: &'a str, _now_ms: i64) -> StateFuture<'a, WidgetStates> {
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
    PREDICTION_DEFINITION.with_state("test-other-source", "prediction");

fn source_lookup(kind: &str) -> Option<&'static WidgetDefinition> {
    if kind == "prediction" {
        Some(&OTHER_PREDICTION)
    } else {
        get_widget_definition(kind)
    }
}

#[tokio::test]
async fn failed_source_is_isolated_failed_in_flight_reads_release_and_a_fresh_cycle_retries() {
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
        .with_definition_lookup(source_lookup);
    let scope = registry.create_read_scope();
    let complete = [state_widget("poll", true), state_widget("prediction", true)];
    let partial = [state_widget("poll", true)];
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

type Selected = Vec<Vec<StateWidget>>;

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

    fn snapshot<'a>(&'a self, _channel: &'a str, _now_ms: i64) -> StateFuture<'a, WidgetStates> {
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
                state: JsonValue::Array(
                    widgets
                        .iter()
                        .map(|widget| {
                            JsonValue::Array(vec![
                                widget.field("id").cloned().unwrap_or(JsonValue::Null),
                                widget.field("config").cloned().unwrap_or(JsonValue::Null),
                            ])
                        })
                        .collect(),
                ),
            },
        );
        Ok(state)
    }
}

#[tokio::test]
async fn access_checks_precede_reads_and_projection_receives_full_selected_instance_configs() {
    let reads = Arc::new(AtomicUsize::new(0));
    let projects = Arc::new(AtomicUsize::new(0));
    let selected: Arc<Mutex<Selected>> = Arc::new(Mutex::new(Vec::new()));
    let source: Arc<dyn WidgetStateSource> = Arc::new(Gated {
        reads: reads.clone(),
        projects: projects.clone(),
        selected: selected.clone(),
    });
    let registry = WidgetStateRegistry::with_sources(vec![source]).expect("source");

    let denied_widgets = [state_widget("poll", true)];
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

    let first = state_widget_with(
        "poll",
        true,
        [
            ("id", JsonValue::String("poll-a".into())),
            (
                "config",
                parse_json(r#"{"interactionDesign":"compact"}"#).expect("json"),
            ),
        ],
    );
    let second = state_widget_with(
        "poll",
        true,
        [
            ("id", JsonValue::String("poll-b".into())),
            (
                "config",
                parse_json(r#"{"interactionDesign":"card"}"#).expect("json"),
            ),
        ],
    );
    let result = registry
        .snapshot_once(
            "allowed",
            &[first.clone(), second.clone(), state_widget("prediction", false)],
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

#[tokio::test]
async fn unknown_sources_and_invalid_revisions_are_isolated_as_unavailable() {
    let empty = WidgetStateRegistry::with_sources(vec![]).expect("empty registry");
    assert_eq!(
        empty
            .snapshot_once("a", &[state_widget("poll", true)], 0)
            .await
            .failed_sources,
        vec!["twitch-interactions"]
    );

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
                Ok(WidgetStates::from([(
                    "poll".into(),
                    WidgetStateEntry {
                        revision: MAX_SAFE_REVISION as f64 + 1.0,
                        state: JsonValue::String("invalid".into()),
                    },
                )]))
            })
        }
    }

    let source: Arc<dyn WidgetStateSource> = Arc::new(Oversized);
    let registry = WidgetStateRegistry::with_sources(vec![source]).expect("source");
    let result = registry
        .snapshot_once("a", &[state_widget("poll", true)], 0)
        .await;
    assert!(result.widget_states.is_empty());
    assert_eq!(result.failed_sources, vec!["twitch-interactions"]);
}

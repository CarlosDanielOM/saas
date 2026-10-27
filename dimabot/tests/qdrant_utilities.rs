#![cfg(feature = "qdrant")]

use dima_rust::utils::qdrant::*;
use qdrant_client::qdrant::{
    Filter, PointId, condition, r#match::MatchValue, point_id, points_selector, value,
};
use serde_json::{Value, json};
use std::{collections::VecDeque, sync::Mutex};

type Step = Box<dyn FnOnce(QdrantRequest) -> Result<QdrantResponse, UtilityError> + Send>;
struct Backend(Mutex<VecDeque<Step>>);
impl Backend {
    fn new(steps: Vec<Step>) -> Self {
        Self(Mutex::new(steps.into()))
    }
    fn done(&self) {
        assert!(self.0.lock().unwrap().is_empty(), "unused backend steps");
    }
}
impl QdrantBackend for Backend {
    fn execute(&self, request: QdrantRequest) -> UtilityFuture<'_, QdrantResponse> {
        Box::pin(async move {
            let step = self
                .0
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected backend call");
            step(request)
        })
    }
}
#[derive(Default)]
struct Embeddings {
    calls: Mutex<Vec<(String, &'static str, EmbeddingKind)>>,
    failure: Option<&'static str>,
}
impl EmbeddingProvider for Embeddings {
    fn embed<'a>(
        &'a self,
        text: &'a str,
        model: &'static str,
        kind: EmbeddingKind,
    ) -> UtilityFuture<'a, Vec<f32>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push((text.into(), model, kind));
            if let Some(error) = self.failure {
                return Err(UtilityError(error.into()));
            }
            Ok(vec![1.0, 0.0, 0.0])
        })
    }
}
#[derive(Default)]
struct Language(Mutex<Vec<(String, f64)>>);
impl LanguageDetector for Language {
    fn detect_language(&self, text: &str, threshold: f64) -> String {
        self.0.lock().unwrap().push((text.into(), threshold));
        "fixture-language".into()
    }
}
#[derive(Default)]
struct Context {
    metrics: Mutex<Vec<SemanticMemoryMetric>>,
    errors: Mutex<Vec<String>>,
}
impl QdrantContext for Context {
    fn semantic_memory_metric(&self, metric: SemanticMemoryMetric) {
        self.metrics.lock().unwrap().push(metric);
    }
    fn error(&self, operation: &str, _: Value) {
        self.errors.lock().unwrap().push(operation.into());
    }
}
fn chat(message: &str) -> ChatMessageData {
    ChatMessageData {
        channel_id: "c".into(),
        channel_name: Some("channel".into()),
        message: message.into(),
        username: "user".into(),
        user_id: "u".into(),
        timestamp: 1_700_000_000.0,
        language: None,
    }
}
fn semantic() -> SemanticChatContextParams {
    SemanticChatContextParams {
        channel_id: "c".into(),
        query: "  dragon topic  ".into(),
        limit: 3,
        primary_min_score: None,
        fallback_min_score: None,
    }
}
fn memory() -> UpsertChannelMemoryParams {
    UpsertChannelMemoryParams {
        qdrant_point_id: 42.0,
        memory_id: "m".into(),
        channel_id: "c".into(),
        content: " body ".into(),
        summary: " summary ".into(),
        created_at_unix: Some(1_700_000_000.0),
        updated_at_unix: Some(1_700_000_001.0),
        confidence: Some(0.8),
        status: Some("confirmed".into()),
        subject_scope: Some("channel".into()),
        ..Default::default()
    }
}
fn retrieved(payload: Value) -> Step {
    Box::new(move |request| {
        let QdrantRequest::Retrieve(request) = request else {
            panic!("expected retrieve")
        };
        assert_eq!(request.collection_name, "twitch_channel_memories");
        assert_eq!(request.ids, vec![PointId::from(42_u64)]);
        Ok(QdrantResponse::Points(if payload.is_null() {
            vec![]
        } else {
            vec![json!({"payload":payload})]
        }))
    })
}

fn assert_keyword_match(filter: &Filter, key: &str, expected: &str) {
    let field = filter
        .must
        .iter()
        .find_map(|condition| match &condition.condition_one_of {
            Some(condition::ConditionOneOf::Field(field)) if field.key == key => Some(field),
            _ => None,
        })
        .unwrap_or_else(|| panic!("missing {key} field condition"));
    assert_eq!(
        field
            .r#match
            .as_ref()
            .and_then(|value| value.match_value.clone()),
        Some(MatchValue::Keyword(expected.to_owned())),
        "{key} must use exact keyword equality"
    );
}

#[tokio::test]
async fn window_channel_ids_with_internal_whitespace_use_keyword_equality() {
    let embeddings = Embeddings::default();
    let language = Language::default();
    for channel_id in ["channel one", "channel\tone", "channel\u{00a0}one"] {
        let expected = channel_id.to_owned();
        let backend = Backend::new(vec![Box::new(move |request| {
            let QdrantRequest::Scroll(request) = request else {
                panic!("scroll expected")
            };
            assert_keyword_match(request.filter.as_ref().unwrap(), "channel_id", &expected);
            Ok(QdrantResponse::Scroll {
                points: vec![],
                next_offset: None,
            })
        })]);
        let result = QdrantUtilities::new(&backend, &embeddings, &language)
            .retrieve_channel_chat_window(&ChatWindowParams {
                channel_id: channel_id.into(),
                from_unix: 1.0,
                to_unix: 2.0,
                limit: 1.0,
            })
            .await;
        assert!(!result.error);
        backend.done();
    }
}

#[tokio::test]
async fn semantic_channel_ids_with_internal_whitespace_use_keyword_equality() {
    let embeddings = Embeddings::default();
    let language = Language::default();
    for channel_id in ["channel one", "channel\tone", "channel\u{00a0}one"] {
        let expected = channel_id.to_owned();
        let backend = Backend::new(vec![Box::new(move |request| {
            let QdrantRequest::Query(request) = request else {
                panic!("query expected")
            };
            assert_keyword_match(request.filter.as_ref().unwrap(), "channel_id", &expected);
            Ok(QdrantResponse::Points(vec![
                json!({"score": 1.0, "payload": {
                    "channel_id": expected, "message": "primary result", "timestamp": 1,
                }}),
            ]))
        })]);
        let mut params = semantic();
        params.channel_id = channel_id.into();
        let result = QdrantUtilities::new(&backend, &embeddings, &language)
            .retrieve_semantic_chat_context(&params)
            .await;
        assert!(!result.error);
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.selected_pass, SemanticPass::High);
        backend.done();
    }
}

#[tokio::test]
async fn memory_channel_ids_with_internal_whitespace_use_keyword_equality() {
    let embeddings = Embeddings::default();
    let language = Language::default();
    for channel_id in ["channel one", "channel\tone", "channel\u{00a0}one"] {
        let expected = channel_id.to_owned();
        let backend = Backend::new(vec![Box::new(move |request| {
            let QdrantRequest::Query(request) = request else {
                panic!("query expected")
            };
            let filter = request.filter.as_ref().unwrap();
            assert_keyword_match(filter, "channel_id", &expected);
            assert_keyword_match(filter, "status", "confirmed");
            assert_keyword_match(filter, "subject_scope", "channel");
            Ok(QdrantResponse::Points(vec![
                json!({"id": 1, "score": 1.0, "payload": {
                    "channel_id": expected, "content": "memory result", "status": "confirmed",
                }}),
            ]))
        })]);
        let result = QdrantUtilities::new(&backend, &embeddings, &language)
            .retrieve_channel_memory_context(&RetrieveMemoryContextParams {
                channel_id: channel_id.into(),
                query: "query".into(),
                limit: 1,
                min_score: None,
                mode: MemoryRetrievalMode::Passive,
                subject_scope: MemorySubjectScope::Channel,
            })
            .await;
        assert!(!result.error);
        assert_eq!(result.items.len(), 1);
        backend.done();
    }
}

#[tokio::test]
async fn channel_deletion_with_internal_whitespace_uses_keyword_equality() {
    let embeddings = Embeddings::default();
    let language = Language::default();
    for channel_id in ["channel one", "channel\tone", "channel\u{00a0}one"] {
        let expected = channel_id.to_owned();
        let backend = Backend::new(vec![Box::new(move |request| {
            let QdrantRequest::Delete(request) = request else {
                panic!("delete expected")
            };
            let selector = request
                .points
                .as_ref()
                .unwrap()
                .points_selector_one_of
                .as_ref();
            let Some(points_selector::PointsSelectorOneOf::Filter(filter)) = selector else {
                panic!("delete filter expected")
            };
            assert_keyword_match(filter, "channel_id", &expected);
            assert_eq!(request.wait, Some(true));
            Ok(QdrantResponse::Done)
        })]);
        let result = QdrantUtilities::new(&backend, &embeddings, &language)
            .delete_channel_memory_embeddings_by_channel(channel_id)
            .await;
        assert!(!result.error);
        backend.done();
    }
}

#[test]
fn public_helpers_match_independent_typescript_folder_oracle() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/qdrant_folder_reference.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 90);
    for (index, case) in cases.iter().enumerate() {
        let input = &case["input"];
        let actual = match case["operation"].as_str().unwrap() {
            "point_id" => json!(generate_qdrant_point_id(
                input[0].as_str().unwrap(),
                input[1].as_str().unwrap(),
                input[2].as_f64().unwrap()
            )),
            "memory_owner" => json!(qdrant_point_belongs_to_memory(
                Some(&input["payload"]),
                input["memoryID"].as_str().unwrap(),
                input["channelID"].as_str().unwrap()
            )),
            "passive_relevant" => json!(is_passive_memory_relevant(
                input["query"].as_str().unwrap(),
                input["summary"].as_str().unwrap(),
                input["score"].as_f64().unwrap()
            )),
            "semantic_limit" => json!(get_semantic_memory_limit_for_tier(
                input["tier"].as_str().unwrap()
            )),
            "semantic_select" => serde_json::to_value(select_semantic_chat_items(
                input["channelID"].as_str().unwrap(),
                input["points"].as_array().unwrap(),
                input["threshold"].as_f64().unwrap(),
                input["limit"].as_u64().unwrap() as usize,
            ))
            .unwrap(),
            "memory_parse" => serde_json::to_value(parse_memory_point(&input["point"])).unwrap(),
            "window_parse" => {
                serde_json::to_value(parse_chat_window_point(&input["point"])).unwrap()
            }
            "embedding_input" => json!(build_memory_embedding_input(
                input["summary"].as_str().unwrap(),
                input["content"].as_str().unwrap()
            )),
            "collection" => serde_json::to_value(if input["kind"] == "chat" {
                twitch_chat_logs_collection()
            } else {
                twitch_channel_memories_collection()
            })
            .unwrap(),
            operation => panic!("unknown oracle operation {operation}"),
        };
        assert_json_parity(
            &actual,
            &case["expected"],
            &format!("case {index}: {}", case["operation"]),
        );
    }
}
fn assert_json_parity(actual: &Value, expected: &Value, path: &str) {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => assert_eq!(a.as_f64(), b.as_f64(), "{path}"),
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                assert_json_parity(a, b, &format!("{path}[{i}]"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: {actual} != {expected}");
            for (key, b) in b {
                assert_json_parity(
                    a.get(key).unwrap_or_else(|| panic!("{path}.{key} missing")),
                    b,
                    &format!("{path}.{key}"),
                );
            }
        }
        _ => assert_eq!(actual, expected, "{path}"),
    }
}

#[tokio::test]
async fn construction_is_pure_and_empty_messages_skip_all_adapters() {
    let backend = Backend::new(vec![]);
    let embeddings = Embeddings::default();
    let language = Language::default();
    let service = QdrantUtilities::new(&backend, &embeddings, &language);
    struct Queue;
    impl ChatEmbeddingQueue for Queue {
        fn add_message(&self, _: QueuedChatMessage) -> Result<(), UtilityError> {
            panic!("queue called")
        }
    }
    let result = service
        .store_chat_message_embedding(&chat("\u{feff} \n"))
        .await;
    assert!(result.error);
    assert_eq!(result.message.as_deref(), Some("Message is empty"));
    assert_eq!(result.embedding_time, None);
    service
        .store_chat_message_embedding_batched(&Queue, &chat("\u{feff}"))
        .await;
    assert!(embeddings.calls.lock().unwrap().is_empty());
    assert!(language.0.lock().unwrap().is_empty());
    backend.done();
}

#[tokio::test]
async fn immediate_write_preserves_text_ids_and_native_integer_payload() {
    let backend = Backend::new(vec![Box::new(|request| {
        let QdrantRequest::Upsert(request) = request else {
            panic!("upsert expected")
        };
        assert_eq!(request.wait, Some(false));
        assert_eq!(request.collection_name, "twitch_chat_logs");
        let point = &request.points[0];
        assert_eq!(
            point.id,
            Some(u64::from(generate_qdrant_point_id("c", "u", 1_700_000_000.0)).into())
        );
        assert_eq!(
            point.payload["timestamp"].kind,
            Some(value::Kind::IntegerValue(1_700_000_000))
        );
        assert_eq!(
            point.payload["message"].as_str().map(String::as_str),
            Some("  raw message  ")
        );
        assert_eq!(
            point.payload["language"].as_str().map(String::as_str),
            Some("fixture-language")
        );
        Ok(QdrantResponse::Done)
    })]);
    let embeddings = Embeddings::default();
    let language = Language::default();
    let result = QdrantUtilities::new(&backend, &embeddings, &language)
        .store_chat_message_embedding(&chat("  raw message  "))
        .await;
    assert!(!result.error);
    assert!(result.total_time.is_some());
    assert_eq!(
        embeddings.calls.lock().unwrap()[0],
        (
            "  raw message  ".into(),
            EMBEDDING_MODEL,
            EmbeddingKind::Document
        )
    );
    backend.done();
}

#[tokio::test]
async fn immediate_embedding_and_backend_errors_have_source_envelopes() {
    let backend = Backend::new(vec![]);
    let language = Language::default();
    let embeddings = Embeddings {
        failure: Some("provider unavailable"),
        ..Default::default()
    };
    let result = QdrantUtilities::new(&backend, &embeddings, &language)
        .store_chat_message_embedding(&chat("message"))
        .await;
    assert_eq!(result.message.as_deref(), Some("provider unavailable"));
    assert!(result.total_time.is_none());
    backend.done();
    let backend = Backend::new(vec![Box::new(|_| Err(UtilityError("offline".into())))]);
    let embeddings = Embeddings::default();
    let result = QdrantUtilities::new(&backend, &embeddings, &language)
        .store_chat_message_embedding(&chat("message"))
        .await;
    assert_eq!(
        result.message.as_deref(),
        Some("Failed to store chat message embedding")
    );
    assert!(result.total_time.is_some());
    backend.done();
}

#[tokio::test]
async fn batched_adapter_preserves_metadata_and_swallows_queue_error() {
    struct Queue(Mutex<Vec<QueuedChatMessage>>);
    impl ChatEmbeddingQueue for Queue {
        fn add_message(&self, message: QueuedChatMessage) -> Result<(), UtilityError> {
            self.0.lock().unwrap().push(message);
            Err(UtilityError("queue rejected".into()))
        }
    }
    let backend = Backend::new(vec![]);
    let embeddings = Embeddings::default();
    let language = Language::default();
    let context = Context::default();
    let queue = Queue(Mutex::new(vec![]));
    QdrantUtilities::new(&backend, &embeddings, &language)
        .with_context(&context)
        .store_chat_message_embedding_batched(&queue, &chat(" raw "))
        .await;
    assert_eq!(queue.0.lock().unwrap()[0].text, " raw ");
    assert_eq!(queue.0.lock().unwrap()[0].language, None);
    assert_eq!(
        *context.errors.lock().unwrap(),
        vec!["storeChatMessageEmbeddingBatched"]
    );
    assert!(embeddings.calls.lock().unwrap().is_empty());
    assert!(language.0.lock().unwrap().is_empty());
    backend.done();
}

#[tokio::test]
async fn semantic_fallback_is_single_embedding_with_scoped_filters_and_metrics() {
    let backend = Backend::new(vec![
        Box::new(|request| {
            let QdrantRequest::Query(q) = request else {
                panic!("query expected")
            };
            assert_eq!(q.limit, Some(9));
            assert_eq!(q.score_threshold, Some(0.75));
            assert_eq!(q.filter.unwrap().must.len(), 1);
            Ok(QdrantResponse::Points(vec![
                json!({"score":0.99,"payload":{"channel_id":"other","message":"wrong channel"}}),
            ]))
        }),
        Box::new(|request| {
            let QdrantRequest::Query(q) = request else {
                panic!("query expected")
            };
            assert_eq!(q.score_threshold, Some(0.69));
            Ok(QdrantResponse::Points(vec![
                json!({"score":0.69,"payload":{"channel_id":"c","message":"  exact boundary  ","timestamp":10}}),
            ]))
        }),
    ]);
    let embeddings = Embeddings::default();
    let language = Language::default();
    let context = Context::default();
    let result = QdrantUtilities::new(&backend, &embeddings, &language)
        .with_context(&context)
        .retrieve_semantic_chat_context(&semantic())
        .await;
    assert!(!result.error);
    assert_eq!(result.selected_pass, SemanticPass::Fallback);
    assert_eq!(result.items[0].message, "exact boundary");
    assert_eq!(result.pass_results[0].raw_matches, 1);
    assert_eq!(result.pass_results[0].kept_matches, 0);
    assert_eq!(embeddings.calls.lock().unwrap().len(), 1);
    assert_eq!(embeddings.calls.lock().unwrap()[0].0, "dragon topic");
    assert_eq!(context.metrics.lock().unwrap()[0].avg_score, 0.69);
    backend.done();
}

#[tokio::test]
async fn primary_match_skips_fallback_and_failure_discards_partial_passes() {
    let backend = Backend::new(vec![Box::new(|_| {
        Ok(QdrantResponse::Points(vec![
            json!({"score":0.8,"payload":{"channel_id":"c","message":"primary"}}),
        ]))
    })]);
    let embeddings = Embeddings::default();
    let language = Language::default();
    let result = QdrantUtilities::new(&backend, &embeddings, &language)
        .retrieve_semantic_chat_context(&semantic())
        .await;
    assert_eq!(result.selected_pass, SemanticPass::High);
    assert_eq!(result.pass_results.len(), 1);
    backend.done();
    let backend = Backend::new(vec![
        Box::new(|_| Ok(QdrantResponse::Points(vec![]))),
        Box::new(|_| Err(UtilityError("unavailable".into()))),
    ]);
    let context = Context::default();
    let result = QdrantUtilities::new(&backend, &embeddings, &language)
        .with_context(&context)
        .retrieve_semantic_chat_context(&semantic())
        .await;
    assert!(result.error);
    assert!(result.pass_results.is_empty());
    assert!(context.metrics.lock().unwrap()[0].failed);
    backend.done();
}

#[tokio::test]
async fn window_paginates_filters_sorts_and_stops_at_zero_offset() {
    let backend = Backend::new(vec![
        Box::new(|request| {
            let QdrantRequest::Scroll(q) = request else {
                panic!("scroll expected")
            };
            assert_eq!(q.limit, Some(4));
            assert!(q.offset.is_none());
            assert_eq!(q.filter.unwrap().must.len(), 2);
            Ok(QdrantResponse::Scroll {
                points: vec![
                    json!({"payload":{"channel_id":"c","message":"later","timestamp":12.9}}),
                    json!({"payload":{"channel_id":"other","message":"wrong","timestamp":11}}),
                ],
                next_offset: Some(99_u64.into()),
            })
        }),
        Box::new(|request| {
            let QdrantRequest::Scroll(q) = request else {
                panic!("scroll expected")
            };
            assert_eq!(q.limit, Some(2));
            assert_eq!(q.offset, Some(99_u64.into()));
            Ok(QdrantResponse::Scroll {
                points: vec![
                    json!({"payload":{"channel_id":"c","message":"first","timestamp":10}}),
                ],
                next_offset: Some(0_u64.into()),
            })
        }),
    ]);
    let embeddings = Embeddings::default();
    let language = Language::default();
    let result = QdrantUtilities::new(&backend, &embeddings, &language)
        .retrieve_channel_chat_window(&ChatWindowParams {
            channel_id: " c ".into(),
            from_unix: 10.9,
            to_unix: 15.9,
            limit: 4.9,
        })
        .await;
    assert!(!result.error);
    assert_eq!(
        result
            .items
            .iter()
            .map(|i| i.message.as_str())
            .collect::<Vec<_>>(),
        vec!["first", "later"]
    );
    assert!(embeddings.calls.lock().unwrap().is_empty());
    backend.done();
}

#[tokio::test]
async fn window_stops_after_twelve_empty_pages_and_clamps_limits() {
    let mut steps: Vec<Step> = vec![];
    for _ in 0..12 {
        steps.push(Box::new(|request| {
            let QdrantRequest::Scroll(q) = request else {
                panic!("scroll expected")
            };
            assert_eq!(q.limit, Some(120));
            Ok(QdrantResponse::Scroll {
                points: vec![],
                next_offset: Some(1_u64.into()),
            })
        }));
    }
    let backend = Backend::new(steps);
    let embeddings = Embeddings::default();
    let language = Language::default();
    let service = QdrantUtilities::new(&backend, &embeddings, &language);
    let result = service
        .retrieve_channel_chat_window(&ChatWindowParams {
            channel_id: "c".into(),
            from_unix: 1.0,
            to_unix: 100.0,
            limit: 99999.0,
        })
        .await;
    assert!(!result.error);
    assert!(result.items.is_empty());
    backend.done();
    let invalid = service
        .retrieve_channel_chat_window(&ChatWindowParams {
            channel_id: "c".into(),
            from_unix: 100.0,
            to_unix: 1.0,
            limit: 0.0,
        })
        .await;
    assert!(invalid.error);
}

#[tokio::test]
async fn memory_upsert_guards_before_embedding_and_preserves_optional_fields() {
    let backend = Backend::new(vec![retrieved(
        json!({"memory_id":"other","channel_id":"c"}),
    )]);
    let embeddings = Embeddings::default();
    let language = Language::default();
    let result = QdrantUtilities::new(&backend, &embeddings, &language)
        .upsert_channel_memory_embedding(&memory())
        .await;
    assert!(result.error);
    assert!(result.message.unwrap().contains("collision"));
    assert!(embeddings.calls.lock().unwrap().is_empty());
    backend.done();
    let backend = Backend::new(vec![
        retrieved(Value::Null),
        Box::new(|request| {
            let QdrantRequest::Upsert(q) = request else {
                panic!("upsert expected")
            };
            assert_eq!(q.wait, Some(true));
            let p = &q.points[0].payload;
            assert!(!p.contains_key("memory_type"));
            assert_eq!(
                p["created_at"].kind,
                Some(value::Kind::IntegerValue(1_700_000_000))
            );
            assert_eq!(p["content"].as_str().map(String::as_str), Some(" body "));
            Ok(QdrantResponse::Done)
        }),
    ]);
    let result = QdrantUtilities::new(&backend, &embeddings, &language)
        .upsert_channel_memory_embedding(&memory())
        .await;
    assert!(!result.error);
    assert_eq!(
        embeddings.calls.lock().unwrap()[0],
        (
            "summary\nbody".into(),
            EMBEDDING_MODEL,
            EmbeddingKind::Document
        )
    );
    backend.done();
}

#[tokio::test]
async fn memory_delete_is_idempotent_guarded_and_retains_legacy_unguarded_path() {
    let backend = Backend::new(vec![
        retrieved(Value::Null),
        retrieved(json!({"memory_id":"other","channel_id":"c"})),
        retrieved(json!({"memory_id":"other","channel_id":"other"})),
        Box::new(|request| {
            let QdrantRequest::Delete(q) = request else {
                panic!("delete expected")
            };
            assert_eq!(q.wait, Some(true));
            Ok(QdrantResponse::Done)
        }),
        Box::new(|request| {
            let QdrantRequest::Delete(q) = request else {
                panic!("delete expected")
            };
            assert_eq!(q.wait, Some(true));
            assert!(matches!(
                q.points.unwrap().points_selector_one_of,
                Some(qdrant_client::qdrant::points_selector::PointsSelectorOneOf::Filter(_))
            ));
            Ok(QdrantResponse::Done)
        }),
    ]);
    let embeddings = Embeddings::default();
    let language = Language::default();
    let service = QdrantUtilities::new(&backend, &embeddings, &language);
    assert!(
        !service
            .delete_channel_memory_embedding(42.0, "c", Some("m"))
            .await
            .error
    );
    assert!(
        service
            .delete_channel_memory_embedding(42.0, "c", Some("m"))
            .await
            .error
    );
    assert!(
        !service
            .delete_channel_memory_embedding(42.0, "c", None)
            .await
            .error
    );
    assert!(
        !service
            .delete_channel_memory_embeddings_by_channel("c")
            .await
            .error
    );
    assert!(
        service
            .delete_channel_memory_embeddings_by_channel("")
            .await
            .error
    );
    backend.done();
}

#[tokio::test]
async fn memory_candidates_apply_lexical_gate_score_and_updated_at_order() {
    let points = vec![
        json!({"id":1,"score":0.6,"payload":{"channel_id":"c","status":"confirmed","content":"body","summary":"dragon mascot","updated_at":1}}),
        json!({"id":2,"score":0.6,"payload":{"channel_id":"c","status":"confirmed","content":"body","summary":"dragon lore","updated_at":2}}),
        json!({"id":3,"score":0.7,"payload":{"channel_id":"c","status":"confirmed","content":"body","summary":"unrelated"}}),
        json!({"id":4,"score":0.72,"payload":{"channel_id":"c","status":"confirmed","content":"body","summary":"unrelated"}}),
        json!({"id":5,"score":0.9,"payload":{"channel_id":"other","status":"confirmed","content":"body"}}),
        json!({"id":6,"score":0.9,"payload":{"channel_id":"c","status":"pending","content":"body"}}),
    ];
    let mut steps: Vec<Step> = vec![];
    for expected_conditions in [3, 2] {
        let points = points.clone();
        steps.push(Box::new(move |request| {
            let QdrantRequest::Query(q) = request else {
                panic!("query expected")
            };
            assert_eq!(q.limit, Some(24));
            assert_eq!(q.filter.unwrap().must.len(), expected_conditions);
            Ok(QdrantResponse::Points(points))
        }));
    }
    let backend = Backend::new(steps);
    let embeddings = Embeddings::default();
    let language = Language::default();
    let service = QdrantUtilities::new(&backend, &embeddings, &language);
    let mut params = RetrieveMemoryContextParams {
        channel_id: "c".into(),
        query: "dragon lore".into(),
        limit: 3,
        min_score: None,
        mode: MemoryRetrievalMode::Passive,
        subject_scope: MemorySubjectScope::Channel,
    };
    let result = service.retrieve_channel_memory_context(&params).await;
    assert_eq!(
        result
            .items
            .iter()
            .map(|i| i.memory_id.as_str())
            .collect::<Vec<_>>(),
        vec!["4", "2", "1"]
    );
    params.min_score = Some(0.55);
    params.subject_scope = MemorySubjectScope::Any;
    let result = service.retrieve_channel_memory_context(&params).await;
    assert_eq!(
        result
            .items
            .iter()
            .map(|i| i.memory_id.as_str())
            .collect::<Vec<_>>(),
        vec!["4", "3", "2"]
    );
    backend.done();
}

#[tokio::test]
async fn explicit_memory_mode_uses_point55_and_any_subject_filter() {
    let backend = Backend::new(vec![Box::new(|request| {
        let QdrantRequest::Query(q) = request else {
            panic!("query expected")
        };
        assert_eq!(q.score_threshold, Some(0.55));
        let filter = q.filter.unwrap();
        assert_eq!(filter.must.len(), 2);
        for condition in filter.must {
            let Some(qdrant_client::qdrant::condition::ConditionOneOf::Field(field)) =
                condition.condition_one_of
            else {
                panic!("field filter expected")
            };
            assert_ne!(field.key, "subject_scope");
        }
        Ok(QdrantResponse::Points(vec![
            json!({"id":1,"score":0.55,"payload":{"channel_id":"c","content":"unrelated user fact","subject_scope":"user"}}),
            json!({"id":2,"score":0.54,"payload":{"channel_id":"c","content":"below threshold"}}),
        ]))
    })]);
    let embeddings = Embeddings::default();
    let language = Language::default();
    let result = QdrantUtilities::new(&backend, &embeddings, &language)
        .retrieve_channel_memory_context(&RetrieveMemoryContextParams {
            channel_id: "c".into(),
            query: "original query".into(),
            limit: 2,
            min_score: None,
            mode: MemoryRetrievalMode::Explicit,
            subject_scope: MemorySubjectScope::Any,
        })
        .await;
    assert!(!result.error);
    assert_eq!(result.items.len(), 1);
    assert_eq!(result.items[0].subject_scope, "user");
    backend.done();
}

#[tokio::test]
async fn memory_validation_empty_content_and_dependency_failures_keep_source_envelopes() {
    let embeddings = Embeddings::default();
    let language = Language::default();
    let backend = Backend::new(vec![]);
    let service = QdrantUtilities::new(&backend, &embeddings, &language);
    for id in [-1.0, 1.5, f64::NAN, f64::INFINITY] {
        let mut params = memory();
        params.qdrant_point_id = id;
        assert_eq!(
            service
                .upsert_channel_memory_embedding(&params)
                .await
                .message
                .as_deref(),
            Some("Missing or invalid qdrantPointID, memoryId, or channelID")
        );
        assert_eq!(
            service
                .delete_channel_memory_embedding(id, "c", Some("m"))
                .await
                .message
                .as_deref(),
            Some("Missing or invalid qdrantPointID")
        );
    }
    backend.done();
    assert!(embeddings.calls.lock().unwrap().is_empty());
    let backend = Backend::new(vec![retrieved(Value::Null)]);
    let mut params = memory();
    params.content = " \u{feff}".into();
    params.summary = "\n".into();
    assert_eq!(
        QdrantUtilities::new(&backend, &embeddings, &language)
            .upsert_channel_memory_embedding(&params)
            .await
            .message
            .as_deref(),
        Some("Memory content is empty")
    );
    backend.done();
    assert!(embeddings.calls.lock().unwrap().is_empty());
    let backend = Backend::new(vec![retrieved(Value::Null)]);
    let provider = Embeddings {
        failure: Some("embedding unavailable"),
        ..Default::default()
    };
    assert_eq!(
        QdrantUtilities::new(&backend, &provider, &language)
            .upsert_channel_memory_embedding(&memory())
            .await
            .message
            .as_deref(),
        Some("embedding unavailable")
    );
    backend.done();
    let backend = Backend::new(vec![
        Box::new(|_| Err(UtilityError("read failed".into()))),
        retrieved(Value::Null),
        Box::new(|_| Err(UtilityError("write failed".into()))),
        Box::new(|_| Err(UtilityError("delete read failed".into()))),
        retrieved(json!({"memory_id":"m","channel_id":"c"})),
        Box::new(|_| Err(UtilityError("delete failed".into()))),
        Box::new(|_| Err(UtilityError("channel delete failed".into()))),
    ]);
    let service = QdrantUtilities::new(&backend, &embeddings, &language);
    for _ in 0..2 {
        assert_eq!(
            service
                .upsert_channel_memory_embedding(&memory())
                .await
                .message
                .as_deref(),
            Some("Failed to upsert channel memory embedding")
        );
    }
    for _ in 0..2 {
        assert_eq!(
            service
                .delete_channel_memory_embedding(42.0, "c", Some("m"))
                .await
                .message
                .as_deref(),
            Some("Failed to delete channel memory embedding")
        );
    }
    assert_eq!(
        service
            .delete_channel_memory_embeddings_by_channel("c")
            .await
            .message
            .as_deref(),
        Some("Failed to delete channel memory embeddings")
    );
    backend.done();
}

#[tokio::test]
async fn memory_retrieval_rejects_missing_input_and_reports_provider_or_query_failure() {
    let mut params = RetrieveMemoryContextParams {
        channel_id: "c".into(),
        query: String::new(),
        limit: 2,
        min_score: None,
        mode: MemoryRetrievalMode::Passive,
        subject_scope: MemorySubjectScope::Channel,
    };
    let backend = Backend::new(vec![]);
    let embeddings = Embeddings::default();
    let language = Language::default();
    let result = QdrantUtilities::new(&backend, &embeddings, &language)
        .retrieve_channel_memory_context(&params)
        .await;
    assert_eq!(
        result.message.as_deref(),
        Some("Missing required parameters")
    );
    backend.done();
    params.query = "query".into();
    let provider = Embeddings {
        failure: Some("embedding unavailable"),
        ..Default::default()
    };
    let result = QdrantUtilities::new(&backend, &provider, &language)
        .retrieve_channel_memory_context(&params)
        .await;
    assert_eq!(result.message.as_deref(), Some("embedding unavailable"));
    backend.done();
    let backend = Backend::new(vec![Box::new(|_| Err(UtilityError("query failed".into())))]);
    let result = QdrantUtilities::new(&backend, &embeddings, &language)
        .retrieve_channel_memory_context(&params)
        .await;
    assert_eq!(
        result.message.as_deref(),
        Some("Failed to retrieve channel memory context")
    );
    backend.done();
}

#[tokio::test]
async fn startup_preserves_existing_policy_and_individual_failure_envelopes() {
    let backend = Backend::new(vec![
        Box::new(|_| Ok(QdrantResponse::Exists(true))),
        Box::new(|_| Err(UtilityError("offline".into()))),
    ]);
    let embeddings = Embeddings::default();
    let language = Language::default();
    let result = QdrantUtilities::new(&backend, &embeddings, &language)
        .start_up()
        .await;
    assert!(!result.error);
    assert_eq!(result.data[0].status, 409);
    assert!(result.data[0].error);
    assert_eq!(result.data[1].status, 500);
    backend.done();
}

#[tokio::test]
async fn new_collection_applies_source_schema_and_default_text_tokenizer() {
    let mut steps: Vec<Step> = vec![
        Box::new(|_| Ok(QdrantResponse::Exists(false))),
        Box::new(|request| {
            let QdrantRequest::CreateCollection(q) = request else {
                panic!("create expected")
            };
            assert!(q.quantization_config.is_some());
            Ok(QdrantResponse::Done)
        }),
    ];
    for index in twitch_chat_logs_collection().payload_indexes {
        steps.push(Box::new(move |request| {
            let QdrantRequest::CreateIndex(q) = request else {
                panic!("index expected")
            };
            assert_eq!(q.field_name, index.field_name);
            assert!(q.field_index_params.is_none());
            Ok(QdrantResponse::Done)
        }));
    }
    let backend = Backend::new(steps);
    let result = create_qdrant_collection(&backend, &twitch_chat_logs_collection()).await;
    assert!(!result.error);
    assert_eq!(result.status, 200);
    backend.done();
}

#[test]
fn payload_numbers_preserve_node_integer_and_double_kinds() {
    use qdrant_client::Payload;
    let payload=Payload::try_from(json!({"integer":qdrant_number_payload(1_700_000_000.0),"fraction":qdrant_number_payload(12.5),
        "large":qdrant_number_payload(9_007_199_254_740_991.0),"negative_zero":qdrant_number_payload(-0.0)})).unwrap();
    let payload: std::collections::HashMap<String, qdrant_client::qdrant::Value> = payload.into();
    assert_eq!(
        payload["integer"].kind,
        Some(value::Kind::IntegerValue(1_700_000_000))
    );
    assert_eq!(
        payload["fraction"].kind,
        Some(value::Kind::DoubleValue(12.5))
    );
    assert_eq!(
        payload["large"].kind,
        Some(value::Kind::IntegerValue(9_007_199_254_740_991))
    );
    assert_eq!(
        payload["negative_zero"].kind,
        Some(value::Kind::IntegerValue(0))
    );
    assert_eq!(
        PointId::from(0_u64).point_id_options,
        Some(point_id::PointIdOptions::Num(0))
    );
}

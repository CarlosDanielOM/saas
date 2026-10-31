#![cfg(feature = "ast-bot-runtime")]
//! Fresh keyword-state behaviour against an in-memory document store.
//!
//! No MongoDB client, network, or Docker is involved. The production read
//! path is [`KeywordStateReader`] plus [`interpret_keyword_document`]; these
//! fixtures supply a [`KeywordDocumentSource`] and record [`KeywordCountSink`]
//! calls. The runtime futures are not `Send`, so the async tests use the
//! current-thread Tokio flavor.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;

use mongodb::bson::{doc, oid::ObjectId, Bson, Document};

use dima_rust::utils::ast_runtime::keyword_state::{
    as_command_store_state, interpret_keyword_document, keyword_state_filter,
    keyword_state_projection, resolve_keyword_object_id, KeywordCountSink, KeywordDocumentSource,
    KeywordState, KeywordStateError, KeywordStateReader, KEYWORD_ACTIVATION,
    KEYWORD_STATE_COLLECTION,
};
use dima_rust::utils::ast_runtime::BoxFuture;

const CHANNEL: &str = "channel-7";
const HEX: &str = "507f1f77bcf86cd799439011";

struct MemoryDocuments {
    queries: Rc<Cell<u32>>,
    seen: Rc<RefCell<Vec<(String, ObjectId)>>>,
    pages: RefCell<VecDeque<Option<Document>>>,
}

impl KeywordDocumentSource for MemoryDocuments {
    fn find_keyword<'a>(
        &'a self,
        channel_id: &'a str,
        id: ObjectId,
    ) -> BoxFuture<'a, Result<Option<Document>, KeywordStateError>> {
        Box::pin(async move {
            self.queries.set(self.queries.get() + 1);
            self.seen
                .borrow_mut()
                .push((channel_id.to_owned(), id));
            Ok(self.pages.borrow_mut().pop_front().flatten())
        })
    }
}

struct RecordingCache {
    calls: Rc<RefCell<Vec<(String, String, f64)>>>,
}

impl KeywordCountSink for RecordingCache {
    fn save_count<'a>(
        &'a self,
        channel_id: &'a str,
        id: &'a str,
        count: f64,
    ) -> BoxFuture<'a, Result<(), KeywordStateError>> {
        Box::pin(async move {
            self.calls
                .borrow_mut()
                .push((channel_id.to_owned(), id.to_owned(), count));
            Ok(())
        })
    }
}

struct Probe {
    queries: Rc<Cell<u32>>,
    seen: Rc<RefCell<Vec<(String, ObjectId)>>>,
    calls: Rc<RefCell<Vec<(String, String, f64)>>>,
    reader: KeywordStateReader<MemoryDocuments, RecordingCache>,
}

fn probe(document: Option<Document>) -> Probe {
    let queries = Rc::new(Cell::new(0));
    let seen = Rc::new(RefCell::new(Vec::new()));
    let calls = Rc::new(RefCell::new(Vec::new()));
    let source = MemoryDocuments {
        queries: Rc::clone(&queries),
        seen: Rc::clone(&seen),
        pages: RefCell::new(VecDeque::from([document])),
    };
    let cache = RecordingCache {
        calls: Rc::clone(&calls),
    };
    Probe {
        queries,
        seen,
        calls,
        reader: KeywordStateReader::new(source, cache),
    }
}

fn enabled_state(result: Result<KeywordState, KeywordStateError>) -> KeywordState {
    match result {
        Ok(state) => state,
        Err(error) => panic!("expected an enabled keyword, got {error}"),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn enabled_keyword_returns_its_count() {
    let stored = probe(Some(doc! { "enabled": true, "count": 6.5 }));
    let state = enabled_state(stored.reader.keyword_state(CHANNEL, HEX).await);
    assert!(state.enabled);
    assert_eq!(state.count, 6.5);
    assert_eq!(stored.queries.get(), 1);
    let seen = stored.seen.borrow();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].0, CHANNEL);
    assert_eq!(seen[0].1.to_hex(), HEX);
    assert!(stored.calls.borrow().is_empty());

    let missing_count = probe(Some(doc! { "enabled": true }));
    let state = enabled_state(missing_count.reader.keyword_state(CHANNEL, HEX).await);
    assert_eq!(state.count, 0.0);

    let integer = probe(Some(doc! { "enabled": true, "count": 8 }));
    let state = enabled_state(integer.reader.keyword_state(CHANNEL, HEX).await);
    assert_eq!(state.count, 8.0);
}

#[tokio::test(flavor = "current_thread")]
async fn missing_keyword_is_not_found_and_distinct_from_disabled() {
    let missing = probe(None);
    match missing.reader.keyword_state(CHANNEL, HEX).await {
        Err(KeywordStateError::NotFound) => {}
        other => panic!("expected not found, got {other:?}"),
    }
    assert_eq!(missing.queries.get(), 1);
    assert_ne!(
        KeywordStateError::NotFound.to_string(),
        KeywordStateError::Disabled.to_string()
    );
    assert!(KeywordStateError::NotFound.to_string().contains("not found"));
    assert!(KeywordStateError::Disabled.to_string().contains("disabled"));
}

#[tokio::test(flavor = "current_thread")]
async fn disabled_keyword_does_not_expose_its_count() {
    let disabled = probe(Some(doc! { "enabled": false, "count": 99.0 }));
    match disabled.reader.keyword_state(CHANNEL, HEX).await {
        Err(error @ KeywordStateError::Disabled) => {
            assert!(!error.to_string().contains("99"));
        }
        other => panic!("expected disabled, got {other:?}"),
    }
    assert_eq!(disabled.queries.get(), 1);

    let missing_flag = probe(Some(doc! { "count": 99.0 }));
    match missing_flag.reader.keyword_state(CHANNEL, HEX).await {
        Err(KeywordStateError::Disabled) => {}
        other => panic!("missing enabled must be disabled, got {other:?}"),
    }

    let stale = probe(Some(doc! { "enabled": false, "count": "stale" }));
    match stale.reader.keyword_state(CHANNEL, HEX).await {
        Err(KeywordStateError::Disabled) => {}
        other => panic!("disabled must ignore a non-numeric count, got {other:?}"),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn unresolved_identifier_does_not_query() {
    let probe = probe(Some(doc! { "enabled": true, "count": 6.5 }));
    let cases = [
        ("", KeywordStateError::MISSING_EMPTY_ID),
        (
            r#"{"$oid":"507f1f77bcf86cd799439011"}"#,
            KeywordStateError::MISSING_EXTENDED_JSON,
        ),
        ("not-an-object-id", KeywordStateError::MISSING_HEX),
    ];
    for (id, missing) in cases {
        match probe.reader.keyword_state(CHANNEL, id).await {
            Err(KeywordStateError::IdentifierUnresolved {
                id: received,
                missing: reason,
            }) => {
                assert_eq!(received, id);
                assert_eq!(reason, missing);
            }
            other => panic!("expected an identifier error for {id:?}, got {other:?}"),
        }
    }
    assert_eq!(probe.queries.get(), 0);
    assert!(probe.seen.borrow().is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn save_keyword_count_delegates_the_same_arguments() {
    let probe = probe(None);
    if let Err(error) = probe
        .reader
        .save_keyword_count(CHANNEL, HEX, 4.5)
        .await
    {
        panic!("count write failed: {error}");
    }
    if let Err(error) = probe
        .reader
        .save_keyword_count("other-channel", "not-hex", -1.0)
        .await
    {
        panic!("count write failed: {error}");
    }
    assert_eq!(probe.queries.get(), 0);
    assert_eq!(
        probe.calls.borrow().as_slice(),
        [
            (CHANNEL.to_owned(), HEX.to_owned(), 4.5),
            ("other-channel".to_owned(), "not-hex".to_owned(), -1.0),
        ]
        .as_slice()
    );
}

#[test]
fn filter_matches_channel_object_id_and_keyword_activation() {
    let id = match resolve_keyword_object_id(HEX) {
        Ok(id) => id,
        Err(error) => panic!("executor hex was rejected: {error}"),
    };
    assert_eq!(id.to_hex(), HEX);
    let filter = keyword_state_filter(CHANNEL, id);
    assert_eq!(filter.len(), 3);
    match filter.get("channelID") {
        Some(Bson::String(value)) => assert_eq!(value, CHANNEL),
        other => panic!("channelID was {other:?}"),
    }
    match filter.get("activation") {
        Some(Bson::String(value)) => assert_eq!(value, KEYWORD_ACTIVATION),
        other => panic!("activation was {other:?}"),
    }
    match filter.get("_id") {
        Some(Bson::ObjectId(found)) => assert_eq!(*found, id),
        other => panic!("_id was {other:?}, not an ObjectId"),
    }
    assert!(filter.get("enabled").is_none());
    assert!(filter.get("count").is_none());
    assert!(filter.get("cmd").is_none());
    assert_eq!(KEYWORD_STATE_COLLECTION, "commands");
    assert_eq!(KEYWORD_ACTIVATION, "keyword");

    let projection = keyword_state_projection();
    assert_eq!(projection.len(), 3);
    assert!(matches!(projection.get("count"), Some(Bson::Int32(1))));
    assert!(matches!(projection.get("enabled"), Some(Bson::Int32(1))));
    assert!(matches!(projection.get("_id"), Some(Bson::Int32(0))));
}

#[test]
fn decision_treats_not_found_disabled_and_count_separately() {
    match interpret_keyword_document(None) {
        Err(KeywordStateError::NotFound) => {}
        other => panic!("missing document was {other:?}"),
    }
    let enabled = doc! { "enabled": true, "count": 6.5 };
    match interpret_keyword_document(Some(&enabled)) {
        Ok(state) => {
            assert!(state.enabled);
            assert_eq!(state.count, 6.5);
        }
        Err(error) => panic!("enabled double was rejected: {error}"),
    }
    let missing_count = doc! { "enabled": true };
    match interpret_keyword_document(Some(&missing_count)) {
        Ok(state) => assert_eq!(state.count, 0.0),
        Err(error) => panic!("nullish count was rejected: {error}"),
    }
    let null_count = doc! { "enabled": true, "count": Bson::Null };
    match interpret_keyword_document(Some(&null_count)) {
        Ok(state) => assert_eq!(state.count, 0.0),
        Err(error) => panic!("null count was rejected: {error}"),
    }
    let disabled = doc! { "enabled": false, "count": "stale" };
    match interpret_keyword_document(Some(&disabled)) {
        Err(KeywordStateError::Disabled) => {}
        other => panic!("disabled document was {other:?}"),
    }
    let bad_flag = doc! { "enabled": "yes", "count": 1.0 };
    match interpret_keyword_document(Some(&bad_flag)) {
        Err(KeywordStateError::Mongo(message)) => {
            assert!(message.contains("not a boolean"));
        }
        other => panic!("non-boolean enabled was {other:?}"),
    }
    let bad_count = doc! { "enabled": true, "count": "nope" };
    match interpret_keyword_document(Some(&bad_count)) {
        Err(KeywordStateError::Mongo(message)) => {
            assert!(message.contains("not a BSON number"));
        }
        other => panic!("non-numeric count was {other:?}"),
    }

    let enabled = KeywordState {
        enabled: true,
        count: 6.5,
    };
    assert_eq!(
        as_command_store_state(Ok(enabled)).ok(),
        Some(Some((true, 6.5)))
    );
    assert_eq!(
        as_command_store_state(Err(KeywordStateError::NotFound)).ok(),
        Some(None)
    );
    assert_eq!(
        as_command_store_state(Err(KeywordStateError::Disabled)).ok(),
        Some(None)
    );
    assert!(matches!(
        as_command_store_state(Err(KeywordStateError::Mongo("down".to_owned()))),
        Err(KeywordStateError::Mongo(_))
    ));
}

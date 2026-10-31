#![cfg(feature = "overlays-runtime")]
//! Source parity for the available clip-presence portion of live.ts.
//! Central module/feature wiring is supplied by the integrator.

use std::sync::{atomic::{AtomicUsize, Ordering}, Mutex};

use dima_rust::overlays::source_activation::{
    mark_clip_source_connected, ClipPresenceStore, PresenceFuture,
};

#[derive(Default)]
struct RecordingStore {
    attempts: Mutex<Vec<(String, String)>>,
    fail_at: Option<usize>,
}

impl ClipPresenceStore for RecordingStore {
    fn set<'a>(&'a self, key: &'a str, value: &'a str) -> PresenceFuture<'a> {
        Box::pin(async move {
            let mut attempts = self.attempts.lock().unwrap();
            attempts.push((key.to_owned(), value.to_owned()));
            if self.fail_at == Some(attempts.len()) {
                return Err("set failed".into());
            }
            Ok(())
        })
    }
}

#[tokio::test]
async fn presence_writes_match_source_order_values_and_channel() {
    let store = RecordingStore::default();
    let clock_calls = AtomicUsize::new(0);
    mark_clip_source_connected(&store, "channel:42", || {
        clock_calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(store.attempts.lock().unwrap().len(), 1);
        1_700_000_000_123
    }).await.unwrap();
    assert_eq!(*store.attempts.lock().unwrap(), vec![
        ("twitch:channel:42:clips:connected".into(), "true".into()),
        ("twitch:channel:42:clips:last_activity".into(), "1700000000123".into()),
    ]);
    assert_eq!(clock_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn first_failure_skips_clock_and_second_write() {
    let store = RecordingStore { fail_at: Some(1), ..Default::default() };
    let clock_calls = AtomicUsize::new(0);
    let error = mark_clip_source_connected(&store, "one", || {
        clock_calls.fetch_add(1, Ordering::SeqCst);
        123
    }).await.unwrap_err();
    assert_eq!(error, "set failed");
    assert_eq!(*store.attempts.lock().unwrap(), vec![("twitch:one:clips:connected".into(), "true".into())]);
    assert_eq!(clock_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn second_failure_is_returned_after_first_write_and_retry_repeats_both() {
    let failing = RecordingStore { fail_at: Some(2), ..Default::default() };
    assert_eq!(mark_clip_source_connected(&failing, "two", || 123).await.unwrap_err(), "set failed");
    assert_eq!(*failing.attempts.lock().unwrap(), vec![
        ("twitch:two:clips:connected".into(), "true".into()),
        ("twitch:two:clips:last_activity".into(), "123".into()),
    ]);
    mark_clip_source_connected(&failing, "two", || 456).await.unwrap();
    assert_eq!(*failing.attempts.lock().unwrap(), vec![
        ("twitch:two:clips:connected".into(), "true".into()),
        ("twitch:two:clips:last_activity".into(), "123".into()),
        ("twitch:two:clips:connected".into(), "true".into()),
        ("twitch:two:clips:last_activity".into(), "456".into()),
    ]);
}

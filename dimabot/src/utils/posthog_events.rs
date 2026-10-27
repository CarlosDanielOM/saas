//! PostHog product analytics, mirroring `dimabot/src/utils/posthog_events.ts`.
//!
//! The TypeScript client hard-codes the public project key and US host, and
//! batches with `flushAt: 20` and `flushInterval: 1000`. [`client_options`]
//! keeps those values. posthog-rs stamps `$is_server: true` by default;
//! posthog-node does not, so it is turned off to keep the same event shape.
//!
//! posthog-rs has no `identify` call. [`identify_event`] builds the same
//! `$identify` event posthog-node sends (`$set` plus an empty `$set_once`), and
//! [`StreamerIdentities`] keeps the TypeScript rule of identifying a channel
//! only on first sight in this process or after a rename.
//!
//! The client sends from a background thread with a blocking HTTP client.
//! Create it inside the long-lived Tokio runtime and call `shutdown().await`
//! (or `flush().await`) before exit so buffered events are delivered.

use std::{collections::HashMap, sync::Mutex};

use posthog_rs::{Client, ClientOptions, ClientOptionsBuilder, Event};
use serde_json::{Map, Value, json};
use tokio::sync::OnceCell;

pub use crate::utils::POSTHOG_PROJECT_KEY;
/// Same US ingestion host as the TypeScript client.
pub const POSTHOG_HOST: &str = "https://us.i.posthog.com";
/// `flushAt` in the TypeScript client.
pub const FLUSH_AT: usize = 20;
/// `flushInterval` in the TypeScript client, in milliseconds.
pub const FLUSH_INTERVAL_MS: u64 = 1_000;

static CLIENT: OnceCell<Client> = OnceCell::const_new();

/// Builds options with the TypeScript batching settings for `host`.
pub fn client_options(api_key: &str, host: &str) -> ClientOptions {
    ClientOptionsBuilder::default()
        .api_key(api_key.to_owned())
        .host(host)
        .flush_at(FLUSH_AT)
        .flush_interval_ms(FLUSH_INTERVAL_MS)
        .is_server(false)
        .build()
        .expect("static PostHog options are valid")
}

/// Returns the process-wide client for the production project.
pub async fn get_posthog_client() -> &'static Client {
    CLIENT
        .get_or_init(|| posthog_rs::client(client_options(POSTHOG_PROJECT_KEY, POSTHOG_HOST)))
        .await
}

/// Builds the `$identify` event posthog-node sends for `identify()`.
pub fn identify_event(distinct_id: &str, set: Map<String, Value>) -> Event {
    let mut event = Event::new("$identify", distinct_id);
    event
        .insert_prop("$set", Value::Object(set))
        .expect("JSON objects serialize");
    event
        .insert_prop("$set_once", json!({}))
        .expect("JSON objects serialize");
    event
}

/// Remembers which channel name was last identified per channel ID.
#[derive(Debug, Default)]
pub struct StreamerIdentities {
    seen: Mutex<HashMap<String, String>>,
}

impl StreamerIdentities {
    /// Returns the `$identify` event to send, or `None` when either value is
    /// empty or this channel was already identified with the same name.
    pub fn identify(&self, channel_id: &str, channel_name: &str) -> Option<Event> {
        if channel_id.is_empty() || channel_name.is_empty() {
            return None;
        }
        let mut seen = self
            .seen
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if seen
            .get(channel_id)
            .is_some_and(|name| name == channel_name)
        {
            return None;
        }
        seen.insert(channel_id.to_owned(), channel_name.to_owned());
        let mut set = Map::new();
        set.insert("channel_name".to_owned(), Value::from(channel_name));
        Some(identify_event(channel_id, set))
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::utils::test_http::{CannedResponse, Recorder};

    #[test]
    fn identifies_once_per_channel_name() {
        let identities = StreamerIdentities::default();
        assert!(identities.identify("", "name").is_none());
        assert!(identities.identify("123", "").is_none());
        assert!(identities.identify("123", "first").is_some());
        assert!(identities.identify("123", "first").is_none());
        assert!(identities.identify("123", "renamed").is_some());
        assert!(identities.identify("456", "first").is_some());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batches_identify_and_capture_like_posthog_node() {
        let recorder = Recorder::start(|_| CannedResponse::json(200, r#"{"status":1}"#));
        let client = posthog_rs::client(client_options("phc_test", &recorder.base_url)).await;

        let identities = StreamerIdentities::default();
        client.capture(identities.identify("123", "streamer").unwrap());
        let mut command = Event::new("command_executed", "123");
        command.insert_prop("command", "!hello").unwrap();
        client.capture(command);
        client.flush().await;

        let request = recorder.next(Duration::from_secs(20));
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/batch/");
        let body: Value = serde_json::from_slice(&request.body).expect("JSON batch");
        assert_eq!(body["api_key"], "phc_test");
        let events = body["batch"].as_array().expect("batch array");
        assert_eq!(events.len(), 2);

        let identify = &events[0];
        assert_eq!(identify["event"], "$identify");
        assert_eq!(identify["distinct_id"], "123");
        assert_eq!(
            identify["properties"]["$set"],
            json!({"channel_name": "streamer"})
        );
        assert_eq!(identify["properties"]["$set_once"], json!({}));
        assert!(identify["properties"].get("$is_server").is_none());

        assert_eq!(events[1]["event"], "command_executed");
        assert_eq!(events[1]["properties"]["command"], "!hello");
        client.shutdown().await;
    }
}

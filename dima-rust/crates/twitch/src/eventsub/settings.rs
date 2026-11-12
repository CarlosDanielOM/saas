//! The typed configuration of subscription management. The crate never reads the environment:
//! a binary builds [`EventsubSettings`] once at start-up (from `TWITCH_EVENTSUB_SECRET`; the
//! reference has the callback as a literal) and the constructor validates it.
//!
//! | Setting | Value | Source |
//! |---|---|---|
//! | `callback` | `https://subscriptions.domdimabot.com/eventsub` | the literal of `subscribeTwitchEvent` |
//! | `secret` | `TWITCH_EVENTSUB_SECRET` | an empty or missing secret makes every create answer the reference's 500 |
//! | `request_timeout` | 30 s | none in the reference (`fetch` without a signal); generous, fires only on a hang |
//! | `max_pages` | 1000 | the page cap of `getEventsubs` (100 subscriptions a page) |

use dima_core::SecretString;
use serde_json::{Value, json};
use std::fmt;
use std::time::Duration;

use super::condition::Condition;

/// The reference's webhook callback.
pub const REFERENCE_CALLBACK: &str = "https://subscriptions.domdimabot.com/eventsub";

/// Why the settings were refused.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SettingsError {
    /// The callback is not an `https` URL on port 443 without credentials (Twitch's rule).
    #[error("the EventSub callback must be an https URL on port 443")]
    Callback,
    /// The secret is not 10 to 100 ASCII characters (Twitch refuses every create otherwise).
    #[error("the EventSub secret must be 10 to 100 ASCII characters")]
    Secret,
}

/// How subscriptions are created and listed.
#[derive(Clone)]
pub struct EventsubSettings {
    callback: String,
    secret: Option<SecretString>,
    /// The deadline of each Twitch request.
    pub request_timeout: Duration,
    /// The most pages one listing reads (100 subscriptions each).
    pub max_pages: u32,
}

impl fmt::Debug for EventsubSettings {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EventsubSettings")
            .field("callback", &self.callback)
            .field("secret", &self.secret.as_ref().map(|_| "<redacted>"))
            .field("request_timeout", &self.request_timeout)
            .field("max_pages", &self.max_pages)
            .finish()
    }
}

impl EventsubSettings {
    /// Settings for `callback` with `secret` (`None`, or an empty text, is "not configured":
    /// every create then answers `EventSub secret is not configured`, as the reference does).
    pub fn new(callback: &str, secret: Option<SecretString>) -> Result<Self, SettingsError> {
        let url = url::Url::parse(callback).map_err(|_| SettingsError::Callback)?;
        if url.scheme() != "https"
            || url.host_str().is_none_or(str::is_empty)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some_and(|port| port != 443)
        {
            return Err(SettingsError::Callback);
        }
        let secret = secret.filter(|secret| !secret.expose().is_empty());
        if let Some(secret) = &secret {
            let text = secret.expose();
            let count = text.chars().count();
            if !(10..=100).contains(&count) || !text.is_ascii() {
                return Err(SettingsError::Secret);
            }
        }
        Ok(Self {
            callback: callback.to_owned(),
            secret,
            request_timeout: Duration::from_secs(30),
            max_pages: 1000,
        })
    }

    /// The reference's callback with `secret`.
    pub fn reference(secret: Option<SecretString>) -> Result<Self, SettingsError> {
        Self::new(REFERENCE_CALLBACK, secret)
    }

    /// The webhook callback.
    pub fn callback(&self) -> &str {
        &self.callback
    }

    /// Whether a secret is configured.
    pub fn has_secret(&self) -> bool {
        self.secret.is_some()
    }

    /// The create request's body (`JSON.stringify({type, version, condition, transport})`), or
    /// `None` without a secret. The value holds the secret: send it, never log it.
    pub fn create_body(&self, kind: &str, version: &str, condition: &Condition) -> Option<Value> {
        let secret = self.secret.as_ref()?;
        Some(json!({
            "type": kind,
            "version": version,
            "condition": condition.to_value(),
            "transport": {
                "method": "webhook",
                "callback": self.callback,
                "secret": secret.expose(),
            }
        }))
    }

    /// Whether a listed subscription was created by this backend: a webhook to this callback.
    /// Anything else under the client id (another callback, a WebSocket or conduit transport)
    /// is foreign and is never deleted here.
    pub fn owns(&self, transport: &Value) -> bool {
        transport.get("method").and_then(Value::as_str) == Some("webhook")
            && transport.get("callback").and_then(Value::as_str) == Some(self.callback.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_are_validated() {
        let secret = || Some(SecretString::from("0123456789abcdef"));
        assert!(EventsubSettings::reference(secret()).is_ok());
        assert!(EventsubSettings::reference(None).is_ok_and(|s| !s.has_secret()));
        assert!(
            EventsubSettings::reference(Some(SecretString::from("")))
                .is_ok_and(|s| !s.has_secret())
        );
        assert_eq!(
            EventsubSettings::reference(Some(SecretString::from("short"))).err(),
            Some(SettingsError::Secret)
        );
        assert_eq!(
            EventsubSettings::reference(Some(SecretString::from("ñ123456789012"))).err(),
            Some(SettingsError::Secret)
        );
        for bad in [
            "http://subscriptions.domdimabot.com/eventsub",
            "https://user:pw@example.com/eventsub",
            "https://example.com:8443/eventsub",
            "not a url",
        ] {
            assert_eq!(
                EventsubSettings::new(bad, secret()).err(),
                Some(SettingsError::Callback),
                "{bad}"
            );
        }
        let settings = EventsubSettings::reference(secret()).ok();
        let debug = format!("{settings:?}");
        assert!(!debug.contains("0123456789abcdef"), "{debug}");
        assert!(settings.as_ref().is_some_and(|s| {
            s.owns(&json!({"method": "webhook", "callback": REFERENCE_CALLBACK}))
        }));
        assert!(
            settings
                .as_ref()
                .is_some_and(|s| !s.owns(&json!({"method": "websocket", "session_id": "x"})))
        );
        assert!(settings.as_ref().is_some_and(|s| {
            !s.owns(&json!({"method": "webhook", "callback": "https://dev.example/eventsub"}))
        }));
    }
}

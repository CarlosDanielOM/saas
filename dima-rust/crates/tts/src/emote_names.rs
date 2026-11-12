//! Global names cache: EX 3600 on success, EX 60 on provider failure. Channel names reuse
//! dima-twitch's catalogue. Cache errors degrade to no global names. One global load at a time.
//! The global response is capped at 2MiB and 20,000 names; this adds a safety bound.
use dima_store::dragonfly::{Dragonfly, SetOptions};
use dima_twitch::{Auth, HelixRequest, Twitch};
use serde_json::Value;
use std::time::Duration;
pub struct Emotes {
    pub twitch: Twitch,
    pub store: Dragonfly,
    flight: tokio::sync::Mutex<()>,
}
impl Emotes {
    pub fn new(twitch: Twitch, store: Dragonfly) -> Self {
        Self {
            twitch,
            store,
            flight: tokio::sync::Mutex::new(()),
        }
    }
    async fn global(&self) -> Vec<String> {
        let _guard = self.flight.lock().await;
        let key = "twitch:global:tts:emotes";
        match self.store.get(key).await {
            Ok(Some(raw)) => {
                // JSON.parse failures leave the reference's outer cache block immediately.
                let value = match serde_json::from_slice::<Value>(&raw) {
                    Ok(value) => value,
                    Err(_) => return Vec::new(),
                };
                if let Ok(names) = serde_json::from_value::<Vec<String>>(value)
                    && names.len() <= 20_000
                {
                    return names;
                }
            }
            Err(_) => return Vec::new(),
            _ => {}
        }
        let answer = self
            .twitch
            .helix(
                HelixRequest::get(dima_http::Path::fixed("/chat/emotes/global"), Auth::App)
                    .timeout(Duration::from_secs(3)),
            )
            .await;
        let mut success = false;
        let mut names = Vec::new();
        if let Ok(answer) = answer {
            let ok = answer.status().is_success();
            if let Ok(body) = answer
                .into_response()
                .max_bytes(2 * 1024 * 1024)
                .json::<Value>()
                .await
                && ok
                && let Some(data) = body["data"].as_array().filter(|a| a.len() <= 20_000)
            {
                names = data
                    .iter()
                    .filter_map(|v| v["name"].as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect();
                success = true;
            }
        }
        if let Ok(raw) = serde_json::to_vec(&names)
            && self
                .store
                .set(key, &raw, SetOptions::ex(if success { 3600 } else { 60 }))
                .await
                .is_err()
        {
            return Vec::new();
        }
        names
    }
}
impl crate::default_queue::EmoteNames for Emotes {
    async fn names(&self, channel: &str) -> Vec<String> {
        let (mut names, channel) =
            tokio::join!(self.global(), self.twitch.channel_emote_catalog(channel));
        for emote in channel.emotes {
            if !names.contains(&emote.name) {
                names.push(emote.name);
            }
        }
        names
    }
}
/// EventSub gives exact emote text; no offset conversion is needed.
pub fn from_event(event: &Value) -> Option<Vec<String>> {
    Some(
        event
            .get("message")?
            .get("fragments")?
            .as_array()?
            .iter()
            .filter(|v| v["type"] == "emote")
            .filter_map(|v| v["text"].as_str().map(str::to_owned))
            .collect(),
    )
}

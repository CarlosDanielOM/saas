//! Swappable studio producer dispatch from `bridge.ts`.
//! A caller-owned handle starts without a bridge and returns the source's safe
//! defaults; registration replaces the dispatch target without import-time I/O.

use std::{future::Future, pin::Pin, sync::{Arc, RwLock}};
use crate::utils::lossless_json::JsonValue;
use super::controls::OverlayPlatform;
use super::{delivery_store::{DeliveryRepository, MongoDeliveryStore, DELIVERY_TTL_MS, MAX_PENDING}, live::{LiveCore, PendingDelivery, PeerTransport, SocketTransport, SpeechOwnership}};

/// Asynchronous bridge operation result.
pub type BridgeFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
/// Read-TTS publication outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadTtsPublication { /// A source received the event.
    Emitted, /// No eligible source was available.
    Unavailable, /// The producer cancelled the publication.
    Cancelled }
/// A TTS publication request; callback hooks are evaluated by the adapter.
#[derive(Clone)]
pub struct ReadTtsDelivery {
    /// Speech correlation ID.
    pub speech_id: String,
    /// Duration hint in milliseconds.
    pub duration_ms: f64,
    /// Caption text.
    pub text: String,
    /// Whether the producer is legacy.
    pub legacy: bool,
    /// Optional retained source path.
    pub file: Option<String>,
    /// Optional media MIME type.
    pub mime: Option<String>,
    /// Optional callback immediately before emission.
    pub before_emit: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    /// Optional cancellation callback.
    pub cancelled: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}
/// Aggregate source playback status.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TtsStatus { /// Whether a source is connected.
    pub connected: bool, /// Whether speech is playing.
    pub playing: bool, /// Number of queued speech items.
    pub queue_length: usize }
/// Media publication arguments.
#[derive(Clone, Debug, PartialEq)]
pub struct MediaPublication { /// Clip or TTS event kind.
    pub kind: String, /// Media metadata.
    pub media: JsonValue, /// Source file path.
    pub file: String, /// MIME type.
    pub mime: String, /// Optional caption.
    pub text: Option<String>, /// Optional origin platform.
    pub platform: Option<OverlayPlatform>, /// Optional speech ID.
    pub speech_id: Option<String> }
/// Studio implementation registered by the composition root.
pub trait Bridge: Send + Sync {
    /// Enumerate queue channels, retaining disconnected entries as `None`.
    fn queue_channels(&self) -> Option<Vec<Option<String>>> { None }
    /// Publish speech or report its unavailable default.
    fn read_tts<'a>(&'a self, _channel: &'a str, _input: ReadTtsDelivery) -> BridgeFuture<'a, ReadTtsPublication> { Box::pin(async { ReadTtsPublication::Unavailable }) }
    /// End a speech publication.
    fn end_read_tts<'a>(&'a self, _channel: &'a str, _speech_id: &'a str) -> BridgeFuture<'a, ()> { Box::pin(async {}) }
    /// Live source availability; omitted implementations use `has_source`.
    fn has_live_source(&self, channel: &str, kind: &str) -> bool { self.has_source(channel, kind) }
    /// Source availability including reconnecting peers.
    fn has_source(&self, channel: &str, kind: &str) -> bool;
    /// Publish retained media.
    fn media<'a>(&'a self, channel: &'a str, input: MediaPublication) -> BridgeFuture<'a, ()>;
    /// Publish a trigger; the absence of a bridge returns `None`.
    fn trigger<'a>(&'a self, channel: &'a str, body: JsonValue, platform: Option<OverlayPlatform>) -> BridgeFuture<'a, ()>;
    /// Control active TTS.
    fn control_tts<'a>(&'a self, _channel: &'a str, _action: &'a str) -> BridgeFuture<'a, ()> { Box::pin(async {}) }
    /// Query TTS playback status.
    fn tts_status<'a>(&'a self, _channel: &'a str, _speech_id: Option<&'a str>) -> BridgeFuture<'a, TtsStatus> { Box::pin(async { TtsStatus::default() }) }
}
/// Default bridge with no live source and no side effects.
pub struct NoBridge;
impl Bridge for NoBridge {
    fn has_source(&self, _: &str, _: &str) -> bool { false }
    fn media<'a>(&'a self, _: &'a str, _: MediaPublication) -> BridgeFuture<'a, ()> { Box::pin(async {}) }
    fn trigger<'a>(&'a self, _: &'a str, _: JsonValue, _: Option<OverlayPlatform>) -> BridgeFuture<'a, ()> { Box::pin(async {}) }
}
/// Native studio dispatch over the shared live core, Mongo store and sockets.
/// Construction only retains supplied application handles and performs no I/O.
pub struct NativeBridge {
    core: Arc<std::sync::Mutex<LiveCore>>,
    store: MongoDeliveryStore,
    transport: SocketTransport,
    writes: Arc<tokio::sync::Mutex<()>>,
    cancelled_speech: std::sync::Mutex<std::collections::BTreeSet<(String, String)>>,
}
impl NativeBridge {
    /// Bind the same core and transport used by `register_socket_namespace`.
    pub fn new(core: Arc<std::sync::Mutex<LiveCore>>, store: MongoDeliveryStore, transport: SocketTransport, writes: Arc<tokio::sync::Mutex<()>>) -> Self {
        Self { core, store, transport, writes, cancelled_speech: std::sync::Mutex::new(std::collections::BTreeSet::new()) }
    }
    fn recipients(&self, channel: &str, kind: &str) -> Vec<String> {
        self.core.lock().map(|core| core.peers.iter().filter(|(_, peer)| peer.channel == channel && peer.disconnected_at.is_none() && peer.scopes.contains(kind)).map(|(key, _)| key.clone()).collect()).unwrap_or_default()
    }
    async fn publish(&self, channel: &str, kind: &str, event: JsonValue, media: Option<(&str, u64, &str)>) -> bool {
        use mongodb::bson::{doc, DateTime};
        let _write = self.writes.lock().await;
        let selected = self.recipients(channel, kind);
        if selected.is_empty() { return false; }
        if self.core.lock().map(|core| selected.iter().any(|key| core.pending.iter().filter(|item| item.recipients.contains(key)).count() >= MAX_PENDING)).unwrap_or(true) { return false; }
        let id = match &event { JsonValue::Object(fields) => fields.iter().find(|(key, _)| key.as_str() == Some("id")).and_then(|(_, value)| match value { JsonValue::String(id) => id.as_str(), _ => None }).map(str::to_owned), _ => None };
        let Some(id) = id else { return false };
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|duration| duration.as_millis().min(i64::MAX as u128) as i64).unwrap_or(0);
        let expires = now.saturating_add(DELIVERY_TTL_MS);
        let mut saved = doc! { "_id": &id, "channel": channel, "event": crate::utils::bson_json::json_bson(&event), "recipients": selected.clone(), "expiresAt": DateTime::from_millis(expires) };
        if let Some((media_id, bytes, mime)) = media { saved.insert("mediaId", media_id); saved.insert("bytes", bytes as i64); saved.insert("mime", mime); }
        if self.store.put_record(false, &id, saved).await.is_err() { return false; }
        let platform = match &event { JsonValue::Object(fields) => fields.iter().find(|(key, _)| key.as_str() == Some("platform")).and_then(|(_, value)| match value { JsonValue::String(value) => value.as_str(), _ => None }), _ => None };
        let platform = match platform { Some("kick") => OverlayPlatform::Kick, Some("other") => OverlayPlatform::Other, _ => OverlayPlatform::Twitch };
        let item = PendingDelivery { id: id.clone(), channel: channel.to_owned(), kind: kind.to_owned(), platform, event: event.clone(), recipients: selected.iter().cloned().collect(), tts: kind == "tts" };
        if !self.core.lock().map(|mut core| core.enqueue(item, expires)).unwrap_or(false) { let _ = self.store.delete_record(false, &id).await; return false; }
        for key in selected { let _ = self.transport.emit(&key, "overlay-event", &event); }
        true
    }
}
impl Bridge for NativeBridge {
    fn queue_channels(&self) -> Option<Vec<Option<String>>> {
        self.core.lock().ok().map(|core| core.peers.values().map(|peer| if peer.disconnected_at.is_none() { Some(peer.channel.clone()) } else { None }).collect())
    }
    fn has_source(&self, channel: &str, kind: &str) -> bool { !self.recipients(channel, kind).is_empty() }
    fn read_tts<'a>(&'a self, channel: &'a str, input: ReadTtsDelivery) -> BridgeFuture<'a, ReadTtsPublication> {
        Box::pin(async move {
            use mongodb::bson::{doc, DateTime, Document};
            let marker = (channel.to_owned(), input.speech_id.clone());
            if let Ok(mut cancelled) = self.cancelled_speech.lock() { cancelled.remove(&marker); }
            let cancelled = || input.cancelled.as_ref().is_some_and(|check| check()) || self.cancelled_speech.lock().map(|values| values.contains(&marker)).unwrap_or(true);
            let _write = self.writes.lock().await;
            let selected = self.recipients(channel, "tts");
            if selected.is_empty() { return if cancelled() { ReadTtsPublication::Cancelled } else { ReadTtsPublication::Unavailable }; }
            if self.core.lock().map(|core| selected.iter().any(|key| core.pending.iter().filter(|item| item.recipients.contains(key)).count() >= MAX_PENDING)).unwrap_or(true) { return ReadTtsPublication::Unavailable; }
            let epochs: std::collections::BTreeMap<String, String> = selected.iter().filter_map(|key| self.transport.socket_id(key).map(|epoch| (key.clone(), epoch))).collect();
            if epochs.len() != selected.len() { return ReadTtsPublication::Unavailable; }
            let owner = if !input.legacy && input.file.is_some() { selected.first().cloned() } else { None };
            let current = || !cancelled() && owner.as_ref().is_none_or(|key| epochs.get(key).is_some_and(|epoch| self.transport.socket_id(key).as_ref() == Some(epoch)));
            if !current() { return if cancelled() { ReadTtsPublication::Cancelled } else { ReadTtsPublication::Unavailable }; }
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|duration| duration.as_millis().min(i64::MAX as u128) as i64).unwrap_or(0);
            let retained = if owner.is_some() {
                let Some(path) = input.file.as_deref() else { return ReadTtsPublication::Unavailable };
                match self.store.retain(std::path::Path::new(path), now).await { Ok(file) => Some(file), Err(_) => return ReadTtsPublication::Unavailable }
            } else { None };
            if !current() {
                if let Some(file) = &retained { let _ = self.store.release(&file.media_id).await; }
                return if cancelled() { ReadTtsPublication::Cancelled } else { ReadTtsPublication::Unavailable };
            }
            let id = uuid::Uuid::new_v4().to_string();
            let owner_client = owner.as_ref().and_then(|key| key.split_once(':').map(|(_, client)| client.to_owned()));
            let duration = if input.duration_ms == 0.0 || input.duration_ms.is_nan() { 60_000.0 } else { input.duration_ms.clamp(1.0, 60_000.0) };
            let tts = JsonValue::Object(vec![("speechID".into(), JsonValue::String(input.speech_id.as_str().into())), ("ownerClientId".into(), owner_client.as_ref().map_or(JsonValue::Null, |id| JsonValue::String(id.as_str().into()))), ("durationMs".into(), JsonValue::Number(duration))]);
            let mut fields = vec![("id".into(), JsonValue::String(id.as_str().into())), ("kind".into(), JsonValue::String("tts".into())), ("platform".into(), JsonValue::String("twitch".into())), ("text".into(), JsonValue::String(input.text.as_str().into())), ("tts".into(), tts)];
            if owner.is_some() { fields.push(("media".into(), JsonValue::Object(vec![("type".into(), JsonValue::String("audio".into())), ("title".into(), JsonValue::String(input.text.as_str().into())), ("volume".into(), JsonValue::Number(1.0))]))); }
            let event = JsonValue::Object(fields);
            let mut epoch_document = Document::new();
            for (key, epoch) in &epochs { epoch_document.insert(key, epoch.clone()); }
            let mut saved = doc! { "_id": &id, "channel": channel, "speechID": &input.speech_id, "event": crate::utils::bson_json::json_bson(&event), "ttsEpochs": epoch_document, "recipients": selected.clone(), "expiresAt": DateTime::from_millis(now.saturating_add(DELIVERY_TTL_MS)) };
            if let Some(owner) = &owner { saved.insert("ttsOwnerKey", owner); }
            if let Some(file) = &retained { saved.insert("mediaId", &file.media_id); saved.insert("bytes", file.bytes as i64); }
            if let Some(mime) = &input.mime { saved.insert("mime", mime); }
            if self.store.put_record(false, &id, saved).await.is_err() {
                if let Some(file) = &retained { let _ = self.store.release(&file.media_id).await; }
                return ReadTtsPublication::Unavailable;
            }
            if !current() || input.before_emit.as_ref().is_some_and(|callback| !callback()) {
                let _ = self.store.delete_record(false, &id).await;
                if let Some(file) = &retained { let _ = self.store.release(&file.media_id).await; }
                return if cancelled() { ReadTtsPublication::Cancelled } else { ReadTtsPublication::Unavailable };
            }
            let item = PendingDelivery { id: id.clone(), channel: channel.to_owned(), kind: "tts".into(), platform: OverlayPlatform::Twitch, event: event.clone(), recipients: selected.iter().cloned().collect(), tts: true };
            let accepted = self.core.lock().map(|mut core| core.enqueue(item, now.saturating_add(DELIVERY_TTL_MS)) && core.register_speech_ownership(&id, SpeechOwnership { speech_id: input.speech_id.clone(), owner_key: owner.clone(), epochs: epochs.clone(), terminal: false })).unwrap_or(false);
            if !accepted {
                if let Ok(mut core) = self.core.lock() { core.discard(&id); }
                let _ = self.store.delete_record(false, &id).await;
                if let Some(file) = &retained { let _ = self.store.release(&file.media_id).await; }
                return ReadTtsPublication::Unavailable;
            }
            for key in selected {
                let mut output = event.clone();
                if owner.as_ref() != Some(&key) {
                    if let JsonValue::Object(fields) = &mut output {
                        fields.retain(|(name, _)| name.as_str() != Some("media"));
                        if let Some((_, JsonValue::Object(tts))) = fields.iter_mut().find(|(name, _)| name.as_str() == Some("tts")) {
                            if let Some((_, owner)) = tts.iter_mut().find(|(name, _)| name.as_str() == Some("ownerClientId")) { *owner = JsonValue::Null; }
                        }
                    }
                }
                let _ = self.transport.emit(&key, "overlay-event", &output);
            }
            ReadTtsPublication::Emitted
        })
    }
    fn end_read_tts<'a>(&'a self, channel: &'a str, speech_id: &'a str) -> BridgeFuture<'a, ()> {
        Box::pin(async move {
            if let Ok(mut cancelled) = self.cancelled_speech.lock() { cancelled.insert((channel.to_owned(), speech_id.to_owned())); }
            let _write = self.writes.lock().await;
            let ids: Vec<(String, Vec<String>)> = self.core.lock().map(|core| core.pending.iter().filter(|item| item.channel == channel && item.tts && match &item.event {
                JsonValue::Object(fields) => fields.iter().find(|(key, _)| key.as_str() == Some("tts")).is_some_and(|(_, value)| match value {
                    JsonValue::Object(fields) => fields.iter().any(|(key, value)| key.as_str() == Some("speechID") && matches!(value, JsonValue::String(value) if value.as_str() == Some(speech_id))),
                    _ => false,
                }), _ => false,
            }).map(|item| (item.id.clone(), item.recipients.iter().cloned().collect())).collect()).unwrap_or_default();
            for (id, recipients) in ids {
                let media = self.store.get_record(false, &id).await.ok().flatten().and_then(|record| record.get_str("mediaId").ok().map(str::to_owned));
                if self.store.delete_record(false, &id).await.is_err() { continue; }
                if let Some(media) = media { let _ = self.store.release(&media).await; }
                if let Ok(mut core) = self.core.lock() { core.discard(&id); }
                let payload = JsonValue::Array(vec![JsonValue::String(id.as_str().into())]);
                for recipient in recipients { let _ = self.transport.emit(&recipient, "overlay-expired", &payload); }
            }
        })
    }
    fn tts_status<'a>(&'a self, channel: &'a str, current_speech_id: Option<&'a str>) -> BridgeFuture<'a, TtsStatus> {
        Box::pin(async move {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|duration| duration.as_millis().min(i64::MAX as u128) as i64).unwrap_or(0);
            self.core.lock().map(|core| {
                let sources: Vec<_> = core.peers.iter().filter(|(_, peer)| peer.channel == channel && peer.scopes.contains("tts") && (peer.disconnected_at.is_none() || super::live::reconnecting(peer, now))).collect();
                let connected = sources.iter().any(|(_, peer)| peer.disconnected_at.is_none());
                let active: std::collections::BTreeSet<&str> = sources.iter().filter(|(_, peer)| peer.disconnected_at.is_none()).filter_map(|(key, _)| core.playback.get(*key)).flat_map(|(active, _)| active.iter().map(String::as_str)).collect();
                let mut playing = false;
                let ids: std::collections::BTreeSet<String> = core.pending.iter().filter(|item| item.channel == channel && item.tts && core.delivery_is_live(&item.id, now) && sources.iter().any(|(key, _)| item.recipients.contains(*key))).filter_map(|item| {
                    if active.contains(item.id.as_str()) { playing = true; return None; }
                    let speech = match &item.event {
                    JsonValue::Object(fields) => fields.iter().find(|(key, _)| key.as_str() == Some("tts")).and_then(|(_, value)| match value {
                        JsonValue::Object(fields) => fields.iter().find(|(key, _)| key.as_str() == Some("speechID")).and_then(|(_, value)| match value { JsonValue::String(id) => id.as_str(), _ => None }),
                        _ => None,
                    }),
                    _ => None,
                    };
                    if speech.is_some() && speech == current_speech_id { None } else { Some(speech.unwrap_or(&item.id).to_owned()) }
                }).collect();
                TtsStatus { connected, playing, queue_length: ids.len() }
            }).unwrap_or_default()
        })
    }
    fn control_tts<'a>(&'a self, channel: &'a str, action: &'a str) -> BridgeFuture<'a, ()> {
        Box::pin(async move {
            if !matches!(action, "skip" | "clear" | "refresh") { return; }
            let _write = self.writes.lock().await;
            let selections: Vec<(String, Vec<String>)> = self.core.lock().map(|core| core.peers.iter().filter(|(_, peer)| peer.channel == channel).map(|(key, _)| {
                let active = core.playback.get(key).map(|(active, _)| active);
                let ids = core.pending.iter().filter(|item| item.channel == channel && item.tts && item.recipients.contains(key) && (action == "clear" || active.is_some_and(|active| active.contains(&item.id)))).map(|item| item.id.clone()).collect();
                (key.clone(), ids)
            }).collect()).unwrap_or_default();
            for (key, ids) in selections {
                let payload = JsonValue::Array(ids.iter().map(|id| JsonValue::String(id.as_str().into())).collect());
                let _ = self.transport.emit(&key, "overlay-expired", &payload);
                for id in ids {
                    let collection = self.store.deliveries();
                    if collection.update_one(mongodb::bson::doc! { "_id": &id, "recipients": &key }, mongodb::bson::doc! { "$pull": { "recipients": &key } }).await.is_err() { continue; }
                    let record = match self.store.get_record(false, &id).await { Ok(record) => record, Err(_) => continue };
                    if let Some(record) = record {
                        if record.get_array("recipients").is_ok_and(|recipients| recipients.is_empty()) {
                            let media = record.get_str("mediaId").ok().map(str::to_owned);
                            if collection.update_one(mongodb::bson::doc! { "_id": &id, "recipients": { "$size": 0 } }, mongodb::bson::doc! { "$unset": { "mediaId": "", "bytes": "" } }).await.is_err() { continue; }
                            if let Some(media) = media { let _ = self.store.release(&media).await; }
                        }
                    }
                    if let Ok(mut core) = self.core.lock() {
                        let empty = if let Some(item) = core.pending.iter_mut().find(|item| item.id == id) { item.recipients.remove(&key); item.recipients.is_empty() } else { false };
                        if empty { core.discard(&id); }
                    }
                }
                if action == "refresh" { let _ = self.transport.disconnect(&key); }
            }
        })
    }
    fn media<'a>(&'a self, channel: &'a str, input: MediaPublication) -> BridgeFuture<'a, ()> {
        Box::pin(async move {
            if self.recipients(channel, &input.kind).is_empty() { return; }
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|duration| duration.as_millis().min(i64::MAX as u128) as i64).unwrap_or(0);
            let Ok(file) = self.store.retain(&std::path::PathBuf::from(&input.file), now).await else { return };
            let id = uuid::Uuid::new_v4().to_string();
            let platform = match input.platform.unwrap_or(OverlayPlatform::Twitch) { OverlayPlatform::Twitch => "twitch", OverlayPlatform::Kick => "kick", OverlayPlatform::Other => "other" };
            let mut fields = vec![("id".into(), JsonValue::String(id.as_str().into())), ("kind".into(), JsonValue::String(input.kind.as_str().into())), ("platform".into(), JsonValue::String(platform.into())), ("media".into(), input.media.clone())];
            if let Some(text) = &input.text { fields.push(("text".into(), JsonValue::String(text.as_str().into()))); }
            let event = JsonValue::Object(fields);
            if !self.publish(channel, &input.kind, event, Some((&file.media_id, file.bytes, &input.mime))).await { let _ = self.store.release(&file.media_id).await; }
        })
    }
    fn trigger<'a>(&'a self, channel: &'a str, body: JsonValue, platform: Option<OverlayPlatform>) -> BridgeFuture<'a, ()> {
        Box::pin(async move {
            let url = match &body { JsonValue::Object(fields) => fields.iter().find(|(key, _)| key.as_str() == Some("url")).and_then(|(_, value)| match value { JsonValue::String(value) => value.as_str(), _ => None }), _ => None };
            if !url.is_some_and(|value| value.starts_with("https://") || value.starts_with("http://")) { return; }
            let id = uuid::Uuid::new_v4().to_string();
            let platform = match platform.unwrap_or(OverlayPlatform::Twitch) { OverlayPlatform::Twitch => "twitch", OverlayPlatform::Kick => "kick", OverlayPlatform::Other => "other" };
            let event = JsonValue::Object(vec![("id".into(), JsonValue::String(id.as_str().into())), ("kind".into(), JsonValue::String("trigger".into())), ("platform".into(), JsonValue::String(platform.into())), ("media".into(), body)]);
            let _ = self.publish(channel, "trigger", event, None).await;
        })
    }
}
/// Injected swappable dispatch slot; construction does no I/O.
#[derive(Clone, Default)]
pub struct BridgeHandle { slot: Arc<RwLock<Option<Arc<dyn Bridge>>>> }
impl BridgeHandle {
    /// Register or replace the current studio implementation.
    pub fn register(&self, bridge: Arc<dyn Bridge>) {
        let mut guard = self.slot.write().unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = Some(bridge);
    }
    /// Register the native studio bridge using the application's shared handles.
    pub fn register_native(&self, core: Arc<std::sync::Mutex<LiveCore>>, store: MongoDeliveryStore, transport: SocketTransport, writes: Arc<tokio::sync::Mutex<()>>) {
        self.register(Arc::new(NativeBridge::new(core, store, transport, writes)));
    }
    fn get(&self) -> Option<Arc<dyn Bridge>> {
        self.slot.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }
    /// Snapshot the bridge's queue channels, if supplied.
    pub fn studio_queue_channels(&self) -> Option<Vec<Option<String>>> { self.get().and_then(|bridge| bridge.queue_channels()) }
    /// Publish speech through the registered bridge.
    pub async fn publish_studio_read_tts(&self, channel: &str, input: ReadTtsDelivery) -> ReadTtsPublication {
        match self.get() { Some(bridge) => bridge.read_tts(channel, input).await, None => ReadTtsPublication::Unavailable }
    }
    /// End a speech publication.
    pub async fn end_studio_read_tts(&self, channel: &str, speech_id: &str) {
        if let Some(bridge) = self.get() { bridge.end_read_tts(channel, speech_id).await; }
    }
    /// Check connected source availability.
    pub fn studio_has_live_source(&self, channel: &str, kind: &str) -> bool { self.get().is_some_and(|bridge| bridge.has_live_source(channel, kind)) }
    /// Check connected or reconnecting source availability.
    pub fn studio_has_source(&self, channel: &str, kind: &str) -> bool { self.get().is_some_and(|bridge| bridge.has_source(channel, kind)) }
    /// Publish media through the active studio.
    pub async fn publish_studio_media(&self, channel: &str, input: MediaPublication) { if let Some(bridge) = self.get() { bridge.media(channel, input).await; } }
    /// Publish a trigger, returning whether a bridge was registered.
    pub async fn publish_studio_trigger(&self, channel: &str, body: JsonValue, platform: Option<OverlayPlatform>) -> bool {
        if let Some(bridge) = self.get() { bridge.trigger(channel, body, platform).await; true } else { false }
    }
    /// Control studio TTS.
    pub async fn control_studio_tts(&self, channel: &str, action: &str) { if let Some(bridge) = self.get() { bridge.control_tts(channel, action).await; } }
    /// Read studio TTS status or the safe default.
    pub async fn studio_tts_status(&self, channel: &str, speech_id: Option<&str>) -> TtsStatus {
        match self.get() { Some(bridge) => bridge.tts_status(channel, speech_id).await, None => TtsStatus::default() }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    struct Available;
    impl Bridge for Available {
        fn has_source(&self, channel: &str, _: &str) -> bool { channel == "1" }
        fn media<'a>(&'a self, _: &'a str, _: MediaPublication) -> BridgeFuture<'a, ()> { Box::pin(async {}) }
        fn trigger<'a>(&'a self, _: &'a str, _: JsonValue, _: Option<OverlayPlatform>) -> BridgeFuture<'a, ()> { Box::pin(async {}) }
    }
    #[test]
    fn registration_changes_dispatch_and_live_falls_back_to_source() {
        let slot = BridgeHandle::default();
        assert!(!slot.studio_has_source("1", "tts"));
        slot.register(Arc::new(Available));
        assert!(slot.studio_has_live_source("1", "tts"));
        slot.register(Arc::new(NoBridge));
        assert!(!slot.studio_has_source("1", "tts"));
    }
}

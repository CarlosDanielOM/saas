//! Overlay peer state and namespace entry from `live.ts`.
//! Public IDs and client IDs are validated before a peer is registered; the
//! injected handshake callback supplies already-authorized state. Connection
//! state recovery remains unavailable in the existing socket foundation.

use std::{collections::{BTreeMap, BTreeSet}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}};
use socketioxide::{SocketIo, extract::{SocketRef, TryData, AckSender}, handler::ConnectHandler};
use crate::utils::lossless_json::JsonValue;
use super::{controls::{OverlayPlatform, OverlayScope, QueueCommand, QueueCommandAction, platform_matches}, delivery_store::{DeliveryRepository, MongoDeliveryStore, LEASE_MS}, store::{MongoStudioStore, valid_public_id}};

/// Validated information supplied by the application's handshake adapter.
#[derive(Clone, Debug)]
pub struct Handshake {
    /// Public overlay ID from the namespace.
    pub public_id: String,
    /// Stable browser-source identity.
    pub client_id: String,
    /// Owning channel resolved by the application's store.
    pub channel: String,
    /// Event origin selected for the peer, if constrained.
    pub platform: Option<OverlayPlatform>,
    /// Event kinds accepted by the published scene.
    pub scopes: BTreeSet<String>,
    /// Initial socket payload supplied by the application adapter.
    pub initial_state: serde_json::Value,
    /// Current epoch in milliseconds, supplied by the application.
    pub now_ms: i64,
}
/// Runtime state for a browser source.
#[derive(Clone, Debug)]
pub struct Peer {
    /// Public overlay ID.
    pub public_id: String,
    /// Stable client identity.
    pub client_id: String,
    /// Owning channel.
    pub channel: String,
    /// Optional platform selection.
    pub platform: Option<OverlayPlatform>,
    /// Accepted event kinds.
    pub scopes: BTreeSet<String>,
    /// Time of the current connection.
    pub connected_at: i64,
    /// Disconnect time, or none for an active connection.
    pub disconnected_at: Option<i64>,
    /// Commands retained until acknowledged.
    pub commands: Vec<QueueCommand>,
    /// Whether the latest automatic clip/TTS activation failed.
    pub activation_failed: bool,
    /// Earliest retry after an activation failure.
    pub activation_retry_at: i64,
    /// Whether the current scene/state read or interaction recovery failed.
    pub state_failed: bool,
}
/// A delivery and the source identities still entitled to receive it.
#[derive(Clone, Debug)]
pub struct PendingDelivery {
    /// Event ID.
    pub id: String,
    /// Owning channel.
    pub channel: String,
    /// Event kind.
    pub kind: String,
    /// Origin platform.
    pub platform: OverlayPlatform,
    /// Lossless event payload.
    pub event: JsonValue,
    /// Eligible `publicId:clientId` source keys.
    pub recipients: BTreeSet<String>,
    /// Whether this is speech, which must not replay after reconnect.
    pub tts: bool,
}
/// Elected owner and connection epochs for a speech delivery.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpeechOwnership {
    /// Producer speech identifier.
    pub speech_id: String,
    /// Source key allowed to fetch audio and report playback.
    pub owner_key: Option<String>,
    /// Socket epoch captured for each recipient at publication.
    pub epochs: BTreeMap<String, String>,
    /// Whether the owner has already reported completion.
    pub terminal: bool,
}
/// In-memory ordered peer and pending-delivery state.
#[derive(Default)]
pub struct LiveCore {
    /// Source registry indexed by public ID and client ID.
    pub peers: BTreeMap<String, Peer>,
    /// Deliveries in publication order.
    pub pending: Vec<PendingDelivery>,
    /// Per-source current speech epoch and cancellation flag.
    epochs: BTreeMap<String, (String, Arc<AtomicBool>)>,
    /// Expiry time for each pending delivery.
    expiries: BTreeMap<String, i64>,
    /// Provider cancellation signals belonging to the current peer epoch.
    speech_signals: BTreeMap<String, tokio::sync::watch::Sender<Option<String>>>,
    /// Ownership data for live TTS deliveries.
    speech_ownership: BTreeMap<String, SpeechOwnership>,
    /// Last valid active and queued playback report for each peer.
    pub playback: BTreeMap<String, (BTreeSet<String>, BTreeSet<String>)>,
}
/// Whether a browser identity matches the source's permitted grammar.
pub fn valid_client_id(client: &str) -> bool {
    (16..=80).contains(&client.len()) && client.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}
/// Whether a disconnected peer remains within its reconnect lease.
pub fn reconnecting(peer: &Peer, now_ms: i64) -> bool {
    peer.disconnected_at.is_some_and(|at| i128::from(now_ms) - i128::from(at) < i128::from(LEASE_MS))
}
impl LiveCore {
    /// Install a newer speech epoch, cancelling work belonging to the old one.
    pub fn replace_tts_epoch(&mut self, peer_key: &str, epoch: &str) -> Arc<AtomicBool> {
        if let Some(signal) = self.speech_signals.remove(peer_key) { let _ = signal.send(Some("studio_superseded".into())); }
        let cancelled = Arc::new(AtomicBool::new(false));
        if let Some((_, previous)) = self.epochs.insert(peer_key.to_owned(), (epoch.to_owned(), cancelled.clone())) {
            previous.store(true, Ordering::SeqCst);
        }
        cancelled
    }
    /// Check that a peer and socket epoch still own a speech publication.
    pub fn owns_tts_epoch(&self, peer_key: &str, epoch: &str) -> bool {
        self.epochs.get(peer_key).is_some_and(|(current, cancelled)| current == epoch && !cancelled.load(Ordering::SeqCst))
    }
    /// Record ownership only for a live TTS delivery and current source epochs.
    pub fn register_speech_ownership(&mut self, delivery_id: &str, ownership: SpeechOwnership) -> bool {
        let Some(delivery) = self.pending.iter().find(|item| item.id == delivery_id && item.tts) else { return false };
        if ownership.epochs.iter().any(|(key, epoch)| !delivery.recipients.contains(key) || !self.owns_tts_epoch(key, epoch)) { return false; }
        if ownership.owner_key.as_ref().is_some_and(|key| !ownership.epochs.contains_key(key)) { return false; }
        self.speech_ownership.insert(delivery_id.to_owned(), ownership);
        true
    }
    /// Check scene, client and socket epoch before exposing an owned speech item.
    pub fn correlated_speech(&self, delivery_id: &str, public_id: &str, client_id: &str, socket_id: &str) -> bool {
        let key = format!("{public_id}:{client_id}");
        self.pending.iter().any(|item| item.id == delivery_id && item.tts && item.recipients.contains(&key))
            && self.speech_ownership.get(delivery_id).and_then(|owner| owner.epochs.get(&key)).is_some_and(|epoch| epoch == socket_id)
            && self.owns_tts_epoch(&key, socket_id)
            && self.peers.get(&key).is_some_and(|peer| peer.disconnected_at.is_none())
    }
    /// Only the elected owner may retrieve retained audio.
    pub fn owns_speech_media(&self, delivery_id: &str, public_id: &str, client_id: &str, socket_id: &str) -> bool {
        self.correlated_speech(delivery_id, public_id, client_id, socket_id)
            && self.speech_ownership.get(delivery_id).and_then(|owner| owner.owner_key.as_deref()) == Some(format!("{public_id}:{client_id}").as_str())
    }
    /// Atomically claim a terminal owner report; duplicates do not claim again.
    pub fn claim_speech_terminal(&mut self, delivery_id: &str, public_id: &str, client_id: &str, socket_id: &str) -> bool {
        if !self.owns_speech_media(delivery_id, public_id, client_id, socket_id) { return false; }
        let Some(owner) = self.speech_ownership.get_mut(delivery_id) else { return false };
        if owner.terminal { return false; }
        owner.terminal = true;
        true
    }
    /// Validate a speech report against the elected owner, speech ID and socket
    /// epoch. A terminal report claims ownership before the caller performs I/O.
    pub fn accept_speech_report(&mut self, delivery_id: &str, public_id: &str, client_id: &str, socket_id: &str, speech_id: &str, playback: Option<(&str, f64)>) -> bool {
        if !self.owns_speech_media(delivery_id, public_id, client_id, socket_id) { return false; }
        let Some(owner) = self.speech_ownership.get_mut(delivery_id) else { return false };
        if owner.terminal || owner.speech_id != speech_id { return false; }
        if let Some((phase, position)) = playback {
            matches!(phase, "loading" | "playing" | "progress" | "recovering") && position.is_finite() && (0.0..=3600.0).contains(&position)
        } else {
            owner.terminal = true;
            true
        }
    }
    /// Append one delivery in order, rejecting duplicate IDs.
    pub fn enqueue(&mut self, item: PendingDelivery, expires_at_ms: i64) -> bool {
        if self.pending.iter().any(|old| old.id == item.id) { return false; }
        self.expiries.insert(item.id.clone(), expires_at_ms);
        self.pending.push(item);
        true
    }
    /// Persist an event before adding it to the ordered in-memory queue.
    /// Existing journal IDs are ignored, including after process recovery.
    pub async fn persist_delivery<R: DeliveryRepository>(&mut self, repository: &R, item: PendingDelivery, expires_at_ms: i64) -> Result<bool, super::delivery_store::DeliveryStoreError> {
        use mongodb::bson::{doc, DateTime};
        if self.pending.iter().any(|old| old.id == item.id) || repository.get_record(false, &item.id).await?.is_some() { return Ok(false); }
        let recipients: Vec<String> = item.recipients.iter().cloned().collect();
        let saved = doc! { "_id": &item.id, "channel": &item.channel,
            "event": crate::utils::bson_json::json_bson(&item.event),
            "recipients": recipients, "expiresAt": DateTime::from_millis(expires_at_ms) };
        repository.put_record(false, &item.id, saved).await?;
        Ok(self.enqueue(item, expires_at_ms))
    }
    /// Disconnect a source and revoke its speech epochs and pending speech.
    /// Returns IDs with no remaining recipients, so the adapter can release them.
    pub fn disconnect(&mut self, peer_key: &str, now_ms: i64) -> Vec<String> {
        if let Some(peer) = self.peers.get_mut(peer_key) { peer.disconnected_at = Some(now_ms); }
        if let Some((_, cancelled)) = self.epochs.remove(peer_key) { cancelled.store(true, Ordering::SeqCst); }
        if let Some(signal) = self.speech_signals.remove(peer_key) { let _ = signal.send(Some("studio_disconnected".into())); }
        for item in &mut self.pending { if item.tts { item.recipients.remove(peer_key); } }
        self.remove_empty()
    }
    /// Accept a playback report only when every ID belongs to this source.
    pub fn report_playback(&mut self, peer_key: &str, active: Vec<String>, queued: Vec<String>) -> bool {
        if active.len() > 5000 || queued.len() > 5000 { return false; }
        if active.iter().chain(&queued).any(|id| !self.pending.iter().any(|item| item.id == *id && item.recipients.contains(peer_key))) { return false; }
        self.playback.insert(peer_key.to_owned(), (active.into_iter().collect(), queued.into_iter().collect()));
        true
    }
    fn remove_empty(&mut self) -> Vec<String> {
        let mut removed = Vec::new();
        self.pending.retain(|item| {
            if item.recipients.is_empty() { removed.push(item.id.clone()); false } else { true }
        });
        for id in &removed { self.expiries.remove(id); self.speech_ownership.remove(id); }
        removed
    }
    /// Remove an in-memory delivery and its ownership metadata.
    pub fn discard(&mut self, id: &str) {
        self.pending.retain(|item| item.id != id);
        self.expiries.remove(id);
        self.speech_ownership.remove(id);
    }
    /// Expire pending deliveries and disconnected peer leases at the supplied time.
    /// Returns expired delivery IDs in original delivery order.
    pub fn poll_expired(&mut self, now_ms: i64) -> Vec<String> {
        let expired_peers: Vec<_> = self.peers.iter().filter(|(_, peer)| peer.disconnected_at.is_some() && !reconnecting(peer, now_ms)).map(|(key, _)| key.clone()).collect();
        for key in expired_peers {
            self.peers.remove(&key);
            self.playback.remove(&key);
            if let Some((_, cancelled)) = self.epochs.remove(&key) { cancelled.store(true, Ordering::SeqCst); }
            if let Some(signal) = self.speech_signals.remove(&key) { let _ = signal.send(Some("studio_removed".into())); }
            for item in &mut self.pending { item.recipients.remove(&key); }
        }
        let mut removed = Vec::new();
        self.pending.retain(|item| {
            let expired = item.recipients.is_empty() || self.expiries.get(&item.id).is_some_and(|expiry| *expiry <= now_ms);
            if expired { removed.push(item.id.clone()); }
            !expired
        });
        for id in &removed { self.expiries.remove(id); self.speech_ownership.remove(id); }
        removed
    }
    /// Install a new peer, preserving queued commands only for an unexpired lease.
    pub fn connect(&mut self, handshake: &Handshake) -> Option<String> {
        if !valid_public_id(&handshake.public_id) || !valid_client_id(&handshake.client_id) { return None; }
        let key = format!("{}:{}", handshake.public_id, handshake.client_id);
        let commands = self.peers.get(&key).filter(|peer| peer.disconnected_at.is_none() || reconnecting(peer, handshake.now_ms)).map(|peer| peer.commands.clone()).unwrap_or_default();
        if let Some((_, cancelled)) = self.epochs.remove(&key) { cancelled.store(true, Ordering::SeqCst); }
        if let Some(signal) = self.speech_signals.remove(&key) { let _ = signal.send(Some("studio_superseded".into())); }
        self.peers.insert(key.clone(), Peer { public_id: handshake.public_id.clone(), client_id: handshake.client_id.clone(), channel: handshake.channel.clone(), platform: handshake.platform, scopes: handshake.scopes.clone(), connected_at: handshake.now_ms, disconnected_at: None, commands, activation_failed: false, activation_retry_at: 0, state_failed: false });
        Some(key)
    }
    /// Return retained non-speech delivery IDs in publication order for a peer.
    pub fn replay_ids(&self, key: &str) -> Vec<&str> {
        self.pending.iter().filter(|item| !item.tts && item.recipients.contains(key)).map(|item| item.id.as_str()).collect()
    }
    /// Whether a pending item is still within its stored delivery lifetime.
    pub fn delivery_is_live(&self, id: &str, now_ms: i64) -> bool { self.expiries.get(id).is_some_and(|expiry| *expiry > now_ms) }
    /// Remove a previously captured command when acknowledged.
    pub fn acknowledge_command(&mut self, key: &str, id: &str) {
        if let Some(peer) = self.peers.get_mut(key) { peer.commands.retain(|command| command.id != id); }
    }
    /// Prepare a provider request tied to the peer's current socket epoch.
    /// The caller runs the returned operation without holding the core lock.
    pub fn prepare_speech(&mut self, peer_key: &str, epoch: &str, runtime: Arc<crate::tts_services::runtime::TtsRuntime>, mut request: crate::tts_services::tts_provider::TtsSynthesisRequest) -> Option<SpeechOperation> {
        if !self.owns_tts_epoch(peer_key, epoch) { return None; }
        if let Some(previous) = self.speech_signals.remove(peer_key) { let _ = previous.send(Some("studio_superseded".into())); }
        let (sender, receiver) = tokio::sync::watch::channel(None);
        request.signal = Some(receiver);
        self.speech_signals.insert(peer_key.to_owned(), sender);
        Some(SpeechOperation { runtime, request })
    }
    /// Capture per-peer delivery IDs for skip or clear, refusing the whole
    /// operation when any selected peer has reached the command limit.
    pub fn queue_control(&mut self, channel: &str, scope: OverlayScope, action: QueueCommandAction, mut next_id: impl FnMut() -> String) -> Result<usize, &'static str> {
        let selected: Vec<(String, Vec<String>)> = self.peers.iter().filter(|(_, peer)| peer.channel == channel).filter_map(|(key, _)| {
            let ids: Vec<String> = self.pending.iter().filter(|delivery| delivery.recipients.contains(key) && platform_matches(scope, delivery.platform)).map(|delivery| delivery.id.clone()).collect();
            (!ids.is_empty()).then(|| (key.clone(), ids))
        }).collect();
        if selected.iter().any(|(key, _)| self.peers.get(key).is_some_and(|peer| peer.commands.len() >= 256)) {
            return Err("A browser source must reconnect before accepting more controls");
        }
        let count = selected.len();
        for (key, event_ids) in selected {
            if let Some(peer) = self.peers.get_mut(&key) { peer.commands.push(QueueCommand { id: next_id(), action, platform: scope, event_ids }); }
        }
        Ok(count)
    }
}
/// A provider operation prepared with the source's peer cancellation signal.
pub struct SpeechOperation {
    runtime: Arc<crate::tts_services::runtime::TtsRuntime>,
    request: crate::tts_services::tts_provider::TtsSynthesisRequest,
}
impl SpeechOperation {
    /// Synthesize using the configured native provider.
    pub async fn synthesize(self) -> crate::tts_services::tts_provider::TtsSynthesisResult {
        self.runtime.synthesize(Some(self.request.provider), &self.request).await
    }
}
/// A caller-owned source of validated handshake data; it must resolve authorization.
pub type HandshakeExtractor = Arc<dyn Fn(&SocketRef) -> Option<Handshake> + Send + Sync>;
/// Integration-owned transport operations not demonstrated by the in-repo
/// socketioxide example. These callbacks carry already resolved peer IDs.
pub trait PeerTransport: Send + Sync {
    /// Emit an event to one peer.
    fn emit(&self, peer_key: &str, event: &str, payload: &JsonValue) -> Result<(), String>;
    /// Disconnect a peer whose session has been superseded.
    fn disconnect(&self, peer_key: &str) -> Result<(), String>;
}
/// Production transport backed by the currently connected socketioxide peers.
#[derive(Clone, Default)]
pub struct SocketTransport { sockets: Arc<Mutex<BTreeMap<String, SocketRef>>> }
impl SocketTransport {
    /// Construct an empty transport without opening a connection.
    pub fn new() -> Self { Self::default() }
    /// Associate a source key with the currently connected socket.
    pub fn attach(&self, peer_key: &str, socket: SocketRef) -> Option<SocketRef> {
        self.sockets.lock().ok().and_then(|mut sockets| sockets.insert(peer_key.to_owned(), socket))
    }
    /// Remove a source only when its current socket matches the supplied ID.
    pub fn detach(&self, peer_key: &str, socket_id: &str) {
        if let Ok(mut sockets) = self.sockets.lock() {
            if sockets.get(peer_key).is_some_and(|socket| socket.id.to_string() == socket_id) { sockets.remove(peer_key); }
        }
    }
    /// Return the current connected socket's epoch identifier.
    pub fn socket_id(&self, peer_key: &str) -> Option<String> {
        self.sockets.lock().ok().and_then(|sockets| sockets.get(peer_key).filter(|socket| socket.connected()).map(|socket| socket.id.to_string()))
    }
}
impl PeerTransport for SocketTransport {
    fn emit(&self, peer_key: &str, event: &str, payload: &JsonValue) -> Result<(), String> {
        let socket = self.sockets.lock().map_err(|_| "Socket registry unavailable".to_owned())?.get(peer_key).cloned().ok_or_else(|| "Socket unavailable".to_owned())?;
        let mut wire = String::new();
        payload.write_json_string(&mut wire);
        let data: serde_json::Value = serde_json::from_str(&wire).map_err(|_| "Socket payload is not representable".to_owned())?;
        socket.emit(event, &data).map_err(|_| "Socket emission failed".to_owned())
    }
    fn disconnect(&self, peer_key: &str) -> Result<(), String> {
        let socket = self.sockets.lock().map_err(|_| "Socket registry unavailable".to_owned())?.remove(peer_key).ok_or_else(|| "Socket unavailable".to_owned())?;
        socket.disconnect().map_err(|_| "Socket disconnect failed".to_owned())
    }
}
/// Concrete dispatch adapter around integration-supplied socket callbacks.
pub struct CallbackTransport {
    emit: Arc<dyn Fn(&str, &str, &JsonValue) -> Result<(), String> + Send + Sync>,
    disconnect: Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>,
}
fn peer_document(key: &str, peer: &Peer, now_ms: i64) -> mongodb::bson::Document {
    use mongodb::bson::{doc, DateTime};
    let commands: Vec<_> = peer.commands.iter().map(|command| {
        let action = match command.action { QueueCommandAction::Skip => "skip", QueueCommandAction::Clear => "clear" };
        let platform = match command.platform { OverlayScope::All => "all", OverlayScope::Platform(OverlayPlatform::Twitch) => "twitch", OverlayScope::Platform(OverlayPlatform::Kick) => "kick", OverlayScope::Platform(OverlayPlatform::Other) => "other" };
        doc! { "id": &command.id, "action": action, "platform": platform, "eventIds": &command.event_ids }
    }).collect();
    doc! { "_id": key, "channel": &peer.channel, "publicId": &peer.public_id, "since": peer.connected_at, "expiresAt": DateTime::from_millis(now_ms.saturating_add(LEASE_MS)), "commands": commands }
}
// Decode only commands whose full wire shape is understood. Never restore a
// lease belonging to another scene/channel, even if the key was forged.
fn restored_commands(row: &mongodb::bson::Document, handshake: &Handshake, key: &str) -> Option<Vec<QueueCommand>> {
    if row.get_str("_id").ok()? != key || row.get_str("publicId").ok()? != handshake.public_id
        || row.get_str("channel").ok()? != handshake.channel
        || row.get_datetime("expiresAt").ok()?.timestamp_millis() <= handshake.now_ms { return None; }
    let mut commands = Vec::new();
    for value in row.get_array("commands").ok()? {
        let command = value.as_document()?;
        let action = match command.get_str("action").ok()? { "skip" => QueueCommandAction::Skip, "clear" => QueueCommandAction::Clear, _ => return None };
        let platform = match command.get_str("platform").ok()? {
            "all" => OverlayScope::All,
            "twitch" => OverlayScope::Platform(OverlayPlatform::Twitch),
            "kick" => OverlayScope::Platform(OverlayPlatform::Kick),
            "other" => OverlayScope::Platform(OverlayPlatform::Other),
            _ => return None,
        };
        let event_ids = command.get_array("eventIds").ok()?.iter().map(|id| id.as_str().map(str::to_owned)).collect::<Option<Vec<_>>>()?;
        commands.push(QueueCommand { id: command.get_str("id").ok()?.to_owned(), action, platform, event_ids });
    }
    Some(commands)
}
impl CallbackTransport {
    /// Bind the host's emission and disconnect callbacks without opening I/O.
    pub fn new(emit: Arc<dyn Fn(&str, &str, &JsonValue) -> Result<(), String> + Send + Sync>, disconnect: Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>) -> Self { Self { emit, disconnect } }
}
impl PeerTransport for CallbackTransport {
    fn emit(&self, peer_key: &str, event: &str, payload: &JsonValue) -> Result<(), String> { (self.emit)(peer_key, event, payload) }
    fn disconnect(&self, peer_key: &str) -> Result<(), String> { (self.disconnect)(peer_key) }
}
/// Application queue operations needed by the automatic source lifecycle.
/// Clip activation must set both presence keys and subscribe the clip queue;
/// speech activation must resume the TTS queue if idle.
pub trait OverlaySourceActivation: Send + Sync {
    /// Activate clip queue and presence for this channel.
    fn activate_clip<'a>(&'a self, channel: &'a str) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>>;
    /// Resume the channel's TTS queue if idle.
    fn resume_tts<'a>(&'a self, channel: &'a str) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>>;
}

/// Explicit owner-facing readiness; uses the shared EventSub service directly.
pub async fn overlay_interaction_readiness(service: &super::interaction_subscriptions::InteractionSubscriptions<'_>, channel: &str, kind: crate::domain_event_contracts::interaction::InteractionKind) -> Result<super::interaction_subscriptions::InteractionReadiness, super::store::OverlayError> {
    service.interaction_readiness(channel, kind).await
}
/// Explicit owner-facing activation; never called by automatic peer recovery.
pub async fn overlay_activate_interaction(service: &super::interaction_subscriptions::InteractionSubscriptions<'_>, channel: &str, kind: crate::domain_event_contracts::interaction::InteractionKind) -> Result<super::interaction_subscriptions::InteractionReadiness, super::store::OverlayError> {
    service.activate_interaction(channel, kind).await
}

fn overlay_activation_accepts(snapshot: &serde_json::Value, kind: &str) -> bool {
    snapshot.get("widgets").and_then(serde_json::Value::as_array).into_iter().flatten().any(|widget| {
        widget.get("visible").and_then(serde_json::Value::as_bool) == Some(true)
            && (widget.get("kind").and_then(serde_json::Value::as_str) == Some(kind)
                || (widget.get("kind").and_then(serde_json::Value::as_str) == Some("alert")
                    && widget.get("events").and_then(serde_json::Value::as_array).is_some_and(|events| events.iter().any(|event| event.as_str() == Some(kind)))))
    })
}
async fn overlay_activation_run(source: &dyn OverlaySourceActivation, channel: &str, snapshot: &serde_json::Value) -> Result<(), String> {
    if overlay_activation_accepts(snapshot, "clip") { source.activate_clip(channel).await?; }
    if overlay_activation_accepts(snapshot, "tts") { source.resume_tts(channel).await?; }
    Ok(())
}
fn overlay_activation_result(peer: &mut Peer, result: &Result<(), String>, now: i64) {
    peer.activation_failed = result.is_err();
    if peer.activation_failed { peer.activation_retry_at = now.saturating_add(5000); }
}
fn overlay_activation_due(peer: &Peer, changed: bool, now: i64) -> bool {
    peer.disconnected_at.is_none() && (changed || (peer.activation_failed && now >= peer.activation_retry_at))
}

// Widget state versions are per socket epoch; failed interaction reads must not
// replace the legacy version or send fabricated nulls to older clients.
#[derive(Clone)]
struct WidgetPeer {
    socket: SocketRef,
    public_id: String,
    channel: String,
    snapshot: serde_json::Value,
    revision: serde_json::Value,
    controls: serde_json::Value,
    widget_version: String,
    interaction_version: Option<String>,
}

fn overlay_live_widget_inputs(snapshot: &serde_json::Value) -> Vec<super::widget_state::StateWidget> {
    snapshot.get("widgets").and_then(|value| value.as_array()).into_iter().flatten()
        .filter_map(|value| serde_json::to_string(value).ok())
        .filter_map(|wire| crate::utils::lossless_json::parse_json(&wire).ok())
        .filter_map(|value| super::widget_state::StateWidget::from_json(&value))
        .collect()
}

// Reuse the registry's scene validation and bindings so recovery selects the
// same visible interaction widgets as ordinary state reads.
fn overlay_live_lifecycle_kinds(widgets: &[super::widget_state::StateWidget]) -> Vec<crate::domain_event_contracts::interaction::InteractionKind> {
    use crate::domain_event_contracts::interaction::InteractionKind;
    let selection = super::widget_state::select_widgets(widgets);
    let Some(keys) = selection.get(super::widget_state_providers::INTERACTION_SOURCE) else { return Vec::new() };
    [ ("poll", InteractionKind::Poll), ("prediction", InteractionKind::Prediction) ]
        .into_iter().filter_map(|(key, kind)| keys.contains(key).then_some(kind)).collect()
}

fn overlay_live_lifecycle_overdue(widgets: &[super::widget_state::StateWidget], interactions: Option<&serde_json::Value>, now: i64) -> Vec<crate::domain_event_contracts::interaction::InteractionKind> {
    use crate::domain_event_contracts::interaction::InteractionKind;
    overlay_live_lifecycle_kinds(widgets).into_iter().filter(|kind| {
        let name = match kind { InteractionKind::Poll => "poll", InteractionKind::Prediction => "prediction" };
        let Some(state) = interactions.and_then(|value| value.get(name)) else { return false };
        state.get("phase").and_then(serde_json::Value::as_str) == Some("active")
            && state.get("deadline").and_then(serde_json::Value::as_str)
                .and_then(crate::utils::js_date::parse_date)
                .is_some_and(|deadline| i128::from(deadline) + 5000 < i128::from(now))
    }).collect()
}

fn overlay_activation_mark_recovery_failure(core: &mut LiveCore, epochs: &BTreeMap<String, String>, key: &str, socket_id: &str) {
    if epochs.get(key).is_some_and(|current| current == socket_id) {
        if let Some(peer) = core.peers.get_mut(key) { peer.state_failed = true; }
    }
}

fn overlay_live_lifecycle_resync(service: &Arc<super::interactions::InteractionResync>, core: &Arc<Mutex<LiveCore>>, epochs: &Arc<Mutex<BTreeMap<String, String>>>, key: &str, socket_id: &str, channel: &str, kinds: Vec<crate::domain_event_contracts::interaction::InteractionKind>) {
    for kind in kinds {
        let service = service.clone(); let core = core.clone(); let epochs = epochs.clone();
        let key = key.to_owned(); let socket_id = socket_id.to_owned(); let channel = channel.to_owned();
        tokio::spawn(async move {
            if service.resync_interaction(&channel, kind, overlay_live_widget_now()).await.is_err() {
                // A late failure from a replaced socket must not poison its successor.
                if let Ok(current) = epochs.lock() {
                    if let Ok(mut core) = core.lock() { overlay_activation_mark_recovery_failure(&mut core, &current, &key, &socket_id); }
                }
            }
        });
    }
}

fn overlay_live_widget_payload(snapshot: &super::widget_contract::WidgetStateSnapshot) -> Option<(serde_json::Value, Option<serde_json::Value>, String, Option<String>)> {
    let wire = snapshot.to_json().to_json_string();
    let payload: serde_json::Value = serde_json::from_str(&wire).ok()?;
    let version = serde_json::to_string(&serde_json::json!([payload.get("widgetStates")?, payload.get("failedSources")?])).ok()?;
    let interactions = if snapshot.failed_sources.iter().any(|source| source == super::widget_state_providers::INTERACTION_SOURCE) {
        None
    } else {
        let legacy = super::widget_state_providers::legacy_interactions(&snapshot.widget_states, snapshot.server_time as f64);
        Some(serde_json::from_str::<serde_json::Value>(&legacy.to_json_string()).ok()?)
    };
    let interaction_version = interactions.as_ref().map(|value| {
        serde_json::json!([value.get("poll").and_then(|v| v.get("revision")), value.get("prediction").and_then(|v| v.get("revision"))]).to_string()
    });
    Some((payload, interactions, version, interaction_version))
}

fn overlay_live_widget_now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis().min(i64::MAX as u128) as i64).unwrap_or(0)
}

/// Register the verified dynamic namespace and emit initial state after the
/// injected extractor has authorized and validated the peer.
pub fn register_socket_namespace(io: &SocketIo, core: Arc<Mutex<LiveCore>>, store: MongoStudioStore, delivery_store: MongoDeliveryStore, sockets: SocketTransport, bridge: &super::bridge::BridgeHandle, extract: HandshakeExtractor, interactions: super::interactions::MongoInteractions, resync: Arc<super::interactions::InteractionResync>, activation: Arc<dyn OverlaySourceActivation>) -> Result<(), String> {
    let widget_registry = Arc::new(super::widget_state_providers::widget_state_registry(interactions)?);
    let widget_peers: Arc<Mutex<BTreeMap<String, WidgetPeer>>> = Arc::new(Mutex::new(BTreeMap::new()));
    let epochs: Arc<Mutex<BTreeMap<String, String>>> = Arc::new(Mutex::new(BTreeMap::new()));
    let poll_epochs = epochs.clone();
    let poll_activation = activation.clone();
    let poll_registry = widget_registry.clone();
    let poll_resync = resync.clone();
    let poll_peers = widget_peers.clone();
    let poll_store = store.clone();
    let poll_core = Arc::downgrade(&core);
    let widget_poll = async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(1));
        timer.tick().await;
        loop {
            timer.tick().await;
            if poll_core.upgrade().is_none() { break; }
            let peers = match poll_peers.lock() { Ok(peers) => peers.clone(), Err(_) => continue };
            let scope = poll_registry.create_read_scope();
            let now = overlay_live_widget_now();
            for (key, peer) in peers {
                if !peer.socket.connected() { continue; }
                // A transient scene read keeps the last published widget selection.
                let scene = poll_store.public_state(&peer.public_id).await;
                let mut scene_failed = false;
                let (snapshot, revision, controls) = match scene {
                    Ok(state) if state.channel == peer.channel => {
                        let snapshot = serde_json::to_value(&state.snapshot).unwrap_or_else(|_| peer.snapshot.clone());
                        let revision = serde_json::to_value(&state.revision).unwrap_or_else(|_| peer.revision.clone());
                        let controls = serde_json::to_value(&state.controls).unwrap_or_else(|_| peer.controls.clone());
                        let snapshot = if revision == peer.revision { peer.snapshot.clone() } else { snapshot };
                        (snapshot, revision, controls)
                    }
                    Ok(_) => continue,
                    Err(error) if error.status == 403 || error.status == 404 => {
                        let _ = peer.socket.emit("overlay-revoked", &());
                        let _ = peer.socket.clone().disconnect();
                        continue;
                    }
                    Err(_) => { scene_failed = true; (peer.snapshot.clone(), peer.revision.clone(), peer.controls.clone()) },
                };
                let Some(core) = poll_core.upgrade() else { break };
                let socket_id = peer.socket.id.to_string();
                let changed = revision != peer.revision;
                let due = core.lock().ok().and_then(|core| core.peers.get(&key).map(|peer| overlay_activation_due(peer, changed, now))).unwrap_or(false);
                if let Ok(current) = poll_epochs.lock() {
                    if current.get(&key) == Some(&socket_id) {
                        if let Ok(mut core) = core.lock() { if let Some(peer) = core.peers.get_mut(&key) { peer.state_failed = scene_failed; } }
                    }
                }
                if due {
                    let activation_result = overlay_activation_run(poll_activation.as_ref(), &peer.channel, &snapshot).await;
                    if let Ok(current) = poll_epochs.lock() {
                        if current.get(&key) == Some(&socket_id) {
                            if let Ok(mut core) = core.lock() { if let Some(peer) = core.peers.get_mut(&key) { overlay_activation_result(peer, &activation_result, overlay_live_widget_now()); } }
                        }
                    }
                }
                let widgets = overlay_live_widget_inputs(&snapshot);
                let result = poll_registry.snapshot(&peer.channel, &widgets, &scope, now).await;
                let Some((payload, interactions, version, interaction_version)) = overlay_live_widget_payload(&result) else { continue };
                let overdue = overlay_live_lifecycle_overdue(&widgets, interactions.as_ref(), now);
                if !result.failed_sources.is_empty() {
                    if let Ok(current) = poll_epochs.lock() { if current.get(&key) == Some(&socket_id) { if let Ok(mut core) = core.lock() { if let Some(peer) = core.peers.get_mut(&key) { peer.state_failed = true; } } } }
                }
                overlay_live_lifecycle_resync(&poll_resync, &core, &poll_epochs, &key, &socket_id, &peer.channel, overdue);
                if let Ok(mut current) = poll_peers.lock() {
                    let Some(active) = current.get_mut(&key) else { continue };
                    if active.socket.id != peer.socket.id || !active.socket.connected() { continue; }
                    if controls.get("revision") != active.controls.get("revision") {
                        let _ = active.socket.emit("overlay-queue-state", &controls);
                        active.controls = controls;
                    }
                    if revision != active.revision {
                        let _ = active.socket.emit("overlay-updated", &serde_json::json!({"revision": revision}));
                        active.revision = revision;
                        active.snapshot = snapshot;
                    }
                    if version != active.widget_version && active.socket.emit("overlay-widget-states", &payload).is_ok() {
                        active.widget_version = version;
                    }
                    if let (Some(interactions), Some(version)) = (interactions, interaction_version) {
                        if active.interaction_version.as_ref() != Some(&version) && active.socket.emit("overlay-interactions", &interactions).is_ok() {
                            active.interaction_version = Some(version);
                        }
                    }
                }
            }
        }
    };
    let bridge_core = core.clone();
    let bridge_store = delivery_store.clone();
    let bridge_sockets = sockets.clone();
    let writes = Arc::new(tokio::sync::Mutex::new(()));
    let handler_writes = writes.clone();
    let handler_widget_registry = widget_registry.clone();
    let handler_resync = resync.clone();
    let handler_activation = activation.clone();
    let handler_widget_peers = widget_peers.clone();
    let prepared: Arc<Mutex<BTreeMap<String, Handshake>>> = Arc::new(Mutex::new(BTreeMap::new()));
    let handler_prepared = prepared.clone();
    let handler_core = core.clone();
    let handler_epochs = epochs.clone();
    let handler_sockets = sockets.clone();
    let handler_delivery_store = delivery_store;
    let handler = move |socket: SocketRef| {
        let prepared = handler_prepared.clone();
        let core = handler_core.clone();
        let epochs = handler_epochs.clone();
        let sockets = handler_sockets.clone();
        let delivery_store = handler_delivery_store.clone();
        let writes = handler_writes.clone();
        let widget_registry = handler_widget_registry.clone();
        let resync = handler_resync.clone();
        let activation = handler_activation.clone();
        let widget_peers = handler_widget_peers.clone();
        async move {
            let socket_id = socket.id.to_string();
            let handshake = prepared.lock().ok().and_then(|mut values| values.remove(&socket_id));
            let Some(handshake) = handshake else { let _ = socket.disconnect(); return };
            let guard = writes.lock().await;
            let candidate_key = format!("{}:{}", handshake.public_id, handshake.client_id);
            let saved_lease = match delivery_store.get_record(true, &candidate_key).await { Ok(row) => row, Err(_) => { let _ = socket.disconnect(); return } };
            let key = match core.lock() {
                Ok(mut core) => {
                    let had_peer = core.peers.contains_key(&candidate_key);
                    let key = core.connect(&handshake);
                    if !had_peer {
                        if let (Some(key), Some(commands)) = (key.as_ref(), saved_lease.as_ref().and_then(|row| restored_commands(row, &handshake, &candidate_key))) {
                            if let Some(peer) = core.peers.get_mut(key) { peer.commands = commands; }
                        }
                    }
                    key
                }, Err(_) => None
            };
            let Some(key) = key else { let _ = socket.disconnect(); return };
            let lease = core.lock().ok().and_then(|core| core.peers.get(&key).map(|peer| peer_document(&key, peer, handshake.now_ms)));
            let Some(lease) = lease else { let _ = socket.disconnect(); return };
            if delivery_store.put_record(true, &key, lease).await.is_err() { let _ = socket.disconnect(); return; }
            // Restore non-speech entries only: an old audio epoch must never be replayed.
            let saved = match delivery_store.list_records(false, handshake.now_ms).await { Ok(saved) => saved, Err(_) => { let _ = socket.disconnect(); return } };
            let mut replay = Vec::new();
            for row in saved {
                let Ok(event) = row.get_document("event") else { continue };
                if event.contains_key("tts") { continue; }
                let recipients: BTreeSet<String> = row.get_array("recipients").ok().into_iter().flatten().filter_map(|item| item.as_str().map(str::to_owned)).collect();
                if !recipients.contains(&key) { continue; }
                let (Ok(id), Ok(channel), Ok(kind), Ok(expires)) = (row.get_str("_id"), row.get_str("channel"), event.get_str("kind"), row.get_datetime("expiresAt")) else { continue };
                if channel != handshake.channel { continue; }
                let platform = match event.get_str("platform").unwrap_or("twitch") { "kick" => OverlayPlatform::Kick, "other" => OverlayPlatform::Other, _ => OverlayPlatform::Twitch };
                let payload = crate::utils::bson_json::compiler_bson_json(&mongodb::bson::Bson::Document(event.clone()));
                let item = PendingDelivery { id: id.to_owned(), channel: channel.to_owned(), kind: kind.to_owned(), platform, event: payload.clone(), recipients, tts: false };
                if let Ok(mut core) = core.lock() { core.enqueue(item, expires.timestamp_millis()); }
                replay.push(payload);
            }
            if let Ok(mut current) = epochs.lock() { current.insert(key.clone(), socket_id.clone()); }
            let previous = sockets.attach(&key, socket.clone());
            if let Some(previous) = previous { let _ = previous.disconnect(); }
            if let Ok(mut core) = core.lock() { core.replace_tts_epoch(&key, &socket_id); }
            drop(guard);
            let ack_core = core.clone();
            let ack_key = key.clone();
            let ack_epochs = epochs.clone();
            let ack_socket_id = socket_id.clone();
            let ack_store = delivery_store.clone();
            let ack_writes = writes.clone();
            socket.on("overlay-control-ack", move |TryData(data): TryData<serde_json::Value>| {
                let core = ack_core.clone(); let key = ack_key.clone(); let epochs = ack_epochs.clone(); let socket_id = ack_socket_id.clone(); let store = ack_store.clone(); let writes = ack_writes.clone();
                async move {
                    let Some(id) = data.ok().and_then(|value| value.as_str().map(str::to_owned)) else { return };
                    if epochs.lock().ok().and_then(|current| current.get(&key).cloned()).as_deref() != Some(socket_id.as_str()) { return; }
                    let _write = writes.lock().await;
                    if epochs.lock().ok().and_then(|current| current.get(&key).cloned()).as_deref() != Some(socket_id.as_str()) { return; }
                    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|value| value.as_millis().min(i64::MAX as u128) as i64).unwrap_or(0);
                    let lease = if let Ok(mut core) = core.lock() {
                        core.acknowledge_command(&key, &id);
                        core.peers.get(&key).map(|peer| peer_document(&key, peer, now))
                    } else { None };
                    if let Some(lease) = lease { let _ = store.put_record(true, &key, lease).await; }
                }
            });
            let playback_core = core.clone();
            let playback_epochs = epochs.clone();
            let playback_key = key.clone();
            let playback_socket_id = socket_id.clone();
            socket.on("overlay-playback", move |TryData(data): TryData<serde_json::Value>| {
                let core = playback_core.clone(); let epochs = playback_epochs.clone(); let key = playback_key.clone(); let socket_id = playback_socket_id.clone();
                async move {
                    if epochs.lock().ok().and_then(|current| current.get(&key).cloned()).as_deref() != Some(socket_id.as_str()) { return; }
                    let Ok(data) = data else { return };
                    let parse = |name: &str| -> Option<Vec<String>> { data.get(name)?.as_array()?.iter().map(|value| value.as_str().map(str::to_owned)).collect() };
                    let (Some(active), Some(queued)) = (parse("active"), parse("queued")) else { return };
                    if let Ok(mut core) = core.lock() { core.report_playback(&key, active, queued); }
                }
            });
            let end_core = core.clone();
            let end_key = key.clone();
            let end_epochs = epochs.clone();
            let end_socket_id = socket_id.clone();
            let end_store = delivery_store.clone();
            let end_writes = writes.clone();
            socket.on("overlay-ended", move |TryData(data): TryData<serde_json::Value>, ack: AckSender| {
                let core = end_core.clone(); let key = end_key.clone(); let epochs = end_epochs.clone(); let socket_id = end_socket_id.clone(); let store = end_store.clone(); let writes = end_writes.clone();
                async move {
                    let Some(id) = data.ok().and_then(|value| value.as_str().map(str::to_owned)) else { return };
                    if epochs.lock().ok().and_then(|current| current.get(&key).cloned()).as_deref() != Some(socket_id.as_str()) { return; }
                    let _write = writes.lock().await;
                    if epochs.lock().ok().and_then(|current| current.get(&key).cloned()).as_deref() != Some(socket_id.as_str()) { return; }
                    let is_tts = core.lock().ok().and_then(|core| core.pending.iter().find(|item| item.id == id && item.recipients.contains(&key)).map(|item| item.tts)).unwrap_or(false);
                    if is_tts { return; }
                    let collection = store.deliveries();
                    let update = collection.update_one(mongodb::bson::doc! { "_id": &id, "recipients": &key, "event.tts": { "$exists": false } }, mongodb::bson::doc! { "$pull": { "recipients": &key } }).await;
                    if update.is_err() { return; }
                    let record = match collection.find_one(mongodb::bson::doc! { "_id": &id }).await { Ok(record) => record, Err(_) => return };
                    if let Some(record) = record {
                        if record.get_document("event").ok().is_some_and(|event| event.contains_key("tts")) { return; }
                        if record.get_array("recipients").is_ok_and(|recipients| recipients.is_empty()) {
                            let media_id = record.get_str("mediaId").ok().map(str::to_owned);
                            if collection.update_one(mongodb::bson::doc! { "_id": &id, "recipients": { "$size": 0 } }, mongodb::bson::doc! { "$unset": { "mediaId": "", "bytes": "" } }).await.is_err() { return; }
                            if let Some(media_id) = media_id { if store.release(&media_id).await.is_err() { return; } }
                        }
                    }
                    if let Ok(mut core) = core.lock() {
                        if let Some(item) = core.pending.iter_mut().find(|item| item.id == id) { item.recipients.remove(&key); }
                        core.remove_empty();
                    }
                    let _ = ack.send(&());
                }
            });
            let disconnect_widget_peers = widget_peers.clone();
            let disconnect_core = core.clone();
            let disconnect_key = key.clone();
            let disconnect_epochs = epochs.clone();
            let disconnect_sockets = sockets.clone();
            let disconnect_store = delivery_store.clone();
            let disconnect_writes = writes.clone();
            socket.on_disconnect(move |socket: SocketRef| {
                let widget_peers = disconnect_widget_peers.clone();
                let core = disconnect_core.clone(); let key = disconnect_key.clone(); let epochs = disconnect_epochs.clone(); let sockets = disconnect_sockets.clone(); let store = disconnect_store.clone(); let writes = disconnect_writes.clone();
                async move {
                    let _write = writes.lock().await;
                    let socket_id = socket.id.to_string();
                    let current = if let Ok(mut epochs) = epochs.lock() {
                        if epochs.get(&key) == Some(&socket_id) { epochs.remove(&key); true } else { false }
                    } else { false };
                    if current {
                        if let Ok(mut peers) = widget_peers.lock() {
                            if peers.get(&key).is_some_and(|peer| peer.socket.id.to_string() == socket_id) { peers.remove(&key); }
                        }
                        sockets.detach(&key, &socket_id);
                        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|value| value.as_millis().min(i64::MAX as u128) as i64).unwrap_or(0);
                        let speech_ids = core.lock().map(|core| core.pending.iter().filter(|item| item.tts && item.recipients.contains(&key)).map(|item| item.id.clone()).collect::<Vec<_>>()).unwrap_or_default();
                        for id in speech_ids {
                            let collection = store.deliveries();
                            if collection.update_one(mongodb::bson::doc! { "_id": &id, "recipients": &key }, mongodb::bson::doc! { "$pull": { "recipients": &key } }).await.is_err() { continue; }
                            if let Ok(Some(record)) = store.get_record(false, &id).await {
                                if record.get_array("recipients").is_ok_and(|recipients| recipients.is_empty()) {
                                    let media = record.get_str("mediaId").ok().map(str::to_owned);
                                    if collection.update_one(mongodb::bson::doc! { "_id": &id, "recipients": { "$size": 0 } }, mongodb::bson::doc! { "$unset": { "mediaId": "", "bytes": "" } }).await.is_ok() {
                                        if let Some(media) = media { let _ = store.release(&media).await; }
                                    }
                                }
                            }
                        }
                        let lease = if let Ok(mut core) = core.lock() {
                            core.disconnect(&key, now);
                            core.peers.get(&key).map(|peer| peer_document(&key, peer, now))
                        } else { None };
                        if let Some(lease) = lease { let _ = store.put_record(true, &key, lease).await; }
                    }
                }
            });
            let mut initial_state = handshake.initial_state.clone();
            let scene_snapshot = initial_state.get("snapshot").cloned().unwrap_or(serde_json::Value::Null);
            let widgets = overlay_live_widget_inputs(&scene_snapshot);
            let result = widget_registry.snapshot_once(&handshake.channel, &widgets, overlay_live_widget_now()).await;
            // The connection may have been replaced while the provider was reading.
            if epochs.lock().ok().and_then(|current| current.get(&key).cloned()).as_deref() != Some(socket_id.as_str()) || !socket.connected() { return; }
            let Some((widget_payload, interactions, widget_version, interaction_version)) = overlay_live_widget_payload(&result) else { let _ = socket.disconnect(); return };
            if let Some(object) = initial_state.as_object_mut() {
                if let Some(fields) = widget_payload.as_object() { object.extend(fields.clone()); }
                if let Some(interactions) = interactions { object.insert("interactions".into(), interactions); }
                let commands = core.lock().ok().and_then(|core| core.peers.get(&key).map(|peer| peer_document(&key, peer, handshake.now_ms).get_array("commands").cloned().unwrap_or_default())).unwrap_or_default();
                object.insert("commands".into(), serde_json::to_value(commands).unwrap_or_default());
                let ids = core.lock().map(|core| core.replay_ids(&key).into_iter().map(str::to_owned).collect::<Vec<_>>()).unwrap_or_default();
                object.insert("pendingIds".into(), serde_json::json!(ids));
            }
            if let Ok(current) = epochs.lock() {
                if current.get(&key) != Some(&socket_id) || !socket.connected() { return; }
                let _ = socket.emit("overlay-state", &initial_state);
                if let Ok(mut peers) = widget_peers.lock() {
                    peers.insert(key.clone(), WidgetPeer { socket: socket.clone(), public_id: handshake.public_id.clone(), channel: handshake.channel.clone(), snapshot: scene_snapshot, revision: initial_state.get("revision").cloned().unwrap_or(serde_json::Value::Null), controls: initial_state.get("controls").cloned().unwrap_or(serde_json::Value::Null), widget_version, interaction_version });
                }
            } else { return; }
            if let Ok(current) = epochs.lock() {
                if current.get(&key) == Some(&socket_id) {
                    if let Ok(mut core) = core.lock() { if let Some(peer) = core.peers.get_mut(&key) { peer.state_failed = !result.failed_sources.is_empty(); } }
                }
            }
            overlay_live_lifecycle_resync(&resync, &core, &epochs, &key, &socket_id, &handshake.channel, overlay_live_lifecycle_kinds(&widgets));
            for event in replay {
                if let Ok(data) = serde_json::from_str::<serde_json::Value>(&event.to_json_string()) { let _ = socket.emit("overlay-event", &data); }
            }
            tokio::spawn(async move {
                let activation_result = overlay_activation_run(activation.as_ref(), &handshake.channel, &initial_state["snapshot"]).await;
                if let Ok(current) = epochs.lock() {
                    if current.get(&key) == Some(&socket_id) {
                        if let Ok(mut core) = core.lock() { if let Some(peer) = core.peers.get_mut(&key) { overlay_activation_result(peer, &activation_result, overlay_live_widget_now()); } }
                    }
                }
            });
        }
    };
    let middleware_prepared = prepared.clone();
    let middleware = move |socket: SocketRef, TryData(auth): TryData<serde_json::Value>| {
        let store = store.clone(); let prepared = middleware_prepared.clone(); let extract = extract.clone();
        async move {
            let auth = auth.map_err(|_| "Overlay unavailable")?;
            let client = auth.get("clientId").and_then(serde_json::Value::as_str).filter(|id| valid_client_id(id)).ok_or("Overlay unavailable")?;
            let mut handshake = extract(&socket).ok_or("Overlay unavailable")?;
            let namespace = socket.ns().to_owned();
            if namespace.strip_prefix("/overlay-studio/") != Some(handshake.public_id.as_str()) || handshake.client_id != client { return Err("Overlay unavailable"); }
            let published = store.public_state(&handshake.public_id).await.map_err(|_| "Overlay unavailable")?;
            handshake.channel = published.channel;
            handshake.initial_state = serde_json::json!({ "publicId": published.public_id, "revision": published.revision, "snapshot": published.snapshot, "controls": published.controls });
            prepared.lock().map_err(|_| "Overlay unavailable")?.insert(socket.id.to_string(), handshake);
            Ok::<(), &'static str>(())
        }
    };
    io.dyn_ns("/overlay-studio/{id}", handler.with(middleware)).map_err(|error| format!("{error:?}"))?;
    tokio::spawn(widget_poll);
    bridge.register_native(bridge_core, bridge_store, bridge_sockets, writes);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct OverlayActivationFixture { calls: Mutex<Vec<String>>, fail_clip: bool, fail_tts: bool }
    impl OverlaySourceActivation for OverlayActivationFixture {
        fn activate_clip<'a>(&'a self, channel: &'a str) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
            Box::pin(async move { self.calls.lock().unwrap().push(format!("clip:{channel}")); if self.fail_clip { Err("clip".into()) } else { Ok(()) } })
        }
        fn resume_tts<'a>(&'a self, channel: &'a str) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
            Box::pin(async move { self.calls.lock().unwrap().push(format!("tts:{channel}")); if self.fail_tts { Err("tts".into()) } else { Ok(()) } })
        }
    }
    #[tokio::test]
    async fn overlay_activation_selects_visible_sources_and_stops_on_clip_failure() {
        let scene = serde_json::json!({"widgets": [
            {"visible": true, "kind": "alert", "events": ["clip"]},
            {"visible": true, "kind": "tts"}, {"visible": false, "kind": "clip"}
        ]});
        let fixture = OverlayActivationFixture::default();
        assert!(overlay_activation_run(&fixture, "123", &scene).await.is_ok());
        assert_eq!(*fixture.calls.lock().unwrap(), vec!["clip:123", "tts:123"]);
        let failure = OverlayActivationFixture { fail_clip: true, ..Default::default() };
        assert!(overlay_activation_run(&failure, "123", &scene).await.is_err());
        assert_eq!(*failure.calls.lock().unwrap(), vec!["clip:123"]);
        let hidden = serde_json::json!({"widgets":[{"visible":false,"kind":"tts"},{"visible":true,"kind":"alert","events":["follow"]}]});
        let empty = OverlayActivationFixture::default();
        assert!(overlay_activation_run(&empty, "123", &hidden).await.is_ok());
        assert!(empty.calls.lock().unwrap().is_empty());
    }
    #[test]
    fn overlay_activation_retries_after_five_seconds_or_immediately_on_revision_change() {
        let handshake = Handshake { public_id: "a".repeat(48), client_id: "client-identity-0001".into(), channel: "123".into(), platform: None, scopes: BTreeSet::new(), initial_state: serde_json::Value::Null, now_ms: 0 };
        let mut core = LiveCore::default();
        let key = core.connect(&handshake).unwrap();
        let peer = core.peers.get_mut(&key).unwrap();
        overlay_activation_result(peer, &Err("tts".into()), 100);
        assert!(peer.activation_failed);
        assert!(!overlay_activation_due(peer, false, 5099));
        assert!(overlay_activation_due(peer, false, 5100));
        assert!(overlay_activation_due(peer, true, 101));
        overlay_activation_result(peer, &Ok(()), 5100);
        assert!(!peer.activation_failed);
        assert!(!overlay_activation_due(peer, false, 9000));
        peer.disconnected_at = Some(1);
        assert!(!overlay_activation_due(peer, true, 9000));
    }
    #[test]
    fn overlay_activation_recovery_error_only_marks_current_socket() {
        let handshake = Handshake { public_id: "a".repeat(48), client_id: "client-identity-0001".into(), channel: "123".into(), platform: None, scopes: BTreeSet::new(), initial_state: serde_json::Value::Null, now_ms: 0 };
        let mut core = LiveCore::default();
        let key = core.connect(&handshake).unwrap();
        let epochs = BTreeMap::from([(key.clone(), "new".to_owned())]);
        overlay_activation_mark_recovery_failure(&mut core, &epochs, &key, "old");
        assert!(!core.peers[&key].state_failed);
        overlay_activation_mark_recovery_failure(&mut core, &epochs, &key, "new");
        assert!(core.peers[&key].state_failed);
    }
    #[test]
    fn overlay_live_lifecycle_overdue_only_recovers_visible_valid_active_states_after_grace() {
        use crate::domain_event_contracts::interaction::InteractionKind;
        let widgets = overlay_live_widget_inputs(&serde_json::json!({"widgets": [
            {"kind":"poll", "visible":true},
            {"kind":"prediction", "visible":false},
            {"kind":"poll", "visible":true, "configVersion":2}
        ]}));
        let states = serde_json::json!({
            "poll":{"phase":"active", "deadline":"2020-01-01T00:00:00.000Z"},
            "prediction":{"phase":"active", "deadline":"2020-01-01T00:00:00.000Z"}
        });
        let deadline = crate::utils::js_date::parse_date("2020-01-01T00:00:00.000Z").unwrap();
        assert_eq!(overlay_live_lifecycle_kinds(&widgets), vec![InteractionKind::Poll]);
        assert!(overlay_live_lifecycle_overdue(&widgets, Some(&states), deadline + 5000).is_empty());
        assert_eq!(overlay_live_lifecycle_overdue(&widgets, Some(&states), deadline + 5001), vec![InteractionKind::Poll]);
        assert!(overlay_live_lifecycle_overdue(&widgets, None, deadline + 5001).is_empty());
        let ended = serde_json::json!({"poll":{"phase":"ended", "deadline":"2020-01-01T00:00:00.000Z"}});
        assert!(overlay_live_lifecycle_overdue(&widgets, Some(&ended), deadline + 5001).is_empty());
    }

    struct OverlayLiveWidgetSource {
        reads: Arc<std::sync::atomic::AtomicUsize>,
        fail: Arc<AtomicBool>,
    }
    impl super::super::widget_state::WidgetStateSource for OverlayLiveWidgetSource {
        fn source(&self) -> &str { super::super::widget_state_providers::INTERACTION_SOURCE }
        fn snapshot<'a>(&'a self, _channel: &'a str, _now_ms: i64) -> super::super::widget_state::StateFuture<'a, super::super::widget_contract::WidgetStates> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                if self.fail.load(Ordering::SeqCst) { return Err("private database error".into()); }
                Ok(super::super::widget_contract::WidgetStates::from([
                    ("poll".into(), super::super::widget_contract::WidgetStateEntry { revision: 7.0, state: crate::utils::lossless_json::parse_json(r#"{"revision":7,"title":"poll"}"#).unwrap() }),
                    ("prediction".into(), super::super::widget_contract::WidgetStateEntry { revision: 3.0, state: crate::utils::lossless_json::parse_json(r#"{"revision":3,"title":"prediction"}"#).unwrap() }),
                ]))
            })
        }
    }
    #[tokio::test]
    async fn overlay_live_lifecycle_failed_source_preserves_legacy_until_recovery() {
        let fail = Arc::new(AtomicBool::new(true));
        let source = Arc::new(OverlayLiveWidgetSource { reads: Arc::new(std::sync::atomic::AtomicUsize::new(0)), fail: fail.clone() });
        let registry = super::super::widget_state::WidgetStateRegistry::with_sources(vec![source]).unwrap();
        let widgets = overlay_live_widget_inputs(&serde_json::json!({"widgets":[{"kind":"poll","visible":true}]}));
        let failed = registry.snapshot_once("channel", &widgets, 1).await;
        let (_, legacy, _, version) = overlay_live_widget_payload(&failed).unwrap();
        assert!(legacy.is_none() && version.is_none());
        assert!(overlay_live_lifecycle_overdue(&widgets, legacy.as_ref(), 1).is_empty());
        fail.store(false, Ordering::SeqCst);
        let recovered = registry.snapshot_once("channel", &widgets, 2).await;
        let (_, legacy, _, version) = overlay_live_widget_payload(&recovered).unwrap();
        assert_eq!(legacy.unwrap()["poll"]["revision"], 7);
        assert!(version.is_some());
    }
    #[tokio::test]
    async fn overlay_live_widget_cycle_shares_reads_but_projects_each_scene() {
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let fail = Arc::new(AtomicBool::new(false));
        let source = Arc::new(OverlayLiveWidgetSource { reads: reads.clone(), fail });
        let registry = super::super::widget_state::WidgetStateRegistry::with_sources(vec![source]).unwrap();
        let first = overlay_live_widget_inputs(&serde_json::json!({"widgets":[{"kind":"poll","visible":true},{"kind":"prediction","visible":false}]}));
        let second = overlay_live_widget_inputs(&serde_json::json!({"widgets":[{"kind":"prediction","visible":true},{"kind":"poll","visible":true,"configVersion":2}]}));
        let scope = registry.create_read_scope();
        let a = registry.snapshot("channel", &first, &scope, 42).await;
        let b = registry.snapshot("channel", &second, &scope, 42).await;
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        let (a, legacy, _, _) = overlay_live_widget_payload(&a).unwrap();
        assert_eq!(a["widgetStates"]["poll"]["revision"].as_f64(), Some(7.0));
        assert!(a["widgetStates"].get("prediction").is_none());
        let legacy = legacy.unwrap();
        assert_eq!(legacy["poll"]["title"], "poll");
        assert!(legacy["prediction"].is_null());
        assert_eq!(legacy["serverTime"].as_f64(), Some(42.0));
        let (b, _, _, _) = overlay_live_widget_payload(&b).unwrap();
        assert_eq!(b["widgetStates"]["prediction"]["revision"].as_f64(), Some(3.0));
        assert!(b["widgetStates"].get("poll").is_none());
        registry.snapshot_once("channel", &first, 43).await;
        assert_eq!(reads.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn overlay_live_widget_failure_omits_legacy_and_recovers_without_leaking_error() {
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let fail = Arc::new(AtomicBool::new(true));
        let source = Arc::new(OverlayLiveWidgetSource { reads: reads.clone(), fail: fail.clone() });
        let registry = super::super::widget_state::WidgetStateRegistry::with_sources(vec![source]).unwrap();
        let widgets = overlay_live_widget_inputs(&serde_json::json!({"widgets":[{"kind":"poll","visible":true}]}));
        let failed = registry.snapshot_once("channel", &widgets, 1).await;
        let (payload, legacy, failed_version, version) = overlay_live_widget_payload(&failed).unwrap();
        assert!(legacy.is_none() && version.is_none());
        assert_eq!(payload["failedSources"], serde_json::json!(["twitch-interactions"]));
        assert_eq!(payload["widgetStates"], serde_json::json!({}));
        assert!(!payload.to_string().contains("private"));
        fail.store(false, Ordering::SeqCst);
        let recovered = registry.snapshot_once("channel", &widgets, 2).await;
        let (_, legacy, recovered_version, version) = overlay_live_widget_payload(&recovered).unwrap();
        assert!(legacy.is_some() && version.is_some());
        assert_ne!(failed_version, recovered_version);
        assert_eq!(reads.load(Ordering::SeqCst), 2);
    }
    #[test]
    fn overlay_delivery_restores_only_matching_unexpired_lease_commands() {
        use mongodb::bson::{doc, DateTime};
        let handshake = Handshake { public_id: "a".repeat(48), client_id: "client-identity-0001".into(), channel: "123456".into(), platform: None, scopes: BTreeSet::new(), initial_state: serde_json::Value::Null, now_ms: 100 };
        let key = format!("{}:{}", handshake.public_id, handshake.client_id);
        let mut row = doc! { "_id": &key, "publicId": &handshake.public_id, "channel": &handshake.channel, "expiresAt": DateTime::from_millis(101), "commands": [{ "id": "command", "action": "skip", "platform": "twitch", "eventIds": ["event"] }] };
        let commands = restored_commands(&row, &handshake, &key).expect("matching lease");
        assert_eq!(commands[0].event_ids, vec!["event"]);
        assert_eq!(commands[0].platform, OverlayScope::Platform(OverlayPlatform::Twitch));
        row.insert("expiresAt", DateTime::from_millis(100));
        assert!(restored_commands(&row, &handshake, &key).is_none());
        row.insert("expiresAt", DateTime::from_millis(101));
        row.insert("channel", "another-channel");
        assert!(restored_commands(&row, &handshake, &key).is_none());
    }
    #[test]
    fn client_identity_checks_length_and_grammar() {
        assert!(valid_client_id("client-identity-0001"));
        assert!(!valid_client_id("short"));
        assert!(!valid_client_id("client-identity_0001"));
    }
    #[test]
    fn reconnecting_ends_at_lease_boundary() {
        let peer = Peer { public_id: String::new(), client_id: String::new(), channel: String::new(), platform: None, scopes: BTreeSet::new(), connected_at: 0, disconnected_at: Some(1), commands: vec![], activation_failed: false, activation_retry_at: 0, state_failed: false };
        assert!(reconnecting(&peer, LEASE_MS));
        assert!(!reconnecting(&peer, LEASE_MS + 1));
    }
    #[test]
    fn replay_excludes_speech_and_preserves_order() {
        let mut core = LiveCore::default();
        for (id, tts) in [("first", false), ("speech", true), ("last", false)] {
            core.pending.push(PendingDelivery { id: id.into(), channel: "1".into(), kind: "tts".into(), platform: OverlayPlatform::Twitch, event: JsonValue::Null, recipients: BTreeSet::from(["source".into()]), tts });
        }
        assert_eq!(core.replay_ids("source"), vec!["first", "last"]);
    }
    #[test]
    fn superseding_an_epoch_cancels_the_previous_owner() {
        let mut core = LiveCore::default();
        let old = core.replace_tts_epoch("peer", "one");
        let new = core.replace_tts_epoch("peer", "two");
        assert!(old.load(Ordering::SeqCst)); assert!(!new.load(Ordering::SeqCst));
        assert!(!core.owns_tts_epoch("peer", "one")); assert!(core.owns_tts_epoch("peer", "two"));
    }
    #[test]
    fn duplicate_deliveries_are_rejected_and_expire_in_order() {
        let mut core = LiveCore::default();
        let item = |id: &str| PendingDelivery { id: id.into(), channel: "1".into(), kind: "clip".into(), platform: OverlayPlatform::Twitch, event: JsonValue::Null, recipients: BTreeSet::from(["p".into()]), tts: false };
        assert!(core.enqueue(item("a"), 10)); assert!(!core.enqueue(item("a"), 20)); assert!(core.enqueue(item("b"), 10));
        assert_eq!(core.poll_expired(10), vec!["a", "b"]);
    }
    #[test]
    fn disconnect_revokes_speech_but_keeps_other_delivery() {
        let mut core = LiveCore::default();
        let cancelled = core.replace_tts_epoch("p", "one");
        for (id, tts) in [("speech", true), ("clip", false)] {
            core.enqueue(PendingDelivery { id: id.into(), channel: "1".into(), kind: "tts".into(), platform: OverlayPlatform::Twitch, event: JsonValue::Null, recipients: BTreeSet::from(["p".into()]), tts }, 100);
        }
        assert_eq!(core.disconnect("p", 1), vec!["speech"]);
        assert!(cancelled.load(Ordering::SeqCst)); assert_eq!(core.replay_ids("p"), vec!["clip"]);
    }
    #[test]
    fn reconnect_supersedes_active_speech_epoch() {
        let mut core = LiveCore::default();
        let handshake = Handshake { public_id: "a".repeat(48), client_id: "client-identity-0001".into(), channel: "1".into(), platform: None, scopes: BTreeSet::new(), initial_state: serde_json::Value::Null, now_ms: 0 };
        let key = core.connect(&handshake).expect("valid peer");
        let previous = core.replace_tts_epoch(&key, "old");
        core.connect(&handshake).expect("reconnect");
        assert!(previous.load(Ordering::SeqCst));
        assert!(!core.owns_tts_epoch(&key, "old"));
    }
    // Partial port of dima032_delivery.test.ts: epoch and replay assertions.
    #[test]
    fn disconnect_reconnect_with_same_client_never_replays_unseen_pending_audio_nor_reauthorizes_old_urls() {
        let mut core = LiveCore::default();
        let handshake = Handshake { public_id: "a".repeat(48), client_id: "client-identity-0001".into(), channel: "123456".into(), platform: None, scopes: BTreeSet::from(["tts".into()]), initial_state: serde_json::Value::Null, now_ms: 0 };
        let key = core.connect(&handshake).expect("valid peer");
        let old = core.replace_tts_epoch(&key, "epoch-one");
        core.enqueue(PendingDelivery { id: "lost-delivery".into(), channel: "123456".into(), kind: "tts".into(), platform: OverlayPlatform::Twitch, event: JsonValue::Null, recipients: BTreeSet::from([key.clone()]), tts: true }, DELIVERY_TTL_MS_FOR_TEST);
        assert_eq!(core.disconnect(&key, 1), vec!["lost-delivery"]);
        core.connect(&handshake).expect("reconnect");
        core.replace_tts_epoch(&key, "epoch-two");
        assert!(old.load(Ordering::SeqCst));
        assert!(!core.owns_tts_epoch(&key, "epoch-one"));
        assert!(core.replay_ids(&key).is_empty());
    }
    // Partial source-oracle port: owner, caption and cross-scene correlation.
    #[test]
    fn one_elected_studio_owns_media_cross_scene_reused_client_id_stays_caption_only_and_cannot_fetch_owner_media() {
        let mut core = LiveCore::default();
        let scene_a = "a".repeat(48);
        let scene_b = "b".repeat(48);
        let handshake = |scene: &str, client: &str| Handshake { public_id: scene.into(), client_id: client.into(), channel: "123456".into(), platform: None, scopes: BTreeSet::from(["tts".into()]), initial_state: serde_json::Value::Null, now_ms: 0 };
        let owner = core.connect(&handshake(&scene_a, "client-identity-0001")).expect("owner");
        let caption = core.connect(&handshake(&scene_a, "client-identity-0002")).expect("caption");
        let other = core.connect(&handshake(&scene_b, "client-identity-0001")).expect("other scene");
        core.replace_tts_epoch(&owner, "socket-owner");
        core.replace_tts_epoch(&caption, "socket-caption");
        core.replace_tts_epoch(&other, "socket-other-scene");
        core.enqueue(PendingDelivery { id: "speech-a".into(), channel: "123456".into(), kind: "tts".into(), platform: OverlayPlatform::Twitch, event: JsonValue::Null, recipients: BTreeSet::from([owner.clone(), caption.clone(), other.clone()]), tts: true }, DELIVERY_TTL_MS_FOR_TEST);
        assert!(core.register_speech_ownership("speech-a", SpeechOwnership { speech_id: "speech-a".into(), owner_key: Some(owner.clone()), epochs: BTreeMap::from([(owner, "socket-owner".into()), (caption, "socket-caption".into()), (other, "socket-other-scene".into())]), terminal: false }));
        assert!(core.owns_speech_media("speech-a", &scene_a, "client-identity-0001", "socket-owner"));
        assert!(!core.owns_speech_media("speech-a", &scene_b, "client-identity-0001", "socket-other-scene"));
        assert!(!core.owns_speech_media("speech-a", &scene_a, "client-identity-0002", "socket-caption"));
        assert!(!core.owns_speech_media("speech-a", &scene_a, "client-identity-0001", "forged-socket"));
        assert!(!core.accept_speech_report("speech-a", &scene_a, "client-identity-0002", "socket-caption", "speech-a", None));
        assert!(!core.accept_speech_report("speech-a", &scene_a, "client-identity-0001", "socket-owner", "wrong", None));
        assert!(core.accept_speech_report("speech-a", &scene_a, "client-identity-0001", "socket-owner", "speech-a", Some(("playing", 61.0))));
        assert!(!core.accept_speech_report("speech-a", &scene_a, "client-identity-0001", "socket-owner", "speech-a", Some(("playing", 3601.0))));
        assert!(core.accept_speech_report("speech-a", &scene_a, "client-identity-0001", "socket-owner", "speech-a", None));
        assert!(!core.accept_speech_report("speech-a", &scene_a, "client-identity-0001", "socket-owner", "speech-a", None));
    }
    const DELIVERY_TTL_MS_FOR_TEST: i64 = super::super::delivery_store::DELIVERY_TTL_MS;
}

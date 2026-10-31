//! DimaFX overlay authentication and socket lifecycle from
//! `dimafx-overlay.service.ts`. Secrets and application operations are injected;
//! the two-second poll runs only for connected, ready sockets. Socketioxide has
//! no connection-state recovery, so there is no session persistence to disable.

use sha2::{Digest, Sha256};
use std::fmt;

/// Overlay signing configuration is unavailable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OverlaySigningError;
impl fmt::Display for OverlaySigningError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("Overlay signing is unavailable") }
}
impl std::error::Error for OverlaySigningError {}

fn hmac(secret: &[u8], message: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 64];
    if secret.len() > key.len() { key[..32].copy_from_slice(&Sha256::digest(secret)); }
    else { key[..secret.len()].copy_from_slice(secret); }
    let mut inner = [0x36u8; 64];
    let mut outer = [0x5cu8; 64];
    for i in 0..64 { inner[i] ^= key[i]; outer[i] ^= key[i]; }
    let mut hash = Sha256::new();
    hash.update(inner);
    hash.update(message);
    let digest = hash.finalize();
    let mut hash = Sha256::new();
    hash.update(outer);
    hash.update(digest);
    hash.finalize().into()
}
fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes { output.push(DIGITS[(byte >> 4) as usize] as char); output.push(DIGITS[(byte & 15) as usize] as char); }
    output
}
/// Generate the HMAC-SHA256 token using an injected secret.
pub fn overlay_token(channel: &str, secret: Option<&str>) -> Result<String, OverlaySigningError> {
    let secret = secret.filter(|s| !s.is_empty()).ok_or(OverlaySigningError)?;
    Ok(hex(&hmac(secret.as_bytes(), format!("dimafx-overlay:{channel}").as_bytes())))
}
/// Check a channel and token using a fixed-time comparison for valid-length tokens.
pub fn authorize_dimafx_overlay(channel: &str, token: Option<&str>, secret: Option<&str>) -> Result<bool, OverlaySigningError> {
    if channel.is_empty() || !channel.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') { return Ok(false); }
    let Some(token) = token else { return Ok(false); };
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return Ok(false); }
    let expected = overlay_token(channel, secret)?;
    let mut diff = 0u8;
    for (a, b) in token.bytes().zip(expected.bytes()) { diff |= a ^ b; }
    Ok(diff == 0)
}
/// Construct the public overlay URL, applying JavaScript URI-component escaping.
pub fn dimafx_overlay_url(channel: &str, base: Option<&str>, secret: Option<&str>) -> Result<String, OverlaySigningError> {
    let base = base.filter(|s| !s.is_empty()).unwrap_or("https://api.domdimabot.com").trim_end_matches('/');
    let mut encoded = String::new();
    const DIGITS: &[u8; 16] = b"0123456789ABCDEF";
    for b in channel.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) { encoded.push(b as char); }
        else { encoded.push('%'); encoded.push(DIGITS[(b >> 4) as usize] as char); encoded.push(DIGITS[(b & 15) as usize] as char); }
    }
    Ok(format!("{base}/overlays/dimafx/{encoded}?token={}", overlay_token(channel, secret)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn rfc_4231_hmac_vector() {
        assert_eq!(hex(&hmac(&[0x0b; 20], b"Hi There")), "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
    }
    #[test] fn invalid_token_short_circuits() { assert_eq!(authorize_dimafx_overlay("abc", Some("bad"), None), Ok(false)); }
    #[test] fn valid_token_roundtrip() { let token = overlay_token("abc", Some("key")).unwrap(); assert_eq!(authorize_dimafx_overlay("abc", Some(&token), Some("key")), Ok(true)); }
    #[test] fn url_encodes_channel() { assert!(dimafx_overlay_url("a/b", Some("https://example.test///"), Some("key")).unwrap().starts_with("https://example.test/overlays/dimafx/a%2Fb?token=")); }
}


use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}},
    time::Duration,
};
use socketioxide::{
    SocketIo,
    extract::{SocketRef, TryData},
    handler::ConnectHandler as _,
};

/// Source polling cadence. This waits for new queue and purchase work, not a
/// playback timeout; ready events also trigger an immediate poll.
pub const DIMAFX_OVERLAY_POLL_INTERVAL: Duration = Duration::from_millis(2_000);

/// Future returned by the application queue and purchase-recovery adapters.
pub type OverlayFuture<'a> = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;

/// Application-specific queue operations. The partial Mongo playback store is
/// not a replacement for the queue handler's dispatch and completion logic.
pub trait OverlayQueue: Send + Sync {
    /// Resume a channel's queue if no playback is active.
    fn resume_if_idle<'a>(&'a self, channel: &'a str) -> OverlayFuture<'a>;
    /// Persist an overlay's completion acknowledgement.
    fn handle_trigger_ended<'a>(&'a self, channel: &'a str, trigger: &'a str) -> OverlayFuture<'a>;
}

/// Contract of the excluded route's `recoverDimafxPurchases(channelID)`.
pub trait OverlayPurchaseRecovery: Send + Sync {
    /// Recover outstanding purchases for this channel.
    fn recover<'a>(&'a self, channel: &'a str) -> OverlayFuture<'a>;
}

/// Ready sockets for the queue delivery adapter. Entries are keyed by socket ID,
/// so disconnecting one overlay does not remove other overlays on the channel.
#[derive(Clone, Default)]
pub struct DimafxReadySockets {
    sockets: Arc<Mutex<HashMap<String, (String, SocketRef)>>>,
}
impl DimafxReadySockets {
    /// Snapshot the connected ready sockets for a channel.
    pub fn for_channel(&self, channel: &str) -> Vec<SocketRef> {
        self.sockets.lock().map(|sockets| sockets.values()
            .filter(|(id, socket)| id == channel && socket.connected())
            .map(|(_, socket)| socket.clone()).collect()).unwrap_or_default()
    }
    fn insert(&self, channel: &str, socket: SocketRef) {
        if let Ok(mut sockets) = self.sockets.lock() {
            sockets.insert(socket.id.to_string(), (channel.to_owned(), socket));
        }
    }
    fn remove(&self, socket: &SocketRef) {
        if let Ok(mut sockets) = self.sockets.lock() { sockets.remove(&socket.id.to_string()); }
    }
}

/// Handshake failure sent as the Socket.IO connect error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OverlayAuthError {
    /// Invalid namespace, token type or signature.
    Invalid,
    /// A validly shaped request cannot be checked without the signing secret.
    Unavailable,
}
impl fmt::Display for OverlayAuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Invalid => "Invalid DimaFX overlay token",
            Self::Unavailable => "DimaFX overlay authentication unavailable",
        })
    }
}
impl std::error::Error for OverlayAuthError {}

fn namespace_channel(namespace: &str) -> Option<&str> {
    let channel = namespace.strip_prefix("/overlays/dimafx/")?;
    if channel.is_empty() || !channel.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        return None;
    }
    Some(channel)
}

/// Apply the source's namespace and handshake authentication checks.
pub fn authorize_overlay_handshake(
    namespace: &str, auth: Option<&serde_json::Value>, secret: Option<&str>,
) -> Result<(), OverlayAuthError> {
    let channel = namespace_channel(namespace).ok_or(OverlayAuthError::Invalid)?;
    let token = auth.and_then(|auth| auth.get("token")).and_then(|token| token.as_str());
    match authorize_dimafx_overlay(channel, token, secret) {
        Ok(true) => Ok(()),
        Ok(false) => Err(OverlayAuthError::Invalid),
        Err(_) => Err(OverlayAuthError::Unavailable),
    }
}

struct OverlaySession {
    ready: AtomicBool,
    recovering: AtomicBool,
}
impl OverlaySession {
    fn new() -> Self { Self { ready: AtomicBool::new(false), recovering: AtomicBool::new(false) } }
    fn begin_recovery(&self) -> bool {
        self.recovering.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok()
    }
}

fn trigger_id(body: &serde_json::Value) -> Option<&str> {
    body.get("triggerID").and_then(serde_json::Value::as_str)
}

fn poll_overlay(
    socket: &SocketRef, channel: &str, session: &Arc<OverlaySession>,
    queue: &Arc<dyn OverlayQueue>, recovery: &Arc<dyn OverlayPurchaseRecovery>,
) {
    if !socket.connected() || !session.ready.load(Ordering::Acquire) { return; }
    let queue = queue.clone();
    let resume_channel = channel.to_owned();
    tokio::spawn(async move {
        // The TypeScript source deliberately does not await this operation.
        if let Err(error) = queue.resume_if_idle(&resume_channel).await {
            eprintln!("DimaFX queue resume failed: {error}");
        }
    });
    if !session.begin_recovery() { return; }
    let recovery = recovery.clone();
    let session = session.clone();
    let channel = channel.to_owned();
    tokio::spawn(async move { run_recovery(recovery.as_ref(), &channel, &session).await; });
}

async fn run_recovery(recovery: &dyn OverlayPurchaseRecovery, channel: &str, session: &OverlaySession) {
    if let Err(error) = recovery.recover(channel).await {
        eprintln!("DimaFX purchase recovery failed: {error}");
    }
    session.recovering.store(false, Ordering::Release);
}

/// Register the dynamic Socket.IO namespace with pre-join authentication.
/// The supplied queue and recovery must be real application adapters for use in
/// production. No I/O or task is started until a client connects.
pub fn register_dimafx_overlay(
    io: &SocketIo, secret: Option<String>, queue: Arc<dyn OverlayQueue>,
    recovery: Arc<dyn OverlayPurchaseRecovery>, ready_sockets: DimafxReadySockets,
) -> Result<(), socketioxide::NsInsertError> {
    let secret = Arc::new(secret);
    let middleware = async move |socket: SocketRef, TryData(auth): TryData<serde_json::Value>| {
        authorize_overlay_handshake(socket.ns(), auth.as_ref().ok(), secret.as_ref().as_deref())
    };
    let handler = move |socket: SocketRef| {
        let queue = queue.clone();
        let recovery = recovery.clone();
        let ready_sockets = ready_sockets.clone();
        async move {
            let Some(channel) = namespace_channel(socket.ns()).map(str::to_owned) else {
                let _ = socket.disconnect();
                return;
            };
            let session = Arc::new(OverlaySession::new());
            let ready_session = session.clone();
            let ready_queue = queue.clone();
            let ready_recovery = recovery.clone();
            let ready_registry = ready_sockets.clone();
            let ready_channel = channel.clone();
            socket.on("dimafx-ready", move |socket: SocketRef| {
                let session = ready_session.clone();
                let queue = ready_queue.clone();
                let recovery = ready_recovery.clone();
                let registry = ready_registry.clone();
                let channel = ready_channel.clone();
                async move {
                    if !socket.connected() { return; }
                    session.ready.store(true, Ordering::Release);
                    registry.insert(&channel, socket.clone());
                    // Recheck after insertion so a concurrent disconnect cannot
                    // leave an entry visible as ready.
                    if !socket.connected() {
                        session.ready.store(false, Ordering::Release);
                        registry.remove(&socket);
                        return;
                    }
                    poll_overlay(&socket, &channel, &session, &queue, &recovery);
                }
            });
            let ended_session = session.clone();
            let ended_queue = queue.clone();
            let ended_channel = channel.clone();
            socket.on("dimafx-ended", move |TryData(body): TryData<serde_json::Value>| {
                let session = ended_session.clone();
                let queue = ended_queue.clone();
                let channel = ended_channel.clone();
                async move {
                    if !session.ready.load(Ordering::Acquire) { return; }
                    let Some(trigger) = body.as_ref().ok().and_then(trigger_id) else { return };
                    if let Err(error) = queue.handle_trigger_ended(&channel, trigger).await {
                        eprintln!("DimaFX completion persistence failed: {error}");
                    }
                }
            });
            let timer_socket = socket.clone();
            let timer_session = session.clone();
            let timer = tokio::spawn(async move {
                let start = tokio::time::Instant::now() + DIMAFX_OVERLAY_POLL_INTERVAL;
                let mut interval = tokio::time::interval_at(start, DIMAFX_OVERLAY_POLL_INTERVAL);
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    interval.tick().await;
                    poll_overlay(&timer_socket, &channel, &timer_session, &queue, &recovery);
                }
            });
            let abort = timer.abort_handle();
            socket.on_disconnect(move |socket: SocketRef| {
                let session = session.clone();
                let ready_sockets = ready_sockets.clone();
                let abort = abort.clone();
                async move {
                    session.ready.store(false, Ordering::Release);
                    ready_sockets.remove(&socket);
                    abort.abort();
                }
            });
        }
    };
    io.dyn_ns("/overlays/dimafx/{id}", handler.with(middleware))
}

#[cfg(test)]
mod dimafx_overlay_socket_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn handshake_enforces_namespace_token_and_missing_secret_errors() {
        let token = overlay_token("abc_1", Some("secret")).unwrap();
        let auth = json!({"token": token});
        assert_eq!(authorize_overlay_handshake("/overlays/dimafx/abc_1", Some(&auth), Some("secret")), Ok(()));
        assert_eq!(authorize_overlay_handshake("/overlays/dimafx/abc-1", Some(&auth), Some("secret")), Err(OverlayAuthError::Invalid));
        assert_eq!(authorize_overlay_handshake("/overlays/dimafx/abc_1/extra", Some(&auth), Some("secret")), Err(OverlayAuthError::Invalid));
        assert_eq!(authorize_overlay_handshake("/overlays/dimafx/abc_1", Some(&auth), None), Err(OverlayAuthError::Unavailable));
        assert_eq!(authorize_overlay_handshake("/overlays/dimafx/abc_1", Some(&json!({"token": 42})), None), Err(OverlayAuthError::Invalid));
    }
    #[test]
    fn wrong_signature_and_token_format_are_rejected() {
        let token = overlay_token("abc", Some("key")).unwrap();
        assert_eq!(authorize_dimafx_overlay("abc", Some(&token), Some("other")), Ok(false));
        assert_eq!(authorize_dimafx_overlay("abc", Some(&token.to_uppercase()), Some("key")), Ok(false));
        assert_eq!(authorize_dimafx_overlay("abc", Some(&token[..63]), Some("key")), Ok(false));
    }
    #[test]
    fn recovery_is_single_flight_and_can_retry_after_failure() {
        let state = OverlaySession::new();
        assert!(!state.ready.load(Ordering::Acquire));
        assert!(state.begin_recovery());
        assert!(!state.begin_recovery());
        state.recovering.store(false, Ordering::Release);
        assert!(state.begin_recovery());
    }
    struct FailingRecovery;
    impl OverlayPurchaseRecovery for FailingRecovery {
        fn recover<'a>(&'a self, _: &'a str) -> OverlayFuture<'a> {
            Box::pin(async { Err("fixture failure".into()) })
        }
    }
    #[tokio::test]
    async fn recovery_failure_releases_guard_for_next_poll() {
        let state = OverlaySession::new();
        assert!(state.begin_recovery());
        run_recovery(&FailingRecovery, "abc", &state).await;
        assert!(state.begin_recovery());
    }
    #[test]
    fn ended_only_accepts_string_trigger_ids() {
        assert_eq!(trigger_id(&json!({"triggerID": "x"})), Some("x"));
        assert_eq!(trigger_id(&json!({"triggerID": 2})), None);
        assert_eq!(trigger_id(&json!(null)), None);
    }
}

//! Local tests (not upstream's, see `vendor/README.md`): the WebSocket upgrade of a polling
//! session, matched against `engine.io` 6.6.9 (`build/socket.js`, `Socket._maybeUpgrade`, and
//! `build/server.js`, `Server.onWebSocket`).

use std::{sync::Arc, time::Duration};

use bytes::Bytes;
use engineioxide::{
    Str,
    config::EngineIoConfig,
    handler::EngineIoHandler,
    service::EngineIoService,
    socket::{DisconnectReason, Socket},
};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

mod fixture;

use fixture::{create_polling_connection, create_ws_upgrade_connection, send_req_raw};

/// Echoes messages and reports disconnections.
#[derive(Debug, Clone)]
struct EchoHandler {
    disconnect_tx: mpsc::Sender<DisconnectReason>,
}

impl EngineIoHandler for EchoHandler {
    type Data = ();

    fn on_connect(self: Arc<Self>, _socket: Arc<Socket<()>>) {}
    fn on_disconnect(&self, _socket: Arc<Socket<()>>, reason: DisconnectReason) {
        self.disconnect_tx.try_send(reason).ok();
    }
    fn on_message(self: &Arc<Self>, msg: Str, socket: Arc<Socket<()>>) {
        socket.emit(msg).ok();
    }
    fn on_binary(self: &Arc<Self>, _data: Bytes, _socket: Arc<Socket<()>>) {}
}

/// A server whose heartbeat stays out of the way, with a short upgrade timeout.
fn server(
    upgrade_timeout: Duration,
) -> (
    EngineIoService<EchoHandler>,
    mpsc::Receiver<DisconnectReason>,
) {
    let (disconnect_tx, rx) = mpsc::channel(10);
    let config = EngineIoConfig::builder()
        .ping_interval(Duration::from_secs(60))
        .ping_timeout(Duration::from_secs(60))
        .upgrade_timeout(upgrade_timeout)
        .build();
    let svc = EngineIoService::with_config(Arc::new(EchoHandler { disconnect_tx }), config);
    (svc, rx)
}

async fn post(svc: &mut EngineIoService<EchoHandler>, sid: &str, body: &str) -> String {
    send_req_raw(
        svc,
        format!("transport=polling&sid={sid}"),
        http::Method::POST,
        Some(body.into()),
    )
    .await
}

/// Polls until a payload contains `wanted` (pings and noops are skipped); `false` on timeout.
async fn poll_until(svc: &mut EngineIoService<EchoHandler>, sid: &str, wanted: &str) -> bool {
    let attempt = async {
        loop {
            let payload = send_req_raw(
                svc,
                format!("transport=polling&sid={sid}"),
                http::Method::GET,
                None,
            )
            .await;
            if payload.split('\x1e').any(|packet| packet == wanted) {
                return;
            }
            // Polls answered at once in a loop would never let the timeout run.
            tokio::task::yield_now().await;
        }
    };
    tokio::time::timeout(Duration::from_secs(2), attempt)
        .await
        .is_ok()
}

/// Whether the next frame on the probe WebSocket is the server closing it.
async fn closed_by_server<S>(ws: &mut tokio_tungstenite::WebSocketStream<S>) -> bool
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        match tokio::time::timeout(Duration::from_secs(2), ws.next()).await {
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Ok(Some(Err(_))) => return true,
            Ok(Some(Ok(_))) => continue,
            Err(_) => return false,
        }
    }
}

/// The session is still open and still works over polling.
async fn still_polling(
    svc: &mut EngineIoService<EchoHandler>,
    rx: &mut mpsc::Receiver<DisconnectReason>,
    sid: &str,
) {
    assert_eq!(rx.try_recv().ok(), None, "the session was closed");
    assert_eq!(post(svc, sid, "4still here").await, "ok");
    assert!(
        poll_until(svc, sid, "4still here").await,
        "no echo over polling"
    );
    assert_eq!(rx.try_recv().ok(), None, "the session was closed");
}

/// `engine.io` socket.js 211-218: when the upgrade times out, only the new transport is closed.
/// A client behind a network that breaks WebSockets after the handshake stays on polling.
#[tokio::test]
async fn an_upgrade_that_times_out_leaves_the_session_on_polling() {
    let (mut svc, mut rx) = server(Duration::from_millis(100));
    let sid = create_polling_connection(&mut svc).await;
    let mut ws = create_ws_upgrade_connection(&mut svc, sid.parse().unwrap()).await;

    assert!(
        closed_by_server(&mut ws).await,
        "the probe WebSocket was not closed"
    );
    still_polling(&mut svc, &mut rx, &sid).await;
}

/// `engine.io` socket.js 211-218 after the probe was answered: the client never sends the upgrade
/// packet. Polls are answered again once the upgrade is given up.
#[tokio::test]
async fn an_upgrade_abandoned_after_the_probe_leaves_the_session_on_polling() {
    let (mut svc, mut rx) = server(Duration::from_millis(100));
    let sid = create_polling_connection(&mut svc).await;
    let mut ws = create_ws_upgrade_connection(&mut svc, sid.parse().unwrap()).await;
    ws.send(Message::Text("2probe".into())).await.unwrap();
    let pong = ws.next().await.unwrap().unwrap();
    assert_eq!(pong, Message::Text("3probe".into()));

    assert!(
        closed_by_server(&mut ws).await,
        "the probe WebSocket was not closed"
    );
    still_polling(&mut svc, &mut rx, &sid).await;
}

/// `engine.io` socket.js 264-272: the new transport closing during the probe ends the upgrade
/// only.
#[tokio::test]
async fn a_probe_websocket_closed_by_the_client_leaves_the_session_on_polling() {
    let (mut svc, mut rx) = server(Duration::from_secs(5));
    let sid = create_polling_connection(&mut svc).await;
    let mut ws = create_ws_upgrade_connection(&mut svc, sid.parse().unwrap()).await;
    ws.send(Message::Text("2probe".into())).await.unwrap();
    let pong = ws.next().await.unwrap().unwrap();
    assert_eq!(pong, Message::Text("3probe".into()));
    ws.close(None).await.unwrap();

    tokio::time::sleep(Duration::from_millis(50)).await;
    still_polling(&mut svc, &mut rx, &sid).await;
}

/// `engine.io` socket.js 243-246: any other packet during the probe closes the new transport,
/// not the session.
#[tokio::test]
async fn a_wrong_packet_during_the_probe_leaves_the_session_on_polling() {
    let (mut svc, mut rx) = server(Duration::from_secs(5));
    let sid = create_polling_connection(&mut svc).await;
    let mut ws = create_ws_upgrade_connection(&mut svc, sid.parse().unwrap()).await;
    ws.send(Message::Text("4hello".into())).await.unwrap();

    assert!(
        closed_by_server(&mut ws).await,
        "the probe WebSocket was not closed"
    );
    still_polling(&mut svc, &mut rx, &sid).await;
}

/// `engine.io` socket.js 220-226 and 249-254: polls are answered with a noop only once the probe
/// was answered (its `check` starts on the probe), so before it they wait for data as usual.
#[tokio::test]
async fn polls_carry_data_until_the_probe_is_answered() {
    let (mut svc, mut rx) = server(Duration::from_secs(5));
    let sid = create_polling_connection(&mut svc).await;
    let _ws = create_ws_upgrade_connection(&mut svc, sid.parse().unwrap()).await;
    tokio::time::sleep(Duration::from_millis(20)).await;

    still_polling(&mut svc, &mut rx, &sid).await;
}

/// `engine.io` socket.js 249-254: during the upgrade a poll gets a noop from the check that runs
/// every 100 ms, not at once (a client that missed the probe answer would otherwise poll in a
/// tight loop until the upgrade timeout).
#[tokio::test]
async fn polls_during_the_upgrade_get_a_noop_at_the_check_interval() {
    let (mut svc, _rx) = server(Duration::from_secs(5));
    let sid = create_polling_connection(&mut svc).await;
    let mut ws = create_ws_upgrade_connection(&mut svc, sid.parse().unwrap()).await;
    ws.send(Message::Text("2probe".into())).await.unwrap();
    ws.next().await.unwrap().unwrap();
    // The noop pushed for a pending poll, then the paced ones.
    let mut payloads = Vec::new();
    let start = tokio::time::Instant::now();
    for _ in 0..3 {
        payloads.push(
            send_req_raw(
                &mut svc,
                format!("transport=polling&sid={sid}"),
                http::Method::GET,
                None,
            )
            .await,
        );
    }
    assert!(
        payloads.iter().all(|p| p.split('\x1e').any(|p| p == "6")),
        "{payloads:?}"
    );
    assert!(
        start.elapsed() >= Duration::from_millis(150),
        "polls were answered in a tight loop: {:?}",
        start.elapsed()
    );
}

/// Reads the next text frame, or how the WebSocket ended.
async fn next_frame<S>(ws: &mut tokio_tungstenite::WebSocketStream<S>) -> String
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        match tokio::time::timeout(Duration::from_secs(2), ws.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => return text.as_str().to_owned(),
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Ok(Some(Err(_))) => {
                return "closed".into();
            }
            Ok(Some(Ok(_))) => continue,
            Err(_) => return "timeout".into(),
        }
    }
}

/// Upgrades over `ws` (probe answered already) and checks the session works over it.
async fn finish_upgrade<S>(ws: &mut tokio_tungstenite::WebSocketStream<S>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    ws.send(Message::Text("5".into())).await.unwrap();
    ws.send(Message::Text("4over ws".into())).await.unwrap();
    loop {
        match next_frame(ws).await.as_str() {
            "4over ws" => return,
            "6" | "2" => continue,
            other => panic!("unexpected frame after the upgrade: {other}"),
        }
    }
}

/// `engine.io` server.js 616-618: a WebSocket for a session that is already upgrading is closed
/// (after its handshake); the running upgrade and the session are untouched.
#[tokio::test]
async fn a_second_probe_during_an_upgrade_is_refused() {
    let (mut svc, mut rx) = server(Duration::from_secs(5));
    let sid = create_polling_connection(&mut svc).await;
    let mut first = create_ws_upgrade_connection(&mut svc, sid.parse().unwrap()).await;
    first.send(Message::Text("2probe".into())).await.unwrap();
    assert_eq!(next_frame(&mut first).await, "3probe");

    let mut second = create_ws_upgrade_connection(&mut svc, sid.parse().unwrap()).await;
    second.send(Message::Text("2probe".into())).await.ok();
    assert_eq!(next_frame(&mut second).await, "closed");

    finish_upgrade(&mut first).await;
    assert_eq!(rx.try_recv().ok(), None, "the session was closed");
}

/// `engine.io` server.js 620-622: a WebSocket for a session that has upgraded is closed.
#[tokio::test]
async fn a_probe_after_the_upgrade_is_refused() {
    let (mut svc, mut rx) = server(Duration::from_secs(5));
    let sid = create_polling_connection(&mut svc).await;
    let mut first = create_ws_upgrade_connection(&mut svc, sid.parse().unwrap()).await;
    first.send(Message::Text("2probe".into())).await.unwrap();
    assert_eq!(next_frame(&mut first).await, "3probe");
    finish_upgrade(&mut first).await;

    let mut late = create_ws_upgrade_connection(&mut svc, sid.parse().unwrap()).await;
    late.send(Message::Text("2probe".into())).await.ok();
    assert_eq!(next_frame(&mut late).await, "closed");

    first.send(Message::Text("4still".into())).await.unwrap();
    let mut frame = next_frame(&mut first).await;
    while frame == "2" {
        frame = next_frame(&mut first).await;
    }
    assert_eq!(frame, "4still");
    assert_eq!(rx.try_recv().ok(), None, "the session was closed");
}

/// Two probes at once: exactly one owns the upgrade (a single compare-and-set, where upstream
/// let both pass its `is_ws()` check), the other is closed, and the session upgrades over the
/// winner.
#[tokio::test]
async fn simultaneous_probes_upgrade_once() {
    for _ in 0..20 {
        let (mut svc, mut rx) = server(Duration::from_secs(5));
        let sid = create_polling_connection(&mut svc).await;
        let mut a = create_ws_upgrade_connection(&mut svc, sid.parse().unwrap()).await;
        let mut b = create_ws_upgrade_connection(&mut svc, sid.parse().unwrap()).await;
        a.send(Message::Text("2probe".into())).await.ok();
        b.send(Message::Text("2probe".into())).await.ok();
        let (first, second) = tokio::join!(next_frame(&mut a), next_frame(&mut b));
        let mut outcomes = [first.as_str(), second.as_str()];
        outcomes.sort_unstable();
        assert_eq!(outcomes, ["3probe", "closed"]);
        let winner = if first == "3probe" { &mut a } else { &mut b };
        finish_upgrade(winner).await;
        assert_eq!(rx.try_recv().ok(), None, "the session was closed");
    }
}

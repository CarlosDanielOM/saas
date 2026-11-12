//! Local tests (not upstream's, see `vendor/README.md`): the protocol 4 heartbeat, matched
//! against `engine.io` 6.6.9 (`build/socket.js`, `schedulePing`, `resetPingTimeout`, `onPacket`).

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
use tokio::{sync::mpsc, time::Instant};
use tokio_tungstenite::tungstenite::Message;

mod fixture;

use fixture::{create_polling_connection, create_ws_connection, send_req_raw};

#[derive(Debug, Clone)]
struct Handler {
    disconnect_tx: mpsc::Sender<DisconnectReason>,
}

impl EngineIoHandler for Handler {
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

const INTERVAL: Duration = Duration::from_millis(300);

fn server(timeout: Duration) -> (EngineIoService<Handler>, mpsc::Receiver<DisconnectReason>) {
    let (disconnect_tx, rx) = mpsc::channel(10);
    let config = EngineIoConfig::builder()
        .ping_interval(INTERVAL)
        .ping_timeout(timeout)
        .build();
    let svc = EngineIoService::with_config(Arc::new(Handler { disconnect_tx }), config);
    (svc, rx)
}

/// The next text frame (`closed` when the WebSocket ends, `timeout` after two seconds).
async fn next_text<S>(ws: &mut tokio_tungstenite::WebSocketStream<S>) -> String
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        match tokio::time::timeout(Duration::from_secs(2), ws.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => return text.as_str().to_owned(),
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Ok(Some(Err(_))) => {
                return "closed".into();
            }
            Ok(Some(Ok(_))) => {}
            Err(_) => return "timeout".into(),
        }
    }
}

/// socket.js 138-144: the first ping goes out one ping interval after the open packet.
#[tokio::test]
async fn the_first_ping_waits_one_interval_over_polling() {
    let (mut svc, _rx) = server(Duration::from_secs(5));
    let start = Instant::now();
    let sid = create_polling_connection(&mut svc).await;
    let poll = send_req_raw(
        &mut svc,
        format!("transport=polling&sid={sid}"),
        http::Method::GET,
        None,
    )
    .await;
    assert_eq!(poll, "2");
    assert!(
        start.elapsed() >= INTERVAL - Duration::from_millis(20),
        "the first ping came after {:?}",
        start.elapsed()
    );
}

/// The same over a WebSocket session.
#[tokio::test]
async fn the_first_ping_waits_one_interval_over_websocket() {
    let (mut svc, _rx) = server(Duration::from_secs(5));
    let start = Instant::now();
    let mut ws = create_ws_connection(&mut svc).await;
    assert!(next_text(&mut ws).await.starts_with('0'));
    assert_eq!(next_text(&mut ws).await, "2");
    assert!(
        start.elapsed() >= INTERVAL - Duration::from_millis(20),
        "the first ping came after {:?}",
        start.elapsed()
    );
}

/// socket.js 108-110: a pong restarts the interval, so the next ping comes one interval after
/// the pong (not on a fixed schedule from the open packet).
#[tokio::test]
async fn the_next_ping_comes_one_interval_after_the_pong() {
    let (mut svc, mut rx) = server(Duration::from_secs(5));
    let mut ws = create_ws_connection(&mut svc).await;
    assert!(next_text(&mut ws).await.starts_with('0'));
    assert_eq!(next_text(&mut ws).await, "2");
    tokio::time::sleep(Duration::from_millis(200)).await;
    ws.send(Message::Text("3".into())).await.unwrap();
    let pong = Instant::now();
    assert_eq!(next_text(&mut ws).await, "2");
    assert!(
        pong.elapsed() >= INTERVAL - Duration::from_millis(20),
        "the next ping came {:?} after the pong",
        pong.elapsed()
    );
    assert_eq!(rx.try_recv().ok(), None);
}

/// socket.js 93-97: in protocol 4 the client never pings; a ping is an error that closes the
/// session as a transport error.
#[tokio::test]
async fn a_ping_from_the_client_closes_a_websocket_session() {
    for ping in ["2", "2probe"] {
        let (mut svc, mut rx) = server(Duration::from_secs(5));
        let mut ws = create_ws_connection(&mut svc).await;
        assert!(next_text(&mut ws).await.starts_with('0'));
        ws.send(Message::Text(ping.into())).await.unwrap();
        let reason = tokio::time::timeout(Duration::from_millis(200), rx.recv()).await;
        assert_eq!(
            reason.ok().flatten(),
            Some(DisconnectReason::TransportError),
            "{ping}"
        );
        assert_eq!(next_text(&mut ws).await, "closed", "{ping}");
    }
}

/// The same in a polling POST: the session closes, and the payload is answered `ok` (polling.js
/// 120-131).
#[tokio::test]
async fn a_ping_from_the_client_closes_a_polling_session() {
    let (mut svc, mut rx) = server(Duration::from_secs(5));
    let sid = create_polling_connection(&mut svc).await;
    let answer = send_req_raw(
        &mut svc,
        format!("transport=polling&sid={sid}"),
        http::Method::POST,
        Some("2".into()),
    )
    .await;
    assert_eq!(answer, "ok");
    let reason = tokio::time::timeout(Duration::from_millis(200), rx.recv()).await;
    assert_eq!(
        reason.ok().flatten(),
        Some(DisconnectReason::TransportError)
    );
}

/// socket.js 103-111: a pong is never an error, even when one is already waiting to be counted
/// (upstream ended the session as a heartbeat timeout when the second could not be queued).
#[tokio::test]
async fn extra_pongs_do_not_end_the_session() {
    let (mut svc, mut rx) = server(Duration::from_secs(5));
    let mut ws = create_ws_connection(&mut svc).await;
    assert!(next_text(&mut ws).await.starts_with('0'));
    for _ in 0..5 {
        ws.send(Message::Text("3".into())).await.unwrap();
    }
    ws.send(Message::Text("4still".into())).await.unwrap();
    assert_eq!(next_text(&mut ws).await, "4still");
    assert_eq!(rx.try_recv().ok(), None, "the session was closed");

    let sid = create_polling_connection(&mut svc).await;
    let answer = send_req_raw(
        &mut svc,
        format!("transport=polling&sid={sid}"),
        http::Method::POST,
        Some("3\x1e3\x1e3\x1e4still".into()),
    )
    .await;
    assert_eq!(answer, "ok");
    assert_eq!(rx.try_recv().ok(), None, "the session was closed");
}

/// A client that stops answering is still closed: one interval, then the ping timeout.
#[tokio::test]
async fn a_silent_client_is_closed_after_the_interval_and_the_timeout() {
    let (mut svc, mut rx) = server(Duration::from_millis(200));
    let start = Instant::now();
    let _ws = create_ws_connection(&mut svc).await;
    let reason = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await;
    assert_eq!(
        reason.ok().flatten(),
        Some(DisconnectReason::HeartbeatTimeout)
    );
    assert!(start.elapsed() >= INTERVAL + Duration::from_millis(180));
}

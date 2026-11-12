//! Local tests (not upstream's, see `vendor/README.md`): input from the network that is not
//! what the protocol expects, matched against `engine.io` 6.6.9.

use std::{sync::Arc, time::Duration};

use bytes::Bytes;
use engineioxide::{
    Str,
    handler::EngineIoHandler,
    socket::{DisconnectReason, Socket},
};
use futures_util::SinkExt;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

mod fixture;

use fixture::{create_polling_connection, create_server, create_ws_connection, send_req_raw};

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

/// `é1234` is six bytes whose first character is two bytes long: upstream sliced `[1..6]` out of
/// it before checking the packet type and the WebSocket reader task panicked, leaving the session
/// open with nobody reading it. `engine.io` reads an unknown type as a parse error and closes the
/// session (engine.io-parser decodePacket, socket.js 113-115).
#[tokio::test]
async fn a_six_byte_text_that_is_not_a_packet_closes_a_websocket_session() {
    let (disconnect_tx, mut rx) = mpsc::channel(10);
    let mut svc = create_server(EchoHandler { disconnect_tx }).await;
    let mut ws = create_ws_connection(&mut svc).await;
    ws.send(Message::Text("é1234".into())).await.unwrap();

    let reason = tokio::time::timeout(Duration::from_millis(500), rx.recv()).await;
    assert_eq!(
        reason.ok().flatten(),
        Some(DisconnectReason::PacketParsingError)
    );
}

/// The same text in a polling POST: a parse error that closes the session, not a panic in the
/// request (engine.io-parser decodePayload stops at the error packet).
#[tokio::test]
async fn a_six_byte_text_that_is_not_a_packet_closes_a_polling_session() {
    let (disconnect_tx, mut rx) = mpsc::channel(10);
    let mut svc = create_server(EchoHandler { disconnect_tx }).await;
    let sid = create_polling_connection(&mut svc).await;
    let post = tokio::spawn(send_req_raw(
        &mut svc,
        format!("transport=polling&sid={sid}"),
        http::Method::POST,
        Some("é1234".into()),
    ));
    let answered = tokio::time::timeout(Duration::from_millis(500), post).await;
    assert!(
        matches!(answered, Ok(Ok(_))),
        "the POST was not answered: {answered:?}"
    );
    let reason = tokio::time::timeout(Duration::from_millis(500), rx.recv()).await;
    assert_eq!(
        reason.ok().flatten(),
        Some(DisconnectReason::PacketParsingError)
    );
}

/// Records the messages it is handed, and disconnections.
#[derive(Debug, Clone)]
struct Recorder {
    message_tx: mpsc::UnboundedSender<String>,
    disconnect_tx: mpsc::Sender<DisconnectReason>,
}

impl EngineIoHandler for Recorder {
    type Data = ();

    fn on_connect(self: Arc<Self>, _socket: Arc<Socket<()>>) {}
    fn on_disconnect(&self, _socket: Arc<Socket<()>>, reason: DisconnectReason) {
        self.disconnect_tx.try_send(reason).ok();
    }
    fn on_message(self: &Arc<Self>, msg: Str, _socket: Arc<Socket<()>>) {
        self.message_tx.send(msg.to_string()).ok();
    }
    fn on_binary(self: &Arc<Self>, _data: Bytes, _socket: Arc<Socket<()>>) {}
}

struct Recording {
    svc: engineioxide::service::EngineIoService<Recorder>,
    messages: mpsc::UnboundedReceiver<String>,
    disconnects: mpsc::Receiver<DisconnectReason>,
}

fn recording(config: engineioxide::config::EngineIoConfig) -> Recording {
    let (message_tx, messages) = mpsc::unbounded_channel();
    let (disconnect_tx, disconnects) = mpsc::channel(4);
    let svc = engineioxide::service::EngineIoService::with_config(
        Arc::new(Recorder {
            message_tx,
            disconnect_tx,
        }),
        config,
    );
    Recording {
        svc,
        messages,
        disconnects,
    }
}

fn quiet_config(max_payload: u64) -> engineioxide::config::EngineIoConfig {
    engineioxide::config::EngineIoConfig::builder()
        .ping_interval(Duration::from_secs(60))
        .ping_timeout(Duration::from_secs(60))
        .max_payload(max_payload)
        .build()
}

type Chunk = Result<http_body::Frame<Bytes>, std::io::Error>;

/// A POST whose body arrives through `chunks`; resolves to the answer's status and body.
fn streamed_post(
    svc: &mut engineioxide::service::EngineIoService<Recorder>,
    sid: &str,
    chunks: mpsc::Receiver<Chunk>,
) -> tokio::task::JoinHandle<(u16, String)> {
    use http_body_util::BodyExt;
    use tower_service::Service;
    let body = http_body_util::StreamBody::new(tokio_stream::wrappers::ReceiverStream::new(chunks));
    let req = http::Request::builder()
        .method(http::Method::POST)
        .uri(format!(
            "http://127.0.0.1/engine.io/?EIO=4&transport=polling&sid={sid}"
        ))
        .body(body)
        .unwrap();
    let res = svc.call(req);
    tokio::spawn(async move {
        let res = res.await.unwrap();
        let status = res.status().as_u16();
        let body = res.into_body().collect().await.unwrap().to_bytes();
        (status, String::from_utf8_lossy(&body).into_owned())
    })
}

fn data(text: &str) -> Chunk {
    Ok(http_body::Frame::data(Bytes::copy_from_slice(
        text.as_bytes(),
    )))
}

async fn polling_session(svc: &mut engineioxide::service::EngineIoService<Recorder>) -> String {
    #[derive(serde::Deserialize)]
    struct Open {
        sid: String,
    }
    let open = send_req_raw(svc, "transport=polling".into(), http::Method::GET, None).await;
    serde_json::from_str::<Open>(open.trim_start_matches('0'))
        .unwrap()
        .sid
}

/// `engine.io` polling.js 106-133: the body is buffered and its packets are handled on `end`,
/// so a packet at the front of a body that is still arriving is not acted on.
#[tokio::test]
async fn a_post_is_handled_only_once_it_has_fully_arrived() {
    let mut rec = recording(quiet_config(1_000_000));
    let sid = polling_session(&mut rec.svc).await;
    let (tx, rx) = mpsc::channel(4);
    let post = streamed_post(&mut rec.svc, &sid, rx);
    tx.send(data("4first\x1e")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        rec.messages.try_recv().ok(),
        None,
        "a packet was handled before the body ended"
    );
    tx.send(data("4second")).await.unwrap();
    drop(tx);
    assert_eq!(post.await.unwrap(), (200, "ok".into()));
    assert_eq!(rec.messages.recv().await.as_deref(), Some("first"));
    assert_eq!(rec.messages.recv().await.as_deref(), Some("second"));
}

/// `engine.io` polling.js 113-117: a body over `maxHttpBufferSize` is answered 413 while it
/// arrives; none of its packets is handled and the session stays.
#[tokio::test]
async fn an_oversized_post_handles_none_of_its_packets_and_keeps_the_session() {
    let mut rec = recording(quiet_config(1_000));
    let sid = polling_session(&mut rec.svc).await;
    let (tx, rx) = mpsc::channel(4);
    let post = streamed_post(&mut rec.svc, &sid, rx);
    tx.send(data("4first\x1e")).await.unwrap();
    tx.send(data(&"x".repeat(1_000))).await.ok();
    let answer = tokio::time::timeout(Duration::from_secs(1), post).await;
    assert_eq!(answer.unwrap().unwrap().0, 413);
    drop(tx);
    assert_eq!(rec.messages.try_recv().ok(), None, "a packet was handled");

    let after = send_req_raw(
        &mut rec.svc,
        format!("transport=polling&sid={sid}"),
        http::Method::POST,
        Some("4after".into()),
    )
    .await;
    assert_eq!(after, "ok");
    assert_eq!(rec.messages.recv().await.as_deref(), Some("after"));
    assert_eq!(
        rec.disconnects.try_recv().ok(),
        None,
        "the session was closed"
    );
}

/// A body that stops arriving is given up (here when the heartbeat ends the session; at the
/// latest after a ping interval and a ping timeout), and its packets are not handled.
#[tokio::test]
async fn a_stalled_post_is_given_up_without_handling_its_packets() {
    let config = engineioxide::config::EngineIoConfig::builder()
        .ping_interval(Duration::from_millis(100))
        .ping_timeout(Duration::from_millis(100))
        .build();
    let mut rec = recording(config);
    let sid = polling_session(&mut rec.svc).await;
    let (tx, rx) = mpsc::channel(4);
    let post = streamed_post(&mut rec.svc, &sid, rx);
    tx.send(data("4first\x1e")).await.unwrap();
    let answer = tokio::time::timeout(Duration::from_secs(2), post).await;
    assert!(answer.is_ok(), "the stalled POST was never answered");
    assert_eq!(rec.messages.try_recv().ok(), None, "a packet was handled");
    assert!(rec.disconnects.recv().await.is_some());
    drop(tx);
}

/// `engine.io` polling.js 107-110: the request breaking off mid-body is a transport error.
#[tokio::test]
async fn a_post_that_breaks_off_closes_the_session_without_handling_its_packets() {
    let mut rec = recording(quiet_config(1_000_000));
    let sid = polling_session(&mut rec.svc).await;
    let (tx, rx) = mpsc::channel(4);
    let post = streamed_post(&mut rec.svc, &sid, rx);
    tx.send(data("4first\x1e")).await.unwrap();
    tx.send(Err(std::io::Error::other("reset"))).await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), post)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(rec.messages.try_recv().ok(), None, "a packet was handled");
    let reason = tokio::time::timeout(Duration::from_secs(1), rec.disconnects.recv()).await;
    assert_eq!(
        reason.ok().flatten(),
        Some(DisconnectReason::TransportError)
    );
}

/// engine.io-parser decodePayload handles the packets before a malformed one and stops there;
/// polling.js 120-131 answers `ok` once the payload is handled, even though it ended the session.
#[tokio::test]
async fn a_malformed_packet_in_a_post_ends_the_session_after_the_packets_before_it() {
    let mut rec = recording(quiet_config(1_000_000));
    let sid = polling_session(&mut rec.svc).await;
    let answer = send_req_raw(
        &mut rec.svc,
        format!("transport=polling&sid={sid}"),
        http::Method::POST,
        Some("4before\x1eé1234\x1e4after".into()),
    )
    .await;
    assert_eq!(answer, "ok");
    assert_eq!(rec.messages.recv().await.as_deref(), Some("before"));
    let reason = tokio::time::timeout(Duration::from_secs(1), rec.disconnects.recv()).await;
    assert_eq!(
        reason.ok().flatten(),
        Some(DisconnectReason::PacketParsingError)
    );
    assert_eq!(
        rec.messages.try_recv().ok(),
        None,
        "a packet after the error was handled"
    );
}

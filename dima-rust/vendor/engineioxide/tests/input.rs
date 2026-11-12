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

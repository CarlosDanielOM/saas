//! Local tests (not upstream's, see `vendor/README.md`): the two hooks `dima-socketio` needs,
//! [`Socket::tasks_ended`] and [`Socket::messages_done`].

use std::{sync::Arc, time::Duration};

use bytes::Bytes;
use engineioxide::{
    Str,
    config::EngineIoConfig,
    handler::EngineIoHandler,
    service::EngineIoService,
    socket::{DisconnectReason, Socket},
};
use futures_util::StreamExt;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

mod fixture;

use fixture::{create_polling_connection, create_ws_connection, send_req_raw};

/// Hands every socket to the test and reports disconnections.
#[derive(Debug, Clone)]
struct Capture {
    socket_tx: mpsc::Sender<Arc<Socket<()>>>,
    disconnect_tx: mpsc::Sender<DisconnectReason>,
}

impl EngineIoHandler for Capture {
    type Data = ();

    fn on_connect(self: Arc<Self>, socket: Arc<Socket<()>>) {
        self.socket_tx.try_send(socket).ok();
    }
    fn on_disconnect(&self, _socket: Arc<Socket<()>>, reason: DisconnectReason) {
        self.disconnect_tx.try_send(reason).ok();
    }
    fn on_message(self: &Arc<Self>, _msg: Str, _socket: Arc<Socket<()>>) {}
    fn on_binary(self: &Arc<Self>, _data: Bytes, _socket: Arc<Socket<()>>) {}
}

struct Server {
    svc: EngineIoService<Capture>,
    sockets: mpsc::Receiver<Arc<Socket<()>>>,
    disconnects: mpsc::Receiver<DisconnectReason>,
}

fn server(max_payload: u64) -> Server {
    let (socket_tx, sockets) = mpsc::channel(4);
    let (disconnect_tx, disconnects) = mpsc::channel(4);
    let config = EngineIoConfig::builder()
        .ping_interval(Duration::from_secs(60))
        .ping_timeout(Duration::from_secs(60))
        .max_payload(max_payload)
        .build();
    let svc = EngineIoService::with_config(
        Arc::new(Capture {
            socket_tx,
            disconnect_tx,
        }),
        config,
    );
    Server {
        svc,
        sockets,
        disconnects,
    }
}

async fn poll(svc: &mut EngineIoService<Capture>, sid: &str) -> String {
    send_req_raw(
        svc,
        format!("transport=polling&sid={sid}"),
        http::Method::GET,
        None,
    )
    .await
}

/// Waits until `messages_done` reaches `count` (at most a second).
async fn done(socket: &Socket<()>, count: u64) -> bool {
    let mut done = socket.watch_messages_done();
    tokio::time::timeout(Duration::from_secs(1), done.wait_for(|n| *n >= count))
        .await
        .is_ok()
}

#[tokio::test]
async fn the_tasks_of_a_polling_session_end_once_it_is_closed() {
    let mut s = server(1_000_000);
    create_polling_connection(&mut s.svc).await;
    let socket = s.sockets.recv().await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), socket.tasks_ended())
            .await
            .is_err(),
        "the tasks ended while the session was open"
    );
    socket.close(DisconnectReason::ClosingServer);
    tokio::time::timeout(Duration::from_secs(1), socket.tasks_ended())
        .await
        .expect("the tasks ended");
    assert!(s.disconnects.try_recv().is_ok(), "on_disconnect ran first");
}

#[tokio::test]
async fn the_tasks_of_a_websocket_session_end_once_it_is_closed() {
    let mut s = server(1_000_000);
    let mut ws = create_ws_connection(&mut s.svc).await;
    let socket = s.sockets.recv().await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), socket.tasks_ended())
            .await
            .is_err(),
        "the tasks ended while the session was open"
    );
    socket.close(DisconnectReason::ClosingServer);
    tokio::time::timeout(Duration::from_secs(1), socket.tasks_ended())
        .await
        .expect("the tasks ended");
    while let Some(Ok(frame)) = ws.next().await {
        if matches!(frame, Message::Close(_)) {
            break;
        }
    }
}

/// A polling payload's messages are done once its response is gone; a message held back for
/// the next poll (over `max_payload`) is not done yet; the transport's own packets and volatile
/// messages do not count.
#[tokio::test]
async fn polled_messages_are_done_once_their_payload_is_gone() {
    let mut s = server(10);
    let sid = create_polling_connection(&mut s.svc).await;
    let socket = s.sockets.recv().await.unwrap();
    assert_eq!(socket.messages_done(), 0);
    socket.emit("hello").unwrap();
    socket.emit("world").unwrap();
    assert!(socket.emit_volatile("vol"));
    assert_eq!(socket.messages_done(), 0);

    assert_eq!(poll(&mut s.svc, &sid).await, "4hello");
    assert_eq!(socket.messages_done(), 1);
    assert_eq!(poll(&mut s.svc, &sid).await, "4world");
    assert_eq!(socket.messages_done(), 2);
    assert_eq!(poll(&mut s.svc, &sid).await, "4vol");
    assert_eq!(socket.messages_done(), 2, "a volatile message was counted");
}

#[tokio::test]
async fn websocket_messages_are_done_once_written() {
    let mut s = server(1_000_000);
    let mut ws = create_ws_connection(&mut s.svc).await;
    let socket = s.sockets.recv().await.unwrap();
    socket.emit("one").unwrap();
    socket
        .reserve()
        .unwrap()
        .emit_many("two".into(), [Bytes::from_static(b"2")].into());
    assert!(done(&socket, 2).await, "{}", socket.messages_done());
    let mut texts = Vec::new();
    while texts.len() < 3 {
        match ws.next().await.unwrap().unwrap() {
            Message::Text(text) => texts.push(text.as_str().to_owned()),
            Message::Binary(_) => texts.push("binary".into()),
            _ => {}
        }
    }
    assert!(texts[0].starts_with('0'), "{texts:?}");
    assert_eq!(texts[1..], ["4one", "4two"], "{texts:?}");
    assert_eq!(socket.messages_done(), 2);
}

/// Messages still queued when the session closes are done (dropped), the close packet does not
/// count.
#[tokio::test]
async fn messages_left_when_a_session_closes_are_done() {
    let mut s = server(1_000_000);
    create_polling_connection(&mut s.svc).await;
    let socket = s.sockets.recv().await.unwrap();
    for text in ["a", "b", "c"] {
        socket.emit(text).unwrap();
    }
    socket.close(DisconnectReason::ClosingServer);
    tokio::time::timeout(Duration::from_secs(1), socket.tasks_ended())
        .await
        .expect("the tasks ended");
    assert_eq!(socket.messages_done(), 3);
}

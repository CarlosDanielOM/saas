//! Shared by the integration tests: a server with the test namespaces of
//! `tests/js/reference-server.mjs` (declared the same way, handler for handler), mounted in front
//! of a small `dima_web::App`, and the helpers that find Node and the pinned clients.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

pub mod raw;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use dima_core::Shutdown;
use dima_socketio::{
    AckError, ConnectError, Event, Handshake, Namespace, NamespaceOptions, NamespaceRef, Options,
    Recovery, Runtime, Socket, SocketIo,
};
use dima_web::{App, Body, Error, Req, Response, Router, ServeOptions};
use futures_util::{SinkExt as _, StreamExt as _};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

/// The directory of the JavaScript side.
pub fn js_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/js")
}

/// Node and the pinned clients, or why the test cannot run. With `DIMA_TEST_REQUIRE_STORES=1`
/// (exported by `tools/test-env`) a missing piece fails the test instead of skipping it.
pub fn node() -> Option<PathBuf> {
    let installed = js_dir()
        .join("node_modules/client-4.8.3/package.json")
        .exists()
        && js_dir()
            .join("node_modules/client-4.7.5/package.json")
            .exists();
    let node = std::process::Command::new("node")
        .arg("--version")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|_| PathBuf::from("node"));
    match (node, installed) {
        (Some(node), true) => Some(node),
        (node, _) => {
            let what = if node.is_none() {
                "node is not installed"
            } else {
                "the JavaScript clients are not installed"
            };
            let help = format!(
                "{what}; install them with: (cd {} && npm ci --ignore-scripts)",
                js_dir().display()
            );
            if std::env::var("DIMA_TEST_REQUIRE_STORES").as_deref() == Ok("1") {
                panic!("{help}");
            }
            eprintln!("skipped: {help}");
            None
        }
    }
}

// ----- the app ------------------------------------------------------------------------------

async fn hello(_req: &mut Req) -> Response {
    Response::new().text("hello from the app")
}

/// GET /raw-ws: the app's own WebSocket endpoint next to `/socket.io/`.
async fn raw_ws(req: &mut Req) -> Result<Response, Error> {
    let key = req.header("sec-websocket-key").map(|key| key.to_string());
    let (Some(upgrade), Some(guard), Some(key)) =
        (req.take_upgrade(), req.take_upgrade_guard(), key)
    else {
        return Ok(Response::send_status(426));
    };
    tokio::spawn(async move {
        let _guard = guard;
        let Ok(upgraded) = upgrade.await else { return };
        let io = hyper_util::rt::TokioIo::new(upgraded);
        let mut ws = tokio_tungstenite::WebSocketStream::from_raw_socket(
            io,
            tokio_tungstenite::tungstenite::protocol::Role::Server,
            None,
        )
        .await;
        while let Some(Ok(message)) = ws.next().await {
            if let Message::Text(text) = message
                && ws.send(Message::text(format!("app:{text}"))).await.is_err()
            {
                return;
            }
        }
    });
    let accept = tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes());
    let response = http::Response::builder()
        .status(101)
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Accept", accept)
        .body(Body::empty())?;
    Ok(Response::from_http(response))
}

pub fn app() -> App {
    let mut router = Router::new();
    router.get("/hello", hello);
    router.get("/raw-ws", raw_ws);
    App::new(router, ()).expect("app")
}

// ----- the namespaces -----------------------------------------------------------------------

type Tags = Arc<Mutex<HashMap<String, Socket<()>>>>;
type Slot<N> = Arc<OnceLock<NamespaceRef<N>>>;

fn str_of(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn welcome(socket: &Socket<()>) {
    let handshake = socket.handshake();
    let _ = socket.emit(
        "welcome",
        &[json!({
            "recovered": socket.recovered(),
            "nsp": socket.namespace(),
            "x": handshake.query().get("x"),
            "token": handshake.auth().get("token").cloned().unwrap_or(Value::Null),
            "tag": handshake.auth().get("tag").cloned().unwrap_or(Value::Null),
        })],
    );
}

fn texts() -> Value {
    let mut value = json!({
        "emoji": "😀👍🏽",
        "combining": "e\u{301}",
        "rtl": "שלום עולם",
        "zwj": "👨‍👩‍👧",
        "separators": "a\u{2028}b\u{2029}c",
        "keys": { "b": 1, "2": 2, "a": 3, "1": 4 },
        "numbers": [1e21, -0.0, 0.1 + 0.2, 9_007_199_254_740_993_u64, 1.5e-7, 123_456_789_012_u64],
    });
    // A JavaScript object lists integer keys first: build the value as `JSON.stringify` sees it.
    dima_text::js_key_order(&mut value);
    value
}

/// The event handlers every test namespace shares (`events(socket)` in the reference script).
async fn events<N: Namespace<Data = ()>>(me: &Slot<N>, socket: Socket<()>, mut event: Event) {
    let ack = event.take_ack();
    let args = std::mem::take(&mut event.args);
    let first = args.first().cloned().unwrap_or(Value::Null);
    match event.name.as_str() {
        "echo" => match ack {
            Some(ack) => {
                let _ = ack.send(&args);
            }
            None => {
                let _ = socket.emit("echo", &args);
            }
        },
        "1" => {
            let _ = socket.emit("one", &args);
        }
        "ack-multi" => {
            if let Some(ack) = ack {
                let _ = ack.send(&[json!(1), json!("two"), json!({"three": [3]}), Value::Null]);
            }
        }
        "ack-empty" => {
            if let Some(ack) = ack {
                let _ = ack.send(&[]);
            }
        }
        "ack-twice" => {
            if let Some(ack) = ack {
                // A second call is impossible: sending consumes the acknowledgement.
                let _ = ack.send(&[json!("first")]);
            }
        }
        "ask" => {
            let answer = match socket
                .emit_with_ack("question", &[first], Duration::from_secs(2))
                .await
            {
                Ok(reply) => match reply.into_iter().next() {
                    Some(reply) => json!({"ok": true, "reply": reply}),
                    None => json!({"ok": true}),
                },
                Err(error) => json!({"ok": false, "error": error.to_string()}),
            };
            let _ = socket.emit("answer", &[answer]);
        }
        "ask-silent" => {
            let answer = match socket
                .emit_with_ack("question-silent", &[], Duration::from_millis(300))
                .await
            {
                Ok(_) => json!({"ok": true}),
                Err(error) => json!({"ok": false, "error": error.to_string()}),
            };
            let _ = socket.emit("answer", &[answer]);
        }
        "bye" => socket.disconnect(),
        "bye-all" => socket.disconnect_connection(),
        "broadcast" => {
            if let Some(me) = me.get() {
                let _ = me.emit(socket.namespace(), "broadcast", &[first]);
            }
        }
        "burst" => {
            let count = first.as_u64().unwrap_or(0);
            for i in 0..count {
                let _ = socket.emit("seq", &[json!(i)]);
            }
        }
        "texts" => {
            let _ = socket.emit("texts", &[texts()]);
        }
        "count" => {
            if let (Some(ack), Some(me)) = (ack, me.get()) {
                let _ = ack.send(&[json!(me.sockets(socket.namespace()).len())]);
            }
        }
        _ => {}
    }
}

/// `/basic`: full recovery, a check with every refusal shape.
pub struct Basic {
    me: Slot<Basic>,
    tags: Tags,
}

impl Namespace for Basic {
    type Data = ();

    async fn check(&self, handshake: &Handshake, _namespace: &str) -> Result<(), ConnectError> {
        match str_of(handshake.auth().get("token")) {
            Some("bad") => {
                Err(ConnectError::new("Invalid token")
                    .with_data(json!({"code": "bad_token", "n": 1})))
            }
            Some("plain") => Err(ConnectError::new("Plain refusal")),
            Some("slow") => {
                tokio::time::sleep(Duration::from_millis(200)).await;
                Ok(())
            }
            _ => Ok(()),
        }
    }

    async fn on_connect(&self, socket: Socket<()>) {
        if let Some(tag) = str_of(socket.handshake().auth().get("tag")) {
            self.tags
                .lock()
                .unwrap()
                .insert(tag.to_owned(), socket.clone());
        }
        welcome(&socket);
    }

    async fn on_event(&self, socket: Socket<()>, event: Event) {
        events(&self.me, socket, event).await;
    }
}

/// `/norec`, and the offsets-only family: welcome and the shared events.
pub struct Plain<const ID: u8> {
    me: Slot<Plain<ID>>,
}

impl<const ID: u8> Namespace for Plain<ID> {
    type Data = ();

    async fn check(&self, _handshake: &Handshake, _namespace: &str) -> Result<(), ConnectError> {
        Ok(())
    }

    async fn on_connect(&self, socket: Socket<()>) {
        welcome(&socket);
    }

    async fn on_event(&self, socket: Socket<()>, event: Event) {
        events(&self.me, socket, event).await;
    }
}

/// `/fam/*`: `_deny` names refused, `quiet` ones silent.
pub struct Fam {
    me: Slot<Fam>,
    tags: Tags,
}

impl Namespace for Fam {
    type Data = ();

    async fn check(&self, _handshake: &Handshake, namespace: &str) -> Result<(), ConnectError> {
        if namespace.ends_with("_deny") {
            return Err(ConnectError::new("Denied").with_data(json!({"nsp": namespace})));
        }
        Ok(())
    }

    async fn on_connect(&self, socket: Socket<()>) {
        if let Some(tag) = str_of(socket.handshake().auth().get("tag")) {
            self.tags
                .lock()
                .unwrap()
                .insert(tag.to_owned(), socket.clone());
        }
        if !socket.namespace().contains("quiet") {
            welcome(&socket);
        }
    }

    async fn on_event(&self, socket: Socket<()>, event: Event) {
        events(&self.me, socket, event).await;
    }
}

/// The `/pick/*` and `/digits/*` families: which declaration took the name.
pub struct Which(u8);

impl Namespace for Which {
    type Data = ();

    async fn check(&self, _handshake: &Handshake, _namespace: &str) -> Result<(), ConnectError> {
        Ok(())
    }

    async fn on_connect(&self, socket: Socket<()>) {
        let _ = socket.emit("which", &[json!(self.0)]);
    }
}

/// `/control`: server-side emits while a client is away.
pub struct Control {
    tags: Tags,
    basic: Slot<Basic>,
    fam: Slot<Fam>,
    norec: Slot<Plain<0>>,
    nopersist: Slot<Plain<1>>,
}

impl Control {
    fn nsp_emit(&self, name: &str, payload: Value) {
        let args = [payload];
        if let Some(r) = self.basic.get().filter(|r| r.covers(name)) {
            let _ = r.emit(name, "pushed", &args);
        } else if let Some(r) = self.fam.get().filter(|r| r.covers(name)) {
            let _ = r.emit(name, "pushed", &args);
        } else if let Some(r) = self.norec.get().filter(|r| r.covers(name)) {
            let _ = r.emit(name, "pushed", &args);
        } else if let Some(r) = self.nopersist.get().filter(|r| r.covers(name)) {
            let _ = r.emit(name, "pushed", &args);
        }
    }

    fn count(&self, name: &str) -> usize {
        if let Some(r) = self.basic.get().filter(|r| r.covers(name)) {
            r.sockets(name).len()
        } else if let Some(r) = self.fam.get().filter(|r| r.covers(name)) {
            r.sockets(name).len()
        } else {
            0
        }
    }
}

impl Namespace for Control {
    type Data = ();

    async fn check(&self, _handshake: &Handshake, _namespace: &str) -> Result<(), ConnectError> {
        Ok(())
    }

    async fn on_event(&self, _socket: Socket<()>, mut event: Event) {
        let ack = event.take_ack();
        let args = event.args;
        let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
        let reply = match event.name.as_str() {
            "nsp-emit" => {
                self.nsp_emit(str_of(args.first()).unwrap_or(""), arg(1));
                json!("done")
            }
            "direct-emit" => {
                let target = self
                    .tags
                    .lock()
                    .unwrap()
                    .get(str_of(args.first()).unwrap_or(""))
                    .cloned();
                match target {
                    Some(target) => {
                        let _ = target.emit("direct", &[arg(1)]);
                        json!("done")
                    }
                    None => json!("unknown"),
                }
            }
            "direct-ask" => {
                let target = self
                    .tags
                    .lock()
                    .unwrap()
                    .get(str_of(args.first()).unwrap_or(""))
                    .cloned();
                let Some(target) = target else { return };
                // The reference times out on a disconnected socket; here it fails at once.
                match target
                    .emit_with_ack(
                        "question",
                        &[json!("while-away")],
                        Duration::from_millis(200),
                    )
                    .await
                {
                    Ok(_) => json!("answered"),
                    Err(AckError::Timeout | AckError::Disconnected) => {
                        json!("operation has timed out")
                    }
                    Err(error) => json!(error.to_string()),
                }
            }
            "count" => json!(self.count(str_of(args.first()).unwrap_or(""))),
            _ => return,
        };
        if let Some(ack) = ack {
            let _ = ack.send(&[reply]);
        }
    }
}

/// Declares the test namespaces in the reference script's order.
pub fn declare(builder: &mut dima_socketio::Builder) {
    let tags: Tags = Arc::default();
    let full = NamespaceOptions::default();
    let off = NamespaceOptions {
        recovery: Recovery::Off,
        ..NamespaceOptions::default()
    };
    let offsets = NamespaceOptions {
        recovery: Recovery::OffsetsOnly,
        ..NamespaceOptions::default()
    };

    let basic: Slot<Basic> = Arc::default();
    let r = builder
        .namespace(
            "/basic",
            full,
            Basic {
                me: Arc::clone(&basic),
                tags: Arc::clone(&tags),
            },
        )
        .unwrap();
    let _ = basic.set(r);
    let norec: Slot<Plain<0>> = Arc::default();
    let r = builder
        .namespace(
            "/norec",
            off,
            Plain {
                me: Arc::clone(&norec),
            },
        )
        .unwrap();
    let _ = norec.set(r);
    let fam: Slot<Fam> = Arc::default();
    let r = builder
        .family(
            r"^\/fam\/\w+$",
            full,
            Fam {
                me: Arc::clone(&fam),
                tags: Arc::clone(&tags),
            },
        )
        .unwrap();
    let _ = fam.set(r);
    builder
        .family(r"^\/pick\/[a-f0-9]{4}$", full, Which(1))
        .unwrap();
    builder.family(r"^\/pick\/\w+$", full, Which(2)).unwrap();
    builder
        .family(r"^\/digits\/[0-9]{1,3}$", full, Which(3))
        .unwrap();
    let nopersist: Slot<Plain<1>> = Arc::default();
    let r = builder
        .family(
            r"^\/nopersist\/\w+$",
            offsets,
            Plain {
                me: Arc::clone(&nopersist),
            },
        )
        .unwrap();
    let _ = nopersist.set(r);
    builder
        .namespace(
            "/control",
            off,
            Control {
                tags,
                basic,
                fam,
                norec,
                nopersist,
            },
        )
        .unwrap();
}

// ----- the server ---------------------------------------------------------------------------

/// A running server on 127.0.0.1.
pub struct TestServer {
    pub addr: SocketAddr,
    pub io: SocketIo,
    pub shutdown: Shutdown,
    serve: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl TestServer {
    /// Starts a server with the test namespaces and `options`.
    pub async fn start(options: Options) -> Self {
        Self::start_with(options, Runtime::default(), declare).await
    }

    /// Starts a server with the namespaces `declare` adds.
    pub async fn start_with(
        options: Options,
        runtime: Runtime,
        declare: impl FnOnce(&mut dima_socketio::Builder),
    ) -> Self {
        let shutdown = Shutdown::new();
        let mut builder = SocketIo::builder(options, runtime, shutdown.clone());
        declare(&mut builder);
        let io = builder.build();
        let listener = dima_web::bind_to(SocketAddr::from(([127, 0, 0, 1], 0))).unwrap();
        let addr = listener.local_addr().unwrap();
        let serve = tokio::spawn(dima_web::serve(
            listener,
            io.layer(app()),
            shutdown.cancellation_token(),
            ServeOptions::default(),
        ));
        Self {
            addr,
            io,
            shutdown,
            serve,
        }
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    /// Shuts down and waits for both the server and Socket.IO to finish.
    pub async fn stop(self) {
        self.shutdown.trigger();
        let _ = tokio::time::timeout(Duration::from_secs(15), self.io.closed()).await;
        let _ = tokio::time::timeout(Duration::from_secs(15), self.serve).await;
    }
}

/// The options of the reference script's short-timer server.
pub fn short_options() -> Options {
    Options {
        connect_timeout: Duration::from_secs(1),
        recovery_max_disconnection: Duration::from_millis(1500),
        upgrade_timeout: Duration::from_secs(1),
        ping_interval: Duration::from_millis(400),
        ping_timeout: Duration::from_millis(1500),
        ..Options::default()
    }
}

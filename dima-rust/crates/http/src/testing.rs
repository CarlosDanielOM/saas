//! A loopback recorder server for tests (feature `test-util`).
//!
//! It listens on `127.0.0.1` on a free port, speaks plain HTTP/1.1, records every request
//! exactly as received (method, target, headers in order, body bytes after chunked decoding),
//! and answers from a script: queued [`MockResponse`]s first, then the fallback handler, then
//! `501`. A response can wait before its headers, stream its body in timed chunks (chunked
//! encoding), send Server-Sent Events, stall, or drop the connection before or during the body.
//! Each connection serves one request and closes. It never contacts anything else.
//!
//! ```
//! # #[tokio::main(flavor = "current_thread")]
//! # async fn main() {
//! use dima_http::testing::{MockResponse, MockServer};
//! use dima_http::Provider;
//! let server = MockServer::start().await.unwrap();
//! server.push(MockResponse::json(200, r#"{"ok":true}"#));
//! // The real declaration, pointed at the mock through a loopback-only test mode
//! // (`/helix` is kept: requests arrive at `/helix/...`).
//! let twitch = server
//!     .provider(Provider::builder("twitch", "https://api.twitch.tv/helix"))
//!     .unwrap();
//! assert!(twitch.base_url().as_str().starts_with("http://127.0.0.1:"));
//! // Send, then:
//! // let request = server.next_request().await;
//! # }
//! ```

#![allow(clippy::missing_panics_doc)]

use bytes::Bytes;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

/// A request as the server received it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordedRequest {
    /// The method.
    pub method: String,
    /// The request target (path and query, as sent).
    pub target: String,
    /// Headers in the order received, names lowercased.
    pub headers: Vec<(String, String)>,
    /// The body bytes (chunked encoding removed).
    pub body: Vec<u8>,
}

impl RecordedRequest {
    /// The first value of a header (case-insensitive).
    pub fn header(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v.as_str())
    }

    /// Every value of a header.
    pub fn header_all(&self, name: &str) -> Vec<&str> {
        let name = name.to_ascii_lowercase();
        self.headers
            .iter()
            .filter(|(n, _)| *n == name)
            .map(|(_, v)| v.as_str())
            .collect()
    }

    /// The path without the query.
    pub fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or_default()
    }

    /// The query, if any.
    pub fn query(&self) -> Option<&str> {
        self.target.split_once('?').map(|(_, q)| q)
    }

    /// The body as text (lossy).
    pub fn body_text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// How the body of a [`MockResponse`] is sent.
#[derive(Clone, Debug)]
enum MockBody {
    /// With `Content-Length`.
    Full(Bytes),
    /// Chunked, each piece after its delay.
    Chunks(Vec<(Duration, Bytes)>),
}

/// What the connection does.
#[derive(Clone, Debug)]
enum Action {
    Respond,
    /// Close without answering.
    DropBeforeResponse,
    /// Send the head with the full `Content-Length`, then this many body bytes, then close.
    DropAfter(usize),
    /// Send the head and the full body length, then nothing (the connection stays open until
    /// the server is dropped).
    StallAfterHeaders,
}

/// A scripted answer.
#[derive(Clone, Debug)]
pub struct MockResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: MockBody,
    delay: Duration,
    action: Action,
}

impl MockResponse {
    /// A status with an empty body.
    pub fn new(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: MockBody::Full(Bytes::new()),
            delay: Duration::ZERO,
            action: Action::Respond,
        }
    }

    /// A JSON body.
    pub fn json(status: u16, body: &str) -> Self {
        Self::new(status)
            .header("content-type", "application/json")
            .body(body.to_owned())
    }

    /// An event stream: each item is sent as one chunk, after `gap`.
    pub fn sse(chunks: &[&str], gap: Duration) -> Self {
        Self::new(200)
            .header("content-type", "text/event-stream")
            .chunks(
                chunks
                    .iter()
                    .map(|c| (gap, Bytes::from((*c).to_owned())))
                    .collect(),
            )
    }

    /// Adds a header.
    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }

    /// The body, sent with `Content-Length`.
    pub fn body(mut self, body: impl Into<Bytes>) -> Self {
        self.body = MockBody::Full(body.into());
        self
    }

    /// A chunked body; each piece is written after its delay.
    pub fn chunks(mut self, chunks: Vec<(Duration, Bytes)>) -> Self {
        self.body = MockBody::Chunks(chunks);
        self
    }

    /// Waits before sending the head.
    pub fn delay(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }

    /// Closes the connection without answering.
    pub fn drop_connection() -> Self {
        Self {
            action: Action::DropBeforeResponse,
            ..Self::new(500)
        }
    }

    /// Sends the head and `n` bytes of the body, then closes.
    pub fn drop_after(mut self, n: usize) -> Self {
        self.action = Action::DropAfter(n);
        self
    }

    /// Sends the head, then nothing.
    pub fn stall_after_headers(mut self) -> Self {
        self.action = Action::StallAfterHeaders;
        self
    }
}

type Handler = Arc<dyn Fn(&RecordedRequest) -> MockResponse + Send + Sync>;

#[derive(Default)]
struct State {
    script: VecDeque<MockResponse>,
    fallback: Option<Handler>,
    requests: Vec<RecordedRequest>,
}

/// The loopback recorder. Stops when dropped.
pub struct MockServer {
    addr: std::net::SocketAddr,
    state: Arc<Mutex<State>>,
    notify: Arc<Notify>,
    task: JoinHandle<()>,
}

impl std::fmt::Debug for MockServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MockServer")
            .field("addr", &self.addr)
            .finish()
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn lock(state: &Mutex<State>) -> std::sync::MutexGuard<'_, State> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

impl MockServer {
    /// Starts a server on a free loopback port.
    pub async fn start() -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let addr = listener.local_addr()?;
        let state = Arc::new(Mutex::new(State::default()));
        let notify = Arc::new(Notify::new());
        let task = tokio::spawn(accept_loop(
            listener,
            Arc::clone(&state),
            Arc::clone(&notify),
        ));
        Ok(Self {
            addr,
            state,
            notify,
            task,
        })
    }

    /// Builds `provider` pointed at this server: a registry in
    /// [`TestMode::RigMock`](crate::TestMode) (loopback only) overrides its base URL with
    /// [`MockServer::url`] followed by the declared base path. Everything else the declaration
    /// says (headers, secret headers, limits, retries) is kept.
    pub fn provider(
        &self,
        provider: crate::ProviderBuilder,
    ) -> Result<crate::Provider, crate::ConfigError> {
        let name = provider.name();
        let base = format!("{}{}", self.url(), provider.declared_path());
        let registry = crate::ProviderRegistry::builder()
            .test_mode(crate::TestMode::RigMock {
                loopback_only: true,
            })
            .provider(provider)
            .base_url_override(name, &base)
            .build()?;
        registry.get(name).cloned()
    }

    /// `http://127.0.0.1:<port>`.
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// The socket address.
    pub fn addr(&self) -> std::net::SocketAddr {
        self.addr
    }

    /// Queues an answer (answers are used in order).
    pub fn push(&self, response: MockResponse) {
        lock(&self.state).script.push_back(response);
    }

    /// Answers with `handler` once the queue is empty.
    pub fn fallback(
        &self,
        handler: impl Fn(&RecordedRequest) -> MockResponse + Send + Sync + 'static,
    ) {
        lock(&self.state).fallback = Some(Arc::new(handler));
    }

    /// Every request received so far.
    pub fn requests(&self) -> Vec<RecordedRequest> {
        lock(&self.state).requests.clone()
    }

    /// Waits up to 10 s until `n` requests have arrived and returns them all.
    pub async fn wait_for(&self, n: usize) -> Vec<RecordedRequest> {
        let wait = async {
            loop {
                let notified = self.notify.notified();
                {
                    let state = lock(&self.state);
                    if state.requests.len() >= n {
                        return state.requests.clone();
                    }
                }
                notified.await;
            }
        };
        match tokio::time::timeout(Duration::from_secs(10), wait).await {
            Ok(requests) => requests,
            Err(_) => self.requests(),
        }
    }

    /// The first request (waiting for it up to 10 s).
    pub async fn next_request(&self) -> Option<RecordedRequest> {
        self.wait_for(1).await.into_iter().next()
    }
}

async fn accept_loop(listener: TcpListener, state: Arc<Mutex<State>>, notify: Arc<Notify>) {
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            return;
        };
        let state = Arc::clone(&state);
        let notify = Arc::clone(&notify);
        tokio::spawn(async move {
            let _ = serve(stream, state, notify).await;
        });
    }
}

async fn serve(
    stream: TcpStream,
    state: Arc<Mutex<State>>,
    notify: Arc<Notify>,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream);
    let Some(request) = read_request(&mut reader).await? else {
        return Ok(());
    };
    let response = {
        let mut state = lock(&state);
        state.requests.push(request.clone());
        let scripted = state.script.pop_front();
        match (scripted, &state.fallback) {
            (Some(response), _) => response,
            (None, Some(handler)) => handler(&request),
            (None, None) => MockResponse::new(501).body("no scripted response"),
        }
    };
    notify.notify_waiters();
    let mut stream = reader.into_inner();
    if !response.delay.is_zero() {
        tokio::time::sleep(response.delay).await;
    }
    let full = match &response.body {
        MockBody::Full(bytes) => Some(bytes.clone()),
        MockBody::Chunks(_) => None,
    };
    if let Action::DropBeforeResponse = response.action {
        return stream.shutdown().await;
    }
    let mut head = format!("HTTP/1.1 {} Mock\r\n", response.status);
    for (name, value) in &response.headers {
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    match &full {
        Some(bytes) => head.push_str(&format!("content-length: {}\r\n", bytes.len())),
        None => head.push_str("transfer-encoding: chunked\r\n"),
    }
    head.push_str("connection: close\r\n\r\n");
    stream.write_all(head.as_bytes()).await?;
    match (&response.action, &response.body) {
        (Action::StallAfterHeaders, _) => {
            stream.flush().await?;
            std::future::pending::<()>().await;
        }
        (Action::DropAfter(n), MockBody::Full(bytes)) => {
            stream.write_all(bytes.get(..*n).unwrap_or(bytes)).await?;
            stream.flush().await?;
            return Ok(());
        }
        (Action::DropAfter(n), MockBody::Chunks(chunks)) => {
            let mut left = *n;
            for (delay, chunk) in chunks {
                tokio::time::sleep(*delay).await;
                let piece = chunk.get(..left.min(chunk.len())).unwrap_or_default();
                write_chunk(&mut stream, piece).await?;
                left -= piece.len();
                if left == 0 {
                    break;
                }
            }
            stream.flush().await?;
            return Ok(());
        }
        (_, MockBody::Full(bytes)) => stream.write_all(bytes).await?,
        (_, MockBody::Chunks(chunks)) => {
            for (delay, chunk) in chunks {
                tokio::time::sleep(*delay).await;
                write_chunk(&mut stream, chunk).await?;
                stream.flush().await?;
            }
            stream.write_all(b"0\r\n\r\n").await?;
        }
    }
    stream.flush().await?;
    let _ = stream.shutdown().await;
    Ok(())
}

async fn write_chunk(stream: &mut TcpStream, chunk: &[u8]) -> std::io::Result<()> {
    if chunk.is_empty() {
        return Ok(());
    }
    stream
        .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
        .await?;
    stream.write_all(chunk).await?;
    stream.write_all(b"\r\n").await
}

const MAX_HEAD: usize = 64 * 1024;
const MAX_BODY: usize = 64 * 1024 * 1024;

fn invalid(what: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, what.to_owned())
}

async fn read_line(
    reader: &mut BufReader<TcpStream>,
    budget: &mut usize,
) -> std::io::Result<String> {
    let mut line = Vec::new();
    let n = (&mut *reader)
        .take(u64::try_from(*budget).unwrap_or(0))
        .read_until(b'\n', &mut line)
        .await?;
    *budget = budget.saturating_sub(n);
    if !line.ends_with(b"\n") {
        return Err(invalid("truncated line"));
    }
    while line.last().is_some_and(|b| *b == b'\n' || *b == b'\r') {
        line.pop();
    }
    String::from_utf8(line).map_err(|_| invalid("non-utf8 head"))
}

async fn read_request(
    reader: &mut BufReader<TcpStream>,
) -> std::io::Result<Option<RecordedRequest>> {
    let mut budget = MAX_HEAD;
    let start = match read_line(reader, &mut budget).await {
        Ok(line) => line,
        Err(error) if error.kind() == std::io::ErrorKind::InvalidData => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut parts = start.split(' ');
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else {
        return Ok(None);
    };
    let (method, target) = (method.to_owned(), target.to_owned());
    let mut headers = Vec::new();
    loop {
        let line = read_line(reader, &mut budget).await?;
        if line.is_empty() {
            break;
        }
        let (name, value) = line.split_once(':').ok_or_else(|| invalid("header"))?;
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_owned()));
    }
    let header = |name: &str| {
        headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    };
    let mut body = Vec::new();
    if header("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked")) {
        loop {
            let mut line_budget = 1024;
            let size_line = read_line(reader, &mut line_budget).await?;
            let size_text = size_line.split(';').next().unwrap_or("0").trim();
            let size = usize::from_str_radix(size_text, 16).map_err(|_| invalid("chunk size"))?;
            if size == 0 {
                loop {
                    let mut trailer_budget = MAX_HEAD;
                    if read_line(reader, &mut trailer_budget).await?.is_empty() {
                        break;
                    }
                }
                break;
            }
            if body.len() + size > MAX_BODY {
                return Err(invalid("body too large"));
            }
            let start = body.len();
            body.resize(start + size, 0);
            reader
                .read_exact(body.get_mut(start..).unwrap_or_default())
                .await?;
            let mut crlf = [0; 2];
            reader.read_exact(&mut crlf).await?;
        }
    } else if let Some(length) = header("content-length") {
        let length: usize = length.parse().map_err(|_| invalid("content-length"))?;
        if length > MAX_BODY {
            return Err(invalid("body too large"));
        }
        body.resize(length, 0);
        reader.read_exact(&mut body).await?;
    }
    Ok(Some(RecordedRequest {
        method,
        target,
        headers,
        body,
    }))
}

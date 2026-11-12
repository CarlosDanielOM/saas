//! Raw Engine.IO clients for the adversarial tests: they send exactly the bytes a test wants.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::net::SocketAddr;
use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use serde_json::Value;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

/// What the next frame was.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Next {
    /// An Engine.IO text packet (heartbeat pings are answered and skipped).
    Text(String),
    /// The server closed the connection.
    Closed,
    /// Nothing arrived in time.
    Timeout,
}

/// A WebSocket Engine.IO client.
pub struct Ws {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    pub sid: String,
}

impl Ws {
    /// Opens a session; reads the open packet.
    pub async fn open(addr: SocketAddr) -> Self {
        let url = format!("ws://{addr}/socket.io/?EIO=4&transport=websocket");
        let (ws, _) = tokio_tungstenite::connect_async(url)
            .await
            .expect("websocket opens");
        let mut client = Self {
            ws,
            sid: String::new(),
        };
        let Next::Text(open) = client.next(Duration::from_secs(5)).await else {
            panic!("no open packet");
        };
        let open: Value =
            serde_json::from_str(open.strip_prefix('0').expect("open packet")).unwrap();
        client.sid = open["sid"].as_str().unwrap().to_owned();
        client
    }

    /// Sends one raw Engine.IO text packet.
    pub async fn send(&mut self, text: &str) -> bool {
        self.ws.send(Message::text(text)).await.is_ok()
    }

    /// Sends a binary frame.
    pub async fn send_binary(&mut self, data: Vec<u8>) -> bool {
        self.ws.send(Message::binary(data)).await.is_ok()
    }

    /// The next packet, answering heartbeat pings on the way.
    pub async fn next(&mut self, timeout: Duration) -> Next {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let frame = match tokio::time::timeout_at(deadline, self.ws.next()).await {
                Err(_) => return Next::Timeout,
                Ok(None | Some(Err(_))) => return Next::Closed,
                Ok(Some(Ok(frame))) => frame,
            };
            match frame {
                Message::Text(text) if text.as_str() == "2" => {
                    let _ = self.ws.send(Message::text("3")).await;
                }
                Message::Text(text) => return Next::Text(text.as_str().to_owned()),
                Message::Close(_) => return Next::Closed,
                _ => {}
            }
        }
    }

    /// Reads until a packet satisfies `wanted`; `None` on close or timeout.
    pub async fn until(
        &mut self,
        wanted: impl Fn(&str) -> bool,
        timeout: Duration,
    ) -> Option<String> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            match self.next(left).await {
                Next::Text(text) if wanted(&text) => return Some(text),
                Next::Text(_) => {}
                Next::Closed | Next::Timeout => return None,
            }
        }
    }

    /// Whether the server closes the connection within `timeout` (packets before are skipped).
    pub async fn closed_within(&mut self, timeout: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            match self.next(left).await {
                Next::Text(text) if text == "1" => return true,
                Next::Text(_) => {}
                Next::Closed => return true,
                Next::Timeout => return false,
            }
        }
    }

    /// Joins a namespace: `0<nsp>,<auth>`; returns the CONNECT or CONNECT_ERROR data.
    pub async fn join(&mut self, nsp: &str, auth: &Value) -> Result<Value, Value> {
        let packet = if nsp == "/" {
            format!("40{auth}")
        } else {
            format!("40{nsp},{auth}")
        };
        self.send(&packet).await;
        let ok = connect_prefix(nsp, '0');
        let err = connect_prefix(nsp, '4');
        let answer = self
            .until(
                |t| t.starts_with(&ok) || t.starts_with(&err),
                Duration::from_secs(5),
            )
            .await
            .expect("an answer to the CONNECT");
        if let Some(data) = answer.strip_prefix(&ok) {
            Ok(serde_json::from_str(data).unwrap())
        } else {
            Err(serde_json::from_str(answer.strip_prefix(&err).unwrap_or("null")).unwrap())
        }
    }

    /// Closes the WebSocket.
    pub async fn close(mut self) {
        let _ = self.ws.close(None).await;
    }

    /// Drops the TCP connection without a close frame (a network failure).
    pub fn drop_connection(self) {
        drop(self);
    }
}

/// `4<type><nsp>,` (just `4<type>` for `/`).
pub fn connect_prefix(nsp: &str, kind: char) -> String {
    if nsp == "/" {
        format!("4{kind}")
    } else {
        format!("4{kind}{nsp},")
    }
}

/// An EVENT's data array from a packet `42<nsp>,[…]` of namespace `nsp`.
pub fn event(text: &str, nsp: &str) -> Option<Vec<Value>> {
    let rest = text.strip_prefix(&connect_prefix(nsp, '2'))?;
    let rest = rest.trim_start_matches(|c: char| c.is_ascii_digit());
    serde_json::from_str::<Vec<Value>>(rest).ok()
}

/// An answer of a plain HTTP request.
#[derive(Debug)]
pub struct HttpAnswer {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpAnswer {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// One HTTP/1.1 request on its own connection; `None` when the server dropped the connection
/// without an answer or nothing came in time.
pub async fn http(
    addr: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
    timeout: Duration,
) -> Option<HttpAnswer> {
    let attempt = async {
        let mut stream = TcpStream::connect(addr).await.ok()?;
        let mut head = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n");
        // A test may declare a length of its own (an oversized body it does not send).
        if !headers
            .iter()
            .any(|(n, _)| n.eq_ignore_ascii_case("content-length"))
        {
            head.push_str(&format!("Content-Length: {}\r\n", body.len()));
        }
        for (name, value) in headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head.push_str("\r\n");
        stream.write_all(head.as_bytes()).await.ok()?;
        stream.write_all(body).await.ok()?;
        let mut raw = Vec::new();
        let _ = stream.read_to_end(&mut raw).await;
        parse(&raw)
    };
    tokio::time::timeout(timeout, attempt).await.ok().flatten()
}

fn parse(raw: &[u8]) -> Option<HttpAnswer> {
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(raw.get(..end)?).into_owned();
    let mut lines = head.split("\r\n");
    let status = lines.next()?.split(' ').nth(1)?.parse().ok()?;
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(n, v)| (n.trim().to_owned(), v.trim().to_owned()))
        .collect();
    let mut body = raw.get(end + 4..)?.to_vec();
    let chunked = headers
        .iter()
        .any(|(n, v)| n.eq_ignore_ascii_case("transfer-encoding") && v.contains("chunked"));
    if chunked {
        let mut decoded = Vec::new();
        let mut rest = body.as_slice();
        loop {
            let line_end = rest.windows(2).position(|w| w == b"\r\n")?;
            let size =
                usize::from_str_radix(std::str::from_utf8(rest.get(..line_end)?).ok()?.trim(), 16)
                    .ok()?;
            rest = rest.get(line_end + 2..)?;
            if size == 0 {
                break;
            }
            decoded.extend_from_slice(rest.get(..size)?);
            rest = rest.get(size + 2..)?;
        }
        body = decoded;
    }
    Some(HttpAnswer {
        status,
        headers,
        body,
    })
}

/// A polling Engine.IO client.
pub struct Polling {
    addr: SocketAddr,
    pub sid: String,
}

impl Polling {
    pub async fn open(addr: SocketAddr) -> Self {
        let answer = http(
            addr,
            "GET",
            "/socket.io/?EIO=4&transport=polling",
            &[],
            b"",
            Duration::from_secs(5),
        )
        .await
        .expect("handshake");
        assert_eq!(answer.status, 200, "{}", answer.text());
        let open: Value =
            serde_json::from_str(answer.text().strip_prefix('0').expect("open")).unwrap();
        Self {
            addr,
            sid: open["sid"].as_str().unwrap().to_owned(),
        }
    }

    fn path(&self) -> String {
        format!("/socket.io/?EIO=4&transport=polling&sid={}", self.sid)
    }

    /// POSTs packets joined with the record separator; the status.
    pub async fn post(&self, packets: &[&str]) -> Option<u16> {
        let body = packets.join("\u{1e}");
        http(
            self.addr,
            "POST",
            &self.path(),
            &[("Content-Type", "text/plain;charset=UTF-8")],
            body.as_bytes(),
            Duration::from_secs(5),
        )
        .await
        .map(|answer| answer.status)
    }

    /// One poll: the packets, or the answer's status when it is not 200.
    pub async fn poll(&self, timeout: Duration) -> Result<Vec<String>, Option<u16>> {
        match http(self.addr, "GET", &self.path(), &[], b"", timeout).await {
            Some(answer) if answer.status == 200 => {
                Ok(answer.text().split('\u{1e}').map(str::to_owned).collect())
            }
            Some(answer) => Err(Some(answer.status)),
            None => Err(None),
        }
    }
}

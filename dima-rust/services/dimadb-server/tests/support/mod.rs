//! Test support: start the Rust binary or the Node reference on a data directory, and speak
//! raw HTTP/1.1 to them (so malformed requests can be sent as they are).
#![allow(dead_code, reason = "each test file uses part of the support module")]

use std::io::{Read as _, Write as _};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// The repository root (`dima-rust/services/dimadb-server/../../..`).
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// A fresh, empty directory under the system temp directory.
pub fn scratch(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let dir =
        std::env::temp_dir().join(format!("dimadb-test-{name}-{}-{nanos}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// A loopback port nobody listens on right now.
pub fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(0)
}

/// Why the Node reference cannot run here, if it cannot.
pub fn node_unavailable() -> Option<String> {
    let version = Command::new("node").arg("--version").output();
    if !version.is_ok_and(|o| o.status.success()) {
        return Some("node is not installed".to_owned());
    }
    let modules = repo_root().join("dimadb/server/node_modules/mongoose");
    if !modules.exists() {
        return Some(format!(
            "{} is missing (npm ci --prefix dimadb/server)",
            modules.display()
        ));
    }
    None
}

/// A running server process, killed when dropped.
pub struct Server {
    pub port: u16,
    child: Child,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Server {
    /// Sends SIGTERM and waits for the exit status.
    pub fn terminate(mut self) -> Option<std::process::ExitStatus> {
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(self.child.id().to_string())
            .status();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Ok(Some(status)) = self.child.try_wait() {
                return Some(status);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        None
    }
}

fn wait_ready(port: u16, child: &mut Child) -> bool {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return false;
        }
        if request(port, "GET", "/api/health", &[], None).is_some_and(|r| r.status == 200) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

fn base_command(
    mut command: Command,
    data: &Path,
    public: &Path,
    port: u16,
    extra: &[(&str, &str)],
) -> Command {
    command
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("PORT", port.to_string())
        .env("DATA_DIR", data)
        .env("PUBLIC_DIR", public)
        .env("TZ", "UTC")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (name, value) in extra {
        command.env(name, value);
    }
    command
}

/// Starts the Rust binary and waits until `/api/health` answers.
pub fn start_rust(data: &Path, public: &Path, extra: &[(&str, &str)]) -> Option<Server> {
    let port = free_port();
    let command = base_command(
        Command::new(env!("CARGO_BIN_EXE_dimadb-server")),
        data,
        public,
        port,
        extra,
    );
    start(command, port)
}

/// Starts `node server/index.mjs` and waits until `/api/health` answers.
pub fn start_node(data: &Path, public: &Path, extra: &[(&str, &str)]) -> Option<Server> {
    let port = free_port();
    let mut command = Command::new("node");
    command
        .arg("server/index.mjs")
        .current_dir(repo_root().join("dimadb"));
    start(base_command(command, data, public, port, extra), port)
}

fn start(mut command: Command, port: u16) -> Option<Server> {
    let mut child = command.spawn().ok()?;
    if !wait_ready(port, &mut child) {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    }
    Some(Server { port, child })
}

/// A response.
#[derive(Debug)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
    }

    /// The `name=value` part of the Set-Cookie header.
    pub fn cookie(&self) -> String {
        self.header("set-cookie")
            .and_then(|c| c.split(';').next())
            .unwrap_or_default()
            .to_owned()
    }
}

/// One request with `Connection: close`; `headers` are raw `Name: value` lines (a `Host`
/// line replaces the default one).
pub fn request(
    port: u16,
    method: &str,
    target: &str,
    headers: &[&str],
    body: Option<&[u8]>,
) -> Option<Reply> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .ok()?;
    let mut head = format!("{method} {target} HTTP/1.1\r\nConnection: close\r\n");
    if !headers
        .iter()
        .any(|h| h.to_ascii_lowercase().starts_with("host:"))
    {
        head.push_str("Host: 127.0.0.1\r\n");
    }
    for header in headers {
        head.push_str(header);
        head.push_str("\r\n");
    }
    if let Some(body) = body {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).ok()?;
    if let Some(body) = body {
        stream.write_all(body).ok()?;
    }
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw);
    parse(&raw)
}

/// A JSON API call with the CSRF header and an optional cookie.
pub fn api(
    port: u16,
    method: &str,
    path: &str,
    cookie: Option<&str>,
    body: Option<serde_json::Value>,
) -> Option<Reply> {
    let cookie_line = cookie.map(|c| format!("Cookie: {c}"));
    let mut headers = vec!["X-Dimadb: 1", "Content-Type: application/json"];
    if let Some(line) = &cookie_line {
        headers.push(line);
    }
    let text = body.map(|b| b.to_string());
    request(
        port,
        method,
        path,
        &headers,
        text.as_deref().map(str::as_bytes),
    )
}

fn parse(raw: &[u8]) -> Option<Reply> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(raw.get(..split)?).into_owned();
    let mut rest = raw.get(split + 4..)?.to_vec();
    let mut lines = head.split("\r\n");
    let status = lines.next()?.split(' ').nth(1)?.parse().ok()?;
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(n, v)| (n.trim().to_owned(), v.trim().to_owned()))
        .collect();
    let chunked = headers
        .iter()
        .any(|(n, v)| n.eq_ignore_ascii_case("transfer-encoding") && v.contains("chunked"));
    if chunked {
        let mut body = Vec::new();
        loop {
            let end = rest.windows(2).position(|w| w == b"\r\n")?;
            let size =
                usize::from_str_radix(String::from_utf8_lossy(rest.get(..end)?).trim(), 16).ok()?;
            if size == 0 {
                break;
            }
            body.extend_from_slice(rest.get(end + 2..end + 2 + size)?);
            rest = rest.get(end + 4 + size..)?.to_vec();
        }
        rest = body;
    }
    Some(Reply {
        status,
        headers,
        body: rest,
    })
}

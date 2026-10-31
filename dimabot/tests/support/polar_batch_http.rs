//! Loopback HTTP peer for Polar batch tests. It records one request at a time
//! on `127.0.0.1` and never contacts a real provider.

use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

#[derive(Debug, Clone)]
pub struct RecordedRequest {
    pub method: String,
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

impl RecordedRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }

    pub fn body_str(&self) -> &str {
        std::str::from_utf8(&self.body).expect("loopback body is UTF-8")
    }
}

struct Shared {
    requests: Mutex<Vec<RecordedRequest>>,
    notify: Mutex<mpsc::Sender<()>>,
    hold: bool,
    hold_body: bool,
    released: Mutex<bool>,
    release: Condvar,
    headers_sent: Mutex<bool>,
    headers_ready: Condvar,
    stopped: AtomicBool,
    status: u16,
    content_type: Option<String>,
    body: Vec<u8>,
    sockets: Mutex<Vec<TcpStream>>,
}

pub struct PolarHttp {
    pub base_url: String,
    address: String,
    shared: Arc<Shared>,
    incoming: Mutex<mpsc::Receiver<()>>,
    thread: Option<thread::JoinHandle<()>>,
}

impl PolarHttp {
    /// Answers immediately with an ingest count.
    pub fn inserted(inserted: u64, duplicates: u64) -> Self {
        Self::start(
            false,
            false,
            200,
            Some("application/json".into()),
            format!(r#"{{"inserted":{inserted},"duplicates":{duplicates}}}"#),
        )
    }

    pub fn respond(status: u16, body: &str) -> Self {
        Self::start(
            false,
            false,
            status,
            Some("application/json".into()),
            body.to_owned(),
        )
    }

    pub fn respond_with_type(status: u16, body: &str, content_type: Option<&str>) -> Self {
        Self::start(
            false,
            false,
            status,
            content_type.map(str::to_owned),
            body.to_owned(),
        )
    }

    /// Reads the request, then waits until [`Self::release`] before responding.
    pub fn hold(status: u16, body: &str) -> Self {
        Self::start(
            true,
            false,
            status,
            Some("application/json".into()),
            body.to_owned(),
        )
    }

    /// Send response headers, then hold the body until released.
    pub fn hold_body(status: u16, body: &str) -> Self {
        Self::start(
            true,
            true,
            status,
            Some("application/json".into()),
            body.to_owned(),
        )
    }

    pub fn wait_for_headers(&self) {
        let ready = self.shared.headers_sent.lock().expect("headers lock");
        let (ready, _) = self
            .shared
            .headers_ready
            .wait_timeout_while(ready, Duration::from_secs(15), |ready| !*ready)
            .expect("headers wait");
        assert!(*ready, "loopback sent response headers");
    }

    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.shared.requests.lock().expect("request lock").clone()
    }

    pub fn wait_for_request(&self) {
        self.incoming
            .lock()
            .expect("notify lock")
            .recv_timeout(Duration::from_secs(15))
            .expect("loopback received a Polar request");
    }

    pub fn release(&self) {
        *self.shared.released.lock().expect("release lock") = true;
        self.shared.release.notify_all();
    }

    fn start(
        hold: bool,
        hold_body: bool,
        status: u16,
        content_type: Option<String>,
        body: String,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind polar loopback");
        let address = listener.local_addr().expect("loopback address").to_string();
        let (sender, incoming) = mpsc::channel();
        let shared = Arc::new(Shared {
            requests: Mutex::new(Vec::new()),
            notify: Mutex::new(sender),
            hold,
            hold_body,
            released: Mutex::new(false),
            release: Condvar::new(),
            headers_sent: Mutex::new(false),
            headers_ready: Condvar::new(),
            stopped: AtomicBool::new(false),
            status,
            content_type,
            body: body.into_bytes(),
            sockets: Mutex::new(Vec::new()),
        });
        let state = Arc::clone(&shared);
        let thread = thread::spawn(move || serve(listener, state));
        Self {
            base_url: format!("http://{address}"),
            address,
            shared,
            incoming: Mutex::new(incoming),
            thread: Some(thread),
        }
    }
}

impl Drop for PolarHttp {
    fn drop(&mut self) {
        self.shared.stopped.store(true, Ordering::SeqCst);
        self.release();
        for socket in self.shared.sockets.lock().expect("sockets").drain(..) {
            let _ = socket.shutdown(Shutdown::Both);
        }
        let _ = TcpStream::connect(&self.address);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn serve(listener: TcpListener, state: Arc<Shared>) {
    for incoming in listener.incoming() {
        if state.stopped.load(Ordering::SeqCst) {
            break;
        }
        let Ok(stream) = incoming else { break };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(15)));
        if let Ok(socket) = stream.try_clone() {
            state.sockets.lock().expect("sockets").push(socket);
        }
        if let Some(request) = read_request(&stream) {
            state.requests.lock().expect("requests").push(request);
            let _ = state.notify.lock().expect("notify").send(());
            if state.hold_body {
                write_headers(
                    &stream,
                    state.status,
                    state.body.len(),
                    state.content_type.as_deref(),
                );
                *state.headers_sent.lock().expect("headers") = true;
                state.headers_ready.notify_all();
            }
            if state.hold {
                let guard = state.released.lock().expect("released");
                let _ =
                    state
                        .release
                        .wait_timeout_while(guard, Duration::from_secs(30), |released| {
                            !*released && !state.stopped.load(Ordering::SeqCst)
                        });
            }
            if state.stopped.load(Ordering::SeqCst) {
                break;
            }
            if state.hold_body {
                let _ = (&stream).write_all(&state.body);
                let _ = (&stream).flush();
            } else {
                write_response(
                    &stream,
                    state.status,
                    &state.body,
                    state.content_type.as_deref(),
                );
            }
        }
    }
}

fn read_request(stream: &TcpStream) -> Option<RecordedRequest> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_owned();
    let path = parts.next()?.to_owned();
    let mut headers = BTreeMap::<String, String>::new();
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).ok()?;
        let header = header.trim_end_matches(['\r', '\n']);
        if header.is_empty() {
            break;
        }
        let (name, value) = header.split_once(':')?;
        headers
            .entry(name.trim().to_ascii_lowercase())
            .and_modify(|existing| {
                existing.push_str(", ");
                existing.push_str(value.trim());
            })
            .or_insert_with(|| value.trim().to_owned());
    }
    let chunked = headers
        .get("transfer-encoding")
        .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"));
    let mut body = Vec::new();
    if chunked {
        loop {
            let mut size_line = String::new();
            reader.read_line(&mut size_line).ok()?;
            let size_text = size_line.trim().split(';').next().unwrap_or("0");
            let size = usize::from_str_radix(size_text, 16).ok()?;
            if size == 0 {
                loop {
                    let mut trailer = String::new();
                    reader.read_line(&mut trailer).ok()?;
                    if trailer.trim().is_empty() {
                        break;
                    }
                }
                break;
            }
            let mut chunk = vec![0; size];
            reader.read_exact(&mut chunk).ok()?;
            body.extend_from_slice(&chunk);
            let mut crlf = [0; 2];
            reader.read_exact(&mut crlf).ok()?;
        }
    } else if let Some(length) = headers.get("content-length") {
        let length: usize = length.parse().ok()?;
        body.resize(length, 0);
        reader.read_exact(&mut body).ok()?;
    }
    Some(RecordedRequest {
        method,
        path,
        headers,
        body,
    })
}

fn write_response(mut stream: &TcpStream, status: u16, body: &[u8], content_type: Option<&str>) {
    write_headers(stream, status, body.len(), content_type);
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn write_headers(mut stream: &TcpStream, status: u16, length: usize, content_type: Option<&str>) {
    let content_type = content_type
        .map(|value| format!("content-type: {value}\r\n"))
        .unwrap_or_default();
    let head = format!(
        "HTTP/1.1 {status} Recorded\r\n{content_type}content-length: {}\r\nconnection: close\r\n\r\n",
        length
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.flush();
}

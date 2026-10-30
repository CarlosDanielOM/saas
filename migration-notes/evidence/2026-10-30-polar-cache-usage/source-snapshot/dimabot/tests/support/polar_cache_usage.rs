//! Bounded RESP forwarding gate for the explicitly private keyword Redis.
//! It observes actual replies and never manufactures a successful mutation.
use std::{
    io::{self, BufRead, BufReader, Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;
pub const LIMIT: Duration = Duration::from_secs(12);

fn frame(reader: &mut impl BufRead) -> io::Result<Vec<u8>> {
    let mut line = Vec::new();
    if reader.read_until(b'\n', &mut line)? == 0 {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    if !line.ends_with(b"\r\n") {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let head = *line.first().ok_or(io::ErrorKind::InvalidData)?;
    if matches!(head, b'$' | b'!' | b'=') {
        let n = std::str::from_utf8(&line[1..line.len() - 2])
            .map_err(|_| io::ErrorKind::InvalidData)?
            .parse::<i64>()
            .map_err(|_| io::ErrorKind::InvalidData)?;
        if n > 8 * 1024 * 1024 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        if n >= 0 {
            let mut body = vec![0; n as usize + 2];
            reader.read_exact(&mut body)?;
            line.extend(body);
        }
    } else if matches!(head, b'*' | b'%' | b'~' | b'>') {
        let n = std::str::from_utf8(&line[1..line.len() - 2])
            .map_err(|_| io::ErrorKind::InvalidData)?
            .parse::<i64>()
            .map_err(|_| io::ErrorKind::InvalidData)?;
        if n > 4096 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        for _ in 0..n.max(0) * (if head == b'%' { 2 } else { 1 }) {
            line.extend(frame(reader)?);
        }
    }
    Ok(line)
}
fn parts(raw: &[u8]) -> io::Result<Vec<Vec<u8>>> {
    let mut r = BufReader::new(raw);
    let mut line = String::new();
    r.read_line(&mut line)?;
    let count = line
        .trim()
        .strip_prefix('*')
        .ok_or(io::ErrorKind::InvalidData)?
        .parse::<usize>()
        .map_err(|_| io::ErrorKind::InvalidData)?;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        line.clear();
        r.read_line(&mut line)?;
        let n = line
            .trim()
            .strip_prefix('$')
            .ok_or(io::ErrorKind::InvalidData)?
            .parse::<usize>()
            .map_err(|_| io::ErrorKind::InvalidData)?;
        let mut b = vec![0; n];
        r.read_exact(&mut b)?;
        let mut crlf = [0; 2];
        r.read_exact(&mut crlf)?;
        if crlf != *b"\r\n" {
            return Err(io::ErrorKind::InvalidData.into());
        }
        out.push(b);
    }
    Ok(out)
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    Hold,
    LoseReply,
    Reject,
}
struct Arm {
    command: String,
    key: String,
    fault: Fault,
}
struct State {
    stopped: AtomicBool,
    forwarded: Mutex<Vec<Vec<Vec<u8>>>>,
    attempted: Mutex<Vec<Vec<Vec<u8>>>>,
    arm: Mutex<Option<Arm>>,
    applied: Notify,
    gate: Mutex<bool>,
    release: Condvar,
    sockets: Mutex<Vec<TcpStream>>,
}
#[derive(Clone)]
pub struct Recorder {
    state: Arc<State>,
}
impl Recorder {
    pub fn note(&self, kind: &str, payload: &str) {
        self.state
            .attempted
            .lock()
            .unwrap()
            .push(vec![kind.as_bytes().to_vec(), payload.as_bytes().to_vec()]);
    }
}
pub struct Proxy {
    address: String,
    state: Arc<State>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Proxy {
    /// Caller must already have validated the exact alias and unique keys.
    pub fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let state = Arc::new(State {
            stopped: AtomicBool::new(false),
            forwarded: Mutex::new(Vec::new()),
            attempted: Mutex::new(Vec::new()),
            arm: Mutex::new(None),
            applied: Notify::new(),
            gate: Mutex::new(false),
            release: Condvar::new(),
            sockets: Mutex::new(Vec::new()),
        });
        let s = state.clone();
        let thread = std::thread::spawn(move || {
            let mut children = Vec::new();
            for incoming in listener.incoming() {
                let Ok(mut client) = incoming else { break };
                if s.stopped.load(Ordering::SeqCst) {
                    break;
                }
                client.set_read_timeout(Some(LIMIT)).unwrap();
                client.set_write_timeout(Some(LIMIT)).unwrap();
                s.sockets.lock().unwrap().push(client.try_clone().unwrap());
                let s = s.clone();
                children.push(std::thread::spawn(move || {
                    let mut server = TcpStream::connect("keyword-redis:6379").unwrap();
                    server.set_read_timeout(Some(LIMIT)).unwrap();
                    server.set_write_timeout(Some(LIMIT)).unwrap();
                    s.sockets.lock().unwrap().push(server.try_clone().unwrap());
                    let mut requests = BufReader::new(client.try_clone().unwrap());
                    let mut responses = BufReader::new(server.try_clone().unwrap());
                    while let Ok(raw) = frame(&mut requests) {
                        let Ok(args) = parts(&raw) else { break };
                        let cmd = args
                            .first()
                            .map(|x| String::from_utf8_lossy(x).to_ascii_uppercase())
                            .unwrap_or_default();
                        s.attempted.lock().unwrap().push(args.clone());
                        let fault = {
                            let mut arm = s.arm.lock().unwrap();
                            let matches = arm.as_ref().is_some_and(|a| {
                                a.command == cmd
                                    && args
                                        .get(1)
                                        .is_some_and(|key| key.as_slice() == a.key.as_bytes())
                            });
                            if matches {
                                arm.take().map(|a| a.fault)
                            } else {
                                None
                            }
                        };
                        if fault == Some(Fault::Reject) {
                            if client
                                .write_all(b"-ERR fixture injected failure\r\n")
                                .is_err()
                            {
                                break;
                            }
                            continue;
                        }
                        if server.write_all(&raw).is_err() {
                            break;
                        }
                        s.forwarded.lock().unwrap().push(args);
                        let Ok(reply) = frame(&mut responses) else {
                            break;
                        };
                        if matches!(fault, Some(Fault::Hold | Fault::LoseReply)) {
                            // Assert upstream acknowledged successful integer RPUSH before gating.
                            if cmd == "RPUSH" && !reply.starts_with(b":") {
                                break;
                            }
                            s.applied.notify_one();
                            if fault == Some(Fault::LoseReply) {
                                let _ = client.shutdown(Shutdown::Both);
                                break;
                            }
                            let held = s.gate.lock().unwrap();
                            let (released, wait) = s
                                .release
                                .wait_timeout_while(held, LIMIT, |v| {
                                    !*v && !s.stopped.load(Ordering::SeqCst)
                                })
                                .unwrap();
                            if wait.timed_out() || !*released {
                                break;
                            }
                        }
                        if client.write_all(&reply).is_err() {
                            break;
                        }
                    }
                }));
            }
            for child in children {
                child.join().unwrap();
            }
        });
        Self {
            address,
            state,
            thread: Some(thread),
        }
    }
    pub fn url(&self) -> String {
        format!("redis://{}/", self.address)
    }
    pub fn arm(&self, command: &str, key: &str, fault: Fault) {
        *self.state.gate.lock().unwrap() = false;
        *self.state.arm.lock().unwrap() = Some(Arm {
            command: command.into(),
            key: key.into(),
            fault,
        });
    }
    pub async fn applied(&self) {
        tokio::time::timeout(LIMIT, self.state.applied.notified())
            .await
            .expect("proxy applied real command and received reply");
    }
    pub fn release(&self) {
        *self.state.gate.lock().unwrap() = true;
        self.state.release.notify_all();
    }
    pub fn commands(&self) -> Vec<Vec<Vec<u8>>> {
        self.state.forwarded.lock().unwrap().clone()
    }
    pub fn attempts(&self) -> Vec<Vec<Vec<u8>>> {
        self.state.attempted.lock().unwrap().clone()
    }
    pub fn recorder(&self) -> Recorder {
        Recorder {
            state: self.state.clone(),
        }
    }
    pub fn count(&self, command: &str, key: &str) -> usize {
        self.state
            .forwarded
            .lock()
            .unwrap()
            .iter()
            .filter(|args| {
                args.first()
                    .is_some_and(|s| s.eq_ignore_ascii_case(command.as_bytes()))
                    && args.get(1).is_some_and(|s| s.as_slice() == key.as_bytes())
            })
            .count()
    }
}
impl Drop for Proxy {
    fn drop(&mut self) {
        self.state.stopped.store(true, Ordering::SeqCst);
        self.release();
        for socket in self.state.sockets.lock().unwrap().iter() {
            let _ = socket.shutdown(Shutdown::Both);
        }
        let _ = TcpStream::connect(&self.address);
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}

pub struct Catch<F: std::future::Future>(pub std::pin::Pin<Box<F>>);
impl<F: std::future::Future> std::future::Future for Catch<F> {
    type Output = std::thread::Result<F::Output>;
    fn poll(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Self::Output> {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.get_mut().0.as_mut().poll(cx)
        })) {
            Ok(std::task::Poll::Ready(v)) => std::task::Poll::Ready(Ok(v)),
            Ok(std::task::Poll::Pending) => std::task::Poll::Pending,
            Err(e) => std::task::Poll::Ready(Err(e)),
        }
    }
}
pub async fn bounded<F: std::future::Future>(future: F) -> F::Output {
    tokio::time::timeout(LIMIT, future)
        .await
        .expect("bounded private Redis fixture")
}

pub struct HttpPeer {
    address: String,
    received: std::sync::mpsc::Receiver<String>,
    stopped: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl HttpPeer {
    pub fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let (tx, received) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let Ok((mut socket, _)) = listener.accept() else {
                return;
            };
            if stop.load(Ordering::SeqCst) {
                return;
            }
            socket.set_read_timeout(Some(LIMIT)).unwrap();
            socket.set_write_timeout(Some(LIMIT)).unwrap();
            let mut bytes = Vec::new();
            let mut buf = [0; 4096];
            let start = loop {
                let Ok(n) = socket.read(&mut buf) else { return };
                if n == 0 {
                    return;
                }
                bytes.extend_from_slice(&buf[..n]);
                if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            let Ok(headers) = std::str::from_utf8(&bytes[..start]) else {
                return;
            };
            let Some(length) = headers.lines().find_map(|line| {
                line.split_once(':').and_then(|(k, v)| {
                    if k.eq_ignore_ascii_case("content-length") {
                        v.trim().parse::<usize>().ok()
                    } else {
                        None
                    }
                })
            }) else {
                return;
            };
            if length > 8 * 1024 * 1024 {
                return;
            }
            while bytes.len() - start < length {
                let Ok(n) = socket.read(&mut buf) else { return };
                if n == 0 {
                    return;
                }
                bytes.extend_from_slice(&buf[..n]);
            }
            let Ok(body) = String::from_utf8(bytes[start..start + length].to_vec()) else {
                return;
            };
            let _ = socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
            let _ = tx.send(body);
        });
        Self {
            address,
            received,
            stopped,
            thread: Some(thread),
        }
    }
    pub fn endpoint(&self) -> String {
        format!("http://{}/batch/", self.address)
    }
    pub fn body(&self) -> String {
        self.received
            .recv_timeout(LIMIT)
            .expect("loopback PostHog delivery")
    }
}
impl Drop for HttpPeer {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(&self.address);
        if let Some(t) = self.thread.take() {
            t.join().unwrap();
        }
    }
}

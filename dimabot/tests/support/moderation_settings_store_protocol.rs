//! Test-only RESP proxy for the guarded task-owned keyword Redis fixture.
//! No production URL or host is accepted. This draft has not been executed.
#![allow(dead_code)]
use std::{
    io::{self, BufRead, BufReader, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[derive(Clone, Copy)]
pub enum Action {
    Pass,
    Error(&'static str),
    HoldBeforeNx,
    HoldBothNx,
    DropAppliedSet,
    HoldAfterSet,
}
struct Shared {
    stop: AtomicBool,
    state: Mutex<State>,
    signal: Condvar,
}
struct State {
    action: Action,
    triggered: bool,
    applied: bool,
    released: bool,
    after_released: bool,
    requests: Vec<Vec<String>>,
    sockets: Vec<TcpStream>,
}
#[derive(Clone)]
pub struct Trace(Arc<Shared>);
impl Trace {
    pub fn find(&self, channel: &str) {
        self.0
            .state
            .lock()
            .unwrap()
            .requests
            .push(vec!["FIND".into(), channel.into()]);
    }
}
pub struct Proxy {
    pub url: String,
    shared: Arc<Shared>,
    worker: Option<JoinHandle<()>>,
}
impl Proxy {
    pub fn start(action: Action) -> Self {
        assert_eq!(
            std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
            Ok("dimabot-migration")
        );
        assert_eq!(
            std::env::var("KEYWORD_FIXTURE_REDIS_URL").as_deref(),
            Ok("redis://keyword-redis:6379/")
        );
        let ns = std::env::var("KEYWORD_FIXTURE_NAMESPACE").unwrap();
        assert!(
            ns.starts_with("keyword-fixture-")
                && ns.ends_with(':')
                && (24..=50).contains(&ns.len())
                && ns
                    .trim_end_matches(':')
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("redis://{}/", listener.local_addr().unwrap());
        let shared = Arc::new(Shared {
            stop: AtomicBool::new(false),
            state: Mutex::new(State {
                action,
                triggered: false,
                applied: false,
                released: false,
                after_released: false,
                requests: vec![],
                sockets: vec![],
            }),
            signal: Condvar::new(),
        });
        let child = shared.clone();
        let worker = thread::spawn(move || {
            let mut children = vec![];
            while !child.stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((socket, _)) => {
                        child
                            .state
                            .lock()
                            .unwrap()
                            .sockets
                            .push(socket.try_clone().unwrap());
                        let s = child.clone();
                        children.push(thread::spawn(move || {
                            let _ = serve(socket, s);
                        }));
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(_) => break,
                }
            }
            for worker in children {
                let _ = worker.join();
            }
        });
        Self {
            url,
            shared,
            worker: Some(worker),
        }
    }
    pub fn trace(&self) -> Trace {
        Trace(self.shared.clone())
    }
    pub fn wait_trigger(&self) {
        let limit = Instant::now() + Duration::from_secs(5);
        let mut s = self.shared.state.lock().unwrap();
        while !s.triggered {
            let left = limit.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "proxy action not reached");
            let (next, _) = self.shared.signal.wait_timeout(s, left).unwrap();
            s = next;
        }
    }
    pub fn wait_applied(&self) {
        let limit = Instant::now() + Duration::from_secs(5);
        let mut s = self.shared.state.lock().unwrap();
        while !s.applied {
            let left = limit.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "proxy command not applied");
            let (next, _) = self.shared.signal.wait_timeout(s, left).unwrap();
            s = next;
        }
    }
    pub fn release(&self) {
        let mut s = self.shared.state.lock().unwrap();
        s.released = true;
        self.shared.signal.notify_all();
    }
    pub fn release_after(&self) {
        let mut s = self.shared.state.lock().unwrap();
        s.after_released = true;
        self.shared.signal.notify_all();
    }
    pub fn requests(&self) -> Vec<Vec<String>> {
        self.shared.state.lock().unwrap().requests.clone()
    }
    pub fn connections(&self) -> usize {
        self.shared.state.lock().unwrap().sockets.len()
    }
}
impl Drop for Proxy {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        let mut s = self.shared.state.lock().unwrap();
        s.released = true;
        s.after_released = true;
        for socket in &s.sockets {
            let _ = socket.shutdown(Shutdown::Both);
        }
        self.shared.signal.notify_all();
        drop(s);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}
fn serve(mut downstream: TcpStream, shared: Arc<Shared>) -> io::Result<()> {
    let mut upstream = TcpStream::connect("keyword-redis:6379")?;
    let mut input = BufReader::new(downstream.try_clone()?);
    let mut responses = BufReader::new(upstream.try_clone()?);
    loop {
        let mut raw = vec![];
        let request = read_frame(&mut input, &mut raw)?;
        let args = match request {
            Frame::Array(a) => a
                .into_iter()
                .map(|f| match f {
                    Frame::Bytes(b) => String::from_utf8_lossy(&b).into_owned(),
                    _ => String::new(),
                })
                .collect::<Vec<_>>(),
            _ => return Err(io::ErrorKind::InvalidData.into()),
        };
        let command = args
            .first()
            .map(|x| x.to_ascii_uppercase())
            .unwrap_or_default();
        let mut s = shared.state.lock().unwrap();
        if matches!(command.as_str(), "GET" | "SET" | "DEL") {
            s.requests.push(args.clone());
        }
        let action = if !s.triggered { s.action } else { Action::Pass };
        let matched = match action {
            Action::Error(c) => command == c,
            Action::HoldBeforeNx | Action::HoldBothNx => {
                command == "SET" && args.iter().any(|x| x.eq_ignore_ascii_case("NX"))
            }
            Action::DropAppliedSet | Action::HoldAfterSet => command == "SET",
            Action::Pass => false,
        };
        if matched {
            s.triggered = true;
            shared.signal.notify_all();
        }
        if matched && matches!(action, Action::HoldBeforeNx | Action::HoldBothNx) {
            while !s.released && !shared.stop.load(Ordering::SeqCst) {
                s = shared.signal.wait(s).unwrap();
            }
        }
        drop(s);
        if matched && matches!(action, Action::Error(_)) {
            downstream.write_all(b"-ERR injected\r\n")?;
            continue;
        }
        upstream.write_all(&raw)?;
        let mut response = vec![];
        read_frame(&mut responses, &mut response)?;
        if matched {
            let mut s = shared.state.lock().unwrap();
            s.applied = true;
            shared.signal.notify_all();
        }
        if matched && matches!(action, Action::HoldBothNx) {
            let mut s = shared.state.lock().unwrap();
            while !s.after_released && !shared.stop.load(Ordering::SeqCst) {
                s = shared.signal.wait(s).unwrap();
            }
        }
        if matched && matches!(action, Action::DropAppliedSet) {
            if response != b"+OK\r\n" {
                return Err(io::ErrorKind::InvalidData.into());
            }
            downstream.shutdown(Shutdown::Both)?;
            return Ok(());
        }
        if matched && matches!(action, Action::HoldAfterSet) {
            let mut s = shared.state.lock().unwrap();
            while !s.released && !shared.stop.load(Ordering::SeqCst) {
                s = shared.signal.wait(s).unwrap();
            }
        }
        downstream.write_all(&response)?;
    }
}
enum Frame {
    Bytes(Vec<u8>),
    Array(Vec<Frame>),
    Other,
}
fn read_frame(reader: &mut impl BufRead, out: &mut Vec<u8>) -> io::Result<Frame> {
    let mut line = Vec::new();
    reader.read_until(b'\n', &mut line)?;
    if line.len() < 3 || !line.ends_with(b"\r\n") {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    let kind = line[0];
    out.extend_from_slice(&line);
    if kind == b'$' || kind == b'*' {
        let n = std::str::from_utf8(&line[1..line.len() - 2])
            .map_err(|_| io::ErrorKind::InvalidData)?
            .parse::<i64>()
            .map_err(|_| io::ErrorKind::InvalidData)?;
        if n < 0 {
            return Ok(Frame::Other);
        }
        if n > 16_777_216 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        if kind == b'$' {
            let mut body = vec![0; n as usize + 2];
            reader.read_exact(&mut body)?;
            if !body.ends_with(b"\r\n") {
                return Err(io::ErrorKind::InvalidData.into());
            }
            out.extend_from_slice(&body);
            body.truncate(n as usize);
            return Ok(Frame::Bytes(body));
        }
        let mut fields = Vec::with_capacity(n as usize);
        for _ in 0..n {
            fields.push(read_frame(reader, out)?);
        }
        return Ok(Frame::Array(fields));
    }
    if matches!(kind, b'+' | b'-' | b':') {
        Ok(Frame::Other)
    } else {
        Err(io::ErrorKind::InvalidData.into())
    }
}

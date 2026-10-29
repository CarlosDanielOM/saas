//! Private bounded RESP2 fixture/proxy. Never connects to an implicit endpoint.
#![allow(dead_code)]
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use std::{
    io::{self, BufRead, BufReader, Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};
pub type Command = Vec<String>;
pub fn read_command(reader: &mut BufReader<TcpStream>) -> io::Result<Command> {
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let count: usize = line
        .trim()
        .strip_prefix('*')
        .ok_or_else(|| io::Error::other("expected array"))?
        .parse()
        .map_err(io::Error::other)?;
    if count > 32 {
        return Err(io::Error::other("oversized command"));
    }
    let mut out = Vec::new();
    for _ in 0..count {
        line.clear();
        reader.read_line(&mut line)?;
        let n: usize = line
            .trim()
            .strip_prefix('$')
            .ok_or_else(|| io::Error::other("expected bulk"))?
            .parse()
            .map_err(io::Error::other)?;
        if n > 1024 * 1024 {
            return Err(io::Error::other("oversized argument"));
        }
        let mut bytes = vec![0; n + 2];
        reader.read_exact(&mut bytes)?;
        bytes.truncate(n);
        out.push(String::from_utf8(bytes).map_err(io::Error::other)?);
    }
    Ok(out)
}
pub fn write_command(stream: &mut TcpStream, args: &Command) -> io::Result<()> {
    write!(stream, "*{}\r\n", args.len())?;
    for arg in args {
        write!(stream, "${}\r\n{}\r\n", arg.len(), arg)?;
    }
    stream.flush()
}
pub fn read_reply(reader: &mut BufReader<TcpStream>) -> io::Result<Vec<u8>> {
    let mut line = Vec::new();
    reader.read_until(b'\n', &mut line)?;
    if line.is_empty() {
        return Err(io::Error::other("closed"));
    }
    if line[0] == b'$' {
        let n: i64 = std::str::from_utf8(&line[1..line.len() - 2])
            .map_err(io::Error::other)?
            .parse()
            .map_err(io::Error::other)?;
        if n >= 0 {
            let mut b = vec![0; n as usize + 2];
            reader.read_exact(&mut b)?;
            line.extend(b);
        }
    }
    Ok(line)
}
pub fn bulk(value: Option<&str>) -> Vec<u8> {
    value
        .map(|s| format!("${}\r\n{}\r\n", s.len(), s).into_bytes())
        .unwrap_or_else(|| b"$-1\r\n".to_vec())
}
pub struct Endpoint {
    pub url: String,
    pub calls: Arc<Mutex<Vec<Command>>>,
    pub connections: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    sockets: Arc<Mutex<Vec<TcpStream>>>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Endpoint {
    pub fn new(handler: impl Fn(&Command) -> Vec<u8> + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("redis://{}/", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let sockets = Arc::new(Mutex::new(Vec::new()));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let connections = Arc::new(AtomicUsize::new(0));
        let (s, ss, cc, connections_thread) = (
            stop.clone(),
            sockets.clone(),
            calls.clone(),
            connections.clone(),
        );
        let handler = Arc::new(handler);
        let thread = thread::spawn(move || {
            let mut children = Vec::new();
            while !s.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        if s.load(Ordering::SeqCst) {
                            break;
                        }
                        connections_thread.fetch_add(1, Ordering::SeqCst);
                        stream
                            .set_read_timeout(Some(Duration::from_secs(10)))
                            .unwrap();
                        stream
                            .set_write_timeout(Some(Duration::from_secs(10)))
                            .unwrap();
                        ss.lock().unwrap().push(stream.try_clone().unwrap());
                        let c = cc.clone();
                        let h = handler.clone();
                        children.push(thread::spawn(move || {
                            let mut reader = BufReader::new(stream.try_clone().unwrap());
                            while let Ok(args) = read_command(&mut reader) {
                                let reply = match args[0].as_str() {
                                    "CLIENT" => b"+OK\r\n".to_vec(),
                                    "PING" => h(&args),
                                    _ => {
                                        c.lock().unwrap().push(args.clone());
                                        h(&args)
                                    }
                                };
                                if reply.is_empty() || stream.write_all(&reply).is_err() {
                                    break;
                                }
                            }
                            // The endpoint retains a cloned socket for bounded
                            // cleanup. Closing this handler must still deliver
                            // EOF to the client rather than leave that clone open.
                            let _ = stream.shutdown(Shutdown::Both);
                        }));
                    }
                    Err(_) => break,
                }
            }
            for stream in ss.lock().unwrap().iter() {
                let _ = stream.shutdown(Shutdown::Both);
            }
            for child in children {
                let _ = child.join();
            }
        });
        Self {
            url,
            calls,
            connections,
            stop,
            sockets,
            thread: Some(thread),
        }
    }
    pub async fn manager(&self) -> ConnectionManager {
        redis::Client::open(self.url.as_str())
            .unwrap()
            .get_connection_manager_with_config(
                ConnectionManagerConfig::new().set_response_timeout(None),
            )
            .await
            .unwrap()
    }
}
impl Drop for Endpoint {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        for s in self.sockets.lock().unwrap().iter() {
            let _ = s.shutdown(Shutdown::Both);
        }
        let address = self
            .url
            .strip_prefix("redis://")
            .unwrap()
            .strip_suffix('/')
            .unwrap();
        let _ = TcpStream::connect(address);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
/// Strict parsed allowlist; no credentials, TLS, query, fragment, or database.
pub fn fixture_url() -> (String, String, u16) {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration")
    );
    let url = std::env::var("DIMA_TEST_REDIS_URL").expect("explicit disposable fixture URL");
    let (host, port) = parse_fixture_url(&url);
    (url, host, port)
}
pub fn parse_fixture_url(url: &str) -> (String, u16) {
    let authority = url
        .strip_prefix("redis://")
        .expect("plain redis scheme")
        .strip_suffix('/')
        .unwrap_or_else(|| url.strip_prefix("redis://").unwrap());
    let (host, port) = authority.rsplit_once(':').expect("explicit host:port");
    assert!(
        [
            "keyword-redis",
            "redis-fixture",
            "127.0.0.1",
            "localhost",
            "[::1]"
        ]
        .contains(&host),
        "fixture host required"
    );
    assert!(!port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()));
    let port: u16 = port.parse().unwrap();
    assert_ne!(port, 0);
    (host.trim_matches(['[', ']']).into(), port)
}
/// Bounded subprocess collection, killing/reaping the owned child on failure.
/// The short park is idle process-completion waiting after try_wait, never a
/// cadence while fixture commands or ready records remain to be processed.
pub fn child_output(mut child: std::process::Child, limit: Duration) -> std::process::Output {
    let end = std::time::Instant::now() + limit;
    loop {
        if child.try_wait().unwrap().is_some() {
            return child.wait_with_output().unwrap();
        }
        if std::time::Instant::now() >= end {
            let _ = child.kill();
            let _ = child.wait();
            panic!("default child deadline");
        }
        std::thread::park_timeout(Duration::from_millis(10));
    }
}

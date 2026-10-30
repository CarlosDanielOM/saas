//! Guarded response-loss proxy for exclusively owned private Redis fixtures.
#![allow(dead_code)]
use std::{
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};
/// RESP2 forwarding proxy to the exact guarded private Redis alias. It drops
/// the first applied EVALSHA response, producing a genuinely uncertain result.
pub struct RedisResponseLoss {
    pub url: String,
    pub script_count: Arc<AtomicUsize>,
    pub set_count: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl RedisResponseLoss {
    pub fn start() -> Self {
        Self::start_dropping_set(false)
    }
    pub fn start_dropping_set(drop_set: bool) -> Self {
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
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("redis://{}/", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let script_count = Arc::new(AtomicUsize::new(0));
        let counted = script_count.clone();
        let set_count = Arc::new(AtomicUsize::new(0));
        let sets = set_count.clone();
        let worker = thread::spawn(move || {
            while !stopped.load(Ordering::SeqCst) {
                let (mut downstream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                    Err(error) => panic!("private RESP accept: {error}"),
                };
                downstream
                    .set_read_timeout(Some(Duration::from_millis(100)))
                    .unwrap();
                let mut upstream = std::net::TcpStream::connect("keyword-redis:6379").unwrap();
                upstream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut down_reader = BufReader::new(downstream.try_clone().unwrap());
                let mut up_reader = BufReader::new(upstream.try_clone().unwrap());
                loop {
                    if stopped.load(Ordering::SeqCst) {
                        return;
                    }
                    let mut request = Vec::new();
                    match resp_frame(&mut down_reader, &mut request) {
                        Ok(()) => {}
                        Err(error)
                            if request.is_empty()
                                && matches!(
                                    error.kind(),
                                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                                ) =>
                        {
                            continue;
                        }
                        Err(_) => break,
                    }
                    let command = request
                        .split(|b| *b == b'\n')
                        .nth(2)
                        .unwrap_or_default()
                        .strip_suffix(b"\r")
                        .unwrap_or_default();
                    let script = command.eq_ignore_ascii_case(b"EVALSHA")
                        || command.eq_ignore_ascii_case(b"EVAL");
                    let set = command.eq_ignore_ascii_case(b"SET");
                    upstream.write_all(&request).unwrap();
                    let mut response = Vec::new();
                    resp_frame(&mut up_reader, &mut response).unwrap();
                    if script {
                        let index = counted.fetch_add(1, Ordering::SeqCst);
                        if index == 0 && !drop_set {
                            assert_ne!(
                                response.first(),
                                Some(&b'-'),
                                "uncertainty fixture must drop a successful applied script response"
                            );
                            break;
                        }
                    }
                    if set {
                        let index = sets.fetch_add(1, Ordering::SeqCst);
                        if drop_set && index == 0 {
                            assert_eq!(response.as_slice(), b"+OK\r\n", "drop only successful SET");
                            break;
                        }
                    }
                    if downstream.write_all(&response).is_err() {
                        break;
                    }
                }
            }
        });
        Self {
            url,
            script_count,
            set_count,
            stop,
            worker: Some(worker),
        }
    }
}
impl Drop for RedisResponseLoss {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let result = worker.join();
            if !thread::panicking() {
                result.unwrap();
            }
        }
    }
}
fn resp_frame(reader: &mut impl BufRead, output: &mut Vec<u8>) -> std::io::Result<()> {
    let mut line = Vec::new();
    reader.read_until(b'\n', &mut line)?;
    if line.is_empty() {
        return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof));
    }
    if !line.ends_with(b"\r\n") {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
    }
    let kind = line[0];
    let count = if kind == b'$' || kind == b'*' {
        std::str::from_utf8(&line[1..line.len() - 2])
            .unwrap()
            .parse::<i64>()
            .unwrap()
    } else {
        0
    };
    output.extend_from_slice(&line);
    if kind == b'$' && count >= 0 {
        let mut data = vec![0; count as usize + 2];
        reader.read_exact(&mut data)?;
        output.extend_from_slice(&data);
    } else if kind == b'*' && count >= 0 {
        for _ in 0..count {
            resp_frame(reader, output)?;
        }
    } else if !matches!(kind, b'+' | b'-' | b':' | b'$' | b'*') {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
    }
    Ok(())
}

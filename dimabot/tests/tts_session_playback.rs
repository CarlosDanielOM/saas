#![cfg(all(feature = "tts-utilities", feature = "redis"))]
use dima_rust::utils::tts::{
    playback_timeout::{
        audio_file_duration_ms, audio_file_duration_ms_async, tts_playback_timeout_ms,
        tts_playback_timeout_ms_async,
    },
    session::TtsSession,
};
use serde_json::Value;

#[tokio::test]
#[ignore = "requires task-owned source oracle audio fixtures"]
async fn file_duration_matches_typescript_oracle() {
    let dir = std::env::var("DIMA_TTS_PLAYBACK_FIXTURES").expect("DIMA_TTS_PLAYBACK_FIXTURES");
    let dir = std::path::Path::new(&dir);
    let cases: Vec<Value> = serde_json::from_slice(
        &std::fs::read(dir.join("tts_session_playback_cases.json")).unwrap(),
    )
    .unwrap();
    for case in cases {
        let file = dir.join(case["name"].as_str().unwrap());
        assert_eq!(
            audio_file_duration_ms(&file),
            case["duration"].as_u64().unwrap(),
            "{}",
            file.display()
        );
        assert_eq!(
            tts_playback_timeout_ms(&file),
            case["timeout"].as_u64().unwrap(),
            "{}",
            file.display()
        );
        assert_eq!(
            audio_file_duration_ms_async(&file).await,
            case["duration"].as_u64().unwrap(),
            "{}",
            file.display()
        );
        assert_eq!(
            tts_playback_timeout_ms_async(&file).await,
            case["timeout"].as_u64().unwrap(),
            "{}",
            file.display()
        );
    }
    assert_eq!(audio_file_duration_ms(&dir.join("missing.wav")), 0);
}

#[tokio::test]
#[ignore = "requires task-owned disposable Dragonfly and DIMA_TEST_REDIS_URL"]
async fn actual_lua_session_and_bounded_cleanup() {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration")
    );
    let url = std::env::var("DIMA_TEST_REDIS_URL").unwrap();
    assert!(
        url.starts_with("redis://keyword-redis:")
            || url.starts_with("redis://redis:")
            || url.starts_with("redis://127.0.0.1:")
            || url.starts_with("redis://localhost:")
    );
    let client = redis::Client::open(url).unwrap();
    let mut cache = redis::aio::ConnectionManager::new(client).await.unwrap();
    let adapter = TtsSession::new(cache.clone());
    let channel = format!(
        "tts-session-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let prefix = format!("twitch:{channel}:tts:");
    adapter
        .enqueue(&channel, "before", 1.0, "{}")
        .await
        .unwrap();
    assert_eq!(adapter.pop(&channel).await.unwrap().unwrap().session, None);
    adapter.enqueue(&channel, "", 1.0, "{}").await.unwrap();
    assert!(adapter.pop(&channel).await.unwrap().is_none());
    let count: i64 = redis::cmd("ZCARD")
        .arg(format!("{prefix}queue"))
        .query_async(&mut cache)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let _: i64 = redis::cmd("ZREM")
        .arg(format!("{prefix}queue"))
        .arg("")
        .query_async(&mut cache)
        .await
        .unwrap();
    for i in 0..260 {
        adapter
            .enqueue(&channel, &format!("{i}"), i as f64, "{}")
            .await
            .unwrap();
    }
    adapter.reset(&channel, "new", &[]).await.unwrap();
    let gone: Option<String> = redis::cmd("GET")
        .arg(format!("{prefix}queue:data:129"))
        .query_async(&mut cache)
        .await
        .unwrap();
    assert!(gone.is_none());
    adapter.enqueue(&channel, "129", 1.0, "{}").await.unwrap();
    let item = adapter.pop(&channel).await.unwrap().unwrap();
    assert_eq!(item.session.as_deref(), Some("new"));
    assert_eq!(
        serde_json::from_str::<Value>(&item.payload).unwrap()["queueSession"],
        "new"
    );
    let keys: Vec<String> = redis::cmd("KEYS")
        .arg(format!("{prefix}*"))
        .query_async(&mut cache)
        .await
        .unwrap();
    if !keys.is_empty() {
        let _: i64 = redis::cmd("DEL")
            .arg(keys)
            .query_async(&mut cache)
            .await
            .unwrap();
    }
}

// A test-only RESP relay pauses requests at the native adapter's real command
// boundaries. The other client talks directly to the same disposable server.
// No production callbacks or timing sleeps are needed.
mod race_fixture {
    use super::*;
    use std::{
        io::{self, BufRead, BufReader, Read, Write},
        net::{Shutdown, TcpListener, TcpStream},
        sync::mpsc,
        thread,
        time::Duration,
    };
    const DEADLINE: Duration = Duration::from_secs(10);

    enum Pause {
        Pop,
        Cleanup,
    }
    struct Relay {
        entered: mpsc::Receiver<()>,
        release: mpsc::Sender<()>,
        socket: mpsc::Receiver<TcpStream>,
        worker: Option<thread::JoinHandle<()>>,
        url: String,
    }
    type RequestFrame = (Vec<u8>, Vec<Vec<u8>>);
    fn request(reader: &mut BufReader<TcpStream>) -> io::Result<Option<RequestFrame>> {
        let mut line = Vec::new();
        if reader.read_until(b'\n', &mut line)? == 0 {
            return Ok(None);
        }
        if line.first() != Some(&b'*') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "expected RESP array",
            ));
        }
        let count: usize = std::str::from_utf8(&line[1..line.len() - 2])
            .map_err(io::Error::other)?
            .parse()
            .map_err(io::Error::other)?;
        let mut raw = line;
        let mut args = Vec::with_capacity(count);
        for _ in 0..count {
            let mut len = Vec::new();
            reader.read_until(b'\n', &mut len)?;
            if len.first() != Some(&b'$') {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "expected RESP bulk",
                ));
            }
            let size: usize = std::str::from_utf8(&len[1..len.len() - 2])
                .map_err(io::Error::other)?
                .parse()
                .map_err(io::Error::other)?;
            raw.extend_from_slice(&len);
            let mut bytes = vec![0; size + 2];
            reader.read_exact(&mut bytes)?;
            args.push(bytes[..size].to_vec());
            raw.extend_from_slice(&bytes);
        }
        Ok(Some((raw, args)))
    }
    impl Relay {
        fn start(server: &str, pause: Pause, limit: usize) -> Self {
            let endpoint = server
                .strip_prefix("redis://")
                .unwrap()
                .split('/')
                .next()
                .unwrap();
            assert!(
                endpoint.starts_with("keyword-redis:")
                    || endpoint.starts_with("redis:")
                    || endpoint.starts_with("127.0.0.1:")
                    || endpoint.starts_with("localhost:")
            );
            let upstream = TcpStream::connect(endpoint).unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("redis://{}/", listener.local_addr().unwrap());
            let (entered_tx, entered) = mpsc::channel();
            let (release, release_rx) = mpsc::channel();
            let (socket_tx, socket) = mpsc::channel();
            let worker = thread::spawn(move || {
                let (client, _) = listener.accept().unwrap();
                let _ = socket_tx.send(client.try_clone().unwrap());
                let mut upstream_write = upstream.try_clone().unwrap();
                let mut downstream = client.try_clone().unwrap();
                let relay_response = thread::spawn(move || {
                    let mut input = upstream;
                    let _ = io::copy(&mut input, &mut downstream);
                });
                let mut reader = BufReader::new(client);
                let mut pauses = 0;
                while let Ok(Some((raw, args))) = request(&mut reader) {
                    let eval = args.first().is_some_and(|s| {
                        s.eq_ignore_ascii_case(b"EVALSHA") || s.eq_ignore_ascii_case(b"EVAL")
                    });
                    let first_key = args.get(3).map(Vec::as_slice).unwrap_or_default();
                    let matched = eval
                        && match pause {
                            Pause::Pop => first_key.ends_with(b":tts:queue"),
                            Pause::Cleanup => first_key
                                .windows(b":tts:queue:data:".len())
                                .any(|w| w == b":tts:queue:data:"),
                        };
                    if matched && pauses < limit {
                        pauses += 1;
                        if entered_tx.send(()).is_err()
                            || release_rx.recv_timeout(DEADLINE).is_err()
                        {
                            break;
                        }
                    }
                    if upstream_write.write_all(&raw).is_err() {
                        break;
                    }
                }
                let _ = upstream_write.shutdown(Shutdown::Both);
                let _ = relay_response.join();
            });
            Self {
                entered,
                release,
                socket,
                worker: Some(worker),
                url,
            }
        }
        fn wait(&self) {
            self.entered
                .recv_timeout(DEADLINE)
                .expect("adapter command did not reach relay");
        }
        fn resume(&self) {
            self.release.send(()).unwrap();
        }
        fn close(mut self) {
            let socket = self.socket.recv_timeout(DEADLINE).unwrap();
            let _ = socket.shutdown(Shutdown::Both);
            self.worker.take().unwrap().join().unwrap();
        }
    }

    async fn connection(url: &str) -> redis::aio::ConnectionManager {
        let client = redis::Client::open(url).unwrap();
        tokio::time::timeout(DEADLINE, redis::aio::ConnectionManager::new(client))
            .await
            .unwrap()
            .unwrap()
    }
    async fn bounded<T>(f: impl std::future::Future<Output = T>) -> T {
        tokio::time::timeout(DEADLINE, f)
            .await
            .expect("fixture operation timed out")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires task-owned disposable Dragonfly and DIMA_TEST_REDIS_URL"]
    async fn real_adapter_forced_cas_and_reset_races() {
        assert_eq!(
            std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
            Ok("dimabot-migration")
        );
        let url = std::env::var("DIMA_TEST_REDIS_URL").unwrap();
        let endpoint = url
            .strip_prefix("redis://")
            .unwrap()
            .split('/')
            .next()
            .unwrap();
        assert!(
            endpoint.starts_with("keyword-redis:")
                || endpoint.starts_with("redis:")
                || endpoint.starts_with("127.0.0.1:")
                || endpoint.starts_with("localhost:")
        );
        let mut raw = connection(&url).await;
        let direct = TtsSession::new(raw.clone());
        let channel = format!(
            "tts-race-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let prefix = format!("twitch:{channel}:tts:");

        // Load the actual adapter scripts on the disposable server so EVALSHA
        // reaches each pause exactly once, rather than first returning NOSCRIPT.
        bounded(direct.enqueue(&channel, "warm", 0.0, "{}"))
            .await
            .unwrap();
        bounded(direct.pop(&channel)).await.unwrap();
        bounded(direct.enqueue(&channel, "warm-reset", 0.0, "{}"))
            .await
            .unwrap();
        bounded(direct.reset(&channel, "old", &[])).await.unwrap();

        bounded(direct.enqueue(&channel, "peeked", 20.0, "{}"))
            .await
            .unwrap();
        let relay = Relay::start(&url, Pause::Pop, 1);
        let adapter = TtsSession::new(connection(&relay.url).await);
        let name = channel.clone();
        let task = tokio::spawn(async move { adapter.pop(&name).await });
        relay.wait();
        bounded(direct.enqueue(&channel, "minimum", 1.0, "{}"))
            .await
            .unwrap();
        relay.resume();
        assert_eq!(
            bounded(task).await.unwrap().unwrap().unwrap().value,
            "minimum"
        );
        relay.close();
        assert_eq!(
            bounded(direct.pop(&channel)).await.unwrap().unwrap().value,
            "peeked"
        );

        bounded(direct.enqueue(&channel, "original", 100.0, "{}"))
            .await
            .unwrap();
        let relay = Relay::start(&url, Pause::Pop, 8);
        let adapter = TtsSession::new(connection(&relay.url).await);
        let name = channel.clone();
        let task = tokio::spawn(async move { adapter.pop(&name).await });
        for n in 0..8 {
            relay.wait();
            bounded(direct.enqueue(&channel, &format!("contender-{n}"), -(n as f64), "{}"))
                .await
                .unwrap();
            relay.resume();
        }
        assert!(bounded(task).await.unwrap().unwrap().is_none());
        relay.close();
        let count: i64 = bounded(
            redis::cmd("ZCARD")
                .arg(format!("{prefix}queue"))
                .query_async(&mut raw),
        )
        .await
        .unwrap();
        assert_eq!(count, 9);

        // Pause after RESET's atomic boundary, before the first cleanup chunk.
        // Reusing an old ID and adding a fresh ID must survive the old fence.
        bounded(direct.enqueue(&channel, "reused", 50.0, "{}"))
            .await
            .unwrap();
        let _: () = bounded(
            redis::cmd("SET")
                .arg(format!("{prefix}processing"))
                .arg("original")
                .query_async(&mut raw),
        )
        .await
        .unwrap();
        let relay = Relay::start(&url, Pause::Cleanup, 1);
        let adapter = TtsSession::new(connection(&relay.url).await);
        let name = channel.clone();
        let task = tokio::spawn(async move { adapter.reset(&name, "new", &[]).await });
        relay.wait();
        let marker: String = bounded(
            redis::cmd("GET")
                .arg(format!("{prefix}session"))
                .query_async(&mut raw),
        )
        .await
        .unwrap();
        assert_eq!(marker, "new");
        bounded(direct.enqueue(&channel, "reused", 1.0, "{}"))
            .await
            .unwrap();
        bounded(direct.enqueue(&channel, "late", 2.0, "{}"))
            .await
            .unwrap();
        relay.resume();
        bounded(task).await.unwrap().unwrap();
        relay.close();
        let old: Option<String> = bounded(
            redis::cmd("GET")
                .arg(format!("{prefix}queue:data:original"))
                .query_async(&mut raw),
        )
        .await
        .unwrap();
        assert!(old.is_none());
        for expected in ["reused", "late"] {
            let item = bounded(direct.pop(&channel)).await.unwrap().unwrap();
            assert_eq!(item.value, expected);
            assert_eq!(item.session.as_deref(), Some("new"));
            assert_eq!(
                serde_json::from_str::<Value>(&item.payload).unwrap()["queueSession"],
                "new"
            );
        }
        let keys: Vec<String> = bounded(
            redis::cmd("KEYS")
                .arg(format!("{prefix}*"))
                .query_async(&mut raw),
        )
        .await
        .unwrap();
        if !keys.is_empty() {
            let _: i64 = bounded(redis::cmd("DEL").arg(keys).query_async(&mut raw))
                .await
                .unwrap();
        }
    }
}

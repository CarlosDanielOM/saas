//! Multipart uploads over real connections: streaming into the storage, client aborts, the hard
//! deadline and cleanup of partial files, and rejected uploads still answered.

// Test code may unwrap, expect and panic (see clippy.toml); helpers outside `#[test]`
// functions need the allowance spelled out.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dima_web::multipart::{
    DiskStorage, FileInfo, FileStream, Limits, Multer, Storage, StoredFile, UploadError,
    UploadedFile,
};
use dima_web::{App, BoxFuture, Error, Req, Response, Router, ServeOptions, serve};
use serde_json::json;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

const BOUNDARY: &str = "----dima-test-boundary";

/// A temporary directory removed when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let path =
            std::env::temp_dir().join(format!("dima-web-{label}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&path).expect("temp dir");
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn entries(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

async fn eventually_empty(dir: &Path) -> Vec<String> {
    for _ in 0..200 {
        let names = entries(dir);
        if names.is_empty() {
            return names;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    entries(dir)
}

/// Shared by the handlers.
#[derive(Default)]
struct Shared {
    dir: PathBuf,
    outcome: Mutex<Option<oneshot::Sender<String>>>,
    first_chunk: Mutex<Option<oneshot::Sender<usize>>>,
}

type State = Arc<Shared>;

fn report(req: &Req<State>, text: String) {
    if let Some(tx) = req.state().outcome.lock().unwrap().take() {
        let _ = tx.send(text);
    }
}

fn outcome_text(outcome: &Result<Option<UploadedFile>, UploadError>) -> String {
    match outcome {
        Ok(Some(file)) => format!("ok {} {}", file.originalname, file.size()),
        Ok(None) => "none".to_owned(),
        Err(UploadError::Multer(error)) => format!("multer {}", error.code.as_str()),
        Err(error) => format!("error {error}"),
    }
}

/// POST /disk: files named after the client's name (emoji included), 1 MiB at most.
async fn disk(req: &mut Req<State>) -> Response {
    let dir = req.state().dir.clone();
    let multer = Multer::new(DiskStorage::new(&dir).filename(|file| file.originalname.clone()))
        .limits(Limits {
            file_size: Some(1024 * 1024),
            ..Limits::default()
        });
    let outcome = multer.single("file").run(req).await;
    report(req, outcome_text(&outcome));
    match outcome {
        Ok(file) => Response::new().json(&json!({ "size": file.map(|f| f.size()) })),
        Err(UploadError::Multer(error)) => {
            Response::status(413).json(&json!({ "error": true, "code": error.code.as_str() }))
        }
        Err(error) => Response::status(400).json(&json!({ "error": error.to_string() })),
    }
}

/// POST /deadline: the asset library's hard deadline, shortened.
async fn deadline(req: &mut Req<State>) -> Response {
    let dir = req.state().dir.clone();
    let multer = Multer::new(DiskStorage::new(&dir)).deadline(Duration::from_millis(300));
    let outcome = multer.single("file").run(req).await;
    report(req, outcome_text(&outcome));
    Response::status(408)
        .header("Connection", "close")
        .json(&json!({ "error": "upload_aborted" }))
}

/// A storage that reports its first chunk as soon as it arrives, then counts the rest.
struct Watching(State);

impl Storage for Watching {
    fn handle_file<'a>(
        &'a self,
        _file: &'a FileInfo,
        data: &'a mut FileStream<'_>,
    ) -> BoxFuture<'a, Result<StoredFile, Error>> {
        Box::pin(async move {
            let mut size = 0u64;
            while let Some(chunk) = data.chunk().await {
                let chunk = chunk?;
                if size == 0
                    && let Some(tx) = self.0.first_chunk.lock().unwrap().take()
                {
                    let _ = tx.send(chunk.len());
                }
                size += chunk.len() as u64;
            }
            Ok(StoredFile {
                size,
                ..StoredFile::default()
            })
        })
    }

    fn remove_file<'a>(&'a self, _file: &'a mut UploadedFile) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async { Ok(()) })
    }
}

/// POST /stream: a streaming storage engine.
async fn stream(req: &mut Req<State>) -> Response {
    let storage = Watching(Arc::clone(req.state()));
    let outcome = Multer::new(storage).single("file").run(req).await;
    report(req, outcome_text(&outcome));
    Response::new().json(&json!({ "outcome": outcome_text(&outcome) }))
}

async fn start(
    dir: &Path,
) -> (
    std::net::SocketAddr,
    CancellationToken,
    State,
    tokio::task::JoinHandle<std::io::Result<()>>,
) {
    let shared: State = Arc::new(Shared {
        dir: dir.to_owned(),
        ..Shared::default()
    });
    let mut root = Router::new();
    root.post("/disk", disk);
    root.post("/deadline", deadline);
    root.post("/stream", stream);
    let app = App::with_shared_state(root, Arc::new(Arc::clone(&shared))).expect("app");
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let token = CancellationToken::new();
    let server = tokio::spawn(serve(listener, app, token.clone(), ServeOptions::default()));
    (addr, token, shared, server)
}

/// The request head and the start of a file part; `length` is the whole body's declared size.
fn upload_head(path: &str, filename: &str, length: usize) -> Vec<u8> {
    let mut bytes = format!(
        "POST {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Type: multipart/form-data; boundary={BOUNDARY}\r\nContent-Length: {length}\r\n\r\n"
    )
    .into_bytes();
    bytes.extend_from_slice(part_head(filename).as_bytes());
    bytes
}

fn part_head(filename: &str) -> String {
    format!(
        "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: video/mp4\r\n\r\n"
    )
}

fn closing() -> String {
    format!("\r\n--{BOUNDARY}--\r\n")
}

async fn read_all(stream: &mut TcpStream) -> String {
    let mut raw = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(10), stream.read_to_end(&mut raw)).await;
    String::from_utf8_lossy(&raw).into_owned()
}

#[tokio::test]
async fn a_client_going_away_mid_file_leaves_no_partial_file() {
    let dir = TempDir::new("abort");
    let (addr, token, shared, server) = start(&dir.0).await;
    let (tx, _rx) = oneshot::channel();
    *shared.outcome.lock().unwrap() = Some(tx);
    let mut client = TcpStream::connect(addr).await.expect("connect");
    client
        .write_all(&upload_head("/disk", "clip 😀.mp4", 1_000_000))
        .await
        .expect("head");
    client.write_all(&[7u8; 4096]).await.expect("data");
    // The file is being written under the client's name, as multer reads it: the UTF-8 bytes of
    // the emoji as latin1 characters.
    let mut seen = Vec::new();
    for _ in 0..200 {
        seen = entries(&dir.0);
        if !seen.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(seen, ["clip \u{f0}\u{9f}\u{98}\u{80}.mp4"]);
    drop(client);
    assert_eq!(eventually_empty(&dir.0).await, Vec::<String>::new());
    token.cancel();
    server.await.expect("join").expect("serve");
}

#[tokio::test]
async fn the_deadline_ends_a_stalled_upload_and_removes_its_file() {
    let dir = TempDir::new("deadline");
    let (addr, token, shared, server) = start(&dir.0).await;
    let (tx, rx) = oneshot::channel();
    *shared.outcome.lock().unwrap() = Some(tx);
    let mut client = TcpStream::connect(addr).await.expect("connect");
    client
        .write_all(&upload_head("/deadline", "slow.mp4", 1_000_000))
        .await
        .expect("head");
    client.write_all(&[1u8; 1000]).await.expect("data");
    let outcome = tokio::time::timeout(Duration::from_secs(3), rx)
        .await
        .expect("deadline reported")
        .expect("outcome");
    assert_eq!(outcome, "error upload deadline passed");
    let response = read_all(&mut client).await;
    assert!(response.starts_with("HTTP/1.1 408"), "{response}");
    assert!(
        response.ends_with(r#"{"error":"upload_aborted"}"#),
        "{response}"
    );
    assert_eq!(eventually_empty(&dir.0).await, Vec::<String>::new());
    token.cancel();
    server.await.expect("join").expect("serve");
}

#[tokio::test]
async fn a_streaming_storage_sees_bytes_as_they_arrive() {
    let dir = TempDir::new("stream");
    let (addr, token, shared, server) = start(&dir.0).await;
    let (first_tx, first_rx) = oneshot::channel();
    *shared.first_chunk.lock().unwrap() = Some(first_tx);
    let rest = 300_000usize;
    let total = part_head("big.mp4").len() + 1000 + rest + closing().len();
    let mut client = TcpStream::connect(addr).await.expect("connect");
    client
        .write_all(&upload_head("/stream", "big.mp4", total))
        .await
        .expect("head");
    client.write_all(&[2u8; 1000]).await.expect("first bytes");
    // The storage has the first bytes while most of the file is still to be sent.
    let first = tokio::time::timeout(Duration::from_secs(2), first_rx)
        .await
        .expect("first chunk delivered before the upload finished")
        .expect("size");
    assert!(first > 0 && first <= 1000, "{first}");
    client.write_all(&vec![3u8; rest]).await.expect("rest");
    client.write_all(closing().as_bytes()).await.expect("close");
    let response = read_all(&mut client).await;
    assert!(
        response.ends_with(&format!(r#"{{"outcome":"ok big.mp4 {}"}}"#, 1000 + rest)),
        "{response}"
    );
    token.cancel();
    server.await.expect("join").expect("serve");
}

#[tokio::test]
async fn a_rejected_upload_is_answered_and_cleaned_up() {
    let dir = TempDir::new("rejected");
    let (addr, token, shared, server) = start(&dir.0).await;
    let (tx, rx) = oneshot::channel();
    *shared.outcome.lock().unwrap() = Some(tx);
    let size = 3 * 1024 * 1024;
    let total = part_head("huge 😀.mp4").len() + size + closing().len();
    let mut client = TcpStream::connect(addr).await.expect("connect");
    let (mut reader, mut writer) = client.split();
    let send = async {
        writer
            .write_all(&upload_head("/disk", "huge 😀.mp4", total))
            .await
            .expect("head");
        for _ in 0..(size / 65_536) {
            if writer.write_all(&[9u8; 65_536]).await.is_err() {
                return;
            }
        }
        let _ = writer.write_all(closing().as_bytes()).await;
    };
    let receive = async {
        let mut raw = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(10), reader.read_to_end(&mut raw)).await;
        String::from_utf8_lossy(&raw).into_owned()
    };
    let ((), response) = tokio::join!(send, receive);
    assert!(response.starts_with("HTTP/1.1 413"), "{response}");
    assert!(
        response.ends_with(r#"{"error":true,"code":"LIMIT_FILE_SIZE"}"#),
        "{response}"
    );
    assert_eq!(rx.await.expect("outcome"), "multer LIMIT_FILE_SIZE");
    assert_eq!(eventually_empty(&dir.0).await, Vec::<String>::new());
    token.cancel();
    server.await.expect("join").expect("serve");
}

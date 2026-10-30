//! Source-reference decoding for the decision oracle. No Mongo connection.
use dima_rust::utils::moderation::decisions::DecisionClock;
use dima_rust::utils::{bson_compat, js_string::JsString};
use mongodb::bson::{Bson, DateTime, Document};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::VecDeque, sync::Mutex};
#[path = "moderation_leaf_source.rs"]
mod moderation_leaf_source;

pub fn tagged_string(v: &Value) -> JsString {
    assert_eq!(v["kind"], "string");
    JsString::from_units(
        v["utf16"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| u16::try_from(x.as_u64().unwrap()).unwrap())
            .collect(),
    )
}
pub fn decode(v: &Value) -> Bson {
    match v["kind"].as_str().unwrap() {
        "null" => Bson::Null,
        "undefined" | "hole" => Bson::Undefined,
        "boolean" => Bson::Boolean(v["value"].as_bool().unwrap()),
        "number" => bson_compat::js_number(f64::from_bits(
            u64::from_str_radix(v["bits"].as_str().unwrap(), 16).unwrap(),
        )),
        "string" => Bson::String(tagged_string(v).to_utf8_lossy()),
        "date" => {
            let bits =
                u64::from_str_radix(v["milliseconds"]["bits"].as_str().unwrap(), 16).unwrap();
            Bson::DateTime(DateTime::from_millis(f64::from_bits(bits) as i64))
        }
        "array" => Bson::Array(v["items"].as_array().unwrap().iter().map(decode).collect()),
        "object" => {
            let mut doc = Document::new();
            for pair in v["entries"].as_array().unwrap() {
                let units = pair[0]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| u16::try_from(x.as_u64().unwrap()).unwrap())
                    .collect::<Vec<_>>();
                doc.insert(
                    JsString::from_units(units).to_utf8_lossy(),
                    decode(&pair[1]),
                );
            }
            Bson::Document(doc)
        }
        kind => panic!("unsupported source tag {kind}"),
    }
}
/// JSON.stringify drops undefined object properties and converts undefined array
/// elements to null. The source fixture retains the raw tagged own-property
/// evidence separately; this projection is used only for JSON-shape comparison.
pub fn stringify_projection(value: Bson) -> Bson {
    match value {
        Bson::Document(doc) => Bson::Document(
            doc.into_iter()
                .filter_map(|(k, v)| {
                    if matches!(v, Bson::Undefined) {
                        None
                    } else {
                        Some((k, stringify_projection(v)))
                    }
                })
                .collect(),
        ),
        Bson::Array(items) => Bson::Array(
            items
                .into_iter()
                .map(|v| {
                    if matches!(v, Bson::Undefined) {
                        Bson::Null
                    } else {
                        stringify_projection(v)
                    }
                })
                .collect(),
        ),
        value => value,
    }
}
pub fn member<'a>(v: &'a Value, name: &str) -> &'a Value {
    v["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|pair| {
            let units = pair[0]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u16)
                .collect::<Vec<_>>();
            JsString::from_units(units) == JsString::from(name)
        })
        .map(|pair| &pair[1])
        .unwrap_or_else(|| panic!("missing field {name}"))
}
pub struct FixtureClock {
    pub values: Mutex<VecDeque<i64>>,
    pub last: Mutex<i64>,
}
impl DecisionClock for FixtureClock {
    fn now_ms(&self) -> i64 {
        if let Some(value) = self.values.lock().unwrap().pop_front() {
            *self.last.lock().unwrap() = value;
        }
        *self.last.lock().unwrap()
    }
}
pub fn reference() -> Value {
    let path = std::env::var("DIMA_DECISIONS_REFERENCE").expect("independent source reference");
    let pin = std::env::var("DIMA_DECISIONS_REFERENCE_SHA256").expect("independent source digest");
    assert!(
        pin.len() == 64
            && pin
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), pin);
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["schema"], 1);
    assert_eq!(value["provenance"]["node"], "24.22.1");
    assert_eq!(value["provenance"]["v8"], "13.6.233.17-node.58");
    assert_eq!(value["provenance"]["typescript"], "5.9.3");
    assert_eq!(value["provenance"]["mongoose"], "8.24.2");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for (source, hash) in value["provenance"]["pins"].as_object().unwrap() {
        let relative = std::path::Path::new(source);
        assert!(
            relative
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_)))
        );
        let file = if source.starts_with("node_modules/") {
            let sdk = std::path::PathBuf::from(
                std::env::var("DIMA_DECISIONS_SDK_SOURCE_ROOT")
                    .expect("captured SDK source directory"),
            );
            assert!(
                sdk.is_absolute() && sdk.canonicalize().unwrap() == sdk && !sdk.starts_with(root)
            );
            sdk.join(relative)
        } else {
            moderation_leaf_source::path(root, source)
        };
        assert_eq!(
            format!("{:x}", Sha256::digest(std::fs::read(file).unwrap())),
            hash.as_str().unwrap(),
            "{source}"
        );
    }
    for (path, field) in [
        (
            "tests/fixtures/moderation_decisions_source.cjs",
            "loaderSha256",
        ),
        (
            "tests/fixtures/moderation_decisions_reference.cjs",
            "readerSha256",
        ),
    ] {
        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest(std::fs::read(root.join(path)).unwrap())
            ),
            value["provenance"][field].as_str().unwrap()
        );
    }
    assert_eq!(
        value["provenance"]["caseCount"].as_u64().unwrap() as usize,
        value["cases"].as_array().unwrap().len()
    );
    value
}

/// A bounded loopback proxy for a single task-owned Mongo server. It forwards
/// the selected update, reads the successful server reply, then drops that
/// reply and connection. The acknowledgement proves the write reached Mongo;
/// the independent readback proves durable state. All other commands pass.
pub struct LostReplyProxy {
    pub address: std::net::SocketAddr,
    pub updates: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    pub dropped: std::sync::Arc<std::sync::atomic::AtomicBool>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl LostReplyProxy {
    pub fn start(database: String, command: &'static str) -> Self {
        use std::io::{Cursor, Read, Write};
        use std::net::{Shutdown, TcpListener, TcpStream};
        use std::sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        };
        use std::time::Duration;
        assert!(database.starts_with("keyword_fixture_") && database.ends_with("_lost_reply"));
        assert!(matches!(command, "update" | "findAndModify"));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let updates = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let worker_updates = updates.clone();
        let worker_dropped = dropped.clone();
        fn packet(stream: &mut TcpStream) -> std::io::Result<Vec<u8>> {
            let mut header = [0_u8; 16];
            stream.read_exact(&mut header)?;
            let len = i32::from_le_bytes(header[..4].try_into().unwrap());
            if !(16..=16 * 1024 * 1024).contains(&len) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "invalid Mongo frame",
                ));
            }
            let mut out = vec![0; len as usize];
            out[..16].copy_from_slice(&header);
            stream.read_exact(&mut out[16..])?;
            Ok(out)
        }
        let thread = std::thread::spawn(move || {
            let mut workers = Vec::new();
            while !worker_stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut downstream, peer)) => {
                        assert!(peer.ip().is_loopback());
                        let mut upstream = TcpStream::connect("keyword-mongo:27017").unwrap();
                        downstream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        upstream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let db = database.clone();
                        let counts = worker_updates.clone();
                        let lost = worker_dropped.clone();
                        let closing = worker_stop.clone();
                        workers.push(std::thread::spawn(move || {
                            while !closing.load(Ordering::SeqCst) {
                                let request = match packet(&mut downstream) {
                                    Ok(p) => p,
                                    Err(_) => break,
                                };
                                let opcode =
                                    i32::from_le_bytes(request[12..16].try_into().unwrap());
                                let mut target = false;
                                if opcode == 2013 {
                                    assert!(request.len() >= 26 && request[20] == 0);
                                    let body =
                                        Document::from_reader(Cursor::new(&request[21..])).unwrap();
                                    let command_db = body.get_str("$db").unwrap();
                                    assert!(
                                        command_db == "admin" || command_db == db,
                                        "proxy rejected unowned database"
                                    );
                                    if command_db == db && body.contains_key(command) {
                                        assert_eq!(
                                            body.get_str(command).unwrap(),
                                            "moderation_decisions"
                                        );
                                        counts.fetch_add(1, Ordering::SeqCst);
                                        target = !lost.load(Ordering::SeqCst);
                                    }
                                } else {
                                    // Legacy OP_QUERY is only the initial admin handshake.
                                    assert_eq!(opcode, 2004);
                                    assert!(request[20..].starts_with(b"admin.$cmd\0"));
                                }
                                if upstream.write_all(&request).is_err() {
                                    break;
                                }
                                let response = match packet(&mut upstream) {
                                    Ok(p) => p,
                                    Err(_) => break,
                                };
                                if target {
                                    assert_eq!(
                                        i32::from_le_bytes(response[12..16].try_into().unwrap()),
                                        2013
                                    );
                                    assert_eq!(response[20], 0);
                                    let body = Document::from_reader(Cursor::new(&response[21..]))
                                        .unwrap();
                                    let ok = match body.get("ok") {
                                        Some(Bson::Double(n)) => *n == 1.0,
                                        Some(Bson::Int32(n)) => *n == 1,
                                        _ => false,
                                    };
                                    assert!(ok, "upstream did not acknowledge update: {body:?}");
                                    if command == "update" {
                                        assert_eq!(
                                            body.get_i32("nModified").unwrap(),
                                            1,
                                            "upstream did not modify exactly one row"
                                        );
                                    } else {
                                        assert_eq!(
                                            body.get_document("lastErrorObject")
                                                .unwrap()
                                                .get_i32("n")
                                                .unwrap(),
                                            1,
                                            "upstream did not acknowledge one upsert"
                                        );
                                        assert!(
                                            body.get_document("value").is_ok(),
                                            "upsert did not return a document"
                                        );
                                    }
                                    lost.store(true, Ordering::SeqCst);
                                    let _ = downstream.shutdown(Shutdown::Both);
                                    let _ = upstream.shutdown(Shutdown::Both);
                                    break;
                                }
                                if downstream.write_all(&response).is_err() {
                                    break;
                                }
                            }
                        }));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(e) => panic!("private proxy listener: {e}"),
                }
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
        Self {
            address,
            updates,
            dropped,
            stop,
            thread: Some(thread),
        }
    }
    pub fn shutdown(mut self) {
        use std::sync::atomic::Ordering;
        self.stop.store(true, Ordering::SeqCst);
        self.thread.take().unwrap().join().unwrap();
    }
}

/// Guard and clean only databases identified by this task's marker even after a
/// panic. The parent additionally owns the entire private fixture server.
pub fn owned_fixture() -> (String, String, String) {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").unwrap(),
        "dimabot-migration"
    );
    let uri = std::env::var("KEYWORD_FIXTURE_MONGO_URI").unwrap();
    assert_eq!(uri, "mongodb://keyword-mongo:27017");
    let namespace = std::env::var("KEYWORD_FIXTURE_NAMESPACE").unwrap();
    let id = namespace
        .strip_prefix("keyword-fixture-")
        .and_then(|s| s.strip_suffix(':'))
        .expect("fixture namespace");
    assert_eq!(id.len(), 12);
    assert!(
        id.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    (uri, namespace.clone(), format!("keyword_fixture_{id}"))
}
pub async fn guarded_cleanup<F>(suffix: &str, failpoints: bool, body: F)
where
    F: std::future::Future<Output = ()>,
{
    use futures_util::FutureExt;
    use mongodb::{
        Client,
        bson::{Document, doc},
    };
    use std::panic::AssertUnwindSafe;
    let (uri, namespace, base) = owned_fixture();
    assert!(matches!(
        suffix,
        "ready" | "failures" | "replay" | "crossing" | "lost_reply" | "worker_race"
    ));
    if failpoints {
        assert_eq!(
            std::env::var("DIMA_VARIATION_JOBS_FAILPOINT_OWNER").unwrap(),
            namespace
        );
    }
    let outcome = AssertUnwindSafe(body).catch_unwind().await;
    let client = Client::with_uri_str(uri)
        .await
        .expect("private cleanup client");
    if failpoints {
        client
            .database("admin")
            .run_command(doc! {"configureFailPoint":"failCommand", "mode":"off"})
            .await
            .expect("reset task-owned failpoint");
    }
    let db = client.database(&format!("{base}_{suffix}"));
    let collections = db
        .list_collection_names()
        .await
        .expect("inspect task-owned database");
    if collections.iter().any(|name| name == "_decision_owner") {
        let marker = db
            .collection::<Document>("_decision_owner")
            .find_one(doc! {"_id":"owner"})
            .await
            .expect("read ownership marker")
            .expect("missing ownership marker");
        assert_eq!(marker.get_str("owner").unwrap(), "dimabot-migration");
        assert_eq!(marker.get_str("namespace").unwrap(), namespace);
        db.drop().await.expect("drop owned task database");
    } else {
        assert!(
            collections.is_empty(),
            "refusing to drop an unowned database"
        );
    }
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}
impl Drop for LostReplyProxy {
    fn drop(&mut self) {
        use std::sync::atomic::Ordering;
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

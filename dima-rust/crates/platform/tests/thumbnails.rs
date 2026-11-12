// Tests use the fake ffmpeg (tests/fake-ffmpeg.sh, written into the test's own directory), a
// local S3 mock and a throwaway `dima_test_platform_<random>` database; the real ffmpeg is never
// run and nothing leaves the machine.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use anyhow::{Context, Result};
use bson::{Bson, Document, doc, oid::ObjectId};
use bytes::Bytes;
use dima_core::{ManualClock, Random, RandomError, SystemRandom};
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer, RecordedRequest};
use dima_model::media_assets::INFO;
use dima_platform::s3;
use dima_platform::thumbnails::{Config, Error, Outcome, Thumbnails};
use dima_store::mongo::{MongoConfig, MongoStore};
use futures_util::{FutureExt, TryStreamExt};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::os::unix::fs::PermissionsExt as _;
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const PUBLIC: &str = "https://cdn.test/examplebucket";

/// A mock answer, made afresh for each request.
type Route = Arc<dyn Fn() -> MockResponse + Send + Sync>;

fn reference() -> Result<Value> {
    Ok(serde_json::from_str(include_str!(
        "thumbnails-reference.json"
    ))?)
}

/// Fills every request with one byte, as the recorder's patched `crypto.randomBytes` did.
#[derive(Debug)]
struct Fixed(u8);
impl Random for Fixed {
    fn fill(&self, out: &mut [u8]) -> Result<(), RandomError> {
        out.fill(self.0);
        Ok(())
    }
}

async fn connect(db: &str) -> Result<Option<MongoStore>> {
    let uri = match std::env::var("DIMA_TEST_MONGO_URI") {
        Ok(u) => u,
        Err(e) => {
            if std::env::var("DIMA_TEST_REQUIRE_STORES").as_deref() == Ok("1") {
                return Err(e.into());
            }
            return Ok(None);
        }
    };
    let mut config = MongoConfig::new(uri);
    config.database = Some(db.into());
    Ok(Some(MongoStore::connect(&config, None).await?))
}

/// A rig: own database, own directory (fake ffmpeg, temporary directory, records), S3 mock.
struct Rig {
    store: MongoStore,
    base: PathBuf,
    server: MockServer,
    sources: Arc<Mutex<HashMap<String, Route>>>,
}

impl Rig {
    fn config(&self) -> Config {
        let mut c = Config::new(
            self.base.join("bin/ffmpeg"),
            self.base.join("tmp"),
            "examplebucket".into(),
        );
        c.timeout = Duration::from_secs(10);
        c.max_input_bytes = 1024 * 1024;
        c.max_thumbnail_bytes = 1024 * 1024;
        c.s3_timeout = Duration::from_secs(5);
        c.store_deadline = Duration::from_secs(5);
        c
    }
    fn s3(&self) -> Arc<s3::Client> {
        Arc::new(
            s3::Client::new(
                HttpClient::builder().build().unwrap(),
                s3::Config {
                    endpoint: self.server.url(),
                    region: "us-east-1".into(),
                    bucket: "examplebucket".into(),
                    access_key_id: "AKIDEXAMPLE".into(),
                    secret_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
                    addressing: s3::Addressing::Path,
                    public_url: PUBLIC.into(),
                },
                Arc::new(ManualClock::new(NOW)),
            )
            .unwrap(),
        )
    }
    fn thumbnails(&self, config: Config, random: Arc<dyn Random>) -> Thumbnails {
        Thumbnails::new(
            self.store.clone(),
            self.s3(),
            config,
            Arc::new(ManualClock::new(NOW)),
            random,
        )
        .unwrap()
    }
    fn source(&self, key: &str, response: impl Fn() -> MockResponse + Send + Sync + 'static) {
        self.route(format!("/examplebucket/{key}"), response);
    }
    fn route(&self, route: String, response: impl Fn() -> MockResponse + Send + Sync + 'static) {
        self.sources
            .lock()
            .unwrap()
            .insert(route, Arc::new(response));
    }
    fn rec(&self, name: &str) -> Option<Vec<u8>> {
        std::fs::read(self.base.join("rec").join(name)).ok()
    }
    fn clear_rec(&self) {
        let _ = std::fs::remove_dir_all(self.base.join("rec"));
        std::fs::create_dir(self.base.join("rec")).unwrap();
    }
    fn pid(&self, name: &str) -> i32 {
        String::from_utf8(self.rec(name).unwrap())
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }
    fn running(&self) -> usize {
        std::fs::read_dir(self.base.join("rec"))
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("running.")
            })
            .count()
    }
    fn temp_entries(&self) -> usize {
        std::fs::read_dir(self.base.join("tmp")).unwrap().count()
    }
    async fn wait_for(&self, name: &str) {
        for _ in 0..500 {
            if self.rec(name).is_some() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("fake never wrote {name}");
    }
    async fn documents(&self) -> Result<Vec<Document>> {
        Ok(self
            .store
            .documents(INFO.name)
            .find(doc! {})
            .sort(doc! {"_id": 1})
            .await?
            .try_collect()
            .await?)
    }
    async fn seed(&self, parent: &Document) -> Result<()> {
        self.store.documents(INFO.name).delete_many(doc! {}).await?;
        self.store
            .documents(INFO.name)
            .insert_one(parent.clone())
            .await?;
        Ok(())
    }
    fn s3_requests(&self) -> Vec<RecordedRequest> {
        self.server.requests()
    }
}

const NOW: i64 = 1794355200000;

async fn with_rig<F, Fut>(f: F) -> Result<()>
where
    F: FnOnce(Arc<Rig>) -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    let name = format!("dima_test_platform_{}", SystemRandom.hex_token(12)?);
    let Some(store) = connect(&name).await? else {
        return Ok(());
    };
    for i in INFO.indexes {
        store.documents(INFO.name).create_index(i.model()).await?;
    }
    let base = std::env::temp_dir().join(&name);
    std::fs::create_dir(&base)?;
    for dir in ["bin", "tmp", "rec"] {
        std::fs::create_dir(base.join(dir))?;
    }
    let fake = base.join("bin/ffmpeg");
    std::fs::write(&fake, include_str!("fake-ffmpeg.sh"))?;
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755))?;
    let server = MockServer::start().await?;
    // Exec the new fake once until the kernel stops reporting it busy (ETXTBSY: a thread of
    // another test forking while this one wrote the file can hold it open for an instant).
    for _ in 0..200 {
        match std::process::Command::new(&fake)
            .current_dir(base.join("bin"))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
        {
            Err(e) if e.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                std::thread::sleep(Duration::from_millis(5));
            }
            _ => break,
        }
    }
    let sources: Arc<Mutex<HashMap<String, Route>>> = Arc::default();
    let routes = sources.clone();
    server.fallback(move |request| {
        let path = request.path().to_owned();
        match request.method.as_str() {
            "GET" => match routes.lock().unwrap().get(&path) {
                Some(response) => response(),
                None => MockResponse::new(404).body("<Error><Code>NoSuchKey</Code></Error>"),
            },
            "PUT" => match routes.lock().unwrap().get(&format!("PUT {path}")) {
                Some(response) => response(),
                None => MockResponse::new(200),
            },
            "DELETE" => MockResponse::new(204),
            _ => MockResponse::new(400),
        }
    });
    let rig = Arc::new(Rig {
        store: store.clone(),
        base: base.clone(),
        server,
        sources,
    });
    let result = AssertUnwindSafe(f(rig)).catch_unwind().await;
    let _ = std::fs::set_permissions(base.join("tmp"), std::fs::Permissions::from_mode(0o755));
    let _ = std::fs::remove_dir_all(&base);
    store.database().drop().await?;
    match result {
        Ok(r) => r,
        Err(p) => std::panic::resume_unwind(p),
    }
}

/// `start` with ETXTBSY retried: another test thread forking while this one wrote its fake
/// can hold the file open for writing for an instant. Such a start changes nothing but the
/// attempt counter, so the test retries from a fresh seed.
async fn generate(rig: &Rig, t: &Thumbnails, parent: &Document) -> Result<Outcome, Error> {
    let id = parent.get_object_id("_id").unwrap();
    for _ in 0..100 {
        let outcome = t.generate_and_store(id).await;
        if let Ok(Outcome::Failed { message }) = &outcome
            && message.contains("Text file busy")
        {
            rig.seed(parent).await.unwrap();
            tokio::time::sleep(Duration::from_millis(10)).await;
            continue;
        }
        return outcome;
    }
    panic!("ffmpeg stayed busy");
}

fn ejson(docs: Vec<Document>) -> Value {
    Bson::Array(docs.into_iter().map(Bson::Document).collect()).into_canonical_extjson()
}

/// New ObjectIds (the thumbnail's) differ per run: replace those not in `known` everywhere.
fn normalise_ids(value: &mut Value, known: &BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(oid)) = map.get("$oid")
                && !known.contains(oid)
            {
                map.insert("$oid".into(), Value::String("<new>".into()));
            }
            for v in map.values_mut() {
                normalise_ids(v, known);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|v| normalise_ids(v, known)),
        _ => {}
    }
}

fn oids(value: &Value, out: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(oid)) = map.get("$oid") {
                out.insert(oid.clone());
            }
            map.values().for_each(|v| oids(v, out));
        }
        Value::Array(items) => items.iter().for_each(|v| oids(v, out)),
        _ => {}
    }
}

fn rust_args(video: bool) -> Vec<String> {
    let mut args = vec!["-y", "-protocol_whitelist", "file"];
    if video {
        args.extend(["-ss", "00:00:01"]);
    }
    args.extend(["-i", "file:in"]);
    if video {
        args.extend(["-vframes", "1"]);
    }
    args.extend(["-vf", "scale=480:-1", "-q:v", "5", "file:out.jpg"]);
    args.into_iter().map(str::to_owned).collect()
}

fn split_nul(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes)
        .split_terminator('\0')
        .map(str::to_owned)
        .collect()
}

#[tokio::test]
async fn recorded_reference_documents_uploads_and_arguments() -> Result<()> {
    let r = reference()?;
    assert_eq!(
        r["sha256"],
        dima_core::crypto::digest::sha256(include_str!(
            "../../../../dimabot/src/utils/thumbnail_generator.ts"
        ))
        .hex()
    );
    assert_eq!(r["publicUrl"], PUBLIC);
    assert_eq!(r["now"], NOW);
    with_rig(|rig| async move {
        let cases = r["cases"].as_array().context("cases")?;
        assert_eq!(cases.len(), 12);
        for case in cases {
            let name = case["name"].as_str().context("name")?;
            assert!(case["error"].is_null(), "{name}: the reference resolved");
            let byte = u8::try_from(case["byte"].as_u64().context("byte")?)?;
            let seed = case["seed"].as_array().context("seed")?;
            let parent_id = ObjectId::parse_str(case["parentID"].as_str().context("id")?)?;
            rig.store.documents(INFO.name).delete_many(doc! {}).await?;
            let mut parent_doc = None;
            for s in seed {
                let d: Document = bson::deserialize_from_bson(Bson::try_from(s.clone())?)?;
                rig.store.documents(INFO.name).insert_one(d.clone()).await?;
                parent_doc = Some(d);
            }
            if let Some(parent) = &parent_doc {
                let key = parent.get_str("s3Key")?;
                let status = u16::try_from(case["sourceStatus"].as_u64().context("status")?)?;
                let body = Bytes::from(case["source"].as_str().context("src")?.to_owned());
                rig.source(key, move || MockResponse::new(status).body(body.clone()));
            }
            rig.clear_rec();
            let before = rig.s3_requests().len();
            let t = rig.thumbnails(rig.config(), Arc::new(Fixed(byte)));
            let outcome = match &parent_doc {
                Some(parent) => generate(&rig, &t, parent).await?,
                None => t.generate_and_store(parent_id).await?,
            };

            // Documents, with the reference's known differences applied to its side.
            let mut expected = case["documents"].clone();
            let mut known = BTreeSet::new();
            oids(&case["seed"], &mut known);
            normalise_ids(&mut expected, &known);
            let rust_error = match name {
                "ffmpeg_fails" => Some(format!(
                    "Command failed: ffmpeg {}\nboom: invalid data found when processing input\n",
                    rust_args(true).join(" ")
                )),
                "no_output" => Some("ffmpeg produced an empty/invalid output".to_owned()),
                _ => None,
            };
            if let Some(message) = &rust_error {
                let stored = expected[0]["thumbnailLastError"].as_str().context("err")?;
                // The reference's text names its temporary paths; ours, the run's names.
                assert!(
                    stored.starts_with("Command failed: ffmpeg -y -ss 00:00:01 -i <tmp>/dima-in-")
                        || stored.starts_with(
                            "ENOENT: no such file or directory, stat '<tmp>/dima-out-"
                        ),
                    "{name}: {stored}"
                );
                expected[0]["thumbnailLastError"] = Value::String(message.clone());
            }
            let mut actual = ejson(rig.documents().await?);
            normalise_ids(&mut actual, &known);
            assert_eq!(
                serde_json::to_string_pretty(&actual)?,
                serde_json::to_string_pretty(&expected)?,
                "{name}: documents (types, key order, null versus missing)"
            );
            let thumb = actual
                .as_array()
                .context("docs")?
                .iter()
                .any(|d| d["scope"] == "system");
            match (name, &outcome) {
                ("audio", Outcome::Skipped)
                | ("already_ready", Outcome::AlreadyReady)
                | ("missing_parent", Outcome::NotFound) => {}
                (_, Outcome::Ready { .. }) => assert!(thumb, "{name}"),
                (_, Outcome::Failed { message }) => {
                    assert!(!thumb, "{name}");
                    assert_eq!(
                        Some(message.as_str()),
                        actual[0]["thumbnailLastError"].as_str()
                    );
                }
                other => panic!("{name}: {other:?}"),
            }

            // Requests: the source read (the reference fetched the same path without the SDK)
            // and the upload, every header the SDK sends that carries meaning, and the body.
            let requests = &rig.s3_requests()[before..];
            let recorded = case["requests"].as_array().context("requests")?;
            assert_eq!(requests.len(), recorded.len(), "{name}: requests");
            for (sent, want) in requests.iter().zip(recorded) {
                assert_eq!(sent.method, want["method"].as_str().context("m")?, "{name}");
                let want_target = want["target"].as_str().context("target")?;
                if sent.method == "GET" {
                    assert_eq!(sent.path(), want_target, "{name}");
                    continue;
                }
                assert_eq!(sent.target, want_target, "{name}");
                for (header, value) in want["headers"].as_object().context("headers")? {
                    assert_eq!(
                        sent.header(header),
                        value.as_str(),
                        "{name}: header {header}"
                    );
                }
                use base64::Engine as _;
                let body = base64::engine::general_purpose::STANDARD
                    .decode(want["body"].as_str().context("body")?)?;
                assert_eq!(sent.body, body, "{name}: upload body");
            }

            // Arguments: the reference's vector with its temporary paths is ours with the
            // protocol whitelist and the run directory's names.
            let calls = case["ffmpeg"].as_array().context("ffmpeg")?;
            match calls.as_slice() {
                [] => assert!(rig.rec("args").is_none(), "{name}: ffmpeg not run"),
                [call] => {
                    let video = parent_doc
                        .as_ref()
                        .is_some_and(|d| d.get_str("mediaType").ok() == Some("video"));
                    let ours = split_nul(&rig.rec("args").context("args")?);
                    assert_eq!(ours, rust_args(video), "{name}");
                    let theirs: Vec<String> = call
                        .as_array()
                        .context("call")?
                        .iter()
                        .map(|a| {
                            let a = a.as_str().unwrap_or_default();
                            if a.starts_with("<tmp>/dima-in-") {
                                "file:in".to_owned()
                            } else if a.starts_with("<tmp>/dima-out-") && a.ends_with(".jpg") {
                                "file:out.jpg".to_owned()
                            } else {
                                a.to_owned()
                            }
                        })
                        .collect();
                    let without_whitelist: Vec<String> = ours
                        .iter()
                        .enumerate()
                        .filter(|(i, _)| !(1..=2).contains(i))
                        .map(|(_, a)| a.clone())
                        .collect();
                    assert_eq!(without_whitelist, theirs, "{name}");
                    assert_eq!(
                        rig.rec("input").context("input")?,
                        case["source"].as_str().context("src")?.as_bytes(),
                        "{name}: ffmpeg read the source"
                    );
                    assert_eq!(rig.rec("env").context("env")?, b"", "{name}: empty env");
                    let cwd = String::from_utf8(rig.rec("cwd").context("cwd")?)?;
                    let cwd = std::path::Path::new(cwd.trim());
                    assert_eq!(
                        cwd.parent(),
                        Some(std::fs::canonicalize(rig.base.join("tmp"))?.as_path())
                    );
                    assert_eq!(
                        cwd.file_name().map(|n| n.to_string_lossy().into_owned()),
                        Some(format!("thumb-{}", format!("{byte:02x}").repeat(12)))
                    );
                }
                _ => panic!("{name}: one ffmpeg run at most"),
            }
            assert_eq!(rig.temp_entries(), 0, "{name}: run directory removed");
        }
        Ok(())
    })
    .await
}

fn parent(n: u8, media_type: &str) -> Document {
    let key = format!("533538623/triggers/x-{n}.bin");
    doc! {
        "_id": ObjectId::from_bytes([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, n]),
        "ownerUserID": "u", "ownerChannelID": "533538623", "ownerChannelName": "c",
        "uploadedByUserID": "u", "originalName": "o", "displayName": "d", "fileName": "f",
        "extension": "bin", "mimeType": "x/y", "mediaType": media_type, "bytes": 1_i32,
        "bucket": "examplebucket", "s3Key": key, "storageUrl": "https://cdn.test/x",
        "scope": "private", "thumbnailStatus": "pending", "thumbnailAttempts": 0_i32,
    }
}

async fn stored(rig: &Rig, id: ObjectId) -> Result<Document> {
    rig.store
        .documents(INFO.name)
        .find_one(doc! {"_id": id})
        .await?
        .context("parent")
}

/// Runs one generation whose source starts with `kind` and returns the outcome.
async fn run_kind(rig: &Rig, config: Config, kind: &str, n: u8) -> Result<Outcome> {
    let p = parent(n, "image");
    rig.seed(&p).await?;
    let kind = kind.to_owned();
    rig.source(p.get_str("s3Key")?, move || {
        MockResponse::new(200).body(kind.clone())
    });
    rig.clear_rec();
    let t = rig.thumbnails(config, Arc::new(SystemRandom));
    Ok(generate(rig, &t, &p).await?)
}

async fn assert_dead(pid: i32) {
    for _ in 0..500 {
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Err(_) => return,
            Ok(stat) => {
                let state = stat.rsplit_once(") ").map(|(_, rest)| rest.chars().next());
                if matches!(state, Some(Some('Z' | 'X'))) {
                    return;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("process {pid} is still alive");
}

#[tokio::test]
async fn invalid_outputs_fail_without_an_upload() -> Result<()> {
    with_rig(|rig| async move {
        for kind in ["NOTJ", "HUGE", "TINY", "NONE"] {
            let before = rig.s3_requests().len();
            let outcome = run_kind(&rig, rig.config(), kind, 1).await?;
            assert_eq!(
                outcome,
                Outcome::Failed {
                    message: "ffmpeg produced an empty/invalid output".into()
                },
                "{kind}"
            );
            let methods: Vec<String> = rig.s3_requests()[before..]
                .iter()
                .map(|r| r.method.clone())
                .collect();
            assert_eq!(methods, ["GET"], "{kind}: no upload");
            assert_eq!(rig.documents().await?.len(), 1);
            assert_eq!(rig.temp_entries(), 0);
        }
        Ok(())
    })
    .await
}

#[tokio::test]
async fn time_and_output_limits_kill_ffmpeg_and_record_the_reason() -> Result<()> {
    with_rig(|rig| async move {
        let mut config = rig.config();
        config.timeout = Duration::from_millis(500);
        let outcome = run_kind(&rig, config.clone(), "HANG", 1).await?;
        let Outcome::Failed { message } = outcome else {
            panic!("{outcome:?}")
        };
        assert_eq!(
            message,
            format!(
                "Command failed: ffmpeg {}\nprogram exceeded its time limit",
                rust_args(false).join(" ")
            )
        );
        assert_dead(rig.pid("pid")).await;
        let doc = stored(&rig, parent(1, "image").get_object_id("_id")?).await?;
        assert_eq!(doc.get_str("thumbnailStatus")?, "failed");
        assert_eq!(doc.get_str("thumbnailLastError")?, message);

        let outcome = run_kind(&rig, config.clone(), "FORK", 1).await?;
        assert!(matches!(&outcome, Outcome::Failed { message } if message.ends_with("time limit")));
        assert_dead(rig.pid("pid")).await;
        assert_dead(rig.pid("child")).await;

        let mut config = rig.config();
        config.max_output = 64 * 1024;
        let outcome = run_kind(&rig, config, "LOUD", 1).await?;
        assert!(
            matches!(&outcome, Outcome::Failed { message } if message.ends_with("program output exceeded its limit")),
            "{outcome:?}"
        );
        assert_dead(rig.pid("pid")).await;
        assert_eq!(rig.temp_entries(), 0);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn dropping_the_caller_kills_ffmpeg_and_removes_the_run_directory() -> Result<()> {
    with_rig(|rig| async move {
        let p = parent(1, "video");
        rig.seed(&p).await?;
        rig.source(p.get_str("s3Key")?, || MockResponse::new(200).body("FORK"));
        let t = rig.thumbnails(rig.config(), Arc::new(SystemRandom));
        let id = p.get_object_id("_id")?;
        let task = tokio::spawn(async move { t.generate_and_store(id).await });
        rig.wait_for("started").await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_dead(rig.pid("pid")).await;
        assert_dead(rig.pid("child")).await;
        assert_eq!(rig.temp_entries(), 0);
        let doc = stored(&rig, id).await?;
        assert_eq!(
            doc.get_str("thumbnailStatus")?,
            "pending",
            "left for a retry"
        );
        assert_eq!(rig.documents().await?.len(), 1, "no thumbnail document");
        Ok(())
    })
    .await
}

#[tokio::test]
async fn concurrency_is_two_and_the_queue_is_bounded() -> Result<()> {
    with_rig(|rig| async move {
        let mut config = rig.config();
        config.max_waiting = 1;
        let t = rig.thumbnails(config, Arc::new(SystemRandom));
        let mut tasks = Vec::new();
        rig.store.documents(INFO.name).delete_many(doc! {}).await?;
        for n in 1..=3 {
            let p = parent(n, "image");
            rig.store.documents(INFO.name).insert_one(p.clone()).await?;
            rig.source(p.get_str("s3Key")?, || MockResponse::new(200).body("HANG"));
            let t = t.clone();
            let id = p.get_object_id("_id")?;
            tasks.push(tokio::spawn(async move { t.generate_and_store(id).await }));
        }
        for _ in 0..500 {
            if rig.running() == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(rig.running(), 2, "two ffmpeg runs at once");
        let refused = t.generate_and_store(ObjectId::new()).await;
        assert!(matches!(refused, Err(Error::Busy)), "{refused:?}");
        for task in tasks {
            task.abort();
            let _ = task.await;
        }
        assert_eq!(rig.temp_entries(), 0);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn source_failures_are_recorded() -> Result<()> {
    with_rig(|rig| async move {
        let p = parent(1, "video");
        let key = p.get_str("s3Key")?.to_owned();
        let id = p.get_object_id("_id")?;
        let t = rig.thumbnails(rig.config(), Arc::new(SystemRandom));
        let cases: [(fn() -> MockResponse, String); 4] = [
            (
                || MockResponse::new(200).body(vec![b'x'; 2 * 1024 * 1024]),
                format!("Source too large for thumbnail ({} bytes)", 2 * 1024 * 1024),
            ),
            (
                || {
                    MockResponse::new(200).chunks(vec![
                        (Duration::ZERO, Bytes::from(vec![b'x'; 700 * 1024])),
                        (Duration::ZERO, Bytes::from(vec![b'x'; 700 * 1024])),
                    ])
                },
                format!(
                    "Source too large for thumbnail (over {} bytes)",
                    1024 * 1024
                ),
            ),
            (
                || MockResponse::new(403).body("<Error><Code>AccessDenied</Code></Error>"),
                "Failed to fetch source: HTTP 403".to_owned(),
            ),
            (
                || MockResponse::new(503).body("<Error><Code>SlowDown</Code></Error>"),
                "Failed to fetch source: HTTP 503".to_owned(),
            ),
        ];
        for (response, message) in cases {
            rig.seed(&p).await?;
            rig.source(&key, response);
            let outcome = t.generate_and_store(id).await?;
            assert_eq!(
                outcome,
                Outcome::Failed {
                    message: message.clone()
                }
            );
            assert_eq!(
                stored(&rig, id).await?.get_str("thumbnailLastError")?,
                message
            );
            assert_eq!(rig.temp_entries(), 0);
        }
        let mut other = p.clone();
        other.insert("bucket", "another");
        rig.seed(&other).await?;
        let outcome = t.generate_and_store(id).await?;
        assert_eq!(
            outcome,
            Outcome::Failed {
                message: "Source is not in the configured bucket".into()
            }
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn no_half_written_asset_when_a_later_step_fails() -> Result<()> {
    with_rig(|rig| async move {
        let p = parent(1, "image");
        let key = p.get_str("s3Key")?.to_owned();
        let id = p.get_object_id("_id")?;

        // The upload fails: nothing is created.
        rig.seed(&p).await?;
        rig.source(&key, || MockResponse::new(200).body("PNG"));
        let thumb_key = format!("library/thumbnails/{}.jpg", "5a".repeat(8));
        rig.route(format!("PUT /examplebucket/{thumb_key}"), || {
            MockResponse::new(500).body("<Error><Code>InternalError</Code></Error>")
        });
        let t = rig.thumbnails(rig.config(), Arc::new(Fixed(0x5a)));
        let outcome = generate(&rig, &t, &p).await?;
        assert_eq!(
            outcome,
            Outcome::Failed {
                message: "S3 service error (500)".into()
            }
        );
        assert_eq!(rig.documents().await?.len(), 1);

        // The document create fails (its s3Key is taken): the uploaded object is deleted.
        rig.seed(&p).await?;
        let mut taken = parent(2, "image");
        taken.insert("s3Key", thumb_key.clone());
        rig.store.documents(INFO.name).insert_one(taken).await?;
        rig.sources.lock().unwrap().clear();
        rig.source(&key, || MockResponse::new(200).body("PNG"));
        let before = rig.s3_requests().len();
        let outcome = generate(&rig, &t, &p).await?;
        assert!(
            matches!(&outcome, Outcome::Failed { message } if message.contains("E11000")),
            "{outcome:?}"
        );
        let sent: Vec<(String, String)> = rig.s3_requests()[before..]
            .iter()
            .map(|r| (r.method.clone(), r.path().to_owned()))
            .collect();
        assert_eq!(
            sent.last(),
            Some(&("DELETE".to_owned(), format!("/examplebucket/{thumb_key}")))
        );
        assert_eq!(rig.documents().await?.len(), 2, "only the two parents");

        // The parent is deleted while ffmpeg runs: the thumbnail is removed again.
        rig.seed(&p).await?;
        rig.source(&key, || {
            MockResponse::new(200)
                .body("PNG")
                .delay(Duration::from_millis(400))
        });
        let t2 = t.clone();
        let task = tokio::spawn(async move { t2.generate_and_store(id).await });
        tokio::time::sleep(Duration::from_millis(150)).await;
        rig.store
            .documents(INFO.name)
            .delete_one(doc! {"_id": id})
            .await?;
        let before = rig.s3_requests().len();
        let outcome = task.await??;
        assert_eq!(
            outcome,
            Outcome::Failed {
                message: "Parent asset no longer exists".into()
            }
        );
        assert!(rig.documents().await?.is_empty(), "no orphan thumbnail");
        assert!(
            rig.s3_requests()[before..]
                .iter()
                .any(|r| r.method == "DELETE" && r.path().ends_with(&thumb_key))
        );
        assert_eq!(rig.temp_entries(), 0);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn unwritable_temporary_directory_fails_cleanly() -> Result<()> {
    with_rig(|rig| async move {
        let p = parent(1, "image");
        rig.seed(&p).await?;
        let t = rig.thumbnails(rig.config(), Arc::new(SystemRandom));
        std::fs::set_permissions(rig.base.join("tmp"), std::fs::Permissions::from_mode(0o555))?;
        let outcome = t.generate_and_store(p.get_object_id("_id")?).await;
        std::fs::set_permissions(rig.base.join("tmp"), std::fs::Permissions::from_mode(0o755))?;
        assert!(
            matches!(&outcome, Ok(Outcome::Failed { message }) if message.contains("Permission denied")),
            "{outcome:?}"
        );
        assert!(rig.s3_requests().is_empty(), "nothing fetched");
        assert!(rig.rec("args").is_none(), "ffmpeg not run");
        Ok(())
    })
    .await
}

#[tokio::test]
async fn configuration_is_checked_at_startup() -> Result<()> {
    with_rig(|rig| async move {
        let refused = |c: Config| {
            matches!(
                Thumbnails::new(
                    rig.store.clone(),
                    rig.s3(),
                    c,
                    Arc::new(ManualClock::new(NOW)),
                    Arc::new(SystemRandom)
                ),
                Err(Error::Config(_))
            )
        };
        let mut c = rig.config();
        c.ffmpeg = PathBuf::from("ffmpeg");
        assert!(refused(c), "a PATH lookup is never made");
        let mut c = rig.config();
        c.ffmpeg = rig.base.join("bin/none");
        assert!(refused(c));
        let mut c = rig.config();
        c.temp_dir = rig.base.join("missing");
        assert!(refused(c));
        let mut c = rig.config();
        c.concurrency = 0;
        assert!(refused(c));
        let mut c = rig.config();
        c.max_waiting = usize::MAX;
        assert!(refused(c));
        Ok(())
    })
    .await
}

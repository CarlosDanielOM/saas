#![cfg(feature = "ai-usage-ledger-persistence")]
//! AUTHOR-ONLY DRAFT: execution and integration belong to the parent. Build
//! --no-run in the capped compiler; run the resulting static release ELF in
//! the separate capped Node runtime against fresh private fixture servers.
use dima_rust::utils::{
    ai_usage_ledger_persistence::{MongoAiUsageLedgerPersistence, PersistAiUsageReceiptOutcome},
    ai_usage_lock,
    ai_usage_producer::FixedReceiptClock,
    credit_policy::JsDate,
    lossless_json::{JsonValue, parse_json},
};
use futures_util::{FutureExt, TryStreamExt};
use mongodb::{
    Client, Database,
    bson::{Bson, Document, doc},
};
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    panic::AssertUnwindSafe,
    path::{Component, Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::Arc,
    time::Instant,
};

const OWNER: &str = "dimabot-migration";
const MONGO: &str = "mongodb://ai-usage-persistence-bench-mongo-fixture:27017";
const REDIS: &str = "redis://ai-usage-persistence-bench-redis-fixture:6379/";
const POLICY: &str = "/?directConnection=true&retryWrites=false&retryReads=false&maxPoolSize=10&minPoolSize=0&maxConnecting=2&connectTimeoutMS=5000&serverSelectionTimeoutMS=5000&w=1";
const MARKER: &str = "_persistence_bench_owner";
const COLLECTIONS: [(&str, &str); 4] = [
    ("daily", "ai_usage_dailies"),
    ("dashboard", "ai_usage_dashboards"),
    ("ledger_state", "ai_usage_ledger_states"),
    ("receipt", "ai_usage_receipts"),
];
fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn required(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("required explicit fixture setting {name}"))
}
fn external(path: &Path, repo: &Path) -> PathBuf {
    let path = path.canonicalize().unwrap();
    assert!(!path.starts_with(repo), "external artifact directory only");
    path
}
fn safe_relative(path: &str) {
    assert!(
        Path::new(path)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    );
    assert!(!path.is_empty() && !path.contains('\\'));
}
fn read_bound(directory: &Path, name: &str, expected: &str) -> Vec<u8> {
    let bytes = fs::read(directory.join(name)).unwrap();
    assert_eq!(
        hash(&bytes),
        expected,
        "independent digest mismatch: {name}"
    );
    bytes
}
fn verify_hashes(root: &Path, hashes: &Value) {
    assert!(!hashes.as_object().unwrap().is_empty());
    for (file, digest) in hashes.as_object().unwrap() {
        safe_relative(file);
        assert_eq!(
            digest,
            &json!(hash(fs::read(root.join(file)).unwrap())),
            "source/dependency drift {file}"
        );
    }
}
fn static_elf(bytes: &[u8]) {
    assert!(bytes.len() >= 64 && &bytes[..4] == b"\x7fELF");
    assert_eq!(bytes[4], 2, "64-bit ELF required");
    assert_eq!(bytes[5], 1, "little-endian ELF required");
    let u16_at = |offset| u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap());
    let phoff = u64::from_le_bytes(bytes[32..40].try_into().unwrap()) as usize;
    let phsize = usize::from(u16_at(54));
    let count = usize::from(u16_at(56));
    assert!(phsize >= 56 && count > 0);
    assert!(
        phoff
            .checked_add(phsize.checked_mul(count).unwrap())
            .unwrap()
            <= bytes.len()
    );
    for index in 0..count {
        let offset = phoff + index * phsize;
        let kind = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
        assert_ne!(kind, 3, "PT_INTERP found: use static-musl release test ELF");
    }
}
struct NodeActor {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    stopped: bool,
}
impl NodeActor {
    fn spawn(node: &Path, root: &Path, directory: &Path) -> Self {
        let mut command = Command::new(node);
        command.env_clear();
        // Do not inherit production credentials or bootstrap configuration.
        for name in [
            "DIMA_RUST_TEST_RESOURCE_OWNER",
            "DIMA_TEST_MONGO_URI",
            "DIMA_TEST_REDIS_URI",
            "DIMA_AI_PERSISTENCE_BENCH_TOKEN",
            "DIMA_AI_PERSISTENCE_BENCH_DATABASE",
            "DIMA_AI_PERSISTENCE_BENCH_NODE_SHA256",
            "DIMA_AI_PERSISTENCE_BENCH_INPUT_SHA256",
            "DIMA_AI_PERSISTENCE_BENCH_SOURCE_SHA256",
        ] {
            command.env(name, required(name));
        }
        let mut child = command
            .arg(root.join("tests/fixtures/ai_usage_persistence_e2e_benchmark.cjs"))
            .arg("--serve")
            .arg(directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            input,
            output,
            stopped: false,
        }
    }
    fn receive(&mut self) -> Value {
        let mut line = String::new();
        assert!(
            self.output.read_line(&mut line).unwrap() > 0,
            "Node IPC closed; never replay a helper call"
        );
        let result: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(result["ok"], true, "Node helper error: {result}");
        result
    }
    fn request(&mut self, request: Value) -> Value {
        writeln!(self.input, "{request}").unwrap();
        self.input.flush().unwrap();
        self.receive()
    }
    fn stop(&mut self) {
        if !self.stopped {
            let _ = self.child.kill();
            let _ = self.child.wait();
            self.stopped = true;
        }
    }
    fn wait(&mut self) {
        assert!(
            self.child.wait().unwrap().success(),
            "Node helper exited unsuccessfully"
        );
        self.stopped = true;
    }
}
impl Drop for NodeActor {
    fn drop(&mut self) {
        self.stop();
    }
}
// Sort comparison keys while preserving arrays and all BSON values/types.
// Only generated top-level document _ids are removed by canonical_document.
fn canonical(value: Bson) -> Bson {
    match value {
        Bson::Document(document) => {
            let mut fields: Vec<_> = document.into_iter().collect();
            fields.sort_by(|a, b| a.0.cmp(&b.0));
            Bson::Document(
                fields
                    .into_iter()
                    .map(|(name, value)| (name, canonical(value)))
                    .collect(),
            )
        }
        Bson::Array(values) => Bson::Array(values.into_iter().map(canonical).collect()),
        value => value,
    }
}
fn canonical_document(mut document: Document) -> String {
    assert!(
        document.remove("_id").is_some(),
        "real server-generated id expected"
    );
    let Bson::Document(document) = canonical(Bson::Document(document)) else {
        unreachable!()
    };
    document
        .to_vec()
        .unwrap()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn decode_document(hex: &str) -> Document {
    assert_eq!(hex.len() % 2, 0);
    let bytes: Vec<_> = (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
        .collect();
    Document::from_reader(&mut std::io::Cursor::new(bytes)).unwrap()
}
fn numeric(document: &Document, name: &str) -> f64 {
    match document.get(name).unwrap() {
        Bson::Double(number) => *number,
        Bson::Int32(number) => f64::from(*number),
        Bson::Int64(number) => *number as f64,
        value => panic!("expected numeric {name}: {value:?}"),
    }
}
async fn owned(database: &Database, token: &str, cache: &mut ConnectionManager, lease_key: &str) {
    assert_eq!(
        database.name(),
        format!("ai_usage_persistence_bench_{token}")
    );
    let marker = database
        .collection::<Document>(MARKER)
        .find_one(doc! {"_id":"owner"})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(marker.get_str("owner").unwrap(), OWNER);
    assert_eq!(marker.get_str("token").unwrap(), token);
    let value: Option<String> = redis::cmd("GET")
        .arg(format!("marker:ai-usage-persistence-bench:{token}"))
        .query_async(cache)
        .await
        .unwrap();
    let expected = format!("{OWNER}:{token}");
    assert_eq!(value.as_deref(), Some(expected.as_str()));
    let lease: Option<String> = redis::cmd("GET")
        .arg(lease_key)
        .query_async(cache)
        .await
        .unwrap();
    assert!(
        lease.is_none(),
        "owned account lease must be absent between actors"
    );
}
async fn readback(database: &Database) -> Value {
    let mut snapshot = serde_json::Map::new();
    for (key, collection) in COLLECTIONS {
        let documents: Vec<Document> = database
            .collection(collection)
            .find(doc! {})
            .await
            .unwrap()
            .try_collect()
            .await
            .unwrap();
        let mut wires: Vec<_> = documents.into_iter().map(canonical_document).collect();
        wires.sort();
        snapshot.insert(key.into(), json!(wires));
    }
    Value::Object(snapshot)
}
fn validate_snapshot(snapshot: &Value, inputs: &Value) -> Value {
    assert_eq!(snapshot.as_object().unwrap().len(), COLLECTIONS.len());
    let rows = |key: &str| {
        snapshot[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| decode_document(value.as_str().unwrap()))
            .collect::<Vec<_>>()
    };
    let receipts = rows("receipt");
    let daily = rows("daily");
    let dashboards = rows("dashboard");
    let states = rows("ledger_state");
    assert_eq!(receipts.len(), 32);
    assert_eq!(daily.len(), 8);
    assert_eq!(dashboards.len(), 1);
    assert_eq!(states.len(), 1);
    assert!(dashboards[0].get_bool("dirty").unwrap());
    let expected = inputs["receipts"].as_array().unwrap();
    let stamp = inputs["middlewareNow"].as_i64().unwrap();
    let channel = inputs["channelID"].as_str().unwrap();
    let customer = inputs["customerId"].as_str().unwrap();
    for (key, _) in COLLECTIONS {
        for document in rows(key) {
            assert!(!document.contains_key("_id"));
            assert_eq!(document.get_str("channelID").unwrap(), channel);
            assert_eq!(document.get_str("customerId").unwrap(), customer);
            let fields: &[&str] = match key {
                "daily" => &["dayStart", "expiresAt", "created_at", "updated_at"],
                "receipt" => &["occurredAt", "expiresAt", "created_at", "updated_at"],
                "ledger_state" => &["coverageStart", "backfilledAt", "created_at", "updated_at"],
                "dashboard" => &["refreshedAt", "expiresAt"],
                _ => unreachable!(),
            };
            for field in fields {
                assert!(
                    matches!(document.get(*field), Some(Bson::DateTime(_))),
                    "actual BSON Date required: {key}.{field}"
                );
            }
        }
    }
    for receipt in &receipts {
        let input = expected
            .iter()
            .find(|input| input["id"] == receipt.get_str("entryId").unwrap())
            .unwrap();
        assert_eq!(
            numeric(receipt, "credits"),
            input["credits"].as_f64().unwrap()
        );
        assert_eq!(
            receipt.get_str("retentionTier").unwrap(),
            inputs["tier"].as_str().unwrap()
        );
        assert_eq!(
            receipt
                .get_datetime("created_at")
                .unwrap()
                .timestamp_millis(),
            stamp
        );
        assert_eq!(
            receipt
                .get_datetime("updated_at")
                .unwrap()
                .timestamp_millis(),
            stamp
        );
    }
    let mut spent = 0.0;
    let mut count = 0.0;
    for row in &daily {
        let date = row.get_str("date").unwrap();
        let matching: Vec<_> = expected
            .iter()
            .filter(|input| input["occurredAt"].as_str().unwrap().starts_with(date))
            .collect();
        assert_eq!(matching.len(), 4);
        let sum: f64 = matching
            .iter()
            .map(|input| input["credits"].as_f64().unwrap())
            .sum();
        assert_eq!(numeric(row, "spentCredits"), sum);
        assert_eq!(numeric(row, "grantedCredits"), 0.0);
        assert_eq!(numeric(row, "netConsumedCredits"), sum);
        assert_eq!(numeric(row, "transactionCount"), 4.0);
        let categories = row.get_document("categories").unwrap();
        assert_eq!(categories.len(), 4);
        for input in matching {
            let entry = categories
                .get_document(input["category"].as_str().unwrap())
                .unwrap();
            assert_eq!(
                numeric(entry, "credits"),
                input["credits"].as_f64().unwrap()
            );
            assert_eq!(numeric(entry, "transactionCount"), 1.0);
        }
        assert_eq!(
            row.get_datetime("created_at").unwrap().timestamp_millis(),
            stamp
        );
        assert_eq!(
            row.get_datetime("updated_at").unwrap().timestamp_millis(),
            stamp
        );
        spent += sum;
        count += 4.0;
    }
    assert_eq!(
        spent,
        expected
            .iter()
            .map(|input| input["credits"].as_f64().unwrap())
            .sum::<f64>()
    );
    assert_eq!(count, 32.0);
    json!({"receipts":receipts.len(),"dailyDays":daily.len(),"spentCredits":spent,"transactions":count,"dirty":true,"leaseAbsent":true})
}
async fn native_trial(
    service: &MongoAiUsageLedgerPersistence,
    receipts: &[JsonValue],
    tier: &JsonValue,
) -> Value {
    // Retain outcomes; count/check only after stopping this actor's timer.
    let mut outcomes = Vec::with_capacity(receipts.len());
    let start = Instant::now();
    for receipt in receipts {
        outcomes.push(service.persist_value(receipt, tier).await.unwrap());
    }
    let elapsed_ns = start.elapsed().as_nanos();
    let mut inserted = 0;
    let mut duplicate = 0;
    let mut expired = 0;
    for outcome in &outcomes {
        match outcome {
            PersistAiUsageReceiptOutcome::Inserted => inserted += 1,
            PersistAiUsageReceiptOutcome::Duplicate => duplicate += 1,
            PersistAiUsageReceiptOutcome::Expired => expired += 1,
        }
    }
    json!({"elapsedNs":elapsed_ns.to_string(),"operations":outcomes.len(),"inserted":inserted,"duplicate":duplicate,"expired":expired})
}
fn check_outcomes(outcome: &Value, workload: &str) {
    assert_eq!(outcome["operations"], 32);
    assert_eq!(
        outcome["inserted"],
        if workload == "insert" { 32 } else { 0 }
    );
    assert_eq!(
        outcome["duplicate"],
        if workload == "duplicate-repair" {
            32
        } else {
            0
        }
    );
    assert_eq!(outcome["expired"], 0);
    assert!(
        outcome["elapsedNs"]
            .as_str()
            .unwrap()
            .parse::<u128>()
            .unwrap()
            > 0
    );
}
// Failure-only disposal after the Node child is killed and waited. Never
// replay writes or remove arbitrary Redis keys. Unknown/missing ownership
// refuses mutation; the parent's task-owned container cleanup remains needed.
async fn fallback_cleanup(
    database: &Database,
    token: &str,
    cache: &mut ConnectionManager,
    lease_key: &str,
) {
    let marker = database
        .collection::<Document>(MARKER)
        .find_one(doc! {"_id":"owner"})
        .await;
    if let Ok(Some(marker)) = marker {
        if marker.get_str("owner").ok() == Some(OWNER)
            && marker.get_str("token").ok() == Some(token)
            && database.name() == format!("ai_usage_persistence_bench_{token}")
        {
            let _ = database.drop().await;
        }
    }
    let redis_marker = format!("marker:ai-usage-persistence-bench:{token}");
    let expected = format!("{OWNER}:{token}");
    let actual: redis::RedisResult<Option<String>> = redis::cmd("GET")
        .arg(&redis_marker)
        .query_async(cache)
        .await;
    if matches!(actual, Ok(Some(ref actual)) if actual == &expected) {
        let _: redis::RedisResult<i64> = redis::cmd("EVAL")
            .arg("if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[2]); return redis.call('DEL', KEYS[1]) end return 0")
            .arg(2).arg(&redis_marker).arg(lease_key).arg(&expected).query_async(cache).await;
    }
}
fn write_sample(log: &mut File, sample: &Value) {
    writeln!(log, "{sample}").unwrap();
    log.flush().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "manual release benchmark: capped compiler/runtime and fresh private Mongo/Redis fixtures required"]
async fn real_persistence_helpers_matched_trials() {
    assert!(!cfg!(debug_assertions), "release-only benchmark");
    assert_eq!(required("DIMA_RUST_TEST_RESOURCE_OWNER"), OWNER);
    assert_eq!(required("DIMA_TEST_MONGO_URI"), MONGO);
    assert_eq!(required("DIMA_TEST_REDIS_URI"), REDIS);
    let token = required("DIMA_AI_PERSISTENCE_BENCH_TOKEN");
    assert!(
        (8..=32).contains(&token.len())
            && token
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    );
    let name = format!("ai_usage_persistence_bench_{token}");
    assert_eq!(required("DIMA_AI_PERSISTENCE_BENCH_DATABASE"), name);
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    let repo = root.parent().unwrap();
    let directory = external(Path::new(&required("DIMA_AI_PERSISTENCE_BENCH_DIR")), repo);
    let input_hash = required("DIMA_AI_PERSISTENCE_BENCH_INPUT_SHA256");
    let source_hash = required("DIMA_AI_PERSISTENCE_BENCH_SOURCE_SHA256");
    let input_bytes = read_bound(&directory, "inputs.json", &input_hash);
    let source_bytes = read_bound(&directory, "source.json", &source_hash);
    let inputs: Value = serde_json::from_slice(&input_bytes).unwrap();
    let metadata: Value = serde_json::from_slice(&source_bytes).unwrap();
    assert_eq!(inputs["token"], token);
    assert_eq!(inputs["format"], 1);
    assert_eq!(inputs["trials"], 7);
    assert_eq!(inputs["warmupBatches"], 2);
    assert_eq!(inputs["workloads"], json!(["insert", "duplicate-repair"]));
    assert_eq!(inputs["receipts"].as_array().unwrap().len(), 32);
    assert_eq!(metadata["inputSha256"], input_hash);
    assert_eq!(metadata["mongoPolicy"], POLICY);
    assert_eq!(metadata["mongoBase"], MONGO);
    assert_eq!(metadata["redisBase"], REDIS);
    assert_eq!(metadata["typeDiagnostics"], json!([]));
    verify_hashes(&root, &metadata["sourceHashes"]);
    verify_hashes(&root, &metadata["nativeHashes"]);
    verify_hashes(&root, &metadata["dependencies"]);
    assert_eq!(
        metadata["nativeSourceManifestSha256"],
        hash(serde_json::to_vec(&metadata["nativeHashes"]).unwrap())
    );
    for declaration in metadata["declarations"].as_array().unwrap() {
        let file = declaration["file"].as_str().unwrap();
        safe_relative(file);
        let source = fs::read(root.join(file)).unwrap();
        let start = declaration["startByte"].as_u64().unwrap() as usize;
        let end = declaration["endByte"].as_u64().unwrap() as usize;
        let mut text = source[start..end].to_vec();
        text.push(b'\n');
        assert_eq!(declaration["sha256"], hash(&text));
        assert_eq!(declaration["text"], String::from_utf8(text).unwrap());
    }
    let node = PathBuf::from(required("DIMA_AI_PERSISTENCE_BENCH_NODE"));
    assert!(node.is_absolute());
    let node_hash = hash(fs::read(&node).unwrap());
    assert_eq!(node_hash, required("DIMA_AI_PERSISTENCE_BENCH_NODE_SHA256"));
    assert_eq!(metadata["nodeExecutableSha256"], node_hash);
    let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
    let executable_bytes = fs::read(&executable).unwrap();
    static_elf(&executable_bytes);
    let executable_hash = hash(&executable_bytes);
    assert_eq!(
        executable_hash,
        required("DIMA_AI_PERSISTENCE_BENCH_NATIVE_SHA256")
    );
    let receipts: Vec<_> = inputs["receipts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|receipt| parse_json(&receipt.to_string()).unwrap())
        .collect();
    let tier = JsonValue::String(inputs["tier"].as_str().unwrap().into());
    let prepared_hash = hash(serde_json::to_vec(&inputs["receipts"]).unwrap());
    let channel = inputs["channelID"].as_str().unwrap();
    let customer = inputs["customerId"].as_str().unwrap();
    assert_eq!(channel, format!("persistence_bench_{token}"));
    assert_eq!(customer, format!("customer_{token}"));
    let lease_key = ai_usage_lock::account_key(&channel.into(), &customer.into());
    assert_eq!(metadata["leaseKey"], lease_key);
    let mut log = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join("samples.ndjson"))
        .unwrap();
    assert!(
        !directory.join("report.json").exists(),
        "exclusive report path required"
    );

    // Explicit clients, shared pools/socket, same matched URI policies; no
    // dotenv/default app clients and no per-operation connection/parse cost.
    let client = Client::with_uri_str(format!("{MONGO}{POLICY}"))
        .await
        .unwrap();
    let database = client.database(&name);
    let config = ConnectionManagerConfig::new().set_response_timeout(None);
    let mut cache = redis::Client::open(REDIS)
        .unwrap()
        .get_connection_manager_with_config(config)
        .await
        .unwrap();
    client
        .database("admin")
        .run_command(doc! {"ping":1})
        .await
        .unwrap();
    let _: String = redis::cmd("PING").query_async(&mut cache).await.unwrap();
    let service = MongoAiUsageLedgerPersistence::with_clocks(
        &database,
        cache.clone(),
        Arc::new(FixedReceiptClock(JsDate::from_millis(
            inputs["now"].as_i64().unwrap() as f64,
        ))),
        Arc::new(FixedReceiptClock(JsDate::from_millis(
            inputs["middlewareNow"].as_i64().unwrap() as f64,
        ))),
    );
    let mut node_actor = NodeActor::spawn(&node, &root, &directory);
    let outcome = AssertUnwindSafe(async {
        let ready = node_actor.receive(); assert_eq!(ready["op"], "ready");
        assert_eq!(ready["database"], name); assert_eq!(ready["leaseKey"], lease_key);
        assert_eq!(ready["inputSha256"], input_hash); assert_eq!(ready["nodeExecutableSha256"], node_hash);
        owned(&database, &token, &mut cache, &lease_key).await;
        let mut warmups = Vec::new(); let mut samples = Vec::new();
        for workload in ["insert", "duplicate-repair"] {
            // Both complete helper paths and both clients are warm before
            // measured pairs; each batch starts from the same owned seed state.
            for batch in 0..2 {
                for actor in if batch % 2 == 0 { ["node", "rust"] } else { ["rust", "node"] } {
                    node_actor.request(json!({"op":"reset","workload":workload,"actor":actor}));
                    owned(&database, &token, &mut cache, &lease_key).await;
                    let result = if actor == "node" { node_actor.request(json!({"op":"trial"})) }
                        else { native_trial(&service, &receipts, &tier).await };
                    check_outcomes(&result, workload);
                    owned(&database, &token, &mut cache, &lease_key).await;
                    let snapshot = if actor == "node" { node_actor.request(json!({"op":"readback"}))["snapshot"].clone() }
                        else { readback(&database).await };
                    let validation = validate_snapshot(&snapshot, &inputs);
                    warmups.push(json!({"workload":workload,"batch":batch,"actor":actor,"result":result,"validation":validation}));
                }
            }
            for trial in 0..7 {
                let mut pair = Vec::new();
                for actor in if trial % 2 == 0 { ["node", "rust"] } else { ["rust", "node"] } {
                    let reset = node_actor.request(json!({"op":"reset","workload":workload,"actor":actor}));
                    owned(&database, &token, &mut cache, &lease_key).await;
                    let result = if actor == "node" { node_actor.request(json!({"op":"trial"})) }
                        else { native_trial(&service, &receipts, &tier).await };
                    check_outcomes(&result, workload);
                    owned(&database, &token, &mut cache, &lease_key).await;
                    let snapshot = if actor == "node" { node_actor.request(json!({"op":"readback"}))["snapshot"].clone() }
                        else { readback(&database).await };
                    let validation = validate_snapshot(&snapshot, &inputs);
                    let sample = json!({"workload":workload,"trial":trial,"actor":actor,"generation":reset["generation"],
                        "elapsedNs":result["elapsedNs"],"operations":result["operations"],"inserted":result["inserted"],
                        "duplicate":result["duplicate"],"expired":result["expired"],"snapshotSha256":hash(serde_json::to_vec(&snapshot).unwrap()),
                        "snapshot":snapshot,"validation":validation});
                    write_sample(&mut log, &sample); samples.push(sample.clone()); pair.push(sample);
                }
                assert_eq!(pair[0]["snapshot"], pair[1]["snapshot"], "all BSON fields/types after id-only normalization: {workload}/{trial}");
            }
        }
        verify_hashes(&root, &metadata["sourceHashes"]); verify_hashes(&root, &metadata["nativeHashes"]);
        assert_eq!(hash(fs::read(directory.join("inputs.json")).unwrap()), input_hash);
        assert_eq!(hash(fs::read(directory.join("source.json")).unwrap()), source_hash);
        assert_eq!(hash(serde_json::to_vec(&inputs["receipts"]).unwrap()), prepared_hash);
        // Native owned receipts also stay unchanged while helper calls borrow them.
        let receipts_after: Vec<_> = receipts.iter().map(JsonValue::to_json_string).collect();
        let receipts_before: Vec<_> = inputs["receipts"].as_array().unwrap().iter().map(|receipt| parse_json(&receipt.to_string()).unwrap().to_json_string()).collect();
        assert_eq!(receipts_after, receipts_before);
        let finish = node_actor.request(json!({"op":"finish"})); node_actor.wait();
        assert_eq!(finish["cleanup"]["databaseDropped"], true); assert_eq!(finish["cleanup"]["redisMarkerDeleted"], true);
        verify_hashes(&root, &finish["loadedDependencies"]);
        assert_eq!(finish["preparedSha256"], ready["preparedSha256"]);
        assert!(database.list_collection_names().await.unwrap().is_empty());
        let size: i64 = redis::cmd("DBSIZE").query_async(&mut cache).await.unwrap(); assert_eq!(size, 0);
        json!({"format":1,"status":"complete","scope":metadata["scope"],"excluded":metadata["excluded"],
            "inputSha256":input_hash,"sourceSha256":source_hash,"nodeExecutableSha256":node_hash,
            "nativeExecutableSha256":executable_hash,"nativeExecutablePath":executable,
            "nativeSourceManifestSha256":metadata["nativeSourceManifestSha256"],
            "nativeRuntime":{"arch":std::env::consts::ARCH,"os":std::env::consts::OS,"staticElfWithoutInterpreter":true,
                "debugAssertions":cfg!(debug_assertions),"feature":"ai-usage-ledger-persistence","tokioWorkerThreads":2},
            "sourceMetadata":metadata,"nodeReady":ready,"nodeFinish":finish,"cleanup":finish["cleanup"],
            "nativePreparedSha256":prepared_hash,"sampleLogSha256":hash(fs::read(directory.join("samples.ndjson")).unwrap()),
            "warmups":warmups,"samples":samples})
    }).catch_unwind().await;
    match outcome {
        Ok(report) => {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(directory.join("report.json"))
                .unwrap();
            writeln!(file, "{report}").unwrap();
            file.sync_all().unwrap();
        }
        Err(panic) => {
            node_actor.stop();
            fallback_cleanup(&database, &token, &mut cache, &lease_key).await;
            std::panic::resume_unwind(panic);
        }
    }
}

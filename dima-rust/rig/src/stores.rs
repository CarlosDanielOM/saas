//! The stores of one side: a MongoDB database and a Dragonfly logical database.
//!
//! Dragonfly logical databases are claimed with a file lock per index, so several rig runs on one
//! machine never share one. MongoDB databases are named `rig_<pid>_<n>_<side>` and dropped at the
//! end (`dima-rig gc` drops those left behind by a rig process that is gone).

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions, TryLockError};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use bson::{Bson, Document, doc};
use futures_util::TryStreamExt;
use mongodb::Client;
use mongodb::options::ClientOptions;
use redis::aio::MultiplexedConnection;

use crate::canon::fnv1a64;
use crate::capture::{RawColl, RawEntry, RawReply, RawValue};
use crate::error::{Result, RigError, config, store};
use crate::path::name_glob;
use crate::scenario::{self, ExtMode, Scenario, Selection};

/// Most documents per collection a capture reads.
pub const MAX_DOCS: i64 = 20_000;
/// Most keys a capture reads.
pub const MAX_KEYS: usize = 50_000;
const STORE_TIMEOUT: Duration = Duration::from_secs(20);

static SEQ: AtomicU32 = AtomicU32::new(0);

#[derive(Debug, Clone)]
pub struct StoreConfig {
    /// Root MongoDB URI (no database in the path).
    pub mongo_uri: String,
    pub dragonfly_host: String,
    pub dragonfly_port: u16,
    /// Logical databases the rig may use (never 0).
    pub dragonfly_dbs: Vec<u8>,
    pub lock_dir: PathBuf,
    /// How long to wait for a free logical database.
    pub lock_wait: Duration,
}

/// The URI with `db` as its path (credentials and options kept).
pub fn uri_with_db(uri: &str, db: &str) -> String {
    let (scheme, rest) = uri.split_once("://").unwrap_or(("mongodb", uri));
    let (hosts, tail) = match rest.find(['/', '?']) {
        Some(i) => rest.split_at(i),
        None => (rest, ""),
    };
    let query = tail.find('?').and_then(|i| tail.get(i..)).unwrap_or("");
    format!("{scheme}://{hosts}/{db}{query}")
}

async fn timed<T, E: std::fmt::Display>(
    what: &str,
    f: impl std::future::IntoFuture<Output = std::result::Result<T, E>>,
) -> Result<T> {
    match tokio::time::timeout(STORE_TIMEOUT, f.into_future()).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(store(what, e)),
        Err(_) => Err(store(what, "timed out")),
    }
}

pub async fn mongo_client(uri: &str) -> Result<Client> {
    let mut opts = timed("MongoDB URI", ClientOptions::parse(uri)).await?;
    opts.app_name = Some("dima-rig".into());
    opts.server_selection_timeout = Some(Duration::from_secs(5));
    Client::with_options(opts).map_err(|e| store("MongoDB client", e))
}

async fn lock_index(cfg: &StoreConfig) -> Result<(u8, File)> {
    std::fs::create_dir_all(&cfg.lock_dir)
        .map_err(|e| crate::error::io(&cfg.lock_dir.display().to_string(), e))?;
    let deadline = tokio::time::Instant::now() + cfg.lock_wait;
    loop {
        for idx in &cfg.dragonfly_dbs {
            let path = cfg.lock_dir.join(format!(
                "dragonfly-{}-{}-db{idx}.lock",
                cfg.dragonfly_host.replace(['/', ':'], "_"),
                cfg.dragonfly_port
            ));
            let f = OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(&path)
                .map_err(|e| crate::error::io(&path.display().to_string(), e))?;
            match f.try_lock() {
                Ok(()) => return Ok((*idx, f)),
                Err(TryLockError::WouldBlock) => {}
                Err(TryLockError::Error(e)) => {
                    return Err(crate::error::io(&path.display().to_string(), e));
                }
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(store(
                "Dragonfly",
                format!(
                    "every allowed logical database ({:?}) is held by another rig run; try again later",
                    cfg.dragonfly_dbs
                ),
            ));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// A snapshot of the stores right after a process started, restored between scenarios.
#[derive(Debug, Clone, Default)]
pub struct Baseline {
    colls: Vec<(String, RawColl)>,
    keys: Vec<(Vec<u8>, Vec<u8>, i64)>,
}

pub struct SideStores {
    pub cfg: StoreConfig,
    pub client: Client,
    pub db_name: String,
    /// The rig created this database and drops it.
    owned: bool,
    pub df_index: u8,
    pub redis: MultiplexedConnection,
    _lock: File,
}

fn redis_err(e: redis::RedisError) -> RigError {
    store("Dragonfly", e)
}

fn to_raw_reply(v: redis::Value) -> RawReply {
    use redis::Value as V;
    match v {
        V::Nil => RawReply::Nil,
        V::Int(i) => RawReply::Int(i),
        V::BulkString(b) => RawReply::Bulk(b),
        V::Array(a) | V::Set(a) => RawReply::Array(a.into_iter().map(to_raw_reply).collect()),
        V::SimpleString(s) => RawReply::Status(s),
        V::Okay => RawReply::Status("OK".into()),
        V::Map(m) => RawReply::Map(
            m.into_iter()
                .map(|(k, v)| (to_raw_reply(k), to_raw_reply(v)))
                .collect(),
        ),
        V::Attribute { data, .. } => to_raw_reply(*data),
        V::Double(f) => RawReply::Double(f),
        V::Boolean(b) => RawReply::Bool(b),
        V::VerbatimString { text, .. } => RawReply::Bulk(text.into_bytes()),
        V::BigNumber(n) => RawReply::Bulk(format!("{n:?}").into_bytes()),
        V::Push { data, .. } => RawReply::Array(data.into_iter().map(to_raw_reply).collect()),
        V::ServerError(e) => RawReply::Error(
            format!("{} {}", e.code(), e.details().unwrap_or(""))
                .trim()
                .to_string(),
        ),
        other => RawReply::Bulk(format!("{other:?}").into_bytes()),
    }
}

fn bulk_list(v: redis::Value) -> Vec<Vec<u8>> {
    match v {
        redis::Value::Array(a) | redis::Value::Set(a) => a
            .into_iter()
            .filter_map(|x| match x {
                redis::Value::BulkString(b) => Some(b),
                redis::Value::SimpleString(s) => Some(s.into_bytes()),
                redis::Value::Int(i) => Some(i.to_string().into_bytes()),
                redis::Value::Double(f) => Some(f.to_string().into_bytes()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn first_batch(reply: &Document) -> Vec<Document> {
    reply
        .get_document("cursor")
        .ok()
        .and_then(|c| c.get_array("firstBatch").ok())
        .map(|a| a.iter().filter_map(|b| b.as_document().cloned()).collect())
        .unwrap_or_default()
}

impl SideStores {
    /// Claim a logical database and name a fresh MongoDB database (or use `existing_db`, which
    /// the rig never drops or writes).
    pub async fn allocate(
        cfg: &StoreConfig,
        label: &str,
        existing_db: Option<&str>,
    ) -> Result<SideStores> {
        let (df_index, lock) = lock_index(cfg).await?;
        let client = mongo_client(&cfg.mongo_uri).await?;
        let (db_name, owned) = match existing_db {
            Some(db) => (db.to_string(), false),
            None => (
                format!(
                    "rig_{}_{}_{label}",
                    std::process::id(),
                    SEQ.fetch_add(1, Ordering::Relaxed)
                ),
                true,
            ),
        };
        let url = format!(
            "redis://{}:{}/{df_index}",
            cfg.dragonfly_host, cfg.dragonfly_port
        );
        let rc = redis::Client::open(url).map_err(redis_err)?;
        let redis = timed("Dragonfly connect", rc.get_multiplexed_async_connection()).await?;
        let mut s = SideStores {
            cfg: cfg.clone(),
            client,
            db_name,
            owned,
            df_index,
            redis,
            _lock: lock,
        };
        s.reset_empty().await?;
        Ok(s)
    }

    pub fn mongo_uri(&self) -> String {
        uri_with_db(&self.cfg.mongo_uri, &self.db_name)
    }

    pub fn dragonfly_url(&self) -> String {
        format!(
            "redis://{}:{}/{}",
            self.cfg.dragonfly_host, self.cfg.dragonfly_port, self.df_index
        )
    }

    fn db(&self) -> mongodb::Database {
        self.client.database(&self.db_name)
    }

    async fn flushdb(&mut self) -> Result<()> {
        timed(
            "Dragonfly FLUSHDB",
            redis::cmd("FLUSHDB").query_async::<()>(&mut self.redis),
        )
        .await
    }

    /// Empty both stores (the MongoDB database only when the rig owns it).
    pub async fn reset_empty(&mut self) -> Result<()> {
        if self.owned {
            timed("MongoDB drop", self.db().drop()).await?;
        }
        self.flushdb().await
    }

    /// Drop what the rig created and empty the logical database.
    pub async fn cleanup(&mut self, keep: bool) -> Result<()> {
        if keep {
            return Ok(());
        }
        let r = if self.owned {
            timed("MongoDB drop", self.db().drop()).await
        } else {
            Ok(())
        };
        let f = self.flushdb().await;
        r.and(f)
    }

    async fn collections(&self) -> Result<Vec<Document>> {
        let reply = timed(
            "MongoDB listCollections",
            self.db()
                .run_command(doc! {"listCollections": 1, "cursor": {"batchSize": 100_000}}),
        )
        .await?;
        let mut out: Vec<Document> = first_batch(&reply)
            .into_iter()
            .filter(|c| {
                !c.get_str("name")
                    .unwrap_or("system.")
                    .starts_with("system.")
            })
            .collect();
        out.sort_by(|a, b| {
            a.get_str("name")
                .unwrap_or("")
                .cmp(b.get_str("name").unwrap_or(""))
        });
        Ok(out)
    }

    async fn indexes(&self, coll: &str) -> Result<Vec<Document>> {
        let reply = self
            .db()
            .run_command(doc! {"listIndexes": coll, "cursor": {"batchSize": 100_000}})
            .await;
        match reply {
            Ok(r) => Ok(first_batch(&r)),
            // Views have no indexes.
            Err(_) => Ok(Vec::new()),
        }
    }

    async fn read_coll(&self, spec: &Document) -> Result<(String, RawColl)> {
        let name = spec.get_str("name").unwrap_or("").to_string();
        let kind = spec.get_str("type").unwrap_or("collection").to_string();
        let options = spec.get_document("options").cloned().unwrap_or_default();
        let indexes = self.indexes(&name).await?;
        let coll = self.db().collection::<Document>(&name);
        let cursor = timed("MongoDB find", coll.find(doc! {}).limit(MAX_DOCS + 1)).await?;
        let docs: Vec<Document> = timed("MongoDB read", cursor.try_collect()).await?;
        if i64::try_from(docs.len()).unwrap_or(i64::MAX) > MAX_DOCS {
            return Err(config(format!(
                "collection {name} has more than {MAX_DOCS} documents; narrow compare.mongo"
            )));
        }
        Ok((
            name,
            RawColl {
                kind,
                options,
                indexes,
                docs,
            },
        ))
    }

    pub async fn capture_mongo(&self, sel: &Selection) -> Result<BTreeMap<String, RawColl>> {
        let mut out = BTreeMap::new();
        for spec in self.collections().await? {
            let name = spec.get_str("name").unwrap_or("");
            if !sel.includes(name) {
                continue;
            }
            let (n, c) = self.read_coll(&spec).await?;
            out.insert(n, c);
        }
        Ok(out)
    }

    async fn keys(&mut self) -> Result<Vec<Vec<u8>>> {
        let mut out = Vec::new();
        let mut cursor: u64 = 0;
        loop {
            let (next, batch): (u64, Vec<Vec<u8>>) = timed(
                "Dragonfly SCAN",
                redis::cmd("SCAN")
                    .arg(cursor)
                    .arg("COUNT")
                    .arg(1000)
                    .query_async(&mut self.redis),
            )
            .await?;
            out.extend(batch);
            if out.len() > MAX_KEYS {
                return Err(config(format!(
                    "more than {MAX_KEYS} Dragonfly keys; narrow compare.dragonfly"
                )));
            }
            if next == 0 {
                break;
            }
            cursor = next;
        }
        out.sort();
        out.dedup();
        Ok(out)
    }

    async fn q(&mut self, cmd: &mut redis::Cmd) -> Result<redis::Value> {
        timed(
            "Dragonfly",
            cmd.query_async::<redis::Value>(&mut self.redis),
        )
        .await
    }

    pub async fn capture_dragonfly(&mut self, sel: &Selection) -> Result<Vec<RawEntry>> {
        let mut out = Vec::new();
        for key in self.keys().await? {
            if !sel.includes(&String::from_utf8_lossy(&key)) {
                continue;
            }
            let kind = match self.q(redis::cmd("TYPE").arg(&key)).await? {
                redis::Value::SimpleString(s) => s,
                redis::Value::Okay => "string".into(),
                redis::Value::BulkString(b) => String::from_utf8_lossy(&b).to_string(),
                _ => continue,
            };
            let value = match kind.as_str() {
                "none" => continue,
                "string" => match self.q(redis::cmd("GET").arg(&key)).await? {
                    redis::Value::BulkString(b) => RawValue::Str(b),
                    redis::Value::Nil => continue,
                    other => RawValue::Str(format!("{other:?}").into_bytes()),
                },
                "hash" => {
                    let flat = bulk_list(self.q(redis::cmd("HGETALL").arg(&key)).await?);
                    RawValue::Hash(
                        flat.chunks(2)
                            .filter_map(|c| match c {
                                [k, v] => Some((k.clone(), v.clone())),
                                _ => None,
                            })
                            .collect(),
                    )
                }
                "list" => RawValue::List(bulk_list(
                    self.q(redis::cmd("LRANGE").arg(&key).arg(0).arg(-1))
                        .await?,
                )),
                "set" => RawValue::Set(bulk_list(self.q(redis::cmd("SMEMBERS").arg(&key)).await?)),
                "zset" => {
                    let reply = self
                        .q(redis::cmd("ZRANGE")
                            .arg(&key)
                            .arg(0)
                            .arg(-1)
                            .arg("WITHSCORES"))
                        .await?;
                    let mut pairs = Vec::new();
                    if let redis::Value::Array(items) = reply {
                        let mut flat: Vec<redis::Value> = Vec::new();
                        for it in items {
                            match it {
                                redis::Value::Array(pair) => flat.extend(pair),
                                other => flat.push(other),
                            }
                        }
                        for c in flat.chunks(2) {
                            if let [m, s] = c {
                                let member = match m {
                                    redis::Value::BulkString(b) => b.clone(),
                                    other => format!("{other:?}").into_bytes(),
                                };
                                let score = match s {
                                    redis::Value::BulkString(b) => {
                                        String::from_utf8_lossy(b).parse().unwrap_or(f64::NAN)
                                    }
                                    redis::Value::Double(f) => *f,
                                    redis::Value::Int(i) => *i as f64,
                                    _ => f64::NAN,
                                };
                                pairs.push((member, score));
                            }
                        }
                    }
                    RawValue::ZSet(pairs)
                }
                "stream" => {
                    let reply = self
                        .q(redis::cmd("XRANGE").arg(&key).arg("-").arg("+"))
                        .await?;
                    let mut entries = Vec::new();
                    if let redis::Value::Array(items) = reply {
                        for it in items {
                            if let redis::Value::Array(parts) = it {
                                let mut parts = parts.into_iter();
                                let id = match parts.next() {
                                    Some(redis::Value::BulkString(b)) => {
                                        String::from_utf8_lossy(&b).to_string()
                                    }
                                    Some(redis::Value::SimpleString(s)) => s,
                                    _ => continue,
                                };
                                let fields = parts.next().map(bulk_list).unwrap_or_default();
                                let pairs = fields
                                    .chunks(2)
                                    .filter_map(|c| match c {
                                        [k, v] => Some((k.clone(), v.clone())),
                                        _ => None,
                                    })
                                    .collect();
                                entries.push((id, pairs));
                            }
                        }
                    }
                    RawValue::Stream(entries)
                }
                _ => RawValue::Other,
            };
            let pttl = match self.q(redis::cmd("PTTL").arg(&key)).await? {
                redis::Value::Int(i) => i,
                _ => -1,
            };
            if pttl == -2 {
                continue;
            }
            out.push(RawEntry {
                key,
                kind,
                value,
                pttl,
            });
        }
        Ok(out)
    }

    pub async fn snapshot(&mut self) -> Result<Baseline> {
        let mut colls = Vec::new();
        if self.owned {
            for spec in self.collections().await? {
                colls.push(self.read_coll(&spec).await?);
            }
        }
        let mut keys = Vec::new();
        for key in self.keys().await? {
            let dump = match self.q(redis::cmd("DUMP").arg(&key)).await? {
                redis::Value::BulkString(b) => b,
                _ => continue,
            };
            let pttl = match self.q(redis::cmd("PTTL").arg(&key)).await? {
                redis::Value::Int(i) => i,
                _ => -1,
            };
            keys.push((key, dump, pttl));
        }
        Ok(Baseline { colls, keys })
    }

    /// Put the stores back to a baseline: everything else is removed.
    pub async fn restore(&mut self, b: &Baseline) -> Result<()> {
        self.reset_empty().await?;
        let db = self.db();
        for (name, c) in &b.colls {
            let mut create = doc! {"create": name.clone()};
            for (k, v) in &c.options {
                create.insert(k.clone(), v.clone());
            }
            timed("MongoDB create", db.run_command(create)).await?;
            let specs: Vec<Bson> = c
                .indexes
                .iter()
                .filter(|s| s.get_str("name").ok() != Some("_id_"))
                .map(|s| {
                    let mut s = s.clone();
                    s.remove("v");
                    s.remove("ns");
                    Bson::Document(s)
                })
                .collect();
            if !specs.is_empty() {
                timed(
                    "MongoDB createIndexes",
                    db.run_command(doc! {"createIndexes": name.clone(), "indexes": specs}),
                )
                .await?;
            }
            if !c.docs.is_empty() && c.kind == "collection" {
                timed(
                    "MongoDB insert",
                    db.collection::<Document>(name).insert_many(c.docs.clone()),
                )
                .await?;
            }
        }
        for (key, dump, pttl) in &b.keys {
            let ttl = if *pttl > 0 { *pttl } else { 0 };
            self.q(redis::cmd("RESTORE")
                .arg(key)
                .arg(ttl)
                .arg(dump)
                .arg("REPLACE"))
                .await?;
        }
        Ok(())
    }

    /// Write the scenario's seed.
    pub async fn seed(&mut self, s: &Scenario, now: i64) -> Result<()> {
        let db = self.db();
        for (coll, docs) in &s.seed_mongo {
            let mut converted = Vec::with_capacity(docs.len());
            for (i, d) in docs.iter().enumerate() {
                converted.push(
                    scenario::to_doc(d, ExtMode::Seed, now, &format!("seed.mongo.{coll}[{i}]"))
                        .map_err(config)?,
                );
            }
            if !converted.is_empty() {
                timed(
                    &format!("seeding {coll}"),
                    db.collection::<Document>(coll).insert_many(converted),
                )
                .await?;
            }
        }
        let empty = BTreeMap::new();
        for (i, cmd) in s.seed_dragonfly.iter().enumerate() {
            let args = cmd
                .iter()
                .map(|a| a.render(&empty, now))
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| config(format!("seed.dragonfly[{i}]: {e}")))?;
            match self.command(&args).await? {
                RawReply::Error(e) => {
                    return Err(config(format!("seed.dragonfly[{i}] {args:?} failed: {e}")));
                }
                _ => continue,
            }
        }
        Ok(())
    }

    /// Run one command on the side's logical database. Error replies are values, not failures.
    pub async fn command(&mut self, args: &[String]) -> Result<RawReply> {
        let Some((name, rest)) = args.split_first() else {
            return Err(config("empty command"));
        };
        let mut cmd = redis::cmd(name);
        for a in rest {
            cmd.arg(a);
        }
        match tokio::time::timeout(
            STORE_TIMEOUT,
            cmd.query_async::<redis::Value>(&mut self.redis),
        )
        .await
        {
            Err(_) => Err(store("Dragonfly command", "timed out")),
            Ok(Ok(v)) => Ok(to_raw_reply(v)),
            Ok(Err(e))
                if e.is_io_error()
                    || e.is_connection_dropped()
                    || e.is_connection_refusal()
                    || e.is_timeout() =>
            {
                Err(redis_err(e))
            }
            Ok(Err(e)) => Ok(RawReply::Error(
                format!("{} {}", e.code().unwrap_or("ERR"), e.detail().unwrap_or(""))
                    .trim()
                    .to_string(),
            )),
        }
    }

    pub async fn count(&self, collection: &str, filter: Document) -> Result<u64> {
        timed(
            "MongoDB count",
            self.db()
                .collection::<Document>(collection)
                .count_documents(filter),
        )
        .await
    }

    pub async fn key_exists(&mut self, pattern: &str) -> Result<bool> {
        if !pattern.contains(['*', '?', '[']) {
            let n: i64 = timed(
                "Dragonfly EXISTS",
                redis::cmd("EXISTS")
                    .arg(pattern)
                    .query_async(&mut self.redis),
            )
            .await?;
            return Ok(n > 0);
        }
        Ok(self
            .keys()
            .await?
            .iter()
            .any(|k| name_glob(pattern, &String::from_utf8_lossy(k))))
    }

    /// A hash of everything stored (TTL presence, not TTL values), for "wait until quiet".
    pub async fn fingerprint(
        &mut self,
        ignore_keys: &[String],
        ignore_collections: &[String],
    ) -> Result<u64> {
        let mut acc = String::new();
        if self.owned || !ignore_collections.iter().any(|c| c == "*") {
            let names: Vec<String> = self
                .collections()
                .await?
                .iter()
                .filter_map(|c| c.get_str("name").ok().map(str::to_string))
                .filter(|n| !ignore_collections.iter().any(|g| name_glob(g, n)))
                .collect();
            for n in &names {
                acc.push_str(n);
                for i in self.indexes(n).await? {
                    acc.push_str(&i.to_string());
                }
            }
            if !names.is_empty() {
                let list: Vec<Bson> = names.iter().map(|n| Bson::String(n.clone())).collect();
                let h = timed(
                    "MongoDB dbHash",
                    self.db()
                        .run_command(doc! {"dbHash": 1, "collections": list}),
                )
                .await?;
                acc.push_str(h.get_str("md5").unwrap_or(""));
            }
        }
        for key in self.keys().await? {
            if ignore_keys
                .iter()
                .any(|g| name_glob(g, &String::from_utf8_lossy(&key)))
            {
                continue;
            }
            let dump = match self.q(redis::cmd("DUMP").arg(&key)).await? {
                redis::Value::BulkString(b) => b,
                _ => Vec::new(),
            };
            let ttl = matches!(self.q(redis::cmd("PTTL").arg(&key)).await?, redis::Value::Int(i) if i >= 0);
            acc.push_str(&format!(
                "{}|{}|{ttl};",
                String::from_utf8_lossy(&key),
                fnv1a64(&dump)
            ));
        }
        Ok(fnv1a64(acc.as_bytes()))
    }
}

/// Per-collection content hashes of a database (to prove a read-only run did not write).
pub async fn db_hash(client: &Client, db: &str) -> Result<BTreeMap<String, String>> {
    let reply = timed(
        "MongoDB dbHash",
        client.database(db).run_command(doc! {"dbHash": 1}),
    )
    .await?;
    let mut out = BTreeMap::new();
    if let Ok(c) = reply.get_document("collections") {
        for (k, v) in c {
            out.insert(k.clone(), v.as_str().unwrap_or("").to_string());
        }
    }
    Ok(out)
}

/// Drop `rig_<pid>_...` databases whose rig process is gone. Returns the dropped names.
pub async fn gc(mongo_uri: &str) -> Result<Vec<String>> {
    let client = mongo_client(mongo_uri).await?;
    let names = timed("MongoDB listDatabases", client.list_database_names()).await?;
    let mut dropped = Vec::new();
    for n in names {
        let Some(rest) = n.strip_prefix("rig_") else {
            continue;
        };
        let Some(pid) = rest.split('_').next().and_then(|p| p.parse::<u32>().ok()) else {
            continue;
        };
        if std::path::Path::new(&format!("/proc/{pid}")).exists() {
            continue;
        }
        timed("MongoDB drop", client.database(&n).drop()).await?;
        dropped.push(n);
    }
    Ok(dropped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_gets_the_database() {
        assert_eq!(
            uri_with_db(
                "mongodb://u:p@127.0.0.1:27017/?authSource=admin&directConnection=true",
                "rig_1"
            ),
            "mongodb://u:p@127.0.0.1:27017/rig_1?authSource=admin&directConnection=true"
        );
        assert_eq!(
            uri_with_db("mongodb://127.0.0.1:27017", "x"),
            "mongodb://127.0.0.1:27017/x"
        );
        assert_eq!(uri_with_db("mongodb://h/old?w=1", "x"), "mongodb://h/x?w=1");
    }
}

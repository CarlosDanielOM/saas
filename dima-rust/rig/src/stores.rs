//! The stores of one side: a MongoDB database and a Dragonfly logical database.
//!
//! Dragonfly logical databases are claimed with a file lock per index, so several rig runs on one
//! machine never share one. MongoDB databases are named `rig_<pid>_<n>_<side>` and dropped at the
//! end (`dima-rig gc` drops those left behind by a rig process that is gone).

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions, TryLockError};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
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
    pub postgres_uri: Option<String>,
    pub dragonfly_host: String,
    pub dragonfly_port: u16,
    /// Logical databases the rig may use (never 0).
    pub dragonfly_dbs: Vec<u8>,
    pub lock_dir: PathBuf,
    /// How long to wait for a free logical database.
    pub lock_wait: Duration,
}

/// The URI without credentials (options kept).
fn without_credentials(uri: &str) -> String {
    crate::capture::redact_uri(uri)
}

/// The URI with these credentials (defined in `admin`) and `db` as its path. The options keep
/// their order (`authSource` set to `admin` where it was, or appended).
pub fn uri_with_user(uri: &str, user: &str, password: &str, db: &str) -> String {
    let base = uri_with_db(&without_credentials(uri), db);
    let (scheme, rest) = base.split_once("://").unwrap_or(("mongodb", base.as_str()));
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let mut params: Vec<&str> = query.split('&').filter(|p| !p.is_empty()).collect();
    match params.iter_mut().find(|p| p.starts_with("authSource=")) {
        Some(p) => *p = "authSource=admin",
        None => params.push("authSource=admin"),
    }
    format!("{scheme}://{user}:{password}@{path}?{}", params.join("&"))
}

/// A temporary user, defined in `admin`, that may read, write and index the side's own
/// database and nothing else. Registered for [`Registry::cleanup`] before it exists.
pub async fn create_side_user(cfg: &StoreConfig, reg: &Registry, db: &str) -> Result<String> {
    let name = format!("{db}_rw");
    let password = uuid::Uuid::new_v4().simple().to_string();
    let client = mongo_client(&cfg.mongo_uri).await?;
    reg.add_user(&name);
    timed(
        "MongoDB createUser",
        client.database("admin").run_command(doc! {
            "createUser": &name,
            "pwd": &password,
            "roles": [{"role": "readWrite", "db": db}, {"role": "dbAdmin", "db": db}],
        }),
    )
    .await?;
    Ok(uri_with_user(&cfg.mongo_uri, &name, &password, db))
}

/// A temporary user, defined in `admin`, with the `read` role on `db` only. Registered for
/// [`Registry::cleanup`] before it exists. Returns the URI a side connects with.
pub async fn create_read_only_user(
    cfg: &StoreConfig,
    reg: &Registry,
    label: &str,
    db: &str,
) -> Result<String> {
    let name = format!(
        "rig_{}_{}_{label}_ro",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    );
    let password = uuid::Uuid::new_v4().simple().to_string();
    let client = mongo_client(&cfg.mongo_uri).await?;
    reg.add_user(&name);
    timed(
        "MongoDB createUser",
        client.database("admin").run_command(doc! {
            "createUser": &name,
            "pwd": &password,
            "roles": [{"role": "read", "db": db}],
        }),
    )
    .await?;
    Ok(uri_with_user(&cfg.mongo_uri, &name, &password, db))
}

/// Whether the server refuses a client without credentials, so a user's role is enforced.
pub async fn auth_enforced(cfg: &StoreConfig) -> Result<bool> {
    let client = mongo_client(&without_credentials(&cfg.mongo_uri)).await?;
    match tokio::time::timeout(STORE_TIMEOUT, client.list_database_names()).await {
        Ok(Ok(_)) => Ok(false),
        // Unauthorized.
        Ok(Err(e)) if command_code(&e) == Some(13) => Ok(true),
        Ok(Err(e)) => Err(store("MongoDB authentication check", e)),
        Err(_) => Err(store("MongoDB authentication check", "timed out")),
    }
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

/// The lock file that claims logical database `idx` of the configured Dragonfly server.
pub fn lock_path(cfg: &StoreConfig, idx: u8) -> PathBuf {
    cfg.lock_dir.join(format!(
        "dragonfly-{}-{}-db{idx}.lock",
        cfg.dragonfly_host.replace(['/', ':'], "_"),
        cfg.dragonfly_port
    ))
}

async fn lock_index(cfg: &StoreConfig) -> Result<(u8, File)> {
    std::fs::create_dir_all(&cfg.lock_dir)
        .map_err(|e| crate::error::io(&cfg.lock_dir.display().to_string(), e))?;
    let deadline = tokio::time::Instant::now() + cfg.lock_wait;
    loop {
        for idx in &cfg.dragonfly_dbs {
            let path = lock_path(cfg, *idx);
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

/// Everything one rig command has claimed: MongoDB databases it created, temporary MongoDB users,
/// and Dragonfly logical databases (with the lock files that claim them). Released by one path,
/// [`Registry::cleanup`], after success, an error, or an interruption alike. The lock files live
/// here, not in the side, so a logical database is flushed before its lock is released.
#[derive(Clone, Default)]
pub struct Registry(Arc<Mutex<Held>>);

#[derive(Default)]
struct Held {
    postgres: Vec<(String, String)>,
    mongo_dbs: Vec<String>,
    /// Users defined in the `admin` database.
    users: Vec<String>,
    dragonfly: Vec<(u8, File)>,
    /// Qdrant collection prefixes of the sides' proxies.
    qdrant: Vec<crate::mock::qdrant::Upstream>,
    /// Containers started for sides (`docker rm -f` on cleanup).
    containers: Vec<String>,
    /// The sides' data directories (removed on cleanup).
    data_dirs: Vec<PathBuf>,
}

/// What [`Registry::cleanup`] did.
#[derive(Debug, Default)]
pub struct Cleanup {
    pub dropped_dbs: Vec<String>,
    pub dropped_postgres: Vec<String>,
    pub kept_dbs: Vec<String>,
    pub dropped_users: Vec<String>,
    pub flushed: Vec<u8>,
    pub kept_dragonfly: Vec<u8>,
    pub dropped_collections: Vec<String>,
    pub removed_containers: Vec<String>,
    pub errors: Vec<String>,
}

impl Cleanup {
    /// One line for stderr, or `None` when there was nothing to release.
    pub fn summary(&self) -> Option<String> {
        let mut parts = Vec::new();
        if !self.dropped_postgres.is_empty() {
            parts.push(format!(
                "dropped PostgreSQL databases {}",
                self.dropped_postgres.join(", ")
            ));
        }
        if !self.dropped_dbs.is_empty() {
            parts.push(format!(
                "dropped MongoDB databases {}",
                self.dropped_dbs.join(", ")
            ));
        }
        if !self.dropped_users.is_empty() {
            parts.push(format!(
                "dropped MongoDB users {}",
                self.dropped_users.join(", ")
            ));
        }
        if !self.dropped_collections.is_empty() {
            parts.push(format!(
                "dropped Qdrant collections {}",
                self.dropped_collections.join(", ")
            ));
        }
        if !self.removed_containers.is_empty() {
            parts.push(format!(
                "removed containers {}",
                self.removed_containers.join(", ")
            ));
        }
        if !self.flushed.is_empty() {
            let list: Vec<String> = self.flushed.iter().map(u8::to_string).collect();
            parts.push(format!(
                "flushed Dragonfly logical databases {}",
                list.join(", ")
            ));
        }
        if !self.kept_dbs.is_empty() || !self.kept_dragonfly.is_empty() {
            let list: Vec<String> = self.kept_dragonfly.iter().map(u8::to_string).collect();
            parts.push(format!(
                "kept (--keep) MongoDB databases {} and Dragonfly logical databases {} (flushed by the next run that claims them)",
                self.kept_dbs.join(", "),
                list.join(", ")
            ));
        }
        (!parts.is_empty()).then(|| format!("cleanup: {}", parts.join("; ")))
    }
}

impl Registry {
    fn held(&self) -> std::sync::MutexGuard<'_, Held> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn add_postgres(&self, uri: &str, name: &str) {
        self.held().postgres.push((uri.into(), name.into()));
    }

    pub fn add_db(&self, name: &str) {
        self.held().mongo_dbs.push(name.to_string());
    }

    pub fn add_user(&self, name: &str) {
        self.held().users.push(name.to_string());
    }

    fn add_dragonfly(&self, idx: u8, lock: File) {
        self.held().dragonfly.push((idx, lock));
    }

    pub fn add_qdrant(&self, up: &crate::mock::qdrant::Upstream) {
        self.held().qdrant.push(up.clone());
    }

    /// A side's container, removed by the cleanup path if it is still there.
    pub fn add_container(&self, name: &str) {
        self.held().containers.push(name.to_string());
    }

    pub fn add_data_dir(&self, dir: &std::path::Path) {
        self.held().data_dirs.push(dir.to_path_buf());
    }

    /// Release everything: drop the MongoDB databases (unless `keep`) and the temporary users
    /// (always), flush each claimed logical database (unless `keep`), then release its lock.
    /// Idempotent: what was released is forgotten.
    pub async fn cleanup(&self, cfg: &StoreConfig, keep: bool) -> Cleanup {
        let (dbs, users, dragonfly, qdrant, containers, data_dirs) = {
            let mut h = self.held();
            (
                std::mem::take(&mut h.mongo_dbs),
                std::mem::take(&mut h.users),
                std::mem::take(&mut h.dragonfly),
                std::mem::take(&mut h.qdrant),
                std::mem::take(&mut h.containers),
                std::mem::take(&mut h.data_dirs),
            )
        };
        let mut out = Cleanup::default();
        let postgres = std::mem::take(&mut self.held().postgres);
        // Containers first: nothing may write to the stores while they are released.
        for name in containers {
            match crate::side::remove_container(&name).await {
                Ok(true) => out.removed_containers.push(name),
                Ok(false) => {}
                Err(e) => out.errors.push(format!("removing container {name}: {e}")),
            }
        }
        for (uri, name) in postgres {
            match crate::postgres::drop_database(&uri, &name).await {
                Ok(()) => out.dropped_postgres.push(name),
                Err(e) => out
                    .errors
                    .push(format!("dropping PostgreSQL database {name}: {e}")),
            }
        }
        for dir in data_dirs {
            if keep || !dir.exists() {
                continue;
            }
            if let Err(e) = std::fs::remove_dir_all(&dir) {
                out.errors.push(format!(
                    "removing the data directory {}: {e} (files a container wrote as root?)",
                    dir.display()
                ));
            }
        }
        for up in qdrant {
            if keep {
                continue;
            }
            match crate::mock::qdrant::drop_prefixed(&up).await {
                Ok(names) => out.dropped_collections.extend(names),
                Err(e) => out.errors.push(format!(
                    "dropping Qdrant collections {}*: {e}; run `dima-rig gc`",
                    up.prefix
                )),
            }
        }
        if !dbs.is_empty() || !users.is_empty() {
            match mongo_client(&cfg.mongo_uri).await {
                Ok(client) => {
                    for db in dbs {
                        if keep {
                            out.kept_dbs.push(db);
                            continue;
                        }
                        match timed("MongoDB drop", client.database(&db).drop()).await {
                            Ok(()) => out.dropped_dbs.push(db),
                            Err(e) => out.errors.push(format!("dropping database {db}: {e}")),
                        }
                    }
                    for user in users {
                        match drop_user(&client, &user).await {
                            Ok(()) => out.dropped_users.push(user),
                            Err(e) => out.errors.push(format!("dropping user {user}: {e}")),
                        }
                    }
                }
                Err(e) => out.errors.push(format!(
                    "MongoDB cleanup: {e} (databases {dbs:?}, users {users:?}); run `dima-rig gc`"
                )),
            }
        }
        for (idx, lock) in dragonfly {
            if keep {
                out.kept_dragonfly.push(idx);
            } else {
                match flush_index(cfg, idx).await {
                    Ok(()) => out.flushed.push(idx),
                    Err(e) => out.errors.push(format!(
                        "flushing Dragonfly logical database {idx}: {e} (the next run that claims it flushes it)"
                    )),
                }
            }
            // Released only now, after the flush.
            drop(lock);
        }
        out
    }
}

async fn flush_index(cfg: &StoreConfig, idx: u8) -> Result<()> {
    let url = format!(
        "redis://{}:{}/{idx}",
        cfg.dragonfly_host, cfg.dragonfly_port
    );
    let rc = redis::Client::open(url).map_err(redis_err)?;
    let mut conn = timed("Dragonfly connect", rc.get_multiplexed_async_connection()).await?;
    timed(
        "Dragonfly FLUSHDB",
        redis::cmd("FLUSHDB").query_async::<()>(&mut conn),
    )
    .await
}

/// Drop a user defined in `admin`; a user that is already gone is fine.
pub async fn drop_user(client: &Client, user: &str) -> Result<()> {
    match tokio::time::timeout(
        STORE_TIMEOUT,
        client
            .database("admin")
            .run_command(doc! {"dropUser": user}),
    )
    .await
    {
        Ok(Ok(_)) => Ok(()),
        // UserNotFound.
        Ok(Err(e)) if command_code(&e) == Some(11) => Ok(()),
        Ok(Err(e)) => Err(store("MongoDB dropUser", e)),
        Err(_) => Err(store("MongoDB dropUser", "timed out")),
    }
}

/// The server's error code of a failed command.
pub fn command_code(e: &mongodb::error::Error) -> Option<i32> {
    match e.kind.as_ref() {
        mongodb::error::ErrorKind::Command(c) => Some(c.code),
        _ => None,
    }
}

/// `NamespaceNotFound`: the collection does not exist (any more).
const NAMESPACE_NOT_FOUND: i32 = 26;

/// The index definitions of a collection. A view has none; a collection that does not exist
/// (dropped while the capture ran) has none; any other failure fails the capture.
pub async fn list_indexes(db: &mongodb::Database, coll: &str, kind: &str) -> Result<Vec<Document>> {
    if kind == "view" {
        return Ok(Vec::new());
    }
    match tokio::time::timeout(
        STORE_TIMEOUT,
        db.run_command(doc! {"listIndexes": coll, "cursor": {"batchSize": 100_000}}),
    )
    .await
    {
        Ok(Ok(r)) => Ok(first_batch(&r)),
        Ok(Err(e)) if command_code(&e) == Some(NAMESPACE_NOT_FOUND) => Ok(Vec::new()),
        Ok(Err(e)) => Err(store(&format!("MongoDB listIndexes on {coll}"), e)),
        Err(_) => Err(store(
            &format!("MongoDB listIndexes on {coll}"),
            "timed out",
        )),
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
    /// The URI the side process gets instead of the rig's own (a read-only user).
    pub side_uri: Option<String>,
    pub postgres: Option<crate::postgres::Database>,
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
    /// the rig never drops or writes). Both are registered for [`Registry::cleanup`] before
    /// anything is written to them.
    pub async fn allocate(
        cfg: &StoreConfig,
        reg: &Registry,
        label: &str,
        existing_db: Option<&str>,
        own_user: bool,
    ) -> Result<SideStores> {
        let (df_index, lock) = lock_index(cfg).await?;
        reg.add_dragonfly(df_index, lock);
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
        if owned {
            reg.add_db(&db_name);
        }
        let url = format!(
            "redis://{}:{}/{df_index}",
            cfg.dragonfly_host, cfg.dragonfly_port
        );
        let rc = redis::Client::open(url).map_err(redis_err)?;
        let redis = timed("Dragonfly connect", rc.get_multiplexed_async_connection()).await?;
        // The side reaches only its own database (record, verify, compare).
        let side_uri = if owned && own_user {
            Some(create_side_user(cfg, reg, &db_name).await?)
        } else {
            None
        };
        let postgres = match &cfg.postgres_uri {
            Some(uri) if owned => {
                Some(crate::postgres::Database::create(uri, &db_name, reg).await?)
            }
            _ => None,
        };
        let mut s = SideStores {
            postgres,
            cfg: cfg.clone(),
            client,
            db_name,
            owned,
            df_index,
            redis,
            side_uri,
        };
        s.reset_empty().await?;
        Ok(s)
    }

    /// The MongoDB URI the side process gets.
    pub fn mongo_uri(&self) -> String {
        self.side_uri
            .clone()
            .unwrap_or_else(|| uri_with_db(&self.cfg.mongo_uri, &self.db_name))
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
        if let Some(pg) = &self.postgres {
            pg.reset().await?;
        }
        self.flushdb().await
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

    async fn read_coll(&self, spec: &Document) -> Result<(String, RawColl)> {
        let name = spec.get_str("name").unwrap_or("").to_string();
        let kind = spec.get_str("type").unwrap_or("collection").to_string();
        let options = spec.get_document("options").cloned().unwrap_or_default();
        let indexes = list_indexes(&self.db(), &name, &kind).await?;
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
                                // The score as the server wrote it.
                                let score = match s {
                                    redis::Value::BulkString(b) => {
                                        String::from_utf8_lossy(b).to_string()
                                    }
                                    redis::Value::Double(f) => f.to_string(),
                                    redis::Value::Int(i) => i.to_string(),
                                    other => format!("{other:?}"),
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
            // Each TTL with the time of its own reading (the middle of the round trip).
            let before = crate::timefmt::now_ms();
            let pttl = match self.q(redis::cmd("PTTL").arg(&key)).await? {
                redis::Value::Int(i) => i,
                _ => -1,
            };
            let pttl_at = before + (crate::timefmt::now_ms() - before) / 2;
            if pttl == -2 {
                continue;
            }
            out.push(RawEntry {
                key,
                kind,
                value,
                pttl,
                pttl_at,
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
        if !s.seed_postgres.is_empty() {
            let pg = self
                .postgres
                .as_ref()
                .ok_or_else(|| config("seed.postgres requires DIMA_TEST_POSTGRES_URI"))?;
            for sql in &s.seed_postgres {
                pg.execute(sql).await?;
            }
        }
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
            let words = crate::dfcmd::words(&args);
            crate::dfcmd::check(&words, s.allow_scripts)
                .map_err(|e| config(format!("seed.dragonfly[{i}] {words:?}: {e}")))?;
            match self.command(&args).await? {
                RawReply::Error(e) => {
                    return Err(config(format!("seed.dragonfly[{i}] {words:?} failed: {e}")));
                }
                _ => continue,
            }
        }
        Ok(())
    }

    /// Run one command on the side's logical database. Error replies are values, not failures.
    pub async fn command(&mut self, args: &[Vec<u8>]) -> Result<RawReply> {
        let Some((name, rest)) = args.split_first() else {
            return Err(config("empty command"));
        };
        let mut cmd = redis::cmd(&String::from_utf8_lossy(name));
        for a in rest {
            cmd.arg(a.as_slice());
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

    /// Every key that has a TTL now, with its expiry (rig clock, epoch ms).
    pub async fn ttl_keys(&mut self) -> Result<Vec<(Vec<u8>, i64)>> {
        let mut out = Vec::new();
        for key in self.keys().await? {
            let before = crate::timefmt::now_ms();
            if let redis::Value::Int(p) = self.q(redis::cmd("PTTL").arg(&key)).await?
                && p >= 0
            {
                out.push((key, before + p));
            }
        }
        Ok(out)
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
            let specs: Vec<(String, String)> = self
                .collections()
                .await?
                .iter()
                .filter_map(|c| {
                    let name = c.get_str("name").ok()?.to_string();
                    let kind = c.get_str("type").unwrap_or("collection").to_string();
                    Some((name, kind))
                })
                .filter(|(n, _)| !ignore_collections.iter().any(|g| name_glob(g, n)))
                .collect();
            for (n, kind) in &specs {
                acc.push_str(n);
                for i in list_indexes(&self.db(), n, kind).await? {
                    acc.push_str(&i.to_string());
                }
            }
            let names: Vec<String> = specs.into_iter().map(|(n, _)| n).collect();
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
    // dbHash covers documents only: index changes (an application's start-up createIndexes)
    // are writes too. dbHash lists collections, not views.
    let names: Vec<String> = out.keys().cloned().collect();
    for name in names {
        let mut specs: Vec<String> = list_indexes(&client.database(db), &name, "collection")
            .await?
            .iter()
            .map(|d| d.to_string())
            .collect();
        specs.sort();
        out.insert(format!("{name} (indexes)"), specs.join(";"));
    }
    Ok(out)
}

/// Delete Qdrant collections `rig_<pid>_...` whose rig process is gone.
pub async fn gc_qdrant(store: &crate::config::QdrantStore) -> Result<Vec<String>> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| store_err("Qdrant", e))?;
    let base = store.url.trim_end_matches('/');
    let with_key = |rb: reqwest::RequestBuilder| match &store.api_key {
        Some(k) => rb.header("api-key", k.as_str()),
        None => rb,
    };
    let list: serde_json::Value = with_key(client.get(format!("{base}/collections")))
        .send()
        .await
        .map_err(|e| store_err("Qdrant", e))?
        .json()
        .await
        .map_err(|e| store_err("Qdrant", e))?;
    let mut dropped = Vec::new();
    for name in list
        .pointer("/result/collections")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| c.get("name").and_then(serde_json::Value::as_str))
    {
        let Some(pid) = name
            .strip_prefix("rig_")
            .and_then(|rest| rest.split('_').next())
            .and_then(|p| p.parse::<u32>().ok())
        else {
            continue;
        };
        if std::path::Path::new(&format!("/proc/{pid}")).exists() {
            continue;
        }
        with_key(client.delete(format!("{base}/collections/{name}")))
            .send()
            .await
            .map_err(|e| store_err("Qdrant", e))?;
        dropped.push(format!("Qdrant collection {name}"));
    }
    Ok(dropped)
}

fn store_err(what: &str, e: impl std::fmt::Display) -> RigError {
    store(what, e)
}

/// Drop `rig_<pid>_...` databases and users whose rig process is gone. Returns the dropped names.
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
    // Temporary users (diff-get) of rig processes that are gone.
    let reply = timed(
        "MongoDB usersInfo",
        client.database("admin").run_command(doc! {"usersInfo": 1}),
    )
    .await?;
    let users: Vec<String> = reply
        .get_array("users")
        .map(|a| {
            a.iter()
                .filter_map(|u| u.as_document()?.get_str("user").ok().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    for u in users {
        let Some(pid) = u
            .strip_prefix("rig_")
            .and_then(|rest| rest.split('_').next())
            .and_then(|p| p.parse::<u32>().ok())
        else {
            continue;
        };
        if std::path::Path::new(&format!("/proc/{pid}")).exists() {
            continue;
        }
        drop_user(&client, &u).await?;
        dropped.push(format!("user {u}"));
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

    #[test]
    fn uri_for_a_temporary_user() {
        assert_eq!(
            uri_with_user(
                "mongodb://root:p@127.0.0.1:27017/?authSource=admin&directConnection=true",
                "rig_1_ro",
                "abc",
                "domdimabot"
            ),
            "mongodb://rig_1_ro:abc@127.0.0.1:27017/domdimabot?authSource=admin&directConnection=true"
        );
        assert_eq!(
            uri_with_user("mongodb://h:1", "u", "p", "d"),
            "mongodb://u:p@h:1/d?authSource=admin"
        );
    }
}

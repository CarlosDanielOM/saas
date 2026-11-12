//! Disposable PostgreSQL databases. The catalogue is compared separately from row values.
use crate::error::{Result, config, store};
use crate::stores::Registry;
use serde_json::{Value, json};
use std::time::Duration;
use tokio_postgres::{Client, NoTls};

const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_ROWS: usize = 20_000;

const CLOSE_TIMEOUT: Duration = Duration::from_secs(60);
const DROP_TIMEOUT: Duration = Duration::from_secs(120);
const DRAIN_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_OBSERVERS: usize = 128;
type Driver = tokio::task::JoinHandle<std::result::Result<(), tokio_postgres::Error>>;
type Closer = tokio::task::JoinHandle<Result<()>>;
type PendingClose = std::sync::Arc<tokio::sync::Mutex<Option<Closer>>>;
static PENDING: std::sync::Mutex<Vec<PendingClose>> = std::sync::Mutex::new(Vec::new());
static SLOTS: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::OnceLock::new();

/// Cancellation closes are owned until the registry (or next connection) joins them.
pub async fn flush_observers() -> Result<()> {
    loop {
        let tasks = PENDING
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if tasks.is_empty() {
            return Ok(());
        }
        let mut errors = Vec::new();
        for task in tasks {
            // The join handle stays in the shared queue while awaited. Cancelling this
            // waiter releases only the mutex guard; a later cleanup resumes the join.
            let mut held = task.lock().await;
            if let Some(task) = held.as_mut() {
                match task.await {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => errors.push(error.to_string()),
                    Err(error) => errors.push(format!("observer close task: {error}")),
                }
                *held = None;
            }
        }
        PENDING
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|task| task.try_lock().map_or(true, |held| held.is_some()));
        if !errors.is_empty() {
            return Err(store("PostgreSQL observer cleanup", errors.join("; ")));
        }
    }
}

struct Connection {
    client: Option<Client>,
    task: Option<Driver>,
    transaction: bool,
    database: String,
    runtime: tokio::runtime::Handle,
    permit: Option<tokio::sync::OwnedSemaphorePermit>,
}
impl Connection {
    fn client(&self) -> Result<&Client> {
        self.client
            .as_ref()
            .ok_or_else(|| store("PostgreSQL observer", "connection already closed"))
    }
    async fn end_transaction(&mut self, commit: bool) -> Result<()> {
        let ended = if self.transaction {
            let sql = if commit { "COMMIT" } else { "ROLLBACK" };
            tokio::time::timeout(CLOSE_TIMEOUT, self.client()?.batch_execute(sql))
                .await
                .map_err(|_| {
                    store(
                        &format!("PostgreSQL transaction end {}", self.database),
                        "timed out",
                    )
                })
                .and_then(|result| {
                    result.map_err(|e| {
                        pg_error(&format!("PostgreSQL transaction end {}", self.database), e)
                    })
                })
        } else {
            Ok(())
        };
        if ended.is_ok() {
            self.transaction = false;
        }
        ended
    }
    async fn close(mut self, commit: bool) -> Result<()> {
        let ended = self.end_transaction(commit).await;
        // If an error or cancellation interrupts transaction end, Drop queues ROLLBACK and
        // retains the driver. Successful end permits a clean frontend disconnect.
        if ended.is_ok() {
            self.transaction = false;
        }
        if ended.is_err() && self.transaction {
            let _ =
                tokio::time::timeout(CLOSE_TIMEOUT, self.client()?.batch_execute("ROLLBACK")).await;
            self.transaction = false;
        }
        drop(self.client.take());
        let driven = match self.task.as_mut() {
            Some(task) => join_driver(task, &self.database).await,
            None => Ok(()),
        };
        self.task = None;
        ended.and(driven)
    }
    async fn finish<T>(self, result: Result<T>) -> Result<T> {
        self.close(result.is_ok()).await?;
        result
    }
}
async fn join_driver(task: &mut Driver, database: &str) -> Result<()> {
    let result = tokio::time::timeout(CLOSE_TIMEOUT, &mut *task).await;
    match result {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(error))) => Err(pg_error(&format!("PostgreSQL close {database}"), error)),
        Ok(Err(error)) => Err(store(&format!("PostgreSQL close {database}"), error)),
        Err(_) => {
            task.abort();
            let _ = task.await;
            Err(store(
                &format!("PostgreSQL close {database}"),
                "driver did not finish within 60s; aborted and joined",
            ))
        }
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        let Some(mut task) = self.task.take() else {
            return;
        };
        let client = self.client.take();
        let transaction = self.transaction;
        let database = self.database.clone();
        let permit = self.permit.take();
        // Keep the queue lock through spawn/registration. Each entry retains one of the
        // 128 observer permits, and every new observer drains the queue before connecting.
        let mut pending = PENDING
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        pending.push(std::sync::Arc::new(tokio::sync::Mutex::new(Some(
            self.runtime.spawn(async move {
                let ended = if transaction {
                    match &client {
                        Some(client) => {
                            tokio::time::timeout(CLOSE_TIMEOUT, client.batch_execute("ROLLBACK"))
                                .await
                                .map_err(|_| {
                                    store(&format!("PostgreSQL rollback {database}"), "timed out")
                                })
                                .and_then(|result| {
                                    result.map_err(|e| {
                                        pg_error(&format!("PostgreSQL rollback {database}"), e)
                                    })
                                })
                        }
                        None => Ok(()),
                    }
                } else {
                    Ok(())
                };
                drop(client);
                let driven = join_driver(&mut task, &database).await;
                drop(permit);
                ended.and(driven)
            }),
        ))));
    }
}

async fn connect(uri: &str) -> Result<Connection> {
    let cfg: tokio_postgres::Config = uri.parse().map_err(|_| config("invalid PostgreSQL URI"))?;
    if cfg.get_hosts().iter().any(|h| !matches!(h, tokio_postgres::config::Host::Tcp(s) if s == "127.0.0.1" || s == "localhost" || s == "::1")) {
        return Err(config("PostgreSQL must be on loopback"));
    }
    flush_observers().await?;
    let slots = SLOTS
        .get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(MAX_OBSERVERS)))
        .clone();
    let permit = tokio::time::timeout(TIMEOUT, slots.acquire_owned())
        .await
        .map_err(|_| store("PostgreSQL observer slots", "timed out"))?
        .map_err(|e| store("PostgreSQL observer slots", e))?;
    let (client, connection) = tokio::time::timeout(TIMEOUT, cfg.connect(NoTls))
        .await
        .map_err(|_| store("PostgreSQL connect", "timed out"))?
        .map_err(|_| {
            store(
                "PostgreSQL connect",
                "connection failed (credentials redacted)",
            )
        })?;
    let c = Connection {
        client: Some(client),
        task: Some(tokio::spawn(connection)),
        transaction: false,
        database: cfg.get_dbname().unwrap_or("postgres").to_string(),
        runtime: tokio::runtime::Handle::current(),
        permit: Some(permit),
    };
    let configured = c
        .client()?
        .batch_execute("SET statement_timeout = '15s'; SET timezone = 'UTC'")
        .await
        .map_err(|e| pg_error("PostgreSQL settings", e));
    match configured {
        Ok(()) => Ok(c),
        Err(error) => c.finish(Err(error)).await,
    }
}
fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
fn database_uri(uri: &str, name: &str) -> Result<String> {
    let mut u = reqwest::Url::parse(uri).map_err(|_| config("invalid PostgreSQL URI"))?;
    u.set_path(&format!("/{name}"));
    Ok(u.to_string())
}
/// Returns whether FORCE was required. The side process must already be stopped.
pub async fn drop_database(uri: &str, name: &str) -> Result<bool> {
    if !name.starts_with("rig_") || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(config("refusing to drop a non-rig PostgreSQL database"));
    }
    flush_observers()
        .await
        .map_err(|e| store(&format!("PostgreSQL drop database {name}"), e))?;
    let c = connect(uri)
        .await
        .map_err(|e| store(&format!("PostgreSQL drop database {name}"), e))?;
    let result = async {
        c.client()?.batch_execute("SET statement_timeout = '120s'").await
            .map_err(|e| pg_error(&format!("PostgreSQL drop settings {name}"), e))?;
        let deadline = tokio::time::Instant::now() + DRAIN_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() { break; }
            let row = match tokio::time::timeout(TIMEOUT.min(remaining), c.client()?.query_one(
                "SELECT count(*) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", &[&name]
            )).await {
                Ok(result) => result.map_err(|e| pg_error(&format!("PostgreSQL backend drain {name}"), e))?,
                // Reaching the drain deadline is the reason to attempt DROP, not itself
                // a cleanup failure. DROP still has its independent 120-second limit.
                Err(_) => continue,
            };
            if row.get::<_, i64>(0) == 0 { break; }
            if tokio::time::Instant::now() >= deadline { break; }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let sql = format!("DROP DATABASE IF EXISTS {}", quote(name));
        let dropped = tokio::time::timeout(DROP_TIMEOUT, c.client()?.batch_execute(&sql)).await
            .map_err(|_| store(&format!("PostgreSQL drop database {name}"), "timed out after 120s"))?;
        match dropped {
            Ok(()) => return Ok(false),
            Err(error) if error.code() == Some(&tokio_postgres::error::SqlState::OBJECT_IN_USE) => {},
            Err(error) => return Err(pg_error(&format!("PostgreSQL drop database {name}"), error)),
        }
        {
            tokio::time::timeout(DROP_TIMEOUT, c.client()?.batch_execute(&format!("{sql} WITH (FORCE)"))).await
                .map_err(|_| store(&format!("PostgreSQL forced drop database {name}"), "timed out after 120s"))?
                .map_err(|e| pg_error(&format!("PostgreSQL forced drop database {name}"), e))?;
            eprintln!("dima-rig: PostgreSQL cleanup required FORCE for database {name}");
        }
        Ok(true)
    }.await;
    c.finish(result)
        .await
        .map_err(|e| store(&format!("PostgreSQL drop database {name}"), e))
}

/// One owned connection for cheap per-step time provenance, closed at scenario end.
pub struct TimeObserver {
    connection: Connection,
}
impl TimeObserver {
    pub async fn rows(&mut self) -> Result<Value> {
        let c = &mut self.connection;
        c.transaction = true;
        let result = async {
            c.client()?.batch_execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY").await
                .map_err(|e| pg_error("PostgreSQL time observer begin", e))?;
            let tables = c.client()?.query("SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f') ORDER BY 1,2", &[]).await
                .map_err(|e| pg_error("PostgreSQL time observer tables", e))?;
            if tables.len() > 2000 { return Err(config("PostgreSQL time observer exceeds 2000 tables")); }
            if tables.is_empty() { return Ok(Value::Array(Vec::new())); }
            let query = tables.into_iter().map(|row| {
                let schema: String = row.get(0); let table: String = row.get(1);
                format!("SELECT to_jsonb(r) AS value FROM {}.{} r", quote(&schema), quote(&table))
            }).collect::<Vec<_>>().join(" UNION ALL ");
            read_rows(c.client()?, &query).await
        }.await;
        c.end_transaction(result.is_ok()).await?;
        result
    }
    pub async fn finish(self) -> Result<()> {
        self.connection.close(false).await
    }
}

async fn create_database(c: &Connection, name: &str) -> Result<()> {
    c.client()?
        .batch_execute("SET statement_timeout = '120s'")
        .await
        .map_err(|e| pg_error(&format!("PostgreSQL create settings {name}"), e))?;
    tokio::time::timeout(
        DROP_TIMEOUT,
        c.client()?
            .batch_execute(&format!("CREATE DATABASE {}", quote(name))),
    )
    .await
    .map_err(|_| {
        store(
            &format!("PostgreSQL create database {name}"),
            "timed out after 120s",
        )
    })?
    .map_err(|e| pg_error(&format!("PostgreSQL create database {name}"), e))
}

pub struct Database {
    pub uri: String,
    owner: Option<(String, String)>,
    registry: Option<Registry>,
}
impl Database {
    pub fn observer(uri: String) -> Self {
        Self {
            uri,
            owner: None,
            registry: None,
        }
    }
    pub async fn create(root: &str, name: &str, registry: &Registry) -> Result<Self> {
        let c = connect(root).await?;
        registry.add_postgres(root, name);
        let result = create_database(&c, name).await;
        if let Err(error) = result {
            return c.finish(Err(error)).await;
        }
        c.finish(Ok(Self {
            uri: database_uri(root, name)?,
            owner: Some((root.into(), name.into())),
            registry: Some(registry.clone()),
        }))
        .await
    }
    pub async fn time_observer(&self) -> Result<TimeObserver> {
        Ok(TimeObserver {
            connection: connect(&self.uri).await?,
        })
    }
    pub async fn execute(&self, sql: &str) -> Result<()> {
        let c = connect(&self.uri).await?;
        let result = c
            .client()?
            .batch_execute(sql)
            .await
            .map_err(|e| pg_error("PostgreSQL seed", e));
        c.finish(result).await
    }
    pub async fn reset(&self) -> Result<()> {
        let (root, name) = self
            .owner
            .as_ref()
            .ok_or_else(|| config("cannot reset an unowned PostgreSQL database"))?;
        if drop_database(root, name).await?
            && let Some(registry) = &self.registry
        {
            registry.note_postgres_force(name);
        }
        let c = connect(root).await?;
        let result = create_database(&c, name).await;
        c.finish(result).await
    }
    /// Read-only transaction: SQL steps cannot accidentally mutate state.
    pub async fn read(&self, sql: &str) -> Result<Value> {
        let mut c = connect(&self.uri).await?;
        c.transaction = true;
        let result = async {
            c.client()?
                .batch_execute("BEGIN READ ONLY")
                .await
                .map_err(|e| pg_error("PostgreSQL read", e))?;
            read_rows(c.client()?, sql).await
        }
        .await;
        c.finish(result).await
    }
    pub async fn snapshot(&self) -> Result<Value> {
        let mut c = connect(&self.uri).await?;
        c.transaction = true;
        let result = async {
        c.client()?
            .batch_execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .await
            .map_err(|e| pg_error("PostgreSQL snapshot", e))?;
        let tables = c.client()?.query("SELECT n.nspname, c.relname, c.relkind::text, pg_get_expr(c.relpartbound,c.oid), pg_get_partkeydef(c.oid), CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid) END FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f') ORDER BY 1,2", &[]).await.map_err(|e| pg_error("PostgreSQL tables", e))?;
        let mut out = serde_json::Map::new();
        for table in tables {
            let schema: String = table.get(0);
            let name: String = table.get(1);
            let kind: String = table.get(2);
            let qualified = format!("{}.{}", quote(&schema), quote(&name));
            let columns = catalogue(c.client()?, "SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS not_null, pg_get_expr(d.adbin,d.adrelid) AS default, a.attidentity::text AS identity, a.attgenerated::text AS generated, a.attnum AS position, co.collname AS collation FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation WHERE a.attrelid=$1::text::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum", &qualified).await?;
            let indexes = catalogue(c.client()?, "SELECT ci.relname AS name, pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid AS valid FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid WHERE i.indrelid=$1::text::regclass ORDER BY ci.relname", &qualified).await?;
            let constraints = catalogue(c.client()?, "SELECT conname AS name, pg_get_constraintdef(oid) AS definition, convalidated AS validated FROM pg_constraint WHERE conrelid=$1::text::regclass ORDER BY conname", &qualified).await?;
            let rows = read_rows(c.client()?, &format!("SELECT * FROM {qualified}")).await?;
            out.insert(format!("{schema}.{name}"), json!({"kind":kind, "partition_bound":table.get::<_,Option<String>>(3), "partition_key":table.get::<_,Option<String>>(4), "view":table.get::<_,Option<String>>(5), "columns":columns, "indexes":indexes, "constraints":constraints, "rows":rows}));
        }
        Ok(Value::Object(out))
        }.await;
        c.finish(result).await
    }
}
async fn catalogue(c: &Client, sql: &str, name: &str) -> Result<Value> {
    let q = format!("SELECT to_jsonb(r) FROM ({sql}) r");
    let rows = c
        .query(&q, &[&name])
        .await
        .map_err(|e| pg_error("PostgreSQL catalogue", e))?;
    Ok(Value::Array(
        rows.into_iter().map(|r| r.get::<_, Value>(0)).collect(),
    ))
}
async fn read_rows(c: &Client, sql: &str) -> Result<Value> {
    let sql = sql.trim().trim_end_matches(';');
    let q = format!("SELECT to_jsonb(r) FROM ({sql}) r LIMIT {}", MAX_ROWS + 1);
    let rows = c
        .query(&q, &[])
        .await
        .map_err(|e| pg_error("PostgreSQL SQL/rows", e))?;
    if rows.len() > MAX_ROWS {
        return Err(config(
            "PostgreSQL query exceeds 20000 rows; refusing a truncated comparison",
        ));
    }
    Ok(Value::Array(
        rows.into_iter().map(|r| r.get::<_, Value>(0)).collect(),
    ))
}

/// Recover databases abandoned by processes that no longer exist (including SIGKILL).
pub async fn gc(uri: &str) -> Result<Vec<String>> {
    let c = connect(uri).await?;
    let result = async {
        let rows = c
            .client()?
            .query(
                "SELECT datname FROM pg_database WHERE datname LIKE 'rig_%'",
                &[],
            )
            .await
            .map_err(|e| pg_error("PostgreSQL gc", e))?;
        let mut dropped = Vec::new();
        for row in rows {
            let name: String = row.get(0);
            let pid = name
                .strip_prefix("rig_")
                .and_then(|s| s.split('_').next())
                .and_then(|s| s.parse::<u32>().ok());
            if let Some(pid) = pid
                && !std::path::Path::new(&format!("/proc/{pid}")).exists()
            {
                let forced = drop_database(uri, &name).await?;
                dropped.push(format!(
                    "PostgreSQL database {name}{}",
                    if forced { " (FORCE)" } else { "" }
                ));
            }
        }
        Ok(dropped)
    }
    .await;
    c.finish(result).await
}

fn pg_error(context: &str, e: tokio_postgres::Error) -> crate::error::RigError {
    match e.as_db_error() {
        Some(d) => store(
            context,
            format!("{} (SQLSTATE {})", d.message(), d.code().code()),
        ),
        None => store(context, e),
    }
}

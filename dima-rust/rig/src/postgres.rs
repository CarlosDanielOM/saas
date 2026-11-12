//! Disposable PostgreSQL databases. The catalogue is compared separately from row values.
use crate::error::{Result, config, store};
use crate::stores::Registry;
use serde_json::{Value, json};
use std::time::Duration;
use tokio_postgres::{Client, NoTls};

const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_ROWS: usize = 20_000;

struct Connection {
    client: Client,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn connect(uri: &str) -> Result<Connection> {
    let cfg: tokio_postgres::Config = uri.parse().map_err(|_| config("invalid PostgreSQL URI"))?;
    if cfg.get_hosts().iter().any(|h| !matches!(h, tokio_postgres::config::Host::Tcp(s) if s == "127.0.0.1" || s == "localhost" || s == "::1")) {
        return Err(config("PostgreSQL must be on loopback"));
    }
    let (client, connection) = tokio::time::timeout(TIMEOUT, cfg.connect(NoTls))
        .await
        .map_err(|_| store("PostgreSQL connect", "timed out"))?
        .map_err(|_| {
            store(
                "PostgreSQL connect",
                "connection failed (credentials redacted)",
            )
        })?;
    let task = tokio::spawn(async move {
        let _ = connection.await;
    });
    let c = Connection { client, task };
    c.client
        .batch_execute("SET statement_timeout = '15s'; SET timezone = 'UTC'")
        .await
        .map_err(|e| pg_error("PostgreSQL settings", e))?;
    Ok(c)
}
fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
fn database_uri(uri: &str, name: &str) -> Result<String> {
    let mut u = reqwest::Url::parse(uri).map_err(|_| config("invalid PostgreSQL URI"))?;
    u.set_path(&format!("/{name}"));
    Ok(u.to_string())
}
pub async fn drop_database(uri: &str, name: &str) -> Result<()> {
    if !name.starts_with("rig_") || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(config("refusing to drop a non-rig PostgreSQL database"));
    }
    let c = connect(uri).await?;
    c.client
        .batch_execute(&format!(
            "DROP DATABASE IF EXISTS {} WITH (FORCE)",
            quote(name)
        ))
        .await
        .map_err(|e| pg_error("PostgreSQL drop database", e))
}

pub struct Database {
    pub uri: String,
    owner: Option<(String, String)>,
}
impl Database {
    pub fn observer(uri: String) -> Self {
        Self { uri, owner: None }
    }
    pub async fn create(root: &str, name: &str, registry: &Registry) -> Result<Self> {
        let c = connect(root).await?;
        registry.add_postgres(root, name);
        c.client
            .batch_execute(&format!("CREATE DATABASE {}", quote(name)))
            .await
            .map_err(|e| pg_error("PostgreSQL create database", e))?;
        Ok(Self {
            uri: database_uri(root, name)?,
            owner: Some((root.into(), name.into())),
        })
    }
    pub async fn execute(&self, sql: &str) -> Result<()> {
        let c = connect(&self.uri).await?;
        c.client
            .batch_execute(sql)
            .await
            .map_err(|e| pg_error("PostgreSQL seed", e))
    }
    pub async fn reset(&self) -> Result<()> {
        let (root, name) = self
            .owner
            .as_ref()
            .ok_or_else(|| config("cannot reset an unowned PostgreSQL database"))?;
        drop_database(root, name).await?;
        let c = connect(root).await?;
        c.client
            .batch_execute(&format!("CREATE DATABASE {}", quote(name)))
            .await
            .map_err(|e| pg_error("PostgreSQL recreate database", e))
    }
    /// Read-only transaction: SQL steps cannot accidentally mutate state.
    pub async fn read(&self, sql: &str) -> Result<Value> {
        let c = connect(&self.uri).await?;
        c.client
            .batch_execute("BEGIN READ ONLY")
            .await
            .map_err(|e| pg_error("PostgreSQL read", e))?;
        read_rows(&c.client, sql).await
    }
    pub async fn snapshot(&self) -> Result<Value> {
        let c = connect(&self.uri).await?;
        c.client
            .batch_execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .await
            .map_err(|e| pg_error("PostgreSQL snapshot", e))?;
        let tables = c.client.query("SELECT n.nspname, c.relname, c.relkind::text, pg_get_expr(c.relpartbound,c.oid), pg_get_partkeydef(c.oid), CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid) END FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f') ORDER BY 1,2", &[]).await.map_err(|e| pg_error("PostgreSQL tables", e))?;
        let mut out = serde_json::Map::new();
        for table in tables {
            let schema: String = table.get(0);
            let name: String = table.get(1);
            let kind: String = table.get(2);
            let qualified = format!("{}.{}", quote(&schema), quote(&name));
            let columns = catalogue(&c.client, "SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS not_null, pg_get_expr(d.adbin,d.adrelid) AS default, a.attidentity::text AS identity, a.attgenerated::text AS generated, a.attnum AS position, co.collname AS collation FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation WHERE a.attrelid=$1::text::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum", &qualified).await?;
            let indexes = catalogue(&c.client, "SELECT ci.relname AS name, pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid AS valid FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid WHERE i.indrelid=$1::text::regclass ORDER BY ci.relname", &qualified).await?;
            let constraints = catalogue(&c.client, "SELECT conname AS name, pg_get_constraintdef(oid) AS definition, convalidated AS validated FROM pg_constraint WHERE conrelid=$1::text::regclass ORDER BY conname", &qualified).await?;
            let rows = read_rows(&c.client, &format!("SELECT * FROM {qualified}")).await?;
            out.insert(format!("{schema}.{name}"), json!({"kind":kind, "partition_bound":table.get::<_,Option<String>>(3), "partition_key":table.get::<_,Option<String>>(4), "view":table.get::<_,Option<String>>(5), "columns":columns, "indexes":indexes, "constraints":constraints, "rows":rows}));
        }
        Ok(Value::Object(out))
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
    let rows = c
        .client
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
            drop_database(uri, &name).await?;
            dropped.push(format!("PostgreSQL database {name}"));
        }
    }
    Ok(dropped)
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

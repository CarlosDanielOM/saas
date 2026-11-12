//! Shared harness: the local MongoDB and Dragonfly from `tools/test-env`, a throwaway
//! `dima_test_cron_<random>` database dropped afterwards, Dragonfly logical database 11 with a
//! unique key prefix removed afterwards, and the `dima-cron` binary started as a child process.
//! Without the stores a test skips with a notice, unless `DIMA_TEST_REQUIRE_STORES=1` (then it
//! fails).
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use anyhow::{Context, Result, bail};
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Hooks};
use dima_store::mongo::{MongoConfig, MongoStore};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The logical database of Dragonfly the cron's tests use.
pub const DRAGONFLY_DATABASE: u8 = 11;
/// A 32-byte test key for the credential cipher.
pub const TEST_SECRET_KEY: &str = "dima-cron-test-key-0123456789abc";

pub fn stores_required() -> bool {
    std::env::var("DIMA_TEST_REQUIRE_STORES").as_deref() == Ok("1")
}

/// The local stores, or `None` (skip) when they are not configured and not required.
pub fn store_env() -> Result<Option<(String, String)>> {
    match (
        std::env::var("DIMA_TEST_MONGO_URI"),
        std::env::var("DIMA_TEST_DRAGONFLY"),
    ) {
        (Ok(mongo), Ok(dragonfly)) => Ok(Some((mongo, dragonfly))),
        _ if stores_required() => bail!("DIMA_TEST_MONGO_URI and DIMA_TEST_DRAGONFLY are required"),
        _ => {
            eprintln!("skipped: local stores not configured");
            Ok(None)
        }
    }
}

/// A unique name: `dima_test_cron_<32 hex>`.
pub fn unique() -> String {
    format!("dima_test_cron_{}", uuid::Uuid::new_v4().simple())
}

pub async fn dragonfly(address: &str) -> Result<Dragonfly> {
    let (host, port) = address.rsplit_once(':').context("host:port")?;
    Ok(Dragonfly::connect(
        DragonflyConfig::from_env_values(
            Some(host),
            Some(&format!("{port}/{DRAGONFLY_DATABASE}")),
            "cron-tests",
        ),
        Hooks::default(),
    )
    .await?)
}

pub async fn mongo(uri: &str, database: &str) -> Result<MongoStore> {
    let mut config = MongoConfig::new(uri);
    config.database = Some(database.to_owned());
    config.server_selection_timeout = Some(Duration::from_secs(5));
    Ok(MongoStore::connect(&config, None).await?)
}

/// Deletes every key under `prefix`.
pub async fn clean_prefix(dragonfly: &Dragonfly, prefix: &str) -> Result<()> {
    let mut scan = dragonfly.scan(&format!("{prefix}*"), Some(500));
    while let Some(page) = scan.next_page().await? {
        for key in page {
            dragonfly.del(&[std::str::from_utf8(&key)?]).await?;
        }
    }
    Ok(())
}

/// The stores of one test: its own database and key prefix, removed by [`Stores::clean`].
pub struct Stores {
    pub mongo_uri: String,
    pub dragonfly_address: String,
    pub database: String,
    pub prefix: String,
    pub mongo: MongoStore,
    pub dragonfly: Dragonfly,
}

impl Stores {
    pub async fn new() -> Result<Option<Self>> {
        let Some((mongo_uri, dragonfly_address)) = store_env()? else {
            return Ok(None);
        };
        let database = unique();
        let prefix = format!("{database}:");
        Ok(Some(Self {
            mongo: mongo(&mongo_uri, &database).await?,
            dragonfly: dragonfly(&dragonfly_address).await?,
            mongo_uri,
            dragonfly_address,
            database,
            prefix,
        }))
    }

    /// Drops the database and the keys. A `dima-cron` child may have sent a write it then gave
    /// up on (a store deadline under load) that the server runs after the drop and that creates
    /// the database again: the drop is repeated while it reappears within a few seconds.
    pub async fn clean(&self) -> Result<()> {
        self.mongo.database().drop().await?;
        for _ in 0..12 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let names = self.mongo.client().list_database_names().await?;
            if names.contains(&self.database) {
                self.mongo.database().drop().await?;
            }
        }
        clean_prefix(&self.dragonfly, &self.prefix).await
    }

    /// The environment of a `dima-cron` child on these stores: its own database (named in the
    /// URI), Dragonfly database 11, the key prefix, no telemetry export.
    pub fn cron_env(&self, workers: &str) -> Vec<(String, String)> {
        let (host, port) = self
            .dragonfly_address
            .rsplit_once(':')
            .unwrap_or((&self.dragonfly_address, "6379"));
        let uri = with_database(&self.mongo_uri, &self.database);
        vec![
            ("MONGO_URI".to_owned(), uri),
            ("DRAGONFLY_HOST".to_owned(), host.to_owned()),
            (
                "DRAGONFLY_PORT".to_owned(),
                format!("{port}/{DRAGONFLY_DATABASE}"),
            ),
            ("SECRET_KEY".to_owned(), TEST_SECRET_KEY.to_owned()),
            ("CLIENT_ID".to_owned(), "test-client-id".to_owned()),
            ("CLIENT_SECRET".to_owned(), "test-client-secret".to_owned()),
            ("OBSERVABILITY_DISABLED".to_owned(), "true".to_owned()),
            ("CRON_KEY_PREFIX".to_owned(), self.prefix.clone()),
            ("CRON_WORKERS".to_owned(), workers.to_owned()),
            ("NODE_ENV".to_owned(), "production".to_owned()),
        ]
    }
}

/// `uri` (`mongodb://host:port/?options`) naming `database` in its path.
pub fn with_database(uri: &str, database: &str) -> String {
    let (base, query) = uri.split_once('?').unwrap_or((uri, ""));
    let base = base.trim_end_matches('/');
    if query.is_empty() {
        format!("{base}/{database}")
    } else {
        format!("{base}/{database}?{query}")
    }
}

/// Now, in epoch milliseconds.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

/// Telemetry's cache log entries (`logger:{platform}:{channel}:{level}:{ms}-{suffix}`) in
/// database 11 written since `since_ms` whose value mentions one of `markers`, deleted: the
/// Twitch crate logs some entries with the destination `both`, which the reference writes to the
/// Dragonfly debug log, and the tests leave nothing behind. Database 11 is the cron tests' own.
pub async fn clean_log_entries(
    dragonfly: &Dragonfly,
    since_ms: i64,
    markers: &[&str],
) -> Result<usize> {
    let mut keys = Vec::new();
    let mut scan = dragonfly.scan("logger:*", Some(500));
    while let Some(page) = scan.next_page().await? {
        keys.extend(page);
    }
    let mut removed = 0;
    for key in keys {
        let key = String::from_utf8(key)?;
        let written = key
            .rsplit(':')
            .next()
            .and_then(|last| last.split('-').next())
            .and_then(|ms| ms.parse::<i64>().ok())
            .unwrap_or(0);
        if written < since_ms {
            continue;
        }
        let value = dragonfly.get(&key).await?.unwrap_or_default();
        let value = String::from_utf8_lossy(&value);
        if markers.iter().any(|marker| value.contains(marker)) {
            dragonfly.del(&[&key]).await?;
            removed += 1;
        }
    }
    Ok(removed)
}

pub const BINARY: &str = env!("CARGO_BIN_EXE_dima-cron");

/// A `dima-cron` child process; killed if the test ends first.
pub struct Cron {
    pub child: Child,
    pub lines: Arc<Mutex<Vec<String>>>,
    pub stderr: Arc<Mutex<Vec<String>>>,
    dir: std::path::PathBuf,
}

impl Drop for Cron {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn collect(stream: impl std::io::Read + Send + 'static) -> Arc<Mutex<Vec<String>>> {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&lines);
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            sink.lock().unwrap().push(line);
        }
    });
    lines
}

impl Cron {
    /// Starts the binary with `args` and exactly `env`, in an empty directory (no `.env`).
    pub fn start(env: &[(String, String)], args: &[&str]) -> Result<Self> {
        let dir = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(unique());
        std::fs::create_dir_all(&dir)?;
        let mut child = Command::new(BINARY)
            .args(args)
            .env_clear()
            .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .current_dir(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let lines = collect(child.stdout.take().context("stdout")?);
        let stderr = collect(child.stderr.take().context("stderr")?);
        Ok(Self {
            child,
            lines,
            stderr,
            dir,
        })
    }

    pub fn pid(&self) -> nix::unistd::Pid {
        nix::unistd::Pid::from_raw(i32::try_from(self.child.id()).unwrap_or(i32::MAX))
    }

    /// The console lines so far, parsed.
    pub fn json_lines(&self) -> Vec<serde_json::Value> {
        self.lines
            .lock()
            .unwrap()
            .iter()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    /// Waits until a console line's `data` satisfies `check`.
    pub fn wait_line(
        &self,
        what: &str,
        timeout: Duration,
        check: impl Fn(&serde_json::Value) -> bool,
    ) -> Result<serde_json::Value> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(found) = self
                .json_lines()
                .into_iter()
                .find(|line| check(&line["data"]))
            {
                return Ok(found["data"].clone());
            }
            if Instant::now() > deadline {
                bail!(
                    "no line {what} within {timeout:?}; stdout {:#?}; stderr {:?}",
                    self.lines.lock().unwrap(),
                    self.stderr.lock().unwrap()
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Sends `signal` and waits for the exit status.
    pub fn stop(&mut self, signal: nix::sys::signal::Signal, timeout: Duration) -> Result<i32> {
        nix::sys::signal::kill(self.pid(), signal)?;
        self.wait_exit(timeout)
    }

    pub fn wait_exit(&mut self, timeout: Duration) -> Result<i32> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait()? {
                // Let the readers take the last lines.
                std::thread::sleep(Duration::from_millis(50));
                return status.code().context("killed by a signal");
            }
            if Instant::now() > deadline {
                bail!("still running after {timeout:?}");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

/// Waits (real time) until `check` holds, polling every 50 ms.
pub async fn eventually<F, Fut>(what: &str, timeout: Duration, mut check: F) -> Result<()>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<bool>>,
{
    let deadline = Instant::now() + timeout;
    loop {
        if check().await? {
            return Ok(());
        }
        if Instant::now() > deadline {
            bail!("{what}: not within {timeout:?}");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

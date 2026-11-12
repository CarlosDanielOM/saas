//! PostgreSQL adapter: explicit SQL, bounded calls, atomic receipts and observations.
use crate::{Error, Result, batch};
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tokio_postgres::{Client, NoTls, types::ToSql};
#[derive(Clone)]
pub struct Store {
    config: Arc<tokio_postgres::Config>,
    idle: Arc<std::sync::Mutex<tokio::sync::mpsc::Receiver<Connection>>>,
    returns: tokio::sync::mpsc::Sender<Connection>,
    slots: Arc<tokio::sync::Semaphore>,
    closing: Arc<std::sync::atomic::AtomicBool>,
}
struct Connection {
    client: Client,
    driver: tokio::task::JoinHandle<()>,
    used: tokio::time::Instant,
}
struct Lease {
    connection: Option<Connection>,
    returns: tokio::sync::mpsc::Sender<Connection>,
    permit: Option<tokio::sync::OwnedSemaphorePermit>,
    complete: bool,
}
impl Lease {
    fn client(&mut self) -> Result<&mut Client> {
        self.connection
            .as_mut()
            .map(|c| &mut c.client)
            .ok_or(Error::Config)
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        let Some(mut c) = self.connection.take() else {
            return;
        };
        if self.complete {
            // Every call on this connection has returned, so no statement is in flight; a
            // transaction that ended early queued its rollback when it was dropped, ahead of
            // whatever the next borrower sends.
            c.used = tokio::time::Instant::now();
            let _ = self.returns.try_send(c);
            return;
        }
        // The borrower was dropped while a statement may still be running (a deadline, a
        // client that went away). The slot stays taken until PostgreSQL has stopped that work,
        // and the connection is retired: a CancelRequest is not acknowledged, and a late one
        // must not hit the next borrower's statement.
        let permit = self.permit.take();
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        runtime.spawn(async move {
            let _permit = permit;
            let _ = c.client.cancel_token().cancel_query(NoTls).await;
            let _ = c.client.batch_execute("ROLLBACK").await;
            drop(c.client);
            let _ = c.driver.await;
        });
    }
}
impl Store {
    async fn open(config: &tokio_postgres::Config) -> Result<Connection> {
        let (client, connection) =
            tokio::time::timeout(Duration::from_secs(3), config.connect(NoTls))
                .await
                .map_err(|_| Error::Timeout)??;
        let driver = tokio::spawn(async move {
            let _ = connection.await;
        });
        Ok(Connection {
            client,
            driver,
            used: tokio::time::Instant::now(),
        })
    }
    pub async fn connect(uri: &str) -> Result<Self> {
        let mut config: tokio_postgres::Config = uri.parse()?;
        config.connect_timeout(Duration::from_secs(3));
        config.options("-c statement_timeout=8000");
        config.application_name(format!("dima-analytics-{}", uuid::Uuid::new_v4().simple()));
        let first = Self::open(&config).await?;
        let (returns, idle) = tokio::sync::mpsc::channel(5);
        returns.try_send(first).map_err(|_| Error::Config)?;
        Ok(Self {
            config: Arc::new(config),
            idle: Arc::new(std::sync::Mutex::new(idle)),
            returns,
            slots: Arc::new(tokio::sync::Semaphore::new(5)),
            closing: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        })
    }
    async fn lease(&self) -> Result<Lease> {
        let permit =
            tokio::time::timeout(Duration::from_secs(3), self.slots.clone().acquire_owned())
                .await
                .map_err(|_| Error::Timeout)?
                .map_err(|_| Error::Config)?;
        if self.closing.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(Error::Config);
        }
        let saved = self.idle.lock().map_err(|_| Error::Config)?.try_recv().ok();
        let connection = match saved {
            Some(c) if !c.client.is_closed() && c.used.elapsed() < Duration::from_secs(30) => c,
            other => {
                if let Some(c) = other {
                    drop(c.client);
                    let _ = c.driver.await;
                }
                Self::open(&self.config).await?
            }
        };
        Ok(Lease {
            connection: Some(connection),
            returns: self.returns.clone(),
            permit: Some(permit),
            complete: false,
        })
    }
    /// Shutdown: refuses new borrowers, waits for every borrower and its cleanup, then ends
    /// each connection and waits for its driver. Afterwards it gives the backends up to two
    /// seconds to disappear (see [`Store::close_confirmed`]) without making that a condition:
    /// a role that may not open the maintenance database still shuts down cleanly.
    pub async fn close(&self) -> Result<()> {
        self.drain().await?;
        let _ = self.backends_gone(Duration::from_secs(2)).await;
        Ok(())
    }
    /// [`Store::close`], failing unless PostgreSQL shows that every backend of this store has
    /// ended. For whoever drops the database next (tests, the rig): a driver that has finished
    /// has sent Terminate, which is not yet the backend being gone. Needs CONNECT on the
    /// `postgres` maintenance database.
    pub async fn close_confirmed(&self) -> Result<()> {
        self.drain().await?;
        self.backends_gone(Duration::from_secs(9)).await
    }
    async fn drain(&self) -> Result<()> {
        self.closing
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let _permits = self
            .slots
            .acquire_many(5)
            .await
            .map_err(|_| Error::Config)?;
        loop {
            let c = self.idle.lock().map_err(|_| Error::Config)?.try_recv().ok();
            let Some(c) = c else { break };
            drop(c.client);
            c.driver.await.map_err(|_| Error::Config)?;
        }
        Ok(())
    }
    async fn backends_gone(&self, within: Duration) -> Result<()> {
        let name = self.config.get_application_name().ok_or(Error::Config)?;
        let mut config = (*self.config).clone();
        config
            .dbname("postgres")
            .application_name("dima-analytics-close");
        let observer = Self::open(&config).await?;
        let result = tokio::time::timeout(within, async {
            loop {
                if observer
                    .client
                    .query(
                        "SELECT 1 FROM pg_stat_activity WHERE application_name=$1",
                        &[&name],
                    )
                    .await?
                    .is_empty()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Ok::<_, Error>(())
        })
        .await
        .map_err(|_| Error::Timeout);
        drop(observer.client);
        observer.driver.await.map_err(|_| Error::Config)?;
        result?
    }
    pub async fn execute(&self, sql: &str, args: &[&(dyn ToSql + Sync)]) -> Result<u64> {
        tokio::time::timeout(Duration::from_secs(9), async {
            let mut lease = self.lease().await?;
            let result = lease.client()?.execute(sql, args).await;
            lease.complete = true;
            Ok(result?)
        })
        .await
        .map_err(|_| Error::Timeout)?
    }
    pub async fn query(
        &self,
        sql: &str,
        args: &[&(dyn ToSql + Sync)],
    ) -> Result<Vec<tokio_postgres::Row>> {
        tokio::time::timeout(Duration::from_secs(9), async {
            let mut lease = self.lease().await?;
            let result = lease.client()?.query(sql, args).await;
            lease.complete = true;
            Ok(result?)
        })
        .await
        .map_err(|_| Error::Timeout)?
    }
    pub async fn migrate(&self, now: i64) -> Result<()> {
        tokio::time::timeout(Duration::from_secs(9), async {
            let mut lease = self.lease().await?;
            lease
                .client()?
                .batch_execute(include_str!("schema.sql"))
                .await?;
            lease.complete = true;
            Ok::<_, Error>(())
        })
        .await
        .map_err(|_| Error::Timeout)??;
        self.partitions(now).await
    }
    pub async fn partitions(&self, now: i64) -> Result<()> {
        for offset in -1..=2 {
            let date = dima_text::to_iso_string(now + offset * 86400000)
                .ok_or(Error::Invalid("Invalid time"))?;
            let date = date.get(..10).ok_or(Error::Invalid("Invalid time"))?;
            let next = dima_text::to_iso_string(
                dima_text::parse_date(date).ok_or(Error::Invalid("Invalid time"))? + 86400000,
            )
            .ok_or(Error::Invalid("Invalid time"))?;
            let next = next.get(..10).ok_or(Error::Invalid("Invalid time"))?;
            for table in ["metrics", "spans", "logs", "resources"] {
                self.execute(&format!("CREATE TABLE IF NOT EXISTS analytics_{table}_{} PARTITION OF analytics_{table} FOR VALUES FROM ('{date}') TO ('{next}')",date.replace('-',"")),&[]).await?;
            }
        }
        Ok(())
    }
    pub async fn ingest(&self, batch: &Value, now: i64) -> Result<bool> {
        batch::validate(batch, now)?;
        tokio::time::timeout(Duration::from_secs(35), async {
            let mut lease = self.lease().await?;
            let stored = Self::ingest_on(lease.client()?, batch).await;
            // Also after an error: the transaction queued its rollback when it was dropped, so
            // a refused batch does not cost a connection.
            lease.complete = true;
            stored
        })
        .await
        .map_err(|_| Error::Timeout)?
    }
    async fn ingest_on(client: &mut Client, batch: &Value) -> Result<bool> {
        let tx = client.transaction().await?;
        let id = batch["id"].as_str().unwrap_or("");
        let receipt = tx.query("INSERT INTO analytics_batches(id) VALUES($1::text::uuid) ON CONFLICT DO NOTHING RETURNING id", &[&id]).await?;
        if receipt.is_empty() {
            tx.rollback().await?;
            return Ok(false);
        }
        let service = batch["service"].as_str().unwrap_or("");
        for (key, sql) in [
            ("metrics", include_str!("metrics.sql")),
            ("spans", include_str!("spans.sql")),
            ("logs", include_str!("logs.sql")),
        ] {
            if batch[key].as_array().is_some_and(|a| !a.is_empty()) {
                tx.execute(sql, &[&batch[key], &service]).await?;
            }
        }
        tx.commit().await?;
        Ok(true)
    }
    pub async fn retain(&self, now: i64) -> Result<()> {
        self.partitions(now).await?;
        for sql in [
            "DELETE FROM analytics_batches WHERE received_at < now() - interval '2 days'",
            "DELETE FROM analytics_metrics WHERE (resolution=10 AND at < now()-interval '2 days') OR (resolution=60 AND at < now()-interval '30 days')",
            "DELETE FROM analytics_audit WHERE at < now()-interval '365 days'",
        ] {
            self.execute(sql, &[]).await?;
        }
        for row in self.query("SELECT relname FROM pg_class WHERE relname ~ '^analytics_(metrics|spans|logs|resources)_[0-9]{8}$'",&[]).await?{let name:String=row.get(0);let Some((prefix,date))=name.rsplit_once('_')else{continue};let days=match prefix{"analytics_metrics"=>365,"analytics_spans"=>3,"analytics_logs"=>7,"analytics_resources"=>30,_=>continue};let Some(date)=date.get(..4).zip(date.get(4..6)).zip(date.get(6..8)).and_then(|((y,m),d)|dima_text::parse_date(&format!("{y}-{m}-{d}")))else{continue};if date+86400000<now-days*86400000{self.execute(&format!("DROP TABLE {name}"),&[]).await?;}}
        Ok(())
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use anyhow::Context;
    use futures_util::FutureExt;
    use std::{future::Future, panic::AssertUnwindSafe};

    async fn fixture_sql(uri: &str, sql: &str) -> anyhow::Result<()> {
        let mut config: tokio_postgres::Config = uri.parse()?;
        config.options("-c statement_timeout=60000");
        let (client, connection) = config.connect(NoTls).await?;
        let driver = tokio::spawn(connection);
        let result = client.batch_execute(sql).await;
        drop(client);
        driver.await??;
        result?;
        Ok(())
    }
    async fn fixture<F, Fut>(check: F) -> anyhow::Result<()>
    where
        F: FnOnce(Store, Store, String) -> Fut,
        Fut: Future<Output = anyhow::Result<()>>,
    {
        let uri = std::env::var("DIMA_TEST_POSTGRES_URI")?;
        let admin = Store::connect(&uri).await?;
        let name = format!("dima_test_analytics_{}", uuid::Uuid::new_v4().simple());
        fixture_sql(&uri, &format!("CREATE DATABASE {name}")).await?;
        let mut url = url::Url::parse(&uri)?;
        url.set_path(&name);
        let store = Store::connect(url.as_str()).await?;
        let result = AssertUnwindSafe(check(store.clone(), admin.clone(), name.clone()))
            .catch_unwind()
            .await;
        let closed = store.close_confirmed().await;
        let dropped = fixture_sql(&uri, &format!("DROP DATABASE {name} WITH (FORCE)")).await;
        admin.close_confirmed().await?;
        closed.context("fixture close")?;
        dropped.context("fixture drop")?;
        match result {
            Ok(r) => r,
            Err(p) => std::panic::resume_unwind(p),
        }
    }
    async fn no_pending(admin: &Store, name: &str) -> anyhow::Result<()> {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let rows = admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND (state LIKE 'idle in transaction%' OR query LIKE 'SELECT pg_sleep%')", &[&name]).await?;
                if rows.is_empty() { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Ok::<_, Error>(())
        }).await??;
        Ok(())
    }
    #[tokio::test]
    async fn cancellation_rolls_back_and_cancels_server_work() -> anyhow::Result<()> {
        fixture(|store, admin, name| async move {
            store
                .execute("CREATE TABLE cancellation_probe(id int)", &[])
                .await?;
            let cancelled = tokio::time::timeout(Duration::from_millis(200), async {
                let mut lease = store.lease().await?;
                let tx = lease.client()?.transaction().await?;
                tx.execute("INSERT INTO cancellation_probe VALUES(1)", &[])
                    .await?;
                tx.query("SELECT pg_sleep(30)", &[]).await?;
                tx.commit().await?;
                Ok::<_, Error>(())
            })
            .await;
            assert!(cancelled.is_err());
            no_pending(&admin, &name)
                .await
                .context("no pending query")?;
            assert!(
                store
                    .query("SELECT * FROM cancellation_probe", &[])
                    .await?
                    .is_empty()
            );
            Ok(())
        })
        .await
    }
    #[tokio::test]
    async fn client_deadline_cancels_query_on_server() -> anyhow::Result<()> {
        fixture(|store, admin, name| async move {
            // Deliberately disable the server deadline to exercise the client deadline.
            store.execute("SET statement_timeout=0", &[]).await?;
            let permits = store.slots.acquire_many(5).await?;
            drop(permits);
            assert!(matches!(
                store.query("SELECT pg_sleep(30)", &[]).await,
                Err(Error::Timeout)
            ));
            no_pending(&admin, &name)
                .await
                .context("no pending query")?;
            assert_eq!(
                store
                    .query("SELECT 1", &[])
                    .await
                    .context("reuse after deadline")?
                    .len(),
                1
            );
            Ok(())
        })
        .await
    }
    #[tokio::test]
    async fn close_drains_all_connections_and_rejects_new_borrowers() -> anyhow::Result<()> {
        fixture(|store, admin, name| async move {
            let mut tasks = Vec::new();
            for _ in 0..5 {
                let s = store.clone();
                tasks.push(tokio::spawn(async move {
                    s.query("SELECT pg_sleep(0.1)", &[]).await
                }));
            }
            for t in tasks {
                t.await??;
            }
            store.close_confirmed().await?;
            assert!(
                admin
                    .query("SELECT 1 FROM pg_stat_activity WHERE datname=$1", &[&name])
                    .await?
                    .is_empty()
            );
            assert!(store.query("SELECT 1", &[]).await.is_err());
            Ok(())
        })
        .await
    }
}

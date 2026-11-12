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
}
struct Connection {
    client: Client,
    driver: tokio::task::JoinHandle<()>,
    used: tokio::time::Instant,
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.driver.abort();
    }
}
struct Lease {
    connection: Option<Connection>,
    returns: tokio::sync::mpsc::Sender<Connection>,
    _permit: tokio::sync::OwnedSemaphorePermit,
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
        if let Some(mut c) = self.connection.take() {
            c.used = tokio::time::Instant::now();
            let _ = self.returns.try_send(c);
        }
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
        let first = Self::open(&config).await?;
        let (returns, idle) = tokio::sync::mpsc::channel(5);
        returns.try_send(first).map_err(|_| Error::Config)?;
        Ok(Self {
            config: Arc::new(config),
            idle: Arc::new(std::sync::Mutex::new(idle)),
            returns,
            slots: Arc::new(tokio::sync::Semaphore::new(5)),
        })
    }
    async fn lease(&self) -> Result<Lease> {
        let permit =
            tokio::time::timeout(Duration::from_secs(3), self.slots.clone().acquire_owned())
                .await
                .map_err(|_| Error::Timeout)?
                .map_err(|_| Error::Config)?;
        let saved = self.idle.lock().map_err(|_| Error::Config)?.try_recv().ok();
        let connection = match saved {
            Some(c) if !c.client.is_closed() && c.used.elapsed() < Duration::from_secs(30) => c,
            _ => Self::open(&self.config).await?,
        };
        Ok(Lease {
            connection: Some(connection),
            returns: self.returns.clone(),
            _permit: permit,
        })
    }
    pub async fn execute(&self, sql: &str, args: &[&(dyn ToSql + Sync)]) -> Result<u64> {
        tokio::time::timeout(Duration::from_secs(9), async {
            let mut lease = self.lease().await?;
            Ok(lease.client()?.execute(sql, args).await?)
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
            Ok(lease.client()?.query(sql, args).await?)
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
        tokio::time::timeout(Duration::from_secs(35),async{
 let mut lease=self.lease().await?;let tx=lease.client()?.transaction().await?;
 let id=batch["id"].as_str().unwrap_or("");let receipt=tx.query("INSERT INTO analytics_batches(id) VALUES($1::text::uuid) ON CONFLICT DO NOTHING RETURNING id",&[&id]).await?;
 if receipt.is_empty(){tx.rollback().await?;return Ok(false);}
 let service=batch["service"].as_str().unwrap_or("");
 for (key,sql) in [("metrics",include_str!("metrics.sql")),("spans",include_str!("spans.sql")),("logs",include_str!("logs.sql"))]{if batch[key].as_array().is_some_and(|a|!a.is_empty()){tx.execute(sql,&[&batch[key],&service]).await?;}}
 tx.commit().await?;Ok(true)
 }).await.map_err(|_|Error::Timeout)?
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

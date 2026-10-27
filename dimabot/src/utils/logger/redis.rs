//! Adapter for an already-created caller-owned Redis connection manager.
//! Does not alter its timeout, reconnect, TLS or global settings.
use super::{CacheRecord, CacheSink, SinkError, SinkFuture};
use redis::aio::ConnectionManager;
use std::time::Duration;

pub struct RedisCacheSink {
    connection: ConnectionManager,
    timeout: Duration,
}
impl RedisCacheSink {
    /// Constructor performs no network I/O. Zero deadlines are rejected.
    pub fn new(
        connection: ConnectionManager,
        timeout: Duration,
    ) -> Result<Self, super::ConfigError> {
        if timeout.is_zero() {
            return Err(super::ConfigError);
        }
        Ok(Self {
            connection,
            timeout,
        })
    }
}
impl CacheSink for RedisCacheSink {
    fn store(&self, record: CacheRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            let mut connection = self.connection.clone();
            let mut command = redis::cmd("SET");
            command
                .arg(record.key)
                .arg(record.json.as_ref())
                .arg("EX")
                .arg(record.ttl_seconds);
            tokio::time::timeout(self.timeout, command.query_async::<()>(&mut connection))
                .await
                .map_err(|_| SinkError::Timeout)?
                .map_err(|_| SinkError::Io)
        })
    }
}

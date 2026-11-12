//! A dedicated connection for blocking commands (`BLPOP`, `BRPOP`, `BLMOVE`, `XREAD BLOCK`, ...).
//!
//! In the reference a blocking call holds the worker's only connection for up to 5 seconds. Here
//! it gets its own socket, with no response timeout, so it never delays ordinary commands and is
//! never cut short by their timeout.
//!
//! # Cancellation
//!
//! Dropping the future of a blocking call (a `select!` branch losing, a task aborted on shutdown)
//! must not leave the connection where the next command could read the abandoned reply, nor
//! leave a server-side waiter that would still pop an item nobody receives. So a connection whose
//! command was abandoned is never reused: it is dropped at once (the driver task is aborted and the
//! socket closed, which makes the server drop the waiter), and the next call opens a fresh
//! connection and first sends `CLIENT KILL ID <old id>`, so from that point on the old waiter is
//! certainly gone. Between the drop and the server noticing the closed socket, an item can still be
//! popped by the abandoned `BLPOP` and lost; the same window exists in the reference (a crash after
//! `BLPOP`). Queues where that matters use `BLMOVE` into a processing list, where an item claimed in
//! that window stays recoverable.
//!
//! A blocking call with a server timeout also gets a client-side deadline of that timeout plus
//! [`BLOCKING_GRACE`], so a hung server cannot hold the caller forever; on expiry the connection
//! is abandoned as above and [`DragonflyError::BlockingDeadline`] is returned.

use super::client::{AUTH_REFUSED, Shared, is_auth_refused};
use super::commands::{End, reply};
use super::error::{DragonflyError, Result};
use super::queue::QueueItem;
use dima_text::number_to_string;
use redis::aio::MultiplexedConnection;
use redis::{AsyncConnectionConfig, Cmd, Value};
use std::sync::Arc;
use std::time::Duration;

/// Extra time past a blocking command's own timeout before the client gives up on the reply.
pub const BLOCKING_GRACE: Duration = Duration::from_secs(5);

struct Live {
    connection: MultiplexedConnection,
    id: i64,
}

/// A dedicated, lazily opened connection for blocking commands. One command at a time (`&mut`).
pub struct BlockingConnection {
    shared: Arc<Shared>,
    live: Option<Live>,
    abandoned: Option<i64>,
}

impl std::fmt::Debug for BlockingConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BlockingConnection")
            .field("connection_id", &self.live.as_ref().map(|live| live.id))
            .field("abandoned", &self.abandoned)
            .finish()
    }
}

/// Records the connection id as abandoned unless the command completed.
struct AbandonGuard<'a> {
    slot: &'a mut Option<i64>,
    id: Option<i64>,
}

impl AbandonGuard<'_> {
    fn completed(mut self) {
        self.id = None;
    }
}

impl Drop for AbandonGuard<'_> {
    fn drop(&mut self) {
        if let Some(id) = self.id {
            *self.slot = Some(id);
        }
    }
}

impl BlockingConnection {
    pub(crate) fn new(shared: Arc<Shared>) -> Self {
        Self {
            shared,
            live: None,
            abandoned: None,
        }
    }

    /// The server's id for the current connection (`CLIENT ID`), if one is open. For diagnostics.
    pub fn connection_id(&self) -> Option<i64> {
        self.live.as_ref().map(|live| live.id)
    }

    /// Opens the connection now (otherwise the first command does), and finishes the clean-up of
    /// an abandoned one (see the module docs).
    pub async fn connect(&mut self) -> Result<()> {
        if self.live.is_some() {
            return Ok(());
        }
        let config = AsyncConnectionConfig::new()
            .set_connection_timeout(Some(self.shared.config.connect_timeout))
            .set_response_timeout(None);
        let open = async {
            let mut connection = self
                .shared
                .client
                .get_multiplexed_async_connection_with_config(&config)
                .await?;
            let id: i64 = redis::cmd("CLIENT")
                .arg("ID")
                .query_async(&mut connection)
                .await?;
            if let Some(old) = self.abandoned {
                // 1 when the old waiter was still there, 0 when the server had already dropped it.
                let _: Value = redis::cmd("CLIENT")
                    .arg("KILL")
                    .arg("ID")
                    .arg(old)
                    .query_async(&mut connection)
                    .await?;
            }
            Ok::<_, redis::RedisError>(Live { connection, id })
        };
        let live = match tokio::time::timeout(self.shared.config.connect_timeout * 2, open).await {
            Ok(Ok(live)) => live,
            Ok(Err(error)) if is_auth_refused(&error) => {
                return Err(DragonflyError::Config(AUTH_REFUSED));
            }
            Ok(Err(error)) => return Err(self.failed(error)),
            Err(_) => {
                return Err(self.failed(redis::RedisError::from(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "Dragonfly blocking connection did not open within the connect timeout",
                ))));
            }
        };
        self.abandoned = None;
        self.live = Some(live);
        Ok(())
    }

    /// Runs one command on this connection. `server_timeout` is the timeout the command itself
    /// carries (`None` or zero: it may block forever, so there is no client deadline either).
    pub async fn query_value(
        &mut self,
        cmd: &Cmd,
        server_timeout: Option<Duration>,
    ) -> Result<Value> {
        self.connect().await?;
        let Some(Live { mut connection, id }) = self.live.take() else {
            return Err(DragonflyError::Reply("blocking connection is not open"));
        };
        let guard = AbandonGuard {
            slot: &mut self.abandoned,
            id: Some(id),
        };
        let deadline = server_timeout
            .filter(|timeout| !timeout.is_zero())
            .map(|timeout| timeout + BLOCKING_GRACE);
        let request = cmd.query_async::<Value>(&mut connection);
        let result = match deadline {
            Some(deadline) => match tokio::time::timeout(deadline, request).await {
                Ok(result) => result,
                // `guard` records the abandonment as it drops; `connection` is dropped with it.
                Err(_) => return Err(DragonflyError::BlockingDeadline),
            },
            None => request.await,
        };
        match result {
            Ok(value) => {
                guard.completed();
                self.live = Some(Live { connection, id });
                Ok(value)
            }
            Err(error) if error.code().is_some() && !error.is_io_error() => {
                // A server error reply: the connection is in a clean state.
                guard.completed();
                self.live = Some(Live { connection, id });
                Err(error.into())
            }
            Err(error) => {
                // Connection trouble: drop it; the next call reconnects (and kills `id`, harmless
                // when the server has already closed it).
                drop(guard);
                Err(self.failed(error))
            }
        }
    }

    /// `BLPOP key... timeout` (node-redis `blPop`: `{key, element} | null`).
    pub async fn blpop(
        &mut self,
        keys: &[&str],
        timeout: Duration,
    ) -> Result<Option<(String, QueueItem)>> {
        self.pop("BLPOP", keys, timeout).await
    }

    /// `BRPOP key... timeout`.
    pub async fn brpop(
        &mut self,
        keys: &[&str],
        timeout: Duration,
    ) -> Result<Option<(String, QueueItem)>> {
        self.pop("BRPOP", keys, timeout).await
    }

    /// `BLMOVE source destination from to timeout` (the reference sends it through
    /// `sendCommand`: `string | null`).
    pub async fn blmove(
        &mut self,
        source: &str,
        destination: &str,
        from: End,
        to: End,
        timeout: Duration,
    ) -> Result<Option<QueueItem>> {
        let mut cmd = redis::cmd("BLMOVE");
        cmd.arg(source)
            .arg(destination)
            .arg(from.keyword())
            .arg(to.keyword())
            .arg(timeout_text(timeout));
        let value = self.query_value(&cmd, Some(timeout)).await?;
        Ok(reply::bytes_or_nil(value)?.map(QueueItem::from_popped))
    }

    async fn pop(
        &mut self,
        command: &str,
        keys: &[&str],
        timeout: Duration,
    ) -> Result<Option<(String, QueueItem)>> {
        let mut cmd = redis::cmd(command);
        cmd.arg(keys).arg(timeout_text(timeout));
        let items = reply::array(self.query_value(&cmd, Some(timeout)).await?)?;
        let mut items = items.into_iter();
        match (items.next(), items.next(), items.next()) {
            (None, _, _) => Ok(None),
            (Some(key), Some(item), None) => Ok(Some((
                reply::text(key)?,
                QueueItem::from_popped(reply::bytes(item)?),
            ))),
            _ => Err(DragonflyError::Reply(
                "blocking pop returned an unexpected shape",
            )),
        }
    }

    fn failed(&self, error: redis::RedisError) -> DragonflyError {
        self.shared.hooks.report(&self.shared.config.caller, &error);
        error.into()
    }
}

/// Seconds as node-redis writes the number it is given (`5`, `0.5`).
fn timeout_text(timeout: Duration) -> String {
    number_to_string(timeout.as_secs_f64())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeouts_are_written_like_javascript_numbers() {
        assert_eq!(timeout_text(Duration::from_secs(5)), "5");
        assert_eq!(timeout_text(Duration::from_millis(500)), "0.5");
        assert_eq!(timeout_text(Duration::ZERO), "0");
    }
}

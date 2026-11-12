//! `Dragonfly::transaction`: one result per queued command whatever `.ignore()` flags the
//! pipeline carries, and an aborted `EXEC` (nil) as its own error. Logical database 8 for the
//! live check, a unique key prefix, everything deleted afterwards; the aborted `EXEC` comes from
//! a scripted server, since it needs a `WATCH` on the shared connection.

mod dragonfly_support;

use anyhow::{Context, Result, ensure};
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, DragonflyError, Hooks, SetOptions};
use dragonfly_support::{cleanup, connect, prefix};
use redis::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

#[tokio::test]
async fn ignore_flags_neither_hide_errors_nor_shift_results() -> Result<()> {
    let Some(df) = connect(8).await? else {
        return Ok(());
    };
    let p = prefix("transaction-ignore");
    let result = async {
        let list = format!("{p}list");
        let text = format!("{p}text");
        df.set(&text, b"v", SetOptions::default()).await?;
        let mut pipeline = redis::pipe();
        pipeline
            .cmd("RPUSH")
            .arg(&list)
            .arg("a")
            .ignore()
            // Fails at run time (WRONGTYPE) and is marked ignored.
            .cmd("LPUSH")
            .arg(&text)
            .arg("x")
            .ignore()
            .cmd("LLEN")
            .arg(&list);
        let replies = df.transaction(pipeline).await?;
        ensure!(replies.len() == 3, "one result per command: {replies:?}");
        ensure!(matches!(replies[0], Ok(Value::Int(1))), "{:?}", replies[0]);
        ensure!(
            matches!(&replies[1], Err(error) if error.is_server_code("WRONGTYPE")),
            "{:?}",
            replies[1]
        );
        ensure!(matches!(replies[2], Ok(Value::Int(1))), "{:?}", replies[2]);
        Ok(())
    }
    .await;
    cleanup(&df, &p).await?;
    result
}

/// A server that answers `PING` and every other command with `OK`, and `EXEC` with nil (a
/// watched key changed).
async fn aborting_server() -> Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (reader, mut writer) = socket.into_split();
                let mut reader = BufReader::new(reader);
                let mut line = String::new();
                loop {
                    line.clear();
                    if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    let Some(count) = line.trim_end().strip_prefix('*') else {
                        return;
                    };
                    let count: usize = count.parse().unwrap_or(0);
                    let mut name = String::new();
                    for index in 0..count {
                        line.clear();
                        let _ = reader.read_line(&mut line).await;
                        let length: usize = line
                            .trim_end()
                            .strip_prefix('$')
                            .and_then(|n| n.parse().ok())
                            .unwrap_or(0);
                        let mut bytes = vec![0; length + 2];
                        if reader.read_exact(&mut bytes).await.is_err() {
                            return;
                        }
                        if index == 0 {
                            bytes.truncate(length);
                            name = String::from_utf8_lossy(&bytes).to_ascii_uppercase();
                        }
                    }
                    let reply: &[u8] = match name.as_str() {
                        "PING" => b"+PONG\r\n",
                        "EXEC" => b"*-1\r\n",
                        "MULTI" => b"+OK\r\n",
                        _ => b"+QUEUED\r\n",
                    };
                    if writer.write_all(reply).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    Ok(port)
}

#[tokio::test]
async fn an_aborted_exec_is_its_own_outcome() -> Result<()> {
    let port = aborting_server().await?;
    let config =
        DragonflyConfig::from_env_values(Some("127.0.0.1"), Some(&port.to_string()), "mock");
    let df = Dragonfly::connect(config, Hooks::default()).await?;
    let mut pipeline = redis::pipe();
    pipeline.cmd("INCR").arg("k").cmd("GET").arg("k");
    let outcome = df.transaction(pipeline).await;
    let error = outcome
        .err()
        .context("an aborted transaction reported success")?;
    ensure!(
        matches!(error, DragonflyError::TransactionAborted),
        "{error:?}"
    );
    ensure!(
        !error.outcome_unknown(),
        "nothing ran: the outcome is known"
    );
    Ok(())
}

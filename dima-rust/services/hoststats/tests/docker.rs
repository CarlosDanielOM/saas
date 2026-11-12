#![forbid(unsafe_code)]
#![allow(clippy::unwrap_used, clippy::panic)]
use dima_hoststats::docker::{Docker, Error};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
static SEQ: AtomicUsize = AtomicUsize::new(0);
fn path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "hs-{}-{}.sock",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ))
}
async fn reply(bytes: Vec<u8>) -> anyhow::Result<(Docker, tokio::task::JoinHandle<()>)> {
    let path = path();
    let listener = tokio::net::UnixListener::bind(&path)?;
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buf = [0; 4096];
        let n = stream.read(&mut buf).await.unwrap();
        assert!(String::from_utf8_lossy(&buf[..n]).starts_with("GET /version HTTP/1.1\r\n"));
        let _ = stream.write_all(&bytes).await;
    });
    Ok((Docker { socket: path }, task))
}
#[tokio::test]
async fn allowlist_refuses_before_any_io() -> anyhow::Result<()> {
    let path = path();
    let listener = tokio::net::UnixListener::bind(&path)?;
    let d = Docker {
        socket: path.clone(),
    };
    for p in [
        "/containers/abc/kill",
        &format!("/containers/{}/exec", "a".repeat(64)),
        "/containers/json",
        "/images/json",
        "/version\r\nPOST /evil",
    ] {
        assert!(matches!(d.get(p, 20).await, Err(Error::NotAllowed)));
    }
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
    std::fs::remove_file(path)?;
    Ok(())
}
#[tokio::test]
async fn chunked_size_status_timeout() -> anyhow::Result<()> {
    let (d, t) = reply(
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n".to_vec(),
    )
    .await?;
    assert_eq!(d.get("/version", 1000).await?, serde_json::json!({}));
    t.await?;
    std::fs::remove_file(d.socket)?;
    let (d, t) = reply(b"HTTP/1.1 200 OK\r\nContent-Length: 16777217\r\n\r\n".to_vec()).await?;
    assert!(matches!(
        d.get("/version", 1000).await,
        Err(Error::TooLarge)
    ));
    t.await?;
    std::fs::remove_file(d.socket)?;
    let (d, t) = reply(b"HTTP/1.1 404 Missing\r\nContent-Length: 2\r\n\r\n{}".to_vec()).await?;
    assert!(matches!(
        d.get("/version", 1000).await,
        Err(Error::Status(404))
    ));
    t.await?;
    std::fs::remove_file(d.socket)?;
    let path = path();
    let listener = tokio::net::UnixListener::bind(&path)?;
    let d = Docker {
        socket: path.clone(),
    };
    assert!(matches!(d.get("/version", 20).await, Err(Error::Timeout)));
    drop(listener);
    std::fs::remove_file(path)?;
    Ok(())
}

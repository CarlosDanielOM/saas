//! Narrow, GET-only HTTP/1.1 transport. The allowlist runs before connect.
use serde_json::Value;
use std::{path::PathBuf, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
const CAP: usize = 16 * 1024 * 1024;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Docker path not allowed")]
    NotAllowed,
    #[error("Docker response too large")]
    TooLarge,
    #[error("Docker timeout")]
    Timeout,
    #[error("Docker {0}")]
    Status(u16),
    #[error("Docker invalid HTTP response")]
    Http,
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
}
#[derive(Clone, Debug)]
pub struct Docker {
    pub socket: PathBuf,
}
pub fn allowed(path: &str) -> bool {
    if ["/version", "/system/df", "/containers/json?all=1"].contains(&path) {
        return true;
    }
    let Some(rest) = path.strip_prefix("/containers/") else {
        return false;
    };
    let Some((id, tail)) = rest.split_once('/') else {
        return false;
    };
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && ["json", "stats?stream=false&one-shot=true"].contains(&tail)
}
impl Docker {
    pub async fn get(&self, path: &str, ms: u64) -> Result<Value, Error> {
        if !allowed(path) {
            return Err(Error::NotAllowed);
        }
        tokio::time::timeout(Duration::from_millis(ms), self.request(path))
            .await
            .map_err(|_| Error::Timeout)?
    }
    async fn request(&self, path: &str) -> Result<Value, Error> {
        let mut s = tokio::net::UnixStream::connect(&self.socket).await?;
        s.write_all(
            format!("GET {path} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n").as_bytes(),
        )
        .await?;
        let mut raw = Vec::new();
        let mut buf = [0; 8192];
        let header_end = loop {
            let n = s.read(&mut buf).await?;
            if n == 0 {
                return Err(Error::Http);
            }
            raw.extend_from_slice(&buf[..n]);
            if let Some(i) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
            if raw.len() > 65536 {
                return Err(Error::TooLarge);
            }
        };
        let headers = String::from_utf8_lossy(&raw[..header_end]);
        let status = headers
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse::<u16>().ok())
            .ok_or(Error::Http)?;
        let mut length = None;
        let mut chunked = false;
        for l in headers.lines().skip(1) {
            if let Some((k, v)) = l.split_once(':') {
                if k.eq_ignore_ascii_case("content-length") {
                    length = Some(v.trim().parse::<usize>().map_err(|_| Error::Http)?)
                }
                if k.eq_ignore_ascii_case("transfer-encoding")
                    && v.trim().eq_ignore_ascii_case("chunked")
                {
                    chunked = true
                }
            }
        }
        if length.is_some_and(|n| n > CAP) {
            return Err(Error::TooLarge);
        }
        let mut body = raw.split_off(header_end);
        let mut decoded = Vec::new();
        let mut cursor = 0;
        loop {
            if chunked {
                loop {
                    let Some(end) = body[cursor..].windows(2).position(|w| w == b"\r\n") else {
                        break;
                    };
                    let line = std::str::from_utf8(&body[cursor..cursor + end])
                        .map_err(|_| Error::Http)?;
                    let size = usize::from_str_radix(line.split(';').next().unwrap_or(""), 16)
                        .map_err(|_| Error::Http)?;
                    if size == 0 {
                        return finish(status, &decoded);
                    }
                    if size > CAP - decoded.len() {
                        return Err(Error::TooLarge);
                    }
                    let start = cursor + end + 2;
                    let Some(stop) = start.checked_add(size) else {
                        return Err(Error::TooLarge);
                    };
                    if body.len() < stop + 2 {
                        break;
                    }
                    if body.get(stop..stop + 2) != Some(b"\r\n") {
                        return Err(Error::Http);
                    }
                    decoded.extend_from_slice(&body[start..stop]);
                    cursor = stop + 2;
                }
                if cursor > 0 {
                    body.drain(..cursor);
                    cursor = 0;
                }
                if body.len() > CAP + 65536 {
                    return Err(Error::TooLarge);
                }
            } else {
                if body.len() > CAP {
                    return Err(Error::TooLarge);
                }
                if length.is_some_and(|n| body.len() >= n) {
                    return finish(status, &body);
                }
            }
            let n = s.read(&mut buf).await?;
            if n == 0 {
                if chunked || length.is_some_and(|n| body.len() != n) {
                    return Err(Error::Http);
                }
                return finish(status, &body);
            }
            body.extend_from_slice(&buf[..n]);
        }
    }
}
fn finish(status: u16, body: &[u8]) -> Result<Value, Error> {
    if status != 200 {
        return Err(Error::Status(status));
    }
    Ok(serde_json::from_slice(
        &dima_text::sanitize_lone_surrogates(body),
    )?)
}

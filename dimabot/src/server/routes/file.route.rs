//! Clip route with bounded, cancellation-aware file streaming.
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::stream;
use serde_json::json;
use std::{io, path::PathBuf};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt};

#[derive(Clone, Debug)]
pub struct FileRoute {
    public_dir: PathBuf,
}
impl FileRoute {
    /// Pass the directory corresponding to the TypeScript route module's `public`.
    /// This constructor does not inspect the filesystem.
    pub fn new(public_dir: impl Into<PathBuf>) -> Self {
        Self {
            public_dir: public_dir.into(),
        }
    }
    pub fn from_module_dir(module_dir: impl Into<PathBuf>) -> Self {
        Self::new(module_dir.into().join("public"))
    }
    pub fn router(&self) -> Router {
        Router::new()
            .route("/clip/{channelID}", get(clip))
            .with_state(self.clone())
    }
    pub fn mounted_router(&self) -> Router {
        Router::new().nest("/video", self.router())
    }
}
fn error(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(json!({"error":true,"message":message,"status":status.as_u16()})),
    )
        .into_response()
}
async fn clip(
    State(service): State<FileRoute>,
    Path(channel): Path<String>,
    headers: HeaderMap,
) -> Response {
    if channel.is_empty() {
        return error(StatusCode::BAD_REQUEST, "channelID is required");
    }
    let path = service
        .public_dir
        .join("downloads")
        .join(format!("{channel}-clip.mp4"));
    let mut file = match tokio::fs::File::open(&path).await {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            eprintln!("Video file not found at: {}", path.display());
            return error(StatusCode::NOT_FOUND, "Clip not found");
        }
        Err(e) => {
            eprintln!("Error serving video clip: channelID={channel:?} error={e}");
            return error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error");
        }
    };
    let size = match file.metadata().await {
        Ok(m) => m.len(),
        Err(e) => {
            eprintln!("Error serving video clip: {e}");
            return error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error");
        }
    };
    let range = headers.get(header::RANGE);
    let (start, end, status) = if let Some(range) = range {
        let parsed = range.to_str().ok().and_then(parse_range);
        let Some((start, requested_end)) = parsed else {
            return error(StatusCode::BAD_REQUEST, "Invalid range");
        };
        if start >= size {
            return error(
                StatusCode::RANGE_NOT_SATISFIABLE,
                "Requested range not satisfiable",
            );
        }
        let end = requested_end.unwrap_or(size - 1);
        if end < start || end >= size {
            return error(
                StatusCode::RANGE_NOT_SATISFIABLE,
                "Requested range not satisfiable",
            );
        }
        (start, end, StatusCode::PARTIAL_CONTENT)
    } else {
        (0, size.saturating_sub(1), StatusCode::OK)
    };
    let length = if size == 0 { 0 } else { end - start + 1 };
    if let Err(e) = file.seek(std::io::SeekFrom::Start(start)).await {
        eprintln!("Error serving video clip: {e}");
        return error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error");
    }
    let mut response = Response::new(stream_body(file, length));
    *response.status_mut() = status;
    let h = response.headers_mut();
    h.insert(header::CONTENT_TYPE, "video/mp4".parse().unwrap());
    h.insert(header::CONTENT_LENGTH, length.to_string().parse().unwrap());
    h.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    if status == StatusCode::PARTIAL_CONTENT {
        h.insert(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{size}").parse().unwrap(),
        );
    }
    response
}

/// Bounded stream used by the file adapter; dropping the body drops the reader.
#[doc(hidden)]
pub fn stream_body<R: AsyncRead + Unpin + Send + 'static>(reader: R, length: u64) -> Body {
    let chunks = stream::try_unfold((reader, length), |(mut file, remaining)| async move {
        if remaining == 0 {
            return Ok::<_, io::Error>(None);
        }
        let mut buf = vec![0; remaining.min(64 * 1024) as usize];
        let n = file.read(&mut buf).await?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "clip truncated during streaming",
            ));
        }
        buf.truncate(n);
        Ok(Some((buf, (file, remaining - n as u64))))
    });
    Body::from_stream(chunks)
}

fn parse_range(value: &str) -> Option<(u64, Option<u64>)> {
    let value = value.strip_prefix("bytes=")?;
    let (start, end) = value.split_once('-')?;
    let start = start.parse().ok()?;
    let end = if end.is_empty() {
        None
    } else {
        Some(end.parse().ok()?)
    };
    Some((start, end))
}

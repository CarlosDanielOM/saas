//! The browser client files under `/socket.io/` (`serveClient`, on by default in the reference;
//! the DimaFX overlay loads `/socket.io/socket.io.js`).
//!
//! As `Server.serve` of `socket.io` 4.8.3 answers them: any method; a path matching
//! `^/socket\.io/socket\.io(\.msgpack|\.esm)?(\.min)?\.js(\.map)?(?:\?|$)`; `304` when
//! `If-None-Match` is exactly `"4.8.3"` or `W/"4.8.3"`; otherwise `200` with
//! `Cache-Control: public, max-age=0`, `Content-Type: application/javascript; charset=utf-8`
//! (`application/json` for source maps), `ETag: "4.8.3"` and the body in `br`, `gzip` or
//! `deflate` as `Accept-Encoding` prefers, or as is. A name the pattern accepts but the package
//! does not ship (`socket.io.esm.js`, `socket.io.msgpack.js` and their maps) makes the reference
//! fail its file stream after the response started, which resets the connection: here the
//! response body fails at once, which does the same.
//!
//! The files are vendored in `client-dist/` (with their Brotli form, made by
//! `tests/js/vendor-client-dist.mjs` with Node's defaults); gzip and deflate are computed once
//! per file on first use, off the async threads.

use std::io::Write as _;
use std::pin::Pin;
use std::sync::OnceLock;
use std::task::{Context, Poll};

use bytes::Bytes;
use dima_web::Body;
use flate2::Compression;
use http::{HeaderValue, Response, StatusCode, header};

use crate::negotiate;

/// The `socket.io` version the files come from (the ETag).
pub const CLIENT_VERSION: &str = "4.8.3";

struct File {
    name: &'static str,
    raw: &'static [u8],
    brotli: &'static [u8],
}

macro_rules! file {
    ($name:literal) => {
        File {
            name: $name,
            raw: include_bytes!(concat!("../client-dist/", $name)),
            brotli: include_bytes!(concat!("../client-dist/", $name, ".br")),
        }
    };
}

static FILES: [File; 8] = [
    file!("socket.io.esm.min.js"),
    file!("socket.io.esm.min.js.map"),
    file!("socket.io.js"),
    file!("socket.io.js.map"),
    file!("socket.io.min.js"),
    file!("socket.io.min.js.map"),
    file!("socket.io.msgpack.min.js"),
    file!("socket.io.msgpack.min.js.map"),
];

static GZIP: [OnceLock<Bytes>; 8] = [const { OnceLock::new() }; 8];
static DEFLATE: [OnceLock<Bytes>; 8] = [const { OnceLock::new() }; 8];

/// `clientPathRegex.test(req.url)`, on the path and query of the request target.
pub fn is_client_path(target: &str) -> bool {
    let Some(rest) = target.strip_prefix("/socket.io/socket.io") else {
        return false;
    };
    let rest = rest
        .strip_prefix(".msgpack")
        .or_else(|| rest.strip_prefix(".esm"))
        .unwrap_or(rest);
    let rest = rest.strip_prefix(".min").unwrap_or(rest);
    let Some(rest) = rest.strip_prefix(".js") else {
        return false;
    };
    let rest = rest.strip_prefix(".map").unwrap_or(rest);
    rest.is_empty() || rest.starts_with('?')
}

/// A body that fails before producing anything: hyper then drops the connection.
struct Reset;

impl hyper::body::Body for Reset {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Option<Result<hyper::body::Frame<Bytes>, std::io::Error>>> {
        Poll::Ready(Some(Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "client file not shipped",
        ))))
    }
}

fn compress(raw: &'static [u8], gzip: bool) -> Bytes {
    let level = Compression::default();
    let written = if gzip {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), level);
        encoder.write_all(raw).and_then(|()| encoder.finish())
    } else {
        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), level);
        encoder.write_all(raw).and_then(|()| encoder.finish())
    };
    written.map(Bytes::from).unwrap_or_default()
}

async fn encoded(index: usize, gzip: bool) -> Option<Bytes> {
    let cells = if gzip { &GZIP } else { &DEFLATE };
    let cell = cells.get(index)?;
    if let Some(bytes) = cell.get() {
        return Some(bytes.clone());
    }
    let raw = FILES.get(index)?.raw;
    let bytes = tokio::task::spawn_blocking(move || compress(raw, gzip))
        .await
        .ok()?;
    Some(cell.get_or_init(|| bytes).clone())
}

/// Answers a request for a client file (`target` passed [`is_client_path`]).
pub async fn serve(headers: &http::HeaderMap, target: &str) -> Response<Body> {
    let path = target.split('?').next().unwrap_or(target);
    let filename = path.strip_prefix("/socket.io/").unwrap_or(path);
    let is_map = filename.contains(".map");
    let expected = format!("\"{CLIENT_VERSION}\"");
    let if_none_match: Vec<&str> = headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .collect();
    if !if_none_match.is_empty() {
        // Node joins repeated headers with ", " before comparing.
        let etag = if_none_match.join(", ");
        if etag == expected || etag == format!("W/{expected}") {
            let mut response = Response::new(Body::empty());
            *response.status_mut() = StatusCode::NOT_MODIFIED;
            return response;
        }
    }
    let accept = headers
        .get_all(header::ACCEPT_ENCODING)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .collect::<Vec<_>>()
        .join(", ");
    let accept = headers
        .contains_key(header::ACCEPT_ENCODING)
        .then_some(accept.as_str());
    let found = FILES.iter().position(|file| file.name == filename);
    let encoding = negotiate::preferred(accept, &["br", "gzip", "deflate"]);
    let mut response = Response::new(Body::empty());
    let out = response.headers_mut();
    out.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=0"),
    );
    out.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(if is_map {
            "application/json; charset=utf-8"
        } else {
            "application/javascript; charset=utf-8"
        }),
    );
    if let Ok(etag) = HeaderValue::from_str(&expected) {
        out.insert(header::ETAG, etag);
    }
    if let Some(encoding) = encoding {
        out.insert(header::CONTENT_ENCODING, HeaderValue::from_static(encoding));
    }
    let Some(index) = found else {
        *response.body_mut() = Body::new(Reset);
        return response;
    };
    let body = match (encoding, FILES.get(index)) {
        (Some("br"), Some(file)) => Some(Bytes::from_static(file.brotli)),
        (Some("gzip"), _) => encoded(index, true).await,
        (Some("deflate"), _) => encoded(index, false).await,
        (_, Some(file)) => Some(Bytes::from_static(file.raw)),
        (_, None) => None,
    };
    *response.body_mut() = match body {
        Some(bytes) => Body::from(bytes),
        None => Body::new(Reset),
    };
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_like_the_reference_pattern() {
        for target in [
            "/socket.io/socket.io.js",
            "/socket.io/socket.io.min.js",
            "/socket.io/socket.io.js.map",
            "/socket.io/socket.io.esm.min.js",
            "/socket.io/socket.io.msgpack.min.js.map",
            "/socket.io/socket.io.esm.js",
            "/socket.io/socket.io.js?v=1",
            "/socket.io/socket.io.js?",
        ] {
            assert!(is_client_path(target), "{target}");
        }
        for target in [
            "/socket.io/socket.io.jsx",
            "/socket.io/socket.io.min.esm.js",
            "/socket.io/socket.io.js/",
            "/socket.io/socket.io.js#x",
            "/socket.io/socket.io.js.map.map",
            "/socket.io/socket.io",
            "/socket.io/?EIO=4&transport=polling",
            "/x/socket.io/socket.io.js",
            "/socket.io/socket%2Eio.js",
        ] {
            assert!(!is_client_path(target), "{target}");
        }
    }

    #[test]
    fn vendored_files_are_the_reference_bytes() {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(FILES[2].raw);
        assert_eq!(FILES[2].name, "socket.io.js");
        assert_eq!(
            hex(&digest),
            "bc425714aa8f2547d6939e3721ebafd3830a7562a1f6cb08acc1e794bd707954"
        );
        for file in &FILES {
            assert!(
                !file.raw.is_empty() && !file.brotli.is_empty(),
                "{}",
                file.name
            );
        }
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}

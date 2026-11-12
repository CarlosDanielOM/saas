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
//! per file on first use, off the async threads: concurrent first requests wait for that one
//! compression (at most [`COMPRESS_WAIT`]; past it they get the file uncompressed).
//!
//! Every answer whose body depends on `Accept-Encoding` (the `200`s, and the `304`s, which
//! must name the same `Vary` as the `200` they stand for) carries `Vary: Accept-Encoding`, so a
//! shared cache does not hand a compressed body to a client that cannot read it. The reference
//! sends no `Vary` (a fix, not visible to the browsers, which do not share caches).

use std::io::Write as _;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

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

static GZIP: [tokio::sync::OnceCell<Bytes>; 8] = [const { tokio::sync::OnceCell::const_new() }; 8];
static DEFLATE: [tokio::sync::OnceCell<Bytes>; 8] =
    [const { tokio::sync::OnceCell::const_new() }; 8];

/// How many times each file was compressed, gzip then deflate (one each, once warm).
static COMPRESSIONS: [AtomicUsize; 16] = [const { AtomicUsize::new(0) }; 16];

/// How long a request waits for the first compression of its file before it is answered with
/// the file as is. Compressing the largest file takes milliseconds; this only fires when the
/// blocking pool is saturated.
pub const COMPRESS_WAIT: Duration = Duration::from_secs(5);

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

/// The compressed file, computed by the first request that needs it; the others wait for that
/// one (a request that gives up hands the work to the next waiter). `None` when it took longer
/// than [`COMPRESS_WAIT`] or failed.
async fn encoded(index: usize, gzip: bool) -> Option<Bytes> {
    let cells = if gzip { &GZIP } else { &DEFLATE };
    let cell = cells.get(index)?;
    let raw = FILES.get(index)?.raw;
    let counter = COMPRESSIONS.get(index * 2 + usize::from(!gzip))?;
    let compute = cell.get_or_try_init(|| async move {
        counter.fetch_add(1, Ordering::Relaxed);
        tokio::task::spawn_blocking(move || compress(raw, gzip))
            .await
            .map_err(|_| ())
    });
    tokio::time::timeout(COMPRESS_WAIT, compute)
        .await
        .ok()?
        .ok()
        .cloned()
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
            response
                .headers_mut()
                .insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
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
    let wanted = negotiate::preferred(accept, &["br", "gzip", "deflate"]);
    let body = match (found, wanted) {
        (None, _) => None,
        (Some(index), Some("br")) => FILES
            .get(index)
            .map(|file| (Some("br"), Bytes::from_static(file.brotli))),
        (Some(index), Some(encoding @ ("gzip" | "deflate"))) => {
            match encoded(index, encoding == "gzip").await {
                Some(bytes) => Some((Some(encoding), bytes)),
                // Not ready in time: the file as is, which every client reads.
                None => FILES
                    .get(index)
                    .map(|file| (None, Bytes::from_static(file.raw))),
            }
        }
        (Some(index), _) => FILES
            .get(index)
            .map(|file| (None, Bytes::from_static(file.raw))),
    };
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
    out.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    match body {
        Some((encoding, bytes)) => {
            if let Some(encoding) = encoding {
                out.insert(header::CONTENT_ENCODING, HeaderValue::from_static(encoding));
            }
            *response.body_mut() = Body::from(bytes);
        }
        None => {
            // The reference sets the encoding header before its stream fails.
            if let Some(encoding) = wanted {
                out.insert(header::CONTENT_ENCODING, HeaderValue::from_static(encoding));
            }
            *response.body_mut() = Body::new(Reset);
        }
    }
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

    fn accepting(encoding: &str) -> http::HeaderMap {
        let mut headers = http::HeaderMap::new();
        headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_str(encoding).unwrap(),
        );
        headers
    }

    /// Finding 16: `Vary: Accept-Encoding` on every answer the encoding can change, `304`s
    /// included.
    #[tokio::test]
    async fn answers_vary_on_the_accepted_encoding() {
        for headers in [accepting("br"), accepting("gzip"), http::HeaderMap::new()] {
            let response = serve(&headers, "/socket.io/socket.io.min.js").await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::VARY], "Accept-Encoding");
        }
        let mut headers = accepting("gzip");
        headers.insert(header::IF_NONE_MATCH, HeaderValue::from_static("\"4.8.3\""));
        let response = serve(&headers, "/socket.io/socket.io.min.js").await;
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(response.headers()[header::VARY], "Accept-Encoding");
    }

    /// Finding 16: concurrent cold requests compress the file once; the others wait for it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_cold_requests_compress_once() {
        // `socket.io.msgpack.min.js.map` with deflate: no other test asks for it.
        let index = 7;
        assert_eq!(FILES[index].name, "socket.io.msgpack.min.js.map");
        let requests: Vec<_> = (0..16)
            .map(|_| {
                tokio::spawn(async {
                    let response = serve(
                        &accepting("deflate"),
                        "/socket.io/socket.io.msgpack.min.js.map",
                    )
                    .await;
                    let encoding = response.headers().get(header::CONTENT_ENCODING).cloned();
                    let body = http_body_util::BodyExt::collect(response.into_body())
                        .await
                        .unwrap()
                        .to_bytes();
                    (encoding, body)
                })
            })
            .collect();
        let mut bodies = Vec::new();
        for request in requests {
            bodies.push(request.await.unwrap());
        }
        assert_eq!(COMPRESSIONS[index * 2 + 1].load(Ordering::Relaxed), 1);
        assert!(bodies.iter().all(|(encoding, body)| {
            encoding.as_ref().is_some_and(|e| e == "deflate") && *body == bodies[0].1
        }));
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}

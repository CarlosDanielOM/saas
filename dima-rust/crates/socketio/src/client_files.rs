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
//! `tests/js/vendor-client-dist.mjs` with Node's defaults); their gzip and deflate forms are
//! computed once, when the server is built ([`ClientFiles::compress`]), so a request never
//! compresses anything, a cancelled request leaves no work behind, and no job runs outside the
//! server's tasks and its shutdown report.
//!
//! Every answer whose body depends on `Accept-Encoding` (the `200`s, and the `304`s, which
//! must name the same `Vary` as the `200` they stand for) carries `Vary: Accept-Encoding`, so a
//! shared cache does not hand a compressed body to a client that cannot read it. The reference
//! sends no `Vary` (a fix, not visible to the browsers, which do not share caches).

use std::io::Write as _;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
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

fn compress(raw: &[u8], gzip: bool, count: &AtomicUsize) -> Option<Bytes> {
    count.fetch_add(1, Ordering::Relaxed);
    let level = Compression::default();
    let written = if gzip {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), level);
        encoder.write_all(raw).and_then(|()| encoder.finish())
    } else {
        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), level);
        encoder.write_all(raw).and_then(|()| encoder.finish())
    };
    written.ok().map(Bytes::from)
}

/// The gzip and deflate forms of every client file, computed when the server is built.
pub(crate) struct ClientFiles {
    /// Per file, in the order of `FILES`: gzip, then deflate (`None`: the compression failed,
    /// and the file is sent as is).
    encoded: Vec<[Option<Bytes>; 2]>,
    /// Compressions done for this server (all of them in [`ClientFiles::compress`]); read by
    /// the tests only.
    #[cfg_attr(not(test), allow(dead_code))]
    compressions: AtomicUsize,
}

impl ClientFiles {
    /// Compresses every file both ways, one scoped thread per file (the largest takes a few
    /// tens of milliseconds in a release build). Called once, by `Builder::build`.
    pub fn compress() -> Self {
        let compressions = AtomicUsize::new(0);
        let count = &compressions;
        let encoded = std::thread::scope(|scope| {
            let jobs: Vec<_> = FILES
                .iter()
                .map(|file| {
                    scope.spawn(move || {
                        [
                            compress(file.raw, true, count),
                            compress(file.raw, false, count),
                        ]
                    })
                })
                .collect();
            jobs.into_iter()
                .map(|job| job.join().unwrap_or([None, None]))
                .collect()
        });
        Self {
            encoded,
            compressions,
        }
    }

    /// Compressions done for this server.
    #[cfg(test)]
    fn compressions(&self) -> usize {
        self.compressions.load(Ordering::Relaxed)
    }

    fn encoded(&self, index: usize, gzip: bool) -> Option<Bytes> {
        self.encoded
            .get(index)
            .and_then(|forms| forms[usize::from(!gzip)].clone())
    }
    /// Answers a request for a client file (`target` passed [`is_client_path`]).
    pub fn serve(&self, headers: &http::HeaderMap, target: &str) -> Response<Body> {
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
                match self.encoded(index, encoding == "gzip") {
                    Some(bytes) => Some((Some(encoding), bytes)),
                    // The compression failed: the file as is, which every client reads.
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

    fn files() -> &'static ClientFiles {
        static FILES: std::sync::OnceLock<ClientFiles> = std::sync::OnceLock::new();
        FILES.get_or_init(ClientFiles::compress)
    }

    fn body(response: Response<Body>) -> Bytes {
        futures_util::FutureExt::now_or_never(http_body_util::BodyExt::collect(
            response.into_body(),
        ))
        .unwrap()
        .unwrap()
        .to_bytes()
    }

    /// Finding 16: `Vary: Accept-Encoding` on every answer the encoding can change, `304`s
    /// included.
    #[test]
    fn answers_vary_on_the_accepted_encoding() {
        for headers in [accepting("br"), accepting("gzip"), http::HeaderMap::new()] {
            let response = files().serve(&headers, "/socket.io/socket.io.min.js");
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::VARY], "Accept-Encoding");
        }
        let mut headers = accepting("gzip");
        headers.insert(header::IF_NONE_MATCH, HeaderValue::from_static("\"4.8.3\""));
        let response = files().serve(&headers, "/socket.io/socket.io.min.js");
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(response.headers()[header::VARY], "Accept-Encoding");
    }

    /// H4: every file is compressed both ways once, when the server is built; requests
    /// (concurrent, cancelled, repeated) only hand out those bytes, which decompress to the
    /// file. Before, each request that found its file cold started a compression job, and eight
    /// requests cancelled during the first one left eight jobs running.
    #[test]
    fn files_are_compressed_once_when_the_server_is_built() {
        use std::io::Read as _;
        let files = ClientFiles::compress();
        assert_eq!(files.compressions(), FILES.len() * 2);
        for (index, file) in FILES.iter().enumerate() {
            let target = format!("/socket.io/{}", file.name);
            for _ in 0..8 {
                // A request whose client went away: its answer is dropped unread.
                drop(files.serve(&accepting("gzip"), &target));
            }
            let gzip = body(files.serve(&accepting("gzip"), &target));
            let deflate = body(files.serve(&accepting("deflate"), &target));
            assert_eq!(Some(&gzip), files.encoded(index, true).as_ref());
            let mut plain = Vec::new();
            flate2::read::GzDecoder::new(&gzip[..])
                .read_to_end(&mut plain)
                .unwrap();
            assert_eq!(plain, file.raw, "{}", file.name);
            plain.clear();
            flate2::read::ZlibDecoder::new(&deflate[..])
                .read_to_end(&mut plain)
                .unwrap();
            assert_eq!(plain, file.raw, "{}", file.name);
        }
        assert_eq!(files.compressions(), FILES.len() * 2);
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}

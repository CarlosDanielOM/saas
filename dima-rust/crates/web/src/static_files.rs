//! `express.static(root)` (serve-static 1.16.3 over send 0.19.2) with default options.

use crate::error::Error;
use crate::handler::{BoxFuture, Flow, Handler};
use crate::request::Req;
use crate::response::Response;
use crate::send::{Sent, resolve_root, serve_static as send_static};

/// `express.static(root)` with the options the reference uses (none), as middleware:
///
/// - GET and HEAD only; other methods continue with the next layer.
/// - The request path, relative to the mount point, is decoded and resolved under `root`.
///   A malformed escape (400), a null byte (400), a `..` segment (403, `\` counts as a
///   separator) and a missing file (404) continue with the next layer, as with Express's
///   default `fallthrough`; once a file was found, failures go down the error path.
/// - Dotfiles follow send's legacy rule: a path whose last part starts with `.` is not served
///   (the next layer runs); directories starting with `.` on the way are served.
/// - A directory with a trailing slash serves its `index.html`; without the slash it answers
///   `301` to the path with a slash (query kept, leading slashes collapsed) with serve-static's
///   HTML body. In the reference this turns `GET /speech/<channel>` into a redirect once TTS
///   output exists for that channel (`ledger/http.md` item 6).
/// - Files are sent like [`Response::send_file`]: mime-table types (`; charset=UTF-8` for text,
///   JavaScript and JSON), `Accept-Ranges: bytes`, `Cache-Control: public, max-age=0`,
///   `Last-Modified`, a weak ETag from size and modification time, conditional requests and
///   single byte ranges. Nothing is cached: every request looks at the disk.
pub fn serve_static(root: impl AsRef<str>) -> ServeStatic {
    ServeStatic {
        root: resolve_root(root.as_ref()),
    }
}

/// See [`serve_static`].
#[derive(Debug, Clone)]
pub struct ServeStatic {
    root: String,
}

impl ServeStatic {
    /// The absolute root directory (`path.resolve(root)`).
    pub fn root(&self) -> &str {
        &self.root
    }
}

impl<S: Send + Sync + 'static> Handler<S> for ServeStatic {
    fn call<'a>(&'a self, req: &'a mut Req<S>) -> BoxFuture<'a, Result<Flow, Error>> {
        Box::pin(async move {
            match send_static(req, &self.root).await {
                Sent::Response(response) => Ok(Flow::Respond(Response::from_http(response))),
                Sent::Next => Ok(Flow::Next),
                Sent::Error(error) => Err(error),
            }
        })
    }
}

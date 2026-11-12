//! Inbound HTTP edge that behaves like the Express app it replaces.
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md`.
//!
//! The TypeScript route tables port one to one: a [`Router`] is an ordered list of layers
//! (middleware, routes, mounted routers, error handlers) dispatched exactly like Express 4,
//! with Express's path matching, `req.query` parsing (qs), body-parser middleware ([`body`]),
//! `cors()` ([`cors`]), `res.send` / `res.json` headers (weak ETags, 304s, HEAD) and the default
//! finalhandler pages. Handlers are `async fn(&mut Req<S>) -> impl IntoFlow`; `S` is the shared
//! application state. Each module's documentation lists where it knowingly differs from the
//! Node package it reproduces, and why.
//!
//! ```
//! use dima_web::{App, Envelope, Error, Flow, Req, Response, Router, body, cors};
//! use serde::Deserialize;
//! use serde_json::json;
//!
//! struct State {
//!     greeting: String,
//! }
//!
//! #[derive(Clone)]
//! struct User {
//!     id: String,
//! }
//!
//! // `router.use(authMiddleware)`: attaches the user or answers 401.
//! async fn auth(req: &mut Req<State>) -> Result<Flow, Error> {
//!     if req.header("authorization").as_deref() != Some("Bearer good") {
//!         return Ok(Envelope::fail(401, "Unauthorized").reply().into());
//!     }
//!     req.extensions_mut().insert(User { id: "42".to_owned() });
//!     Ok(Flow::Next)
//! }
//!
//! async fn health(req: &mut Req<State>) -> Response {
//!     Response::new().json(&json!({ "ok": true, "greeting": req.state().greeting }))
//! }
//!
//! async fn show(req: &mut Req<State>) -> Response {
//!     let user = req.extensions().get::<User>().map(|user| user.id.clone());
//!     let limit = req.query_str("limit").unwrap_or("10");
//!     Response::new().json(&json!({ "user": user, "channel": req.param("channelID"), "limit": limit }))
//! }
//!
//! #[derive(Deserialize)]
//! struct Rename {
//!     name: String,
//! }
//!
//! async fn rename(req: &mut Req<State>) -> Result<Response, Error> {
//!     let Rename { name } = req.body_as()?;
//!     let channel = req.param("channelID").unwrap_or_default();
//!     Ok(Envelope::ok("Renamed").data(json!({ "channel": channel, "name": name })).reply())
//! }
//!
//! let mut channels = Router::new();
//! channels.middleware(auth); // every path under /channels, matched or not, needs the token
//! channels.get("/:channelID", show).patch("/:channelID", rename);
//!
//! let mut root = Router::new();
//! root.middleware(body::json());
//! root.middleware(cors::cors());
//! root.get("/health", health);
//! root.mount("/channels", channels);
//! let app = App::new(root, State { greeting: "hi".to_owned() })?;
//! # let _ = app;
//! # Ok::<(), dima_web::ConfigError>(())
//! ```
//!
//! Serving: `dima_web::serve(dima_web::bind(3000)?, app, shutdown_token, ServeOptions::default())`.
//! [`bind`] listens like Node (dual-stack `::`), and [`ServeOptions`] carries Node's timeouts and
//! this crate's bounds (connections, request head size). A Socket.IO
//! layer can wrap the [`App`] (it is a `tower::Service`), and handlers can take a connection
//! upgrade with [`Req::take_upgrade`] and the [`UpgradeGuard`] that ties it to shutdown with
//! [`Req::take_upgrade_guard`].
//!
//! # Porting notes
//!
//! For whoever ports the 320 TypeScript handlers onto this crate:
//!
//! - **`req.query`**: [`Req::query_str`] is the reference's `typeof req.query.x === 'string'`
//!   guard. It returns `None` both when the key is absent and when it holds an array or object
//!   (`?x=1&x=2`, `?x[a]=1`). Those are not the same: code that tests
//!   `req.query.x === undefined`, truthiness or `Array.isArray` must look at
//!   `req.query().get("x")` instead.
//! - **Typed bodies**: [`Req::body_as`] turns a body that does not fit `T` into an early
//!   `400 body.invalid` on the error path (the default HTML error page unless a router error
//!   handler maps it). That includes `{}`, which is what `req.body` holds when no body was sent
//!   or the content type did not match. An untyped legacy handler may have answered differently
//!   (its own JSON envelope, or carrying on with defaults): port those with [`Req::body`] and the
//!   handler's own checks, or give the fields `#[serde(default)]`.
//! - **Envelopes**: [`Envelope::reply`] sets the HTTP status from the body's `status`. Several
//!   legacy handlers send a body `status` that differs from the HTTP status (`res.json({ status:
//!   400 })` with HTTP 200, `res.status(201)` with body `status: 200`; `ledger/http.md` item 17):
//!   use [`Envelope::reply_with`] for those, and keep the reference's key order and omissions with
//!   `serde_json::json!` where the envelope shape differs.
//! - **Numbers** in JSON bodies are what `JSON.parse` holds: integers beyond 2^53 arrive rounded to
//!   a double, integral doubles (`1.0`) arrive as integers, and a number beyond the double range
//!   is a 400 (the reference got `Infinity`).
//! - **Errors and panics**: return `Err` instead of throwing; a panic is caught and becomes a 500
//!   on the error path, where router error handlers see it like any other error. Express 4 left
//!   a throw in an async handler hanging (and crashed the process); here it is always answered.
//! - **Headers after next()**: middleware that sets headers and continues uses
//!   [`Req::set_header`]; a [`Response`] merges with those headers when it is sent.
//!
//! Beyond routing and bodies:
//!
//! - **Files**: [`serve_static`] is `express.static(dir)` and [`Response::send_file`] is
//!   `res.sendFile(path)`, both on a port of `send` 0.19 (index, dotfiles, the directory
//!   redirect, ETag and Last-Modified from the file, conditional requests, byte ranges, the
//!   mime 1.6 table). Nothing is cached between requests.
//! - **Streams**: [`Response::stream`] sends a body as it is produced; [`sse`] writes
//!   Server-Sent Events with heartbeats; [`Req::closed`] tells spawned work when the exchange is
//!   over, including when the client goes away.
//! - **Uploads**: [`multipart`] is multer 1.4.5-lts.2 over busboy 1.6 (`single(field)`, disk and
//!   streaming storage, limits with multer's codes, file filter, cleanup, deadline).
//! - **Telemetry**: [`App::observe`] installs an [`Observer`] that sees every request start and
//!   end (route, status, duration, bytes, aborts) and may attach a [`TraceContext`].
#![forbid(unsafe_code)]

mod app;
pub mod body;
pub mod conditional;
pub mod cors;
mod envelope;
mod error;
mod exchange;
mod handler;
mod mediatype;
mod mime_table;
pub mod multipart;
mod negotiate;
pub mod path;
pub mod qs;
mod request;
mod response;
mod router;
mod send;
mod server;
pub mod sse;
mod static_files;
pub mod status;
pub mod uri;

/// The body type for requests and responses.
pub type Body = axum::body::Body;

pub use app::{App, ConfigError};
pub use envelope::Envelope;
pub use error::{Error, Result, RouteError};
pub use exchange::{
    MatchedRoute, OBSERVER_QUEUE, Observer, ObserverQueue, RequestEnd, RequestStart, TraceContext,
};
pub use handler::{
    BoxFuture, ErrorHandler, ErrorHandlerFn, Flow, FnHandler, FromFn, Handler, HandlerFn, IntoFlow,
    IntoHandler, Seq, SetHeaders, ViaFn, ViaHandler, from_fn, set_headers,
};
pub use path::Params;
pub use request::{BodyState, PeerAddr, Req, ResponseState};
pub use response::Response;
pub use router::Router;
pub use server::{
    MAX_HEAD_BYTES, MAX_HEADER_LINES, ServeOptions, UpgradeGuard, bind, bind_to, serve,
};
pub use static_files::{ServeStatic, serve_static};

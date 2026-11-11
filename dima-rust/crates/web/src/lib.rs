//! Inbound HTTP edge that behaves like the Express app it replaces.
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md`.
//!
//! The TypeScript route tables port one to one: a [`Router`] is an ordered list of layers
//! (middleware, routes, mounted routers, error handlers) dispatched exactly like Express 4,
//! with Express's path matching, `req.query` parsing (qs), body-parser middleware ([`body`]),
//! `cors()` ([`cors`]), `res.send` / `res.json` headers (weak ETags, 304s, HEAD) and the default
//! finalhandler pages. Handlers are `async fn(&mut Req<S>) -> impl IntoFlow`; `S` is the shared
//! application state.
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
//! Serving: `dima_web::serve(listener, app, shutdown_token, ServeOptions::default()).await`.
//! A Socket.IO layer can wrap the [`App`] (it is a `tower::Service`), and handlers can take a
//! connection upgrade with [`Req::take_upgrade`].
//!
//! Not here yet (the second half of the package): static files and `sendFile` with ranges,
//! multipart uploads, SSE helpers and telemetry middleware. [`Response::from_http`] and
//! [`Req::take_body_stream`] are the seams they plug into.
#![forbid(unsafe_code)]

mod app;
pub mod body;
pub mod conditional;
pub mod cors;
mod envelope;
mod error;
mod handler;
mod mediatype;
mod negotiate;
pub mod path;
pub mod qs;
mod request;
mod response;
mod router;
mod server;
pub mod status;
pub mod uri;

/// The body type for requests and responses.
pub type Body = axum::body::Body;

pub use app::{App, ConfigError};
pub use envelope::Envelope;
pub use error::{Error, Result, RouteError};
pub use handler::{
    BoxFuture, ErrorHandler, ErrorHandlerFn, Flow, FnHandler, FromFn, Handler, HandlerFn, IntoFlow,
    IntoHandler, Seq, SetHeaders, ViaFn, ViaHandler, from_fn, set_headers,
};
pub use path::Params;
pub use request::{BodyState, PeerAddr, Req, ResponseState};
pub use response::Response;
pub use router::Router;
pub use server::{MAX_HEAD_BYTES, MAX_HEADER_LINES, ServeOptions, bind, bind_to, serve};

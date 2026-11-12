//! The application: a root router plus shared state, usable as a `tower::Service`.

use std::convert::Infallible;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::BoxError;
use axum::body::HttpBody;
use bytes::Bytes;
use futures_util::FutureExt as _;

use crate::Body;
use crate::error::{Error, RouteError};
use crate::exchange::{
    Exchange, OBSERVER_QUEUE, Observer, ObserverHub, ObserverQueue, RequestStart,
};
use crate::handler::BoxFuture;
use crate::request::Req;
use crate::response::final_response;
use crate::router::{Exit, Router};

/// Route patterns the framework refused (see [`Router::errors`]).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("route patterns refused: {0:?}")]
pub struct ConfigError(pub Vec<RouteError>);

/// An Express application: the root router, its shared state and the default 404 and error
/// responses (finalhandler in production mode).
///
/// `X-Powered-By: Express` is not sent (a deliberate difference from the reference).
pub struct App<S = ()> {
    inner: Arc<Inner<S>>,
    observer: Option<Arc<ObserverHub>>,
}

struct Inner<S> {
    router: Router<S>,
    state: Arc<S>,
}

impl<S> Clone for App<S> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
            observer: self.observer.clone(),
        }
    }
}

impl<S> std::fmt::Debug for App<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("App")
            .field("router", &self.inner.router)
            .field("observed", &self.observer.is_some())
            .finish_non_exhaustive()
    }
}

impl<S: Send + Sync + 'static> App<S> {
    /// Builds the application; fails when any registered pattern was refused.
    pub fn new(router: Router<S>, state: S) -> Result<Self, ConfigError> {
        Self::with_shared_state(router, Arc::new(state))
    }

    /// Like [`App::new`] with state that is already shared.
    pub fn with_shared_state(router: Router<S>, state: Arc<S>) -> Result<Self, ConfigError> {
        if !router.errors().is_empty() {
            return Err(ConfigError(router.errors().to_vec()));
        }
        Ok(Self {
            inner: Arc::new(Inner { router, state }),
            observer: None,
        })
    }

    /// Installs the telemetry seam: `observer` sees every request start and end (method, the
    /// matched route, status, duration, bytes sent, whether the client went away) and may attach
    /// a trace context to each request. Equivalent to the reference's first middleware
    /// (`httpTelemetry`), which watches `res` for `finish` and `close`.
    ///
    /// Completion records reach the observer on its own thread through a queue of
    /// [`OBSERVER_QUEUE`] records (see [`Observer`]); [`App::observer_queue`] reports drops and
    /// panics.
    #[must_use]
    pub fn observe(self, observer: impl Observer) -> Self {
        self.observe_bounded(observer, OBSERVER_QUEUE)
    }

    /// [`App::observe`] with a queue of `capacity` records (at least 1).
    #[must_use]
    pub fn observe_bounded(mut self, observer: impl Observer, capacity: usize) -> Self {
        self.observer = Some(Arc::new(ObserverHub::new(Arc::new(observer), capacity)));
        self
    }

    /// The installed observer's delivery queue: records dropped, calls that panicked, and
    /// [`ObserverQueue::idle`] to wait for delivery. `None` without an observer.
    pub fn observer_queue(&self) -> Option<ObserverQueue> {
        self.observer.as_ref().map(|hub| hub.queue())
    }

    /// The shared state.
    pub fn state(&self) -> &Arc<S> {
        &self.inner.state
    }

    /// Runs one request through the layers. Never fails: unhandled errors and panics become the
    /// default error page.
    pub async fn handle<B>(&self, request: http::Request<B>) -> http::Response<Body>
    where
        B: HttpBody<Data = Bytes> + Send + 'static,
        B::Error: Into<BoxError>,
    {
        let (parts, body) = request.into_parts();
        let mut req = Req::new(Arc::clone(&self.inner.state), parts, Body::new(body));
        let trace = self.observer.as_ref().and_then(|observer| {
            observer.on_request(&RequestStart {
                method: req.method(),
                url: req.original_url(),
                headers: req.headers(),
                peer: req.peer_addr(),
            })
        });
        req.trace = trace.clone();
        // Dropped with this future if the client goes away first; then it reports the abort.
        let exchange = Exchange::start(
            self.observer.clone(),
            req.closed.clone(),
            req.method().clone(),
            req.original_url().to_owned(),
            req.route_slot.clone(),
            trace,
        );
        let outcome = AssertUnwindSafe(self.inner.router.handle(&mut req))
            .catch_unwind()
            .await;
        let response = match outcome {
            Ok(Exit::Responded(response)) => response,
            Ok(Exit::Fell(error)) => final_response(&mut req, error),
            Err(_) => final_response(&mut req, Some(Error::panicked())),
        };
        exchange.finish(response, req.trace.take())
    }
}

impl<S, B> tower::Service<http::Request<B>> for App<S>
where
    S: Send + Sync + 'static,
    B: HttpBody<Data = Bytes> + Send + 'static,
    B::Error: Into<BoxError>,
{
    type Response = http::Response<Body>;
    type Error = Infallible;
    type Future = BoxFuture<'static, Result<Self::Response, Infallible>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: http::Request<B>) -> Self::Future {
        let app = self.clone();
        Box::pin(async move { Ok(app.handle(request).await) })
    }
}

//! Ordered routers and Express 4's dispatch algorithm.

use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use futures_util::FutureExt as _;
use http::Method;

use crate::Body;
use crate::error::{Error, RouteError};
use crate::handler::{BoxFuture, ErrorHandler, Flow, Handler, IntoHandler};
use crate::path::{PathMatch, PathPattern};
use crate::request::{Req, pathname};
use crate::response::{finalize, options_response};

enum LayerKind<S> {
    Middleware(Box<dyn Handler<S>>),
    ErrorHandler(Box<dyn ErrorHandler<S>>),
    Route(Route<S>),
    Mount(Arc<Router<S>>),
}

struct Route<S> {
    /// `None` for `all`.
    method: Option<Method>,
    handler: Box<dyn Handler<S>>,
}

impl<S> Route<S> {
    /// `route._handles_method(method)`: GET routes also answer HEAD.
    fn handles(&self, method: &Method) -> bool {
        match &self.method {
            None => true,
            Some(own) => own == method || (*method == Method::HEAD && *own == Method::GET),
        }
    }

    /// `route._options()`.
    fn allowed(&self) -> Vec<String> {
        match &self.method {
            None => Vec::new(),
            Some(method) if *method == Method::GET => vec!["GET".to_owned(), "HEAD".to_owned()],
            Some(method) => vec![method.as_str().to_ascii_uppercase()],
        }
    }
}

struct Layer<S> {
    pattern: PathPattern,
    kind: LayerKind<S>,
}

/// An ordered list of layers, dispatched exactly like an `express.Router()`.
///
/// Layers run in registration order. Routes (`get`, `post`, …) match the whole path; middleware,
/// mounted routers and error handlers match a path prefix on whole segments, and a mounted
/// router sees the path with that prefix removed. Matching is case-insensitive and ignores one
/// trailing slash. Pattern problems are collected and reported by [`crate::App::new`].
pub struct Router<S = ()> {
    stack: Vec<Layer<S>>,
    merge_params: bool,
    errors: Vec<RouteError>,
}

impl<S> std::fmt::Debug for Router<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let patterns: Vec<&str> = self
            .stack
            .iter()
            .map(|layer| layer.pattern.source())
            .collect();
        f.debug_struct("Router")
            .field("layers", &patterns)
            .field("merge_params", &self.merge_params)
            .finish()
    }
}

impl<S: Send + Sync + 'static> Default for Router<S> {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) enum Exit {
    Responded(http::Response<Body>),
    Fell(Option<Error>),
}

enum Outcome {
    Respond(http::Response<Body>),
    Next(Option<Error>),
    ExitRouter,
}

impl<S: Send + Sync + 'static> Router<S> {
    /// `express.Router()`.
    pub fn new() -> Self {
        Self {
            stack: Vec::new(),
            merge_params: false,
            errors: Vec::new(),
        }
    }

    /// `express.Router({ mergeParams: true })`: parameters of the mount path stay visible.
    pub fn with_merge_params() -> Self {
        Self {
            merge_params: true,
            ..Self::new()
        }
    }

    fn push(&mut self, path: &str, end: bool, kind: LayerKind<S>) -> &mut Self {
        match PathPattern::compile(path, end) {
            Ok(pattern) => self.stack.push(Layer { pattern, kind }),
            Err(error) => self.errors.push(error),
        }
        self
    }

    /// `router[method](path, handler)`.
    pub fn route<M>(
        &mut self,
        method: Method,
        path: &str,
        handler: impl IntoHandler<S, M>,
    ) -> &mut Self {
        let route = Route {
            method: Some(method),
            handler: Box::new(handler.into_handler()),
        };
        self.push(path, true, LayerKind::Route(route))
    }

    /// `router.get(path, handler)`; also answers HEAD.
    pub fn get<M>(&mut self, path: &str, handler: impl IntoHandler<S, M>) -> &mut Self {
        self.route(Method::GET, path, handler)
    }

    /// `router.post(path, handler)`.
    pub fn post<M>(&mut self, path: &str, handler: impl IntoHandler<S, M>) -> &mut Self {
        self.route(Method::POST, path, handler)
    }

    /// `router.put(path, handler)`.
    pub fn put<M>(&mut self, path: &str, handler: impl IntoHandler<S, M>) -> &mut Self {
        self.route(Method::PUT, path, handler)
    }

    /// `router.patch(path, handler)`.
    pub fn patch<M>(&mut self, path: &str, handler: impl IntoHandler<S, M>) -> &mut Self {
        self.route(Method::PATCH, path, handler)
    }

    /// `router.delete(path, handler)`.
    pub fn delete<M>(&mut self, path: &str, handler: impl IntoHandler<S, M>) -> &mut Self {
        self.route(Method::DELETE, path, handler)
    }

    /// `router.head(path, handler)`.
    pub fn head<M>(&mut self, path: &str, handler: impl IntoHandler<S, M>) -> &mut Self {
        self.route(Method::HEAD, path, handler)
    }

    /// `router.options(path, handler)`.
    pub fn options<M>(&mut self, path: &str, handler: impl IntoHandler<S, M>) -> &mut Self {
        self.route(Method::OPTIONS, path, handler)
    }

    /// `router.all(path, handler)`: every method.
    pub fn all<M>(&mut self, path: &str, handler: impl IntoHandler<S, M>) -> &mut Self {
        let route = Route {
            method: None,
            handler: Box::new(handler.into_handler()),
        };
        self.push(path, true, LayerKind::Route(route))
    }

    /// `router.use(handler)`: runs for every request that reaches this layer.
    pub fn middleware<M>(&mut self, handler: impl IntoHandler<S, M>) -> &mut Self {
        self.middleware_at("/", handler)
    }

    /// `router.use(path, handler)`: runs for requests under `path` (whole segments).
    pub fn middleware_at<M>(&mut self, path: &str, handler: impl IntoHandler<S, M>) -> &mut Self {
        self.push(
            path,
            false,
            LayerKind::Middleware(Box::new(handler.into_handler())),
        )
    }

    /// `router.use(path, childRouter)`: the child sees the path without `path`.
    pub fn mount(&mut self, path: &str, router: Router<S>) -> &mut Self {
        self.errors.extend(router.errors.iter().cloned());
        self.push(path, false, LayerKind::Mount(Arc::new(router)))
    }

    /// `router.use((err, req, res, next) => …)`: handles errors raised by earlier layers of this
    /// router (or its children). Errors raised before this router was entered never reach it.
    pub fn on_error(&mut self, handler: impl ErrorHandler<S>) -> &mut Self {
        self.on_error_at("/", handler)
    }

    /// `router.use(path, (err, req, res, next) => …)`.
    pub fn on_error_at(&mut self, path: &str, handler: impl ErrorHandler<S>) -> &mut Self {
        self.push(path, false, LayerKind::ErrorHandler(Box::new(handler)))
    }

    /// Patterns that were refused, including those of mounted routers.
    pub fn errors(&self) -> &[RouteError] {
        &self.errors
    }

    pub(crate) fn handle<'a>(&'a self, req: &'a mut Req<S>) -> BoxFuture<'a, Exit> {
        Box::pin(self.dispatch(req))
    }

    /// Express `proto.handle`.
    async fn dispatch(&self, req: &mut Req<S>) -> Exit {
        let parent_params = req.params.clone();
        let parent_url = req.base_url.clone();
        let is_options = req.method() == Method::OPTIONS;
        let is_head = req.method() == Method::HEAD;
        let mut options: Vec<String> = Vec::new();
        let mut error: Option<Error> = None;
        let mut index = 0;
        let exit = loop {
            let path = pathname(&req.url).to_owned();
            let mut found: Option<(&Layer<S>, PathMatch)> = None;
            while let Some(layer) = self.stack.get(index) {
                index += 1;
                let matched = match layer.pattern.matches(&path) {
                    Err(decode_error) => {
                        error.get_or_insert(decode_error);
                        continue;
                    }
                    Ok(None) => continue,
                    Ok(Some(matched)) => matched,
                };
                if let LayerKind::Route(route) = &layer.kind {
                    if error.is_some() {
                        continue;
                    }
                    let handles = route.handles(req.method());
                    if !handles && is_options {
                        for method in route.allowed() {
                            if !options.contains(&method) {
                                options.push(method);
                            }
                        }
                    }
                    if !handles && !is_head {
                        continue;
                    }
                }
                found = Some((layer, matched));
                break;
            }
            let Some((layer, matched)) = found else {
                break Exit::Fell(error.take());
            };
            req.params = if self.merge_params {
                matched.params.merged_over(&parent_params)
            } else {
                matched.params
            };
            let outcome = match &layer.kind {
                LayerKind::Route(route) => {
                    if route.handles(req.method()) {
                        call(route.handler.as_ref(), req).await
                    } else {
                        Outcome::Next(None)
                    }
                }
                kind => {
                    let layer_path = matched.path;
                    let mut removed = String::new();
                    let mut slash_added = false;
                    if !layer_path.is_empty() {
                        let boundary = path
                            .get(layer_path.len()..)
                            .and_then(|rest| rest.chars().next());
                        if !path.starts_with(layer_path.as_str())
                            || boundary.is_some_and(|c| c != '/' && c != '.')
                        {
                            continue;
                        }
                        req.url = req.url.get(layer_path.len()..).unwrap_or("").to_owned();
                        if !req.url.starts_with('/') {
                            req.url.insert(0, '/');
                            slash_added = true;
                        }
                        let trimmed = layer_path.strip_suffix('/').unwrap_or(&layer_path);
                        req.base_url = format!("{parent_url}{trimmed}");
                        removed = layer_path;
                    }
                    let outcome = match (error.take(), kind) {
                        (Some(pending), LayerKind::ErrorHandler(handler)) => {
                            call_error(handler.as_ref(), pending, req).await
                        }
                        (Some(pending), _) => Outcome::Next(Some(pending)),
                        (None, LayerKind::Middleware(handler)) => call(handler.as_ref(), req).await,
                        (None, LayerKind::Mount(child)) => match child.handle(req).await {
                            Exit::Responded(response) => Outcome::Respond(response),
                            Exit::Fell(child_error) => Outcome::Next(child_error),
                        },
                        (None, LayerKind::ErrorHandler(_) | LayerKind::Route(_)) => {
                            Outcome::Next(None)
                        }
                    };
                    if slash_added {
                        req.url.remove(0);
                    }
                    if !removed.is_empty() {
                        req.base_url.clone_from(&parent_url);
                        req.url = format!("{removed}{}", req.url);
                    }
                    outcome
                }
            };
            match outcome {
                Outcome::Respond(response) => break Exit::Responded(response),
                Outcome::Next(next_error) => error = next_error,
                Outcome::ExitRouter => break Exit::Fell(None),
            }
        };
        let exit = match exit {
            Exit::Fell(None) if is_options && !options.is_empty() => {
                match options_response(req, &options) {
                    Ok(response) => Exit::Responded(response),
                    Err(send_error) => Exit::Fell(Some(send_error)),
                }
            }
            other => other,
        };
        req.params = parent_params;
        req.base_url = parent_url;
        exit
    }
}

/// Runs a handler, turning panics into errors and answers into HTTP.
async fn call<S: Send + Sync + 'static>(handler: &dyn Handler<S>, req: &mut Req<S>) -> Outcome {
    let result = AssertUnwindSafe(handler.call(req))
        .catch_unwind()
        .await
        .unwrap_or_else(|_| Err(Error::panicked()));
    settle(result, req)
}

async fn call_error<S: Send + Sync + 'static>(
    handler: &dyn ErrorHandler<S>,
    error: Error,
    req: &mut Req<S>,
) -> Outcome {
    let result = AssertUnwindSafe(handler.call(error, req))
        .catch_unwind()
        .await
        .unwrap_or_else(|_| Err(Error::panicked()));
    settle(result, req)
}

fn settle<S>(result: Result<Flow, Error>, req: &mut Req<S>) -> Outcome {
    match result {
        // `next('route')` outside a route behaves like `next()`.
        Ok(Flow::Next | Flow::NextRoute) => Outcome::Next(None),
        Ok(Flow::NextRouter) => Outcome::ExitRouter,
        Ok(Flow::Respond(response)) => match response
            .into_checked()
            .and_then(|response| finalize(response, req))
        {
            Ok(response) => Outcome::Respond(response),
            Err(send_error) => Outcome::Next(Some(send_error)),
        },
        Err(error) => Outcome::Next(Some(error)),
    }
}

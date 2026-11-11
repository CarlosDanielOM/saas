//! What handlers, middleware and error handlers are, and how control passes between layers.

use std::future::Future;
use std::pin::Pin;

use crate::error::Error;
use crate::request::Req;
use crate::response::Response;

/// A boxed, sendable future borrowing for `'a`.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What a layer does with the request: Express's `next()`, `next('route')`, `next('router')`,
/// or answering. Errors are the `Err` side of the handler's `Result` (`next(err)`).
#[derive(Debug)]
pub enum Flow {
    /// `next()`: continue with the next matching layer.
    Next,
    /// `next('route')`: skip the rest of this route's handlers.
    NextRoute,
    /// `next('router')`: leave the current router.
    NextRouter,
    /// Answer the request.
    Respond(Response),
}

impl From<Response> for Flow {
    fn from(response: Response) -> Self {
        Flow::Respond(response)
    }
}

/// Values a handler may return: a [`Response`], a [`Flow`], or a `Result` of either.
pub trait IntoFlow {
    /// Converts into the layer outcome.
    fn into_flow(self) -> Result<Flow, Error>;
}

impl IntoFlow for Flow {
    fn into_flow(self) -> Result<Flow, Error> {
        Ok(self)
    }
}

impl IntoFlow for Response {
    fn into_flow(self) -> Result<Flow, Error> {
        Ok(Flow::Respond(self))
    }
}

impl<T, E> IntoFlow for Result<T, E>
where
    T: IntoFlow,
    E: Into<Error>,
{
    fn into_flow(self) -> Result<Flow, Error> {
        self.map_err(Into::into).and_then(IntoFlow::into_flow)
    }
}

/// A request handler or middleware (Express `(req, res, next)`).
///
/// Register handlers through [`IntoHandler`]: every `async fn(&mut Req<S>) -> impl IntoFlow`
/// converts, as do the built-in middleware (body parsers, CORS) and tuples of handlers, which
/// run in order like Express's `router.get(path, auth, handler)`.
pub trait Handler<S>: Send + Sync + 'static {
    /// Runs the handler.
    fn call<'a>(&'a self, req: &'a mut Req<S>) -> BoxFuture<'a, Result<Flow, Error>>;
}

/// Names the future an async handler function returns for one borrow of the request.
pub trait HandlerFn<'a, S: 'a>: Send + Sync + 'static {
    /// The handler's return value.
    type Output: IntoFlow;
    /// The future the handler returns.
    type Future: Future<Output = Self::Output> + Send + 'a;
    /// Calls the function.
    fn invoke(&self, req: &'a mut Req<S>) -> Self::Future;
}

impl<'a, S: 'a, F, Fut> HandlerFn<'a, S> for F
where
    F: Fn(&'a mut Req<S>) -> Fut + Send + Sync + 'static,
    Fut: Future + Send + 'a,
    Fut::Output: IntoFlow,
{
    type Output = Fut::Output;
    type Future = Fut;

    fn invoke(&self, req: &'a mut Req<S>) -> Fut {
        self(req)
    }
}

/// An async function used as a [`Handler`].
pub struct FnHandler<F>(F);

impl<S, F> Handler<S> for FnHandler<F>
where
    S: Send + Sync + 'static,
    F: for<'a> HandlerFn<'a, S>,
{
    fn call<'a>(&'a self, req: &'a mut Req<S>) -> BoxFuture<'a, Result<Flow, Error>> {
        Box::pin(async move { self.0.invoke(req).await.into_flow() })
    }
}

/// Values that can be registered as a handler. `M` only tells the impls apart (functions,
/// handler values, tuples); callers never name it.
pub trait IntoHandler<S, M>: Send + Sync + 'static {
    /// The handler this becomes.
    type Handler: Handler<S>;
    /// Converts.
    fn into_handler(self) -> Self::Handler;
}

/// Marker: an async function.
#[derive(Debug)]
pub enum ViaFn {}

/// Marker: a value that already is a [`Handler`].
#[derive(Debug)]
pub enum ViaHandler {}

impl<S, F> IntoHandler<S, ViaFn> for F
where
    S: Send + Sync + 'static,
    F: for<'a> HandlerFn<'a, S>,
{
    type Handler = FnHandler<F>;

    fn into_handler(self) -> FnHandler<F> {
        FnHandler(self)
    }
}

impl<S, H> IntoHandler<S, ViaHandler> for H
where
    H: Handler<S>,
{
    type Handler = H;

    fn into_handler(self) -> H {
        self
    }
}

/// Handlers run in order until one does something other than `next()`.
pub struct Seq<T>(T);

macro_rules! sequence {
    ($(($name:ident, $marker:ident)),+) => {
        impl<S, $($name, $marker),+> IntoHandler<S, ($($marker,)+)> for ($($name,)+)
        where
            S: Send + Sync + 'static,
            $($name: IntoHandler<S, $marker>,)+
            $($marker: 'static,)+
        {
            type Handler = Seq<($($name::Handler,)+)>;

            #[allow(non_snake_case)]
            fn into_handler(self) -> Self::Handler {
                let ($($name,)+) = self;
                Seq(($($name.into_handler(),)+))
            }
        }

        impl<S, $($name),+> Handler<S> for Seq<($($name,)+)>
        where
            S: Send + Sync + 'static,
            $($name: Handler<S>,)+
        {
            #[allow(non_snake_case)]
            fn call<'a>(&'a self, req: &'a mut Req<S>) -> BoxFuture<'a, Result<Flow, Error>> {
                let ($($name,)+) = &self.0;
                Box::pin(async move {
                    $(
                        match $name.call(req).await? {
                            Flow::Next => {}
                            other => return Ok(other),
                        }
                    )+
                    Ok(Flow::Next)
                })
            }
        }
    };
}

sequence!((A, MA), (B, MB));
sequence!((A, MA), (B, MB), (C, MC));
sequence!((A, MA), (B, MB), (C, MC), (D, MD));
sequence!((A, MA), (B, MB), (C, MC), (D, MD), (E, ME));

/// An error handler (Express's four-argument `(err, req, res, next)` middleware).
///
/// Return `Err(err)` to pass the error on, `Ok(Flow::Next)` to clear it and continue, or a
/// response to answer.
pub trait ErrorHandler<S>: Send + Sync + 'static {
    /// Runs the handler.
    fn call<'a>(&'a self, error: Error, req: &'a mut Req<S>) -> BoxFuture<'a, Result<Flow, Error>>;
}

/// Names the future an async error handler returns for one borrow of the request.
pub trait ErrorHandlerFn<'a, S: 'a>: Send + Sync + 'static {
    /// The handler's return value.
    type Output: IntoFlow;
    /// The future the handler returns.
    type Future: Future<Output = Self::Output> + Send + 'a;
    /// Calls the function.
    fn invoke(&self, error: Error, req: &'a mut Req<S>) -> Self::Future;
}

impl<'a, S: 'a, F, Fut> ErrorHandlerFn<'a, S> for F
where
    F: Fn(Error, &'a mut Req<S>) -> Fut + Send + Sync + 'static,
    Fut: Future + Send + 'a,
    Fut::Output: IntoFlow,
{
    type Output = Fut::Output;
    type Future = Fut;

    fn invoke(&self, error: Error, req: &'a mut Req<S>) -> Fut {
        self(error, req)
    }
}

impl<S, F> ErrorHandler<S> for F
where
    S: Send + Sync + 'static,
    F: for<'a> ErrorHandlerFn<'a, S>,
{
    fn call<'a>(&'a self, error: Error, req: &'a mut Req<S>) -> BoxFuture<'a, Result<Flow, Error>> {
        Box::pin(async move { self.invoke(error, req).await.into_flow() })
    }
}

/// Middleware from a synchronous closure, for one-liners such as
/// `res.setHeader('Cache-Control', 'no-store'); next()`.
pub fn from_fn<S, F>(f: F) -> FromFn<F>
where
    F: Fn(&mut Req<S>) -> Result<Flow, Error> + Send + Sync + 'static,
{
    FromFn(f)
}

/// See [`from_fn`].
pub struct FromFn<F>(F);

impl<S, F> Handler<S> for FromFn<F>
where
    S: Send + Sync + 'static,
    F: Fn(&mut Req<S>) -> Result<Flow, Error> + Send + Sync + 'static,
{
    fn call<'a>(&'a self, req: &'a mut Req<S>) -> BoxFuture<'a, Result<Flow, Error>> {
        // Runs when polled, inside the router's panic guard.
        Box::pin(async move { (self.0)(req) })
    }
}

/// Middleware that sets response headers and continues (`res.set({...}); next()`).
pub fn set_headers(headers: &[(&str, &str)]) -> SetHeaders {
    SetHeaders(
        headers
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
    )
}

/// See [`set_headers`].
pub struct SetHeaders(Vec<(String, String)>);

impl<S> Handler<S> for SetHeaders
where
    S: Send + Sync + 'static,
{
    fn call<'a>(&'a self, req: &'a mut Req<S>) -> BoxFuture<'a, Result<Flow, Error>> {
        Box::pin(async move {
            self.0
                .iter()
                .try_for_each(|(name, value)| req.set_header(name, value))
                .map(|()| Flow::Next)
        })
    }
}

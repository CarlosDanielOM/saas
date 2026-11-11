//! CORS middleware equal to the `cors` 2.8.6 package.
//!
//! [`cors()`] is `cors()` with default options: every response gets
//! `Access-Control-Allow-Origin: *`, and every `OPTIONS` request is answered `204` with the
//! default methods and the requested headers reflected. Coverage is defined by where the
//! middleware sits in the layer order, exactly as in Express.

use std::sync::Arc;

use crate::error::Error;
use crate::handler::{BoxFuture, Flow, Handler};
use crate::request::Req;
use crate::response::Response;

type OriginFn = Arc<dyn Fn(Option<&str>) -> bool + Send + Sync>;

/// The `origin` option.
#[derive(Clone)]
pub enum Origin {
    /// `'*'` (the default).
    Any,
    /// A fixed origin string, sent as is with `Vary: Origin`.
    Exact(String),
    /// A static allow-check (an array or `RegExp` in the package): the request origin is
    /// reflected when allowed, otherwise no `Access-Control-Allow-Origin`; `Vary: Origin` always.
    Allow(OriginFn),
    /// A callback (`origin: (origin, done) => done(null, allowed)`): when it allows, the request
    /// origin is reflected; when it refuses, the middleware adds nothing and calls `next()` (also
    /// for preflights).
    Callback(OriginFn),
}

impl std::fmt::Debug for Origin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Any => f.write_str("Any"),
            Self::Exact(origin) => f.debug_tuple("Exact").field(origin).finish(),
            Self::Allow(_) => f.write_str("Allow(..)"),
            Self::Callback(_) => f.write_str("Callback(..)"),
        }
    }
}

/// `cors(options)`.
#[derive(Debug, Clone)]
pub struct Cors {
    origin: Origin,
    methods: String,
    allowed_headers: Option<String>,
    exposed_headers: Option<String>,
    credentials: bool,
    max_age: Option<String>,
    preflight_continue: bool,
    options_success_status: u16,
}

/// `cors()` with the package defaults.
pub fn cors() -> Cors {
    Cors {
        origin: Origin::Any,
        methods: "GET,HEAD,PUT,PATCH,POST,DELETE".to_owned(),
        allowed_headers: None,
        exposed_headers: None,
        credentials: false,
        max_age: None,
        preflight_continue: false,
        options_success_status: 204,
    }
}

impl Cors {
    /// `origin`.
    #[must_use]
    pub fn origin(mut self, origin: Origin) -> Self {
        self.origin = origin;
        self
    }

    /// `methods` (joined with `,`).
    #[must_use]
    pub fn methods(mut self, methods: &[&str]) -> Self {
        self.methods = methods.join(",");
        self
    }

    /// `allowedHeaders` (joined with `,`); without it the request's
    /// `Access-Control-Request-Headers` is reflected.
    #[must_use]
    pub fn allowed_headers(mut self, headers: &[&str]) -> Self {
        self.allowed_headers = Some(headers.join(","));
        self
    }

    /// `exposedHeaders` (joined with `,`).
    #[must_use]
    pub fn exposed_headers(mut self, headers: &[&str]) -> Self {
        self.exposed_headers = Some(headers.join(","));
        self
    }

    /// `credentials: true`.
    #[must_use]
    pub fn credentials(mut self, credentials: bool) -> Self {
        self.credentials = credentials;
        self
    }

    /// `maxAge` in seconds.
    #[must_use]
    pub fn max_age(mut self, seconds: u64) -> Self {
        self.max_age = Some(seconds.to_string());
        self
    }

    /// `preflightContinue`: let preflights through to later layers.
    #[must_use]
    pub fn preflight_continue(mut self, value: bool) -> Self {
        self.preflight_continue = value;
        self
    }

    /// `optionsSuccessStatus` (default 204).
    #[must_use]
    pub fn options_success_status(mut self, status: u16) -> Self {
        self.options_success_status = status;
        self
    }

    fn apply<S>(&self, req: &mut Req<S>) -> Result<Flow, Error> {
        let request_origin = req.header("origin").map(|o| o.into_owned());
        let request_origin = request_origin.as_deref();
        // `originCallback(origin, (err, origin) => …)`: a refusing callback skips CORS entirely.
        let reflect = match &self.origin {
            Origin::Callback(allow) if !allow(request_origin) => return Ok(Flow::Next),
            Origin::Callback(_) => Some(true),
            Origin::Allow(allow) => Some(allow(request_origin)),
            Origin::Any | Origin::Exact(_) => None,
        };
        let preflight = req.method() == http::Method::OPTIONS;
        match (&self.origin, reflect) {
            (Origin::Any, _) => req.set_header("Access-Control-Allow-Origin", "*")?,
            (Origin::Exact(origin), _) => {
                req.set_header("Access-Control-Allow-Origin", origin)?;
                req.vary("Origin")?;
            }
            (_, allowed) => {
                if let (Some(true), Some(origin)) =
                    (allowed, request_origin.filter(|o| !o.is_empty()))
                {
                    req.set_header("Access-Control-Allow-Origin", origin)?;
                }
                req.vary("Origin")?;
            }
        }
        if self.credentials {
            req.set_header("Access-Control-Allow-Credentials", "true")?;
        }
        if preflight {
            if !self.methods.is_empty() {
                req.set_header("Access-Control-Allow-Methods", &self.methods)?;
            }
            let allowed = match &self.allowed_headers {
                Some(headers) => Some(headers.clone()),
                None => {
                    req.vary("Access-Control-Request-Headers")?;
                    req.header("access-control-request-headers")
                        .map(|h| h.into_owned())
                }
            };
            if let Some(allowed) = allowed.filter(|h| !h.is_empty()) {
                req.set_header("Access-Control-Allow-Headers", &allowed)?;
            }
            if let Some(max_age) = self.max_age.as_deref().filter(|m| !m.is_empty()) {
                req.set_header("Access-Control-Max-Age", max_age)?;
            }
        }
        if let Some(exposed) = self.exposed_headers.as_deref().filter(|h| !h.is_empty()) {
            req.set_header("Access-Control-Expose-Headers", exposed)?;
        }
        if preflight && !self.preflight_continue {
            req.set_status(self.options_success_status);
            return Ok(Flow::Respond(
                Response::new().header("Content-Length", "0").end(),
            ));
        }
        Ok(Flow::Next)
    }
}

impl<S: Send + Sync + 'static> Handler<S> for Cors {
    fn call<'a>(&'a self, req: &'a mut Req<S>) -> BoxFuture<'a, Result<Flow, Error>> {
        let outcome = self.apply(req);
        Box::pin(async move { outcome })
    }
}

//! The four seams, implemented on the [`Telemetry`] handle.
//!
//! - Inbound HTTP (`httpTelemetry`): [`TracedService`] wraps the application service so each
//!   request runs inside its context (adopting the signed `traceparent` of our own services,
//!   otherwise a new trace); [`WebObserver`] (installed with `dima_web::App::observe`) ends the
//!   request's span as `<METHOD> <route>` with outcome `aborted`, `error` (5xx) or the status.
//!   The route comes from the registered patterns only (a mount parameter is `:id`); a method
//!   outside the standard set is `OTHER`. `/observability` requests are not observed.
//!
//! Every derived name goes through the bounded registry of [`crate::names`].
//! - Outbound HTTP (`instrumentFetch`): [`HttpObserver`] records an `http_client` span
//!   `<provider> <METHOD>` per attempt (outcome `error` for a failure or a status of 400 and above,
//!   else the status); PostHog and analytics are not instrumented. [`Injector`] adds the signed
//!   `traceparent` to calls to providers marked internal.
//! - MongoDB: [`MongoHook`] records a `database` span `mongo.<command>` per command this backend
//!   sends (`mongo.other` for any other command name).
//! - Dragonfly: [`DragonflyHook`] records a `cache` span per instrumented command and the
//!   `cache_lookup` hit or miss of `get` and `hGet`; [`Telemetry::dragonfly_hooks`] adds the
//!   connection-error report with the reference's 30-second suppression.

use crate::label::safe_route;
use crate::names;
use crate::telemetry::Telemetry;
use crate::trace::{self, SIGNATURE, TRACEPARENT, TraceContext};
use dima_http::observe::{RequestEnd as HttpEnd, TraceInjector};
use dima_store::dragonfly::hooks::{CacheLookup, CommandOutcome, ErrorLogLine, SuppressedErrorLog};
use dima_store::mongo::connection::{CommandFailed, CommandSucceeded};
use futures_util::future::Either;
use http::{HeaderMap, HeaderValue, Request};
use std::sync::{Arc, PoisonError};
use std::task::{Context, Poll};

fn observed(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or_default();
    !path.starts_with("/observability")
}

impl Telemetry {
    /// The context of an inbound request: a child of the caller's span when the trace header is
    /// signed with our key, otherwise a new trace.
    pub fn inbound_context(&self, headers: &HeaderMap) -> TraceContext {
        let header = |name: &str| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
        };
        let remote = trace::verify(self.secret(), header(TRACEPARENT), header(SIGNATURE));
        let ids = self.new_ids(remote);
        TraceContext::linked(ids, remote.map(|remote| remote.span_id), self.now_ms()).0
    }

    /// The inbound observer for `dima_web::App::observe`.
    pub fn web_observer(&self) -> WebObserver {
        WebObserver {
            telemetry: self.clone(),
        }
    }

    /// Wraps the application service so every request runs inside its trace context.
    pub fn traced_service<T>(&self, inner: T) -> TracedService<T> {
        TracedService {
            inner,
            telemetry: self.clone(),
        }
    }

    /// The outbound observer for `dima_http::HttpClientBuilder::observer`.
    pub fn http_observer(&self) -> Arc<dyn dima_http::observe::Observer> {
        Arc::new(HttpObserver {
            telemetry: self.clone(),
        })
    }

    /// The trace-header injector for `dima_http::HttpClientBuilder::trace_injector`.
    pub fn trace_injector(&self) -> Arc<dyn TraceInjector> {
        Arc::new(Injector {
            telemetry: self.clone(),
        })
    }

    /// The command hook for `dima_store::mongo::MongoStore::connect`.
    pub fn mongo_hook(&self) -> Arc<dyn dima_store::mongo::CommandHook> {
        Arc::new(MongoHook {
            telemetry: self.clone(),
        })
    }

    /// The hooks for `dima_store::dragonfly::Dragonfly::connect`: command spans and
    /// connection-error lines on the console, at most one per error per 30 seconds.
    pub fn dragonfly_hooks(&self) -> dima_store::dragonfly::Hooks {
        let telemetry = self.clone();
        let errors = SuppressedErrorLog::new(move |line: &ErrorLogLine<'_>| {
            let suffix = if line.suppressed > 0 {
                format!(
                    " (suppressed {} similar errors in last {}s)",
                    line.suppressed,
                    dima_store::dragonfly::hooks::ERROR_LOG_WINDOW.as_secs()
                )
            } else {
                String::new()
            };
            telemetry.console_error(&format!(
                "Error connecting to DragonFlyDB from {}{suffix}: {} ({})",
                line.error.caller, line.error.error, line.error.code
            ));
        });
        dima_store::dragonfly::Hooks {
            command: Some(Arc::new(DragonflyHook {
                telemetry: self.clone(),
            })),
            errors: Some(Arc::new(errors)),
        }
    }

    pub(crate) fn excluded(&self, provider: &str) -> bool {
        self.0.http_exclude.iter().any(|name| name == provider)
    }
}

/// What the inbound observer keeps per request.
#[derive(Clone, Debug)]
pub struct HttpSpan {
    ids: crate::trace::SpanIds,
    link: Arc<crate::trace::Link>,
}

impl HttpSpan {
    /// The request's context, for handlers that run work outside [`TracedService`]: run it with
    /// [`TraceContext::scope`]. A channel bound inside still reaches the request's span.
    pub fn context(&self) -> TraceContext {
        TraceContext::from_link(self.ids, self.link.clone())
    }
}

/// See the module documentation.
#[derive(Clone, Debug)]
pub struct WebObserver {
    telemetry: Telemetry,
}

impl dima_web::Observer for WebObserver {
    fn on_request(&self, start: &dima_web::RequestStart<'_>) -> Option<dima_web::TraceContext> {
        if !self.telemetry.exporting() || !observed(start.url) {
            return None;
        }
        let context = trace::current()
            .filter(|context| context.link().is_some())
            .unwrap_or_else(|| self.telemetry.inbound_context(start.headers));
        let link = context.link()?.clone();
        Some(dima_web::TraceContext::new(HttpSpan {
            ids: context.ids(),
            link,
        }))
    }

    fn on_response(&self, end: dima_web::RequestEnd) {
        let Some(span) = end.trace.as_ref().and_then(|trace| trace.get::<HttpSpan>()) else {
            return;
        };
        let link = &span.link;
        let method = names::method(&end.method);
        let name = match &end.route {
            None => names::join(method, " ", "/unmatched"),
            Some(route) => names::intern(&format!("{method} {}", route_name(route))),
        };
        let set = *link.outcome.lock().unwrap_or_else(PoisonError::into_inner);
        let outcome = match (set, end.aborted, end.status) {
            (Some(outcome), _, _) => outcome,
            (None, true, _) | (None, false, None) => "aborted",
            (None, false, Some(code)) if code >= 500 => "error",
            (None, false, Some(code)) => names::status(code),
        };
        let ids = span.ids;
        let channel = *link.channel.lock().unwrap_or_else(PoisonError::into_inner);
        self.telemetry.finish_span(&crate::aggregate::FinishedSpan {
            trace_id: ids.trace_id,
            span_id: ids.span_id,
            parent: link.parent,
            sampled: ids.sampled,
            channel,
            at: Some(link.at),
            duration_ms: end.duration.as_secs_f64() * 1000.0,
            kind: "http",
            name,
            outcome,
        });
    }
}

/// The route's name from its registered patterns only: the reference's
/// `safeRoute(req.baseUrl + req.route.path)`, except that a parameter of a mount (`baseUrl` holds
/// its value as requested) is written `:id` whatever its value, where the reference hides only
/// values of five or more digits or 24 or more hex characters and keeps a login or any other
/// text as it came. Numeric channel ids therefore give the reference's names
/// (`/duels/:id/duel/state`); no request value ever becomes part of a name.
fn route_name(route: &dima_web::MatchedRoute) -> String {
    let mount = route
        .pattern
        .strip_suffix(route.path.as_str())
        .unwrap_or(route.pattern.as_str());
    let mut name = String::with_capacity(route.pattern.len());
    for (index, segment) in mount.split('/').enumerate() {
        if index > 0 {
            name.push('/');
        }
        name.push_str(if segment.starts_with(':') {
            ":id"
        } else {
            segment
        });
    }
    name.push_str(&route.path);
    safe_route(&name)
}

/// See [`Telemetry::traced_service`].
#[derive(Clone, Debug)]
pub struct TracedService<T> {
    inner: T,
    telemetry: Telemetry,
}

impl<T, B> tower::Service<Request<B>> for TracedService<T>
where
    T: tower::Service<Request<B>>,
{
    type Response = T::Response;
    type Error = T::Error;
    type Future = Either<T::Future, tokio::task::futures::TaskLocalFuture<TraceContext, T::Future>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, request: Request<B>) -> Self::Future {
        let path = request.uri().path();
        if !self.telemetry.exporting() || path.starts_with("/observability") {
            return Either::Left(self.inner.call(request));
        }
        let context = self.telemetry.inbound_context(request.headers());
        Either::Right(context.scope(self.inner.call(request)))
    }
}

/// See the module documentation.
#[derive(Debug)]
pub struct HttpObserver {
    telemetry: Telemetry,
}

impl dima_http::observe::Observer for HttpObserver {
    fn request_end(&self, end: &HttpEnd<'_>) {
        if !self.telemetry.exporting() || self.telemetry.excluded(end.provider) {
            return;
        }
        let outcome = match (end.failure, end.status) {
            (Some(_), _) => "error",
            (None, Some(code)) if code >= 400 => "error",
            (None, Some(code)) => names::status(code),
            (None, None) => "aborted",
        };
        let name = names::join(end.provider, " ", names::method(end.method));
        self.telemetry
            .completed_span("http_client", name, end.duration, outcome, None);
    }
}

/// See the module documentation.
#[derive(Debug)]
pub struct Injector {
    telemetry: Telemetry,
}

impl TraceInjector for Injector {
    /// The current span's ids (a fresh trace when there is none). The reference passes the id of
    /// the `http_client` span it opens for the call; the seam has no per-attempt handle, so the
    /// callee's span is parented to the caller's current span instead (same trace).
    fn inject(&self, _provider: &'static str, headers: &mut HeaderMap) {
        let Some(secret) = self.telemetry.secret() else {
            return;
        };
        let ids = trace::current_ids().unwrap_or_else(|| self.telemetry.new_ids(None));
        let Some((parent, signature)) = trace::sign(secret, &ids) else {
            return;
        };
        if let (Ok(parent), Ok(signature)) = (
            HeaderValue::from_str(parent.as_str()),
            HeaderValue::from_str(&signature),
        ) {
            headers.insert(TRACEPARENT, parent);
            headers.insert(SIGNATURE, signature);
        }
    }
}

/// See the module documentation.
#[derive(Debug)]
pub struct MongoHook {
    telemetry: Telemetry,
}

/// The span name of a command: `mongo.<command>` for the commands this backend sends, and
/// `mongo.other` for anything else (a driver's internal command, a new command), so a command
/// name never creates a series of its own.
fn mongo_name(command: &str) -> &'static str {
    const KNOWN: [(&str, &str); 20] = [
        ("find", "mongo.find"),
        ("insert", "mongo.insert"),
        ("update", "mongo.update"),
        ("delete", "mongo.delete"),
        ("aggregate", "mongo.aggregate"),
        ("findAndModify", "mongo.findAndModify"),
        ("getMore", "mongo.getMore"),
        ("count", "mongo.count"),
        ("distinct", "mongo.distinct"),
        ("createIndexes", "mongo.createIndexes"),
        ("bulkWrite", "mongo.bulkWrite"),
        ("killCursors", "mongo.killCursors"),
        ("commitTransaction", "mongo.commitTransaction"),
        ("abortTransaction", "mongo.abortTransaction"),
        ("listCollections", "mongo.listCollections"),
        ("listIndexes", "mongo.listIndexes"),
        ("create", "mongo.create"),
        ("drop", "mongo.drop"),
        ("dropIndexes", "mongo.dropIndexes"),
        ("ping", "mongo.ping"),
    ];
    KNOWN
        .iter()
        .find(|(name, _)| *name == command)
        .map_or("mongo.other", |(_, label)| label)
}

impl dima_store::mongo::CommandHook for MongoHook {
    fn succeeded(&self, event: &CommandSucceeded<'_>) {
        self.telemetry.completed_span(
            "database",
            mongo_name(event.command_name),
            event.duration,
            "ok",
            None,
        );
    }

    fn failed(&self, event: &CommandFailed<'_>) {
        self.telemetry.completed_span(
            "database",
            mongo_name(event.command_name),
            event.duration,
            "error",
            None,
        );
    }

    fn dropped_paths(&self, event: &dima_store::mongo::write::DroppedPaths<'_>) {
        self.telemetry.error(
            &serde_json::json!({
                "function": "mongo.write",
                "operation": event.operation,
                "collection": event.collection,
                "droppedPaths": event.paths,
            }),
            crate::LogOptions::console(),
        );
    }
}

/// See the module documentation.
#[derive(Debug)]
pub struct DragonflyHook {
    telemetry: Telemetry,
}

impl dima_store::dragonfly::CommandHook for DragonflyHook {
    fn finished(
        &self,
        method: &'static str,
        elapsed: std::time::Duration,
        outcome: CommandOutcome,
    ) {
        let (result, lookup) = match outcome {
            CommandOutcome::Ok { lookup } => ("ok", lookup),
            CommandOutcome::Error => ("error", None),
        };
        self.telemetry
            .completed_span("cache", method, elapsed, result, None);
        if let Some(lookup) = lookup
            && self.telemetry.exporting()
        {
            let outcome = match lookup {
                CacheLookup::Hit => "hit",
                CacheLookup::Miss => "miss",
            };
            self.telemetry.record(
                "cache_lookup",
                method,
                0.0,
                outcome,
                trace::current_channel(),
            );
        }
    }
}

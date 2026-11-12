//! The three routes `server.ts` declares itself (`server.ts:178-266`), and the seams of the
//! two services they read.

use super::failure;
use crate::state::{RouteState, ServiceKey, service};
use dima_telemetry::LogOptions;
use dima_web::sse::{self, SseOptions};
use dima_web::{Error, Req, Response};
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use std::sync::Arc;

/// `getReservedCommandsPayload(language)` (`server/services/command_defaults.service.ts`),
/// provided by P4-SVC-COMMANDS.
pub trait ReservedCommands: Send + Sync {
    /// The payload for `language` (`None` when the query has no string `language`).
    fn payload(&self, language: Option<&str>) -> Value;
}

/// Why a snapshot could not be read (logged; the client sees the reference's 500).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct SnapshotError(pub String);

/// `getSiteAnalyticsSnapshot()` (`utils/siteanalytics.ts`, ported as
/// [`dima_stream::site_analytics::SiteAnalytics`]).
pub trait SiteSnapshots: Send + Sync {
    /// The snapshot as the reference serialises it.
    fn snapshot(&self) -> BoxFuture<'_, Result<Value, SnapshotError>>;
}

impl SiteSnapshots for dima_stream::site_analytics::SiteAnalytics {
    fn snapshot(&self) -> BoxFuture<'_, Result<Value, SnapshotError>> {
        Box::pin(async move {
            let snapshot = self
                .get_site_analytics_snapshot()
                .await
                .map_err(|error| SnapshotError(error.to_string()))?;
            serde_json::to_value(snapshot).map_err(|error| SnapshotError(error.to_string()))
        })
    }
}

/// What the binary registers for this module's routes.
pub const SERVICES: &[ServiceKey] = &[
    ServiceKey::of::<dyn ReservedCommands>(),
    ServiceKey::of::<dyn SiteSnapshots>(),
];

/// `GET /config/commands/reserved` (`server.ts:178`).
pub async fn reserved_commands<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let commands: Arc<dyn ReservedCommands> = service(req)?;
    let data = commands.payload(req.query_str("language"));
    Ok(Response::new().json(&json!({
        "error": false,
        "message": "Commands fetched successfully",
        "status": 200,
        "data": data,
    })))
}

fn log_failure<S: RouteState>(req: &Req<S>, route: &str, error: &SnapshotError) {
    req.state().core().telemetry.error(
        &json!({ "function": route, "error": error.0 }),
        LogOptions::console(),
    );
}

/// `GET /config/site/analytics` (`server.ts:190`).
pub async fn site_analytics<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let snapshots: Arc<dyn SiteSnapshots> = service(req)?;
    match snapshots.snapshot().await {
        Ok(snapshot) => Ok(Response::new().json(&json!({
            "error": false,
            "message": "Site analytics fetched successfully",
            "status": 200,
            "data": snapshot,
        }))),
        Err(error) => {
            log_failure(req, "GET /config/site/analytics", &error);
            Ok(failure(500, "Internal server error"))
        }
    }
}

/// `GET /config/site/analytics/stream` (`server.ts:215`): the headers at once, then the
/// snapshot as an unnamed `data:` event, again every [`super::SiteStreamConfig::interval`],
/// and `: keep-alive` every [`super::SiteStreamConfig::heartbeat`]. A first snapshot that
/// fails ends the stream (the reference had already flushed the headers and called
/// `res.end()`); a later one is logged and skipped.
pub async fn site_analytics_stream<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let snapshots: Arc<dyn SiteSnapshots> = service(req)?;
    let timing = req.state().core().config.site_stream;
    let telemetry = req.state().core().telemetry.clone();
    let (events, body) = sse::channel(SseOptions::new().heartbeat(timing.heartbeat, "keep-alive"));
    let report = move |error: SnapshotError| {
        telemetry.error(
            &json!({ "function": "GET /config/site/analytics/stream", "error": error.0 }),
            LogOptions::console(),
        );
    };
    tokio::spawn(async move {
        let send = |snapshot: Value| {
            let events = events.clone();
            async move { events.data(dima_text::to_js_json(&snapshot)).await }
        };
        match snapshots.snapshot().await {
            Ok(snapshot) => {
                if send(snapshot).await.is_err() {
                    return;
                }
            }
            Err(error) => return report(error),
        }
        let mut every = tokio::time::interval_at(
            tokio::time::Instant::now() + timing.interval,
            timing.interval,
        );
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                () = events.closed() => return,
                _ = every.tick() => {}
            }
            let next = tokio::select! {
                () = events.closed() => return,
                next = snapshots.snapshot() => next,
            };
            match next {
                Ok(snapshot) => {
                    if send(snapshot).await.is_err() {
                        return;
                    }
                }
                Err(error) => report(error),
            }
        }
    });
    Ok(Response::new()
        .header("Content-Type", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .header("Connection", "keep-alive")
        .stream(body))
}

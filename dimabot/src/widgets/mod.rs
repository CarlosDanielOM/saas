//! Dead by Daylight and overlay widget domain.
//!
//! Ports `dimabot/src/widgets/catalog.ts`, `event-model.ts`, `events.ts`,
//! `model.ts`, `service.ts`, and `server/routes/widgets.route.ts`. Catalog
//! data is embedded. Channel documents live in `widget_channels`. Domain
//! events fan out through `events` and persist in `service`. The HTTP router
//! keeps the source path, method, auth, and envelope rules.
//!
//! Constructors take injected clients. Index installation is explicit.
//! Overlay tokens use the provisional codec in `roulette_runtime::service`
//! until team2-api-data lands the canonical module.

#![cfg(feature = "widgets-runtime")]

pub mod catalog;
pub mod event_model;
pub mod events;
pub mod model;
pub mod route;
pub mod service;

pub use catalog::{Catalog, catalog};
pub use route::{WidgetHttpState, router, router_with_duel};
pub use service::{WidgetService, WidgetServiceError};

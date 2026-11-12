//! DBD widget model, catalog, timed transitions and public overlay projection.
//!
//! P4-FEAT-WIDGETS: the pure domain and Mongo service. Routes and realtime use
//! `WidgetService`; the cron calls `settle_due` once per second. The command host
//! supplies `WidgetPolls`. P4-FEAT-OVERLAYS owns token encryption and recovery and
//! uses `token_document`/`save_token`. Command `widget.signal` belongs to the feed.
//! Clock, randomness, store and poll deadlines are explicit dependencies.

pub mod model;
pub use model::{
    WidgetError, catalog, config, initial, layout, normalize, public_state, reveal, settle, start,
};

pub mod events;
pub mod service;
pub use service::{Loaded, PollRequest, ServiceError, WidgetConfig, WidgetPolls, WidgetService};

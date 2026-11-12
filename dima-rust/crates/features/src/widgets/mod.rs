//! DBD widget model, catalog, timed transitions and public overlay projection.
//!
//! This is the pure portion of P4-FEAT-WIDGETS (`widgets/catalog.ts` and
//! `widgets/model.ts`). The command host and
//! routes can use these validators without sockets or store connections. Persistence,
//! poll effects, event rules and token operations are not implemented
//! here yet. `widget_feed` owns command signals, independently of this DBD model.
//!
//! Mixed JSON is retained deliberately: old active runs and unrecognized stored fields
//! must survive normalization and public projection. Configuration writes are validated
//! against the catalog. Text limits count Unicode scalar values, as MIGRATION.md requires.
//! The caller supplies epoch milliseconds and a `dima_core::Random`. There is no
//! environment, network or database access in this module. Pure settling must be wrapped
//! in a revision compare-and-set by the future service; it is not a durable cron tick.

pub mod model;
pub use model::{
    WidgetError, catalog, config, initial, layout, normalize, public_state, reveal, settle, start,
};

//! `dimadb-server`: the dimadb console backend, a drop-in replacement for `node server/index.mjs`
//! (`dimadb/server/*.mjs`). Rules for everything in this workspace are in
//! `dima-rust/MIGRATION.md`; the inventory of the service is `dima-rust/ledger/satellites.md`
//! section 4.
//!
//! - [`config`]: environment, read once.
//! - [`store`]: the data directory (users, sessions, connections, secret) and its crypto.
//! - [`auth`], [`connections`]: accounts, sessions, the connection registry.
//! - [`redis_hub`], [`mongo_hub`], [`ejson`]: the two engines and the document format.
//! - [`http`]: the routes and the static files.
#![forbid(unsafe_code)]

pub mod auth;
pub mod config;
pub mod connections;
pub mod ejson;
pub mod error;
pub mod http;
pub mod js;
pub mod js_errors;
pub mod mongo_hub;
pub mod redis_hub;
pub mod store;

use std::sync::Arc;

use dima_core::{Clock, Random};

/// Builds the application over a configuration (also used by the interoperability tests).
pub fn build(
    config: config::Config,
    clock: Arc<dyn Clock>,
    random: Arc<dyn Random>,
) -> anyhow::Result<dima_web::App<http::State>> {
    let store = store::Store::open(&config.data_dir, config.secret.as_ref(), random)?;
    let collator = dima_text::Collator::new()?;
    let state = http::State {
        config,
        store,
        clock,
        redis: redis_hub::RedisHub::default(),
        mongo: mongo_hub::MongoHub::default(),
        collator,
    };
    let mut root = dima_web::Router::new();
    root.middleware(http::handle);
    Ok(dima_web::App::new(root, state)?)
}

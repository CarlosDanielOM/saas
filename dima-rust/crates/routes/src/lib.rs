//! Every HTTP router of the API (`dima-server`, port 3000), and the table that mounts them in the
//! reference's order (`dimabot/src/server/server.ts`).
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md`; the plan for this
//! crate is `ledger/upper-layers.md` (layer 9 of section 2.3, section 4).
//!
//! The route files of the reference hold logic (13,000 lines), and the charter keeps binaries to
//! wiring, so the routers live here and the API binary only builds [`mounts::build`] and serves
//! it. Each router file of the reference is one function of a package module, `fn <name><S:
//! `[`state::RouteState`]`>() -> dima_web::Router<S>`, named by the mount table
//! ([`mounts::MOUNTS`]); a route package fills its module's routers and touches nothing else.
//! Every router is empty until its package lands, so every request answers the 404 of an
//! unmatched route.
//!
//! # Dependencies, and why
//!
//! - `dima-site-agent`, `dima-realtime`, `dima-services`: what the routes call.
//! - `dima-recap`: the clip recommendation reads.
//! - `dima-chat`: the EventSub test route runs the bot's handler in the API (lead's decision on
//!   plan question 3).
//! - `dima-web`: the router; `dima-platform`: the guards ([`mounts::Guard`] names them).
//!
//! # Modules and the packages that fill them
//!
//! - [`mounts`], [`state`]: P4-SKEL (done); [`mounts`] passes to P4-API-APP for the middleware.
//! - [`app`], by P4-API-APP (wave 1).
//! - [`auth`], by P4-API-AUTH-A (wave 2); [`auth::account`]: P4-API-AUTH-B (wave 3).
//! - [`users`], by P4-API-USERS; [`admins`]: P4-API-ADMINS; [`admin_site`]: P4-API-ADMIN-SITE;
//!   [`billing`]: P4-API-BILLING; [`data`]: P4-API-DATA (wave 2).
//! - [`triggers::library`], by P4-API-TRIGGERS-A (wave 2); [`triggers`]: P4-API-TRIGGERS-B
//!   (wave 3).
//! - [`commands`], by P4-API-COMMANDS (wave 3).
//! - [`channel`], by P4-API-CHANNEL; [`dimafx`]: P4-API-DIMAFX; [`agent`]: P4-API-AGENT (wave 4).
//! - [`media`], by P4-API-MEDIA (wave 5).
//! - [`overlays`], by P4-API-OVERLAYS (wave 6).
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod admin_site;
pub mod admins;
pub mod agent;
pub mod app;
pub mod auth;
pub mod billing;
pub mod channel;
pub mod commands;
pub mod data;
pub mod dimafx;
pub mod media;
pub mod mounts;
pub mod overlays;
pub mod state;
pub mod triggers;
pub mod users;

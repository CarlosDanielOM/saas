//! The dashboard's site agent (sessions, turns streamed over SSE, tools that read and write a
//! channel's settings with approvals, the change log and undo) and the public docs assistant.
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md`; the plan for this
//! crate is `ledger/upper-layers.md` (layer 9 of section 2.3).
//!
//! # Dependencies, and why
//!
//! - `dima-services`: the write tools go through the same services as the dashboard's routes.
//! - `dima-actions` and below: commands are checked and simulated with the engine and its host;
//!   the AI catalog; usage and money through `dima-billing`.
//!
//! Only the API links this crate (`dima-routes::agent`).
//!
//! # Modules and the packages that fill them
//!
//! - [`core`], by P4-SA-CORE-A (wave 1).
//! - [`docs`], by P4-SA-DOCS (wave 1).
//! - [`store`], [`usage`], [`llm`]: P4-SA-CORE-B (wave 2).
//! - [`tools`], by P4-SA-TOOLS-A and P4-SA-TOOLS-B (wave 2); [`docs_assistant`]: P4-SA-TOOLS-B.
//! - [`tools::write`], by P4-SA-WRITE-A; [`tools::write::settings`]: P4-SA-WRITE-B and
//!   P4-SA-WRITE-C (wave 3).
//! - [`runner`], by P4-SA-RUNNER (wave 3).
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod core;
pub mod docs;
pub mod docs_assistant;
pub mod llm;
pub mod runner;
pub mod store;
pub mod tools;
pub mod usage;

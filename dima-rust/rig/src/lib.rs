//! Side-by-side rig for the Rust migration: runs the reference (TypeScript/Node) and the Rust
//! candidate on the same scenario from the same initial state and compares what each one did —
//! HTTP responses, the final MongoDB state and the final Dragonfly state — with run-time values
//! (generated ids, times, ports) normalised. See `rig/README.md` for the file formats.
#![forbid(unsafe_code)]

pub mod allow;
pub mod bytesens;
pub mod canon;
pub mod capture;
pub mod compare;
pub mod config;
pub mod detect;
pub mod dfcmd;
pub mod error;
pub mod getlist;
pub mod mock;
pub mod msgpack;
pub mod path;
pub mod report;
pub mod run;
pub mod scenario;
pub mod side;
pub mod steps;
pub mod stores;
pub mod target;
pub mod template;
pub mod timefmt;
pub mod value;

#[cfg(test)]
mod tests;

//! MongoDB access that stays compatible with the TypeScript (Mongoose 8 on the Node driver)
//! writing the same collections.
//!
//! The specification is `dima-rust/ledger/mongo.md`, section "Rules a Rust data layer must
//! follow to stay compatible"; every rule this module implements was checked against what
//! Mongoose 8.24.3 really sends and stores (`tests/mongo_golden/record.mjs` records it and
//! `tests/mongo_golden.rs` compares this module against the recording).
#![warn(missing_docs)]

pub mod date;
pub mod id;
pub mod json;
pub mod number;

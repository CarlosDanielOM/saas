//! Tests against the local MongoDB and Dragonfly (`eval "$(dima-rust/tools/test-env)"`), with
//! Twitch always the loopback mock. Each test uses its own `dima_test_twitch_<random>` database
//! and key prefix in Dragonfly database 14, removed afterwards.

#[path = "../support/mod.rs"]
mod support;

mod ambiguous;
mod concurrency;
mod deadlines;
mod directory;
mod drain;
mod fence;
mod helix;
mod parity;
mod recovery;
mod tokens;

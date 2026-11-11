//! The small core every crate and binary shares: the environment snapshot and its readers,
//! time and randomness, shutdown and supervised tasks, and crypto that interoperates byte for
//! byte with the TypeScript reference.
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md`. Library crates take
//! typed configuration structs; only binaries read the process environment, once, through
//! [`env::EnvSource`].
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod crypto;
pub mod env;
pub mod random;
pub mod secret;
pub mod time;

pub use random::{Random, RandomError, SeededRandom, SystemRandom};
pub use secret::{SecretBytes, SecretString};
pub use time::{Clock, ManualClock, SystemClock};

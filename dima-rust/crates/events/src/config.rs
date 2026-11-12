//! Typed configuration, read once by the binary from the environment.

use crate::store::DEFAULT_STORE_DEADLINE;
use std::time::Duration;

/// What the journal needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventsConfig {
    /// The bound on each store call ([`DEFAULT_STORE_DEADLINE`]).
    pub store_deadline: Duration,
}

impl Default for EventsConfig {
    fn default() -> Self {
        Self {
            store_deadline: DEFAULT_STORE_DEADLINE,
        }
    }
}

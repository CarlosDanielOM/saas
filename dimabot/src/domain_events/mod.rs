//! Pure journal wire contracts and delivery policy. These modules do no I/O.
//!
//! The journal, owner resolver, delivery leases, and producer transports remain
//! separate application services. Validation here accepts JSON without ever
//! executing user serialization hooks. Native SDK dates and native retained
//! ObjectIds/dates use explicit typed entrypoints.

#[path = "domain_event_contracts.rs"]
pub mod contracts;
#[path = "domain_event_delivery_policy.rs"]
pub mod delivery_policy;
pub mod time;
#[path = "domain_event.types.rs"]
pub mod types;

#[path = "../overlays/interaction-model.rs"]
pub mod interaction;

pub use contracts::*;
pub use delivery_policy::*;
pub use types::*;

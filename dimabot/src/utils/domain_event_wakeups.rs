//! Reuse the existing concrete Redis implementation; hints are not durable.
//! The journal and the polling consumer must share this implementation rather
//! than start a second publisher. Shutdown must be called by their owners.
pub use crate::domain_event_runtime::wakeups::{domain_event_wakeups_enabled, DomainEventWakeupListener, DomainEventWakeups, WakeupConfig, DOMAIN_EVENT_WAKEUP_CHANNEL};

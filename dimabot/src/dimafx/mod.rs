//! DimaFX delivery services ported from their TypeScript counterparts.
//!
//! [`service`] ports `dimafx.service.ts` and [`fulfillment`] ports
//! `dimafx-fulfillment.service.ts`. Queue and overlay composition also lives
//! here; thumbnail remains independently gated pending its integration.

#[cfg(feature = "dimafx-delivery")]
pub mod fulfillment;
#[cfg(feature = "dimafx-delivery")]
pub mod service;
#[cfg(feature = "dimafx-delivery")]
pub mod queue_handler;
#[cfg(feature = "dimafx-delivery")]
pub mod overlay_service;

#[cfg(feature = "dimafx-delivery")]
pub mod purchase_recovery;

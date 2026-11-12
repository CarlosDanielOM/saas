//! Billing, referrals and the Polar webhook. Package **P4-API-BILLING** fills this module; its
//! routers are empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `server/routes/billing.route.ts` (603 lines): `billingRoute`
//! - `server/routes/referral.route.ts` (392 lines): `referralRoute`
//! - `server/routes/webhooks/polarsh.webhook.ts` (48 lines): `polarshWebhook`

use crate::state::RouteState;
use dima_web::Router;

/// `polarshWebhook`, mounted at `/polar/webhook` before every body parser (raw body for the signature).
pub fn polar_webhook_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `billingRoute`, mounted at `/billing`.
pub fn billing_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `referralRoute`, mounted at `/referrals`.
pub fn referral_router<S: RouteState>() -> Router<S> {
    Router::new()
}

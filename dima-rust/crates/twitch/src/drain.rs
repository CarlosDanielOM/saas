//! FOUNDATION WORKAROUND (`dima-http`): the drain lifetime of credential exchanges.
//!
//! A refresh token Twitch has answered may be dead already; the new one exists only in that
//! answer until it is stored. So once a refresh exchange has been sent, neither the process's
//! shutdown nor a caller giving up may cancel its response or the writes that follow
//! (review finding 1).
//!
//! `dima-http` cancels every request of a client when the client's shutdown token fires and
//! offers no per-request opt-out. The workaround: exchanges go through a **second client**
//! whose own shutdown token never fires ([`exchange_client`]); each exchange request is
//! cancelled instead by this crate's drain token, which fires only when
//! [`crate::Timings::exchange_drain`] has passed after [`crate::Twitch::shutdown`] was called
//! (or at [`crate::Twitch::kill`] in tests).
//!
//! **Wanted in `dima-http`** (then this module goes): a per-request lifetime that replaces the
//! client's shutdown token, for example `RequestBuilder::drain_on(&Shutdown)` (cancelled by that
//! token only), so one client serves both, with one connection pool and one observer.

use dima_core::Shutdown;
use dima_http::{HttpClient, HttpClientBuilder};

/// Builds the client for credential exchanges ([`crate::TwitchDeps::exchange_http`]): `builder`
/// with a shutdown token that never fires (give it the process's observer, resolver and clock;
/// whatever shutdown token it carried is replaced). This crate cancels each exchange itself
/// when its drain lifetime ends.
pub fn exchange_client(builder: HttpClientBuilder) -> Result<HttpClient, dima_http::Error> {
    builder.shutdown(Shutdown::new()).build()
}

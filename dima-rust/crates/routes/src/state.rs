//! What every router of the API needs from the application state (P4-SKEL).

use dima_platform::access::HasChannelAccess;

/// The bound every router function of this crate takes: the state carries the authenticator
/// and the access service that `dima-platform`'s guards read (`require_user`,
/// `require_global_admin`, `ChannelGuard`). It is implemented for every such state.
///
/// How a router reaches its own services (the command service, the TTS queue, the site agent)
/// is P4-API-APP's to settle when it fills [`crate::app`]: a module that needs a handle declares
/// it as a trait of its own and P4-API-APP makes it a supertrait here, so the one concrete state
/// the API binary builds (P4-BIN-API) implements all of them.
pub trait RouteState: HasChannelAccess + Send + Sync + 'static {}

impl<S: HasChannelAccess + Send + Sync + 'static> RouteState for S {}

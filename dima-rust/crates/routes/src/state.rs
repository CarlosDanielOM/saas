//! How a route reaches its services, and the rule every route package follows (P4-API-APP).
//!
//! # The rule
//!
//! Every router function is `pub fn <name>_router<S: RouteState>() -> Router<S>` in its
//! package's module, named by [`crate::mounts::RouterFile::router`]. A handler gets, and only
//! gets:
//!
//! 1. **Its identity or channel from a guard.** Mount the guard in front of the handler
//!    (`router.get("/:channelID", (require_user::<S>, ChannelGuard::permission("x:view"),
//!    show))`) and read [`dima_platform::access::ChannelScope::of`],
//!    [`dima_platform::auth::AuthenticatedUser::of`] or the OAuth identity
//!    ([`crate::oauth::OAuthAccess::of`]). Those answer 500 when no guard ran, so a route
//!    mounted without its guard fails loudly instead of running anonymously. Writes take the
//!    channel from the scope (`scope.filter(..)`, `scope.channel_id()`), never from
//!    `req.param("channelID")`, the query or the body. `tests/app_hygiene.rs` refuses a
//!    route module that reads `channelID` or the raw body itself.
//! 2. **A typed body and typed parameters.** Declare a `#[derive(Deserialize)]` struct (with
//!    `#[serde(deny_unknown_fields)]` when the reference refuses extra fields) and read it with
//!    [`body`] (or [`query`]). A body that does not fit is the error
//!    `400 body.invalid` (`query.invalid`): with no handler of the router's own it ends as
//!    Express's HTML 400 page, which is what the reference answers for a body its parser
//!    refuses; a route whose reference answers its own envelope installs
//!    [`invalid_input_answer`] (or its own error handler) on its router. Never hand
//!    `req.body()` to a store call: a struct cannot carry `$`-operators or another
//!    channel's id unnoticed.
//! 3. **Its services from the state.** Cross-cutting handles are typed fields of [`Core`]
//!    (`req.state().core().mongo`, `.twitch`, `.oauth`, `.clock`, …). A service of one area is
//!    a value registered once at start in the typed registry [`Services`], by its type (a
//!    concrete `Arc<Service>` from a lower crate, or an `Arc<dyn Trait>` the route module
//!    declares as its seam), and read with [`service`]. A package that needs a new service
//!    adds nothing to a shared struct: it declares the trait (or names the type) in its own
//!    module, the binary registers an implementation, and the module lists the type in its
//!    `SERVICES` constant so the binary checks the registry at start
//!    ([`Services::missing`]). A service that is not registered answers 500 (and is logged),
//!    like a missing guard.
//!
//! ```
//! use std::sync::Arc;
//! use dima_routes::state::{RouteState, ServiceKey, body, service};
//! use dima_web::{Error, Req, Response, Router};
//! use serde::Deserialize;
//!
//! /// The seam of a service another package will provide.
//! pub trait Greetings: Send + Sync {
//!     fn greet(&self, name: &str) -> String;
//! }
//!
//! /// What the binary must register for this module's routes.
//! pub const SERVICES: &[ServiceKey] = &[ServiceKey::of::<dyn Greetings>()];
//!
//! #[derive(Deserialize)]
//! #[serde(deny_unknown_fields)]
//! struct Hello {
//!     name: String,
//! }
//!
//! async fn hello<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
//!     let input: Hello = body(req)?;
//!     let greetings: Arc<dyn Greetings> = service(req)?;
//!     Ok(Response::new().json(&serde_json::json!({ "text": greetings.greet(&input.name) })))
//! }
//!
//! pub fn greetings_router<S: RouteState>() -> Router<S> {
//!     let mut router = Router::new();
//!     router.post("/hello", hello::<S>);
//!     router
//! }
//! ```
//!
//! The concrete state is [`AppState`]; the API binary builds one (P4-BIN-API) and tests build
//! theirs the same way, registering fakes for the services they exercise.

use dima_core::{Clock, SecureRandom};
use dima_http::HttpClient;
use dima_platform::access::{ChannelAccess, HasChannelAccess};
use dima_platform::auth::{Authenticator, HasAuthenticator};
use dima_platform::oauth::OAuthService;
use dima_store::dragonfly::Dragonfly;
use dima_store::mongo::MongoStore;
use dima_twitch::Twitch;
use dima_web::{Error, Req, Response};
use serde::de::DeserializeOwned;
use serde_json::json;
use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use crate::app::AppConfig;

/// The bound every router function of this crate takes: the guards' authenticator and access
/// service ([`HasChannelAccess`]), the cross-cutting handles ([`Core`]) and the registry of
/// area services ([`Services`]). [`AppState`] implements it.
pub trait RouteState: HasChannelAccess + Send + Sync + 'static {
    /// The handles every area uses.
    fn core(&self) -> &Core;
    /// The services of each area, registered at start.
    fn services(&self) -> &Services;
}

/// The handles every route package may use, built once by the binary.
pub struct Core {
    /// MongoDB.
    pub mongo: MongoStore,
    /// Dragonfly (Rust's own logical database).
    pub dragonfly: Dragonfly,
    /// Everything on Twitch.
    pub twitch: Twitch,
    /// `authMiddleware`'s service ([`dima_platform::auth::require_user`] reads it).
    pub authenticator: Authenticator,
    /// The channel access rules ([`dima_platform::access::ChannelGuard`] reads them).
    pub access: ChannelAccess,
    /// The OAuth server of the desktop app (its routes, the desktop socket, account deletion).
    pub oauth: OAuthService,
    /// The process's outbound HTTP client.
    pub http: HttpClient,
    /// Wall clock.
    pub clock: Arc<dyn Clock>,
    /// Randomness for secrets.
    pub random: Arc<dyn SecureRandom>,
    /// Logs, metrics and the web observer.
    pub telemetry: dima_telemetry::Telemetry,
    /// The application shell's typed configuration.
    pub config: AppConfig,
}

impl fmt::Debug for Core {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Core")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

/// The API's state: [`Core`] and [`Services`].
#[derive(Debug)]
pub struct AppState {
    core: Core,
    services: Services,
}

impl AppState {
    /// The state.
    pub fn new(core: Core, services: Services) -> Self {
        Self { core, services }
    }
}

impl HasAuthenticator for AppState {
    fn authenticator(&self) -> &Authenticator {
        &self.core.authenticator
    }
}

impl HasChannelAccess for AppState {
    fn channel_access(&self) -> &ChannelAccess {
        &self.core.access
    }
}

impl RouteState for AppState {
    fn core(&self) -> &Core {
        &self.core
    }

    fn services(&self) -> &Services {
        &self.services
    }
}

/// Names a service type: `ServiceKey::of::<dyn Trait>()` or `ServiceKey::of::<Concrete>()`.
#[derive(Clone, Copy)]
pub struct ServiceKey {
    id: fn() -> TypeId,
    name: fn() -> &'static str,
}

impl ServiceKey {
    /// The key of `T` (registered as `Arc<T>`).
    pub const fn of<T: ?Sized + 'static>() -> Self {
        Self {
            id: TypeId::of::<T>,
            name: std::any::type_name::<T>,
        }
    }

    /// The type's name.
    pub fn name(&self) -> &'static str {
        (self.name)()
    }
}

impl fmt::Debug for ServiceKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

impl PartialEq for ServiceKey {
    fn eq(&self, other: &Self) -> bool {
        (self.id)() == (other.id)()
    }
}

impl Eq for ServiceKey {}

struct Entry {
    name: &'static str,
    /// Holds an `Arc<T>`.
    value: Box<dyn Any + Send + Sync>,
}

/// The typed registry of area services: one value per type, registered at start and never
/// changed afterwards.
#[derive(Default)]
pub struct Services {
    map: HashMap<TypeId, Entry>,
}

impl fmt::Debug for Services {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut names: Vec<&str> = self.map.values().map(|entry| entry.name).collect();
        names.sort_unstable();
        f.debug_struct("Services").field("types", &names).finish()
    }
}

/// A service type was registered twice.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("service registered twice: {0}")]
pub struct DuplicateService(pub &'static str);

impl Services {
    /// An empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers `service` under its type `T` (for a trait object, `Arc<dyn Trait>`).
    pub fn provide<T: ?Sized + Send + Sync + 'static>(
        &mut self,
        service: Arc<T>,
    ) -> Result<&mut Self, DuplicateService> {
        let name = std::any::type_name::<T>();
        if self.map.contains_key(&TypeId::of::<T>()) {
            return Err(DuplicateService(name));
        }
        self.map.insert(
            TypeId::of::<T>(),
            Entry {
                name,
                value: Box::new(service),
            },
        );
        Ok(self)
    }

    /// The service registered under `T`.
    pub fn get<T: ?Sized + Send + Sync + 'static>(&self) -> Option<Arc<T>> {
        self.map
            .get(&TypeId::of::<T>())
            .and_then(|entry| entry.value.downcast_ref::<Arc<T>>())
            .cloned()
    }

    /// The keys of `required` that are not registered (the binary checks this at start).
    pub fn missing(&self, required: &[ServiceKey]) -> Vec<&'static str> {
        required
            .iter()
            .filter(|key| !self.map.contains_key(&(key.id)()))
            .map(ServiceKey::name)
            .collect()
    }
}

/// The service a handler needs, from the state's registry: a 500 on the error path when the
/// binary did not register it (a wiring mistake, as loud as a missing guard).
pub fn service<T, S>(req: &Req<S>) -> Result<Arc<T>, Error>
where
    T: ?Sized + Send + Sync + 'static,
    S: RouteState,
{
    req.state().services().get::<T>().ok_or_else(|| {
        Error::new(
            500,
            format!("service not registered: {}", std::any::type_name::<T>()),
        )
        .with_kind("service.missing")
    })
}

/// The body as `T`: `400 body.invalid` on the error path when it does not fit (including the
/// `{}` a request without a body, or with another content type, leaves).
pub fn body<T: DeserializeOwned, S>(req: &Req<S>) -> Result<T, Error> {
    req.body_as::<T>()
}

/// The query as `T`: `400 query.invalid` on the error path when it does not fit.
pub fn query<T: DeserializeOwned, S>(req: &Req<S>) -> Result<T, Error> {
    req.query_as::<T>()
}

/// An error handler for routers whose reference answers its own envelope to a body or query it
/// cannot use: `body.invalid` and `query.invalid` become `status {"error":true,"message":
/// message,"status":status}`; every other error goes on.
pub fn invalid_input_answer<S: Send + Sync + 'static>(
    status: u16,
    message: &'static str,
) -> impl dima_web::ErrorHandler<S> {
    move |error: Error, _req: &mut Req<S>| {
        let invalid = matches!(error.kind(), Some("body.invalid" | "query.invalid"));
        async move {
            if invalid {
                Ok(Response::status(status)
                    .json(&json!({ "error": true, "message": message, "status": status })))
            } else {
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    trait Seam: Send + Sync {
        fn value(&self) -> u8;
    }

    struct Fixed(u8);

    impl Seam for Fixed {
        fn value(&self) -> u8 {
            self.0
        }
    }

    #[test]
    fn registry_by_type() {
        let mut services = Services::new();
        let seam: Arc<dyn Seam> = Arc::new(Fixed(7));
        services.provide::<dyn Seam>(seam).unwrap();
        services.provide(Arc::new(String::from("x"))).unwrap();
        assert_eq!(services.get::<dyn Seam>().map(|s| s.value()), Some(7));
        assert_eq!(
            services.get::<String>().as_deref().map(String::as_str),
            Some("x")
        );
        assert!(services.get::<u32>().is_none());
        let again: Arc<dyn Seam> = Arc::new(Fixed(8));
        assert!(services.provide::<dyn Seam>(again).is_err());
        assert_eq!(
            services.missing(&[ServiceKey::of::<dyn Seam>(), ServiceKey::of::<u32>()]),
            vec!["u32"]
        );
        assert_eq!(ServiceKey::of::<u32>(), ServiceKey::of::<u32>());
    }
}

//! Native OAuth desktop-beta HTTP API.
//!
//! This is the port of `dimabot/src/server/oauth/catalog.ts`, `service.ts`, and
//! `routes.ts`. [`catalog`] is pure. [`service`] talks to MongoDB, Redis, and
//! the Twitch validate endpoint. [`routes`] builds the Axum routers.
//!
//! Constructors do not connect or install indexes. Call
//! [`OAuthApiService::initialize`] before serving. `GET /me/credits` and the
//! four pet routes stay blocked until [`OAuthCreditsReader`] and
//! [`OAuthPetAccess`] are implemented by their owning teams.
//!
//! The 503 from [`UnwiredCreditsReader`] and [`UnwiredPetAccess`] is an
//! adapter-boundary convention, not source parity. The TypeScript handlers
//! always call the real credit and pet implementations. Once those adapters
//! are passed to [`OAuthApiService::new`], the routes return the adapter
//! values and this 503 disappears. A missing scope remains 403
//! `insufficient_scope` and does not call the adapter.
//!
//! [`desktop_websocket`] is the port of `desktop-websocket.ts`.
//! [`OAuthApiService::desktop_router`] merges it after the HTTP boundary, and
//! [`OAuthApiService::application_router`] nests that router at `/v1`.
//! `pet_settings.service.ts` stays behind [`OAuthPetAccess`].

pub mod catalog;
pub mod desktop_websocket;
pub mod routes;
pub mod service;

pub use desktop_websocket::{
    desktop_websocket_router, DesktopSocketGate, DESKTOP_WS_HEARTBEAT, DESKTOP_WS_MAX_MESSAGE_BYTES,
    DESKTOP_WS_PATH, DESKTOP_WS_PROTOCOL, DESKTOP_WS_ROUTE, DESKTOP_WS_UPGRADE_TIMEOUT,
};

pub use catalog::{
    ACCESS_TTL_SECONDS, CODE_TTL_SECONDS, DESKTOP_CLIENT_ID, DESKTOP_REDIRECT_URIS, ErrorBody,
    ErrorHeaders, MetadataDocument, OAUTH_SCOPES, OAuthError, RATE_LIMIT_LUA, REFRESH_IDLE_MS,
    REQUEST_TTL_SECONDS, SESSION_ABSOLUTE_MS, access_key, code_key, constant_time_eq, error_headers,
    hash, is_valid_secret, metadata_document, parse_scopes, rate_key, request_key, secret,
    validate_redirect, validate_redirect_str,
};
pub use service::{
    AccessIdentity, AuthorizationRequest, AuthorizationView, BrowserUser, ConnectionSession,
    CreditsError, ExternalFailure, ExternalKind, FailureResponse, OAuthApiService, OAuthClient,
    OAuthCreditsReader, OAuthFailure, OAuthInitError, OAuthPetAccess, PetAccessError,
    TokenResponse, UnwiredCreditsReader, UnwiredPetAccess,
};

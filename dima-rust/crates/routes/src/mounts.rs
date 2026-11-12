//! The mount table: every `app.use` and `app.get` of the reference's `server/server.ts`, in its
//! order, with the package that fills each router and the guards its routes mount (plan
//! section 4). Written once by P4-SKEL; P4-API-APP owns it and filled the middleware and the
//! four `GET` entries in [`build`]. A route package only fills its module's router; its guards
//! are listed here, and `tests/app_mounts.rs` checks them against the inventory of routes.
//!
//! Order matters exactly as in Express: the Polar webhook comes before every body parser (it
//! needs the raw body), the per-prefix JSON limits before the global one, the docs assistant and
//! OAuth before the global CORS, and `/` (`overlayRoute`) between `/triggers` and `/site`.

use crate::state::RouteState;
use dima_web::Router;

/// How a line of `server.ts` attaches its handler.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    /// `app.use(…)`.
    Use,
    /// `app.get(…)`.
    Get,
}

/// The middleware lines of `server.ts`, filled by P4-API-APP.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Middleware {
    /// `httpTelemetry`: `dima_telemetry`'s web observer and traced service.
    Telemetry,
    /// `express.json(…)`: `dima_web::body::json` with this limit in bytes (`None`: the default
    /// 100 KiB).
    Json(Option<usize>),
    /// `express.urlencoded({ extended: true })`.
    Urlencoded,
    /// `express.static(routes/public)`: `dima_web::serve_static`.
    Static,
    /// `cors()`: `dima_web::cors::cors`.
    Cors,
}

/// A route `server.ts` declares itself (`app.get`), filled by P4-API-APP.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    /// `oauthMetadata` (`server/oauth/routes.ts`).
    OAuthMetadata,
    /// The reserved commands, by language.
    ReservedCommands,
    /// The site analytics snapshot.
    SiteAnalytics,
    /// The site analytics as server-sent events (every 500 ms, a keep-alive every 30 s).
    SiteAnalyticsStream,
}

/// A router file of the reference, as `server.ts` mounts it. [`RouterFile::router`] is the
/// router function of the package module that ports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(missing_docs)] // Each variant is the router of the file `RouterFile::source` names.
pub enum RouterFile {
    PolarWebhook,
    DocsAssistant,
    OAuth,
    OAuthApi,
    Observability,
    File,
    Media,
    Clip,
    Speech,
    Auth,
    User,
    Admin,
    AdminTools,
    EmailTest,
    EmailAuth,
    Referral,
    Command,
    SiteAgent,
    Eventsub,
    BitsRules,
    AiPersonality,
    Pet,
    Memories,
    Reward,
    Trigger,
    Overlay,
    Site,
    Billing,
    Dashboard,
    Analytics,
    Timer,
    Roulette,
    Widgets,
    Goals,
    OverlayStudio,
    AssetLibrary,
    FollowDefense,
    Moderation,
    StreamSummary,
    ClipRecommendations,
    Dimafx,
    AdminSite,
}

impl RouterFile {
    /// The reference file the router comes from (under `dimabot/src/`).
    pub fn source(self) -> &'static str {
        use RouterFile as R;
        match self {
            R::PolarWebhook => "server/routes/webhooks/polarsh.webhook.ts",
            R::DocsAssistant => "server/routes/docs-assistant.route.ts",
            R::OAuth | R::OAuthApi => "server/oauth/routes.ts",
            R::Observability => "server/routes/observability.route.ts",
            R::File => "server/routes/file.route.ts",
            R::Media => "server/routes/media.route.ts",
            R::Clip => "server/routes/clip.route.ts",
            R::Speech => "server/routes/speech.route.ts",
            R::Auth => "server/routes/auth.route.ts",
            R::User => "server/routes/user.route.ts",
            R::Admin => "server/routes/admin.route.ts",
            R::AdminTools => "server/routes/admin-tools.route.ts",
            R::EmailTest => "server/routes/email-test.route.ts",
            R::EmailAuth => "server/routes/email-auth.route.ts",
            R::Referral => "server/routes/referral.route.ts",
            R::Command => "server/routes/command.route.ts",
            R::SiteAgent => "server/routes/site-agent.route.ts",
            R::Eventsub => "server/routes/eventsub.route.ts",
            R::BitsRules => "server/routes/bits-rules.route.ts",
            R::AiPersonality => "server/routes/aiPersonality.route.ts",
            R::Pet => "server/routes/pet.route.ts",
            R::Memories => "server/routes/memories.route.ts",
            R::Reward => "server/routes/reward.route.ts",
            R::Trigger => "server/routes/trigger.route.ts",
            R::Overlay => "server/routes/overlay.route.ts",
            R::Site => "server/routes/site.route.ts",
            R::Billing => "server/routes/billing.route.ts",
            R::Dashboard => "server/routes/dashboard.route.ts",
            R::Analytics => "server/routes/analytics.route.ts",
            R::Timer => "server/routes/timer.route.ts",
            R::Roulette => "server/routes/roulette.route.ts",
            R::Widgets => "server/routes/widgets.route.ts",
            R::Goals => "server/routes/goals.route.ts",
            R::OverlayStudio => "server/routes/overlay-studio.route.ts",
            R::AssetLibrary => "server/routes/asset-library.route.ts",
            R::FollowDefense => "server/routes/follow_defense.route.ts",
            R::Moderation => "server/routes/moderation.route.ts",
            R::StreamSummary => "server/routes/stream-summary.route.ts",
            R::ClipRecommendations => "server/routes/clip-recommendations.route.ts",
            R::Dimafx => "server/routes/dimafx.route.ts",
            R::AdminSite => "server/routes/admin_site.route.ts",
        }
    }

    /// The router, from the package module that ports the file.
    pub fn router<S: RouteState>(self) -> Router<S> {
        use RouterFile as R;
        match self {
            R::PolarWebhook => crate::billing::polar_webhook_router(),
            R::DocsAssistant => crate::agent::docs_assistant_router(),
            R::OAuth => crate::oauth::oauth_router(),
            R::OAuthApi => crate::oauth::oauth_api_router(),
            R::Observability => crate::observability::router(),
            R::File => crate::media::file_router(),
            R::Media => crate::media::media_router(),
            R::Clip => crate::media::clip_router(),
            R::Speech => crate::media::speech_router(),
            R::Auth => crate::auth::router(),
            R::User => crate::users::user_router(),
            R::Admin => crate::admins::admin_router(),
            R::AdminTools => crate::admins::admin_tools_router(),
            R::EmailTest => crate::users::email_test_router(),
            R::EmailAuth => crate::users::email_auth_router(),
            R::Referral => crate::billing::referral_router(),
            R::Command => crate::commands::command_router(),
            R::SiteAgent => crate::agent::site_agent_router(),
            R::Eventsub => crate::channel::eventsub_router(),
            R::BitsRules => crate::channel::bits_rules_router(),
            R::AiPersonality => crate::agent::ai_personality_router(),
            R::Pet => crate::overlays::pet_router(),
            R::Memories => crate::agent::memories_router(),
            R::Reward => crate::channel::reward_router(),
            R::Trigger => crate::triggers::router(),
            R::Overlay => crate::overlays::overlay_router(),
            R::Site => crate::channel::site_router(),
            R::Billing => crate::billing::billing_router(),
            R::Dashboard => crate::data::dashboard_router(),
            R::Analytics => crate::data::analytics_router(),
            R::Timer => crate::commands::timer_router(),
            R::Roulette => crate::overlays::roulette_router(),
            R::Widgets => crate::overlays::widgets_router(),
            R::Goals => crate::overlays::goals_router(),
            R::OverlayStudio => crate::overlays::overlay_studio_router(),
            R::AssetLibrary => crate::media::asset_library_router(),
            R::FollowDefense => crate::commands::follow_defense_router(),
            R::Moderation => crate::commands::moderation_router(),
            R::StreamSummary => crate::data::stream_summary_router(),
            R::ClipRecommendations => crate::data::clip_recommendations_router(),
            R::Dimafx => crate::dimafx::router(),
            R::AdminSite => crate::admin_site::router(),
        }
    }
}

/// What a line of `server.ts` mounts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum What {
    /// Middleware (P4-API-APP).
    Middleware(Middleware),
    /// A router file.
    Router(RouterFile),
    /// A route of `server.ts` itself (P4-API-APP).
    Route(Route),
}

/// A guard the routes of a router mount, from `dima-platform` unless said otherwise (plan
/// section 4). A router lists every guard its routes use; each route mounts the one its
/// reference check corresponds to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Guard {
    /// No authentication (public routes).
    Public,
    /// `dima_platform::auth::require_user` (`authMiddleware`).
    User,
    /// `dima_platform::auth::require_workspace_owner`, after `require_user`.
    WorkspaceOwner,
    /// `dima_platform::access::require_global_admin`, after `require_user`.
    GlobalAdmin,
    /// `dima_platform::access::ChannelGuard::owner()`: the channel or a global owner.
    ChannelOwner,
    /// `dima_platform::access::ChannelGuard::self_only()`: the channel itself only.
    ChannelSelf,
    /// `dima_platform::access::ChannelGuard::permission(…)`, each route one of these.
    ChannelPermission(&'static [&'static str]),
    /// The channel comes from the query or the body: the handler calls
    /// `dima_platform::access::ChannelAccess::scope` with one of these, as the reference does.
    ChannelInHandler(&'static [&'static str]),
    /// An OAuth access token (`dima_platform::oauth`).
    OAuthToken,
    /// The OAuth pages' browser session (`browserUser`: `require_user` with a fresh
    /// `Twitch::user_by_token`).
    BrowserUser,
    /// A token in the URL the route checks itself (overlay capability URLs, the activation
    /// JWT).
    Capability,
    /// A signature over the raw body (Polar's Standard Webhooks, `dima-billing`).
    WebhookSignature,
    /// A shared secret, compared in constant time by a small guard of this crate, named by its
    /// environment variable (`DIMAFX_SERVICE_TOKEN`, `MOCK_LOGIN_TOKEN`).
    ServiceToken(&'static str),
    /// The router's own access resolution (the site agent's `resolveAccess`, rate limit first).
    OwnAccess,
    /// No guard here: the service the router forwards to checks the caller's forwarded
    /// credentials (the analytics proxy).
    Upstream,
    /// A guard waiting for the owner's decision (the plan's question in the text); until then
    /// the routes keep the reference's behaviour.
    Undecided(&'static str),
}

/// One line of `server.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mount {
    /// The line in `dimabot/src/server/server.ts` at the baseline commit `0c71108e`.
    pub line: u32,
    /// `app.use` or `app.get`.
    pub method: Method,
    /// The path prefix (`app.use`) or path (`app.get`); `None` for global middleware.
    pub path: Option<&'static str>,
    /// What the line mounts, as `server.ts` writes it.
    pub reference: &'static str,
    /// What it becomes here.
    pub what: What,
    /// The package that fills it (plan section 3).
    pub package: &'static str,
    /// The guards its routes mount (none for middleware).
    pub guards: &'static [Guard],
}

const fn use_mw(
    line: u32,
    path: Option<&'static str>,
    reference: &'static str,
    m: Middleware,
) -> Mount {
    Mount {
        line,
        method: Method::Use,
        path,
        reference,
        what: What::Middleware(m),
        package: "P4-API-APP",
        guards: &[],
    }
}

const fn use_router(
    line: u32,
    path: &'static str,
    reference: &'static str,
    file: RouterFile,
    package: &'static str,
    guards: &'static [Guard],
) -> Mount {
    Mount {
        line,
        method: Method::Use,
        path: Some(path),
        reference,
        what: What::Router(file),
        package,
        guards,
    }
}

const fn get(line: u32, path: &'static str, reference: &'static str, route: Route) -> Mount {
    Mount {
        line,
        method: Method::Get,
        path: Some(path),
        reference,
        what: What::Route(route),
        package: "P4-API-APP",
        guards: &[Guard::Public],
    }
}

use Guard as G;
use RouterFile as F;

/// `server.ts`, line by line, in order.
pub static MOUNTS: [Mount; 54] = [
    use_mw(55, None, "httpTelemetry", Middleware::Telemetry),
    use_router(
        58,
        "/polar/webhook",
        "polarshWebhook",
        F::PolarWebhook,
        "P4-API-BILLING",
        &[G::WebhookSignature],
    ),
    use_mw(
        60,
        Some("/overlay-studio"),
        "express.json({ limit: '5mb' })",
        Middleware::Json(Some(dima_web::body::mb(5))),
    ),
    use_mw(
        62,
        Some("/commands"),
        "express.json({ limit: '1mb' })",
        Middleware::Json(Some(dima_web::body::mb(1))),
    ),
    use_router(
        64,
        "/docs-assistant",
        "docsAssistantRoute",
        F::DocsAssistant,
        "P4-API-AGENT",
        &[G::Public],
    ),
    use_mw(
        66,
        Some("/roulettes"),
        "express.json({ limit: '4mb' })",
        Middleware::Json(Some(dima_web::body::mb(4))),
    ),
    use_mw(67, None, "express.json()", Middleware::Json(None)),
    use_mw(
        68,
        None,
        "express.urlencoded({ extended: true })",
        Middleware::Urlencoded,
    ),
    use_router(
        70,
        "/oauth",
        "oauthRoute",
        F::OAuth,
        "P4-API-APP",
        &[G::Public, G::BrowserUser],
    ),
    use_router(
        71,
        "/v1",
        "oauthApiRoute",
        F::OAuthApi,
        "P4-API-APP",
        &[G::OAuthToken],
    ),
    get(
        72,
        "/.well-known/oauth-authorization-server",
        "oauthMetadata",
        Route::OAuthMetadata,
    ),
    use_mw(
        73,
        None,
        "express.static(path.join(__dirname, 'routes', 'public'))",
        Middleware::Static,
    ),
    use_mw(74, None, "cors()", Middleware::Cors),
    use_router(
        75,
        "/observability",
        "observabilityRoute",
        F::Observability,
        "P4-API-APP",
        &[G::Upstream],
    ),
    use_router(
        78,
        "/video",
        "fileRoute",
        F::File,
        "P4-API-MEDIA",
        &[G::Public],
    ),
    use_router(
        81,
        "/media",
        "mediaRoute",
        F::Media,
        "P4-API-MEDIA",
        &[G::Public],
    ),
    use_router(
        84,
        "/clip",
        "clipRoute",
        F::Clip,
        "P4-API-MEDIA",
        &[G::User, G::ChannelPermission(&["clips:manage"]), G::Public],
    ),
    use_router(
        87,
        "/speech",
        "speechRoute",
        F::Speech,
        "P4-API-MEDIA",
        &[
            G::User,
            G::ChannelPermission(&["tts:view", "tts:manage"]),
            G::Public,
            G::Undecided("plan question 1: a service credential on POST /speech/:channelID"),
        ],
    ),
    use_router(
        90,
        "/auth",
        "authRoute",
        F::Auth,
        "P4-API-AUTH-A, P4-API-AUTH-B",
        &[G::Public, G::User, G::ServiceToken("MOCK_LOGIN_TOKEN")],
    ),
    use_router(
        93,
        "/users",
        "userRoute",
        F::User,
        "P4-API-USERS",
        &[G::Public, G::User, G::ChannelOwner],
    ),
    use_router(
        96,
        "/admins",
        "adminRoute",
        F::Admin,
        "P4-API-ADMINS",
        &[
            G::User,
            G::ChannelPermission(&["admins:view", "admins:manage"]),
        ],
    ),
    use_router(
        99,
        "/admin",
        "adminToolsRoute",
        F::AdminTools,
        "P4-API-ADMINS",
        &[
            G::User,
            G::WorkspaceOwner,
            G::Undecided("plan question 10: GET /admin/read-file"),
        ],
    ),
    use_router(
        102,
        "/email",
        "emailTestRoute",
        F::EmailTest,
        "P4-API-USERS",
        &[G::User, G::WorkspaceOwner],
    ),
    use_router(
        105,
        "/email",
        "emailAuthRoute",
        F::EmailAuth,
        "P4-API-USERS",
        &[G::Capability],
    ),
    use_router(
        108,
        "/referrals",
        "referralRoute",
        F::Referral,
        "P4-API-BILLING",
        &[G::User, G::ChannelInHandler(&["referrals:view"]), G::Public],
    ),
    use_router(
        111,
        "/commands",
        "commandRoute",
        F::Command,
        "P4-API-COMMANDS",
        &[
            G::User,
            G::ChannelPermission(&["commands:manage"]),
            G::Public,
        ],
    ),
    use_router(
        114,
        "/agent",
        "siteAgentRoute",
        F::SiteAgent,
        "P4-API-AGENT",
        &[G::User, G::OwnAccess],
    ),
    use_router(
        117,
        "/eventsubs",
        "eventsubRoute",
        F::Eventsub,
        "P4-API-CHANNEL",
        &[
            G::User,
            G::ChannelPermission(&["eventsubs:manage"]),
            G::Public,
        ],
    ),
    use_router(
        118,
        "/bits-rules",
        "bitsRulesRoute",
        F::BitsRules,
        "P4-API-CHANNEL",
        &[G::User, G::ChannelPermission(&["eventsubs:manage"])],
    ),
    use_router(
        121,
        "/ai-personality",
        "aiPersonalityRoute",
        F::AiPersonality,
        "P4-API-AGENT",
        &[G::User, G::ChannelPermission(&["ai:view", "ai:manage"])],
    ),
    use_router(
        122,
        "/pets",
        "petRoute",
        F::Pet,
        "P4-API-OVERLAYS",
        &[G::User, G::ChannelSelf, G::Capability],
    ),
    use_router(
        125,
        "/memories",
        "memoriesRoute",
        F::Memories,
        "P4-API-AGENT",
        &[
            G::User,
            G::ChannelPermission(&["memories:view", "memories:manage"]),
        ],
    ),
    use_router(
        128,
        "/rewards",
        "rewardRoute",
        F::Reward,
        "P4-API-CHANNEL",
        &[
            G::User,
            G::ChannelPermission(&["rewards:view", "rewards:manage"]),
        ],
    ),
    use_router(
        131,
        "/triggers",
        "triggerRoute",
        F::Trigger,
        "P4-API-TRIGGERS-A, P4-API-TRIGGERS-B",
        &[
            G::User,
            G::ChannelPermission(&["triggers:view", "triggers:edit", "triggers:delete"]),
            G::Public,
        ],
    ),
    use_router(
        134,
        "/",
        "overlayRoute",
        F::Overlay,
        "P4-API-OVERLAYS",
        &[
            G::Public,
            G::Capability,
            G::Undecided("plan question 1: POST /overlays/furry/:channelID"),
        ],
    ),
    use_router(
        137,
        "/site",
        "siteRoute",
        F::Site,
        "P4-API-CHANNEL",
        &[G::User, G::GlobalAdmin],
    ),
    use_router(
        140,
        "/billing",
        "billingRoute",
        F::Billing,
        "P4-API-BILLING",
        &[G::User, G::ChannelInHandler(&["billing:view"])],
    ),
    use_router(
        143,
        "/dashboard",
        "dashboardRoute",
        F::Dashboard,
        "P4-API-DATA",
        &[G::User, G::ChannelPermission(&["dashboard:view"])],
    ),
    use_router(
        146,
        "/analytics",
        "analyticsRoute",
        F::Analytics,
        "P4-API-DATA",
        &[G::User, G::ChannelPermission(&["analytics:view"])],
    ),
    use_router(
        149,
        "/timers",
        "timerRoute",
        F::Timer,
        "P4-API-COMMANDS",
        &[
            G::User,
            G::ChannelPermission(&["commands:view", "commands:manage"]),
        ],
    ),
    use_router(
        150,
        "/roulettes",
        "rouletteRoute",
        F::Roulette,
        "P4-API-OVERLAYS",
        &[G::User, G::ChannelPermission(&["*"]), G::Capability],
    ),
    use_router(
        151,
        "/widgets",
        "widgetsRoute",
        F::Widgets,
        "P4-API-OVERLAYS",
        &[G::User, G::ChannelPermission(&["*"]), G::Capability],
    ),
    use_router(
        152,
        "/goals",
        "goalsRoute",
        F::Goals,
        "P4-API-OVERLAYS",
        &[G::User, G::ChannelPermission(&["dashboard:view", "*"])],
    ),
    use_router(
        153,
        "/overlay-studio",
        "overlayStudioRoute",
        F::OverlayStudio,
        "P4-API-OVERLAYS",
        &[G::User, G::ChannelSelf, G::Capability],
    ),
    use_router(
        154,
        "/asset-library",
        "assetLibraryRoute",
        F::AssetLibrary,
        "P4-API-MEDIA",
        &[G::User, G::ChannelSelf, G::Capability],
    ),
    use_router(
        157,
        "/follow-defense",
        "followDefenseRoute",
        F::FollowDefense,
        "P4-API-COMMANDS",
        &[
            G::User,
            G::ChannelPermission(&["moderation:view", "moderation:manage"]),
        ],
    ),
    use_router(
        160,
        "/moderation",
        "moderationRoute",
        F::Moderation,
        "P4-API-COMMANDS",
        &[
            G::User,
            G::ChannelPermission(&["moderation:view", "moderation:manage"]),
        ],
    ),
    use_router(
        163,
        "/stream-summaries",
        "streamSummaryRoute",
        F::StreamSummary,
        "P4-API-DATA",
        &[G::User, G::ChannelPermission(&["summaries:view"])],
    ),
    use_router(
        166,
        "/clip-recommendations",
        "clipRecommendationsRoute",
        F::ClipRecommendations,
        "P4-API-DATA",
        &[
            G::User,
            G::ChannelPermission(&["clips:view", "clips:manage"]),
        ],
    ),
    use_router(
        169,
        "/extensions/dimafx",
        "dimafxRoute",
        F::Dimafx,
        "P4-API-DIMAFX",
        &[
            G::User,
            G::ChannelPermission(&["dimafx:view", "dimafx:edit", "dimafx:delete"]),
            G::ServiceToken("DIMAFX_SERVICE_TOKEN"),
        ],
    ),
    use_router(
        172,
        "/admin-site",
        "adminSiteRoute",
        F::AdminSite,
        "P4-API-ADMIN-SITE",
        &[G::User, G::GlobalAdmin],
    ),
    get(
        178,
        "/config/commands/reserved",
        "(inline handler)",
        Route::ReservedCommands,
    ),
    get(
        190,
        "/config/site/analytics",
        "(inline handler)",
        Route::SiteAnalytics,
    ),
    get(
        215,
        "/config/site/analytics/stream",
        "(inline handler)",
        Route::SiteAnalyticsStream,
    ),
];

/// Builds the API's router from [`MOUNTS`], in order: the middleware of `server.ts` with its
/// coverage, every router file at its prefix with the router of the package module that ports it
/// (empty until that package lands), and the routes `server.ts` declares itself. The shell's
/// configuration (the static directory, the client address policy) is read from the state at
/// request time, so the table needs no argument.
pub fn build<S: RouteState>() -> Router<S> {
    let mut root = Router::new();
    for mount in &MOUNTS {
        let path = mount.path.unwrap_or("/");
        match mount.what {
            What::Router(file) => {
                root.mount(path, file.router::<S>());
            }
            // `httpTelemetry` watches every request from outside the layers:
            // `crate::app::application` installs it with `App::observe`.
            What::Middleware(Middleware::Telemetry) => {}
            What::Middleware(Middleware::Json(limit)) => {
                let parser =
                    dima_web::body::json().limit(limit.unwrap_or(dima_web::body::DEFAULT_LIMIT));
                root.middleware_at(path, parser);
            }
            What::Middleware(Middleware::Urlencoded) => {
                root.middleware_at(path, dima_web::body::urlencoded());
            }
            What::Middleware(Middleware::Static) => {
                root.middleware_at(path, crate::app::PublicFiles);
            }
            What::Middleware(Middleware::Cors) => {
                root.middleware_at(path, dima_web::cors::cors());
            }
            What::Route(Route::OAuthMetadata) => {
                root.get(path, crate::oauth::metadata::<S>);
            }
            What::Route(Route::ReservedCommands) => {
                root.get(path, crate::app::reserved_commands::<S>);
            }
            What::Route(Route::SiteAnalytics) => {
                root.get(path, crate::app::site_analytics::<S>);
            }
            What::Route(Route::SiteAnalyticsStream) => {
                root.get(path, crate::app::site_analytics_stream::<S>);
            }
        }
    }
    root
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `dimabot/src/server/server.ts` at `0c71108e`, read once: every `app.use` and `app.get`
    /// of `server()`, with its line, method, path (none for global middleware) and what it
    /// mounts.
    const SERVER_TS: [(u32, &str, Option<&str>, &str); 54] = [
        (55, "use", None, "httpTelemetry"),
        (58, "use", Some("/polar/webhook"), "polarshWebhook"),
        (
            60,
            "use",
            Some("/overlay-studio"),
            "express.json({ limit: '5mb' })",
        ),
        (
            62,
            "use",
            Some("/commands"),
            "express.json({ limit: '1mb' })",
        ),
        (64, "use", Some("/docs-assistant"), "docsAssistantRoute"),
        (
            66,
            "use",
            Some("/roulettes"),
            "express.json({ limit: '4mb' })",
        ),
        (67, "use", None, "express.json()"),
        (68, "use", None, "express.urlencoded({ extended: true })"),
        (70, "use", Some("/oauth"), "oauthRoute"),
        (71, "use", Some("/v1"), "oauthApiRoute"),
        (
            72,
            "get",
            Some("/.well-known/oauth-authorization-server"),
            "oauthMetadata",
        ),
        (
            73,
            "use",
            None,
            "express.static(path.join(__dirname, 'routes', 'public'))",
        ),
        (74, "use", None, "cors()"),
        (75, "use", Some("/observability"), "observabilityRoute"),
        (78, "use", Some("/video"), "fileRoute"),
        (81, "use", Some("/media"), "mediaRoute"),
        (84, "use", Some("/clip"), "clipRoute"),
        (87, "use", Some("/speech"), "speechRoute"),
        (90, "use", Some("/auth"), "authRoute"),
        (93, "use", Some("/users"), "userRoute"),
        (96, "use", Some("/admins"), "adminRoute"),
        (99, "use", Some("/admin"), "adminToolsRoute"),
        (102, "use", Some("/email"), "emailTestRoute"),
        (105, "use", Some("/email"), "emailAuthRoute"),
        (108, "use", Some("/referrals"), "referralRoute"),
        (111, "use", Some("/commands"), "commandRoute"),
        (114, "use", Some("/agent"), "siteAgentRoute"),
        (117, "use", Some("/eventsubs"), "eventsubRoute"),
        (118, "use", Some("/bits-rules"), "bitsRulesRoute"),
        (121, "use", Some("/ai-personality"), "aiPersonalityRoute"),
        (122, "use", Some("/pets"), "petRoute"),
        (125, "use", Some("/memories"), "memoriesRoute"),
        (128, "use", Some("/rewards"), "rewardRoute"),
        (131, "use", Some("/triggers"), "triggerRoute"),
        (134, "use", Some("/"), "overlayRoute"),
        (137, "use", Some("/site"), "siteRoute"),
        (140, "use", Some("/billing"), "billingRoute"),
        (143, "use", Some("/dashboard"), "dashboardRoute"),
        (146, "use", Some("/analytics"), "analyticsRoute"),
        (149, "use", Some("/timers"), "timerRoute"),
        (150, "use", Some("/roulettes"), "rouletteRoute"),
        (151, "use", Some("/widgets"), "widgetsRoute"),
        (152, "use", Some("/goals"), "goalsRoute"),
        (153, "use", Some("/overlay-studio"), "overlayStudioRoute"),
        (154, "use", Some("/asset-library"), "assetLibraryRoute"),
        (157, "use", Some("/follow-defense"), "followDefenseRoute"),
        (160, "use", Some("/moderation"), "moderationRoute"),
        (163, "use", Some("/stream-summaries"), "streamSummaryRoute"),
        (
            166,
            "use",
            Some("/clip-recommendations"),
            "clipRecommendationsRoute",
        ),
        (169, "use", Some("/extensions/dimafx"), "dimafxRoute"),
        (172, "use", Some("/admin-site"), "adminSiteRoute"),
        (
            178,
            "get",
            Some("/config/commands/reserved"),
            "(inline handler)",
        ),
        (
            190,
            "get",
            Some("/config/site/analytics"),
            "(inline handler)",
        ),
        (
            215,
            "get",
            Some("/config/site/analytics/stream"),
            "(inline handler)",
        ),
    ];

    #[test]
    fn the_table_is_server_ts_in_order() {
        let table: Vec<(u32, &str, Option<&str>, &str)> = MOUNTS
            .iter()
            .map(|mount| {
                let method = match mount.method {
                    Method::Use => "use",
                    Method::Get => "get",
                };
                (mount.line, method, mount.path, mount.reference)
            })
            .collect();
        assert_eq!(table, SERVER_TS);
        assert!(MOUNTS.windows(2).all(|pair| pair[0].line < pair[1].line));
    }

    /// One entry per router file `server.ts` mounts, each with a source file, a package of
    /// section 3 and at least one guard; middleware and inline routes are P4-API-APP's.
    #[test]
    fn every_router_file_has_a_package_and_guards() {
        let routers: Vec<RouterFile> = MOUNTS
            .iter()
            .filter_map(|mount| match mount.what {
                What::Router(file) => Some(file),
                _ => None,
            })
            .collect();
        assert_eq!(routers.len(), 42);
        for (index, file) in routers.iter().enumerate() {
            assert!(!routers[..index].contains(file), "{file:?} mounted twice");
        }
        let sources: std::collections::BTreeSet<&str> =
            routers.iter().map(|file| file.source()).collect();
        // `server/oauth/routes.ts` gives two routers; the other files one each. Two router files
        // are mounted by their parents, not by `server.ts`: `stream_timeline.route.ts`
        // (`analytics.route.ts:56`) and `duel-widget.route.ts` (`widgets.route.ts:28`).
        assert_eq!(sources.len(), 41);
        for mount in &MOUNTS {
            match mount.what {
                What::Router(_) => {
                    assert!(mount.package.starts_with("P4-API-"), "{}", mount.reference);
                    assert!(!mount.guards.is_empty(), "{}", mount.reference);
                }
                What::Middleware(_) => {
                    assert_eq!(mount.package, "P4-API-APP");
                    assert!(mount.guards.is_empty());
                }
                What::Route(_) => assert_eq!(mount.package, "P4-API-APP"),
            }
        }
    }

    /// The strict self checks and the owner's open questions are where the plan put them.
    #[test]
    fn guards_follow_section_four() {
        let guards = |path: &str, reference: &str| {
            MOUNTS
                .iter()
                .find(|mount| mount.path == Some(path) && mount.reference == reference)
                .map(|mount| mount.guards)
                .unwrap_or_default()
        };
        for (path, reference) in [
            ("/overlay-studio", "overlayStudioRoute"),
            ("/asset-library", "assetLibraryRoute"),
            ("/pets", "petRoute"),
        ] {
            assert!(
                guards(path, reference).contains(&Guard::ChannelSelf),
                "{path}"
            );
            assert!(
                !guards(path, reference).contains(&Guard::ChannelOwner),
                "{path}"
            );
        }
        assert!(guards("/site", "siteRoute").contains(&Guard::GlobalAdmin));
        assert!(guards("/admin-site", "adminSiteRoute").contains(&Guard::GlobalAdmin));
        assert!(guards("/speech", "speechRoute").iter().any(
            |guard| matches!(guard, Guard::Undecided(question) if question.contains("/speech/"))
        ));
        assert!(
            guards("/extensions/dimafx", "dimafxRoute")
                .contains(&Guard::ServiceToken("DIMAFX_SERVICE_TOKEN"))
        );
    }
}

//! The authentication decision table: every row recorded from the TypeScript
//! (`record-auth.mts`, `auth-reference.json`) is replayed against the Rust guards with the same
//! Twitch mock and seeded stores, and must give the same answer (status, content type, body) and
//! the same effects (cache, activity touch). Each intended difference is stated in
//! [`intended`] with its reason and counted.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod guard_support;

use anyhow::{Context, Result};
use dima_core::SystemClock;
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer};
use dima_platform::auth::cache::{
    activity_touch_key, token_cache_key, token_fence_key, user_fence_key,
};
use dima_platform::auth::twitch::{
    HttpTwitchUserApi, Scheme, TwitchAnswer, TwitchUserApi, Unreachable,
};
use dima_platform::auth::{
    AuthConfig, AuthDeps, AuthenticatedUser, Authenticator, BoundChannel, HasAuthenticator,
    NoReport, optional_user, require_user, require_workspace_owner,
};
use dima_store::dragonfly::{SetOptions, Ttl};
use dima_web::{App, Body, Req, Response, Router};
use guard_support::{Stores, endpoint, id_of, script_twitch, token_of, with_stores};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

struct State {
    auth: Authenticator,
    handler_ran: AtomicBool,
}

impl HasAuthenticator for State {
    fn authenticator(&self) -> &Authenticator {
        &self.auth
    }
}

async fn probe(req: &mut Req<State>) -> Response {
    req.state().handler_ran.store(true, Ordering::SeqCst);
    let user = AuthenticatedUser::maybe(req).cloned();
    let bound = req.extensions().get::<BoundChannel>().map(|b| b.0.clone());
    Response::new().json(&json!({ "next": true, "user": user, "bound": bound }))
}

fn app(auth: Authenticator) -> Result<App<State>> {
    let mut router = Router::new();
    router.get("/probe", (require_user::<State>, probe));
    router.get("/probe/:channelID", (require_user::<State>, probe));
    router.get("/optional", (optional_user::<State>, probe));
    router.get(
        "/workspace",
        (
            require_user::<State>,
            require_workspace_owner::<State>,
            probe,
        ),
    );
    Ok(App::new(
        router,
        State {
            auth,
            handler_ran: AtomicBool::new(false),
        },
    )?)
}

async fn send(app: &App<State>, path: &str, header: Option<&str>) -> Result<(u16, String, String)> {
    let mut request = http::Request::builder().method("GET").uri(path);
    if let Some(value) = header {
        request = request.header("authorization", value);
    }
    let response = app.handle(request.body(Body::empty())?).await;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let body = response.into_body().collect().await?.to_bytes();
    Ok((status, content_type, String::from_utf8(body.to_vec())?))
}

fn authenticator(
    stores: &Stores,
    server: &MockServer,
    client_id: &str,
    config: Option<AuthConfig>,
) -> Result<Authenticator> {
    let http = HttpClient::builder().build()?;
    let oauth = server.provider(dima_twitch::oauth_provider())?;
    let helix = server.provider(dima_twitch::helix_provider(client_id))?;
    Ok(Authenticator::new(
        config.unwrap_or(AuthConfig::new(client_id)?),
        AuthDeps {
            twitch: Arc::new(HttpTwitchUserApi::new(http, oauth, helix)),
            cache: stores.cache.clone(),
            mongo: stores.mongo.clone(),
            clock: Arc::new(SystemClock),
            report: Arc::new(NoReport),
        },
    ))
}

async fn seed_site_users(stores: &Stores, cases: &Value) -> Result<()> {
    use dima_model::users::{AccountType, NewAccount, NewUser};
    use dima_store::mongo::WriteContext;
    for kind in cases["site_users"].as_array().context("site_users")? {
        let kind = kind.as_str().context("kind")?;
        let mut account = NewAccount::new(AccountType::Twitch, id_of(kind, &stores.run));
        account.name = Some(format!("login_{kind}"));
        let user = NewUser {
            name: Some(format!("site_{kind}")),
            accounts: vec![account],
            ..NewUser::default()
        };
        let prepared = user.prepare(&mut WriteContext::new(dima_core::Clock::now_ms(
            &SystemClock,
        )))?;
        stores
            .mongo
            .writes(dima_model::users::COLLECTION)
            .insert_one(&prepared)
            .await?;
    }
    Ok(())
}

/// What one row did on the Rust side.
#[derive(Debug)]
struct Observed {
    status: u16,
    content_type: String,
    body: String,
    handler_ran: bool,
    twitch_calls: Vec<&'static str>,
    cached: bool,
    cache_ttl: Option<i64>,
    touch_key_ttl: Option<i64>,
    activity_stamped: Option<bool>,
}

/// The rows whose answer or effects differ from the reference on purpose, with the reason. The
/// check replaces the plain comparison for those fields.
fn intended(name: &str, reference: &Value, observed: &Observed) -> Option<&'static str> {
    match name {
        "optional_without_token" | "optional_with_revoked_token" => {
            // `optionalAuthMiddleware` wrote the 401 and then called the handler anyway (its
            // answer was lost, its side effects were not). No route uses it; here the handler
            // runs without a user and answers.
            assert_eq!(reference["status"], 401);
            assert_eq!(reference["handlerRan"], true);
            assert_eq!(observed.status, 200);
            assert!(observed.handler_ran);
            assert_eq!(
                serde_json::from_str::<Value>(&observed.body).unwrap(),
                json!({"next": true, "user": null, "bound": null})
            );
            Some("optional authentication answers through the handler instead of a lost 401")
        }
        _ => None,
    }
}

/// Twitch calls the Rust guard leaves out on purpose (same answer).
fn expected_calls(name: &str, reference: &[String]) -> Vec<String> {
    match name {
        // Not an OAuth token (a space inside, or longer than 2048): refused without asking
        // Twitch, which refuses it the same way.
        "lowercase_scheme" | "double_space_after_scheme" | "oauth_scheme" | "overlong_token" => {
            vec![]
        }
        // `/validate` named another application: refused before `/users` (which refuses it too).
        "foreign_client_token" => vec!["validate".to_owned()],
        _ => reference.to_vec(),
    }
}

#[tokio::test]
async fn decision_table_matches_the_reference() -> Result<()> {
    let cases: Value = serde_json::from_str(include_str!("auth-cases.json"))?;
    let reference: Value = serde_json::from_str(include_str!("auth-reference.json"))?;
    guard_support::check_drift(&reference)?;
    with_stores(14, |stores| async move {
        let client_id = cases["client_id"].as_str().context("client_id")?;
        let server = MockServer::start().await?;
        script_twitch(&server, &cases, &stores.run);
        seed_site_users(&stores, &cases).await?;
        let app = app(authenticator(&stores, &server, client_id, None)?)?;
        let run = stores.run.clone();
        let kinds: Vec<String> = cases["tokens"]
            .as_object()
            .context("tokens")?
            .keys()
            .cloned()
            .chain(["cached_revoked", "long"].map(str::to_owned))
            .collect();
        for kind in &kinds {
            stores.track(token_cache_key(&token_of(kind, &run)));
        }
        let substitute = |text: &str| {
            let mut out = text.to_owned();
            for kind in kinds
                .iter()
                .map(String::as_str)
                .chain(["valid", "nopic", "nosite", "channel", "creator"])
            {
                out = out
                    .replace(&format!("$TOKEN({kind})"), &token_of(kind, &run))
                    .replace(&format!("$ID({kind})"), &id_of(kind, &run));
            }
            out
        };
        let rows = cases["rows"].as_array().context("rows")?;
        let recorded = reference["rows"].as_array().context("rows")?;
        assert_eq!(rows.len(), recorded.len(), "the recording has every case");
        let (mut same, mut changed) = (0, Vec::new());
        for (row, expected) in rows.iter().zip(recorded) {
            let name = row["name"].as_str().context("name")?;
            assert_eq!(expected["name"], row["name"]);
            let token = row["token"].as_str().map(|kind| token_of(kind, &run));
            let user = row["user"].as_str();
            if let Some(user) = user {
                stores.track(activity_touch_key(&id_of(user, &run)));
            }
            if let (Some(seed), Some(token)) = (row["seed"].as_str(), token.as_deref()) {
                let value = json!({"id": id_of(seed, &run), "login": format!("login_{seed}"),
                    "display_name": format!("Display {seed}"), "profile_image_url": ""});
                stores
                    .cache
                    .set(
                        &token_cache_key(token),
                        &serde_json::to_vec(&value)?,
                        SetOptions::ex(3600),
                    )
                    .await?;
            }
            let header = row["header"]
                .as_str()
                .map(|h| h.replace("$TOKEN", token.as_deref().unwrap_or_default()));
            let path = row["path"]
                .as_str()
                .context("path")?
                .replace("$CHANNEL", &id_of("channel", &run));
            app.state().handler_ran.store(false, Ordering::SeqCst);
            let before = server.requests().len();
            let (status, content_type, body) = send(&app, &path, header.as_deref()).await?;
            let calls = server.requests()[before..].iter().map(endpoint).collect();
            let ttl = |ttl: Ttl| match ttl {
                Ttl::Seconds(s) => s,
                Ttl::Missing => -2,
                Ttl::NoExpiry => -1,
            };
            let observed = Observed {
                status,
                content_type,
                body,
                handler_ran: app.state().handler_ran.load(Ordering::SeqCst),
                twitch_calls: calls,
                cached: match &token {
                    Some(t) => stores.cache.exists(&[&token_cache_key(t)]).await? == 1,
                    None => false,
                },
                cache_ttl: match &token {
                    Some(t) => Some(ttl(stores.cache.ttl(&token_cache_key(t)).await?)),
                    None => None,
                },
                touch_key_ttl: match user {
                    Some(u) => Some(ttl(stores
                        .cache
                        .ttl(&activity_touch_key(&id_of(u, &run)))
                        .await?)),
                    None => None,
                },
                activity_stamped: match user {
                    Some(u) => Some(activity_stamped(&stores, &id_of(u, &run)).await?),
                    None => None,
                },
            };
            let expires_in = row["token"]
                .as_str()
                .and_then(|kind| cases["tokens"][kind]["validate"]["body"]["expires_in"].as_u64());
            if let Some(reason) = intended(name, expected, &observed) {
                changed.push((name.to_owned(), reason));
                continue;
            }
            assert_eq!(
                observed.status,
                expected["status"].as_u64().unwrap() as u16,
                "{name}: status"
            );
            assert_eq!(
                observed.content_type,
                expected["contentType"].as_str().unwrap(),
                "{name}: content type"
            );
            assert_eq!(
                observed.body,
                substitute(expected["body"].as_str().unwrap()),
                "{name}: body"
            );
            assert_eq!(
                observed.handler_ran,
                expected["handlerRan"].as_bool().unwrap(),
                "{name}: handler"
            );
            let reference_calls: Vec<String> =
                serde_json::from_value(expected["twitchCalls"].clone())?;
            assert_eq!(
                observed.twitch_calls,
                expected_calls(name, &reference_calls),
                "{name}: Twitch calls"
            );
            assert_eq!(
                observed.cached,
                expected["cached"].as_bool().unwrap(),
                "{name}: cached"
            );
            if observed.cached {
                // Intended: at most an hour, and never past the token's own `expires_in`
                // (the reference kept every entry 14000 s).
                let bound = expires_in.unwrap_or(3600).min(3600) as i64;
                let ttl = observed.cache_ttl.unwrap();
                assert!(
                    ttl > 0 && ttl <= bound,
                    "{name}: cache lifetime {ttl} > {bound}"
                );
                assert_eq!(
                    expected["cacheTtl"].as_i64().map(|t| t > 13_000),
                    Some(true)
                );
            }
            match (observed.touch_key_ttl, expected["touchKeyTtl"].as_i64()) {
                (Some(rust), Some(node)) if node > 0 => {
                    assert!(rust > 86_000 && rust <= 86_400, "{name}: touch {rust}")
                }
                (rust, node) => assert_eq!(
                    rust.filter(|t| *t > 0),
                    node.filter(|t| *t > 0),
                    "{name}: touch key"
                ),
            }
            assert_eq!(
                observed.activity_stamped,
                expected["activityStamped"].as_bool(),
                "{name}: activity"
            );
            same += 1;
        }
        assert_eq!(same + changed.len(), rows.len());
        assert_eq!(changed.len(), 2, "rows changed on purpose: {changed:?}");
        // No key holds a token.
        for kind in &kinds {
            let token = token_of(kind, &run);
            let mut scan = stores.cache.scan(&format!("*{token}*"), Some(200));
            while let Some(page) = scan.next_page().await? {
                assert!(page.is_empty(), "a key contains a token");
            }
        }
        Ok(())
    })
    .await
}

async fn activity_stamped(stores: &Stores, twitch_id: &str) -> Result<bool> {
    let found = stores
        .mongo
        .documents(dima_model::users::COLLECTION)
        .find_one(bson::doc! { "accounts.id": twitch_id })
        .await?;
    Ok(found.is_some_and(|user| {
        matches!(
            user.get("last_app_activity_at"),
            Some(bson::Bson::DateTime(_))
        )
    }))
}

/// A Twitch that does not answer in time is "Failed to validate token", never access.
#[tokio::test]
async fn twitch_that_hangs_is_a_refusal() -> Result<()> {
    let cases: Value = serde_json::from_str(include_str!("auth-cases.json"))?;
    with_stores(14, |stores| async move {
        let client_id = cases["client_id"].as_str().context("client_id")?;
        let server = MockServer::start().await?;
        server.push(MockResponse::json(200, "{}").delay(Duration::from_secs(5)));
        let mut config = AuthConfig::new(client_id)?;
        config.twitch_timeout = Duration::from_millis(300);
        let app = app(authenticator(&stores, &server, client_id, Some(config))?)?;
        let token = token_of("hang", &stores.run);
        stores.track(token_cache_key(&token));
        let started = std::time::Instant::now();
        let (status, _, body) = send(&app, "/probe", Some(&format!("Bearer {token}"))).await?;
        assert_eq!(status, 401);
        assert_eq!(
            body,
            r#"{"error":true,"message":"Failed to validate token","status":401,"type":"invalid_token"}"#
        );
        assert!(started.elapsed() < Duration::from_secs(4));
        assert!(!app.state().handler_ran.load(Ordering::SeqCst));
        Ok(())
    })
    .await
}

/// A cache that cannot be reached is a miss: Twitch decides (the reference's behaviour), and the
/// request is not held up past the store deadline.
#[tokio::test]
async fn unreachable_cache_falls_back_to_twitch() -> Result<()> {
    let cases: Value = serde_json::from_str(include_str!("auth-cases.json"))?;
    with_stores(14, |stores| async move {
        let client_id = cases["client_id"].as_str().context("client_id")?;
        let server = MockServer::start().await?;
        script_twitch(&server, &cases, &stores.run);
        let silent = silent_dragonfly().await?;
        let mut config = AuthConfig::new(client_id)?;
        config.store_deadline = Duration::from_millis(200);
        let http = HttpClient::builder().build()?;
        let auth = Authenticator::new(
            config,
            AuthDeps {
                twitch: Arc::new(HttpTwitchUserApi::new(
                    http,
                    server.provider(dima_twitch::oauth_provider())?,
                    server.provider(dima_twitch::helix_provider(client_id))?,
                )),
                cache: silent,
                mongo: stores.mongo.clone(),
                clock: Arc::new(SystemClock),
                report: Arc::new(NoReport),
            },
        );
        let app = app(auth)?;
        let good = token_of("valid", &stores.run);
        let (status, _, body) = send(&app, "/probe", Some(&format!("Bearer {good}"))).await?;
        assert_eq!(status, 200, "{body}");
        let revoked = token_of("revoked", &stores.run);
        let (status, _, _) = send(&app, "/probe", Some(&format!("Bearer {revoked}"))).await?;
        assert_eq!(status, 401);
        Ok(())
    })
    .await
}

/// A Dragonfly that accepts the connection and answers the handshake, then never again.
async fn silent_dragonfly() -> Result<dima_store::dragonfly::Dragonfly> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buffer = vec![0_u8; 4096];
                let mut answered_ping = false;
                loop {
                    let Ok(n) = socket.read(&mut buffer).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    let text = String::from_utf8_lossy(&buffer[..n]).to_ascii_uppercase();
                    if answered_ping {
                        continue; // never answer again
                    }
                    let mut replies = String::new();
                    for line in text.split("\r\n") {
                        match line {
                            "PING" => {
                                replies.push_str("+PONG\r\n");
                                answered_ping = true;
                            }
                            "CLIENT" | "SELECT" => replies.push_str("+OK\r\n"),
                            _ => {}
                        }
                    }
                    if socket.write_all(replies.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    let mut config = dima_store::dragonfly::DragonflyConfig::from_env_values(
        Some("127.0.0.1"),
        Some(&port.to_string()),
        "platform-guard-tests",
    );
    config.response_timeout = Duration::from_millis(150);
    config.reconnect_retries = 0;
    Ok(
        dima_store::dragonfly::Dragonfly::connect(config, dima_store::dragonfly::Hooks::default())
            .await?,
    )
}

/// `forget` ends a cached validation at once: the next use asks Twitch.
#[tokio::test]
async fn forgetting_a_token_revalidates_it() -> Result<()> {
    let cases: Value = serde_json::from_str(include_str!("auth-cases.json"))?;
    with_stores(14, |stores| async move {
        let client_id = cases["client_id"].as_str().context("client_id")?;
        let server = MockServer::start().await?;
        script_twitch(&server, &cases, &stores.run);
        let app = app(authenticator(&stores, &server, client_id, None)?)?;
        // A token the cache vouches for, which Twitch now refuses.
        let token = token_of("cached_revoked", &stores.run);
        stores.track(token_cache_key(&token));
        let id = id_of("forget", &stores.run);
        stores.track(activity_touch_key(&id));
        let value = json!({"id": id, "login": "a", "display_name": "A", "profile_image_url": ""});
        stores
            .cache
            .set(
                &token_cache_key(&token),
                &serde_json::to_vec(&value)?,
                SetOptions::ex(60),
            )
            .await?;
        let header = format!("Bearer {token}");
        assert_eq!(send(&app, "/probe", Some(&header)).await?.0, 200);
        assert!(app.state().auth.cached_user(&header).await.is_some());
        stores.track(token_fence_key(&token));
        app.state().auth.forget(&header).await?;
        assert_eq!(send(&app, "/probe", Some(&header)).await?.0, 401);
        assert!(app.state().auth.cached_user(&header).await.is_none());
        Ok(())
    })
    .await
}

#[test]
fn keys_and_debug_never_show_the_token() -> Result<()> {
    let token = "secrettoken0123456789abcdefghij";
    assert!(!token_cache_key(token).contains(token));
    assert_eq!(token_cache_key(token).len(), "auth:token:".len() + 43);
    let config = AuthConfig::new("client")?;
    assert!(!format!("{config:?}").contains(token));
    Ok(())
}

/// The Twitch of the tests, whose `/users` answer is held until the test releases it.
#[derive(Debug)]
struct Held {
    inner: HttpTwitchUserApi,
    gate: Arc<tokio::sync::Semaphore>,
}

impl TwitchUserApi for Held {
    fn validate<'a>(
        &'a self,
        token: &'a dima_core::SecretString,
        scheme: Scheme,
        timeout: Duration,
    ) -> futures_util::future::BoxFuture<'a, Result<TwitchAnswer, Unreachable>> {
        self.inner.validate(token, scheme, timeout)
    }

    fn users<'a>(
        &'a self,
        token: &'a dima_core::SecretString,
        timeout: Duration,
    ) -> futures_util::future::BoxFuture<'a, Result<TwitchAnswer, Unreachable>> {
        Box::pin(async move {
            let answer = self.inner.users(token, timeout).await;
            let _permit = self.gate.acquire().await;
            answer
        })
    }
}

/// An authenticator on its own Dragonfly connection whose `/users` answers wait for `gate`.
async fn held_authenticator(
    stores: &Stores,
    server: &MockServer,
    client_id: &str,
    gate: Arc<tokio::sync::Semaphore>,
) -> Result<Authenticator> {
    let http = HttpClient::builder().build()?;
    let inner = HttpTwitchUserApi::new(
        http,
        server.provider(dima_twitch::oauth_provider())?,
        server.provider(dima_twitch::helix_provider(client_id))?,
    );
    let own = stores.second().await?;
    Ok(Authenticator::new(
        AuthConfig::new(client_id)?,
        AuthDeps {
            twitch: Arc::new(Held { inner, gate }),
            cache: own.cache,
            mongo: own.mongo,
            clock: Arc::new(SystemClock),
            report: Arc::new(NoReport),
        },
    ))
}

/// The review's sequence (A1): an authentication waits for Twitch; the token is forgotten on
/// another connection; Twitch answers. The authentication may answer its own request, but it
/// must not cache the token again.
#[tokio::test]
async fn forget_wins_over_an_authentication_in_flight() -> Result<()> {
    let cases: Value = serde_json::from_str(include_str!("auth-cases.json"))?;
    with_stores(14, |stores| async move {
        let client_id = cases["client_id"].as_str().context("client_id")?;
        let server = MockServer::start().await?;
        script_twitch(&server, &cases, &stores.run);
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let held = Arc::new(held_authenticator(&stores, &server, client_id, gate.clone()).await?);
        let signer_out = authenticator(&stores, &server, client_id, None)?;
        let token = token_of("valid", &stores.run);
        stores.track(token_cache_key(&token));
        stores.track(token_fence_key(&token));
        let header = format!("Bearer {token}");

        let in_flight = tokio::spawn({
            let held = held.clone();
            let header = header.clone();
            async move { held.authenticate(Some(&header)).await }
        });
        // Twitch has answered both calls; the `/users` answer is held.
        server.wait_for(2).await;
        signer_out.forget(&header).await?;
        assert_eq!(stores.cache.exists(&[&token_cache_key(&token)]).await?, 0);
        gate.add_permits(1);
        let user = in_flight
            .await?
            .map_err(|f| anyhow::anyhow!("{}", f.message()))?;
        assert_eq!(user.id, id_of("valid", &stores.run));
        assert_eq!(
            stores.cache.exists(&[&token_cache_key(&token)]).await?,
            0,
            "a forgotten token was cached again by an authentication in flight"
        );
        assert!(signer_out.cached_user(&header).await.is_none());
        // The next request asks Twitch again.
        let before = server.requests().len();
        gate.add_permits(1);
        held.authenticate(Some(&header))
            .await
            .map_err(|f| anyhow::anyhow!("{}", f.message()))?;
        assert_eq!(server.requests().len(), before + 2);
        Ok(())
    })
    .await
}

/// Forgetting a user ends the cached validations of all their tokens, and keeps one in flight
/// from being cached.
#[tokio::test]
async fn forgetting_a_user_ends_every_cached_token() -> Result<()> {
    let cases: Value = serde_json::from_str(include_str!("auth-cases.json"))?;
    with_stores(14, |stores| async move {
        let client_id = cases["client_id"].as_str().context("client_id")?;
        let server = MockServer::start().await?;
        script_twitch(&server, &cases, &stores.run);
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let held = Arc::new(held_authenticator(&stores, &server, client_id, gate.clone()).await?);
        let admin = authenticator(&stores, &server, client_id, None)?;
        let id = id_of("valid", &stores.run);
        stores.track(user_fence_key(&id));
        stores.track(activity_touch_key(&id));
        // Two tokens of the same user (`valid` and `valid_raw`), both cached.
        let first = format!("Bearer {}", token_of("valid", &stores.run));
        let second = format!("Bearer {}", token_of("valid_raw", &stores.run));
        let third = format!("Bearer {}", token_of("creator", &stores.run));
        for kind in ["valid", "valid_raw", "creator", "short_lived"] {
            stores.track(token_cache_key(&token_of(kind, &stores.run)));
        }
        for header in [&first, &second] {
            admin
                .authenticate(Some(header))
                .await
                .map_err(|f| anyhow::anyhow!("{}", f.message()))?;
            assert!(admin.cached_user(header).await.is_some());
        }
        // Another user's token, and a third token of this user in flight.
        admin
            .authenticate(Some(&third))
            .await
            .map_err(|f| anyhow::anyhow!("{}", f.message()))?;
        let fourth = format!("Bearer {}", token_of("short_lived", &stores.run));
        let before = server.requests().len();
        let in_flight = tokio::spawn({
            let held = held.clone();
            let fourth = fourth.clone();
            async move { held.authenticate(Some(&fourth)).await }
        });
        server.wait_for(before + 2).await;

        admin.forget_user(&id).await?;
        assert!(admin.cached_user(&first).await.is_none());
        assert!(admin.cached_user(&second).await.is_none());
        assert!(
            admin.cached_user(&third).await.is_some(),
            "another user's tokens stay cached"
        );
        gate.add_permits(1);
        in_flight
            .await?
            .map_err(|f| anyhow::anyhow!("{}", f.message()))?;
        assert!(admin.cached_user(&fourth).await.is_none());
        // A forgotten token is validated with Twitch again on its next use.
        let before = server.requests().len();
        admin
            .authenticate(Some(&first))
            .await
            .map_err(|f| anyhow::anyhow!("{}", f.message()))?;
        assert_eq!(server.requests().len(), before + 2);
        Ok(())
    })
    .await
}

/// A forget that cannot reach Dragonfly says so; it is never reported as done.
#[tokio::test]
async fn a_forget_that_fails_is_returned() -> Result<()> {
    with_stores(14, |stores| async move {
        let mut config = AuthConfig::new("client")?;
        config.store_deadline = Duration::from_millis(200);
        let server = MockServer::start().await?;
        let http = HttpClient::builder().build()?;
        let auth = Authenticator::new(
            config,
            AuthDeps {
                twitch: Arc::new(HttpTwitchUserApi::new(
                    http,
                    server.provider(dima_twitch::oauth_provider())?,
                    server.provider(dima_twitch::helix_provider("client"))?,
                )),
                cache: silent_dragonfly().await?,
                mongo: stores.mongo.clone(),
                clock: Arc::new(SystemClock),
                report: Arc::new(NoReport),
            },
        );
        assert!(auth.forget("Bearer sometoken0123").await.is_err());
        assert!(auth.forget_user("123").await.is_err());
        Ok(())
    })
    .await
}

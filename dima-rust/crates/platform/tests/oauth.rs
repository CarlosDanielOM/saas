//! The OAuth decision table, the races, and cross-compatibility of stored sessions.
//!
//! - `decision_table_matches_the_reference`: the step script of `oauth-cases.json`, recorded
//!   from the TypeScript (`record-oauth.mts`, `oauth-reference.json`), runs against the Rust
//!   service with the same seeded users and clients; every step must give the same outcome.
//!   Intended differences are stated in [`intended`] with their reason and counted.
//! - Races between two services on separate connections (two processes): one code exchanged
//!   twice gives one session; one refresh token rotated twice gives one token response, an
//!   `invalid_grant`, and a revoked session (reuse detection); a revocation during a refresh wins.
//! - A session issued by the TypeScript works with Rust (its documents as Mongoose stored them),
//!   and one issued by Rust works with the TypeScript (`oauth-rust-issued.json`, used by the
//!   recorder; `DIMA_UPDATE_FIXTURES=1` writes it again).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod guard_support;

use anyhow::{Context, Result};
use bson::oid::ObjectId;
use bson::{Bson, Document, doc};
use dima_core::crypto::keys::sha256_base64url;
use dima_core::{Random, SystemClock, SystemRandom};
use dima_http::testing::{MockResponse, MockServer};
use dima_model::oauth_clients::{ClientType, NewOAuthClient};
use dima_model::users::{AccountType, NewAccount, NewUser};
use dima_model::{IndexPolicy, ensure_indexes};
use dima_platform::auth::twitch::HttpTwitchUserApi;
use dima_platform::oauth::catalog::{DESKTOP_REDIRECT_URIS, active_scopes};
use dima_platform::oauth::{
    AccessIdentity, HookPoint, Input, OAuthConfig, OAuthDeps, OAuthError, OAuthService, RATE_LIMIT,
    TokenResponse,
};
use dima_store::dragonfly::{SetOptions, Ttl};
use dima_store::mongo::WriteContext;
use futures_util::TryStreamExt;
use guard_support::{Stores, id_of, with_stores};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

const R: &str = "http://127.0.0.1:53682/oauth/callback";
const DB: u8 = 15;

fn now_ms() -> i64 {
    dima_core::Clock::now_ms(&SystemClock)
}

fn service(stores: &Stores, twitch: Option<&MockServer>) -> Result<OAuthService> {
    let (oauth, helix) = match twitch {
        Some(server) => (
            server.provider(dima_twitch::oauth_provider())?,
            server.provider(dima_twitch::helix_provider("fixture-client"))?,
        ),
        None => {
            let unreachable = |builder: dima_http::ProviderBuilder| -> Result<dima_http::Provider> {
                let name = builder.name();
                Ok(dima_http::ProviderRegistry::builder()
                    .test_mode(dima_http::TestMode::RigMock {
                        loopback_only: true,
                    })
                    .provider(builder)
                    .base_url_override(name, "http://127.0.0.1:9")
                    .build()?
                    .get(name)?
                    .clone())
            };
            (
                unreachable(dima_twitch::oauth_provider())?,
                unreachable(dima_twitch::helix_provider("fixture-client"))?,
            )
        }
    };
    let mut config = OAuthConfig::new(None, None, "fixture-client")?;
    config.store_deadline = Duration::from_secs(20);
    Ok(OAuthService::new(
        config,
        OAuthDeps {
            mongo: stores.mongo.clone(),
            cache: stores.cache.clone(),
            clock: Arc::new(SystemClock),
            random: Arc::new(SystemRandom),
            twitch: Arc::new(HttpTwitchUserApi::new(
                dima_http::HttpClient::builder().build()?,
                oauth,
                helix,
            )),
        },
    ))
}

/// Users, clients and the indexes the reference's `init()` creates.
async fn seed(stores: &Stores, cases: &Value) -> Result<HashMap<String, String>> {
    for info in [
        &dima_model::oauth_clients::INFO,
        &dima_model::oauth_grants::INFO,
        &dima_model::oauth_sessions::INFO,
        &dima_model::oauth_refresh_tokens::INFO,
    ] {
        let report = ensure_indexes(
            &stores.mongo,
            info,
            IndexPolicy::RequireAll,
            Duration::from_secs(30),
        )
        .await;
        report.require().map_err(|e| anyhow::anyhow!("{e}"))?;
    }
    let mut users = HashMap::new();
    for kind in cases["site_users"].as_array().context("site_users")? {
        let kind = kind.as_str().context("kind")?;
        let mut account = NewAccount::new(AccountType::Twitch, id_of(kind, &stores.run));
        account.name = Some(format!("login_{kind}"));
        let user = NewUser {
            name: Some(format!("site_{kind}")),
            accounts: vec![account],
            ..NewUser::default()
        };
        let prepared = user.prepare(&mut WriteContext::new(now_ms()))?;
        users.insert(
            kind.to_owned(),
            prepared.document.get_object_id("_id")?.to_hex(),
        );
        stores
            .mongo
            .writes(dima_model::users::COLLECTION)
            .insert_one(&prepared)
            .await?;
    }
    for client in cases["clients"].as_array().context("clients")? {
        let scopes: Vec<String> = match &client["allowed_scopes"] {
            Value::String(s) if s == "$active" => {
                active_scopes().iter().map(|s| (*s).to_owned()).collect()
            }
            other => serde_json::from_value(other.clone())?,
        };
        let id = client["client_id"].as_str().context("client_id")?;
        let new = NewOAuthClient {
            client_id: id.to_owned(),
            name: id.to_owned(),
            kind: ClientType::Public,
            redirect_uris: DESKTOP_REDIRECT_URIS
                .iter()
                .map(|s| (*s).to_owned())
                .collect(),
            allowed_scopes: scopes,
            enabled: client["enabled"].as_bool(),
        };
        let prepared = new.prepare(&mut WriteContext::new(now_ms()))?;
        stores
            .mongo
            .writes(dima_model::oauth_clients::COLLECTION)
            .insert_one(&prepared)
            .await?;
    }
    Ok(users)
}

/// Saved values in insertion order; saving a name again keeps its place (JavaScript objects).
#[derive(Default)]
struct SavedValues(Vec<(String, Saved)>);

impl SavedValues {
    fn get(&self, name: &str) -> Option<&Saved> {
        self.0.iter().find(|(k, _)| k == name).map(|(_, v)| v)
    }

    fn insert(&mut self, name: String, value: Saved) {
        match self.0.iter_mut().find(|(k, _)| *k == name) {
            Some(slot) => slot.1 = value,
            None => self.0.push((name, value)),
        }
    }
}

#[derive(Clone, Debug)]
enum Saved {
    Text(String),
    Tokens {
        access: String,
        refresh: String,
        session: String,
    },
}

/// The step interpreter of `record-oauth.mts`, on the Rust service.
struct Script<'a> {
    service: &'a OAuthService,
    stores: &'a Stores,
    users: HashMap<String, String>,
    site_users: Vec<String>,
    generated: Vec<(String, String)>,
    /// In insertion order, as a JavaScript object keeps its keys.
    saved: SavedValues,
}

fn b64(n: usize) -> String {
    SystemRandom.base64url_token(n).unwrap()
}

impl Script<'_> {
    fn generate(&mut self, kind: &str, n: &str) -> String {
        let key = format!("{kind}{n}");
        if let Some((_, value)) = self.generated.iter().find(|(k, _)| *k == key) {
            return value.clone();
        }
        let value = match kind {
            "verifier" => b64(48),
            "state" => b64(32),
            _ => sha256_base64url(&self.generate("verifier", n)),
        };
        self.generated.push((key, value.clone()));
        value
    }

    fn track(&self, kind: &str, secret: &str) {
        self.stores
            .track(format!("oauth:{kind}:{}", sha256_base64url(secret)));
    }

    fn resolve(&mut self, value: &Value) -> Value {
        match value {
            Value::Array(items) => Value::Array(items.iter().map(|v| self.resolve(v)).collect()),
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(k, v)| (k.clone(), self.resolve(v)))
                    .collect(),
            ),
            Value::String(text) => self.resolve_text(text),
            other => other.clone(),
        }
    }

    fn resolve_text(&mut self, text: &str) -> Value {
        let generated = ["challenge", "verifier", "state"];
        if text == "$R" {
            return json!(R);
        }
        if text == "$active" {
            return json!(active_scopes());
        }
        if text == "$long_redirect" {
            return json!(format!("{R}#{}", "a".repeat(301 - R.len() - 1)));
        }
        if text == "$long_scope" {
            return json!("profile:read ".repeat(40).trim_end());
        }
        for kind in generated {
            if let Some(n) = text.strip_prefix('$').and_then(|t| t.strip_prefix(kind))
                && !n.is_empty()
                && n.bytes().all(|b| b.is_ascii_digit())
            {
                return json!(self.generate(kind, n));
            }
        }
        if let Some(rest) = text.strip_prefix("$repeat:") {
            let (n, c) = rest.split_once(':').unwrap();
            return json!(c.repeat(n.parse().unwrap()));
        }
        if let Some(n) = text.strip_prefix("$emoji:") {
            return json!("😀".repeat(n.parse().unwrap()));
        }
        if let Some(path) = text.strip_prefix("$v.") {
            let (name, field) = match path.split_once('.') {
                Some((name, field)) => (name, Some(field)),
                None => (path, None),
            };
            return match (self.saved.get(name), field) {
                (Some(Saved::Text(value)), None) => json!(value),
                (Some(Saved::Tokens { access, .. }), Some("access")) => json!(access),
                (Some(Saved::Tokens { refresh, .. }), Some("refresh")) => json!(refresh),
                (Some(Saved::Tokens { session, .. }), Some("session")) => json!(session),
                _ => Value::Null,
            };
        }
        if text.contains("$random43") {
            return json!(text.replace("$random43", &b64(32)));
        }
        json!(text)
    }

    fn name_of(&self, value: &str) -> String {
        self.generated
            .iter()
            .find(|(_, v)| v == value)
            .map_or("?".to_owned(), |(k, _)| k.clone())
    }

    fn session_name(&self, id: &str) -> String {
        self.saved
            .0
            .iter()
            .find(|(_, saved)| matches!(saved, Saved::Tokens { session, .. } if session == id))
            .map_or("?".to_owned(), |(k, _)| k.clone())
    }

    fn user_name(&self, id: &str) -> String {
        self.users
            .iter()
            .find(|(_, v)| *v == id)
            .map_or("?".to_owned(), |(k, _)| k.clone())
    }

    fn channel_name(&self, id: &str) -> String {
        self.site_users
            .iter()
            .map(String::as_str)
            .chain(["stranger"])
            .find(|kind| id_of(kind, &self.stores.run) == id)
            .map_or("?".to_owned(), str::to_owned)
    }

    fn tokens(&self, response: &TokenResponse) -> Value {
        let body = response.body();
        let pattern = |value: &str, prefix: &str, star: &str| {
            let ok = value.strip_prefix(prefix).is_some_and(|rest| {
                rest.len() == 43
                    && rest
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            });
            if ok {
                star.to_owned()
            } else {
                value.to_owned()
            }
        };
        let session = response.session_id();
        json!({
            "keys": body.as_object().unwrap().keys().collect::<Vec<_>>(),
            "access_token": pattern(response.access_token().expose(), "dima_at_", "dima_at_*"),
            "token_type": body["token_type"],
            "expires_in": body["expires_in"],
            "refresh_token": pattern(response.refresh_token().expose(), "dima_rt_", "dima_rt_*"),
            "scope": body["scope"],
            "session_id": if session.len() == 24 && session.bytes().all(|b| b.is_ascii_hexdigit()) { "<session>".to_owned() } else { session.to_owned() },
            "refresh_expires_in_hours": (response.refresh_expires_in() as f64 / 3600.0).round() as i64,
        })
    }

    fn save_tokens(&mut self, name: Option<&str>, response: &TokenResponse) {
        self.track("access", response.access_token().expose());
        if let Some(name) = name {
            self.saved.insert(
                name.to_owned(),
                Saved::Tokens {
                    access: response.access_token().expose().to_owned(),
                    refresh: response.refresh_token().expose().to_owned(),
                    session: response.session_id().to_owned(),
                },
            );
        }
    }

    fn standard_input(&mut self, step: &Value) -> Input {
        let mut input = Map::new();
        input.insert("response_type".into(), json!("code"));
        input.insert("code_challenge_method".into(), json!("S256"));
        input.insert(
            "code_challenge".into(),
            json!(self.generate("challenge", "1")),
        );
        input.insert("state".into(), json!(self.generate("state", "1")));
        input.insert(
            "client_id".into(),
            json!(step["client"].as_str().unwrap_or("dima-desktop")),
        );
        let redirect = match step.get("redirect") {
            Some(value) => self.resolve(value),
            None => json!(R),
        };
        input.insert("redirect_uri".into(), redirect);
        let scope = match step.get("scope") {
            Some(value) => self.resolve(value),
            None => json!("profile:read desktop:connect"),
        };
        input.insert("scope".into(), scope);
        if let Some(device) = step.get("device") {
            let device = self.resolve(device);
            input.insert("device_name".into(), device);
        }
        input
    }

    async fn approve(
        &mut self,
        id: &str,
        user: &str,
        approve: bool,
        save: Option<&str>,
    ) -> Result<Value, OAuthError> {
        let url = self
            .service
            .approve_authorization(id, &id_of(user, &self.stores.run), approve)
            .await?;
        let code = url::Url::parse(&url)
            .unwrap()
            .query_pairs()
            .find(|(k, _)| k == "code")
            .map(|(_, v)| v.into_owned());
        let mut text = url.clone();
        for (name, value) in &self.generated {
            text = text.replace(value.as_str(), &format!("${name}"));
        }
        if let Some(code) = code {
            self.track("code", &code);
            if let Some(save) = save {
                self.saved
                    .insert(save.to_owned(), Saved::Text(code.clone()));
            }
            text = text.replacen(&code, "<code>", 1);
        }
        Ok(json!({ "url": text }))
    }

    async fn issue(&mut self, step: &Value) -> Result<Value, OAuthError> {
        let mut input = self.standard_input(step);
        input.insert("device_name".into(), json!("Issued"));
        let id = self.service.start_authorization(&input).await?;
        self.track("request", &id);
        let user = step["user"].as_str().unwrap().to_owned();
        self.approve(&id, &user, true, Some("__code")).await?;
        let Some(Saved::Text(code)) = self.saved.get("__code").cloned() else {
            panic!("no code")
        };
        let mut exchange = Map::new();
        exchange.insert(
            "client_id".into(),
            json!(step["client"].as_str().unwrap_or("dima-desktop")),
        );
        exchange.insert("code".into(), json!(code));
        exchange.insert(
            "code_verifier".into(),
            json!(self.generate("verifier", "1")),
        );
        exchange.insert("redirect_uri".into(), json!(R));
        let response = self.service.exchange_code(&exchange).await?;
        self.save_tokens(step["save"].as_str(), &response);
        Ok(self.tokens(&response))
    }

    fn collection(&self, name: &str) -> mongodb::Collection<Document> {
        self.stores.mongo.documents(name)
    }

    async fn session_view(&self, id: &str) -> Result<Value> {
        let oid = ObjectId::parse_str(id)?;
        let Some(s) = self
            .collection("oauth_sessions")
            .find_one(doc! { "_id": oid })
            .await?
        else {
            return Ok(json!({ "exists": false }));
        };
        let ms = |field: &str| {
            s.get_datetime(field)
                .map(|d| d.timestamp_millis())
                .unwrap_or_default()
        };
        let day = 86_400_000.0;
        let round = |x: f64| (x / day).round() as i64;
        let refresh = self.collection("oauth_refresh_tokens");
        Ok(json!({
            "exists": true,
            "revoked": !matches!(s.get("revoked_at"), None | Some(Bson::Null)),
            "reason": s.get_str("revoke_reason").ok(),
            "client_id": s.get_str("client_id")?,
            "channel": self.channel_name(s.get_str("channel_id")?),
            "user": self.user_name(&s.get_object_id("user_id")?.to_hex()),
            "device_name": s.get_str("device_name")?,
            "scopes": s.get_array("scopes")?.iter().filter_map(Bson::as_str).collect::<Vec<_>>(),
            "idle_days": round((ms("idle_expires_at") - ms("last_used_at")) as f64),
            "absolute_days": round((ms("expires_at") - ms("createdAt")) as f64),
            "has_hash": s.get_str("current_refresh_hash").is_ok_and(|h| h.len() == 43),
            "refresh_tokens": refresh.count_documents(doc! { "session_id": oid }).await?,
            "used_tokens": refresh.count_documents(doc! { "session_id": oid, "used_at": { "$ne": Bson::Null } }).await?,
        }))
    }

    async fn step(&mut self, s: &Value) -> Result<Result<Value, OAuthError>> {
        let op = s["op"].as_str().context("op")?;
        let service = self.service;
        let input = |script: &mut Self| -> Input {
            script
                .resolve(&s["input"])
                .as_object()
                .cloned()
                .unwrap_or_default()
        };
        let text = |script: &mut Self, key: &str| -> String {
            script
                .resolve(&s[key])
                .as_str()
                .unwrap_or_default()
                .to_owned()
        };
        Ok(match op {
            "initialize" => service.initialize().await.map(|()| json!({})),
            "inspect_client" => {
                let c = self
                    .collection("oauth_clients")
                    .find_one(doc! { "client_id": s["client"].as_str() })
                    .await?
                    .context("client")?;
                let strings = |field: &str| {
                    c.get_array(field)
                        .map(|a| {
                            a.iter()
                                .filter_map(Bson::as_str)
                                .map(str::to_owned)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default()
                };
                Ok(json!({
                    "name": c.get_str("name")?, "type": c.get_str("type")?, "enabled": c.get_bool("enabled")?,
                    "redirect_uris": strings("redirect_uris"), "allowed_scopes": strings("allowed_scopes"),
                    "timestamps": c.contains_key("createdAt") && c.contains_key("updatedAt"),
                    "version": c.get_i32("__v")?,
                }))
            }
            "set_client" => {
                let set = Bson::try_from(self.resolve(&s["set"]))?;
                self.collection("oauth_clients")
                    .update_one(
                        doc! { "client_id": s["client"].as_str() },
                        doc! { "$set": set },
                    )
                    .await?;
                Ok(json!({}))
            }
            "start" => {
                let input = if s.get("input").is_some() {
                    input(self)
                } else {
                    self.standard_input(s)
                };
                match service.start_authorization(&input).await {
                    Ok(id) => {
                        self.track("request", &id);
                        if let Some(save) = s["save"].as_str() {
                            self.saved.insert(save.to_owned(), Saved::Text(id.clone()));
                        }
                        let shaped = id.len() == 43;
                        Ok(json!({ "id": if shaped { "<id>".to_owned() } else { id } }))
                    }
                    Err(e) => Err(e),
                }
            }
            "get" => {
                let id = text(self, "id");
                service.get_authorization(&id).await.map(|r| {
                    json!({ "client_id": r.client_id, "redirect_uri": r.redirect_uri, "scopes": r.scopes,
                            "state": self.name_of(&r.state), "code_challenge": self.name_of(&r.code_challenge),
                            "device_name": r.device_name })
                })
            }
            "approve" => {
                let id = text(self, "id");
                self.approve(
                    &id,
                    s["user"].as_str().unwrap(),
                    s["approve"].as_bool().unwrap(),
                    s["save"].as_str(),
                )
                .await
            }
            "start_approve" => {
                let input = self.standard_input(s);
                match service.start_authorization(&input).await {
                    Ok(id) => {
                        self.track("request", &id);
                        self.approve(&id, s["user"].as_str().unwrap(), true, s["save"].as_str())
                            .await
                    }
                    Err(e) => Err(e),
                }
            }
            "exchange" | "refresh" => {
                let input = input(self);
                let result = if op == "exchange" {
                    service.exchange_code(&input).await
                } else {
                    service.refresh_access(&input).await
                };
                result.map(|response| {
                    self.save_tokens(s["save"].as_str(), &response);
                    self.tokens(&response)
                })
            }
            "issue" => self.issue(s).await,
            "authenticate" => {
                let token = s
                    .get("token")
                    .map(|t| self.resolve(t).as_str().unwrap_or_default().to_owned());
                service.authenticate_access(token.as_deref()).await.map(|identity: AccessIdentity| {
                    json!({ "keys": ["session_id", "user_id", "client_id", "channel_id", "scopes"],
                            "session_id": self.session_name(&identity.session_id), "user_id": self.user_name(&identity.user_id),
                            "client_id": identity.client_id, "channel_id": self.channel_name(&identity.channel_id),
                            "scopes": identity.scopes })
                })
            }
            "revoke_token" => service.revoke_token(&input(self)).await.map(|()| json!({})),
            "revoke_session" => {
                let id = ObjectId::parse_str(text(self, "session"))?;
                service
                    .revoke_session(&id, "user_revoked")
                    .await
                    .map(|()| json!({}))
            }
            "revoke_user" => {
                let id = match s["raw"].as_str() {
                    Some(raw) => raw.to_owned(),
                    None => self.users[s["user"].as_str().unwrap()].clone(),
                };
                service.revoke_user_oauth(&id).await.map(|()| json!({}))
            }
            "inspect_session" => {
                let session = text(self, "session");
                Ok(self.session_view(&session).await?)
            }
            "inspect_grant" => {
                let user = ObjectId::parse_str(&self.users[s["user"].as_str().unwrap()])?;
                let grants: Vec<Document> = self
                    .collection("oauth_grants")
                    .find(doc! { "user_id": user, "client_id": s["client"].as_str() })
                    .await?
                    .try_collect()
                    .await?;
                let first = grants.first();
                Ok(json!({
                    "count": grants.len(),
                    "scopes": first.map(|g| g.get_array("scopes").map(|a| a.iter().filter_map(Bson::as_str).map(str::to_owned).collect::<Vec<_>>()).unwrap_or_default()),
                    "revoked": first.map(|g| !matches!(g.get("revoked_at"), None | Some(Bson::Null))),
                }))
            }
            "inspect_user_oauth" => {
                let user = ObjectId::parse_str(&self.users[s["user"].as_str().unwrap()])?;
                let session = ObjectId::parse_str(text(self, "session"))?;
                Ok(json!({
                    "grants": self.collection("oauth_grants").count_documents(doc! { "user_id": user }).await?,
                    "sessions": self.collection("oauth_sessions").count_documents(doc! { "user_id": user }).await?,
                    "refresh_tokens": self.collection("oauth_refresh_tokens").count_documents(doc! { "session_id": session }).await?,
                }))
            }
            "set_account" => {
                let kind = s["user"].as_str().unwrap();
                let id = id_of(kind, &self.stores.run);
                let value = if s["present"].as_bool() == Some(true) {
                    id
                } else {
                    format!("gone_{id}")
                };
                let user = ObjectId::parse_str(&self.users[kind])?;
                self.collection("users")
                    .update_one(
                        doc! { "_id": user },
                        doc! { "$set": { "accounts.0.id": value } },
                    )
                    .await?;
                Ok(json!({}))
            }
            "revoke_grant" => {
                let id = ObjectId::parse_str(text(self, "session"))?;
                let session = self
                    .collection("oauth_sessions")
                    .find_one(doc! { "_id": id })
                    .await?
                    .context("session")?;
                self.collection("oauth_grants")
                    .update_one(
                        doc! { "_id": session.get_object_id("grant_id")? },
                        doc! { "$set": { "revoked_at": bson::DateTime::now() } },
                    )
                    .await?;
                Ok(json!({}))
            }
            "set_session" => {
                let id = ObjectId::parse_str(text(self, "session"))?;
                let mut set = Document::new();
                if let Some(field) = s["past"].as_str() {
                    set.insert(field, bson::DateTime::from_millis(now_ms() - 60_000));
                }
                if let Some(scopes) = s["scopes"].as_array() {
                    set.insert(
                        "scopes",
                        scopes.iter().filter_map(Value::as_str).collect::<Vec<_>>(),
                    );
                }
                self.collection("oauth_sessions")
                    .update_one(doc! { "_id": id }, doc! { "$set": set })
                    .await?;
                Ok(json!({}))
            }
            "expire_refresh" => {
                let hash = sha256_base64url(&text(self, "token"));
                self.collection("oauth_refresh_tokens")
                    .update_one(doc! { "token_hash": hash }, doc! { "$set": { "expires_at": bson::DateTime::from_millis(now_ms() - 60_000) } })
                    .await?;
                Ok(json!({}))
            }
            "delete_key" | "key_exists" => {
                let key = format!(
                    "oauth:{}:{}",
                    s["kind"].as_str().unwrap(),
                    sha256_base64url(&text(self, "value"))
                );
                if op == "delete_key" {
                    self.stores.cache.del(&[&key]).await?;
                    Ok(json!({}))
                } else {
                    Ok(json!({ "exists": self.stores.cache.exists(&[&key]).await? == 1 }))
                }
            }
            "rate" => {
                let bucket = format!("test:{}", self.stores.run);
                self.stores
                    .track(format!("oauth:rate:{}", sha256_base64url(&bucket)));
                service
                    .rate_limit(&bucket, s["limit"].as_u64().unwrap())
                    .await
                    .map(|()| json!({}))
            }
            "rate_ttl" => {
                let key = format!(
                    "oauth:rate:{}",
                    sha256_base64url(&format!("test:{}", self.stores.run))
                );
                let ttl = match self.stores.cache.ttl(&key).await? {
                    Ttl::Seconds(s) => s,
                    _ => -1,
                };
                Ok(json!({ "window": ttl > 50 && ttl <= 60 }))
            }
            other => anyhow::bail!("unknown op {other}"),
        })
    }
}

/// The steps whose outcome differs from the reference on purpose, with the reason.
fn intended(name: &str, reference: &Value, rust: &Value) -> Option<&'static str> {
    match name {
        "device_41_emoji" => {
            // 41 emoji are 82 UTF-16 units but 41 characters: a user-text limit counts
            // characters (MIGRATION.md section 4).
            assert_eq!(
                reference,
                &json!({"error": "invalid_request", "status": 400})
            );
            assert_eq!(rust, &json!({"ok": {"id": "<id>"}}));
            Some("device_name counts characters, not UTF-16 units")
        }
        _ => None,
    }
}

fn outcome(result: Result<Value, OAuthError>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(error) => json!({ "error": error.code(), "status": error.status() }),
    }
}

#[tokio::test]
async fn decision_table_matches_the_reference() -> Result<()> {
    let cases: Value = serde_json::from_str(include_str!("oauth-cases.json"))?;
    let reference: Value = serde_json::from_str(include_str!("oauth-reference.json"))?;
    guard_support::check_drift(&reference)?;
    with_stores(DB, |stores| async move {
        let users = seed(&stores, &cases).await?;
        let service = service(&stores, None)?;
        let mut script = Script {
            service: &service,
            stores: &stores,
            users,
            site_users: serde_json::from_value(cases["site_users"].clone())?,
            generated: Vec::new(),
            saved: SavedValues::default(),
        };
        let steps = cases["steps"].as_array().context("steps")?;
        let rows = reference["rows"].as_array().context("rows")?;
        assert_eq!(steps.len(), rows.len());
        let mut changed = Vec::new();
        for (step, expected) in steps.iter().zip(rows) {
            let name = step["name"].as_str().context("name")?;
            assert_eq!(expected["name"], step["name"]);
            let rust = outcome(script.step(step).await?);
            let mut reference = expected["outcome"].clone();
            if let Some(map) = reference.as_object_mut() {
                assert!(
                    map.remove("unexpected").is_none(),
                    "{name}: the reference failed unexpectedly"
                );
            }
            if let Some(reason) = intended(name, &reference, &rust) {
                changed.push((name, reason));
                continue;
            }
            assert_eq!(rust, reference, "{name}");
        }
        assert_eq!(changed.len(), 1, "steps changed on purpose: {changed:?}");
        Ok(())
    })
    .await
}

/// The rate-limit script is the reference's text, byte for byte.
#[test]
fn rate_limit_script_is_verbatim() -> Result<()> {
    let path = format!(
        "{}/../../../dimabot/src/server/oauth/service.ts",
        env!("CARGO_MANIFEST_DIR")
    );
    let source = std::fs::read_to_string(path)?;
    assert!(source.contains(&format!("\"{}\"", RATE_LIMIT.source())));
    RATE_LIMIT.check()?;
    Ok(())
}

async fn issue_one(
    service: &OAuthService,
    stores: &Stores,
    user: &str,
) -> Result<(String, TokenResponse)> {
    let (verifier, input) = authorize_input();
    let id = service.start_authorization(&input).await?;
    stores.track(format!("oauth:request:{}", sha256_base64url(&id)));
    let code = approve_code(service, stores, &id, user).await?;
    let response = service
        .exchange_code(&exchange_input(&code, &verifier))
        .await?;
    stores.track(format!(
        "oauth:access:{}",
        sha256_base64url(response.access_token().expose())
    ));
    Ok((code, response))
}

fn authorize_input() -> (String, Input) {
    let verifier = b64(48);
    let mut input = Map::new();
    for (k, v) in [
        ("response_type", json!("code")),
        ("code_challenge_method", json!("S256")),
        ("code_challenge", json!(sha256_base64url(&verifier))),
        ("state", json!(b64(32))),
        ("client_id", json!("dima-desktop")),
        ("redirect_uri", json!(R)),
        ("scope", json!("profile:read desktop:connect")),
    ] {
        input.insert(k.to_owned(), v);
    }
    (verifier, input)
}

async fn approve_code(
    service: &OAuthService,
    stores: &Stores,
    id: &str,
    user: &str,
) -> Result<String> {
    let url = service
        .approve_authorization(id, &id_of(user, &stores.run), true)
        .await?;
    let code = url::Url::parse(&url)?
        .query_pairs()
        .find(|(k, _)| k == "code")
        .context("code")?
        .1
        .into_owned();
    stores.track(format!("oauth:code:{}", sha256_base64url(&code)));
    Ok(code)
}

fn exchange_input(code: &str, verifier: &str) -> Input {
    let mut input = Map::new();
    input.insert("client_id".into(), json!("dima-desktop"));
    input.insert("code".into(), json!(code));
    input.insert("code_verifier".into(), json!(verifier));
    input.insert("redirect_uri".into(), json!(R));
    input
}

fn refresh_input(token: &str) -> Input {
    let mut input = Map::new();
    input.insert("client_id".into(), json!("dima-desktop"));
    input.insert("refresh_token".into(), json!(token));
    input
}

/// A barrier for two flows: each waits at the hook until both have arrived.
fn barrier_hook(point: HookPoint, count: usize) -> dima_platform::oauth::Hook {
    let barrier = Arc::new(tokio::sync::Barrier::new(count));
    Arc::new(move |at| {
        let barrier = barrier.clone();
        Box::pin(async move {
            if at == point {
                barrier.wait().await;
            }
        })
    })
}

/// One code exchanged by two processes at the same moment, both past every check: one session.
#[tokio::test]
async fn a_code_exchanged_twice_at_once_gives_one_session() -> Result<()> {
    let cases: Value = serde_json::from_str(include_str!("oauth-cases.json"))?;
    with_stores(DB, |stores| async move {
        seed(&stores, &cases).await?;
        // Both pass their checks before either consumes the code.
        let shared = barrier_hook(HookPoint::BeforeCodeConsumed, 2);
        let first = service(&stores, None)?.with_hook(shared.clone());
        first.initialize().await?;
        let second_stores = stores.second().await?;
        let second = service(&second_stores, None)?.with_hook(shared);
        let (verifier, input) = authorize_input();
        let id = first.start_authorization(&input).await?;
        stores.track(format!("oauth:request:{}", sha256_base64url(&id)));
        let code = approve_code(&first, &stores, &id, "valid").await?;
        let exchange = exchange_input(&code, &verifier);
        let (a, b) = tokio::join!(
            first.exchange_code(&exchange),
            second.exchange_code(&exchange)
        );
        for response in [&a, &b].into_iter().flatten() {
            stores.track(format!(
                "oauth:access:{}",
                sha256_base64url(response.access_token().expose())
            ));
        }
        let outcomes = [a.is_ok(), b.is_ok()];
        assert_eq!(
            outcomes.iter().filter(|ok| **ok).count(),
            1,
            "exactly one exchange wins"
        );
        assert!([a.err(), b.err()].contains(&Some(OAuthError::INVALID_GRANT)));
        assert_eq!(
            stores
                .mongo
                .documents("oauth_sessions")
                .count_documents(doc! {})
                .await?,
            1
        );
        assert_eq!(
            stores
                .mongo
                .documents("oauth_grants")
                .count_documents(doc! {})
                .await?,
            1
        );
        Ok(())
    })
    .await
}

/// One refresh token rotated by two processes at the same moment, both past every check: one
/// token response, `invalid_grant` for the other, and the session revoked (`refresh_reuse`), as
/// in the reference.
#[tokio::test]
async fn a_refresh_token_rotated_twice_at_once() -> Result<()> {
    let cases: Value = serde_json::from_str(include_str!("oauth-cases.json"))?;
    with_stores(DB, |stores| async move {
        seed(&stores, &cases).await?;
        let plain = service(&stores, None)?;
        plain.initialize().await?;
        let (_, issued) = issue_one(&plain, &stores, "valid").await?;
        let shared = barrier_hook(HookPoint::BeforeRotation, 2);
        let first = service(&stores, None)?.with_hook(shared.clone());
        let second_stores = stores.second().await?;
        let second = service(&second_stores, None)?.with_hook(shared);
        let input = refresh_input(issued.refresh_token().expose());
        let (a, b) = tokio::join!(first.refresh_access(&input), second.refresh_access(&input));
        for response in [&a, &b].into_iter().flatten() {
            stores.track(format!(
                "oauth:access:{}",
                sha256_base64url(response.access_token().expose())
            ));
        }
        assert_eq!(
            [a.is_ok(), b.is_ok()].iter().filter(|ok| **ok).count(),
            1,
            "one token response"
        );
        assert!([a.as_ref().err(), b.as_ref().err()].contains(&Some(&OAuthError::INVALID_GRANT)));
        let session = stores
            .mongo
            .documents("oauth_sessions")
            .find_one(doc! { "_id": ObjectId::parse_str(issued.session_id())? })
            .await?
            .context("session")?;
        assert_eq!(session.get_str("revoke_reason").ok(), Some("refresh_reuse"));
        // The winner's tokens died with the session.
        let winner = a.ok().or(b.ok()).context("winner")?;
        assert_eq!(
            plain
                .authenticate_access(Some(winner.access_token().expose()))
                .await
                .err(),
            Some(OAuthError::INVALID_TOKEN)
        );
        assert_eq!(
            plain
                .refresh_access(&refresh_input(winner.refresh_token().expose()))
                .await
                .err(),
            Some(OAuthError::INVALID_GRANT)
        );
        Ok(())
    })
    .await
}

/// A revocation that lands while a refresh is between its checks and its rotation wins.
#[tokio::test]
async fn a_revocation_during_a_refresh_wins() -> Result<()> {
    let cases: Value = serde_json::from_str(include_str!("oauth-cases.json"))?;
    with_stores(DB, |stores| async move {
        seed(&stores, &cases).await?;
        let plain = service(&stores, None)?;
        plain.initialize().await?;
        let (_, issued) = issue_one(&plain, &stores, "valid").await?;
        let reached = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let hook: dima_platform::oauth::Hook = {
            let (reached, release) = (reached.clone(), release.clone());
            Arc::new(move |at| {
                let (reached, release) = (reached.clone(), release.clone());
                Box::pin(async move {
                    if at == HookPoint::BeforeRotation {
                        reached.notify_one();
                        release.notified().await;
                    }
                })
            })
        };
        let paused = service(&stores, None)?.with_hook(hook);
        let input = refresh_input(issued.refresh_token().expose());
        let refresh = paused.refresh_access(&input);
        let revoke = async {
            reached.notified().await;
            plain
                .revoke_session(
                    &ObjectId::parse_str(issued.session_id()).unwrap(),
                    "user_revoked",
                )
                .await
                .unwrap();
            release.notify_one();
        };
        let (result, ()) = tokio::join!(refresh, revoke);
        assert_eq!(result.err(), Some(OAuthError::INVALID_GRANT));
        let session = stores
            .mongo
            .documents("oauth_sessions")
            .find_one(doc! { "_id": ObjectId::parse_str(issued.session_id())? })
            .await?
            .context("session")?;
        assert_eq!(
            session.get_str("revoke_reason").ok(),
            Some("user_revoked"),
            "the revocation is not overwritten"
        );
        Ok(())
    })
    .await
}

fn shift_dates(value: &mut Bson, by: i64) {
    match value {
        Bson::DateTime(date) => *date = bson::DateTime::from_millis(date.timestamp_millis() + by),
        Bson::Document(document) => document.iter_mut().for_each(|(_, v)| shift_dates(v, by)),
        Bson::Array(items) => items.iter_mut().for_each(|v| shift_dates(v, by)),
        _ => {}
    }
}

/// A session the TypeScript issued (its documents as Mongoose stored them, moved to today)
/// works with Rust: its access token authenticates, its refresh token rotates, the rotated-out
/// token is detected as reused.
#[tokio::test]
async fn typescript_issued_session_works_in_rust() -> Result<()> {
    let reference: Value = serde_json::from_str(include_str!("oauth-reference.json"))?;
    let issued = &reference["tsIssued"];
    with_stores(DB, |stores| async move {
        let documents = issued["documents"].as_object().context("documents")?;
        let session = Bson::try_from(documents["oauth_sessions"][0].clone())?;
        let issued_at = session
            .as_document()
            .context("session")?
            .get_datetime("last_used_at")?
            .timestamp_millis();
        let shift = now_ms() - issued_at;
        for (collection, docs) in documents {
            for doc in docs.as_array().context("docs")? {
                let mut bson = Bson::try_from(doc.clone())?;
                shift_dates(&mut bson, shift);
                stores
                    .mongo
                    .documents(collection)
                    .insert_one(bson.as_document().context("doc")?.clone())
                    .await?;
            }
        }
        let access = issued["access_token"].as_str().context("access")?;
        let refresh = issued["refresh_token"].as_str().context("refresh")?;
        let key = format!("oauth:access:{}", sha256_base64url(access));
        stores.track(&key);
        stores
            .cache
            .set(
                &key,
                issued["access_value"].as_str().context("value")?.as_bytes(),
                SetOptions::ex(600),
            )
            .await?;
        let service = service(&stores, None)?;
        let identity = service.authenticate_access(Some(access)).await?;
        assert_eq!(identity.session_id, issued["session_id"].as_str().unwrap());
        let rotated = service.refresh_access(&refresh_input(refresh)).await?;
        stores.track(format!(
            "oauth:access:{}",
            sha256_base64url(rotated.access_token().expose())
        ));
        assert_eq!(rotated.session_id(), identity.session_id);
        service
            .authenticate_access(Some(rotated.access_token().expose()))
            .await?;
        assert_eq!(
            service.refresh_access(&refresh_input(refresh)).await.err(),
            Some(OAuthError::INVALID_GRANT)
        );
        Ok(())
    })
    .await
}

/// The shape of a document: field names in order with their BSON types, recursively.
fn shape(value: &Bson) -> Value {
    match value {
        Bson::Document(document) => Value::Object(
            document
                .iter()
                .map(|(k, v)| (k.clone(), shape(v)))
                .collect(),
        ),
        Bson::Array(items) => Value::Array(items.iter().map(shape).collect()),
        other => json!(format!("{:?}", other.element_type())),
    }
}

/// A session Rust issues works with the TypeScript. The recorder seeded the documents of
/// `oauth-rust-issued.json` and used them with `refreshAccess` and `authenticateAccess`; this test
/// checks that outcome, and that Rust still writes documents of exactly that shape.
#[tokio::test]
async fn rust_issued_session_works_in_typescript() -> Result<()> {
    let cases: Value = serde_json::from_str(include_str!("oauth-cases.json"))?;
    let fixture_path = format!(
        "{}/tests/oauth-rust-issued.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let update = std::env::var("DIMA_UPDATE_FIXTURES").as_deref() == Ok("1");
    with_stores(DB, |stores| async move {
        let users = seed(&stores, &cases).await?;
        let service = service(&stores, None)?;
        service.initialize().await?;
        let (_, issued) = issue_one(&service, &stores, "cross").await?;
        let session_id = ObjectId::parse_str(issued.session_id())?;
        let session = stores.mongo.documents("oauth_sessions").find_one(doc! { "_id": session_id }).await?.context("session")?;
        let user = stores.mongo.documents("users").find_one(doc! { "_id": ObjectId::parse_str(&users["cross"])? }).await?.context("user")?;
        let find = |collection: &'static str, filter: Document| {
            let stores = stores.clone();
            async move { Ok::<_, anyhow::Error>(stores.mongo.documents(collection).find(filter).await?.try_collect::<Vec<_>>().await?) }
        };
        let documents = json!({
            "users": [Bson::Document(user).into_canonical_extjson()],
            "oauth_clients": find("oauth_clients", doc! { "client_id": "dima-desktop" }).await?.into_iter().map(|d| Bson::Document(d).into_canonical_extjson()).collect::<Vec<_>>(),
            "oauth_grants": find("oauth_grants", doc! { "_id": session.get_object_id("grant_id")? }).await?.into_iter().map(|d| Bson::Document(d).into_canonical_extjson()).collect::<Vec<_>>(),
            "oauth_sessions": [Bson::Document(session.clone()).into_canonical_extjson()],
            "oauth_refresh_tokens": find("oauth_refresh_tokens", doc! { "session_id": session_id }).await?.into_iter().map(|d| Bson::Document(d).into_canonical_extjson()).collect::<Vec<_>>(),
        });
        let access_value = stores.cache.get(&format!("oauth:access:{}", sha256_base64url(issued.access_token().expose()))).await?.context("access")?;
        if update {
            let fixture = json!({
                "issued_at_ms": session.get_datetime("last_used_at")?.timestamp_millis(),
                "access_token": issued.access_token().expose(),
                "refresh_token": issued.refresh_token().expose(),
                "access_value": String::from_utf8(access_value)?,
                "documents": documents,
            });
            std::fs::write(&fixture_path, serde_json::to_string_pretty(&fixture)? + "\n")?;
            return Ok(());
        }
        let bytes = std::fs::read(&fixture_path)?;
        let fixture: Value = serde_json::from_slice(&bytes)?;
        for collection in ["oauth_grants", "oauth_sessions", "oauth_refresh_tokens", "oauth_clients"] {
            let now: Vec<Value> = documents[collection].as_array().unwrap().iter().map(|d| shape(&Bson::try_from(d.clone()).unwrap())).collect();
            let then: Vec<Value> = fixture["documents"][collection].as_array().unwrap().iter().map(|d| shape(&Bson::try_from(d.clone()).unwrap())).collect();
            assert_eq!(now, then, "{collection}: Rust no longer writes what the TypeScript was shown to read");
        }
        let reference: Value = serde_json::from_str(include_str!("oauth-reference.json"))?;
        let used = &reference["rustIssued"];
        assert_eq!(used["fixture_sha256"], json!(dima_core::crypto::digest::sha256(&bytes).hex()), "record again after updating the fixture");
        assert_eq!(used["authenticate"], "ok");
        assert_eq!(used["refresh"]["token_type"], "Bearer");
        assert_eq!(used["refresh"]["refresh_token"], "dima_rt_*");
        assert_eq!(used["new_access"], "ok");
        assert_eq!(used["reuse_of_old_refresh"]["error"], "invalid_grant");
        Ok(())
    })
    .await
}

/// `browserUser` (read from `routes.ts`; not separately recorded): a fresh proof, never the cache.
#[tokio::test]
async fn browser_proof() -> Result<()> {
    let cases: Value = serde_json::from_str(include_str!("oauth-cases.json"))?;
    with_stores(DB, |stores| async move {
        seed(&stores, &cases).await?;
        let server = MockServer::start().await?;
        let run = stores.run.clone();
        let valid_id = id_of("valid", &run);
        let stranger = id_of("stranger", &run);
        server.fallback(move |request| {
            let auth = request.header("authorization").unwrap_or_default();
            let token = auth.strip_prefix("OAuth ").unwrap_or("");
            let body = |client: &str, user: &str, expires: i64| {
                MockResponse::json(200, &json!({"client_id": client, "login": "x", "scopes": [], "user_id": user, "expires_in": expires}).to_string())
            };
            match token {
                "goodtoken0001" => body("fixture-client", &valid_id, 3600),
                "strangertoken" => body("fixture-client", &stranger, 3600),
                "foreigntoken0" => body("other-app", &valid_id, 3600),
                "expiredtoken0" => body("fixture-client", &valid_id, 0),
                "nouserid00000" => body("fixture-client", "", 3600),
                "notjsontoken0" => MockResponse::json(200, "<html>"),
                "droppedtoken0" => MockResponse::drop_connection(),
                _ => MockResponse::json(401, r#"{"status":401,"message":"invalid access token"}"#),
            }
        });
        let service = service(&stores, Some(&server))?;
        let code = |r: Result<dima_platform::oauth::BrowserUser, OAuthError>| r.map(|u| u.twitch_id).map_err(OAuthError::code);
        assert_eq!(code(service.browser_user(Some("Bearer goodtoken0001")).await), Ok(id_of("valid", &run)));
        for (header, expected) in [
            (None, "login_required"),
            (Some("goodtoken0001"), "login_required"),
            (Some("Bearer short"), "login_required"),
            (Some("Bearer dima_at_whatever0"), "login_required"),
            (Some("Bearer revokedtoken0"), "login_required"),
            (Some("Bearer foreigntoken0"), "login_required"),
            (Some("Bearer expiredtoken0"), "login_required"),
            (Some("Bearer nouserid00000"), "login_required"),
            (Some("Bearer has space000"), "login_required"),
            (Some("Bearer strangertoken"), "account_required"),
            (Some("Bearer notjsontoken0"), "temporarily_unavailable"),
            (Some("Bearer droppedtoken0"), "temporarily_unavailable"),
        ] {
            assert_eq!(code(service.browser_user(header).await), Err(expected), "{header:?}");
        }
        // The proof is sent as `OAuth <token>`, every time.
        assert!(server.requests().iter().all(|r| r.header("authorization").is_some_and(|a| a.starts_with("OAuth "))));
        Ok(())
    })
    .await
}

/// Errors as the OAuth routers answer them.
#[tokio::test]
async fn error_answers() -> Result<()> {
    use http_body_util::BodyExt;
    for (error, status, body, header) in [
        (
            OAuthError::INVALID_TOKEN,
            401,
            r#"{"error":"invalid_token"}"#,
            Some(("www-authenticate", "Bearer error=\"invalid_token\"")),
        ),
        (
            OAuthError::SLOW_DOWN,
            429,
            r#"{"error":"slow_down"}"#,
            Some(("retry-after", "60")),
        ),
        (
            OAuthError::UNAVAILABLE,
            503,
            r#"{"error":"temporarily_unavailable"}"#,
            None,
        ),
        (
            OAuthError::INVALID_GRANT,
            400,
            r#"{"error":"invalid_grant"}"#,
            None,
        ),
    ] {
        let mut router = dima_web::Router::new();
        router.get("/", move |_req: &mut dima_web::Req<()>| async move {
            error.response()
        });
        let app = dima_web::App::new(router, ())?;
        let response = app
            .handle(http::Request::get("/").body(dima_web::Body::empty())?)
            .await;
        assert_eq!(response.status().as_u16(), status);
        if let Some((name, value)) = header {
            assert_eq!(response.headers()[name], value);
        }
        let bytes = response.into_body().collect().await?.to_bytes();
        assert_eq!(std::str::from_utf8(&bytes)?, body);
    }
    Ok(())
}

/// One request approved by two processes at the same moment: one callback with a code, one
/// `invalid_request` (the request is consumed once).
#[tokio::test]
async fn a_request_approved_twice_at_once_gives_one_code() -> Result<()> {
    let cases: Value = serde_json::from_str(include_str!("oauth-cases.json"))?;
    with_stores(DB, |stores| async move {
        seed(&stores, &cases).await?;
        let first = service(&stores, None)?;
        first.initialize().await?;
        let second_stores = stores.second().await?;
        let second = service(&second_stores, None)?;
        let (_, input) = authorize_input();
        let id = first.start_authorization(&input).await?;
        stores.track(format!("oauth:request:{}", sha256_base64url(&id)));
        let twitch = id_of("valid", &stores.run);
        let (a, b) = tokio::join!(
            first.approve_authorization(&id, &twitch, true),
            second.approve_authorization(&id, &twitch, true)
        );
        for url in [&a, &b].into_iter().flatten() {
            if let Some((_, code)) = url::Url::parse(url)?
                .query_pairs()
                .find(|(k, _)| k == "code")
            {
                stores.track(format!("oauth:code:{}", sha256_base64url(&code)));
            }
        }
        assert_eq!([a.is_ok(), b.is_ok()].iter().filter(|ok| **ok).count(), 1);
        assert!([a.err(), b.err()].contains(&Some(OAuthError::INVALID_REQUEST)));
        Ok(())
    })
    .await
}

//! Stateless Twitch Extension gateway. Environment is read only by the binary.
#![forbid(unsafe_code)]
pub mod auth;
use dima_core::{Clock, SecretBytes, SecretString, Shutdown};
use dima_http::{HttpClient, Method, Provider, RetryPolicy};
use dima_web::{App, Flow, Req, Response, Router};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

pub struct Config {
    pub internal_url: String,
    pub public_url: String,
    pub service_token: SecretString,
    pub signing_secret: SecretString,
    pub allow_unverified: bool,
}
pub struct State {
    config: Config,
    keys: Vec<SecretBytes>,
    clock: Arc<dyn Clock>,
    http: HttpClient,
    primary: Provider,
    fallback: Provider,
    outbound: tokio::sync::Semaphore,
}
#[derive(Debug, thiserror::Error)]
pub enum BuildError {
    #[error("invalid upstream configuration")]
    Provider(#[from] dima_http::ConfigError),
    #[error("HTTP client initialization failed")]
    Client(#[from] dima_http::Error),
    #[error("invalid router configuration")]
    Router(#[from] dima_web::ConfigError),
}
/// Build the gateway with injected clock and shutdown owner.
pub fn build(
    config: Config,
    clock: Arc<dyn Clock>,
    shutdown: Shutdown,
) -> Result<App<State>, BuildError> {
    let provider = |name, url: &str| {
        Provider::builder(name, url)
            .internal(true)
            .timeout(Duration::from_secs(30))
            .headers_timeout(Duration::from_secs(30))
            .idle_timeout(Duration::from_secs(30))
            .max_bytes(8 * 1024 * 1024)
            .max_concurrency(128)
            .retry(RetryPolicy::none())
            .secret_header("x-dimafx-service-token", &config.service_token)
            .header("Content-Type", "application/json")
            .build()
    };
    let state = State {
        outbound: tokio::sync::Semaphore::new(128),
        primary: provider("dimafx-internal", &config.internal_url)?,
        fallback: provider("dimafx-public", &config.public_url)?,
        keys: auth::keys(config.signing_secret.expose()),
        http: HttpClient::builder()
            .connect_timeout(Duration::from_secs(30))
            .shutdown(shutdown)
            .build()?,
        config,
        clock,
    };
    let mut root = Router::new();
    root.middleware(dima_web::cors::cors());
    root.middleware(dima_web::body::json());
    root.get("/health", health);
    let mut routes = Router::new();
    routes.middleware(authenticate);
    routes.get("/me", me);
    routes.get("/channels/:channelID/overlay-status", proxy);
    routes.get("/channels/:channelID/items", proxy);
    routes.patch("/channels/:channelID/me/config", proxy);
    for action in ["purchase", "use-credit", "redeem"] {
        routes.post(
            &format!("/channels/:channelID/items/:itemID/{action}"),
            proxy,
        );
    }
    root.mount("/v1", routes);
    Ok(App::new(root, state)?)
}
fn fail(status: u16, message: &str) -> Response {
    Response::status(status).json(&json!({"error":true,"message":message,"status":status}))
}
async fn health(_: &mut Req<State>) -> Response {
    Response::new().json(&json!({"error":false,"status":200,"data":{"ok":true}}))
}
#[derive(Clone)]
struct Identity(Value);
async fn authenticate(req: &mut Req<State>) -> Flow {
    let token = match req.header("authorization") {
        Some(header) if header.starts_with("Bearer ") => {
            header.strip_prefix("Bearer ").map(str::to_owned)
        }
        _ => req.header("x-extension-jwt").map(|v| v.into_owned()),
    };
    let Some(token) = token.filter(|s| !s.is_empty()) else {
        return fail(401, "Missing Twitch Extension token").into();
    };
    let state = req.state();
    let Some(payload) = auth::verify(
        &token,
        &state.keys,
        state.config.allow_unverified,
        state.clock.now_ms(),
    ) else {
        return fail(401, "Invalid Twitch Extension token").into();
    };
    req.extensions_mut().insert(Identity(payload));
    Flow::Next
}
fn identity(req: &Req<State>) -> Value {
    req.extensions()
        .get::<Identity>()
        .map(|v| v.0.clone())
        .unwrap_or(Value::Null)
}
fn status(payload: &Value, default: u16) -> u16 {
    if dima_text::js_truthy(&payload["status"]) {
        dima_text::js_number(&payload["status"]) as u16
    } else {
        default
    }
}
fn enc(value: &Value) -> String {
    dima_text::encode_uri_component(&dima_text::js_string(value)).into_owned()
}
fn copy(from: &Value, to: &mut Value, fields: &[(&str, &str)]) {
    for (source, target) in fields {
        if let Some(value) = from.get(*source) {
            to[*target] = value.clone();
        }
    }
}
impl State {
    async fn request_from(
        &self,
        provider: &Provider,
        path: &str,
        method: Method,
        body: &Value,
    ) -> Value {
        // Compatibility workaround: dima-http Path accepts only static paths or its own
        // stricter RFC3986 escaping. Put the already encodeURIComponent-escaped path
        // in a request-local provider so punctuation keeps the Node wire spelling.
        // Concatenate exactly like fetch(`${baseUrl}${path}`), including an
        // operator-configured trailing slash rather than silently normalizing it.
        let base = if provider.name() == "dimafx-internal" {
            &self.config.internal_url
        } else {
            &self.config.public_url
        };
        let endpoint = format!("{base}{path}");
        let endpoint = Provider::builder(provider.name(), &endpoint)
            .internal(true)
            .timeout(Duration::from_secs(30))
            .headers_timeout(Duration::from_secs(30))
            .idle_timeout(Duration::from_secs(30))
            .max_bytes(8 * 1024 * 1024)
            .retry(RetryPolicy::none())
            .header("Content-Type", "application/json")
            .secret_header("x-dimafx-service-token", &self.config.service_token)
            .build();
        let Ok(endpoint) = endpoint else {
            return json!({"error":true,"message":"fetch failed","status":503});
        };
        let mut request = self.http.request(&endpoint, method.clone(), "");
        if method != Method::GET {
            request = request.json_js(body);
        }
        let result = async {
            let response = request.send().await?;
            let code = response.status().as_u16();
            let mut payload = response
                .bytes()
                .await
                .ok()
                .and_then(|bytes| {
                    dima_text::parse_js_json(
                        &String::from_utf8_lossy(&bytes),
                        dima_text::JsonLimits {
                            max_depth: 128,
                            max_bytes: 8 * 1024 * 1024,
                        },
                    )
                    .ok()
                })
                .unwrap_or_else(|| json!({"error":true,"message":"Invalid API response"}));
            if !(200..300).contains(&code) && payload.is_null() {
                return Ok(json!({"error":true,"status":503,"message":"Cannot read properties of null (reading 'error')"}));
            }
            if !(200..300).contains(&code) && !dima_text::js_truthy(&payload["error"]) {
                if !payload.is_object() {
                    payload = json!({});
                }
                payload["error"] = json!(true);
                payload["status"] = json!(code);
            }
            Ok::<_, dima_http::Error>(payload)
        }
        .await;
        // Never expose transport errors: they can contain upstream URLs or credentials.
        result.unwrap_or_else(|_| json!({"error":true,"message":"fetch failed","status":503}))
    }
    async fn request(&self, path: &str, method: Method, body: Value) -> Value {
        if self.config.service_token.is_empty() {
            return json!({"error":true,"message":"DimaFX service token is not configured","status":503});
        }
        let Ok(_permit) = self.outbound.acquire().await else {
            return json!({"error":true,"message":"fetch failed","status":503});
        };
        let first = self
            .request_from(&self.primary, path, method.clone(), &body)
            .await;
        if dima_text::js_truthy(&first["error"])
            && (!dima_text::js_truthy(&first["status"])
                || dima_text::js_number(&first["status"]) >= 500.)
        {
            // REFERENCE WEAKNESS: replay even purchases, with service token, to public API.
            self.request_from(&self.fallback, path, method, &body).await
        } else {
            first
        }
    }
}
async fn me(req: &mut Req<State>) -> Response {
    let id = identity(req);
    let mut data = json!({"identityShared":false,"platform":"twitch","channelID":id["channel_id"],"balance":0,"inventory":null});
    if !dima_text::js_truthy(&id["user_id"]) {
        copy(&id, &mut data, &[("opaque_user_id", "opaqueUserID")]);
        return Response::new().json(&json!({"error":false,"status":200,"data":data}));
    }
    let path = format!(
        "/extensions/dimafx/internal/channels/{}/viewers/{}/init",
        enc(&id["channel_id"]),
        enc(&id["user_id"])
    );
    let mut payload = req.state().request(&path, Method::POST, json!({})).await;
    let code = status(&payload, 200);
    data["identityShared"] = json!(true);
    data["userID"] = id["user_id"].clone();
    if let Some(object) = data.as_object_mut() {
        object.remove("inventory");
    }
    copy(&payload, &mut data, &[("data", "inventory")]);
    let balance = &payload["data"]["balance"];
    data["balance"] = json!(if dima_text::js_truthy(balance) {
        dima_text::js_number(balance)
    } else {
        0.
    });
    if !payload.is_object() {
        return fail(500, "Internal server error");
    }
    payload["data"] = data;
    Response::status(code).json(&payload)
}
async fn proxy(req: &mut Req<State>) -> Result<Response, dima_web::Error> {
    let id = identity(req);
    let channel = req.param("channelID").unwrap_or_default().to_owned();
    if id["channel_id"].as_str() != Some(&channel) {
        return Ok(fail(403, "Extension channel mismatch"));
    }
    let normalized_path = req.path().trim_end_matches('/').to_ascii_lowercase();
    let overlay = normalized_path.ends_with("/overlay-status");
    if overlay {
        req.set_header("Cache-Control", "no-store")?;
    }
    let config = req.method() == Method::PATCH;
    let action = if config {
        "config"
    } else if overlay {
        "overlay-status"
    } else if req.method() == Method::GET || req.method() == Method::HEAD {
        "items"
    } else {
        normalized_path.rsplit('/').next().unwrap_or_default()
    };
    if !dima_text::js_truthy(&id["user_id"]) {
        let refusal = match action {
            "config" => Some("Share your Twitch identity to save DimaFX preferences"),
            "use-credit" => Some("Share your Twitch identity to use DimaFX credits"),
            "redeem" => Some("Share your Twitch identity to redeem saved items"),
            _ => None,
        };
        if let Some(message) = refusal {
            return Ok(fail(403, message));
        }
    }
    let base = format!(
        "/extensions/dimafx/internal/channels/{}",
        dima_text::encode_uri_component(&channel)
    );
    let path = match action {
        "config" => format!("{base}/viewers/{}/config", enc(&id["user_id"])),
        "overlay-status" => format!("{base}/overlay-status"),
        "items" => format!("{base}/items"),
        _ => format!(
            "{base}/items/{}/{action}",
            dima_text::encode_uri_component(req.param("itemID").unwrap_or_default())
        ),
    };
    let mut body = json!({});
    if !["config", "items", "overlay-status"].contains(&action) {
        copy(
            &id,
            &mut body,
            &[("user_id", "userID"), ("opaque_user_id", "opaqueUserID")],
        );
    }
    let fields: &[(&str, &str)] = match action {
        "config" => &[
            ("quickPurchasePriority", "quickPurchasePriority"),
            ("quickPurchaseAction", "quickPurchaseAction"),
        ],
        "purchase" => &[
            ("sku", "sku"),
            ("transactionID", "transactionID"),
            ("action", "action"),
            ("ttsText", "ttsText"),
        ],
        "use-credit" => &[("action", "action"), ("ttsText", "ttsText")],
        _ => &[],
    };
    copy(req.body(), &mut body, fields);
    let method = if config {
        Method::PATCH
    } else if ["items", "overlay-status"].contains(&action) {
        Method::GET
    } else {
        Method::POST
    };
    let payload = req.state().request(&path, method, body).await;
    if payload.is_null() {
        return Ok(if overlay {
            fail(503, "DimaFX connection status unavailable")
        } else {
            fail(500, "Internal server error")
        });
    }
    let default = if dima_text::js_truthy(&payload["error"]) {
        500
    } else {
        200
    };
    Ok(Response::status(status(&payload, default)).json(&payload))
}

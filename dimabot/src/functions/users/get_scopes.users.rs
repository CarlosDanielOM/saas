//! App-authorized Helix user scope lookup.
use crate::utils::twitch::{AccessToken, HelixRequest, HelixRetryPolicy, TokenFuture, TokenSource, TwitchAuth, TwitchClient};
use reqwest::Method;
use serde_json::{Value, json};

struct FixedToken(AccessToken);
impl TokenSource for FixedToken {
    fn token<'a>(&'a self, _: &'a TwitchAuth) -> TokenFuture<'a> {
        Box::pin(async move { Ok(self.0.clone()) })
    }
}

/// Fetches the Helix authorization record using the supplied app token source.
/// The client and token source are supplied by the caller; construction and
/// module loading do not read the environment or initiate connections.
///
/// `getAppToken` catches its own failures and returns null, so every token-source
/// failure uses the failed-token envelope. The source `catch` covers the Helix
/// call and JSON decode only.
pub async fn get_scopes(tokens: &dyn TokenSource, client: &TwitchClient, user_id: &str) -> Value {
    let token = match tokens.token(&TwitchAuth::App).await {
        Ok(token) if !token.expose_secret().is_empty() => token,
        Ok(_) | Err(_) => return json!({"error":true,"message":"Failed to get app access token","status":500}),
    };
    let Ok(mut query) = reqwest::Url::parse("http://localhost/") else {
        log_get_scopes_failure(user_id, "unable to construct query");
        return json!({"error":true,"message":"Internal server error"});
    };
    query.query_pairs_mut().append_pair("user_id", user_id);
    let params = query.query().unwrap_or_default();
    let result = client.request(&FixedToken(token), &TwitchAuth::App, HelixRequest {
        method: Method::GET, endpoint: "authorization/users", params: Some(params), body: None,
    }, &HelixRetryPolicy::single_attempt()).await;
    let response = match result {
        Ok(result) => result.response,
        Err(error) => {
            log_get_scopes_failure(user_id, &error.to_string());
            return json!({"error":true,"message":"Internal server error"});
        }
    };
    let data: Value = match response.json().await {
        Ok(data) => data,
        Err(error) => {
            log_get_scopes_failure(user_id, &error.to_string());
            return json!({"error":true,"message":"Internal server error"});
        }
    };
    if data.is_null() {
        log_get_scopes_failure(user_id, "Cannot read properties of null (reading error)");
        return json!({"error":true,"message":"Internal server error"});
    }
    let error = data.get("error").is_some_and(|value| match value {
        Value::Null => false, Value::Bool(value) => *value,
        Value::String(value) => !value.is_empty(), Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
        _ => true,
    });
    if error {
        let mut result = serde_json::Map::new();
        result.insert("error".into(), json!(true));
        if let Some(value) = data.get("message") { result.insert("message".into(), value.clone()); }
        if let Some(value) = data.get("status") { result.insert("status".into(), value.clone()); }
        result.insert("data".into(), data);
        Value::Object(result)
    } else {
        let mut result = json!({"error":false,"message":"Scopes fetched successfully","status":200});
        if let Some(value) = data.get("data") { result["data"] = value.clone(); }
        result
    }
}

/// Source `console.error('Error in getScopes:', { userID, error, stack, timestamp })`.
/// Node's `util.inspect` layout is not reproduced. The stack is the native
/// backtrace; there is no JavaScript stack.
fn log_get_scopes_failure(user_id: &str, error: &str) {
    let millis = mongodb::bson::DateTime::now().timestamp_millis();
    let whole = mongodb::bson::DateTime::from_millis(millis.div_euclid(1000) * 1000);
    let base = whole
        .try_to_rfc3339_string()
        .unwrap_or_default()
        .replace("+00:00", "Z");
    let prefix = base.trim_end_matches('Z').split('.').next().unwrap_or("");
    let timestamp = format!("{prefix}.{:03}Z", millis.rem_euclid(1000));
    let stack = std::backtrace::Backtrace::force_capture().to_string();
    eprintln!(
        "Error in getScopes: {}",
        json!({"userID": user_id, "error": error, "stack": stack, "timestamp": timestamp})
    );
}

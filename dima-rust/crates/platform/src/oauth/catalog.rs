//! Scopes, lifetimes, scope parsing and redirect validation (reference:
//! `dimabot/src/server/oauth/catalog.ts`).

use super::OAuthError;
use serde_json::Value;

/// One Dima scope: its name, whether it can be granted today, and its key in the desktop app.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Scope {
    /// The scope name.
    pub name: &'static str,
    /// Grantable today (inactive scopes are announced as planned).
    pub active: bool,
    /// The desktop app's key.
    pub key: &'static str,
}

/// `OAUTH_SCOPES`, in the reference's order.
pub const OAUTH_SCOPES: [Scope; 11] = [
    Scope {
        name: "profile:read",
        active: true,
        key: "profile",
    },
    Scope {
        name: "credits:read",
        active: true,
        key: "credits",
    },
    Scope {
        name: "desktop:connect",
        active: true,
        key: "connect",
    },
    Scope {
        name: "ai:interact",
        active: true,
        key: "aiInteract",
    },
    Scope {
        name: "usage:read",
        active: false,
        key: "usage",
    },
    Scope {
        name: "pet:read",
        active: true,
        key: "petRead",
    },
    Scope {
        name: "pet:write",
        active: false,
        key: "petWrite",
    },
    Scope {
        name: "pet:receive",
        active: true,
        key: "petReceive",
    },
    Scope {
        name: "pet:interact",
        active: true,
        key: "petInteract",
    },
    Scope {
        name: "pet:control",
        active: true,
        key: "petControl",
    },
    Scope {
        name: "pet:playback:select",
        active: true,
        key: "petSelect",
    },
];

/// `ACCESS_TTL_SECONDS`.
pub const ACCESS_TTL_SECONDS: u64 = 600;
/// `REQUEST_TTL_SECONDS`.
pub const REQUEST_TTL_SECONDS: u64 = 600;
/// `CODE_TTL_SECONDS`.
pub const CODE_TTL_SECONDS: u64 = 60;
/// `REFRESH_IDLE_MS`: 30 days.
pub const REFRESH_IDLE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// `SESSION_ABSOLUTE_MS`: 90 days.
pub const SESSION_ABSOLUTE_MS: i64 = 90 * 24 * 60 * 60 * 1000;
/// `DESKTOP_CLIENT_ID`.
pub const DESKTOP_CLIENT_ID: &str = "dima-desktop";
/// The desktop client's registered loopback callbacks (`initializeOAuth`).
pub const DESKTOP_REDIRECT_URIS: [&str; 2] = [
    "http://127.0.0.1/oauth/callback",
    "http://[::1]/oauth/callback",
];

/// The scope named `name`, if the catalog has it.
pub fn scope(name: &str) -> Option<&'static Scope> {
    OAUTH_SCOPES.iter().find(|scope| scope.name == name)
}

/// `Object.hasOwn(OAUTH_SCOPES, name) && OAUTH_SCOPES[name].active`.
pub fn is_active(name: &str) -> bool {
    scope(name).is_some_and(|scope| scope.active)
}

/// The grantable scopes, in catalog order (`scopes_supported`).
pub fn active_scopes() -> Vec<&'static str> {
    OAUTH_SCOPES
        .iter()
        .filter(|scope| scope.active)
        .map(|scope| scope.name)
        .collect()
}

/// The announced, not yet grantable scopes (`planned_scopes`).
pub fn planned_scopes() -> Vec<&'static str> {
    OAUTH_SCOPES
        .iter()
        .filter(|scope| !scope.active)
        .map(|scope| scope.name)
        .collect()
}

/// `parseScopes`: a string of at most 500 UTF-16 units (an outside-protocol limit: the length
/// the client already respects), space-separated active scope names, duplicates removed.
pub fn parse_scopes(value: Option<&Value>) -> Result<Vec<String>, OAuthError> {
    let Some(Value::String(text)) = value else {
        return Err(OAuthError::INVALID_SCOPE);
    };
    if dima_text::utf16_len(text) > 500 {
        return Err(OAuthError::INVALID_SCOPE);
    }
    let mut scopes: Vec<String> = Vec::new();
    for name in text.split(' ') {
        if !is_active(name) {
            return Err(OAuthError::INVALID_SCOPE);
        }
        if !scopes.iter().any(|existing| existing == name) {
            scopes.push(name.to_owned());
        }
    }
    Ok(scopes)
}

/// `validateRedirect`: only an ephemeral port may differ from a registered loopback callback.
///
/// The value must be a string of at most 300 UTF-16 units that parses (WHATWG, as `new URL`)
/// to `http:` on `127.0.0.1` or `[::1]` with an explicit port of at least 1, no user or password,
/// no query and no fragment (an empty `?` or `#` counts as none, as the URL getters report it),
/// whose `http://host/path` is registered, and whose serialisation is the value itself (so no
/// spelling of the same URL can differ from what is registered and compared later).
pub fn validate_redirect(
    value: Option<&Value>,
    registered: &[String],
) -> Result<String, OAuthError> {
    let Some(Value::String(text)) = value else {
        return Err(OAuthError::INVALID_REQUEST);
    };
    validate_redirect_str(text, registered).map(|()| text.clone())
}

pub(crate) fn validate_redirect_str(text: &str, registered: &[String]) -> Result<(), OAuthError> {
    if dima_text::utf16_len(text) > 300 {
        return Err(OAuthError::INVALID_REQUEST);
    }
    let url = url::Url::parse(text).map_err(|_| OAuthError::INVALID_REQUEST)?;
    let host = url.host_str().unwrap_or_default();
    let loopback = host == "127.0.0.1" || host == "[::1]";
    let port_ok = url.port().is_some_and(|port| port >= 1);
    let empty = |part: Option<&str>| part.is_none_or(str::is_empty);
    let base = format!("http://{host}{}", url.path());
    if url.scheme() != "http"
        || !loopback
        || !port_ok
        || !url.username().is_empty()
        || url.password().is_some()
        || !empty(url.query())
        || !empty(url.fragment())
        || !registered.contains(&base)
        || url.as_str() != text
    {
        return Err(OAuthError::INVALID_REQUEST);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn registered() -> Vec<String> {
        DESKTOP_REDIRECT_URIS
            .iter()
            .map(|s| (*s).to_owned())
            .collect()
    }

    #[test]
    fn redirects() {
        let ok = |s: &str| validate_redirect(Some(&json!(s)), &registered()).is_ok();
        assert!(ok("http://127.0.0.1:53682/oauth/callback"));
        assert!(ok("http://[::1]:53682/oauth/callback"));
        assert!(ok("http://127.0.0.1:53682/oauth/callback?"));
        assert!(ok("http://127.0.0.1:53682/oauth/callback#"));
        assert!(!ok("http://127.0.0.1/oauth/callback"));
        assert!(!ok("http://127.0.0.1:0/oauth/callback"));
        assert!(!ok("http://127.0.0.1:053682/oauth/callback"));
        assert!(!ok("http://[0:0::1]:53682/oauth/callback"));
        assert!(!ok("http://127.1:53682/oauth/callback"));
        assert!(!ok("http://localhost:53682/oauth/callback"));
        assert!(!ok("http://u@127.0.0.1:53682/oauth/callback"));
        assert!(!ok("http://127.0.0.1:53682/oauth/callback?a=1"));
        assert!(!ok("https://127.0.0.1:53682/oauth/callback"));
    }

    #[test]
    fn scopes() {
        assert_eq!(
            parse_scopes(Some(&json!("profile:read profile:read pet:read"))),
            Ok(vec!["profile:read".to_owned(), "pet:read".to_owned()])
        );
        assert_eq!(
            parse_scopes(Some(&json!("usage:read"))),
            Err(OAuthError::INVALID_SCOPE)
        );
        assert_eq!(
            parse_scopes(Some(&json!(""))),
            Err(OAuthError::INVALID_SCOPE)
        );
        assert_eq!(
            parse_scopes(Some(&json!("a  b"))),
            Err(OAuthError::INVALID_SCOPE)
        );
        assert_eq!(parse_scopes(None), Err(OAuthError::INVALID_SCOPE));
        assert_eq!(active_scopes().len(), 9);
        assert_eq!(planned_scopes(), ["usage:read", "pet:write"]);
    }
}

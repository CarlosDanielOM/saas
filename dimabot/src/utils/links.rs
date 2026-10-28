//! Exact pure URL string builders from `links.ts`.
//!
//! These preserve the supplied endpoint and pre-encoded query verbatim. Actual
//! outbound requests should use `twitch::TwitchEndpoints` to validate paths and
//! configurable fixture endpoints before opening a connection.

pub const TWITCH_HELIX_BASE: &str = "https://api.twitch.tv/helix/";
pub const TWITCH_OAUTH_BASE: &str = "https://id.twitch.tv/oauth2";

pub fn get_twitch_helix_url(endpoint: &str, params: Option<&str>) -> String {
    build_url(TWITCH_HELIX_BASE, Some(endpoint), params, false)
}

pub fn get_twitch_oauth_url(endpoint: Option<&str>, params: Option<&str>) -> String {
    build_url(
        TWITCH_OAUTH_BASE,
        endpoint.filter(|value| !value.is_empty()),
        params,
        true,
    )
}

fn build_url(base: &str, endpoint: Option<&str>, params: Option<&str>, slash: bool) -> String {
    let params = params.filter(|value| !value.is_empty());
    let mut result = String::with_capacity(
        base.len() + endpoint.map_or(0, str::len) + params.map_or(0, str::len) + 2,
    );
    result.push_str(base);
    if let Some(endpoint) = endpoint {
        if slash {
            result.push('/');
        }
        result.push_str(endpoint);
    }
    if let Some(params) = params {
        result.push('?');
        result.push_str(params);
    }
    result
}

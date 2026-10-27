//! Axum CORS layer matching the legacy `app.use(cors())` in
//! `dimabot/src/server/server.ts`.
//!
//! The npm `cors` defaults are: any origin (`*`), methods
//! `GET,HEAD,PUT,PATCH,POST,DELETE`, requested headers reflected, no
//! credentials, no max age, and `204` for preflight. [`legacy_permissive_cors`]
//! configures tower-http the same way.
//!
//! Differences: tower-http answers preflight `OPTIONS` requests with `200`
//! instead of `204` (both are accepted by browsers), and it adds `Vary` for the
//! origin and request headers.
//! OAuth routes have their own origin policy and must not use this layer.

use axum::http::Method;
use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer};

/// Same methods npm `cors` allows by default.
pub const DEFAULT_METHODS: [Method; 6] = [
    Method::GET,
    Method::HEAD,
    Method::PUT,
    Method::PATCH,
    Method::POST,
    Method::DELETE,
];

/// A layer equivalent to npm `cors()` with no options.
pub fn legacy_permissive_cors() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::any())
        .allow_methods(AllowMethods::list(DEFAULT_METHODS))
        .allow_headers(AllowHeaders::mirror_request())
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    use axum::{Router, routing::get};

    use super::*;

    /// Sends one raw HTTP/1.1 request to `router` on loopback.
    async fn exchange(router: Router, request: &str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await });
        let request = request.to_owned();
        let response = tokio::task::spawn_blocking(move || {
            let mut stream = std::net::TcpStream::connect(address).unwrap();
            stream.write_all(request.as_bytes()).unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        })
        .await
        .unwrap();
        server.abort();
        response.to_ascii_lowercase()
    }

    fn app() -> Router {
        Router::new()
            .route("/observability", get(|| async { "ok" }))
            .layer(legacy_permissive_cors())
    }

    #[tokio::test]
    async fn answers_preflight_like_npm_cors() {
        let response = exchange(
            app(),
            "OPTIONS /observability HTTP/1.1\r\nHost: api\r\nOrigin: https://domdimabot.com\r\n\
             Access-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: x-custom, content-type\r\n\
             Connection: close\r\n\r\n",
        )
        .await;
        assert!(response.starts_with("http/1.1 200"), "{response}");
        assert!(response.contains("access-control-allow-origin: *"));
        assert!(response.contains("access-control-allow-methods: get,head,put,patch,post,delete"));
        assert!(response.contains("access-control-allow-headers: x-custom, content-type"));
        assert!(!response.contains("access-control-allow-credentials"));
    }

    #[tokio::test]
    async fn adds_wildcard_origin_to_simple_requests() {
        let response = exchange(
            app(),
            "GET /observability HTTP/1.1\r\nHost: api\r\nOrigin: https://example.com\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(response.starts_with("http/1.1 200"), "{response}");
        assert!(response.contains("access-control-allow-origin: *"));
        assert!(response.ends_with("ok"));
    }
}

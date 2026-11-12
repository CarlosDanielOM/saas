//! `socket.handshake`: what a namespace check and the handlers know about the connection.

use std::net::SocketAddr;
use std::sync::Arc;

use serde_json::{Map, Value};

use crate::budget::Charge;

/// `socket.handshake.query`: the query of the connection's first HTTP request, read as
/// `Object.fromEntries(new URL(req.url).searchParams)` reads it: `+` is a space, percent escapes
/// are decoded (invalid UTF-8 becomes U+FFFD), and of repeated keys the last value wins.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Query {
    /// Keys in JavaScript object order (array-index keys first), each once.
    entries: Vec<(String, String)>,
}

impl Query {
    /// Parses a raw query string (without the `?`).
    pub fn parse(raw: &str) -> Self {
        let mut entries: Vec<(String, String)> = Vec::new();
        for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
            match entries.iter_mut().find(|(existing, _)| *existing == key) {
                Some(entry) => entry.1 = value.into_owned(),
                None => entries.push((key.into_owned(), value.into_owned())),
            }
        }
        // An object lists array-index keys first, in numeric order.
        let mut object = Map::new();
        for (key, value) in &entries {
            object.insert(key.clone(), Value::String(value.clone()));
        }
        let mut object = Value::Object(object);
        dima_text::js_key_order(&mut object);
        let entries = match object {
            Value::Object(map) => map
                .into_iter()
                .map(|(key, value)| match value {
                    Value::String(value) => (key, value),
                    other => (key, other.to_string()),
                })
                .collect(),
            _ => entries,
        };
        Self { entries }
    }

    /// The value of `key` (`query[key]`).
    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| value.as_str())
    }

    /// Whether `key` is present.
    pub fn contains(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// The entries in object order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v.as_str()))
    }
}

/// What every socket of one connection shares: the first HTTP request.
#[derive(Debug)]
pub(crate) struct Origin {
    pub headers: http::HeaderMap,
    pub url: String,
    pub query: Query,
    pub peer: Option<SocketAddr>,
}

/// `socket.handshake`, built when the socket is created, as `Socket.buildHandshake` builds it.
///
/// The `auth` data is charged to the connection's and the server's inbound budgets for as long
/// as a copy of the handshake lives.
#[derive(Debug, Clone)]
pub struct Handshake {
    origin: Arc<Origin>,
    auth: Arc<Map<String, Value>>,
    issued: i64,
    _charge: Arc<Charge>,
}

impl Handshake {
    pub(crate) fn new(
        origin: Arc<Origin>,
        auth: Map<String, Value>,
        charge: Charge,
        issued: i64,
    ) -> Self {
        Self {
            origin,
            auth: Arc::new(auth),
            issued,
            _charge: Arc::new(charge),
        }
    }

    /// `handshake.auth`: the data object of this namespace's CONNECT packet (`{}` when it had
    /// none). A reconnecting client's `pid` and `offset` are in it too, as in the reference.
    pub fn auth(&self) -> &Map<String, Value> {
        &self.auth
    }

    /// `handshake.query`.
    pub fn query(&self) -> &Query {
        &self.origin.query
    }

    /// `handshake.headers`: the headers of the connection's first request.
    pub fn headers(&self) -> &http::HeaderMap {
        &self.origin.headers
    }

    /// `handshake.address`: the peer of the connection's first request as Node prints it
    /// (`::ffff:127.0.0.1` for IPv4 on the dual-stack listener). No forwarded header is trusted.
    pub fn address(&self) -> Option<String> {
        self.origin.peer.map(|peer| peer.ip().to_string())
    }

    /// The peer socket address.
    pub fn peer(&self) -> Option<SocketAddr> {
        self.origin.peer
    }

    /// `handshake.url`: path and query of the connection's first request.
    pub fn url(&self) -> &str {
        &self.origin.url
    }

    /// `handshake.xdomain`: the first request carried an `Origin` header.
    pub fn xdomain(&self) -> bool {
        self.origin.headers.contains_key(http::header::ORIGIN)
    }

    /// `handshake.secure`: always false, the server speaks plain HTTP behind the proxy.
    pub fn secure(&self) -> bool {
        false
    }

    /// `handshake.issued`: when the socket was created, in epoch milliseconds.
    pub fn issued(&self) -> i64 {
        self.issued
    }
}

#[cfg(test)]
mod tests {
    use super::Query;

    #[test]
    fn query_like_url_search_params() {
        let query = Query::parse(
            "EIO=4&transport=polling&t=abc&timeout=30&b=1&2=x&a+b=c%20d&b=2&bad=%FF&e",
        );
        assert_eq!(query.get("timeout"), Some("30"));
        assert_eq!(query.get("b"), Some("2"));
        assert_eq!(query.get("a b"), Some("c d"));
        assert_eq!(query.get("bad"), Some("\u{FFFD}"));
        assert_eq!(query.get("e"), Some(""));
        assert_eq!(query.get("missing"), None);
        let keys: Vec<&str> = query.iter().map(|(k, _)| k).collect();
        assert_eq!(
            keys,
            [
                "2",
                "EIO",
                "transport",
                "t",
                "timeout",
                "b",
                "a b",
                "bad",
                "e"
            ]
        );
    }
}

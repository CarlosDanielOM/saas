//! A prefixing proxy to the local Qdrant: each side sees an empty Qdrant of its own. Collection
//! names in request paths get the side's prefix (`rig_<pid>_<n>_<side>__twitch_chat_logs`), the
//! collection list shows only the side's collections without the prefix, and the prefix is
//! removed from every answer. The side gets a placeholder API key; the proxy sends the real one.
//! Every request is recorded as a call to provider `qdrant`. The side's collections are deleted
//! by the rig's cleanup (and by `dima-rig gc` for rig processes that are gone).

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use hyper::{Request, Response};
use serde_json::Value;

use super::{Body, Shared, full, not_implemented, read_body};
use crate::capture::RawCall;
use crate::timefmt;

#[derive(Debug, Clone)]
pub struct Upstream {
    /// `http://127.0.0.1:6333`
    pub url: String,
    pub api_key: Option<String>,
    /// `rig_<pid>_<n>_<side>__`
    pub prefix: String,
}

/// The path with the side's prefix on the collection name.
pub fn prefixed_path(path: &str, prefix: &str) -> String {
    let mut parts: Vec<String> = path.split('/').map(str::to_string).collect();
    // ["", "collections", "<name>", ...]
    if parts.get(1).map(String::as_str) == Some("collections")
        && let Some(name) = parts.get_mut(2)
        && !name.is_empty()
        && name != "aliases"
    {
        *name = format!("{prefix}{name}");
    }
    parts.join("/")
}

/// The answer as the side should see it: its own collections, without the prefix.
pub fn unprefixed_answer(path: &str, body: &[u8], prefix: &str) -> Vec<u8> {
    if path.trim_end_matches('/') == "/collections"
        && let Ok(mut v) = serde_json::from_slice::<Value>(body)
    {
        if let Some(list) = v
            .pointer_mut("/result/collections")
            .and_then(Value::as_array_mut)
        {
            list.retain(|c| {
                c.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|n| n.starts_with(prefix))
            });
            for c in list.iter_mut() {
                if let Some(Value::String(n)) = c.get_mut("name") {
                    *n = n.strip_prefix(prefix).unwrap_or(n).to_string();
                }
            }
        }
        return v.to_string().into_bytes();
    }
    match std::str::from_utf8(body) {
        Ok(t) if t.contains(prefix) => t.replace(prefix, "").into_bytes(),
        _ => body.to_vec(),
    }
}

pub(super) async fn handle(
    up: Option<&Upstream>,
    shared: &Arc<Shared>,
    req: Request<hyper::body::Incoming>,
) -> Result<Response<Body>, std::io::Error> {
    let Some(up) = up else {
        return Ok(not_implemented("no Qdrant upstream"));
    };
    let now = timefmt::now_ms();
    let method = req.method().as_str().to_string();
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
    let headers: Vec<(String, Vec<u8>)> = req
        .headers()
        .iter()
        .map(|(k, v)| (k.as_str().to_ascii_lowercase(), v.as_bytes().to_vec()))
        .collect();
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(e) => return Ok(not_implemented(&e)),
    };
    {
        let mut st = shared.state();
        st.last_request = now;
        st.last_by_provider.insert("qdrant".into(), now);
        let mut recorded = headers.clone();
        for (k, v) in &mut recorded {
            if super::CREDENTIAL_HEADERS.contains(&k.as_str()) {
                *v = super::redact(v);
            }
        }
        st.calls.push(RawCall {
            at: now,
            provider: "qdrant".into(),
            host: "qdrant".into(),
            method: method.clone(),
            path: path.clone(),
            query: query.clone(),
            headers: recorded,
            body: body.clone(),
            answered: "local Qdrant".into(),
        });
    }
    let q = if query.is_empty() {
        String::new()
    } else {
        format!("?{query}")
    };
    let url = format!(
        "{}{}{q}",
        up.url.trim_end_matches('/'),
        prefixed_path(&path, &up.prefix)
    );
    let Ok(m) = reqwest::Method::from_bytes(method.as_bytes()) else {
        return Ok(not_implemented("bad method"));
    };
    let mut rb = shared
        .client
        .request(m, &url)
        .timeout(Duration::from_secs(120))
        .body(body);
    for (k, v) in &headers {
        if matches!(
            k.as_str(),
            "host"
                | "content-length"
                | "connection"
                | "transfer-encoding"
                | "api-key"
                | "authorization"
        ) {
            continue;
        }
        rb = rb.header(k.as_str(), v.as_slice());
    }
    if let Some(key) = &up.api_key {
        rb = rb.header("api-key", key.as_str());
    }
    match rb.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let ct = resp
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/json")
                .to_string();
            let bytes = resp.bytes().await.unwrap_or_default();
            Ok(full(
                status,
                &ct,
                Bytes::from(unprefixed_answer(&path, &bytes, &up.prefix)),
            ))
        }
        Err(e) => {
            shared.problem(
                "unmatched",
                format!("the local Qdrant did not answer {method} {path}: {e}"),
            );
            Ok(not_implemented("Qdrant upstream failed"))
        }
    }
}

/// Delete every collection whose name starts with `prefix`. Returns their names.
pub async fn drop_prefixed(up: &Upstream) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let with_key = |rb: reqwest::RequestBuilder| match &up.api_key {
        Some(k) => rb.header("api-key", k.as_str()),
        None => rb,
    };
    let base = up.url.trim_end_matches('/');
    let list: Value = with_key(client.get(format!("{base}/collections")))
        .send()
        .await
        .map_err(|e| format!("Qdrant: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Qdrant: {e}"))?;
    let names: Vec<String> = list
        .pointer("/result/collections")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|c| c.get("name").and_then(Value::as_str))
                .filter(|n| n.starts_with(up.prefix.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    for n in &names {
        let r = with_key(client.delete(format!("{base}/collections/{n}")))
            .send()
            .await
            .map_err(|e| format!("Qdrant delete {n}: {e}"))?;
        if !r.status().is_success() {
            return Err(format!("Qdrant delete {n}: status {}", r.status()));
        }
    }
    Ok(names)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;
    use serde_json::json;

    #[test]
    fn collection_names_get_the_prefix_and_lose_it() {
        let p = "rig_1_0_ref__";
        assert_eq!(
            prefixed_path("/collections/twitch_chat_logs/points/scroll", p),
            "/collections/rig_1_0_ref__twitch_chat_logs/points/scroll"
        );
        assert_eq!(prefixed_path("/collections", p), "/collections");
        assert_eq!(prefixed_path("/", p), "/");
        let listed = json!({"result": {"collections": [{"name": "rig_1_0_ref__a"}, {"name": "other"}, {"name": "rig_1_1_cand__a"}]}, "status": "ok"});
        let back: Value = serde_json::from_slice(&unprefixed_answer(
            "/collections",
            listed.to_string().as_bytes(),
            p,
        ))
        .unwrap();
        assert_eq!(back["result"]["collections"], json!([{"name": "a"}]));
        assert_eq!(
            unprefixed_answer(
                "/collections/x",
                b"Collection `rig_1_0_ref__x` doesn't exist!",
                p
            ),
            b"Collection `x` doesn't exist!".to_vec()
        );
    }
}

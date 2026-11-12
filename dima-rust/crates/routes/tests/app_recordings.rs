//! The application shell, the OAuth routes, the analytics proxy and the site analytics event
//! stream against the reference: every request of `app-cases.json`, recorded from the real
//! `server.ts` by `app-record.mts` (`app-reference.json`), is sent over a loopback connection to
//! the Rust app built by `dima_routes::app::application`, with the same fixtures, mocks and
//! fakes. Status, the headers clients read, the body, what the analytics service received and
//! what the area services were called with must match. Each intended difference is stated in
//! [`intended`] with its reason, checked, and counted.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod app_support;

use anyhow::{Context, Result};
use app_support::{Answer, COMPARED, harness, normalise, oauth_key, send, with_stores};
use base64::Engine as _;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::atomic::Ordering;

/// One row as both sides record it.
#[derive(Debug, Clone, PartialEq)]
struct Row {
    status: u16,
    headers: Vec<(String, String)>,
    body: Option<String>,
    body_base64: Option<String>,
    burst: Option<Value>,
    upstream: Option<Value>,
    calls: Option<Value>,
}

fn recorded(row: &Value) -> Row {
    let mut headers: Vec<(String, String)> = row["headers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pair| {
            (
                pair[0].as_str().unwrap().to_owned(),
                pair[1].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    headers.sort();
    Row {
        status: row["status"].as_u64().unwrap() as u16,
        headers,
        body: row["body"].as_str().map(str::to_owned),
        body_base64: row["body_base64"].as_str().map(str::to_owned),
        burst: row.get("burst").cloned(),
        upstream: row.get("upstream").cloned(),
        calls: row.get("calls").cloned(),
    }
}

fn observed(
    case: &Value,
    answer: &Answer,
    captured: &[(String, String)],
    burst: Option<Value>,
    upstream: Option<Value>,
    calls: Option<Value>,
) -> Row {
    let text = String::from_utf8(answer.body.clone()).ok();
    let body = text.as_deref().map(|text| normalise(text, captured));
    // A `HEAD` answer's ETag is that of a body the test does not see.
    let changed = body.as_deref() != text.as_deref() || case["volatile_etag"] == json!(true);
    let mut headers: Vec<(String, String)> = answer
        .headers
        .iter()
        .filter(|(name, _)| COMPARED.contains(&name.as_str()))
        .map(|(name, value)| {
            let value = if name == "etag" && changed {
                "$ETAG".to_owned()
            } else {
                normalise(value, captured)
            };
            (name.clone(), value)
        })
        .collect();
    headers.sort();
    let normalise_json = |value: Value| -> Value {
        serde_json::from_str(&normalise(&value.to_string(), captured)).unwrap()
    };
    Row {
        status: answer.status,
        headers,
        body_base64: match &text {
            Some(_) => None,
            None => Some(base64::engine::general_purpose::STANDARD.encode(&answer.body)),
        },
        body,
        burst,
        upstream: upstream.map(normalise_json),
        calls: calls.map(normalise_json),
    }
}

fn header<'a>(row: &'a Row, name: &str) -> Option<&'a str> {
    row.headers
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v.as_str())
}

/// The rows whose outcome differs from the reference on purpose. Each arm checks the exact
/// difference and gives the reason; the row then counts as intended.
fn intended(name: &str, reference: &Row, rust: &Row) -> Option<&'static str> {
    match name {
        "rate limit burst of one client" => {
            // The reference counts every `/oauth` request of the run in one bucket (`req.ip`
            // with proxy trust off: the proxy's address), so this client was refused after the
            // other cases' requests plus its own; here the client behind the trusted proxy has
            // a bucket of its own and is refused exactly after 600.
            assert_eq!(
                reference.burst.as_ref().unwrap()["statuses"]["429"]
                    .as_u64()
                    .map(|n| n > 1),
                Some(true)
            );
            assert_eq!(
                rust.burst,
                Some(json!({ "statuses": { "200": 600, "429": 1 }, "first_refused": 600 }))
            );
            assert_eq!((reference.status, rust.status), (429, 429));
            Some("OAuth rate limit per client address instead of one bucket for everyone")
        }
        "rate limit another client" => {
            // The second client was locked out by the first in the reference.
            assert_eq!(reference.status, 429);
            assert_eq!(reference.body.as_deref(), Some(r#"{"error":"slow_down"}"#));
            assert_eq!(rust.status, 200);
            assert!(
                rust.body
                    .as_deref()
                    .is_some_and(|b| b.starts_with(r#"{"issuer":"#))
            );
            Some("another client is not locked out by the first one's requests")
        }
        "preflight under cors"
        | "preflight without request headers"
        | "options without origin"
        | "preflight of the metadata route"
        | "proxy preflight" => {
            // The `cors` package sets `Content-Length: 0` on its 204; HTTP forbids a
            // `Content-Length` on 204 (RFC 9110 section 8.6) and hyper never sends one. Browsers
            // ignore it on a 204; nothing else differs.
            let without = |row: &Row| {
                let mut row = row.clone();
                row.headers.retain(|(name, _)| name != "content-length");
                row
            };
            assert_eq!(header(reference, "content-length"), Some("0"));
            assert_eq!(header(rust, "content-length"), None);
            assert_eq!(without(reference), *rust);
            Some("no Content-Length on a 204 (hyper, RFC 9110)")
        }
        "content-length beyond the limit, nothing sent" => {
            // A request announcing a body beyond the limit whose client then closes its side
            // without sending it: Node's HTTP parser answered a bare `400` (the request was cut
            // short) before body-parser's 413 went out; here the announced length is refused
            // at once with the parser's 413 page. A malformed request: no client depends on it.
            assert_eq!((reference.status, rust.status), (400, 413));
            assert_eq!(reference.body.as_deref(), Some(""));
            assert!(
                rust.body
                    .as_deref()
                    .is_some_and(|b| b.contains("Payload Too Large"))
            );
            Some("an announced body beyond the limit is 413 even when the client stops sending")
        }
        _ => None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_shell_and_the_oauth_routes_match_the_reference() -> Result<()> {
    let cases: Value = serde_json::from_str(include_str!("app-cases.json"))?;
    let reference: Value = serde_json::from_str(include_str!("app-reference.json"))?;
    check_drift(&reference)?;
    with_stores(|stores| async move {
        let client = cases["users"][0]["twitch_id"].as_str().context("user")?;
        let mut buckets = vec![
            "oauth:127.0.0.1".to_owned(),
            "desktop:127.0.0.1".to_owned(),
            format!("approval:{client}"),
            "oauth:198.51.100.1".to_owned(),
            "oauth:198.51.100.2".to_owned(),
        ];
        let keys: Vec<String> = buckets.drain(..).map(|b| oauth_key("rate", &b)).collect();
        for key in &keys {
            stores.cache.del(&[key]).await?;
            stores.track(key.clone());
        }
        let h = harness(stores.clone(), cases.clone()).await?;
        let mut captured: Vec<(String, String)> = Vec::new();
        let mut mismatches = Vec::new();
        let mut differences: BTreeMap<&'static str, Vec<String>> = BTreeMap::new();
        let mut key_order_only = Vec::new();
        let rows = reference["rows"].as_array().context("rows")?;
        assert_eq!(rows.len(), cases["cases"].as_array().unwrap().len());
        for (case, row) in cases["cases"].as_array().unwrap().iter().zip(rows) {
            let name = case["name"].as_str().unwrap();
            assert_eq!(row["name"], case["name"]);
            h.fakes
                .snapshot_fails
                .store(case["snapshot"] == json!("fail"), Ordering::SeqCst);
            h.fakes.calls.take();
            let before = h.analytics.requests().len();
            let snapshot = captured.clone();
            let subst = move |text: &str| -> String {
                let mut out = text.to_owned();
                let mut sorted = snapshot.clone();
                sorted.sort_by_key(|pair| std::cmp::Reverse(pair.0.len()));
                for (name, value) in &sorted {
                    out = out.replace(&format!("${name}"), value);
                }
                out
            };
            let repeat = case["repeat"].as_u64().unwrap_or(1);
            let mut statuses: BTreeMap<String, u64> = BTreeMap::new();
            let mut first_refused: Option<u64> = None;
            let mut answer = None;
            for index in 0..repeat {
                let got = send(h.port, case, &subst).await?;
                *statuses.entry(got.status.to_string()).or_default() += 1;
                if got.status == 429 && first_refused.is_none() {
                    first_refused = Some(index);
                }
                answer = Some(got);
            }
            let answer = answer.context("answer")?;
            capture(case, &answer, &mut captured)?;
            let burst = (repeat > 1).then(|| json!({ "statuses": statuses, "first_refused": first_refused }));
            let upstream = (case["upstream"] == json!(true)).then(|| {
                Value::Array(
                    h.analytics.requests()[before..]
                        .iter()
                        .map(|request| {
                            json!({
                                "method": request.method,
                                "target": request.target,
                                "authorization": request.header("authorization"),
                                "content_type": request.header("content-type"),
                                "body": request.body_text(),
                                "cookie": request.header("cookie"),
                                "forwarded_for": request.header("x-forwarded-for"),
                            })
                        })
                        .collect(),
                )
            });
            let calls = (case["area"] == json!(true)).then(|| Value::Array(h.fakes.calls.take()));
            let mut rust = observed(case, &answer, &captured, burst, upstream, calls);
            let mut expected = recorded(row);
            // Clients parse JSON bodies: a different key order is not a difference (and only
            // changes the weak ETag computed from the bytes).
            if rust.body != expected.body
                && let (Some(a), Some(b)) = (&rust.body, &expected.body)
                && let (Ok(a), Ok(b)) = (serde_json::from_str::<Value>(a), serde_json::from_str::<Value>(b))
                && a == b
            {
                key_order_only.push(name.to_owned());
                rust.body = expected.body.clone();
                rust.headers.retain(|(n, _)| n != "etag");
                expected.headers.retain(|(n, _)| n != "etag");
            }
            if rust == expected {
                continue;
            }
            match intended(name, &expected, &rust) {
                Some(reason) => differences.entry(reason).or_default().push(name.to_owned()),
                None => mismatches.push(format!(
                    "{name}\n  reference: {expected:?}\n  rust:      {rust:?}\n  reference etag {:?} rust etag {:?}",
                    header(&expected, "etag"),
                    header(&rust, "etag")
                )),
            }
        }
        for (name, value) in &captured {
            for kind in ["request", "code", "access"] {
                h.stores.track(oauth_key(kind, value));
            }
            let _ = name;
        }
        assert!(mismatches.is_empty(), "{} rows differ:\n{}", mismatches.len(), mismatches.join("\n"));
        let counted: usize = differences.values().map(Vec::len).sum();
        eprintln!(
            "{} rows; {counted} intended differences {differences:?}; key order only: {key_order_only:?}",
            rows.len()
        );
        assert_eq!(counted, 8, "{differences:?}");
        Ok(())
    })
    .await
}

fn capture(case: &Value, answer: &Answer, captured: &mut Vec<(String, String)>) -> Result<()> {
    for rule in case["capture"].as_array().into_iter().flatten() {
        let from = rule["from"].as_str().context("from")?;
        let mut text = match from.strip_prefix("header:") {
            Some(name) => answer.header(name).map(str::to_owned),
            None => {
                let body: Value = serde_json::from_slice(&answer.body)?;
                body.pointer(rule["pointer"].as_str().context("pointer")?)
                    .map(|value| match value {
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    })
            }
        };
        if let (Some(found), Some(pattern)) = (&text, rule["pattern"].as_str()) {
            text = regex::Regex::new(pattern)?
                .captures(found)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().to_owned());
        }
        let name = rule["as"].as_str().context("as")?;
        let text =
            text.with_context(|| format!("{}: nothing to capture as {name}", case["name"]))?;
        captured.retain(|(n, _)| n != name);
        captured.push((name.to_owned(), text));
    }
    Ok(())
}

/// Fails when a reference file changed since the recording.
fn check_drift(recording: &Value) -> Result<()> {
    for (file, digest) in recording["sha256"].as_object().context("sha256")? {
        let path = format!("{}/../../../dimabot/{file}", env!("CARGO_MANIFEST_DIR"));
        let bytes = std::fs::read(&path).with_context(|| path.clone())?;
        anyhow::ensure!(
            dima_core::crypto::digest::sha256(bytes).hex() == digest.as_str().unwrap_or_default(),
            "{file} changed since the recording: run app-record.mts again"
        );
    }
    Ok(())
}

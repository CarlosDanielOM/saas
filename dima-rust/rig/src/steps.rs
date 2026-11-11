//! Running a scenario's steps against one side.

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::Value;

use crate::capture::{RawHttp, RawStep};
use crate::path::Seg as PSeg;
use crate::scenario::{self, ReqBody, SaveFrom, Step, StepKind, WaitCond};
use crate::side::SideProcess;
use crate::stores::SideStores;
use crate::template;
use crate::timefmt;

/// Largest response body the rig reads.
pub const MAX_BODY: usize = 32 * 1024 * 1024;
const POLL: Duration = Duration::from_millis(20);

#[derive(Debug)]
pub struct StepError {
    pub step: usize,
    pub message: String,
}

pub struct Runner<'a> {
    pub stores: &'a mut SideStores,
    pub proc: &'a mut SideProcess,
    pub http: &'a reqwest::Client,
    pub saved: BTreeMap<String, String>,
}

fn err(step: usize, message: impl Into<String>) -> StepError {
    StepError {
        step,
        message: message.into(),
    }
}

fn save_value(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

impl Runner<'_> {
    fn alive(&mut self, step: usize, during: &str) -> Result<(), StepError> {
        self.proc
            .check_alive()
            .map_err(|why| err(step, format!("{why} {during}")))
    }

    async fn sleep_watching(&mut self, step: usize, ms: u64) -> Result<(), StepError> {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(ms);
        while tokio::time::Instant::now() < deadline {
            self.alive(step, "during a pause")?;
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            tokio::time::sleep(left.min(Duration::from_millis(100))).await;
        }
        Ok(())
    }

    async fn http(&mut self, i: usize, h: &scenario::HttpStep) -> Result<RawStep, StepError> {
        let now = timefmt::now_ms();
        let fill = |s: &str| template::interpolate(s, &self.saved, now).map_err(|e| err(i, e));
        let port_name = h
            .port
            .clone()
            .unwrap_or_else(|| self.proc.ports.keys().next().cloned().unwrap_or_default());
        let port = self
            .proc
            .port(&port_name)
            .ok_or_else(|| err(i, format!("no port named `{port_name}` in the target")))?;
        let url = format!("http://127.0.0.1:{port}{}", fill(&h.path)?);
        let method =
            reqwest::Method::from_bytes(h.method.as_bytes()).map_err(|e| err(i, e.to_string()))?;
        let mut req = self
            .http
            .request(method, &url)
            .timeout(Duration::from_millis(h.timeout_ms));
        let mut has_ct = false;
        for (k, v) in &h.headers {
            has_ct |= k == "content-type";
            req = req.header(k.as_str(), fill(v)?);
        }
        let (body, ct): (Option<Vec<u8>>, Option<&str>) = match &h.body {
            ReqBody::None => (None, None),
            ReqBody::Json(v) => {
                let resolved =
                    scenario::resolve_json(v, &self.saved, now, "json").map_err(|e| err(i, e))?;
                (
                    Some(serde_json::to_vec(&resolved).map_err(|e| err(i, e.to_string()))?),
                    Some("application/json"),
                )
            }
            ReqBody::Form(pairs) => {
                let mut ser = Vec::new();
                for (k, v) in pairs {
                    ser.push((fill(k)?, fill(v)?));
                }
                let encoded: Vec<String> = ser
                    .iter()
                    .map(|(k, v)| format!("{}={}", form_encode(k), form_encode(v)))
                    .collect();
                (
                    Some(encoded.join("&").into_bytes()),
                    Some("application/x-www-form-urlencoded"),
                )
            }
            ReqBody::Text(t) => (Some(fill(t)?.into_bytes()), None),
            ReqBody::Bytes(b) => (Some(b.clone()), None),
        };
        if let (Some(ct), false) = (ct, has_ct) {
            req = req.header("content-type", ct);
        }
        if let Some(b) = body {
            req = req.body(b);
        }
        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                // A process that dies mid-request closes the connection before it is reaped.
                for _ in 0..50 {
                    self.alive(i, "while handling the request")?;
                    tokio::time::sleep(POLL).await;
                }
                return Err(err(
                    i,
                    format!("{} {}: request failed: {e}", h.method, h.path),
                ));
            }
        };
        let status = resp.status().as_u16();
        let headers: Vec<(String, String)> = resp
            .headers()
            .iter()
            .map(|(k, v)| {
                (
                    k.as_str().to_ascii_lowercase(),
                    v.to_str().map_or_else(
                        |_| String::from_utf8_lossy(v.as_bytes()).to_string(),
                        str::to_string,
                    ),
                )
            })
            .collect();
        let mut resp = resp;
        let mut body = Vec::new();
        loop {
            match resp.chunk().await {
                Ok(Some(c)) => {
                    body.extend_from_slice(&c);
                    if body.len() > MAX_BODY {
                        return Err(err(
                            i,
                            format!("response body larger than {MAX_BODY} bytes"),
                        ));
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    self.alive(i, "while sending the response")?;
                    return Err(err(i, format!("reading the response failed: {e}")));
                }
            }
        }
        if let Some(want) = &h.expect_status
            && !want.contains(&status)
        {
            let preview = crate::value::cut(&String::from_utf8_lossy(&body), 300);
            return Err(err(
                i,
                format!(
                    "expected status {want:?} for {} {}, got {status}: {preview}",
                    h.method, h.path
                ),
            ));
        }
        for (name, from) in &h.save {
            let v = match from {
                SaveFrom::Status => Some(status.to_string()),
                SaveFrom::Header(n) => headers.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone()),
                SaveFrom::Body(segs) => {
                    serde_json::from_slice::<Value>(&body)
                        .ok()
                        .and_then(|root| {
                            let mut cur = &root;
                            for s in segs {
                                cur = match s {
                                    PSeg::Key(k) => cur.get(k)?,
                                    PSeg::Index(n) => cur.get(*n)?,
                                };
                            }
                            Some(save_value(cur))
                        })
                }
            };
            match v {
                Some(v) => {
                    self.saved.insert(name.clone(), v);
                }
                None => {
                    return Err(err(
                        i,
                        format!("could not save `{name}`: the response has no such value"),
                    ));
                }
            }
        }
        Ok(RawStep::Http(RawHttp {
            status,
            headers,
            body,
        }))
    }

    async fn wait_for(
        &mut self,
        i: usize,
        cond: &WaitCond,
        timeout_ms: u64,
    ) -> Result<(), StepError> {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        let now = timefmt::now_ms();
        let filter = match cond {
            WaitCond::Mongo { filter, .. } => Some(
                scenario::resolve_filter(filter, &self.saved, now, "wait_for.mongo.filter")
                    .map_err(|e| err(i, e))?,
            ),
            WaitCond::Key(_) => None,
        };
        let key = match cond {
            WaitCond::Key(k) => {
                Some(template::interpolate(k, &self.saved, now).map_err(|e| err(i, e))?)
            }
            WaitCond::Mongo { .. } => None,
        };
        loop {
            self.alive(i, "while waiting")?;
            let done = match (cond, &filter, &key) {
                (
                    WaitCond::Mongo {
                        collection, count, ..
                    },
                    Some(f),
                    _,
                ) => {
                    let n = self
                        .stores
                        .count(collection, f.clone())
                        .await
                        .map_err(|e| err(i, e.to_string()))?;
                    n >= count.unwrap_or(1)
                }
                (_, _, Some(k)) => self
                    .stores
                    .key_exists(k)
                    .await
                    .map_err(|e| err(i, e.to_string()))?,
                _ => true,
            };
            if done {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                let what = match (cond, &key) {
                    (
                        WaitCond::Mongo {
                            collection,
                            count,
                            filter,
                        },
                        _,
                    ) => {
                        format!(
                            "{} document(s) in {collection} matching {filter}",
                            count.unwrap_or(1)
                        )
                    }
                    (_, Some(k)) => format!("key {k}"),
                    _ => String::new(),
                };
                return Err(err(
                    i,
                    format!("wait_for timed out after {timeout_ms} ms waiting for {what}"),
                ));
            }
            tokio::time::sleep(POLL).await;
        }
    }

    async fn wait_quiet(&mut self, i: usize, q: &scenario::WaitQuiet) -> Result<(), StepError> {
        let start = tokio::time::Instant::now();
        let deadline = start + Duration::from_millis(q.timeout_ms);
        let quiet = Duration::from_millis(q.quiet_ms);
        let mut last = None;
        let mut since = start;
        loop {
            self.alive(i, "while waiting for quiet")?;
            let fp = self
                .stores
                .fingerprint(&q.ignore_keys, &q.ignore_collections)
                .await
                .map_err(|e| err(i, e.to_string()))?;
            let t = tokio::time::Instant::now();
            if last != Some(fp) {
                last = Some(fp);
                since = t;
            } else if t.duration_since(since) >= quiet {
                return Ok(());
            }
            if t >= deadline {
                return Err(err(
                    i,
                    format!(
                        "wait_quiet: the stores kept changing for {} ms (quiet_ms {}); list changing keys in ignore_keys or collections in ignore_collections",
                        q.timeout_ms, q.quiet_ms
                    ),
                ));
            }
            tokio::time::sleep(POLL).await;
        }
    }

    pub async fn run(&mut self, steps: &[Step]) -> Result<Vec<RawStep>, StepError> {
        let mut out = Vec::with_capacity(steps.len());
        for (i, s) in steps.iter().enumerate() {
            self.alive(i, "before the step")?;
            let r = match &s.kind {
                StepKind::Http(h) => self.http(i, h).await?,
                StepKind::Dragonfly(args) => {
                    let now = timefmt::now_ms();
                    let rendered = args
                        .iter()
                        .map(|a| a.render(&self.saved, now))
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|e| err(i, e))?;
                    RawStep::Reply(
                        self.stores
                            .command(&rendered)
                            .await
                            .map_err(|e| err(i, e.to_string()))?,
                    )
                }
                StepKind::Pause(ms) => {
                    self.sleep_watching(i, *ms).await?;
                    RawStep::Done("pause_ms".into())
                }
                StepKind::WaitFor { cond, timeout_ms } => {
                    self.wait_for(i, cond, *timeout_ms).await?;
                    RawStep::Done("wait_for".into())
                }
                StepKind::WaitQuiet(q) => {
                    self.wait_quiet(i, q).await?;
                    RawStep::Done("wait_quiet".into())
                }
            };
            self.alive(i, "during the step")?;
            out.push(r);
        }
        Ok(out)
    }
}

fn form_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(char::from(b))
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn form_encoding_matches_url_search_params() {
        assert_eq!(super::form_encode("a b&c=ñ"), "a+b%26c%3D%C3%B1");
    }
}

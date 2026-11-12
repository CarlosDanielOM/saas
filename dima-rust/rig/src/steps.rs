//! Running a scenario's steps against one side.

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::Value;

use crate::capture::{RawHttp, RawReplyStep, RawStep};
use crate::mock::Mock;
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

/// Where a kind of signed webhook goes for this side (rendered from the target).
#[derive(Debug, Clone)]
pub struct HookTarget {
    pub secret: String,
    pub port: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, Default)]
pub struct Hooks {
    pub eventsub: Option<HookTarget>,
    pub polar: Option<HookTarget>,
}

pub struct Runner<'a> {
    pub observe_times: bool,
    pub started_at: Option<i64>,
    pub scan_pages: BTreeMap<usize, Vec<RawStep>>,
    pub step_ends: Vec<i64>,
    pub mongo_selection: &'a scenario::Selection,
    pub dragonfly_selection: &'a scenario::Selection,
    pub time_anchors: BTreeMap<i64, (usize, i64)>,
    pub ttl_origins: BTreeMap<Vec<u8>, (i64, (usize, i64))>,
    pub stores: &'a mut SideStores,
    pub proc: &'a mut SideProcess,
    pub http: &'a reqwest::Client,
    pub saved: BTreeMap<String, String>,
    /// The scenario's `allow_scripts`.
    pub allow_scripts: bool,
    pub mock: &'a Mock,
    pub hooks: &'a Hooks,
    /// Side values usable in step strings: `${port.http}`, `${mongo_db}`, ...
    pub side_values: BTreeMap<String, String>,
}

/// A request the rig sends to the side, and what it does with the answer.
struct Exchange<'e> {
    method: &'e str,
    port: Option<&'e str>,
    path: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
    timeout_ms: u64,
    expect_status: Option<&'e [u16]>,
    save: &'e [(String, SaveFrom)],
}

/// A Twitch timestamp: RFC 3339 with nanoseconds.
fn twitch_time(ms: i64) -> String {
    let iso = timefmt::format_iso_ms(ms).unwrap_or_default();
    match iso.strip_suffix('Z') {
        Some(base) => format!("{base}000000Z"),
        None => iso,
    }
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

    fn fill(&self, i: usize, s: &str, now: i64) -> Result<String, StepError> {
        let mut all = self.side_values.clone();
        all.extend(self.saved.iter().map(|(k, v)| (k.clone(), v.clone())));
        template::interpolate(s, &all, now).map_err(|e| err(i, e))
    }

    fn values(&self) -> BTreeMap<String, String> {
        let mut all = self.side_values.clone();
        all.extend(self.saved.iter().map(|(k, v)| (k.clone(), v.clone())));
        all
    }

    async fn http(&mut self, i: usize, h: &scenario::HttpStep) -> Result<RawStep, StepError> {
        let Some(scan) = &h.scan else {
            return self.http_one(i, h, None).await;
        };
        let path = self.fill(i, &h.path, timefmt::now_ms())?;
        let mut url =
            reqwest::Url::parse(&format!("http://rig{path}")).map_err(|e| err(i, e.to_string()))?;
        let mut page = h.clone();
        page.scan = None;
        let started = tokio::time::Instant::now();
        let mut union = BTreeMap::new();
        let mut cursors = std::collections::BTreeSet::new();
        let mut first: Option<RawHttp> = None;
        let mut envelope = None;
        let mut bytes = 0usize;
        for _ in 0..scan.max_pages {
            page.path = format!(
                "{}{}",
                url.path(),
                url.query().map(|q| format!("?{q}")).unwrap_or_default()
            );
            page.timeout_ms = h
                .timeout_ms
                .saturating_sub(u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX));
            if page.timeout_ms == 0 {
                return Err(err(i, "scan exceeded the step timeout"));
            }
            let response = self.http_one(i, &page, Some(&page.path)).await?;
            let RawStep::Http(ref raw) = response else {
                return Err(err(i, "scan expected HTTP"));
            };
            if !(200..300).contains(&raw.status) {
                return Err(err(i, format!("scan page returned HTTP {}", raw.status)));
            }
            bytes += raw.body.len();
            if bytes > 32 * 1024 * 1024 {
                return Err(err(i, "scan pages exceed 32 MiB"));
            }
            let mut body: Value = serde_json::from_slice(&raw.body)
                .map_err(|e| err(i, format!("scan page JSON: {e}")))?;
            // An aggregate has one read clock. Translate later pages' remaining-second
            // TTLs back to that clock while preserving their exact raw page bytes.
            if let Some(ttl) = &scan.ttl {
                let offset = first
                    .as_ref()
                    .map_or(0, |first| (raw.at - first.at).max(0) / 1000);
                let items = body
                    .pointer_mut(&scan.items)
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| err(i, "scan TTL translation requires the items array"))?;
                for item in items {
                    let value = item
                        .pointer_mut(ttl)
                        .ok_or_else(|| err(i, format!("scan item missing TTL at {ttl}")))?;
                    let remaining = value
                        .as_i64()
                        .ok_or_else(|| err(i, "scan TTL must be integer seconds"))?;
                    if remaining >= 0 {
                        *value = Value::from(remaining.saturating_add(offset));
                    }
                }
            }
            let cursor = scan.page(&body, &mut union).map_err(|e| err(i, e))?;
            if first
                .as_ref()
                .is_some_and(|first| first.status != raw.status)
            {
                return Err(err(i, "scan page HTTP status changed"));
            }
            let mut rest = body.clone();
            if let Some(v) = rest.pointer_mut(&scan.cursor) {
                *v = Value::Null;
            }
            if let Some(v) = rest.pointer_mut(&scan.items) {
                *v = Value::Null;
            }
            if envelope.as_ref().is_some_and(|first| first != &rest) {
                return Err(err(i, "scan page envelope changed outside cursor/items"));
            }
            envelope = Some(rest);
            if first.is_none() {
                first = Some(raw.clone());
            }
            self.scan_pages.entry(i).or_default().push(response);
            if cursor == "0" {
                let mut raw = first.ok_or_else(|| err(i, "scan has no first page"))?;
                let mut body: Value =
                    serde_json::from_slice(&raw.body).map_err(|e| err(i, e.to_string()))?;
                *body
                    .pointer_mut(&scan.items)
                    .ok_or_else(|| err(i, "scan items pointer disappeared"))? =
                    Value::Array(union.into_values().collect());
                *body
                    .pointer_mut(&scan.cursor)
                    .ok_or_else(|| err(i, "scan cursor pointer disappeared"))? =
                    Value::String("0".into());
                raw.body = serde_json::to_vec(&body).map_err(|e| err(i, e.to_string()))?;
                return Ok(RawStep::Http(raw));
            }
            if !cursors.insert(cursor.clone()) {
                return Err(err(
                    i,
                    format!("scan repeated cursor {cursor:?} before zero"),
                ));
            }
            let params: Vec<(String, String)> = url
                .query_pairs()
                .filter(|(k, _)| k != &scan.query)
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            url.set_query(None);
            url.query_pairs_mut()
                .extend_pairs(params)
                .append_pair(&scan.query, &cursor);
        }
        Err(err(
            i,
            format!("scan did not reach zero within {} pages", scan.max_pages),
        ))
    }

    async fn http_one(
        &mut self,
        i: usize,
        h: &scenario::HttpStep,
        resolved_path: Option<&str>,
    ) -> Result<RawStep, StepError> {
        let now = timefmt::now_ms();
        let mut headers = Vec::new();
        for (k, v) in &h.headers {
            headers.push((k.clone(), self.fill(i, v, now)?));
        }
        let values = self.values();
        let (body, ct): (Option<Vec<u8>>, Option<&str>) = match &h.body {
            ReqBody::None => (None, None),
            ReqBody::Json(v) => {
                let resolved =
                    scenario::resolve_json(v, &values, now, "json").map_err(|e| err(i, e))?;
                (
                    Some(serde_json::to_vec(&resolved).map_err(|e| err(i, e.to_string()))?),
                    Some("application/json"),
                )
            }
            ReqBody::Form(pairs) => {
                let mut ser = Vec::new();
                for (k, v) in pairs {
                    ser.push((self.fill(i, k, now)?, self.fill(i, v, now)?));
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
            ReqBody::Text(t) => (Some(self.fill(i, t, now)?.into_bytes()), None),
            ReqBody::Bytes(b) => (Some(b.clone()), None),
        };
        if let Some(ct) = ct
            && !headers.iter().any(|(k, _)| k == "content-type")
        {
            headers.push(("content-type".into(), ct.into()));
        }
        let path = match resolved_path {
            Some(path) => path.to_string(),
            None => self.fill(i, &h.path, now)?,
        };
        self.exchange(
            i,
            Exchange {
                method: &h.method,
                port: h.port.as_deref(),
                path,
                headers,
                body,
                timeout_ms: h.timeout_ms,
                expect_status: h.expect_status.as_deref(),
                save: &h.save,
            },
        )
        .await
    }

    async fn exchange(&mut self, i: usize, x: Exchange<'_>) -> Result<RawStep, StepError> {
        let port_name = x
            .port
            .map_or_else(|| self.proc.primary_port.clone(), str::to_string);
        let port = self
            .proc
            .port(&port_name)
            .ok_or_else(|| err(i, format!("no port named `{port_name}` in the target")))?;
        let url = format!("http://127.0.0.1:{port}{}", x.path);
        let method =
            reqwest::Method::from_bytes(x.method.as_bytes()).map_err(|e| err(i, e.to_string()))?;
        let mut req = self
            .http
            .request(method, &url)
            .timeout(Duration::from_millis(x.timeout_ms));
        for (k, v) in &x.headers {
            req = req.header(k.as_str(), v.as_str());
        }
        if let Some(b) = x.body {
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
                    format!("{} {}: request failed: {e}", x.method, x.path),
                ));
            }
        };
        let status = resp.status().as_u16();
        let headers: Vec<(String, Vec<u8>)> = resp
            .headers()
            .iter()
            .map(|(k, v)| (k.as_str().to_ascii_lowercase(), v.as_bytes().to_vec()))
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
        if let Some(want) = x.expect_status
            && !want.contains(&status)
        {
            let preview = crate::value::cut(&String::from_utf8_lossy(&body), 300);
            return Err(err(
                i,
                format!(
                    "expected status {want:?} for {} {}, got {status}: {preview}",
                    x.method, x.path
                ),
            ));
        }
        for (name, from) in x.save {
            let v = match from {
                SaveFrom::Status => Some(status.to_string()),
                SaveFrom::Header(n) => headers
                    .iter()
                    .find(|(k, _)| k == n)
                    .map(|(_, v)| String::from_utf8_lossy(v).to_string()),
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
            at: timefmt::now_ms(),
            status,
            headers,
            body,
        }))
    }

    /// The body, headers and target of a signed delivery, after `raw` and the overrides.
    fn delivery_headers(
        &self,
        i: usize,
        d: &scenario::Delivery,
        mut headers: Vec<(String, String)>,
        now: i64,
    ) -> Result<Vec<(String, String)>, StepError> {
        for (k, v) in &d.headers {
            headers.retain(|(n, _)| n != k);
            if let Some(v) = v {
                headers.push((k.clone(), self.fill(i, v, now)?));
            }
        }
        Ok(headers)
    }

    fn delivery_body(
        &self,
        i: usize,
        d: &scenario::Delivery,
        built: Value,
        now: i64,
    ) -> Result<Vec<u8>, StepError> {
        match &d.raw {
            Some(Value::String(t)) => Ok(self.fill(i, t, now)?.into_bytes()),
            Some(v) => {
                let r =
                    scenario::resolve_json(v, &self.values(), now, "raw").map_err(|e| err(i, e))?;
                serde_json::to_vec(&r).map_err(|e| err(i, e.to_string()))
            }
            None => serde_json::to_vec(&built).map_err(|e| err(i, e.to_string())),
        }
    }

    async fn eventsub(
        &mut self,
        i: usize,
        e: &scenario::EventsubStep,
    ) -> Result<RawStep, StepError> {
        let Some(hook) = self.hooks.eventsub.clone() else {
            return Err(err(
                i,
                "the target has no webhooks.eventsub (secret, port, path)",
            ));
        };
        let now = timefmt::now_ms();
        let values = self.values();
        let resolve = |v: &Value, what: &str| {
            scenario::resolve_json(v, &values, now, what).map_err(|e| err(i, e))
        };
        let condition = resolve(&e.condition, "condition")?;
        let event = resolve(&e.event, "event")?;
        let timestamp = match &e.timestamp {
            None => twitch_time(now),
            Some(v) => match resolve(v, "timestamp")? {
                Value::String(s) => s,
                other => other.to_string(),
            },
        };
        let message_id = self.fill(i, &e.message_id, now)?;
        let mut sub = serde_json::Map::new();
        sub.insert(
            "id".into(),
            Value::String(crate::mock::handlers::uuid_from(
                format!("{}|{}|{condition}", e.sub_type, e.version).as_bytes(),
            )),
        );
        let status = match e.message_type.as_str() {
            "webhook_callback_verification" => "webhook_callback_verification_pending",
            "revocation" => "authorization_revoked",
            _ => "enabled",
        };
        sub.insert("status".into(), Value::String(status.into()));
        sub.insert("type".into(), Value::String(e.sub_type.clone()));
        sub.insert("version".into(), Value::String(e.version.clone()));
        sub.insert("cost".into(), Value::from(0));
        sub.insert("condition".into(), condition);
        sub.insert(
            "transport".into(),
            serde_json::json!({"method": "webhook", "callback": "https://subscriptions.domdimabot.com/eventsub"}),
        );
        sub.insert(
            "created_at".into(),
            Value::String("2026-01-01T00:00:00.000000000Z".into()),
        );
        if let Some(over) = &e.subscription
            && let Value::Object(m) = resolve(over, "subscription")?
        {
            for (k, v) in m {
                sub.insert(k, v);
            }
        }
        let mut built = serde_json::Map::new();
        match e.message_type.as_str() {
            "webhook_callback_verification" => {
                built.insert("challenge".into(), Value::String(e.challenge.clone()));
                built.insert("subscription".into(), Value::Object(sub));
            }
            "revocation" => {
                built.insert("subscription".into(), Value::Object(sub));
            }
            _ => {
                built.insert("subscription".into(), Value::Object(sub));
                built.insert("event".into(), event);
            }
        }
        let body = self.delivery_body(i, &e.delivery, Value::Object(built), now)?;
        let secret = match &e.delivery.secret {
            Some(s) => self.fill(i, s, now)?,
            None => hook.secret.clone(),
        };
        let signature = match &e.delivery.signature {
            Some(s) => self.fill(i, s, now)?,
            None => dima_core::crypto::webhook::eventsub_signature(
                &dima_core::SecretBytes::from_text(&secret),
                &message_id,
                &timestamp,
                &body,
            ),
        };
        let headers = vec![
            ("content-type".to_string(), "application/json".to_string()),
            ("twitch-eventsub-message-id".into(), message_id),
            ("twitch-eventsub-message-retry".into(), e.retry.to_string()),
            (
                "twitch-eventsub-message-type".into(),
                e.message_type.clone(),
            ),
            ("twitch-eventsub-message-signature".into(), signature),
            ("twitch-eventsub-message-timestamp".into(), timestamp),
            (
                "twitch-eventsub-subscription-type".into(),
                e.sub_type.clone(),
            ),
            (
                "twitch-eventsub-subscription-version".into(),
                e.version.clone(),
            ),
            ("user-agent".into(), "Twitch-Eventsub-Webhooks/1.0".into()),
        ];
        let headers = self.delivery_headers(i, &e.delivery, headers, now)?;
        let path = match &e.delivery.path {
            Some(p) => self.fill(i, p, now)?,
            None => hook.path.clone(),
        };
        let port = e.delivery.port.clone().or(hook.port.clone());
        self.exchange(
            i,
            Exchange {
                method: "POST",
                port: port.as_deref(),
                path,
                headers,
                body: Some(body),
                timeout_ms: e.delivery.timeout_ms,
                expect_status: e.delivery.expect_status.as_deref(),
                save: &e.delivery.save,
            },
        )
        .await
    }

    async fn polar(&mut self, i: usize, p: &scenario::PolarStep) -> Result<RawStep, StepError> {
        let Some(hook) = self.hooks.polar.clone() else {
            return Err(err(
                i,
                "the target has no webhooks.polar (secret, port, path)",
            ));
        };
        let now = timefmt::now_ms();
        let values = self.values();
        let data = scenario::resolve_json(&p.data, &values, now, "data").map_err(|e| err(i, e))?;
        let ts_secs = match &p.timestamp_s {
            None => now.div_euclid(1000),
            Some(v) => {
                let r = scenario::resolve_json(v, &values, now, "timestamp_s")
                    .map_err(|e| err(i, e))?;
                r.as_i64()
                    .or_else(|| r.as_str().and_then(|s| s.parse().ok()))
                    .ok_or_else(|| err(i, "timestamp_s: epoch seconds"))?
            }
        };
        let mut built = serde_json::Map::new();
        built.insert("type".into(), Value::String(p.event_type.clone()));
        built.insert(
            "timestamp".into(),
            Value::String(timefmt::format_iso_ms(now).unwrap_or_default()),
        );
        built.insert("data".into(), data);
        let body = self.delivery_body(i, &p.delivery, Value::Object(built), now)?;
        let id = self.fill(i, &p.id, now)?;
        let secret = match &p.delivery.secret {
            Some(s) => self.fill(i, s, now)?,
            None => hook.secret.clone(),
        };
        let signature = match &p.delivery.signature {
            Some(s) => self.fill(i, s, now)?,
            None => match dima_core::crypto::webhook::PolarWebhook::new(&secret) {
                Some(w) => w.sign(&id, ts_secs, &body),
                None => String::new(),
            },
        };
        let headers = vec![
            ("content-type".to_string(), "application/json".to_string()),
            ("webhook-id".into(), id),
            ("webhook-timestamp".into(), ts_secs.to_string()),
            ("webhook-signature".into(), signature),
            ("user-agent".into(), "Svix-Webhooks/1.0".into()),
        ];
        let headers = self.delivery_headers(i, &p.delivery, headers, now)?;
        let path = match &p.delivery.path {
            Some(x) => self.fill(i, x, now)?,
            None => hook.path.clone(),
        };
        let port = p.delivery.port.clone().or(hook.port.clone());
        self.exchange(
            i,
            Exchange {
                method: "POST",
                port: port.as_deref(),
                path,
                headers,
                body: Some(body),
                timeout_ms: p.delivery.timeout_ms,
                expect_status: p.delivery.expect_status.as_deref(),
                save: &p.delivery.save,
            },
        )
        .await
    }

    /// Wait until the mock has recorded `count` calls that match.
    async fn wait_call(
        &mut self,
        i: usize,
        c: &scenario::CallCond,
        timeout_ms: u64,
    ) -> Result<(), StepError> {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            self.alive(i, "while waiting for a call")?;
            let n = self.mock.count(|call| {
                if c.provider.as_ref().is_some_and(|p| p != &call.provider) {
                    return false;
                }
                let query = crate::mock::parse_query(&call.query);
                let (plain, json) = crate::mock::decode_body(&call.headers, &call.body);
                let text = std::str::from_utf8(&plain).ok();
                let mut caps = BTreeMap::new();
                c.route.matches(
                    &call.host,
                    &crate::mock::route::Incoming {
                        method: &call.method,
                        path: &call.path,
                        query: &query,
                        headers: &call.headers,
                        json: json.as_ref(),
                        text,
                    },
                    &mut caps,
                )
            });
            if u64::try_from(n).unwrap_or(u64::MAX) >= c.count {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                let seen: Vec<String> = self
                    .mock
                    .calls()
                    .iter()
                    .rev()
                    .take(8)
                    .map(|x| format!("{} {}{}", x.method, x.host, x.path))
                    .collect();
                return Err(err(
                    i,
                    format!(
                        "wait_call timed out after {timeout_ms} ms waiting for {} call(s) {}; saw {n}; latest calls: {}",
                        c.count,
                        c.text,
                        if seen.is_empty() {
                            "none".to_string()
                        } else {
                            seen.join(", ")
                        }
                    ),
                ));
            }
            tokio::time::sleep(POLL).await;
        }
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
                scenario::resolve_filter(filter, &self.values(), now, "wait_for.mongo.filter")
                    .map_err(|e| err(i, e))?,
            ),
            WaitCond::Key(_) => None,
        };
        let key = match cond {
            WaitCond::Key(k) => {
                Some(template::interpolate(k, &self.values(), now).map_err(|e| err(i, e))?)
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
        let mut observer = match &self.stores.postgres {
            Some(pg) if self.observe_times => Some(
                pg.time_observer()
                    .await
                    .map_err(|e| err(0, e.to_string()))?,
            ),
            _ => None,
        };
        let mut socketio = None;
        let result = self.run_inner(steps, &mut socketio, &mut observer).await;
        if let Some(client) = socketio {
            client.stop().await;
        }
        if let Some(observer) = observer
            && let Err(error) = observer.finish().await
        {
            return Err(err(
                steps.len().saturating_sub(1),
                format!(
                    "PostgreSQL time observer close: {error}; step result: {}",
                    result
                        .as_ref()
                        .err()
                        .map_or("success".to_string(), |e| e.message.clone())
                ),
            ));
        }
        result
    }

    async fn run_inner(
        &mut self,
        steps: &[Step],
        socketio: &mut Option<crate::socketio::Client>,
        observer: &mut Option<crate::postgres::TimeObserver>,
    ) -> Result<Vec<RawStep>, StepError> {
        let patterns = crate::detect::Patterns::new().map_err(|e| err(0, e.to_string()))?;
        let mut out = Vec::with_capacity(steps.len());
        let mut producer = (0, timefmt::now_ms());
        let mut dragonfly_times = crate::stores::DragonflyTimeCache::default();

        for (i, s) in steps.iter().enumerate() {
            self.alive(i, "before the step")?;
            let request_at = timefmt::now_ms();
            self.started_at.get_or_insert(request_at);
            if !matches!(
                s.kind,
                StepKind::Pause(_)
                    | StepKind::WaitFor { .. }
                    | StepKind::WaitQuiet(_)
                    | StepKind::WaitCall { .. }
            ) {
                producer = (i, request_at);
            }
            let r = match &s.kind {
                StepKind::Sql(sql) => {
                    let pg = self
                        .stores
                        .postgres
                        .as_ref()
                        .ok_or_else(|| err(i, "sql requires DIMA_TEST_POSTGRES_URI"))?;
                    let sql = self.fill(i, sql, timefmt::now_ms())?;
                    let value = pg.read(&sql).await.map_err(|e| err(i, e.to_string()))?;
                    RawStep::Sql {
                        at: timefmt::now_ms(),
                        value,
                    }
                }
                StepKind::Socketio(a) => {
                    if socketio.is_none() {
                        *socketio = Some(crate::socketio::Client::start().map_err(|e| err(i, e))?);
                    }
                    let input = serde_json::to_value(a).map_err(|e| err(i, e.to_string()))?;
                    let mut input = scenario::resolve_json(
                        &input,
                        &self.values(),
                        timefmt::now_ms(),
                        "socketio",
                    )
                    .map_err(|e| err(i, e))?;
                    let resolved: crate::socketio::Action =
                        serde_json::from_value(input.clone()).map_err(|e| err(i, e.to_string()))?;
                    resolved.validate().map_err(|e| err(i, e))?;
                    if let crate::socketio::Action::Open { port, .. } = a {
                        let name = port.as_deref().unwrap_or(&self.proc.primary_port);
                        let port = self
                            .proc
                            .port(name)
                            .ok_or_else(|| err(i, format!("no port named {name}")))?;
                        input["url"] = Value::String(format!("http://127.0.0.1:{port}"));
                    }
                    let client = socketio
                        .as_mut()
                        .ok_or_else(|| err(i, "Socket.IO helper missing"))?;
                    let value = client
                        .request(&input, a.timeout_ms())
                        .await
                        .map_err(|e| err(i, e))?;
                    RawStep::Socketio {
                        at: timefmt::now_ms(),
                        value,
                    }
                }
                StepKind::Http(h) => self.http(i, h).await?,
                StepKind::Dragonfly(args) => {
                    let now = timefmt::now_ms();
                    let values = self.values();
                    let rendered = args
                        .iter()
                        .map(|a| a.render(&values, now))
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|e| err(i, e))?;
                    // The rendered command: a saved value can become a command name or option.
                    let words = crate::dfcmd::words(&rendered);
                    crate::dfcmd::check(&words, self.allow_scripts)
                        .map_err(|e| err(i, format!("dragonfly {words:?}: {e}")))?;
                    let reply = self
                        .stores
                        .command(&rendered)
                        .await
                        .map_err(|e| err(i, e.to_string()))?;
                    RawStep::Reply(RawReplyStep {
                        at: timefmt::now_ms(),
                        command: rendered,
                        reply,
                    })
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
                StepKind::Eventsub(e) => self.eventsub(i, e).await?,
                StepKind::Polar(p) => self.polar(i, p).await?,
                StepKind::WaitCall { cond, timeout_ms } => {
                    self.wait_call(i, cond, *timeout_ms).await?;
                    RawStep::Done("wait_call".into())
                }
            };
            self.alive(i, "during the step")?;
            if !self.observe_times {
                out.push(r);
                continue;
            }
            self.step_ends.push(timefmt::now_ms());
            // Observe values after each operation so later latency cannot move earlier writes.
            let mongo = self
                .stores
                .capture_mongo(self.mongo_selection)
                .await
                .map_err(|e| err(i, format!("timestamp provenance: {e}")))?;
            let mut known = crate::detect::Known::default();
            for coll in mongo.values() {
                for doc in &coll.docs {
                    crate::detect::collect_known_bson(
                        &patterns,
                        &bson::Bson::Document(doc.clone()),
                        &mut known,
                    );
                }
            }
            if let RawStep::Http(h) = &r
                && let Ok(v) = serde_json::from_slice::<Value>(&h.body)
            {
                crate::detect::collect_known_json(&patterns, &v, &mut known);
            }
            if let RawStep::Http(h) = &r {
                for (_, bytes) in &h.headers {
                    if let Ok(text) = std::str::from_utf8(bytes) {
                        patterns.collect_known(text, &mut known);
                    }
                }
            }
            match &r {
                RawStep::Sql { value, .. } | RawStep::Socketio { value, .. } => {
                    crate::detect::collect_known_json(&patterns, value, &mut known);
                }
                RawStep::Reply(reply) => crate::detect::collect_known_json(
                    &patterns,
                    &crate::capture::enc_reply(&reply.reply),
                    &mut known,
                ),
                RawStep::Http(h) => {
                    if let Ok(text) = std::str::from_utf8(&h.body) {
                        patterns.collect_known(text, &mut known);
                    }
                }
                RawStep::Done(_) => {}
            }
            let df = self
                .stores
                .dragonfly_time_changes(self.dragonfly_selection, &mut dragonfly_times)
                .await
                .map_err(|e| err(i, format!("timestamp provenance Dragonfly: {e}")))?;
            for entry in df {
                if let Some(value) = &entry.value {
                    // Unchanged keys were already observed with their first value.
                    if let Ok(key) = std::str::from_utf8(&entry.key) {
                        patterns.collect_known(key, &mut known);
                    }
                    crate::detect::collect_known_json(
                        &patterns,
                        &crate::capture::enc_value(value),
                        &mut known,
                    );
                }
                if let Some(expiry) = entry.expiry {
                    let origin = match self.ttl_origins.get(&entry.key) {
                        Some((old, origin)) if *old == expiry => *origin,
                        _ => producer,
                    };
                    self.ttl_origins.insert(entry.key, (expiry, origin));
                }
            }
            if let Some(pg) = observer {
                let snapshot = pg
                    .rows()
                    .await
                    .map_err(|e| err(i, format!("timestamp provenance PostgreSQL: {e}")))?;
                crate::detect::collect_known_json(&patterns, &snapshot, &mut known);
            }
            for call in self.mock.calls() {
                patterns.collect_known(&call.path, &mut known);
                patterns.collect_known(&call.query, &mut known);
                for (_, bytes) in &call.headers {
                    if let Ok(text) = std::str::from_utf8(bytes) {
                        patterns.collect_known(text, &mut known);
                    }
                }
                let (_, body) = crate::mock::decode_body(&call.headers, &call.body);
                if let Some(body) = body {
                    crate::detect::collect_known_json(&patterns, &body, &mut known);
                }
            }
            for ms in known.times {
                self.time_anchors.entry(ms).or_insert(producer);
            }
            if self.time_anchors.len() > 200_000 || self.ttl_origins.len() > 200_000 {
                return Err(err(i, "timestamp provenance exceeded 200000 values"));
            }
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

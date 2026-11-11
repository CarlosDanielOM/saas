//! Detection: turn a raw capture into values where run-time data is marked.
//!
//! Generated identifiers (ObjectIds whose timestamp falls in the side's lifetime, random UUIDs,
//! values named by a `generated` allowance) become `Id::Raw` atoms; canonicalisation numbers them.
//! Times within the horizon of the run (BSON dates, ISO strings, `YYYY-MM-DD` days, epoch
//! milliseconds) become relative to the scenario start. Values that appear in the scenario's
//! inputs (seed, request bodies, paths, commands) are known and stay exact.

use std::collections::HashSet;

use bson::{Bson, Document, spec::BinarySubtype};
use regex::Regex;
use serde_json::{Number, Value};

use crate::allow::Allowances;
use crate::capture::{Body, Capture, CollCap, EntryCap, RawCapture, RawEntry, RawReply, RawStep, RawValue, StepCap};
use crate::path::{Path, name_glob};
use crate::timefmt::{self, MS_PER_DAY};
use crate::value::{Id, IdKind, Moment, NumRepr, Seg, Text, Val};

/// Times this far around the run window are treated as run-relative ("a lease 60 s later",
/// "a subscription a year later"). Farther times compare exactly.
pub const HORIZON_MS: i64 = 400 * MS_PER_DAY;
/// Times this close to the run window count as "during the run" (no absolute value kept).
pub const WINDOW_SLACK_MS: i64 = 1000;
/// ObjectId timestamps have one-second resolution; this much slack around the side's lifetime.
pub const OID_SLACK_MS: i64 = 5000;
/// Shortest value a `generated` allowance may substitute inside other strings.
pub const MIN_GENERATED_LEN: usize = 6;

#[derive(Clone, Copy, Debug)]
pub struct Window {
    /// Scenario start (before reset and seed), rig clock.
    pub start: i64,
    /// After the last step.
    pub end: i64,
    /// When the side's process was started.
    pub proc_start: i64,
}

impl Window {
    fn in_window(&self, ms: i64) -> bool {
        ms >= self.start - WINDOW_SLACK_MS && ms <= self.end + WINDOW_SLACK_MS
    }

    fn in_horizon(&self, ms: i64) -> bool {
        ms >= self.start - HORIZON_MS && ms <= self.end + HORIZON_MS
    }

    fn moment(&self, ms: i64) -> Moment {
        Moment::Rel { off: ms - self.start, abs: if self.in_window(ms) { None } else { Some(ms) } }
    }

    fn generated_time(&self, ms: i64) -> bool {
        ms >= self.proc_start.min(self.start) - OID_SLACK_MS && ms <= self.end + OID_SLACK_MS
    }
}

/// Values present in the scenario's inputs: they compare exactly wherever they reappear.
#[derive(Debug, Default, Clone)]
pub struct Known {
    pub ids: HashSet<String>,
    pub times: HashSet<i64>,
    pub days: HashSet<String>,
}

/// The fixed patterns the rig looks for inside strings.
pub struct Patterns {
    oid: Regex,
    uuid: Regex,
    iso: Regex,
    ms13: Regex,
}

impl Patterns {
    pub fn new() -> Result<Patterns, regex::Error> {
        Ok(Patterns {
            oid: Regex::new("[0-9a-f]{24}")?,
            uuid: Regex::new("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")?,
            iso: Regex::new(
                "[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\\.[0-9]{1,9})?)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?",
            )?,
            ms13: Regex::new("[0-9]{13}")?,
        })
    }

    /// Record every id, time and day that appears in an input string.
    pub fn collect_known(&self, s: &str, known: &mut Known) {
        for m in self.oid.find_iter(s) {
            if bounded(s, m.start(), m.end(), |c| c.is_ascii_alphanumeric()) {
                known.ids.insert(m.as_str().to_string());
            }
        }
        for m in self.uuid.find_iter(s) {
            if bounded(s, m.start(), m.end(), |c| c.is_ascii_alphanumeric()) {
                known.ids.insert(m.as_str().to_string());
            }
        }
        for m in self.iso.find_iter(s) {
            if !bounded(s, m.start(), m.end(), |c| c.is_ascii_digit()) {
                continue;
            }
            if let Some(ms) = timefmt::parse_iso(m.as_str()) {
                known.times.insert(ms);
            } else if timefmt::parse_day(m.as_str()).is_some() {
                known.days.insert(m.as_str().to_string());
            }
        }
        for m in self.ms13.find_iter(s) {
            if bounded(s, m.start(), m.end(), |c| c.is_ascii_alphanumeric())
                && let Ok(ms) = m.as_str().parse::<i64>() {
                    known.times.insert(ms);
                }
        }
    }
}

/// The match is not glued to neighbouring characters of the given class.
fn bounded(s: &str, start: usize, end: usize, glue: impl Fn(char) -> bool) -> bool {
    let before = s.get(..start).and_then(|p| p.chars().next_back());
    let after = s.get(end..).and_then(|t| t.chars().next());
    !before.is_some_and(&glue) && !after.is_some_and(&glue)
}

/// Record known values from an input JSON value (request bodies, filters, command arguments).
pub fn collect_known_json(p: &Patterns, v: &Value, known: &mut Known) {
    match v {
        Value::String(s) => p.collect_known(s, known),
        Value::Number(n) => {
            if let Some(ms) = integral(n) {
                known.times.insert(ms);
            }
        }
        Value::Array(a) => a.iter().for_each(|x| collect_known_json(p, x, known)),
        Value::Object(m) => {
            for (k, x) in m {
                p.collect_known(k, known);
                collect_known_json(p, x, known);
            }
        }
        Value::Null | Value::Bool(_) => {}
    }
}

/// Record known values from a seed document.
pub fn collect_known_bson(p: &Patterns, b: &Bson, known: &mut Known) {
    match b {
        Bson::String(s) => p.collect_known(s, known),
        Bson::ObjectId(o) => {
            known.ids.insert(o.to_hex());
        }
        Bson::DateTime(d) => {
            known.times.insert(d.timestamp_millis());
        }
        Bson::Int64(i) => {
            known.times.insert(*i);
        }
        Bson::Double(f) => {
            if let Some(i) = f64_integral(*f) {
                known.times.insert(i);
            }
        }
        Bson::Binary(bin) => {
            if let Some(u) = uuid_string(&bin.subtype, &bin.bytes) {
                known.ids.insert(u);
            }
        }
        Bson::Array(a) => a.iter().for_each(|x| collect_known_bson(p, x, known)),
        Bson::Document(d) => {
            for (k, x) in d {
                p.collect_known(k, known);
                collect_known_bson(p, x, known);
            }
        }
        _ => {}
    }
}

fn f64_integral(f: f64) -> Option<i64> {
    if f.is_finite() && f.fract() == 0.0 && f.abs() < 9.0e15 { Some(f as i64) } else { None }
}

fn integral(n: &Number) -> Option<i64> {
    n.as_i64().or_else(|| n.as_f64().and_then(f64_integral))
}

fn uuid_string(subtype: &BinarySubtype, bytes: &[u8]) -> Option<String> {
    if !matches!(subtype, BinarySubtype::Uuid | BinarySubtype::UuidOld) || bytes.len() != 16 {
        return None;
    }
    let h: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let part = |a: usize, b: usize| h.get(a..b).unwrap_or("");
    Some(format!("{}-{}-{}-{}-{}", part(0, 8), part(8, 12), part(12, 16), part(16, 20), part(20, 32)))
}

/// Header names compared by default.
pub const DEFAULT_HEADERS: &[&str] = &[
    "content-type",
    "location",
    "cache-control",
    "www-authenticate",
    "retry-after",
    "access-control-*",
    "content-security-policy",
    "x-content-type-options",
];

/// Everything detection needs to know about one side's run of one scenario.
pub struct DetectCtx<'a> {
    pub patterns: &'a Patterns,
    pub window: Window,
    pub known: &'a Known,
    pub allow: &'a Allowances,
    /// Run-time names to mask: (literal text, name). Example: ("127.0.0.1:41234", "port.http").
    pub names: Vec<(String, String)>,
    /// Header name globs (lower case) to capture.
    pub headers: Vec<String>,
    /// When the Dragonfly TTLs were read.
    pub captured_at: i64,
    /// Dragonfly strings at or below these paths stay exact text (not parsed as JSON).
    pub as_text: Vec<crate::path::Pattern>,
}

struct Detector<'a, 'b> {
    ctx: &'b DetectCtx<'a>,
    extra: Option<Regex>,
    found: Vec<String>,
}

#[derive(Clone)]
struct Cand {
    start: usize,
    end: usize,
    prio: u8,
    seg: Seg,
}

impl Detector<'_, '_> {
    fn moment(&self, ms: i64) -> Moment {
        self.ctx.window.moment(ms)
    }

    fn oid_is_generated(&self, hex: &str) -> bool {
        if self.ctx.known.ids.contains(hex) {
            return false;
        }
        let secs = hex.get(0..8).and_then(|h| i64::from_str_radix(h, 16).ok());
        secs.is_some_and(|s| self.ctx.window.generated_time(s * 1000) || self.ctx.window.generated_time(s * 1000 + 999))
    }

    fn uuid_is_generated(&self, u: &str) -> bool {
        if self.ctx.known.ids.contains(u) {
            return false;
        }
        match u.as_bytes().get(14) {
            Some(b'4') => true,
            Some(b'7') => {
                let hex: String = u.chars().filter(|c| *c != '-').take(12).collect();
                i64::from_str_radix(&hex, 16).is_ok_and(|ms| self.ctx.window.generated_time(ms))
            }
            _ => false,
        }
    }

    fn time_number(&self, ms: i64) -> bool {
        self.ctx.window.in_horizon(ms) && !self.ctx.known.times.contains(&ms)
    }

    /// Find the run-time values inside a string.
    fn text(&mut self, path: &Path, s: &str) -> Text {
        if s.is_empty() {
            return Text::default();
        }
        let p = self.ctx.patterns;
        let mut cands: Vec<Cand> = Vec::new();
        for (lit, name) in &self.ctx.names {
            if lit.is_empty() {
                continue;
            }
            for (i, _) in s.match_indices(lit.as_str()) {
                cands.push(Cand { start: i, end: i + lit.len(), prio: 0, seg: Seg::Name(name.clone()) });
            }
        }
        if let Some(re) = &self.extra {
            for m in re.find_iter(s) {
                cands.push(Cand { start: m.start(), end: m.end(), prio: 1, seg: Seg::Id(Id::Raw(IdKind::Gen, m.as_str().to_string())) });
            }
        }
        for (idx, re) in self.ctx.allow.generated_patterns(path) {
            for m in re.find_iter(s) {
                if m.as_str().is_empty() {
                    continue;
                }
                self.ctx.allow.mark_used(idx);
                self.found.push(m.as_str().to_string());
                cands.push(Cand { start: m.start(), end: m.end(), prio: 2, seg: Seg::Id(Id::Raw(IdKind::Gen, m.as_str().to_string())) });
            }
        }
        for m in p.oid.find_iter(s) {
            if bounded(s, m.start(), m.end(), |c| c.is_ascii_alphanumeric()) && self.oid_is_generated(m.as_str()) {
                cands.push(Cand { start: m.start(), end: m.end(), prio: 3, seg: Seg::Id(Id::Raw(IdKind::Oid, m.as_str().to_string())) });
            }
        }
        for m in p.uuid.find_iter(s) {
            if bounded(s, m.start(), m.end(), |c| c.is_ascii_alphanumeric()) && self.uuid_is_generated(m.as_str()) {
                cands.push(Cand { start: m.start(), end: m.end(), prio: 4, seg: Seg::Id(Id::Raw(IdKind::Uuid, m.as_str().to_string())) });
            }
        }
        for m in p.iso.find_iter(s) {
            if !bounded(s, m.start(), m.end(), |c| c.is_ascii_digit()) {
                continue;
            }
            let txt = m.as_str();
            if let Some(ms) = timefmt::parse_iso(txt) {
                if self.time_number(ms) {
                    let shape: String = txt.chars().map(|c| if c.is_ascii_digit() { 'd' } else { c }).collect();
                    cands.push(Cand { start: m.start(), end: m.end(), prio: 5, seg: Seg::Time { at: self.moment(ms), shape } });
                }
            } else if let Some(day) = timefmt::parse_day(txt) {
                if self.ctx.known.days.contains(txt) {
                    continue;
                }
                let w = &self.ctx.window;
                let start_day = w.start.div_euclid(MS_PER_DAY);
                let end_day = w.end.div_euclid(MS_PER_DAY);
                if (day - start_day).abs() <= HORIZON_MS / MS_PER_DAY {
                    let abs = if day >= start_day && day <= end_day { None } else { Some(txt.to_string()) };
                    cands.push(Cand { start: m.start(), end: m.end(), prio: 5, seg: Seg::Day { off: day - start_day, abs } });
                }
            }
        }
        for m in p.ms13.find_iter(s) {
            if !bounded(s, m.start(), m.end(), |c| c.is_ascii_alphanumeric()) {
                continue;
            }
            if let Ok(ms) = m.as_str().parse::<i64>()
                && self.time_number(ms) {
                    cands.push(Cand { start: m.start(), end: m.end(), prio: 6, seg: Seg::Time { at: self.moment(ms), shape: "ms".into() } });
                }
        }
        if cands.is_empty() {
            return Text::lit(s);
        }
        cands.sort_by(|a, b| a.start.cmp(&b.start).then((b.end - b.start).cmp(&(a.end - a.start))).then(a.prio.cmp(&b.prio)));
        let mut segs = Vec::new();
        let mut at = 0;
        for c in cands {
            if c.start < at {
                continue;
            }
            segs.push(Seg::Lit(s.get(at..c.start).unwrap_or("").to_string()));
            segs.push(c.seg);
            at = c.end;
        }
        segs.push(Seg::Lit(s.get(at..).unwrap_or("").to_string()));
        Text::from_segs(segs)
    }

    fn generated_whole(&mut self, path: &Path, s: &str) -> Option<Val> {
        if self.ctx.allow.generated_whole(path) {
            self.found.push(s.to_string());
            return Some(Val::Str(Text(vec![Seg::Id(Id::Raw(IdKind::Gen, s.to_string()))])));
        }
        None
    }

    fn json_number(&self, n: &Number) -> Val {
        match integral(n) {
            Some(ms) if self.time_number(ms) => Val::Time(NumRepr::Json, self.moment(ms)),
            _ => Val::Num(n.clone()),
        }
    }

    fn json(&mut self, path: &mut Path, v: &Value) -> Val {
        if let Value::String(s) = v
            && let Some(g) = self.generated_whole(path, s) {
                return g;
            }
        match v {
            Value::Null => Val::Null,
            Value::Bool(b) => Val::Bool(*b),
            Value::Number(n) => self.json_number(n),
            Value::String(s) => Val::Str(self.text(path, s)),
            Value::Array(items) => Val::Arr(
                items
                    .iter()
                    .enumerate()
                    .map(|(i, x)| {
                        path.push_index(i);
                        let r = self.json(path, x);
                        path.pop();
                        r
                    })
                    .collect(),
            ),
            Value::Object(m) => {
                let mut kv = Vec::with_capacity(m.len());
                for (k, x) in m {
                    let key = self.text(path, k);
                    path.push_key(key.display());
                    let val = self.json(path, x);
                    path.pop();
                    kv.push((key, val));
                }
                Val::Obj(kv)
            }
        }
    }

    fn doc(&mut self, path: &mut Path, d: &Document) -> Val {
        let mut kv = Vec::with_capacity(d.len());
        for (k, x) in d {
            let key = self.text(path, k);
            path.push_key(key.display());
            let val = self.bson(path, x);
            path.pop();
            kv.push((key, val));
        }
        Val::Obj(kv)
    }

    fn bson(&mut self, path: &mut Path, b: &Bson) -> Val {
        if let Bson::String(s) = b
            && let Some(g) = self.generated_whole(path, s) {
                return g;
            }
        match b {
            Bson::Null => Val::Null,
            Bson::Boolean(x) => Val::Bool(*x),
            Bson::Int32(i) => Val::Int32(*i),
            Bson::Int64(i) if self.time_number(*i) => Val::Time(NumRepr::Int64, self.moment(*i)),
            Bson::Int64(i) => Val::Int64(*i),
            Bson::Double(f) => match f64_integral(*f) {
                Some(ms) if self.time_number(ms) => Val::Time(NumRepr::Double, self.moment(ms)),
                _ => Val::Double(*f),
            },
            Bson::Decimal128(d) => Val::Dec(d.to_string()),
            Bson::String(s) => Val::Str(self.text(path, s)),
            Bson::Array(items) => Val::Arr(
                items
                    .iter()
                    .enumerate()
                    .map(|(i, x)| {
                        path.push_index(i);
                        let r = self.bson(path, x);
                        path.pop();
                        r
                    })
                    .collect(),
            ),
            Bson::Document(d) => self.doc(path, d),
            Bson::ObjectId(o) => {
                let hex = o.to_hex();
                if self.oid_is_generated(&hex) { Val::Oid(Id::Raw(IdKind::Oid, hex)) } else { Val::Oid(Id::Lit(hex)) }
            }
            Bson::DateTime(d) => {
                let ms = d.timestamp_millis();
                if self.time_number(ms) { Val::Time(NumRepr::Date, self.moment(ms)) } else { Val::Time(NumRepr::Date, Moment::Abs(ms)) }
            }
            Bson::Binary(bin) => match uuid_string(&bin.subtype, &bin.bytes) {
                Some(u) if matches!(bin.subtype, BinarySubtype::Uuid) => {
                    if self.uuid_is_generated(&u) { Val::Uuid(Id::Raw(IdKind::Uuid, u)) } else { Val::Uuid(Id::Lit(u)) }
                }
                _ => Val::Ext(b.clone().into_canonical_extjson()),
            },
            other => Val::Ext(other.clone().into_canonical_extjson()),
        }
    }

    /// A Dragonfly string: JSON when it is a compact JSON object or array, else text or bytes.
    fn df_string(&mut self, path: &mut Path, bytes: &[u8]) -> Val {
        let Ok(s) = std::str::from_utf8(bytes) else {
            return Val::Bytes(bytes.to_vec());
        };
        let as_text = self.ctx.as_text.iter().any(|p| p.matches_self_or_ancestor(path));
        if !as_text && (s.starts_with('{') || s.starts_with('['))
            && let Ok(parsed) = serde_json::from_str::<Value>(s)
                && serde_json::to_string(&parsed).is_ok_and(|c| c == s) {
                    return Val::Json(Box::new(self.json(path, &parsed)));
                }
        if let Some(g) = self.generated_whole(path, s) {
            return g;
        }
        Val::Str(self.text(path, s))
    }

    fn reply(&mut self, path: &mut Path, r: &RawReply) -> Val {
        match r {
            RawReply::Nil => Val::Null,
            RawReply::Int(i) => self.json_number(&Number::from(*i)),
            RawReply::Bulk(b) => self.df_string(path, b),
            RawReply::Status(s) => Val::Obj(vec![(Text::lit("status"), Val::Str(self.text(path, s)))]),
            RawReply::Error(s) => Val::Obj(vec![(Text::lit("error"), Val::Str(self.text(path, s)))]),
            RawReply::Double(f) => Number::from_f64(*f).map_or(Val::Str(Text::lit(&f.to_string())), |n| self.json_number(&n)),
            RawReply::Bool(b) => Val::Bool(*b),
            RawReply::Array(items) => Val::Arr(
                items
                    .iter()
                    .enumerate()
                    .map(|(i, x)| {
                        path.push_index(i);
                        let v = self.reply(path, x);
                        path.pop();
                        v
                    })
                    .collect(),
            ),
            RawReply::Map(pairs) => Val::Arr(
                pairs
                    .iter()
                    .enumerate()
                    .map(|(i, (k, v))| {
                        path.push_index(i);
                        let pair = Val::Arr(vec![self.reply(path, k), self.reply(path, v)]);
                        path.pop();
                        pair
                    })
                    .collect(),
            ),
        }
    }

    fn step(&mut self, i: usize, s: &RawStep) -> StepCap {
        let mut path = Path::root("steps");
        path.push_index(i);
        match s {
            RawStep::Done(kind) => StepCap::Done(kind.clone()),
            RawStep::Reply(r) => {
                path.push_key("reply");
                StepCap::Reply(self.reply(&mut path, r))
            }
            RawStep::Http(h) => {
                let mut headers: Vec<(String, Vec<Text>)> = Vec::new();
                for (name, value) in &h.headers {
                    if !self.ctx.headers.iter().any(|g| name_glob(g, name)) {
                        continue;
                    }
                    let hp = path.with_key("headers").with_key(name.clone());
                    let t = self.text(&hp, value);
                    match headers.iter_mut().find(|(n, _)| n == name) {
                        Some((_, vals)) => vals.push(t),
                        None => headers.push((name.clone(), vec![t])),
                    }
                }
                headers.sort_by(|a, b| a.0.cmp(&b.0));
                let content_type = h
                    .headers
                    .iter()
                    .find(|(n, _)| n == "content-type")
                    .map(|(_, v)| v.to_ascii_lowercase())
                    .unwrap_or_default();
                let essence = content_type.split(';').next().unwrap_or("").trim().to_string();
                let is_json = essence == "application/json" || essence.ends_with("+json");
                let mut bp = path.with_key("body");
                let body = match (is_json, serde_json::from_slice::<Value>(&h.body), std::str::from_utf8(&h.body)) {
                    (true, Ok(v), _) => Body::Json(self.json(&mut bp, &v)),
                    (_, _, Ok(text)) => Body::Text(self.text(&bp, text)),
                    _ => Body::Bytes(h.body.clone()),
                };
                StepCap::Http { status: h.status, headers, body }
            }
        }
    }

    fn coll(&mut self, name: &str, c: &crate::capture::RawColl) -> CollCap {
        let base = Path::root("mongo").with_key(name);
        let mut op = base.with_key("options");
        let options = self.doc(&mut op, &c.options);
        let mut indexes: Vec<(String, Val)> = c
            .indexes
            .iter()
            .map(|spec| {
                let n = spec.get_str("name").unwrap_or("?").to_string();
                let mut ip = base.with_key("indexes").with_key(n.clone());
                let v = self.doc(&mut ip, spec);
                (n, v)
            })
            .collect();
        indexes.sort_by(|a, b| a.0.cmp(&b.0));
        let docs = c
            .docs
            .iter()
            .enumerate()
            .map(|(i, d)| {
                let mut dp = base.with_index(i);
                self.doc(&mut dp, d)
            })
            .collect();
        CollCap { kind: c.kind.clone(), options, indexes, docs }
    }

    fn entry(&mut self, e: &RawEntry) -> EntryCap {
        let root = Path::root("dragonfly");
        let key = match std::str::from_utf8(&e.key) {
            Ok(s) => self.text(&root, s),
            Err(_) => Text::lit(&format!("<bytes:{}>", e.key.iter().map(|b| format!("{b:02x}")).collect::<String>())),
        };
        let mut vp = root.with_key(key.display()).with_key("value");
        let value = match &e.value {
            RawValue::Str(b) => self.df_string(&mut vp, b),
            RawValue::Hash(pairs) => {
                let mut kv = Vec::with_capacity(pairs.len());
                for (f, v) in pairs {
                    let field = match std::str::from_utf8(f) {
                        Ok(s) => self.text(&vp, s),
                        Err(_) => Text::lit(&String::from_utf8_lossy(f)),
                    };
                    vp.push_key(field.display());
                    let val = self.df_string(&mut vp, v);
                    vp.pop();
                    kv.push((field, val));
                }
                kv.sort_by_key(|a| a.0.display());
                Val::Obj(kv)
            }
            RawValue::List(items) | RawValue::Set(items) => Val::Arr(
                items
                    .iter()
                    .enumerate()
                    .map(|(i, x)| {
                        vp.push_index(i);
                        let v = self.df_string(&mut vp, x);
                        vp.pop();
                        v
                    })
                    .collect(),
            ),
            RawValue::ZSet(items) => Val::Arr(
                items
                    .iter()
                    .enumerate()
                    .map(|(i, (m, score))| {
                        vp.push_index(i);
                        vp.push_key("member");
                        let member = self.df_string(&mut vp, m);
                        vp.pop();
                        let score = Number::from_f64(*score).map_or(Val::Str(Text::lit(&score.to_string())), |n| self.json_number(&n));
                        vp.pop();
                        Val::Obj(vec![(Text::lit("member"), member), (Text::lit("score"), score)])
                    })
                    .collect(),
            ),
            RawValue::Stream(entries) => Val::Arr(
                entries
                    .iter()
                    .enumerate()
                    .map(|(i, (id, fields))| {
                        vp.push_index(i);
                        let idt = self.text(&vp, id);
                        vp.push_key("fields");
                        let mut kv = Vec::new();
                        for (f, v) in fields {
                            let field = self.text(&vp, &String::from_utf8_lossy(f));
                            vp.push_key(field.display());
                            let val = self.df_string(&mut vp, v);
                            vp.pop();
                            kv.push((field, val));
                        }
                        vp.pop();
                        vp.pop();
                        Val::Obj(vec![(Text::lit("id"), Val::Str(idt)), (Text::lit("fields"), Val::Obj(kv))])
                    })
                    .collect(),
            ),
            RawValue::Other => Val::Unsupported(e.kind.clone()),
        };
        let ttl = if e.pttl >= 0 { Some(self.moment(self.ctx.captured_at + e.pttl)) } else { None };
        EntryCap { key, kind: e.kind.clone(), ttl, value }
    }

    fn run(&mut self, raw: &RawCapture) -> Capture {
        let steps = raw.steps.iter().enumerate().map(|(i, s)| self.step(i, s)).collect();
        let mongo = raw.mongo.iter().map(|(n, c)| (n.clone(), self.coll(n, c))).collect();
        let dragonfly = raw.dragonfly.iter().map(|e| self.entry(e)).collect();
        Capture { steps, mongo, dragonfly }
    }
}

/// Detect run-time values in a raw capture. The result still holds `Id::Raw` atoms; pass it to
/// [`crate::canon::canonicalise`] to order and number it.
pub fn detect(ctx: &DetectCtx<'_>, raw: &RawCapture) -> Capture {
    let mut first = Detector { ctx, extra: None, found: Vec::new() };
    let cap = first.run(raw);
    let mut found: Vec<String> = first.found.into_iter().filter(|s| s.chars().count() >= MIN_GENERATED_LEN).collect();
    if found.is_empty() {
        return cap;
    }
    // A generated value found at one path is also generated wherever else it appears (inside
    // other strings and key names), so cross-references are checked.
    found.sort_by_key(|s| std::cmp::Reverse(s.len()));
    found.dedup();
    let alternation = found.iter().map(|s| regex::escape(s)).collect::<Vec<_>>().join("|");
    let Ok(extra) = Regex::new(&alternation) else {
        return cap;
    };
    let mut second = Detector { ctx, extra: Some(extra), found: Vec::new() };
    second.run(raw)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub const START: i64 = 1_794_400_000_000; // 2026-11-11T12:26:40.000Z

    pub fn window() -> Window {
        Window { start: START, end: START + 3000, proc_start: START - 60_000 }
    }

    /// An ObjectId generated at `ms`.
    pub fn oid_at(ms: i64, n: u32) -> String {
        format!("{:08x}{:016x}", ms / 1000, u64::from(n))
    }

    pub fn ctx<'a>(p: &'a Patterns, known: &'a Known, allow: &'a Allowances) -> DetectCtx<'a> {
        DetectCtx {
            patterns: p,
            window: window(),
            known,
            allow,
            names: vec![("127.0.0.1:41234".into(), "port.http".into())],
            headers: DEFAULT_HEADERS.iter().map(|s| s.to_string()).collect(),
            captured_at: START + 3000,
            as_text: Vec::new(),
        }
    }

    fn text_of(raw: &str, known: &Known) -> Text {
        let p = Patterns::new().unwrap();
        let allow = Allowances::default();
        let c = ctx(&p, known, &allow);
        let mut d = Detector { ctx: &c, extra: None, found: Vec::new() };
        d.text(&Path::root("x"), raw)
    }

    #[test]
    fn ids_inside_strings() {
        let id = oid_at(START + 100, 7);
        let t = text_of(&format!("item:{id}:lock"), &Known::default());
        assert_eq!(t.0.len(), 3, "{t:?}");
        assert!(matches!(&t.0[1], Seg::Id(Id::Raw(IdKind::Oid, v)) if *v == id));
        // An old ObjectId (outside the side's lifetime) and a hex run that is too long stay literal.
        let old = oid_at(START - 86_400_000, 1);
        assert_eq!(text_of(&format!("x:{old}"), &Known::default()).as_plain(), Some(format!("x:{old}").as_str()));
        let long = format!("{id}ab");
        assert!(text_of(&long, &Known::default()).as_plain().is_some());
        // A known (seeded) id stays literal even when fresh.
        let mut known = Known::default();
        known.ids.insert(id.clone());
        assert!(text_of(&format!("item:{id}"), &known).as_plain().is_some());
    }

    #[test]
    fn uuids_by_version() {
        let v4 = "3f2b8c1e-9a4d-4c7e-8f00-1234567890ab";
        let v5 = "3f2b8c1e-9a4d-5c7e-8f00-1234567890ab";
        assert!(text_of(v4, &Known::default()).has_atoms());
        assert!(!text_of(v5, &Known::default()).has_atoms());
    }

    #[test]
    fn times_and_days_inside_strings() {
        let iso = timefmt::format_iso_ms(START + 1500).unwrap();
        let t = text_of(&format!("at {iso} ok"), &Known::default());
        assert!(matches!(&t.0[1], Seg::Time { at: Moment::Rel { off: 1500, abs: None }, shape } if shape == "dddd-dd-ddTdd:dd:dd.dddZ"));
        let far = "1999-01-01T00:00:00.000Z";
        assert!(text_of(far, &Known::default()).as_plain().is_some());
        let day = timefmt::format_day(START.div_euclid(MS_PER_DAY));
        let t = text_of(&format!("stats:{day}"), &Known::default());
        assert!(matches!(&t.0[1], Seg::Day { off: 0, abs: None }));
        let stream_id = format!("{}-0", START + 10);
        let t = text_of(&stream_id, &Known::default());
        assert!(matches!(&t.0[0], Seg::Time { shape, .. } if shape == "ms"));
        let t = text_of("http://127.0.0.1:41234/items", &Known::default());
        assert_eq!(t.encode(), "http://<run:port.http>/items");
    }

    #[test]
    fn non_ascii_text_is_cut_on_character_boundaries() {
        let id = oid_at(START, 1);
        let s = format!("🍕ñ{id}ü😀");
        let t = text_of(&s, &Known::default());
        assert_eq!(t.0.len(), 3);
        assert!(matches!(&t.0[0], Seg::Lit(l) if l == "🍕ñ"));
        assert!(matches!(&t.0[2], Seg::Lit(l) if l == "ü😀"));
    }
}

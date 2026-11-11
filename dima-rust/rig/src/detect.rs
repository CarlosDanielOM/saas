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
use crate::capture::{
    Body, Capture, CollCap, EntryCap, RawCapture, RawEntry, RawReply, RawStep, RawValue, StepCap,
};
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
    /// The run start: just before the first step (rig clock). Run times are relative to it.
    pub start: i64,
    /// After the last step.
    pub end: i64,
    /// When the side's process was started.
    pub proc_start: i64,
    /// The `$rigNow` of the seed (before the stores were reset and seeded).
    pub seeded_at: i64,
}

impl Window {
    fn first(&self) -> i64 {
        self.start.min(self.seeded_at).min(self.proc_start)
    }

    fn in_window(&self, ms: i64) -> bool {
        ms >= self.first() - WINDOW_SLACK_MS && ms <= self.end + WINDOW_SLACK_MS
    }

    fn in_horizon(&self, ms: i64) -> bool {
        ms >= self.start - HORIZON_MS && ms <= self.end + HORIZON_MS
    }

    fn moment(&self, ms: i64) -> Moment {
        Moment::Rel {
            off: ms - self.start,
            abs: if self.in_window(ms) { None } else { Some(ms) },
        }
    }

    fn generated_time(&self, ms: i64) -> bool {
        ms >= self.first() - OID_SLACK_MS && ms <= self.end + OID_SLACK_MS
    }
}

/// Values present in the scenario's inputs: they compare exactly wherever they reappear.
#[derive(Debug, Default, Clone)]
pub struct Known {
    pub ids: HashSet<String>,
    pub times: HashSet<i64>,
    pub days: HashSet<String>,
    /// Every input string: a `generated` value never lands on one of them.
    pub texts: HashSet<String>,
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
            uuid: Regex::new(
                "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
            )?,
            iso: Regex::new(
                "[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\\.[0-9]{1,9})?)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?",
            )?,
            ms13: Regex::new("[0-9]{13}")?,
        })
    }

    /// Record every id, time and day that appears in an input string, and the string itself.
    pub fn collect_known(&self, s: &str, known: &mut Known) {
        if !s.is_empty() {
            known.texts.insert(s.to_string());
        }
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
                && let Ok(ms) = m.as_str().parse::<i64>()
            {
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
    if f.is_finite() && f.fract() == 0.0 && f.abs() < 9.0e15 {
        Some(f as i64)
    } else {
        None
    }
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
    Some(format!(
        "{}-{}-{}-{}-{}",
        part(0, 8),
        part(8, 12),
        part(12, 16),
        part(16, 20),
        part(20, 32)
    ))
}

/// Response headers not compared unless a scenario includes them: transport details that
/// differ between servers without any client relying on them. Every other header is compared.
pub const NOISE_HEADERS: &[&str] = &[
    "date",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "content-length",
    "x-powered-by",
];

/// An ETag compares by presence and weak/strong form only: its value derives from a body that
/// holds generated values.
fn etag_form(v: &[u8]) -> &'static str {
    if v.starts_with(b"W/") {
        "W/\"…\""
    } else if v.starts_with(b"\"") {
        "\"…\""
    } else {
        "… (not quoted)"
    }
}

/// Everything detection needs to know about one side's run of one scenario.
pub struct DetectCtx<'a> {
    pub patterns: &'a Patterns,
    pub window: Window,
    pub known: &'a Known,
    pub allow: &'a Allowances,
    /// Run-time names to mask: (literal text, name). Example: ("127.0.0.1:41234", "port.http").
    pub names: Vec<(String, String)>,
    /// Response headers not compared (lower case).
    pub skip_headers: Vec<String>,
    /// Dragonfly strings at or below these paths stay exact text (not parsed as JSON).
    pub as_text: Vec<crate::path::Pattern>,
    /// Dragonfly key globs whose values stay exact text (`byte_sensitive.json`).
    pub byte_sensitive: Vec<String>,
    /// The `$rigNow` offsets of the seed (with `true` for epoch seconds): a value equal to the
    /// seed time plus one of them is that seeded time, compared by its offset.
    pub seed_offsets: Vec<(i64, bool)>,
}

struct Detector<'a, 'b> {
    ctx: &'b DetectCtx<'a>,
    extra: Option<Regex>,
    found: Vec<String>,
    /// Inside the value of a byte-sensitive key (or the reply to a command on one).
    exact_text: bool,
}

#[derive(Clone)]
struct Cand {
    start: usize,
    end: usize,
    prio: u8,
    seg: Seg,
}

impl Detector<'_, '_> {
    /// The value is known from the scenario's inputs: equal to an input string, or (when long
    /// enough to mean something) part of one.
    fn known_text(&self, v: &str) -> bool {
        let texts = &self.ctx.known.texts;
        texts.contains(v)
            || (v.chars().count() >= MIN_GENERATED_LEN && texts.iter().any(|t| t.contains(v)))
    }

    fn moment(&self, ms: i64) -> Moment {
        let w = &self.ctx.window;
        for (seed, secs) in &self.ctx.seed_offsets {
            let at = w.seeded_at + seed;
            let at = if *secs {
                at.div_euclid(1000) * 1000
            } else {
                at
            };
            if at == ms {
                return Moment::Seed {
                    seed: *seed,
                    off: ms - w.start,
                };
            }
        }
        w.moment(ms)
    }

    fn oid_is_generated(&self, hex: &str) -> bool {
        if self.ctx.known.ids.contains(hex) {
            return false;
        }
        let secs = hex.get(0..8).and_then(|h| i64::from_str_radix(h, 16).ok());
        secs.is_some_and(|s| {
            self.ctx.window.generated_time(s * 1000)
                || self.ctx.window.generated_time(s * 1000 + 999)
        })
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
        // A string of digits declared a time.
        if let Some(secs) = self.ctx.allow.time_unit(path)
            && s.bytes().all(|b| b.is_ascii_digit())
            && let Ok(v) = s.parse::<i64>()
        {
            let ms = if secs { v.saturating_mul(1000) } else { v };
            return Text(vec![Seg::Time {
                at: self.declared_moment(v, ms),
                shape: if secs { "s" } else { "ms" }.into(),
            }]);
        }
        let times = !self.ctx.allow.exact(path);
        let p = self.ctx.patterns;
        let mut cands: Vec<Cand> = Vec::new();
        for (lit, name) in &self.ctx.names {
            if lit.is_empty() {
                continue;
            }
            for (i, _) in s.match_indices(lit.as_str()) {
                cands.push(Cand {
                    start: i,
                    end: i + lit.len(),
                    prio: 0,
                    seg: Seg::Name(name.clone()),
                });
            }
        }
        if let Some(re) = &self.extra {
            // A generated value found elsewhere, here only as a whole token (never glued to
            // letters or digits on either side).
            for m in re.find_iter(s) {
                if !bounded(s, m.start(), m.end(), char::is_alphanumeric) {
                    continue;
                }
                cands.push(Cand {
                    start: m.start(),
                    end: m.end(),
                    prio: 1,
                    seg: Seg::Id(Id::Raw(IdKind::Gen, m.as_str().to_string())),
                });
            }
        }
        for (idx, re) in self.ctx.allow.generated_patterns(path) {
            for m in re.find_iter(s) {
                if m.as_str().is_empty() || self.known_text(m.as_str()) {
                    continue;
                }
                self.ctx.allow.mark_used(idx);
                self.found.push(m.as_str().to_string());
                cands.push(Cand {
                    start: m.start(),
                    end: m.end(),
                    prio: 2,
                    seg: Seg::Id(Id::Raw(IdKind::Gen, m.as_str().to_string())),
                });
            }
        }
        for m in p.oid.find_iter(s) {
            if bounded(s, m.start(), m.end(), |c| c.is_ascii_alphanumeric())
                && self.oid_is_generated(m.as_str())
            {
                cands.push(Cand {
                    start: m.start(),
                    end: m.end(),
                    prio: 3,
                    seg: Seg::Id(Id::Raw(IdKind::Oid, m.as_str().to_string())),
                });
            }
        }
        for m in p.uuid.find_iter(s) {
            if bounded(s, m.start(), m.end(), |c| c.is_ascii_alphanumeric())
                && self.uuid_is_generated(m.as_str())
            {
                cands.push(Cand {
                    start: m.start(),
                    end: m.end(),
                    prio: 4,
                    seg: Seg::Id(Id::Raw(IdKind::Uuid, m.as_str().to_string())),
                });
            }
        }
        for m in p.iso.find_iter(s) {
            if !times || !bounded(s, m.start(), m.end(), |c| c.is_ascii_digit()) {
                continue;
            }
            let txt = m.as_str();
            if let Some(ms) = timefmt::parse_iso(txt) {
                if self.time_number(ms) {
                    let shape: String = txt
                        .chars()
                        .map(|c| if c.is_ascii_digit() { 'd' } else { c })
                        .collect();
                    cands.push(Cand {
                        start: m.start(),
                        end: m.end(),
                        prio: 5,
                        seg: Seg::Time {
                            at: self.moment(ms),
                            shape,
                        },
                    });
                }
            } else if let Some(day) = timefmt::parse_day(txt) {
                if self.ctx.known.days.contains(txt) {
                    continue;
                }
                let w = &self.ctx.window;
                let start_day = w.start.div_euclid(MS_PER_DAY);
                let end_day = w.end.div_euclid(MS_PER_DAY);
                if (day - start_day).abs() <= HORIZON_MS / MS_PER_DAY {
                    let abs = if day >= start_day && day <= end_day {
                        None
                    } else {
                        Some(txt.to_string())
                    };
                    cands.push(Cand {
                        start: m.start(),
                        end: m.end(),
                        prio: 5,
                        seg: Seg::Day {
                            off: day - start_day,
                            abs,
                        },
                    });
                }
            }
        }
        for m in p.ms13.find_iter(s) {
            if !times || !bounded(s, m.start(), m.end(), |c| c.is_ascii_alphanumeric()) {
                continue;
            }
            if let Ok(ms) = m.as_str().parse::<i64>()
                && self.time_number(ms)
            {
                cands.push(Cand {
                    start: m.start(),
                    end: m.end(),
                    prio: 6,
                    seg: Seg::Time {
                        at: self.moment(ms),
                        shape: "ms".into(),
                    },
                });
            }
        }
        if cands.is_empty() {
            return Text::lit(s);
        }
        cands.sort_by(|a, b| {
            a.start
                .cmp(&b.start)
                .then((b.end - b.start).cmp(&(a.end - a.start)))
                .then(a.prio.cmp(&b.prio))
        });
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

    /// Bytes as text: UTF-8 runs are searched for run-time values like any text, other bytes
    /// become [`Seg::Bytes`], which never equals a text.
    fn bytes_text(&mut self, path: &Path, b: &[u8]) -> Text {
        let mut segs = Vec::new();
        for chunk in b.utf8_chunks() {
            segs.extend(self.text(path, chunk.valid()).0);
            if !chunk.invalid().is_empty() {
                segs.push(Seg::Bytes(chunk.invalid().to_vec()));
            }
        }
        Text::from_segs(segs)
    }

    fn generated_whole(&mut self, path: &Path, s: &str) -> Option<Val> {
        if self.ctx.allow.generated_whole(path) && !s.is_empty() && !self.known_text(s) {
            self.found.push(s.to_string());
            return Some(Val::Str(Text(vec![Seg::Id(Id::Raw(
                IdKind::Gen,
                s.to_string(),
            ))])));
        }
        None
    }

    /// A declared time: relative to the run unless it is known from the inputs or far away.
    fn declared_moment(&self, v: i64, ms: i64) -> Moment {
        let known = self.ctx.known.times.contains(&v) || self.ctx.known.times.contains(&ms);
        if known || !self.ctx.window.in_horizon(ms) {
            Moment::Abs(ms)
        } else {
            self.moment(ms)
        }
    }

    /// How an integral number at this path is read: exactly (`exact` allowance), as a declared
    /// time (`time` allowance), or as epoch milliseconds when its magnitude is near the run.
    fn num_time(&self, path: &Path, v: i64, ms_repr: NumRepr, s_repr: NumRepr) -> Option<Val> {
        if self.ctx.allow.exact(path) {
            return None;
        }
        match self.ctx.allow.time_unit(path) {
            Some(true) => Some(Val::Time(
                s_repr,
                self.declared_moment(v, v.saturating_mul(1000)),
            )),
            Some(false) => Some(Val::Time(ms_repr, self.declared_moment(v, v))),
            None => self
                .time_number(v)
                .then(|| Val::Time(ms_repr, self.moment(v))),
        }
    }

    fn json_number(&self, path: &Path, n: &Number) -> Val {
        integral(n)
            .and_then(|v| self.num_time(path, v, NumRepr::Json, NumRepr::JsonSecs))
            .unwrap_or_else(|| Val::Num(n.clone()))
    }

    fn json(&mut self, path: &mut Path, v: &Value) -> Val {
        if let Value::String(s) = v
            && let Some(g) = self.generated_whole(path, s)
        {
            return g;
        }
        match v {
            Value::Null => Val::Null,
            Value::Bool(b) => Val::Bool(*b),
            Value::Number(n) => self.json_number(path, n),
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
            && let Some(g) = self.generated_whole(path, s)
        {
            return g;
        }
        match b {
            Bson::Null => Val::Null,
            Bson::Boolean(x) => Val::Bool(*x),
            // An int32 cannot hold epoch milliseconds; as epoch seconds only when declared.
            Bson::Int32(i) => match self.ctx.allow.time_unit(path) {
                Some(true) if !self.ctx.allow.exact(path) => {
                    let v = i64::from(*i);
                    Val::Time(NumRepr::Int32Secs, self.declared_moment(v, v * 1000))
                }
                _ => Val::Int32(*i),
            },
            Bson::Int64(i) => self
                .num_time(path, *i, NumRepr::Int64, NumRepr::Int64Secs)
                .unwrap_or(Val::Int64(*i)),
            Bson::Double(f) => f64_integral(*f)
                .and_then(|v| self.num_time(path, v, NumRepr::Double, NumRepr::DoubleSecs))
                .unwrap_or(Val::Double(*f)),
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
                if self.oid_is_generated(&hex) {
                    Val::Oid(Id::Raw(IdKind::Oid, hex))
                } else {
                    Val::Oid(Id::Lit(hex))
                }
            }
            Bson::DateTime(d) => {
                let ms = d.timestamp_millis();
                if !self.ctx.allow.exact(path) && self.time_number(ms) {
                    Val::Time(NumRepr::Date, self.moment(ms))
                } else {
                    Val::Time(NumRepr::Date, Moment::Abs(ms))
                }
            }
            Bson::Binary(bin) => match uuid_string(&bin.subtype, &bin.bytes) {
                Some(u) if matches!(bin.subtype, BinarySubtype::Uuid) => {
                    if self.uuid_is_generated(&u) {
                        Val::Uuid(Id::Raw(IdKind::Uuid, u))
                    } else {
                        Val::Uuid(Id::Lit(u))
                    }
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
        let as_text = self.exact_text
            || self
                .ctx
                .as_text
                .iter()
                .any(|p| p.matches_self_or_ancestor(path));
        if !as_text
            && (s.starts_with('{') || s.starts_with('['))
            && let Ok(parsed) = serde_json::from_str::<Value>(s)
            && serde_json::to_string(&parsed).is_ok_and(|c| c == s)
        {
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
            RawReply::Int(i) => self.json_number(path, &Number::from(*i)),
            RawReply::Bulk(b) => self.df_string(path, b),
            RawReply::Status(s) => {
                Val::Obj(vec![(Text::lit("status"), Val::Str(self.text(path, s)))])
            }
            RawReply::Error(s) => {
                Val::Obj(vec![(Text::lit("error"), Val::Str(self.text(path, s)))])
            }
            RawReply::Double(f) => Number::from_f64(*f)
                .map_or(Val::Str(Text::lit(&f.to_string())), |n| {
                    self.json_number(path, &n)
                }),
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
                // A reply about a byte-sensitive key is exact text too.
                self.exact_text = r
                    .command
                    .iter()
                    .skip(1)
                    .any(|a| self.byte_sensitive_key(a.as_bytes()));
                let v = self.reply(&mut path, &r.reply);
                self.exact_text = false;
                StepCap::Reply(v)
            }
            RawStep::Http(h) => {
                let mut grouped: Vec<(String, Vec<&[u8]>)> = Vec::new();
                for (name, value) in &h.headers {
                    if self.ctx.skip_headers.iter().any(|n| n == name) {
                        continue;
                    }
                    match grouped.iter_mut().find(|(n, _)| n == name) {
                        Some((_, vals)) => vals.push(value),
                        None => grouped.push((name.clone(), vec![value])),
                    }
                }
                grouped.sort_by(|a, b| a.0.cmp(&b.0));
                let headers = grouped
                    .into_iter()
                    .map(|(name, vals)| {
                        let hp = path.with_key("headers").with_key(name.clone());
                        let v = if name == "set-cookie" {
                            self.cookies(&hp, &vals)
                        } else if let [one] = vals.as_slice() {
                            self.header(&hp, &name, one)
                        } else {
                            Val::Arr(vals.iter().map(|v| self.header(&hp, &name, v)).collect())
                        };
                        (name, v)
                    })
                    .collect();
                let content_type = h
                    .headers
                    .iter()
                    .find(|(n, _)| n == "content-type")
                    .map(|(_, v)| String::from_utf8_lossy(v).to_ascii_lowercase())
                    .unwrap_or_default();
                let essence = content_type
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let is_json = essence == "application/json" || essence.ends_with("+json");
                let mut bp = path.with_key("body");
                let body = match (
                    is_json,
                    serde_json::from_slice::<Value>(&h.body),
                    std::str::from_utf8(&h.body),
                ) {
                    (true, Ok(v), _) => Body::Json(self.json(&mut bp, &v)),
                    (_, _, Ok(text)) => Body::Text(self.text(&bp, text)),
                    _ => Body::Bytes(h.body.clone()),
                };
                StepCap::Http {
                    status: h.status,
                    headers,
                    body,
                }
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
        CollCap {
            kind: c.kind.clone(),
            options,
            indexes,
            docs,
        }
    }

    /// An HTTP date (`Expires`, `Last-Modified`, a cookie's `Expires`) as a time with a
    /// one-second precision, or `None` when the text is not one or is not near the run.
    fn http_date(&self, path: &Path, s: &str) -> Option<Text> {
        let ms = timefmt::parse_http_date(s.trim())?;
        if self.ctx.allow.exact(path) || !self.time_number(ms) {
            return None;
        }
        let shape = if s.contains('-') {
            "http-date-dashes"
        } else {
            "http-date"
        };
        Some(Text(vec![Seg::Time {
            at: self.moment(ms),
            shape: shape.into(),
        }]))
    }

    /// One response header value.
    fn header(&mut self, hp: &Path, name: &str, value: &[u8]) -> Val {
        if name == "etag" {
            return Val::str(etag_form(value));
        }
        if let Ok(s) = std::str::from_utf8(value)
            && let Some(t) = self.http_date(hp, s)
        {
            return Val::Str(t);
        }
        if let Ok(s) = std::str::from_utf8(value)
            && let Some(g) = self.generated_whole(hp, s)
        {
            return g;
        }
        Val::Str(self.bytes_text(hp, value))
    }

    /// `Set-Cookie` headers, compared attribute by attribute: an object keyed by cookie name
    /// (a repeated name gets `#2`, `#3`), holding `value` and each attribute by its lower-case
    /// name (`true` for flags such as `httponly`).
    fn cookies(&mut self, hp: &Path, vals: &[&[u8]]) -> Val {
        let mut out: Vec<(Text, Val)> = Vec::new();
        for raw in vals {
            let text = String::from_utf8_lossy(raw);
            let mut parts = text.split(';');
            let first = parts.next().unwrap_or("");
            let (name, value) = first.split_once('=').unwrap_or(("", first));
            let mut key = name.trim().to_string();
            let mut n = 1;
            while out.iter().any(|(k, _)| k.as_plain() == Some(key.as_str())) {
                n += 1;
                key = format!("{}#{n}", name.trim());
            }
            let cp = hp.with_key(key.clone());
            let vp = cp.with_key("value");
            let value = value.trim();
            let v = match self.generated_whole(&vp, value) {
                Some(g) => g,
                None => Val::Str(self.text(&vp, value)),
            };
            let mut fields = vec![(Text::lit("value"), v)];
            for attr in parts {
                let attr = attr.trim();
                if attr.is_empty() {
                    continue;
                }
                let (k, v) = match attr.split_once('=') {
                    Some((k, v)) => (k.trim().to_ascii_lowercase(), Some(v.trim())),
                    None => (attr.to_ascii_lowercase(), None),
                };
                let ap = cp.with_key(k.clone());
                let val = match v {
                    None => Val::Bool(true),
                    Some(v) => match self.http_date(&ap, v) {
                        Some(t) if k == "expires" => Val::Str(t),
                        _ => Val::Str(self.text(&ap, v)),
                    },
                };
                fields.push((Text::lit(&k), val));
            }
            out.push((Text::lit(&key), Val::Obj(fields)));
        }
        Val::Obj(out)
    }

    fn byte_sensitive_key(&self, key: &[u8]) -> bool {
        let k = String::from_utf8_lossy(key);
        self.ctx.byte_sensitive.iter().any(|g| name_glob(g, &k))
    }

    fn entry(&mut self, e: &RawEntry) -> EntryCap {
        let root = Path::root("dragonfly");
        let key = self.bytes_text(&root, &e.key);
        self.exact_text = self.byte_sensitive_key(&e.key);
        let mut vp = root.with_key(key.display()).with_key("value");
        let value = match &e.value {
            RawValue::Str(b) => self.df_string(&mut vp, b),
            RawValue::Hash(pairs) => {
                let mut kv = Vec::with_capacity(pairs.len());
                for (f, v) in pairs {
                    let field = self.bytes_text(&vp, f);
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
                        vp.push_key("score");
                        let score = score
                            .parse::<f64>()
                            .ok()
                            .and_then(Number::from_f64)
                            .map_or_else(|| Val::str(score), |n| self.json_number(&vp, &n));
                        vp.pop();
                        vp.pop();
                        Val::Obj(vec![
                            (Text::lit("member"), member),
                            (Text::lit("score"), score),
                        ])
                    })
                    .collect(),
            ),
            // Fields stay ordered pairs: a stream entry may repeat a field name.
            RawValue::Stream(entries) => Val::Arr(
                entries
                    .iter()
                    .enumerate()
                    .map(|(i, (id, fields))| {
                        vp.push_index(i);
                        let idt = self.text(&vp, id);
                        vp.push_key("fields");
                        let mut pairs = Vec::with_capacity(fields.len());
                        for (j, (f, v)) in fields.iter().enumerate() {
                            vp.push_index(j);
                            let field = self.bytes_text(&vp, f);
                            vp.push_index(1);
                            let val = self.df_string(&mut vp, v);
                            vp.pop();
                            vp.pop();
                            pairs.push(Val::Arr(vec![Val::Str(field), val]));
                        }
                        vp.pop();
                        vp.pop();
                        Val::Obj(vec![
                            (Text::lit("id"), Val::Str(idt)),
                            (Text::lit("fields"), Val::Arr(pairs)),
                        ])
                    })
                    .collect(),
            ),
            RawValue::Other => Val::Unsupported(e.kind.clone()),
        };
        self.exact_text = false;
        // Each TTL relative to the time it was read.
        let ttl = (e.pttl >= 0).then(|| self.moment(e.pttl_at + e.pttl));
        EntryCap {
            key,
            kind: e.kind.clone(),
            ttl,
            value,
        }
    }

    fn run(&mut self, raw: &RawCapture) -> Capture {
        let steps = raw
            .steps
            .iter()
            .enumerate()
            .map(|(i, s)| self.step(i, s))
            .collect();
        let mongo = raw
            .mongo
            .iter()
            .map(|(n, c)| (n.clone(), self.coll(n, c)))
            .collect();
        let dragonfly = raw.dragonfly.iter().map(|e| self.entry(e)).collect();
        Capture {
            steps,
            mongo,
            dragonfly,
        }
    }
}

fn first_known(ctx: &DetectCtx<'_>, v: &str) -> bool {
    let texts = &ctx.known.texts;
    texts.contains(v) || texts.iter().any(|t| t.contains(v))
}

/// Detect run-time values in a raw capture. The result still holds `Id::Raw` atoms; pass it to
/// [`crate::canon::canonicalise`] to order and number it.
pub fn detect(ctx: &DetectCtx<'_>, raw: &RawCapture) -> Capture {
    let mut first = Detector {
        ctx,
        extra: None,
        found: Vec::new(),
        exact_text: false,
    };
    let cap = first.run(raw);
    let mut found: Vec<String> = first
        .found
        .into_iter()
        .filter(|s| s.chars().count() >= MIN_GENERATED_LEN)
        .collect();
    found.retain(|s| !first_known(ctx, s));
    if found.is_empty() {
        return cap;
    }
    // A generated value found at one path is also generated wherever else it appears as a whole
    // value or a whole token (inside other strings and key names), so cross-references are
    // checked; never as a bare substring, and never a value known from the inputs.
    found.sort_by_key(|s| std::cmp::Reverse(s.len()));
    found.dedup();
    let alternation = found
        .iter()
        .map(|s| regex::escape(s))
        .collect::<Vec<_>>()
        .join("|");
    let Ok(extra) = Regex::new(&alternation) else {
        return cap;
    };
    let mut second = Detector {
        ctx,
        extra: Some(extra),
        found: Vec::new(),
        exact_text: false,
    };
    second.run(raw)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub const START: i64 = 1_794_400_000_000; // 2026-11-11T12:26:40.000Z

    pub fn window() -> Window {
        Window {
            start: START,
            end: START + 3000,
            proc_start: START - 60_000,
            seeded_at: START - 1000,
        }
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
            skip_headers: NOISE_HEADERS.iter().map(|s| s.to_string()).collect(),
            as_text: Vec::new(),
            byte_sensitive: Vec::new(),
            seed_offsets: Vec::new(),
        }
    }

    fn text_of(raw: &str, known: &Known) -> Text {
        let p = Patterns::new().unwrap();
        let allow = Allowances::default();
        let c = ctx(&p, known, &allow);
        let mut d = Detector {
            ctx: &c,
            extra: None,
            found: Vec::new(),
            exact_text: false,
        };
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
        assert_eq!(
            text_of(&format!("x:{old}"), &Known::default()).as_plain(),
            Some(format!("x:{old}").as_str())
        );
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
        assert!(
            matches!(&t.0[1], Seg::Time { at: Moment::Rel { off: 1500, abs: None }, shape } if shape == "dddd-dd-ddTdd:dd:dd.dddZ")
        );
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

//! Scenario files (`scenarios/<target>/<area>/<name>.json`) and seed files: format, checks,
//! includes, and conversion of their values for the stores.
//!
//! Files are strict: an unknown key is an error naming the expected keys, MongoDB seed values
//! are canonical Extended JSON (a bare number is an error because its BSON type would be a guess),
//! and every allowance needs a reason.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path as FsPath, PathBuf};

use base64::Engine as _;
use bson::{Bson, Document};
use regex::Regex;
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};

use crate::allow::{AllowKind, Allowances};
use crate::canon::fnv1a64;
use crate::detect::{DEFAULT_HEADERS, Known, Patterns};
use crate::error::{Result, config};
use crate::path::{Pattern, Seg as PSeg, name_glob};
use crate::template::{self, NowFmt};
use crate::timefmt;

pub const SCENARIO_VERSION: u64 = 1;
pub const SEED_VERSION: u64 = 1;
const MAX_TIMEOUT_MS: u64 = 600_000;

// ---------------------------------------------------------------------------------------------
// File shapes.

fn present<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ScenarioFile {
    rig_scenario: u64,
    description: String,
    #[serde(default)]
    restart: bool,
    #[serde(default)]
    allow_scripts: bool,
    #[serde(default)]
    seed: Option<SeedBody>,
    steps: Vec<StepFile>,
    #[serde(default)]
    compare: Option<CompareFile>,
    #[serde(default)]
    allow: Vec<AllowFile>,
    #[serde(default)]
    tolerance_ms: Option<u64>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct SeedBody {
    #[serde(default)]
    include: Vec<String>,
    #[serde(default)]
    mongo: Map<String, Value>,
    #[serde(default)]
    dragonfly: Vec<Vec<Value>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SeedFile {
    rig_seed: u64,
    #[serde(default, rename = "description")]
    _description: Option<String>,
    #[serde(default)]
    include: Vec<String>,
    #[serde(default)]
    mongo: Map<String, Value>,
    #[serde(default)]
    dragonfly: Vec<Vec<Value>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StepFile {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    http: Option<HttpFile>,
    #[serde(default)]
    dragonfly: Option<Vec<Value>>,
    #[serde(default)]
    pause_ms: Option<u64>,
    #[serde(default)]
    wait_for: Option<WaitForFile>,
    #[serde(default)]
    wait_quiet: Option<WaitQuietFile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HttpFile {
    method: String,
    path: String,
    #[serde(default)]
    port: Option<String>,
    #[serde(default)]
    headers: Map<String, Value>,
    #[serde(default, deserialize_with = "present")]
    json: Option<Value>,
    #[serde(default)]
    form: Option<Value>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    body_base64: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    expect: Option<ExpectFile>,
    #[serde(default)]
    save: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExpectFile {
    #[serde(default)]
    status: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WaitForFile {
    #[serde(default)]
    mongo: Option<MongoCondFile>,
    #[serde(default)]
    key: Option<String>,
    timeout_ms: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MongoCondFile {
    collection: String,
    #[serde(default)]
    filter: Option<Value>,
    #[serde(default)]
    count: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WaitQuietFile {
    quiet_ms: u64,
    timeout_ms: u64,
    #[serde(default)]
    ignore_keys: Vec<String>,
    #[serde(default)]
    ignore_collections: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(crate) struct CompareFile {
    #[serde(default)]
    mongo: Option<SelFile>,
    #[serde(default)]
    dragonfly: Option<SelFile>,
    #[serde(default)]
    pub(crate) headers: Option<HeaderSelFile>,
    #[serde(default)]
    as_text: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SelFile {
    #[serde(default)]
    only: Option<Vec<String>>,
    #[serde(default)]
    exclude: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HeaderSelFile {
    #[serde(default)]
    only: Option<Vec<String>>,
    #[serde(default)]
    add: Vec<String>,
    #[serde(default)]
    remove: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AllowFile {
    path: String,
    kind: String,
    reason: String,
    #[serde(default)]
    ms: Option<u64>,
    #[serde(default)]
    pattern: Option<String>,
}

// ---------------------------------------------------------------------------------------------
// Checked shapes.

#[derive(Debug, Clone, Default)]
pub struct Selection {
    pub only: Option<Vec<String>>,
    pub exclude: Vec<String>,
}

impl Selection {
    pub fn includes(&self, name: &str) -> bool {
        self.only
            .as_ref()
            .is_none_or(|o| o.iter().any(|g| name_glob(g, name)))
            && !self.exclude.iter().any(|g| name_glob(g, name))
    }
}

/// A Dragonfly command argument.
#[derive(Debug, Clone)]
pub enum Arg {
    /// Text with `${...}` expressions.
    Text(String),
    Now {
        offset_ms: i64,
        fmt: NowFmt,
    },
}

impl Arg {
    pub fn render(
        &self,
        saved: &BTreeMap<String, String>,
        now: i64,
    ) -> std::result::Result<String, String> {
        match self {
            Arg::Text(t) => template::interpolate(t, saved, now),
            Arg::Now { offset_ms, fmt } => Ok(template::format_now(now, *offset_ms, *fmt)),
        }
    }
}

#[derive(Debug, Clone)]
pub enum ReqBody {
    None,
    Json(Value),
    Form(Vec<(String, String)>),
    Text(String),
    Bytes(Vec<u8>),
}

#[derive(Debug, Clone)]
pub enum SaveFrom {
    Status,
    Header(String),
    Body(Vec<PSeg>),
}

#[derive(Debug, Clone)]
pub struct HttpStep {
    pub method: String,
    pub path: String,
    pub port: Option<String>,
    pub headers: Vec<(String, String)>,
    pub body: ReqBody,
    pub timeout_ms: u64,
    pub expect_status: Option<Vec<u16>>,
    pub save: Vec<(String, SaveFrom)>,
}

#[derive(Debug, Clone)]
pub enum WaitCond {
    Mongo {
        collection: String,
        filter: Value,
        count: Option<u64>,
    },
    Key(String),
}

#[derive(Debug, Clone)]
pub struct WaitQuiet {
    pub quiet_ms: u64,
    pub timeout_ms: u64,
    pub ignore_keys: Vec<String>,
    pub ignore_collections: Vec<String>,
}

#[derive(Debug, Clone)]
pub enum StepKind {
    Http(HttpStep),
    Dragonfly(Vec<Arg>),
    Pause(u64),
    WaitFor { cond: WaitCond, timeout_ms: u64 },
    WaitQuiet(WaitQuiet),
}

impl StepKind {
    pub fn name(&self) -> &'static str {
        match self {
            StepKind::Http(_) => "http",
            StepKind::Dragonfly(_) => "dragonfly",
            StepKind::Pause(_) => "pause_ms",
            StepKind::WaitFor { .. } => "wait_for",
            StepKind::WaitQuiet(_) => "wait_quiet",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Step {
    pub name: Option<String>,
    pub kind: StepKind,
}

#[derive(Debug, Clone)]
pub struct Scenario {
    pub name: String,
    pub file: PathBuf,
    pub description: String,
    pub restart: bool,
    /// `EVAL`, `EVALSHA` and `SCRIPT LOAD|EXISTS` may run in steps and seeds.
    pub allow_scripts: bool,
    /// Collection → documents (Extended JSON, `$rigNow` resolved at seed time).
    pub seed_mongo: Vec<(String, Vec<Value>)>,
    pub seed_dragonfly: Vec<Vec<Arg>>,
    pub steps: Vec<Step>,
    pub mongo: Selection,
    pub dragonfly: Selection,
    pub headers: Vec<String>,
    pub as_text: Vec<Pattern>,
    pub allow: Vec<(Pattern, AllowKind, String)>,
    pub tolerance_ms: i64,
    pub hash: String,
    pub known: Known,
}

impl Scenario {
    pub fn allowances(&self) -> Allowances {
        Allowances::new(self.allow.clone())
    }
}

// ---------------------------------------------------------------------------------------------
// Extended JSON.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ExtMode {
    /// Seed documents: canonical types only, bare numbers are errors.
    Seed,
    /// Query filters: bare numbers allowed (MongoDB compares numbers across types).
    Filter,
}

const TYPE_KEYS: &[&str] = &[
    "$oid",
    "$date",
    "$numberInt",
    "$numberLong",
    "$numberDouble",
    "$numberDecimal",
    "$binary",
    "$uuid",
    "$regularExpression",
    "$timestamp",
    "$minKey",
    "$maxKey",
    "$code",
    "$scope",
    "$symbol",
    "$undefined",
    "$dbPointer",
];

fn rig_now(m: &Map<String, Value>, at: &str) -> std::result::Result<(i64, String), String> {
    for k in m.keys() {
        if k != "$rigNow" && k != "as" {
            return Err(format!(
                "{at}: unexpected key `{k}` next to $rigNow (allowed: $rigNow, as)"
            ));
        }
    }
    let off = m
        .get("$rigNow")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{at}: $rigNow needs an offset string such as \"+60s\" or \"0\""))?;
    let offset = timefmt::parse_offset(off).ok_or_else(|| {
        format!("{at}: bad $rigNow offset `{off}` (use +60s, -5m, 150ms, +2d, 0)")
    })?;
    let fmt = match m.get("as") {
        None => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(_) => return Err(format!("{at}: `as` needs a string")),
    };
    Ok((offset, fmt))
}

/// Convert an Extended JSON value to BSON.
pub fn to_bson(v: &Value, mode: ExtMode, now: i64, at: &str) -> std::result::Result<Bson, String> {
    match v {
        Value::Null => Ok(Bson::Null),
        Value::Bool(b) => Ok(Bson::Boolean(*b)),
        Value::String(s) => Ok(Bson::String(s.clone())),
        Value::Number(n) => match mode {
            ExtMode::Seed => Err(format!(
                "{at}: bare number {n}: write {{\"$numberInt\": \"{n}\"}}, {{\"$numberLong\": \"{n}\"}} or {{\"$numberDouble\": \"{n}\"}} so the BSON type is explicit"
            )),
            ExtMode::Filter => Bson::try_from(v.clone()).map_err(|e| format!("{at}: {e}")),
        },
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(i, x)| to_bson(x, mode, now, &format!("{at}[{i}]")))
            .collect::<std::result::Result<Vec<_>, _>>()
            .map(Bson::Array),
        Value::Object(m) => {
            if m.contains_key("$rigNow") {
                let (offset, fmt) = rig_now(m, at)?;
                let t = now + offset;
                return match fmt.as_str() {
                    "" | "date" => Ok(Bson::DateTime(bson::DateTime::from_millis(t))),
                    "long" => Ok(Bson::Int64(t)),
                    "double" => Ok(Bson::Double(t as f64)),
                    "s" => Ok(i32::try_from(t.div_euclid(1000))
                        .map_or(Bson::Int64(t.div_euclid(1000)), Bson::Int32)),
                    "iso" => Ok(Bson::String(template::format_now(now, offset, NowFmt::Iso))),
                    other => Err(format!(
                        "{at}: $rigNow `as` is `{other}`; in MongoDB values use date (default), long, double, s or iso"
                    )),
                };
            }
            if let Some(first) = m.keys().next()
                && TYPE_KEYS.contains(&first.as_str())
            {
                return Bson::try_from(v.clone())
                    .map_err(|e| format!("{at}: bad {first} value: {e}"));
            }
            to_doc_map(m, mode, now, at).map(Bson::Document)
        }
    }
}

fn to_doc_map(
    m: &Map<String, Value>,
    mode: ExtMode,
    now: i64,
    at: &str,
) -> std::result::Result<Document, String> {
    let mut d = Document::new();
    for (k, x) in m {
        if mode == ExtMode::Seed && k.starts_with('$') {
            return Err(format!(
                "{at}: field `{k}`: unknown type wrapper or a field name starting with $ (not allowed in seed documents)"
            ));
        }
        d.insert(k.clone(), to_bson(x, mode, now, &format!("{at}.{k}"))?);
    }
    Ok(d)
}

pub fn to_doc(
    v: &Value,
    mode: ExtMode,
    now: i64,
    at: &str,
) -> std::result::Result<Document, String> {
    match v {
        Value::Object(m) => to_doc_map(m, mode, now, at),
        _ => Err(format!("{at}: expected an object")),
    }
}

/// Fill `${...}` in strings and `$rigNow` objects of a JSON request body.
pub fn resolve_json(
    v: &Value,
    saved: &BTreeMap<String, String>,
    now: i64,
    at: &str,
) -> std::result::Result<Value, String> {
    Ok(match v {
        Value::String(s) => {
            Value::String(template::interpolate(s, saved, now).map_err(|e| format!("{at}: {e}"))?)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .enumerate()
                .map(|(i, x)| resolve_json(x, saved, now, &format!("{at}[{i}]")))
                .collect::<std::result::Result<_, _>>()?,
        ),
        Value::Object(m) if m.contains_key("$rigNow") => {
            let (offset, fmt) = rig_now(m, at)?;
            match fmt.as_str() {
                "" | "ms" => Value::from(now + offset),
                "s" => Value::from((now + offset).div_euclid(1000)),
                "iso" => Value::String(template::format_now(now, offset, NowFmt::Iso)),
                other => {
                    return Err(format!(
                        "{at}: $rigNow `as` is `{other}`; in JSON use ms (default), s or iso"
                    ));
                }
            }
        }
        Value::Object(m) => {
            let mut out = Map::new();
            for (k, x) in m {
                out.insert(
                    k.clone(),
                    resolve_json(x, saved, now, &format!("{at}.{k}"))?,
                );
            }
            Value::Object(out)
        }
        other => other.clone(),
    })
}

/// Fill `${...}` in the strings of a MongoDB filter (keeps `$rigNow` for [`to_bson`]).
pub fn resolve_filter(
    v: &Value,
    saved: &BTreeMap<String, String>,
    now: i64,
    at: &str,
) -> std::result::Result<Document, String> {
    fn strings(
        v: &Value,
        saved: &BTreeMap<String, String>,
        now: i64,
    ) -> std::result::Result<Value, String> {
        Ok(match v {
            Value::String(s) => Value::String(template::interpolate(s, saved, now)?),
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .map(|x| strings(x, saved, now))
                    .collect::<std::result::Result<_, _>>()?,
            ),
            Value::Object(m) => {
                let mut out = Map::new();
                for (k, x) in m {
                    out.insert(
                        k.clone(),
                        if k == "$rigNow" || k == "as" {
                            x.clone()
                        } else {
                            strings(x, saved, now)?
                        },
                    );
                }
                Value::Object(out)
            }
            other => other.clone(),
        })
    }
    let filled = strings(v, saved, now).map_err(|e| format!("{at}: {e}"))?;
    to_doc(&filled, ExtMode::Filter, now, at)
}

// ---------------------------------------------------------------------------------------------
// Loading.

struct Loader<'a> {
    patterns: &'a Patterns,
    allow_scripts: bool,
    known: Known,
    hash_input: String,
    seen_files: HashSet<PathBuf>,
    mongo: Vec<(String, Vec<Value>)>,
    dragonfly: Vec<Vec<Arg>>,
}

fn read_json(file: &FsPath) -> Result<Value> {
    let text =
        std::fs::read_to_string(file).map_err(|e| config(format!("{}: {e}", file.display())))?;
    serde_json::from_str(&text).map_err(|e| config(format!("{}: {e}", file.display())))
}

fn parse<T: for<'de> Deserialize<'de>>(file: &FsPath, v: &Value) -> Result<T> {
    T::deserialize(v).map_err(|e| config(format!("{}: {e}", file.display())))
}

/// Known values of an input, skipping `$rigNow` (those are run-time values).
fn collect_inputs(p: &Patterns, v: &Value, known: &mut Known) {
    match v {
        Value::Object(m) if m.contains_key("$rigNow") => {}
        Value::Object(m) => {
            for (k, x) in m {
                p.collect_known(k, known);
                collect_inputs(p, x, known);
            }
        }
        Value::Array(items) => items.iter().for_each(|x| collect_inputs(p, x, known)),
        other => crate::detect::collect_known_json(p, other, known),
    }
}

/// A command of a step or seed. Checked against [`crate::dfcmd`] here when its words are
/// written literally, and always again once rendered, when it runs.
fn command(
    args: &[Value],
    at: &str,
    saved: &BTreeSet<String>,
    allow_scripts: bool,
) -> Result<Vec<Arg>> {
    let mut out = Vec::with_capacity(args.len());
    for (i, a) in args.iter().enumerate() {
        let here = format!("{at}[{i}]");
        out.push(match a {
            Value::String(s) => {
                for n in template::saved_names(s).map_err(|e| config(format!("{here}: {e}")))? {
                    if !saved.contains(&n) {
                        return Err(config(format!("{here}: `${{{n}}}` is not saved by an earlier step")));
                    }
                }
                Arg::Text(s.clone())
            }
            Value::Number(n) => Arg::Text(n.to_string()),
            Value::Object(m) if m.contains_key("$rigNow") => {
                let (offset_ms, fmt) = rig_now(m, &here).map_err(config)?;
                let fmt = match fmt.as_str() {
                    "" | "ms" => NowFmt::Ms,
                    "s" => NowFmt::S,
                    "iso" => NowFmt::Iso,
                    other => return Err(config(format!("{here}: $rigNow `as` is `{other}`; in commands use ms (default), s or iso"))),
                };
                Arg::Now { offset_ms, fmt }
            }
            _ => return Err(config(format!("{here}: command arguments are strings, numbers or {{\"$rigNow\": ...}}"))),
        });
    }
    if !matches!(out.first(), Some(Arg::Text(_))) {
        return Err(config(format!(
            "{at}: a command starts with its name, such as [\"SET\", \"key\", \"value\"]"
        )));
    }
    // Literal words (no `${...}`) can be checked now; the rest is checked once rendered.
    let literal: Option<Vec<String>> = out
        .iter()
        .map(|a| match a {
            Arg::Text(t) if !t.contains("${") => Some(t.clone()),
            Arg::Now { .. } => Some("0".into()),
            Arg::Text(_) => None,
        })
        .collect();
    let name_literal = matches!(out.first(), Some(Arg::Text(t)) if !t.contains("${"));
    let checked = match literal {
        Some(words) => crate::dfcmd::check(&words, allow_scripts),
        None if name_literal => {
            // Check the name with its literal words; templated words are checked when rendered.
            let words: Vec<String> = out
                .iter()
                .map(|a| match a {
                    Arg::Text(t) => t.clone(),
                    Arg::Now { .. } => "0".into(),
                })
                .collect();
            crate::dfcmd::check(&words, allow_scripts)
        }
        None => Ok(()),
    };
    checked.map_err(|e| config(format!("{at}: {e}")))?;
    Ok(out)
}

impl Loader<'_> {
    fn seed(&mut self, file: &FsPath, body: SeedBody, depth: usize) -> Result<()> {
        if depth > 8 {
            return Err(config(format!(
                "{}: includes nested too deep",
                file.display()
            )));
        }
        let dir = file.parent().unwrap_or(FsPath::new("."));
        for inc in &body.include {
            let path = dir.join(inc);
            let canon = path
                .canonicalize()
                .map_err(|e| config(format!("{}: include `{inc}`: {e}", file.display())))?;
            if !self.seen_files.insert(canon.clone()) {
                return Err(config(format!(
                    "{}: include `{inc}` is included twice or in a cycle",
                    file.display()
                )));
            }
            let v = read_json(&canon)?;
            self.hash_input.push_str(&v.to_string());
            let sf: SeedFile = parse(&canon, &v)?;
            if sf.rig_seed != SEED_VERSION {
                return Err(config(format!(
                    "{}: rig_seed {} is not supported; this rig reads version {SEED_VERSION}",
                    canon.display(),
                    sf.rig_seed
                )));
            }
            self.seed(
                &canon,
                SeedBody {
                    include: sf.include,
                    mongo: sf.mongo,
                    dragonfly: sf.dragonfly,
                },
                depth + 1,
            )?;
        }
        let at = file.display().to_string();
        for (coll, docs) in body.mongo {
            if coll.is_empty()
                || coll.starts_with("system.")
                || coll.contains('$')
                || coll.contains('\0')
            {
                return Err(config(format!(
                    "{at}: seed.mongo: bad collection name `{coll}`"
                )));
            }
            let docs = match docs {
                Value::Array(d) => d,
                _ => {
                    return Err(config(format!(
                        "{at}: seed.mongo.{coll}: a list of documents"
                    )));
                }
            };
            for (i, d) in docs.iter().enumerate() {
                let here = format!("{at}: seed.mongo.{coll}[{i}]");
                let doc = to_doc(d, ExtMode::Seed, 0, &here).map_err(config)?;
                if !doc.contains_key("_id") {
                    return Err(config(format!(
                        "{here}: seed documents need an explicit _id so both sides start identical"
                    )));
                }
                collect_inputs(self.patterns, d, &mut self.known);
            }
            match self.mongo.iter_mut().find(|(c, _)| *c == coll) {
                Some((_, list)) => list.extend(docs),
                None => self.mongo.push((coll, docs)),
            }
        }
        for (i, c) in body.dragonfly.iter().enumerate() {
            let cmd = command(
                c,
                &format!("{at}: seed.dragonfly[{i}]"),
                &BTreeSet::new(),
                self.allow_scripts,
            )?;
            c.iter()
                .for_each(|v| collect_inputs(self.patterns, v, &mut self.known));
            self.dragonfly.push(cmd);
        }
        Ok(())
    }
}

fn status_list(v: &Value, at: &str) -> Result<Vec<u16>> {
    let one = |x: &Value| {
        x.as_u64()
            .and_then(|n| u16::try_from(n).ok())
            .filter(|n| (100..=599).contains(n))
    };
    match v {
        Value::Array(items) if !items.is_empty() => items
            .iter()
            .map(|x| {
                one(x).ok_or_else(|| config(format!("{at}: status codes are numbers 100-599")))
            })
            .collect(),
        x => one(x)
            .map(|n| vec![n])
            .ok_or_else(|| config(format!("{at}: a status code or a list of them"))),
    }
}

fn check_interp(s: &str, saved: &BTreeSet<String>, at: &str) -> Result<()> {
    for n in template::saved_names(s).map_err(|e| config(format!("{at}: {e}")))? {
        if !saved.contains(&n) {
            return Err(config(format!(
                "{at}: `${{{n}}}` is not saved by an earlier step"
            )));
        }
    }
    Ok(())
}

fn check_json_body(v: &Value, saved: &BTreeSet<String>, at: &str) -> Result<()> {
    match v {
        Value::String(s) => check_interp(s, saved, at),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .try_for_each(|(i, x)| check_json_body(x, saved, &format!("{at}[{i}]"))),
        Value::Object(m) if m.contains_key("$rigNow") => {
            let (_, fmt) = rig_now(m, at).map_err(config)?;
            if !matches!(fmt.as_str(), "" | "ms" | "s" | "iso") {
                return Err(config(format!(
                    "{at}: $rigNow `as` is `{fmt}`; in JSON use ms (default), s or iso"
                )));
            }
            Ok(())
        }
        Value::Object(m) => m
            .iter()
            .try_for_each(|(k, x)| check_json_body(x, saved, &format!("{at}.{k}"))),
        _ => Ok(()),
    }
}

/// Some string in the value holds a `${...}` expression.
fn has_interp(v: &Value) -> bool {
    match v {
        Value::String(s) => template::parse_interp(s)
            .is_ok_and(|p| p.iter().any(|x| !matches!(x, template::Piece::Lit(_)))),
        Value::Array(items) => items.iter().any(has_interp),
        Value::Object(m) => m.values().any(has_interp),
        _ => false,
    }
}

fn timeout(ms: u64, at: &str) -> Result<u64> {
    if ms == 0 || ms > MAX_TIMEOUT_MS {
        return Err(config(format!("{at}: between 1 and {MAX_TIMEOUT_MS} ms")));
    }
    Ok(ms)
}

const METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

fn http_step(
    h: HttpFile,
    at: &str,
    saved: &mut BTreeSet<String>,
    p: &Patterns,
    known: &mut Known,
) -> Result<HttpStep> {
    let method = h.method.to_ascii_uppercase();
    if !METHODS.contains(&method.as_str()) {
        return Err(config(format!(
            "{at}.method: `{}` (use one of {})",
            h.method,
            METHODS.join(", ")
        )));
    }
    if !h.path.starts_with('/') {
        return Err(config(format!(
            "{at}.path: starts with / (the rig adds http://127.0.0.1:<port>)"
        )));
    }
    check_interp(&h.path, saved, &format!("{at}.path"))?;
    p.collect_known(&h.path, known);
    let mut headers = Vec::new();
    for (k, v) in &h.headers {
        let Value::String(s) = v else {
            return Err(config(format!(
                "{at}.headers.{k}: header values are strings"
            )));
        };
        if k.is_empty()
            || !k
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_!#$%&'*+.^`|~".contains(&b))
        {
            return Err(config(format!("{at}.headers: bad header name `{k}`")));
        }
        check_interp(s, saved, &format!("{at}.headers.{k}"))?;
        p.collect_known(s, known);
        headers.push((k.to_ascii_lowercase(), s.clone()));
    }
    let kinds = [
        h.json.is_some(),
        h.form.is_some(),
        h.text.is_some(),
        h.body_base64.is_some(),
    ]
    .iter()
    .filter(|x| **x)
    .count();
    if kinds > 1 {
        return Err(config(format!(
            "{at}: at most one of json, form, text, body_base64"
        )));
    }
    let body = if let Some(j) = h.json {
        check_json_body(&j, saved, &format!("{at}.json"))?;
        collect_inputs(p, &j, known);
        ReqBody::Json(j)
    } else if let Some(f) = h.form {
        let pairs: Vec<(String, String)> = match f {
            Value::Object(m) => m
                .into_iter()
                .map(|(k, v)| match v {
                    Value::String(s) => Ok((k, s)),
                    _ => Err(config(format!("{at}.form.{k}: form values are strings"))),
                })
                .collect::<Result<_>>()?,
            Value::Array(items) => items
                .into_iter()
                .map(|x| match x {
                    Value::Array(pair) => match pair.as_slice() {
                        [Value::String(k), Value::String(v)] => Ok((k.clone(), v.clone())),
                        _ => Err(config(format!(
                            "{at}.form: pairs are [\"name\", \"value\"]"
                        ))),
                    },
                    _ => Err(config(format!(
                        "{at}.form: pairs are [\"name\", \"value\"]"
                    ))),
                })
                .collect::<Result<_>>()?,
            _ => {
                return Err(config(format!(
                    "{at}.form: an object of strings or a list of [name, value] pairs"
                )));
            }
        };
        for (k, v) in &pairs {
            check_interp(k, saved, &format!("{at}.form"))?;
            check_interp(v, saved, &format!("{at}.form"))?;
            p.collect_known(v, known);
        }
        ReqBody::Form(pairs)
    } else if let Some(t) = h.text {
        check_interp(&t, saved, &format!("{at}.text"))?;
        p.collect_known(&t, known);
        ReqBody::Text(t)
    } else if let Some(b) = h.body_base64 {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&b)
            .map_err(|e| config(format!("{at}.body_base64: {e}")))?;
        p.collect_known(&String::from_utf8_lossy(&bytes), known);
        ReqBody::Bytes(bytes)
    } else {
        ReqBody::None
    };
    let expect_status = match h.expect.and_then(|e| e.status) {
        Some(v) => Some(status_list(&v, &format!("{at}.expect.status"))?),
        None => None,
    };
    let mut save = Vec::new();
    for (name, from) in h.save {
        let mut chars = name.chars();
        if !chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
            || name.starts_with("now")
        {
            return Err(config(format!(
                "{at}.save: bad name `{name}` (letters, digits, _; not starting with now)"
            )));
        }
        let src = if from == "status" {
            SaveFrom::Status
        } else if let Some(hn) = from.strip_prefix("headers.") {
            SaveFrom::Header(hn.to_ascii_lowercase())
        } else if from == "body" || from.starts_with("body.") || from.starts_with("body[") {
            let pat =
                Pattern::parse(&from).map_err(|e| config(format!("{at}.save.{name}: {e}")))?;
            let segs = pat
                .literal_segments()
                .ok_or_else(|| config(format!("{at}.save.{name}: no wildcards in a save path")))?;
            SaveFrom::Body(segs.into_iter().skip(1).collect())
        } else {
            return Err(config(format!(
                "{at}.save.{name}: `{from}` (use status, headers.<name>, body or body.<path>)"
            )));
        };
        saved.insert(name.clone());
        save.push((name, src));
    }
    Ok(HttpStep {
        method,
        path: h.path,
        port: h.port,
        headers,
        body,
        timeout_ms: timeout(h.timeout_ms.unwrap_or(30_000), &format!("{at}.timeout_ms"))?,
        expect_status,
        save,
    })
}

fn selection(s: Option<SelFile>) -> Selection {
    s.map(|f| Selection {
        only: f.only,
        exclude: f.exclude,
    })
    .unwrap_or_default()
}

pub(crate) fn headers(h: Option<HeaderSelFile>, at: &str) -> Result<Vec<String>> {
    let Some(h) = h else {
        return Ok(DEFAULT_HEADERS.iter().map(|s| s.to_string()).collect());
    };
    for n in h.only.iter().flatten().chain(&h.add).chain(&h.remove) {
        if n.is_empty() || *n != n.to_ascii_lowercase() {
            return Err(config(format!("{at}: header names are lower case (`{n}`)")));
        }
    }
    if h.only.is_some() && (!h.add.is_empty() || !h.remove.is_empty()) {
        return Err(config(format!("{at}: use either only, or add/remove")));
    }
    let mut list: Vec<String> = h
        .only
        .unwrap_or_else(|| DEFAULT_HEADERS.iter().map(|s| s.to_string()).collect());
    for a in h.add {
        if !list.contains(&a) {
            list.push(a);
        }
    }
    for r in &h.remove {
        if !list.contains(r) {
            return Err(config(format!(
                "{at}: remove `{r}`: not in the list ({})",
                list.join(", ")
            )));
        }
    }
    list.retain(|x| !h.remove.contains(x));
    Ok(list)
}

pub(crate) fn allowances(
    list: Vec<AllowFile>,
    at: &str,
) -> Result<Vec<(Pattern, AllowKind, String)>> {
    let mut out = Vec::new();
    for (i, a) in list.into_iter().enumerate() {
        let here = format!("{at}: allow[{i}]");
        let path = Pattern::parse(&a.path).map_err(|e| config(format!("{here}.path: {e}")))?;
        if a.reason.trim().chars().count() < 8 {
            return Err(config(format!(
                "{here}.reason: say why this difference is acceptable (a sentence a reviewer can check)"
            )));
        }
        let kind = match a.kind.as_str() {
            "ignore" => AllowKind::Ignore,
            "set" => AllowKind::Set,
            "tolerance" => {
                let ms =
                    a.ms.ok_or_else(|| config(format!("{here}: tolerance needs \"ms\"")))?;
                AllowKind::Tolerance(
                    i64::try_from(ms).map_err(|_| config(format!("{here}.ms: too large")))?,
                )
            }
            "generated" => match &a.pattern {
                Some(p) => AllowKind::Generated(Some(
                    Regex::new(p).map_err(|e| config(format!("{here}.pattern: {e}")))?,
                )),
                None => AllowKind::Generated(None),
            },
            other => {
                return Err(config(format!(
                    "{here}.kind: `{other}` (use ignore, set, tolerance or generated)"
                )));
            }
        };
        if a.ms.is_some() && !matches!(kind, AllowKind::Tolerance(_)) {
            return Err(config(format!(
                "{here}: \"ms\" only goes with kind tolerance"
            )));
        }
        if a.pattern.is_some() && !matches!(kind, AllowKind::Generated(_)) {
            return Err(config(format!(
                "{here}: \"pattern\" only goes with kind generated"
            )));
        }
        out.push((path, kind, a.reason));
    }
    Ok(out)
}

/// Read and check one scenario.
pub fn load(rig_dir: &FsPath, target: &str, name: &str, patterns: &Patterns) -> Result<Scenario> {
    let file = rig_dir
        .join("scenarios")
        .join(target)
        .join(format!("{name}.json"));
    let v = read_json(&file)?;
    let f: ScenarioFile = parse(&file, &v)?;
    let at = file.display().to_string();
    if f.rig_scenario != SCENARIO_VERSION {
        return Err(config(format!(
            "{at}: rig_scenario {} is not supported; this rig reads version {SCENARIO_VERSION}",
            f.rig_scenario
        )));
    }
    if f.description.trim().is_empty() {
        return Err(config(format!(
            "{at}: description: say what the scenario checks"
        )));
    }
    let mut loader = Loader {
        patterns,
        allow_scripts: f.allow_scripts,
        known: Known::default(),
        hash_input: v.to_string(),
        seen_files: HashSet::new(),
        mongo: Vec::new(),
        dragonfly: Vec::new(),
    };
    if let Ok(c) = file.canonicalize() {
        loader.seen_files.insert(c);
    }
    loader.seed(&file, f.seed.unwrap_or_default(), 0)?;
    let mut saved: BTreeSet<String> = BTreeSet::new();
    let mut steps = Vec::with_capacity(f.steps.len());
    for (i, s) in f.steps.into_iter().enumerate() {
        let here = format!("{at}: steps[{i}]");
        let given: Vec<&str> = [
            s.http.as_ref().map(|_| "http"),
            s.dragonfly.as_ref().map(|_| "dragonfly"),
            s.pause_ms.map(|_| "pause_ms"),
            s.wait_for.as_ref().map(|_| "wait_for"),
            s.wait_quiet.as_ref().map(|_| "wait_quiet"),
        ]
        .into_iter()
        .flatten()
        .collect();
        if given.len() != 1 {
            return Err(config(format!(
                "{here}: a step has exactly one of http, dragonfly, pause_ms, wait_for, wait_quiet (found: {})",
                if given.is_empty() {
                    "none".to_string()
                } else {
                    given.join(", ")
                }
            )));
        }
        let kind = if let Some(h) = s.http {
            StepKind::Http(http_step(
                h,
                &format!("{here}.http"),
                &mut saved,
                patterns,
                &mut loader.known,
            )?)
        } else if let Some(c) = s.dragonfly {
            c.iter()
                .for_each(|x| collect_inputs(patterns, x, &mut loader.known));
            StepKind::Dragonfly(command(
                &c,
                &format!("{here}.dragonfly"),
                &saved,
                f.allow_scripts,
            )?)
        } else if let Some(ms) = s.pause_ms {
            StepKind::Pause(timeout(ms, &format!("{here}.pause_ms"))?)
        } else if let Some(w) = s.wait_for {
            let timeout_ms = timeout(w.timeout_ms, &format!("{here}.wait_for.timeout_ms"))?;
            let cond = match (w.mongo, w.key) {
                (Some(m), None) => {
                    let filter = m.filter.unwrap_or(Value::Object(Map::new()));
                    // With `${...}` inside (such as `{"$oid": "${item}"}`) the filter is
                    // only valid once filled in; it is converted again when the step runs.
                    if !has_interp(&filter) {
                        to_doc(
                            &filter,
                            ExtMode::Filter,
                            0,
                            &format!("{here}.wait_for.mongo.filter"),
                        )
                        .map_err(config)?;
                    }
                    check_json_body(&filter, &saved, &format!("{here}.wait_for.mongo.filter"))?;
                    collect_inputs(patterns, &filter, &mut loader.known);
                    WaitCond::Mongo {
                        collection: m.collection,
                        filter,
                        count: m.count,
                    }
                }
                (None, Some(k)) => {
                    check_interp(&k, &saved, &format!("{here}.wait_for.key"))?;
                    patterns.collect_known(&k, &mut loader.known);
                    WaitCond::Key(k)
                }
                _ => {
                    return Err(config(format!(
                        "{here}.wait_for: exactly one of mongo or key"
                    )));
                }
            };
            StepKind::WaitFor { cond, timeout_ms }
        } else if let Some(q) = s.wait_quiet {
            let timeout_ms = timeout(q.timeout_ms, &format!("{here}.wait_quiet.timeout_ms"))?;
            if q.quiet_ms == 0 || q.quiet_ms >= timeout_ms {
                return Err(config(format!(
                    "{here}.wait_quiet: quiet_ms must be above 0 and below timeout_ms"
                )));
            }
            StepKind::WaitQuiet(WaitQuiet {
                quiet_ms: q.quiet_ms,
                timeout_ms,
                ignore_keys: q.ignore_keys,
                ignore_collections: q.ignore_collections,
            })
        } else {
            return Err(config(format!("{here}: empty step")));
        };
        steps.push(Step { name: s.name, kind });
    }
    let compare = f.compare.unwrap_or_default();
    let as_text = compare
        .as_text
        .iter()
        .map(|p| Pattern::parse(p).map_err(|e| config(format!("{at}: compare.as_text: {e}"))))
        .collect::<Result<Vec<_>>>()?;
    let tolerance_ms = i64::try_from(f.tolerance_ms.unwrap_or(2000))
        .map_err(|_| config(format!("{at}: tolerance_ms too large")))?;
    Ok(Scenario {
        name: name.to_string(),
        file,
        description: f.description,
        restart: f.restart,
        allow_scripts: f.allow_scripts,
        seed_mongo: loader.mongo,
        seed_dragonfly: loader.dragonfly,
        steps,
        mongo: selection(compare.mongo),
        dragonfly: selection(compare.dragonfly),
        headers: headers(compare.headers, &format!("{at}: compare.headers"))?,
        as_text,
        allow: allowances(f.allow, &at)?,
        tolerance_ms,
        hash: format!("fnv1a64:{:016x}", fnv1a64(loader.hash_input.as_bytes())),
        known: loader.known,
    })
}

/// Every scenario of a target, by name (`area/name`), sorted. Paths with a component starting
/// with `_` or `.` (such as `_seeds/`) are not scenarios.
pub fn discover(rig_dir: &FsPath, target: &str) -> Result<Vec<String>> {
    let root = rig_dir.join("scenarios").join(target);
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) if dir == root && e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(config(format!("{}: {e}", dir.display()))),
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('_') || name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Some(stem) = name.strip_suffix(".json") {
                let rel = path
                    .parent()
                    .and_then(|p| p.strip_prefix(&root).ok())
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                out.push(if rel.is_empty() {
                    stem.to_string()
                } else {
                    format!("{rel}/{stem}")
                });
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Scenario names matching any filter (a glob, an exact name, or a directory prefix).
pub fn select(all: &[String], filters: &[String]) -> Vec<String> {
    if filters.is_empty() {
        return all.to_vec();
    }
    all.iter()
        .filter(|n| {
            filters.iter().any(|f| {
                let f = f.trim_end_matches(".json").trim_end_matches('/');
                name_glob(f, n) || n.starts_with(&format!("{f}/"))
            })
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn seeds_must_name_the_bson_type() {
        let err = to_doc(&json!({"_id": "a", "n": 5}), ExtMode::Seed, 0, "doc").unwrap_err();
        assert!(err.contains("$numberInt") && err.contains("doc.n"), "{err}");
        let d = to_doc(
            &json!({"_id": {"$oid": "650000000000000000000001"}, "n": {"$numberLong": "5"}, "at": {"$date": "2026-01-01T00:00:00Z"}}),
            ExtMode::Seed,
            0,
            "doc",
        )
        .unwrap();
        assert!(matches!(d.get("n"), Some(Bson::Int64(5))));
        assert!(matches!(d.get("at"), Some(Bson::DateTime(_))));
        assert!(to_doc(&json!({"$where": "x"}), ExtMode::Seed, 0, "doc").is_err());
        let f = to_doc(&json!({"n": {"$gt": 5}}), ExtMode::Filter, 0, "f").unwrap();
        assert!(f.get_document("n").is_ok());
    }

    #[test]
    fn rig_now_values() {
        let now = 1_000_000;
        let d = to_doc(&json!({"a": {"$rigNow": "+60s"}, "b": {"$rigNow": "-1s", "as": "double"}, "c": {"$rigNow": "0", "as": "iso"}}), ExtMode::Seed, now, "d").unwrap();
        assert_eq!(
            d.get("a"),
            Some(&Bson::DateTime(bson::DateTime::from_millis(now + 60_000)))
        );
        assert_eq!(d.get("b"), Some(&Bson::Double((now - 1000) as f64)));
        assert_eq!(
            d.get("c"),
            Some(&Bson::String("1970-01-01T00:16:40.000Z".into()))
        );
        assert!(
            to_doc(
                &json!({"a": {"$rigNow": "+60s", "as": "ms"}}),
                ExtMode::Seed,
                now,
                "d"
            )
            .is_err()
        );
        let j = resolve_json(
            &json!({"t": {"$rigNow": "+1s"}, "s": "id=${x}"}),
            &[("x".to_string(), "7".to_string())].into(),
            now,
            "j",
        )
        .unwrap();
        assert_eq!(j, json!({"t": 1_001_000, "s": "id=7"}));
    }

    #[test]
    fn filters_with_saved_values_are_converted_when_filled() {
        let filter = json!({"item": {"$oid": "${item}"}, "n": {"$gte": 2}});
        assert!(has_interp(&filter));
        assert!(to_doc(&filter, ExtMode::Filter, 0, "f").is_err());
        let saved: BTreeMap<String, String> =
            [("item".to_string(), "650000000000000000000010".to_string())].into();
        let d = resolve_filter(&filter, &saved, 0, "f").unwrap();
        assert!(d.get_object_id("item").is_ok(), "{d}");
        assert!(has_interp(&json!(["${now_ms+5s}"])));
        assert!(!has_interp(&json!({"n": 1, "s": "plain $ text"})));
    }

    #[test]
    fn commands_are_checked() {
        assert!(
            command(&[json!("SELECT"), json!("2")], "c", &BTreeSet::new(), false)
                .unwrap_err()
                .to_string()
                .contains("not allowed")
        );
        assert!(command(&[json!("flushall")], "c", &BTreeSet::new(), false).is_err());
        assert!(
            command(
                &[
                    json!("COPY"),
                    json!("a"),
                    json!("b"),
                    json!("db"),
                    json!("3")
                ],
                "c",
                &BTreeSet::new(),
                false
            )
            .is_err()
        );
        assert!(
            command(
                &[json!("SET"), json!("k"), json!(5)],
                "c",
                &BTreeSet::new(),
                false
            )
            .is_ok()
        );
        assert!(
            command(
                &[json!("GET"), json!("${missing}")],
                "c",
                &BTreeSet::new(),
                false
            )
            .is_err()
        );
        // A saved value as the name is checked when the step runs.
        let saved: BTreeSet<String> = ["cmd".to_string()].into();
        assert!(
            command(
                &[json!("${cmd}"), json!("GET"), json!("x")],
                "c",
                &saved,
                false
            )
            .is_ok()
        );
        // Scripts need the flag.
        assert!(
            command(
                &[json!("EVAL"), json!("return 1"), json!("0")],
                "c",
                &saved,
                false
            )
            .is_err()
        );
        assert!(
            command(
                &[json!("EVAL"), json!("return 1"), json!("0")],
                "c",
                &saved,
                true
            )
            .is_ok()
        );
    }

    #[test]
    fn selection_and_filters() {
        let all: Vec<String> = ["items/create", "items/jobs", "users/list"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            select(&all, &["items".into()]),
            vec!["items/create", "items/jobs"]
        );
        assert_eq!(select(&all, &["*/list".into()]), vec!["users/list"]);
        assert_eq!(
            select(&all, &["items/create.json".into()]),
            vec!["items/create"]
        );
        let s = Selection {
            only: None,
            exclude: vec!["logs*".into()],
        };
        assert!(s.includes("items") && !s.includes("logs_2026"));
    }
}

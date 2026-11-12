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
use crate::detect::{Known, NOISE_HEADERS, Patterns};
use crate::error::{Result, config};
use crate::path::{Pattern, Seg as PSeg, name_glob};
use crate::template::{self, NowFmt};
use crate::timefmt;

pub const SCENARIO_VERSION: u64 = 3;
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
    /// The scenario does not depend on the process's in-memory state: it may run in one process
    /// with the other scenarios of the run that say so (stores reset between them).
    #[serde(default)]
    share_process: bool,
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
    #[serde(default)]
    relation_tolerance_ms: Option<u64>,
    /// The mock's routes and seeds for this scenario (over the target's).
    #[serde(default)]
    mock: Option<Value>,
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
    #[serde(default)]
    postgres: Vec<String>,
    /// Files written into the side's data directory (`{data_dir}`) before it starts.
    #[serde(default)]
    files: BTreeMap<String, FileSeed>,
}

/// One seeded file: exactly one of `text`, `base64`, `json`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileSeed {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    base64: Option<String>,
    #[serde(default, deserialize_with = "present")]
    json: Option<Value>,
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
    #[serde(default)]
    postgres: Vec<String>,
    #[serde(default)]
    files: BTreeMap<String, FileSeed>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StepFile {
    #[serde(default)]
    socketio: Option<crate::socketio::Action>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    http: Option<HttpFile>,
    #[serde(default)]
    dragonfly: Option<Vec<Value>>,
    #[serde(default)]
    sql: Option<String>,
    #[serde(default)]
    pause_ms: Option<u64>,
    #[serde(default)]
    wait_for: Option<WaitForFile>,
    #[serde(default)]
    wait_quiet: Option<WaitQuietFile>,
    #[serde(default)]
    eventsub: Option<EventsubFile>,
    #[serde(default)]
    polar: Option<PolarFile>,
    #[serde(default)]
    wait_call: Option<WaitCallFile>,
}

/// How a signed webhook is delivered (shared by `eventsub` and `polar`; their files carry
/// these fields themselves, since serde's `flatten` and `deny_unknown_fields` do not mix).
#[derive(Default)]
struct DeliveryFile {
    /// Sign with this secret instead of the target's (a bad-signature case).
    secret: Option<String>,
    /// Send this signature header as is.
    signature: Option<String>,
    /// Extra or replaced headers; `null` removes one.
    headers: Map<String, Value>,
    /// The exact body instead of the built envelope (a string is sent as is).
    raw: Option<Value>,
    port: Option<String>,
    path: Option<String>,
    timeout_ms: Option<u64>,
    expect: Option<ExpectFile>,
    save: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EventsubFile {
    #[serde(default)]
    r#type: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    condition: Option<Value>,
    #[serde(default)]
    event: Option<Value>,
    /// `notification` (default), `webhook_callback_verification` or `revocation`.
    #[serde(default)]
    message_type: Option<String>,
    #[serde(default)]
    message_id: Option<String>,
    /// ISO text or `{"$rigNow": "-15m", "as": "iso"}`; default the time the step runs.
    #[serde(default)]
    timestamp: Option<Value>,
    /// `Twitch-Eventsub-Message-Retry` (default 0).
    #[serde(default)]
    retry: Option<u32>,
    /// Fields over the generated subscription object.
    #[serde(default)]
    subscription: Option<Value>,
    #[serde(default)]
    challenge: Option<String>,
    #[serde(default)]
    secret: Option<String>,
    #[serde(default)]
    signature: Option<String>,
    #[serde(default)]
    headers: Map<String, Value>,
    #[serde(default, deserialize_with = "present")]
    raw: Option<Value>,
    #[serde(default)]
    port: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    expect: Option<ExpectFile>,
    #[serde(default)]
    save: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PolarFile {
    #[serde(default)]
    r#type: Option<String>,
    #[serde(default)]
    data: Option<Value>,
    /// `webhook-id` (default derived from the scenario and the step).
    #[serde(default)]
    id: Option<String>,
    /// `webhook-timestamp` in seconds (default the time the step runs).
    #[serde(default)]
    timestamp_s: Option<Value>,
    #[serde(default)]
    secret: Option<String>,
    #[serde(default)]
    signature: Option<String>,
    #[serde(default)]
    headers: Map<String, Value>,
    #[serde(default, deserialize_with = "present")]
    raw: Option<Value>,
    #[serde(default)]
    port: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    expect: Option<ExpectFile>,
    #[serde(default)]
    save: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WaitCallFile {
    /// A provider host (`api.twitch.tv`) or a provider name (`twitch`); one is required.
    #[serde(default)]
    host: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    query: Map<String, Value>,
    #[serde(default)]
    body: Option<Value>,
    #[serde(default)]
    body_contains: Option<String>,
    #[serde(default)]
    count: Option<u64>,
    timeout_ms: u64,
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
    /// Provider name → `ordered`, `multiset` or `ignore` (overrides the provider table).
    #[serde(default)]
    calls: BTreeMap<String, String>,
    /// More request headers of outbound calls to compare.
    #[serde(default)]
    call_headers: Option<HeaderSelFile>,
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
    /// Names from the noise list to compare after all.
    #[serde(default)]
    include: Vec<String>,
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
    #[serde(default)]
    unit: Option<String>,
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
    /// Bytes given as `{"$rigBytes": "<base64>"}` (values that are not UTF-8, without `EVAL`).
    Bytes(Vec<u8>),
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
    ) -> std::result::Result<Vec<u8>, String> {
        match self {
            Arg::Text(t) => template::interpolate(t, saved, now).map(String::into_bytes),
            Arg::Bytes(b) => Ok(b.clone()),
            Arg::Now { offset_ms, fmt } => {
                Ok(template::format_now(now, *offset_ms, *fmt).into_bytes())
            }
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

/// How a signed webhook is sent and its answer read.
#[derive(Debug, Clone)]
pub struct Delivery {
    pub secret: Option<String>,
    pub signature: Option<String>,
    pub headers: Vec<(String, Option<String>)>,
    pub raw: Option<Value>,
    pub port: Option<String>,
    pub path: Option<String>,
    pub timeout_ms: u64,
    pub expect_status: Option<Vec<u16>>,
    pub save: Vec<(String, SaveFrom)>,
}

/// A Twitch EventSub delivery to the bot's ingress.
#[derive(Debug, Clone)]
pub struct EventsubStep {
    pub sub_type: String,
    pub version: String,
    pub condition: Value,
    pub event: Value,
    pub message_type: String,
    /// Default: derived from the scenario and the step (the same on every run and side).
    pub message_id: String,
    pub timestamp: Option<Value>,
    pub retry: u32,
    pub subscription: Option<Value>,
    pub challenge: String,
    pub delivery: Delivery,
}

/// A Polar webhook (standardwebhooks) to the API.
#[derive(Debug, Clone)]
pub struct PolarStep {
    pub event_type: String,
    pub data: Value,
    pub id: String,
    pub timestamp_s: Option<Value>,
    pub delivery: Delivery,
}

/// Which recorded calls a `wait_call` step waits for.
#[derive(Debug, Clone)]
pub struct CallCond {
    /// Matches on host (compiled like a mock route).
    pub route: crate::mock::route::Route,
    pub provider: Option<String>,
    pub count: u64,
    pub text: String,
}

#[derive(Debug, Clone)]
pub enum StepKind {
    Socketio(crate::socketio::Action),
    Http(HttpStep),
    Dragonfly(Vec<Arg>),
    Sql(String),
    Pause(u64),
    WaitFor {
        cond: WaitCond,
        timeout_ms: u64,
    },
    WaitQuiet(WaitQuiet),
    Eventsub(Box<EventsubStep>),
    Polar(Box<PolarStep>),
    WaitCall {
        cond: Box<CallCond>,
        timeout_ms: u64,
    },
}

impl StepKind {
    pub fn name(&self) -> &'static str {
        match self {
            StepKind::Socketio(_) => "socketio",
            StepKind::Http(_) => "http",
            StepKind::Dragonfly(_) => "dragonfly",
            StepKind::Sql(_) => "sql",
            StepKind::Pause(_) => "pause_ms",
            StepKind::WaitFor { .. } => "wait_for",
            StepKind::WaitQuiet(_) => "wait_quiet",
            StepKind::Eventsub(_) => "eventsub",
            StepKind::Polar(_) => "polar",
            StepKind::WaitCall { .. } => "wait_call",
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
    /// Independent of process state: may share a process (see [`ScenarioFile`]).
    pub share_process: bool,
    /// `EVAL`, `EVALSHA` and `SCRIPT LOAD|EXISTS` may run in steps and seeds.
    pub allow_scripts: bool,
    /// Collection → documents (Extended JSON, `$rigNow` resolved at seed time).
    pub seed_mongo: Vec<(String, Vec<Value>)>,
    pub seed_dragonfly: Vec<Vec<Arg>>,
    pub seed_postgres: Vec<String>,
    pub steps: Vec<Step>,
    pub mongo: Selection,
    pub dragonfly: Selection,
    /// Response headers not compared (the noise list minus `compare.headers.include`).
    pub skip_headers: Vec<String>,
    pub as_text: Vec<Pattern>,
    pub allow: Vec<(Pattern, AllowKind, String)>,
    pub tolerances: crate::compare::Tolerances,
    pub hash: String,
    /// Each input file (the scenario, then every seed it includes) with its own hash.
    pub files: Vec<(String, String)>,
    /// Every `$rigNow` offset of the seed (`true`: written as epoch seconds).
    pub seed_offsets: Vec<(i64, bool)>,
    pub known: Known,
    /// The scenario's `mock` section (merged over the target's when it runs).
    pub mock: crate::mock::MockSpec,
    pub call_rules: crate::detect::CallRules,
    /// Files for the side's data directory: (relative path, bytes).
    pub seed_files: Vec<(String, Vec<u8>)>,
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

/// A file's name relative to the target's scenario directory (`items/create.json`,
/// `_seeds/users.json`), or its full path when it lies elsewhere.
fn relative_name(root: &FsPath, file: &FsPath) -> String {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    file.strip_prefix(&root)
        .unwrap_or(file)
        .to_string_lossy()
        .replace('\\', "/")
}

struct Loader<'a> {
    patterns: &'a Patterns,
    allow_scripts: bool,
    known: Known,
    hash_input: String,
    seen_files: HashSet<PathBuf>,
    /// The scenario directory of the target: file hashes are named relative to it.
    root: PathBuf,
    files: Vec<(String, String)>,
    seed_offsets: Vec<(i64, bool)>,
    mongo: Vec<(String, Vec<Value>)>,
    dragonfly: Vec<Vec<Arg>>,
    postgres: Vec<String>,
    data_files: Vec<(String, Vec<u8>)>,
}

fn read_json(file: &FsPath) -> Result<Value> {
    let text =
        std::fs::read_to_string(file).map_err(|e| config(format!("{}: {e}", file.display())))?;
    serde_json::from_str(&text).map_err(|e| config(format!("{}: {e}", file.display())))
}

fn parse<T: for<'de> Deserialize<'de>>(file: &FsPath, v: &Value) -> Result<T> {
    T::deserialize(v).map_err(|e| config(format!("{}: {e}", file.display())))
}

/// The `$rigNow` offsets inside a seed document.
fn seed_offsets(v: &Value, out: &mut Vec<(i64, bool)>) {
    match v {
        Value::Object(m) if m.contains_key("$rigNow") => {
            if let Ok((off, fmt)) = rig_now(m, "") {
                out.push((off, fmt == "s"));
            }
        }
        Value::Object(m) => m.values().for_each(|x| seed_offsets(x, out)),
        Value::Array(items) => items.iter().for_each(|x| seed_offsets(x, out)),
        _ => {}
    }
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
                    if !saved.contains(&n) && !template::is_side_value(&n) {
                        return Err(config(format!("{here}: `${{{n}}}` is not saved by an earlier step")));
                    }
                }
                Arg::Text(s.clone())
            }
            Value::Number(n) => Arg::Text(n.to_string()),
            Value::Object(m) if m.contains_key("$rigBytes") => {
                let b = m
                    .get("$rigBytes")
                    .and_then(Value::as_str)
                    .filter(|_| m.len() == 1)
                    .ok_or_else(|| config(format!("{here}: {{\"$rigBytes\": \"<base64>\"}} and nothing else")))?;
                Arg::Bytes(
                    base64::engine::general_purpose::STANDARD
                        .decode(b)
                        .map_err(|e| config(format!("{here}: $rigBytes: {e}")))?,
                )
            }
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
            _ => return Err(config(format!("{here}: command arguments are strings, numbers, {{\"$rigNow\": ...}} or {{\"$rigBytes\": \"<base64>\"}}"))),
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
            Arg::Bytes(b) => Some(String::from_utf8_lossy(b).to_string()),
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
                    Arg::Bytes(b) => String::from_utf8_lossy(b).to_string(),
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
            self.files.push((
                relative_name(&self.root, &canon),
                format!("fnv1a64:{:016x}", fnv1a64(v.to_string().as_bytes())),
            ));
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
                    postgres: sf.postgres,
                    files: sf.files,
                },
                depth + 1,
            )?;
        }
        for sql in &body.postgres {
            collect_inputs(self.patterns, &Value::String(sql.clone()), &mut self.known);
        }
        self.postgres.extend(body.postgres);
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
                seed_offsets(d, &mut self.seed_offsets);
            }
            match self.mongo.iter_mut().find(|(c, _)| *c == coll) {
                Some((_, list)) => list.extend(docs),
                None => self.mongo.push((coll, docs)),
            }
        }
        for (rel, f) in body.files {
            let here = format!("{at}: seed.files[{rel:?}]");
            let path = FsPath::new(&rel);
            if rel.is_empty()
                || path.is_absolute()
                || path
                    .components()
                    .any(|c| !matches!(c, std::path::Component::Normal(_)))
            {
                return Err(config(format!(
                    "{here}: a relative path inside the data directory (no .., no leading /)"
                )));
            }
            let bytes = match (f.text, f.base64, f.json) {
                (Some(t), None, None) => t.into_bytes(),
                (None, Some(b), None) => base64::engine::general_purpose::STANDARD
                    .decode(b)
                    .map_err(|e| config(format!("{here}.base64: {e}")))?,
                (None, None, Some(j)) => serde_json::to_vec_pretty(&j)
                    .map_err(|e| config(format!("{here}.json: {e}")))?,
                _ => {
                    return Err(config(format!("{here}: exactly one of text, base64, json")));
                }
            };
            self.patterns
                .collect_known(&String::from_utf8_lossy(&bytes), &mut self.known);
            self.data_files.retain(|(p, _)| *p != rel);
            self.data_files.push((rel, bytes));
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
            for a in &cmd {
                if let Arg::Now { offset_ms, fmt } = a {
                    self.seed_offsets.push((*offset_ms, *fmt == NowFmt::S));
                }
            }
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
        if !saved.contains(&n) && !template::is_side_value(&n) {
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
    let save = save_list(h.save, at, saved)?;
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

fn save_list(
    list: BTreeMap<String, String>,
    at: &str,
    saved: &mut BTreeSet<String>,
) -> Result<Vec<(String, SaveFrom)>> {
    let mut save = Vec::new();
    for (name, from) in list {
        let mut chars = name.chars();
        if !chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
            || name.starts_with("now")
            || template::is_side_value(&name)
        {
            return Err(config(format!(
                "{at}.save: bad name `{name}` (letters, digits, _; not starting with now; not a side value: {})",
                template::SIDE_VALUES.join(", ")
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
    Ok(save)
}

fn delivery(
    d: DeliveryFile,
    at: &str,
    saved: &mut BTreeSet<String>,
    p: &Patterns,
    known: &mut Known,
) -> Result<Delivery> {
    let mut headers = Vec::new();
    for (k, v) in d.headers {
        let v = match v {
            Value::String(s) => {
                check_interp(&s, saved, &format!("{at}.headers.{k}"))?;
                p.collect_known(&s, known);
                Some(s)
            }
            Value::Null => None,
            _ => {
                return Err(config(format!(
                    "{at}.headers.{k}: a string, or null to leave the header out"
                )));
            }
        };
        headers.push((k.to_ascii_lowercase(), v));
    }
    if let Some(r) = &d.raw {
        check_json_body(r, saved, &format!("{at}.raw"))?;
        collect_inputs(p, r, known);
    }
    for (what, v) in [("secret", &d.secret), ("signature", &d.signature)] {
        if let Some(v) = v {
            check_interp(v, saved, &format!("{at}.{what}"))?;
        }
    }
    let expect_status = match d.expect.and_then(|e| e.status) {
        Some(v) => Some(status_list(&v, &format!("{at}.expect.status"))?),
        None => None,
    };
    let save = save_list(d.save, at, saved)?;
    if let Some(path) = &d.path
        && !path.starts_with('/')
    {
        return Err(config(format!("{at}.path: starts with /")));
    }
    Ok(Delivery {
        secret: d.secret,
        signature: d.signature,
        headers,
        raw: d.raw,
        port: d.port,
        path: d.path,
        timeout_ms: timeout(d.timeout_ms.unwrap_or(30_000), &format!("{at}.timeout_ms"))?,
        expect_status,
        save,
    })
}

const EVENTSUB_MESSAGE_TYPES: &[&str] = &[
    "notification",
    "webhook_callback_verification",
    "revocation",
];

fn eventsub_step(
    f: EventsubFile,
    at: &str,
    seed: &str,
    saved: &mut BTreeSet<String>,
    p: &Patterns,
    known: &mut Known,
) -> Result<EventsubStep> {
    let d = DeliveryFile {
        secret: f.secret,
        signature: f.signature,
        headers: f.headers,
        raw: f.raw,
        port: f.port,
        path: f.path,
        timeout_ms: f.timeout_ms,
        expect: f.expect,
        save: f.save,
    };
    let message_type = f.message_type.unwrap_or_else(|| "notification".into());
    if !EVENTSUB_MESSAGE_TYPES.contains(&message_type.as_str()) && d.raw.is_none() {
        return Err(config(format!(
            "{at}.message_type: `{message_type}` (use {}; any other only with \"raw\")",
            EVENTSUB_MESSAGE_TYPES.join(", ")
        )));
    }
    let sub_type = f.r#type.unwrap_or_default();
    if sub_type.is_empty() && d.raw.is_none() {
        return Err(config(format!(
            "{at}.type: the subscription type, such as channel.chat.message"
        )));
    }
    for (what, v) in [
        ("condition", &f.condition),
        ("event", &f.event),
        ("subscription", &f.subscription),
        ("timestamp", &f.timestamp),
    ] {
        if let Some(v) = v {
            check_json_body(v, saved, &format!("{at}.{what}"))?;
            collect_inputs(p, v, known);
        }
    }
    if message_type == "notification" && f.event.is_none() && d.raw.is_none() {
        return Err(config(format!(
            "{at}.event: a notification carries the event"
        )));
    }
    let message_id = f
        .message_id
        .unwrap_or_else(|| crate::mock::handlers::uuid_from(format!("{seed}|message").as_bytes()));
    check_interp(&message_id, saved, &format!("{at}.message_id"))?;
    p.collect_known(&message_id, known);
    let challenge = f.challenge.unwrap_or_else(|| {
        format!(
            "rigchallenge-{}",
            crate::mock::handlers::uuid_from(format!("{seed}|challenge").as_bytes())
        )
    });
    p.collect_known(&challenge, known);
    let delivery = delivery(d, at, saved, p, known)?;
    Ok(EventsubStep {
        sub_type,
        version: f.version.unwrap_or_else(|| "1".into()),
        condition: f.condition.unwrap_or_else(|| Value::Object(Map::new())),
        event: f.event.unwrap_or(Value::Null),
        message_type,
        message_id,
        timestamp: f.timestamp,
        retry: f.retry.unwrap_or(0),
        subscription: f.subscription,
        challenge,
        delivery,
    })
}

fn polar_step(
    f: PolarFile,
    at: &str,
    seed: &str,
    saved: &mut BTreeSet<String>,
    p: &Patterns,
    known: &mut Known,
) -> Result<PolarStep> {
    let d = DeliveryFile {
        secret: f.secret,
        signature: f.signature,
        headers: f.headers,
        raw: f.raw,
        port: f.port,
        path: f.path,
        timeout_ms: f.timeout_ms,
        expect: f.expect,
        save: f.save,
    };
    let event_type = f.r#type.unwrap_or_default();
    if event_type.is_empty() && d.raw.is_none() {
        return Err(config(format!(
            "{at}.type: the Polar event type, such as order.paid"
        )));
    }
    for (what, v) in [("data", &f.data), ("timestamp_s", &f.timestamp_s)] {
        if let Some(v) = v {
            check_json_body(v, saved, &format!("{at}.{what}"))?;
            collect_inputs(p, v, known);
        }
    }
    let id = f.id.unwrap_or_else(|| {
        let u = crate::mock::handlers::uuid_from(format!("{seed}|polar").as_bytes());
        format!("msg_{}", u.replace('-', ""))
    });
    check_interp(&id, saved, &format!("{at}.id"))?;
    p.collect_known(&id, known);
    let delivery = delivery(d, at, saved, p, known)?;
    Ok(PolarStep {
        event_type,
        data: f.data.unwrap_or_else(|| Value::Object(Map::new())),
        id,
        timestamp_s: f.timestamp_s,
        delivery,
    })
}

fn wait_call(
    f: WaitCallFile,
    at: &str,
    saved: &BTreeSet<String>,
    p: &Patterns,
    known: &mut Known,
) -> Result<(CallCond, u64)> {
    let timeout_ms = timeout(f.timeout_ms, &format!("{at}.timeout_ms"))?;
    let providers = crate::mock::providers::Providers::builtin().map_err(config)?;
    match (&f.host, &f.provider) {
        (Some(h), None) => {
            if !h.contains('*') && providers.for_host(h).is_none() {
                return Err(config(format!("{at}.host: `{h}` is not a provider host")));
            }
        }
        (None, Some(name)) => {
            if providers.by_name(name).is_none() {
                return Err(config(format!("{at}.provider: `{name}` is not a provider")));
            }
        }
        _ => {
            return Err(config(format!(
                "{at}: exactly one of host (api.twitch.tv) or provider (twitch)"
            )));
        }
    }
    if let Some(b) = &f.body {
        check_json_body(b, saved, &format!("{at}.body"))?;
        collect_inputs(p, b, known);
    }
    let text = format!(
        "{} {}{}{}",
        f.method.as_deref().unwrap_or("any method"),
        f.host
            .as_deref()
            .or(f.provider.as_deref())
            .unwrap_or_default(),
        f.path.as_deref().unwrap_or(""),
        f.body
            .as_ref()
            .map(|b| format!(" with body {b}"))
            .unwrap_or_default()
    );
    let route = crate::mock::route::Route::compile(
        crate::mock::route::RouteFile {
            host: Some(f.host.clone().unwrap_or_else(|| "*".into())),
            method: f.method,
            path: f.path,
            query: f.query,
            headers: Map::new(),
            body: f.body,
            body_contains: f.body_contains,
            call: None,
            respond: Some(crate::mock::route::RespondFile::default()),
            handler: None,
            args: None,
            proxy: None,
            provider: None,
            reason: None,
        },
        true,
        at.to_string(),
    )
    .map_err(config)?;
    Ok((
        CallCond {
            route,
            provider: f.provider,
            count: f.count.unwrap_or(1).max(1),
            text,
        },
        timeout_ms,
    ))
}

fn selection(s: Option<SelFile>) -> Selection {
    s.map(|f| Selection {
        only: f.only,
        exclude: f.exclude,
    })
    .unwrap_or_default()
}

/// The response headers not compared: the noise list minus `compare.headers.include`. Every
/// other header is compared (ignore one with an allowance, which needs a reason).
pub(crate) fn headers(h: Option<HeaderSelFile>, at: &str) -> Result<Vec<String>> {
    let include = h.map(|h| h.include).unwrap_or_default();
    for n in &include {
        if !NOISE_HEADERS.contains(&n.as_str()) {
            return Err(config(format!(
                "{at}.include: `{n}` is compared already; include names only from the noise list ({})",
                NOISE_HEADERS.join(", ")
            )));
        }
    }
    Ok(NOISE_HEADERS
        .iter()
        .filter(|n| !include.iter().any(|i| i == *n))
        .map(|n| n.to_string())
        .collect())
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
            "exact" => AllowKind::Exact,
            "ttl" => match a.unit.as_deref() {
                None | Some("s") => AllowKind::Ttl { seconds: true },
                Some("ms") => AllowKind::Ttl { seconds: false },
                Some(other) => {
                    return Err(config(format!("{here}.unit: `{other}` (use s or ms)")));
                }
            },
            "time" => match a.unit.as_deref() {
                None | Some("ms") => AllowKind::Time { seconds: false },
                Some("s") => AllowKind::Time { seconds: true },
                Some("min") => AllowKind::Minutes,
                Some(other) => {
                    return Err(config(format!("{here}.unit: `{other}` (use ms, s or min)")));
                }
            },
            other => {
                return Err(config(format!(
                    "{here}.kind: `{other}` (use ignore, set, tolerance, generated, exact, time or ttl)"
                )));
            }
        };
        if a.unit.is_some()
            && !matches!(
                kind,
                AllowKind::Time { .. } | AllowKind::Ttl { .. } | AllowKind::Minutes
            )
        {
            return Err(config(format!(
                "{here}: \"unit\" only goes with kind time or ttl"
            )));
        }
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

/// `tolerance_ms` (default 2000) and `relation_tolerance_ms` (default 50).
pub(crate) fn tolerances(
    window: Option<u64>,
    relation: Option<u64>,
    at: &str,
) -> Result<crate::compare::Tolerances> {
    let d = crate::compare::Tolerances::default();
    let ms = |v: Option<u64>, default: i64, name: &str| -> Result<i64> {
        match v {
            None => Ok(default),
            Some(v) if v <= 86_400_000 => {
                i64::try_from(v).map_err(|_| config(format!("{at}: {name} too large")))
            }
            Some(_) => Err(config(format!("{at}: {name} at most 86400000"))),
        }
    };
    Ok(crate::compare::Tolerances {
        window_ms: ms(window, d.window_ms, "tolerance_ms")?,
        relation_ms: ms(relation, d.relation_ms, "relation_tolerance_ms")?,
    })
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
    if ![1, 2, SCENARIO_VERSION].contains(&f.rig_scenario) {
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
        root: rig_dir.join("scenarios").join(target),
        seed_offsets: Vec::new(),
        files: vec![(
            format!("{name}.json"),
            format!("fnv1a64:{:016x}", fnv1a64(v.to_string().as_bytes())),
        )],
        mongo: Vec::new(),
        dragonfly: Vec::new(),
        postgres: Vec::new(),
        data_files: Vec::new(),
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
            s.sql.as_ref().map(|_| "sql"),
            s.socketio.as_ref().map(|_| "socketio"),
            s.http.as_ref().map(|_| "http"),
            s.dragonfly.as_ref().map(|_| "dragonfly"),
            s.pause_ms.map(|_| "pause_ms"),
            s.wait_for.as_ref().map(|_| "wait_for"),
            s.wait_quiet.as_ref().map(|_| "wait_quiet"),
            s.eventsub.as_ref().map(|_| "eventsub"),
            s.polar.as_ref().map(|_| "polar"),
            s.wait_call.as_ref().map(|_| "wait_call"),
        ]
        .into_iter()
        .flatten()
        .collect();
        if given.len() != 1 {
            return Err(config(format!(
                "{here}: a step has exactly one of sql, socketio, http, dragonfly, pause_ms, wait_for, wait_quiet, eventsub, polar, wait_call (found: {})",
                if given.is_empty() {
                    "none".to_string()
                } else {
                    given.join(", ")
                }
            )));
        }
        let kind = if let Some(sql) = s.sql {
            collect_inputs(patterns, &Value::String(sql.clone()), &mut loader.known);
            StepKind::Sql(sql)
        } else if let Some(a) = s.socketio {
            a.validate()
                .map_err(|e| config(format!("{here}.socketio: {e}")))?;
            let input = serde_json::to_value(&a).map_err(|e| config(e.to_string()))?;
            collect_inputs(patterns, &input, &mut loader.known);
            StepKind::Socketio(a)
        } else if let Some(h) = s.http {
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
        } else if let Some(e) = s.eventsub {
            StepKind::Eventsub(Box::new(eventsub_step(
                e,
                &format!("{here}.eventsub"),
                &format!("{target}/{name}|{i}"),
                &mut saved,
                patterns,
                &mut loader.known,
            )?))
        } else if let Some(pf) = s.polar {
            StepKind::Polar(Box::new(polar_step(
                pf,
                &format!("{here}.polar"),
                &format!("{target}/{name}|{i}"),
                &mut saved,
                patterns,
                &mut loader.known,
            )?))
        } else if let Some(w) = s.wait_call {
            let (cond, timeout_ms) = wait_call(
                w,
                &format!("{here}.wait_call"),
                &saved,
                patterns,
                &mut loader.known,
            )?;
            StepKind::WaitCall {
                cond: Box::new(cond),
                timeout_ms,
            }
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
    let tolerances = tolerances(f.tolerance_ms, f.relation_tolerance_ms, &at)?;
    let mock = match &f.mock {
        None => crate::mock::MockSpec::default(),
        Some(v) => {
            collect_inputs(patterns, v, &mut loader.known);
            let mf: crate::mock::MockFile = serde_json::from_value(v.clone())
                .map_err(|e| config(format!("{at}: mock: {e}")))?;
            crate::mock::MockSpec::from_file(mf, &at).map_err(config)?
        }
    };
    let providers = crate::mock::providers::Providers::builtin().map_err(config)?;
    let mut call_rules = crate::detect::CallRules::default();
    for (p, mode) in &compare.calls {
        if providers.by_name(p).is_none() {
            return Err(config(format!(
                "{at}: compare.calls: `{p}` is not a provider name ({})",
                providers
                    .list
                    .iter()
                    .map(|x| x.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )));
        }
        let order = crate::mock::providers::CallOrder::parse(mode).ok_or_else(|| {
            config(format!(
                "{at}: compare.calls.{p}: `{mode}` (ordered, multiset or ignore)"
            ))
        })?;
        call_rules.order.insert(p.clone(), order);
    }
    if let Some(h) = &compare.call_headers {
        call_rules.include_headers = h.include.iter().map(|n| n.to_ascii_lowercase()).collect();
    }
    Ok(Scenario {
        name: name.to_string(),
        file,
        description: f.description,
        restart: f.restart,
        share_process: f.share_process,
        allow_scripts: f.allow_scripts,
        seed_mongo: loader.mongo,
        seed_dragonfly: loader.dragonfly,
        seed_postgres: loader.postgres,
        steps,
        mongo: selection(compare.mongo),
        dragonfly: selection(compare.dragonfly),
        skip_headers: headers(compare.headers, &format!("{at}: compare.headers"))?,
        as_text,
        allow: allowances(f.allow, &at)?,
        tolerances,
        hash: format!("fnv1a64:{:016x}", fnv1a64(loader.hash_input.as_bytes())),
        files: loader.files,
        seed_offsets: {
            let mut o = loader.seed_offsets;
            o.sort_unstable();
            o.dedup();
            o
        },
        known: loader.known,
        mock,
        call_rules,
        seed_files: loader.data_files,
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

/// `command` for the crate's tests.
#[cfg(test)]
pub(crate) fn tests_command(args: &[Value]) -> Vec<Arg> {
    command(args, "c", &BTreeSet::new(), false).unwrap_or_default()
}

#[cfg(test)]
pub(crate) fn tests_command_err(args: &[Value]) -> String {
    command(args, "c", &BTreeSet::new(), false)
        .err()
        .map(|e| e.to_string())
        .unwrap_or_default()
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

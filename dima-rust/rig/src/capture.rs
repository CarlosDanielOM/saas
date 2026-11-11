//! What a side did in one scenario: raw (as read from the process and the stores) and
//! normalised (run-time values replaced, canonically ordered), plus the capture file format.

use std::collections::BTreeMap;

use base64::Engine as _;
use bson::Document;
use serde_json::{Map, Value, json};

use crate::value::{self, Moment, Text, Val};

/// Version of the capture file format and of the normalisation that produced it. Bump it when a
/// change makes old captures compare differently; `verify` then asks for a re-record.
pub const CAPTURE_VERSION: u64 = 1;

// ---------------------------------------------------------------------------------------------
// Raw capture.

#[derive(Debug, Clone, Default)]
pub struct RawCapture {
    pub steps: Vec<RawStep>,
    pub mongo: BTreeMap<String, RawColl>,
    pub dragonfly: Vec<RawEntry>,
    /// When the Dragonfly TTLs were read (rig clock, epoch ms).
    pub captured_at: i64,
}

#[derive(Debug, Clone)]
pub enum RawStep {
    Http(RawHttp),
    Reply(RawReply),
    /// A step that produces nothing to compare (pause, waits); the string is its kind.
    Done(String),
}

#[derive(Debug, Clone)]
pub struct RawHttp {
    pub status: u16,
    /// Lower-case names, in the order received; repeated names are repeated.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RawReply {
    Nil,
    Int(i64),
    Bulk(Vec<u8>),
    Status(String),
    Error(String),
    Array(Vec<RawReply>),
    Double(f64),
    Bool(bool),
    Map(Vec<(RawReply, RawReply)>),
}

#[derive(Debug, Clone, Default)]
pub struct RawColl {
    /// `collection`, `view`, `timeseries`.
    pub kind: String,
    pub options: Document,
    pub indexes: Vec<Document>,
    pub docs: Vec<Document>,
}

#[derive(Debug, Clone)]
pub struct RawEntry {
    pub key: Vec<u8>,
    pub kind: String,
    pub value: RawValue,
    /// PTTL: -1 for no TTL, otherwise milliseconds left when read.
    pub pttl: i64,
}

/// One stream entry: its id and its field/value pairs.
pub type StreamEntry = (String, Vec<(Vec<u8>, Vec<u8>)>);

#[derive(Debug, Clone)]
pub enum RawValue {
    Str(Vec<u8>),
    Hash(Vec<(Vec<u8>, Vec<u8>)>),
    List(Vec<Vec<u8>>),
    Set(Vec<Vec<u8>>),
    ZSet(Vec<(Vec<u8>, f64)>),
    Stream(Vec<StreamEntry>),
    Other,
}

// ---------------------------------------------------------------------------------------------
// Normalised capture.

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Capture {
    pub steps: Vec<StepCap>,
    pub mongo: BTreeMap<String, CollCap>,
    pub dragonfly: Vec<EntryCap>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum StepCap {
    Http { status: u16, headers: Vec<(String, Vec<Text>)>, body: Body },
    Reply(Val),
    Done(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Body {
    Json(Val),
    Text(Text),
    Bytes(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct CollCap {
    pub kind: String,
    pub options: Val,
    /// By index name, sorted by name.
    pub indexes: Vec<(String, Val)>,
    pub docs: Vec<Val>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EntryCap {
    pub key: Text,
    pub kind: String,
    /// `None`: the key has no TTL. Otherwise its expiry time.
    pub ttl: Option<Moment>,
    pub value: Val,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureMeta {
    pub target: String,
    pub scenario: String,
    pub scenario_hash: String,
}

// ---------------------------------------------------------------------------------------------
// File format.

fn encode_texts(vals: &[Text]) -> Value {
    match vals {
        [one] => value::encode_text_value(one),
        many => Value::Array(many.iter().map(value::encode_text_value).collect()),
    }
}

fn decode_text_value(v: &Value) -> Result<Text, String> {
    match value::decode(v)? {
        Val::Str(t) => Ok(t),
        other => Err(format!("expected text, found {}", other.type_name())),
    }
}

pub fn encode_body(b: &Body) -> Value {
    match b {
        Body::Json(v) => json!({ "json": value::encode(v) }),
        Body::Text(t) => json!({ "text": value::encode_text_value(t) }),
        Body::Bytes(bytes) => json!({ "base64": base64::engine::general_purpose::STANDARD.encode(bytes) }),
    }
}

pub fn encode_step(s: &StepCap) -> Value {
    match s {
        StepCap::Http { status, headers, body } => {
            let mut h = Map::new();
            for (name, vals) in headers {
                h.insert(name.clone(), encode_texts(vals));
            }
            json!({ "http": { "status": status, "headers": h, "body": encode_body(body) } })
        }
        StepCap::Reply(v) => json!({ "dragonfly": { "reply": value::encode(v) } }),
        StepCap::Done(kind) => {
            let mut m = Map::new();
            m.insert(kind.clone(), json!({}));
            Value::Object(m)
        }
    }
}

pub fn encode_ttl(t: &Option<Moment>) -> Value {
    match t {
        None => Value::Null,
        Some(m) => Value::String(format!("<{}>", value::encode_moment(m))),
    }
}

/// The capture as written to `captures/<target>/<scenario>.json`.
pub fn to_file_json(meta: &CaptureMeta, cap: &Capture) -> Value {
    let mut mongo = Map::new();
    for (name, c) in &cap.mongo {
        let mut idx = Map::new();
        for (n, spec) in &c.indexes {
            idx.insert(value::encode_key(&Text::lit(n)), value::encode(spec));
        }
        mongo.insert(
            name.clone(),
            json!({
                "type": c.kind,
                "options": value::encode(&c.options),
                "indexes": idx,
                "documents": c.docs.iter().map(value::encode).collect::<Vec<_>>(),
            }),
        );
    }
    let dragonfly: Vec<Value> = cap
        .dragonfly
        .iter()
        .map(|e| {
            json!({
                "key": value::encode_text_value(&e.key),
                "type": e.kind,
                "ttl": encode_ttl(&e.ttl),
                "value": value::encode(&e.value),
            })
        })
        .collect();
    json!({
        "rig_capture": CAPTURE_VERSION,
        "target": meta.target,
        "scenario": meta.scenario,
        "scenario_hash": meta.scenario_hash,
        "steps": cap.steps.iter().map(encode_step).collect::<Vec<_>>(),
        "mongo": mongo,
        "dragonfly": dragonfly,
    })
}

fn field<'a>(o: &'a Map<String, Value>, k: &str, ctx: &str) -> Result<&'a Value, String> {
    o.get(k).ok_or_else(|| format!("{ctx}: missing `{k}`"))
}

fn obj<'a>(v: &'a Value, ctx: &str) -> Result<&'a Map<String, Value>, String> {
    v.as_object().ok_or_else(|| format!("{ctx}: expected an object"))
}

fn string(v: &Value, ctx: &str) -> Result<String, String> {
    v.as_str().map(str::to_string).ok_or_else(|| format!("{ctx}: expected a string"))
}

fn decode_step(v: &Value, i: usize) -> Result<StepCap, String> {
    let ctx = format!("steps[{i}]");
    let o = obj(v, &ctx)?;
    let (kind, inner) = o.iter().next().filter(|_| o.len() == 1).ok_or_else(|| format!("{ctx}: expected one key"))?;
    match kind.as_str() {
        "http" => {
            let h = obj(inner, &ctx)?;
            let status = field(h, "status", &ctx)?
                .as_u64()
                .and_then(|s| u16::try_from(s).ok())
                .ok_or_else(|| format!("{ctx}: bad status"))?;
            let mut headers = Vec::new();
            for (name, vals) in obj(field(h, "headers", &ctx)?, &ctx)? {
                let texts = match vals {
                    Value::Array(items) => items.iter().map(decode_text_value).collect::<Result<Vec<_>, _>>()?,
                    one => vec![decode_text_value(one)?],
                };
                headers.push((name.clone(), texts));
            }
            let b = obj(field(h, "body", &ctx)?, &ctx)?;
            let body = if let Some(j) = b.get("json") {
                Body::Json(value::decode(j)?)
            } else if let Some(t) = b.get("text") {
                Body::Text(decode_text_value(t)?)
            } else if let Some(s) = b.get("base64") {
                Body::Bytes(
                    base64::engine::general_purpose::STANDARD
                        .decode(string(s, &ctx)?)
                        .map_err(|e| format!("{ctx}: bad base64 body: {e}"))?,
                )
            } else {
                return Err(format!("{ctx}: body needs json, text or base64"));
            };
            Ok(StepCap::Http { status, headers, body })
        }
        "dragonfly" => Ok(StepCap::Reply(value::decode(field(obj(inner, &ctx)?, "reply", &ctx)?)?)),
        other => Ok(StepCap::Done(other.to_string())),
    }
}

/// Read a capture file back.
pub fn from_file_json(v: &Value) -> Result<(CaptureMeta, Capture), String> {
    let o = obj(v, "capture")?;
    let version = field(o, "rig_capture", "capture")?.as_u64().unwrap_or(0);
    if version != CAPTURE_VERSION {
        return Err(format!(
            "capture format version {version}, this rig writes version {CAPTURE_VERSION}: re-record it with `dima-rig record`"
        ));
    }
    let meta = CaptureMeta {
        target: string(field(o, "target", "capture")?, "target")?,
        scenario: string(field(o, "scenario", "capture")?, "scenario")?,
        scenario_hash: string(field(o, "scenario_hash", "capture")?, "scenario_hash")?,
    };
    let steps = field(o, "steps", "capture")?
        .as_array()
        .ok_or("steps: expected an array")?
        .iter()
        .enumerate()
        .map(|(i, s)| decode_step(s, i))
        .collect::<Result<Vec<_>, _>>()?;
    let mut mongo = BTreeMap::new();
    for (name, c) in obj(field(o, "mongo", "capture")?, "mongo")? {
        let ctx = format!("mongo.{name}");
        let co = obj(c, &ctx)?;
        let mut indexes = Vec::new();
        for (n, spec) in obj(field(co, "indexes", &ctx)?, &ctx)? {
            let name_text = value::decode_key(n)?;
            indexes.push((name_text.display(), value::decode(spec)?));
        }
        let docs = field(co, "documents", &ctx)?
            .as_array()
            .ok_or_else(|| format!("{ctx}.documents: expected an array"))?
            .iter()
            .map(value::decode)
            .collect::<Result<Vec<_>, _>>()?;
        mongo.insert(
            name.clone(),
            CollCap {
                kind: string(field(co, "type", &ctx)?, &ctx)?,
                options: value::decode(field(co, "options", &ctx)?)?,
                indexes,
                docs,
            },
        );
    }
    let mut dragonfly = Vec::new();
    for (i, e) in field(o, "dragonfly", "capture")?.as_array().ok_or("dragonfly: expected an array")?.iter().enumerate() {
        let ctx = format!("dragonfly[{i}]");
        let eo = obj(e, &ctx)?;
        let ttl = match field(eo, "ttl", &ctx)? {
            Value::Null => None,
            Value::String(s) => {
                let inner = s.strip_prefix('<').and_then(|x| x.strip_suffix('>')).ok_or_else(|| format!("{ctx}: bad ttl"))?;
                Some(value::decode_moment(inner)?)
            }
            _ => return Err(format!("{ctx}: bad ttl")),
        };
        dragonfly.push(EntryCap {
            key: decode_text_value(field(eo, "key", &ctx)?)?,
            kind: string(field(eo, "type", &ctx)?, &ctx)?,
            ttl,
            value: value::decode(field(eo, "value", &ctx)?)?,
        });
    }
    Ok((meta, Capture { steps, mongo, dragonfly }))
}

/// Pretty JSON with a trailing newline, as stored on disk.
pub fn to_file_string(meta: &CaptureMeta, cap: &Capture) -> String {
    let mut s = serde_json::to_string_pretty(&to_file_json(meta, cap)).unwrap_or_default();
    s.push('\n');
    s
}

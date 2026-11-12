//! What a side did in one scenario.
//!
//! A **raw capture** holds exactly what was observed: every step's status, all response headers
//! and the body bytes, every Dragonfly reply, the final MongoDB documents and index definitions,
//! the final Dragonfly entries with each TTL and the time it was read, plus the run's metadata
//! (its time window and the values the rig chose for the side). It is what a capture file
//! stores, so a better normaliser can be applied to old recordings after the reference is gone.
//!
//! A **normalised capture** ([`Capture`]) is computed from a raw capture by `detect` and `canon`
//! every time two sides are compared; it is never stored.

use std::collections::BTreeMap;
use std::io::Cursor;

use base64::Engine as _;
use bson::{Bson, Document};
use serde_json::{Map, Value, json};

use crate::value::{self, Moment, Text, Val};

/// Version of the capture file format. Bump it only when old files cannot be read any more;
/// normalisation changes do not need a bump (captures are raw).
pub const CAPTURE_VERSION: u64 = 2;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

// ---------------------------------------------------------------------------------------------
// Raw capture.

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RawCapture {
    pub steps: Vec<RawStep>,
    pub mongo: BTreeMap<String, RawColl>,
    pub dragonfly: Vec<RawEntry>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RawStep {
    Http(RawHttp),
    Reply(RawReplyStep),
    /// A step that produces nothing to compare (pause, waits); the string is its kind.
    Done(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawHttp {
    /// When the response was complete (rig clock, epoch ms).
    pub at: i64,
    pub status: u16,
    /// Every header: lower-case names, in the order received; repeated names are repeated.
    pub headers: Vec<(String, Vec<u8>)>,
    pub body: Vec<u8>,
}

/// One request a side made to the mock of the outside world (or through the Qdrant proxy).
/// Credential header values are already reduced to their scheme (`Bearer <redacted>`).
#[derive(Debug, Clone, PartialEq)]
pub struct RawCall {
    /// When the mock received it (rig clock, epoch ms).
    pub at: i64,
    /// The provider it was recorded under (`twitch`, `openrouter`, `qdrant`).
    pub provider: String,
    /// The host the side addressed (`api.twitch.tv`, `dima-server:3000`).
    pub host: String,
    pub method: String,
    /// The path at that host (`/helix/users`).
    pub path: String,
    /// The raw query string, without `?`.
    pub query: String,
    /// Every request header: lower-case names, in the order received.
    pub headers: Vec<(String, Vec<u8>)>,
    /// The body as received (still compressed when it was sent compressed).
    pub body: Vec<u8>,
    /// What answered it: a route's origin, or `unmatched`.
    pub answered: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawReplyStep {
    /// When the reply arrived (rig clock, epoch ms).
    pub at: i64,
    /// The command as sent (rendered).
    pub command: Vec<String>,
    pub reply: RawReply,
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

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RawColl {
    /// `collection`, `view`, `timeseries`.
    pub kind: String,
    pub options: Document,
    /// Sorted by name.
    pub indexes: Vec<Document>,
    /// Sorted by `_id`, then content (see [`RawCapture::sort`]).
    pub docs: Vec<Document>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawEntry {
    pub key: Vec<u8>,
    pub kind: String,
    pub value: RawValue,
    /// PTTL: -1 for no TTL, otherwise milliseconds left when read.
    pub pttl: i64,
    /// When this entry's PTTL was read (rig clock, epoch ms).
    pub pttl_at: i64,
}

/// Field/value pairs in order (hash fields, stream entry fields).
pub type BytePairs = Vec<(Vec<u8>, Vec<u8>)>;

/// One stream entry: its id and its field/value pairs in order (a field name may repeat).
pub type StreamEntry = (String, BytePairs);

#[derive(Debug, Clone, PartialEq)]
pub enum RawValue {
    Str(Vec<u8>),
    /// Sorted by field.
    Hash(BytePairs),
    List(Vec<Vec<u8>>),
    /// Sorted.
    Set(Vec<Vec<u8>>),
    /// In the server's order (score, then member); the score as the server wrote it.
    ZSet(Vec<(Vec<u8>, String)>),
    Stream(Vec<StreamEntry>),
    Other,
}

fn doc_order_key(d: &Document) -> (String, String) {
    let id = d
        .get("_id")
        .map(|b| b.clone().into_canonical_extjson().to_string())
        .unwrap_or_default();
    (
        id,
        Bson::Document(d.clone())
            .into_canonical_extjson()
            .to_string(),
    )
}

impl RawCapture {
    /// The deterministic order a capture file stores: documents by `_id` then content, indexes
    /// by name, keys by bytes, hash fields and set members by bytes. Lists, streams and sorted
    /// sets keep their order, which is part of their value.
    pub fn sort(&mut self) {
        for c in self.mongo.values_mut() {
            c.docs.sort_by_cached_key(doc_order_key);
            c.indexes
                .sort_by_cached_key(|d| d.get_str("name").unwrap_or("").to_string());
        }
        self.dragonfly.sort_by(|a, b| a.key.cmp(&b.key));
        for e in &mut self.dragonfly {
            match &mut e.value {
                RawValue::Hash(pairs) => pairs.sort(),
                RawValue::Set(members) => members.sort(),
                _ => {}
            }
        }
    }
}

/// What the rig chose for one side's run of one scenario, and when it ran: everything the
/// normaliser needs besides the scenario itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunMeta {
    /// The `$rigNow` of the seed: before the stores were reset and seeded (rig clock, epoch ms).
    pub seeded_at: i64,
    /// The run start: just before the first step. Run times are relative to it, so the time a
    /// process takes to start does not move them.
    pub start: i64,
    /// After the last step.
    pub end: i64,
    /// When the side's process was started.
    pub process_start: i64,
    pub ports: BTreeMap<String, u16>,
    pub mongo_db: String,
    /// The side's MongoDB URI with its credentials removed.
    pub mongo_uri: String,
    pub dragonfly_db: u8,
    pub dragonfly_url: String,
}

impl RunMeta {
    /// Run-time names to mask in observed text: (literal, name), longest first.
    pub fn names(&self) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for (n, port) in &self.ports {
            for host in ["127.0.0.1", "localhost", "[::1]"] {
                out.push((format!("{host}:{port}"), format!("port.{n}")));
            }
        }
        out.push((self.dragonfly_url.clone(), "dragonfly_url".into()));
        if self.mongo_db.starts_with("rig_") {
            out.push((self.mongo_db.clone(), "mongo_db".into()));
        }
        out.sort_by_key(|(l, _)| std::cmp::Reverse(l.len()));
        out
    }
}

/// A MongoDB URI without its user name and password.
pub fn redact_uri(uri: &str) -> String {
    match uri.split_once("://") {
        Some((scheme, rest)) => {
            let hosts_end = rest.find(['/', '?']).unwrap_or(rest.len());
            let (authority, tail) = rest.split_at(hosts_end);
            match authority.rsplit_once('@') {
                Some((_, hosts)) => format!("{scheme}://{hosts}{tail}"),
                None => uri.to_string(),
            }
        }
        None => uri.to_string(),
    }
}

/// Who recorded a capture, when, and from what.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Provenance {
    pub target: String,
    pub scenario: String,
    /// `reference`.
    pub side: String,
    /// Given on the command line (`record --label`), such as the reference's commit id.
    pub label: Option<String>,
    /// Epoch ms.
    pub recorded_at: i64,
    pub rig_version: String,
}

/// The hash of the scenario with everything it includes (a stale capture is refused) and of
/// each input file on its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hashes {
    pub scenario: String,
    pub files: Vec<(String, String)>,
}

/// A capture file: `captures/<target>/<scenario>.json`.
#[derive(Debug, Clone, PartialEq)]
pub struct CaptureFile {
    pub provenance: Provenance,
    pub hashes: Hashes,
    pub run: RunMeta,
    pub raw: RawCapture,
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
    Http {
        status: u16,
        /// Compared headers by name (sorted): a string, an array for a repeated header, an
        /// object for `set-cookie` (cookie name → its value and attributes).
        headers: Vec<(String, Val)>,
        body: Body,
    },
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

/// A TTL as reports show it.
pub fn encode_ttl(t: &Option<Moment>) -> Value {
    match t {
        None => Value::Null,
        Some(m) => Value::String(format!("<{}>", value::encode_moment(m))),
    }
}

/// The normalised form as JSON, for people (reports, debugging); never read back.
pub fn normalised_json(cap: &Capture) -> Value {
    let steps: Vec<Value> = cap
        .steps
        .iter()
        .map(|s| match s {
            StepCap::Http {
                status,
                headers,
                body,
            } => {
                let mut h = Map::new();
                for (n, v) in headers {
                    h.insert(n.clone(), value::encode(v));
                }
                let body = match body {
                    Body::Json(v) => json!({ "json": value::encode(v) }),
                    Body::Text(t) => json!({ "text": value::encode_text_value(t) }),
                    Body::Bytes(b) => json!({ "base64": B64.encode(b) }),
                };
                json!({ "http": { "status": status, "headers": h, "body": body } })
            }
            StepCap::Reply(v) => json!({ "dragonfly": { "reply": value::encode(v) } }),
            StepCap::Done(kind) => json!({ kind.clone(): {} }),
        })
        .collect();
    let mut mongo = Map::new();
    for (name, c) in &cap.mongo {
        let mut idx = Map::new();
        for (n, spec) in &c.indexes {
            idx.insert(n.clone(), value::encode(spec));
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
    json!({ "steps": steps, "mongo": mongo, "dragonfly": dragonfly })
}

// ---------------------------------------------------------------------------------------------
// File format (version 2).

/// Bytes as a JSON string when they are UTF-8, else `{"$rigBytes": "<base64>"}`: the two forms
/// cannot be confused.
pub fn enc_bytes(b: &[u8]) -> Value {
    match std::str::from_utf8(b) {
        Ok(s) => Value::String(s.to_string()),
        Err(_) => json!({ "$rigBytes": B64.encode(b) }),
    }
}

fn dec_bytes(v: &Value, ctx: &str) -> Result<Vec<u8>, String> {
    match v {
        Value::String(s) => Ok(s.clone().into_bytes()),
        Value::Object(o) if o.len() == 1 => {
            let b = o
                .get("$rigBytes")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("{ctx}: expected a string or {{\"$rigBytes\": ...}}"))?;
            B64.decode(b).map_err(|e| format!("{ctx}: bad base64: {e}"))
        }
        _ => Err(format!(
            "{ctx}: expected a string or {{\"$rigBytes\": ...}}"
        )),
    }
}

const RAW_BSON: &str = "$rigBson";

/// A document as canonical Extended JSON; `{"$rigBson": "<base64 of the BSON bytes>"}` when the
/// Extended JSON would not read back identically (NaN, ambiguous `$` field names).
pub fn enc_doc(d: &Document) -> Value {
    let ext = Bson::Document(d.clone()).into_canonical_extjson();
    let round_trips = !d.contains_key(RAW_BSON)
        && Bson::try_from(ext.clone()).is_ok_and(|b| b == Bson::Document(d.clone()));
    if round_trips {
        return ext;
    }
    let mut bytes = Vec::new();
    match d.to_writer(&mut bytes) {
        Ok(()) => json!({ RAW_BSON: B64.encode(bytes) }),
        Err(_) => ext,
    }
}

fn dec_doc(v: &Value, ctx: &str) -> Result<Document, String> {
    if let Some(Value::String(b)) = v.get(RAW_BSON)
        && v.as_object().is_some_and(|o| o.len() == 1)
    {
        let bytes = B64
            .decode(b)
            .map_err(|e| format!("{ctx}: bad base64: {e}"))?;
        return Document::from_reader(Cursor::new(bytes)).map_err(|e| format!("{ctx}: {e}"));
    }
    match Bson::try_from(v.clone()) {
        Ok(Bson::Document(d)) => Ok(d),
        Ok(other) => Err(format!(
            "{ctx}: expected a document, found {:?}",
            other.element_type()
        )),
        Err(e) => Err(format!("{ctx}: {e}")),
    }
}

fn enc_reply(r: &RawReply) -> Value {
    match r {
        RawReply::Nil => Value::Null,
        RawReply::Int(i) => json!({ "int": i }),
        RawReply::Bulk(b) => json!({ "bulk": enc_bytes(b) }),
        RawReply::Status(s) => json!({ "status": s }),
        RawReply::Error(s) => json!({ "error": s }),
        RawReply::Array(items) => {
            json!({ "array": items.iter().map(enc_reply).collect::<Vec<_>>() })
        }
        RawReply::Double(f) => json!({ "double": f.to_string() }),
        RawReply::Bool(b) => json!({ "bool": b }),
        RawReply::Map(pairs) => json!({
            "map": pairs.iter().map(|(k, v)| json!([enc_reply(k), enc_reply(v)])).collect::<Vec<_>>()
        }),
    }
}

fn one_key<'a>(v: &'a Value, ctx: &str) -> Result<(&'a str, &'a Value), String> {
    let o = obj(v, ctx)?;
    match o.iter().next() {
        Some((k, x)) if o.len() == 1 => Ok((k.as_str(), x)),
        _ => Err(format!("{ctx}: expected an object with one key")),
    }
}

fn dec_reply(v: &Value, ctx: &str) -> Result<RawReply, String> {
    if v.is_null() {
        return Ok(RawReply::Nil);
    }
    let (k, x) = one_key(v, ctx)?;
    Ok(match k {
        "int" => RawReply::Int(x.as_i64().ok_or_else(|| format!("{ctx}: bad int"))?),
        "bulk" => RawReply::Bulk(dec_bytes(x, ctx)?),
        "status" => RawReply::Status(string(x, ctx)?),
        "error" => RawReply::Error(string(x, ctx)?),
        "array" => RawReply::Array(
            arr(x, ctx)?
                .iter()
                .enumerate()
                .map(|(i, y)| dec_reply(y, &format!("{ctx}[{i}]")))
                .collect::<Result<_, _>>()?,
        ),
        "double" => RawReply::Double(
            string(x, ctx)?
                .parse()
                .map_err(|_| format!("{ctx}: bad double"))?,
        ),
        "bool" => RawReply::Bool(x.as_bool().ok_or_else(|| format!("{ctx}: bad bool"))?),
        "map" => RawReply::Map(
            arr(x, ctx)?
                .iter()
                .enumerate()
                .map(|(i, pair)| match pair.as_array().map(Vec::as_slice) {
                    Some([a, b]) => Ok((
                        dec_reply(a, &format!("{ctx}[{i}]"))?,
                        dec_reply(b, &format!("{ctx}[{i}]"))?,
                    )),
                    _ => Err(format!("{ctx}[{i}]: expected a [key, value] pair")),
                })
                .collect::<Result<_, _>>()?,
        ),
        other => return Err(format!("{ctx}: unknown reply kind `{other}`")),
    })
}

fn enc_pairs(pairs: &[(Vec<u8>, Vec<u8>)]) -> Value {
    Value::Array(
        pairs
            .iter()
            .map(|(a, b)| json!([enc_bytes(a), enc_bytes(b)]))
            .collect(),
    )
}

fn dec_pairs(v: &Value, ctx: &str) -> Result<BytePairs, String> {
    arr(v, ctx)?
        .iter()
        .enumerate()
        .map(|(i, p)| match p.as_array().map(Vec::as_slice) {
            Some([a, b]) => Ok((
                dec_bytes(a, &format!("{ctx}[{i}]"))?,
                dec_bytes(b, &format!("{ctx}[{i}]"))?,
            )),
            _ => Err(format!("{ctx}[{i}]: expected a pair")),
        })
        .collect()
}

fn enc_value(v: &RawValue) -> Value {
    match v {
        RawValue::Str(b) => enc_bytes(b),
        RawValue::Hash(pairs) => enc_pairs(pairs),
        RawValue::List(items) | RawValue::Set(items) => {
            Value::Array(items.iter().map(|b| enc_bytes(b)).collect())
        }
        RawValue::ZSet(items) => Value::Array(
            items
                .iter()
                .map(|(m, score)| json!([enc_bytes(m), score]))
                .collect(),
        ),
        RawValue::Stream(entries) => Value::Array(
            entries
                .iter()
                .map(|(id, fields)| json!({ "id": id, "fields": enc_pairs(fields) }))
                .collect(),
        ),
        RawValue::Other => Value::Null,
    }
}

fn dec_value(kind: &str, v: &Value, ctx: &str) -> Result<RawValue, String> {
    let list = |v: &Value| -> Result<Vec<Vec<u8>>, String> {
        arr(v, ctx)?
            .iter()
            .enumerate()
            .map(|(i, x)| dec_bytes(x, &format!("{ctx}[{i}]")))
            .collect()
    };
    Ok(match kind {
        "string" => RawValue::Str(dec_bytes(v, ctx)?),
        "hash" => RawValue::Hash(dec_pairs(v, ctx)?),
        "list" => RawValue::List(list(v)?),
        "set" => RawValue::Set(list(v)?),
        "zset" => RawValue::ZSet(
            arr(v, ctx)?
                .iter()
                .enumerate()
                .map(|(i, p)| match p.as_array().map(Vec::as_slice) {
                    Some([m, Value::String(score)]) => {
                        Ok((dec_bytes(m, &format!("{ctx}[{i}]"))?, score.clone()))
                    }
                    _ => Err(format!("{ctx}[{i}]: expected [member, \"score\"]")),
                })
                .collect::<Result<_, _>>()?,
        ),
        "stream" => RawValue::Stream(
            arr(v, ctx)?
                .iter()
                .enumerate()
                .map(|(i, e)| {
                    let here = format!("{ctx}[{i}]");
                    let o = obj(e, &here)?;
                    Ok((
                        string(field(o, "id", &here)?, &here)?,
                        dec_pairs(field(o, "fields", &here)?, &here)?,
                    ))
                })
                .collect::<Result<_, String>>()?,
        ),
        _ => RawValue::Other,
    })
}

fn enc_step(s: &RawStep) -> Value {
    match s {
        RawStep::Http(h) => json!({ "http": {
            "at": h.at,
            "status": h.status,
            "headers": h.headers.iter().map(|(n, v)| json!([n, enc_bytes(v)])).collect::<Vec<_>>(),
            "body": enc_bytes(&h.body),
        }}),
        RawStep::Reply(r) => json!({ "dragonfly": {
            "at": r.at,
            "command": r.command,
            "reply": enc_reply(&r.reply),
        }}),
        RawStep::Done(kind) => json!({ kind.clone(): {} }),
    }
}

fn dec_step(v: &Value, i: usize) -> Result<RawStep, String> {
    let ctx = format!("steps[{i}]");
    let (kind, inner) = one_key(v, &ctx)?;
    match kind {
        "http" => {
            let h = obj(inner, &ctx)?;
            let headers = arr(field(h, "headers", &ctx)?, &ctx)?
                .iter()
                .map(|p| match p.as_array().map(Vec::as_slice) {
                    Some([Value::String(n), v]) => Ok((n.clone(), dec_bytes(v, &ctx)?)),
                    _ => Err(format!("{ctx}.headers: expected [name, value] pairs")),
                })
                .collect::<Result<_, String>>()?;
            Ok(RawStep::Http(RawHttp {
                at: int(field(h, "at", &ctx)?, &ctx)?,
                status: field(h, "status", &ctx)?
                    .as_u64()
                    .and_then(|s| u16::try_from(s).ok())
                    .ok_or_else(|| format!("{ctx}: bad status"))?,
                headers,
                body: dec_bytes(field(h, "body", &ctx)?, &ctx)?,
            }))
        }
        "dragonfly" => {
            let d = obj(inner, &ctx)?;
            Ok(RawStep::Reply(RawReplyStep {
                at: int(field(d, "at", &ctx)?, &ctx)?,
                command: arr(field(d, "command", &ctx)?, &ctx)?
                    .iter()
                    .map(|a| string(a, &ctx))
                    .collect::<Result<_, _>>()?,
                reply: dec_reply(field(d, "reply", &ctx)?, &format!("{ctx}.reply"))?,
            }))
        }
        other => Ok(RawStep::Done(other.to_string())),
    }
}

/// The capture as written to `captures/<target>/<scenario>.json` (pretty-printed by
/// [`to_file_string`]). The raw capture should be sorted ([`RawCapture::sort`]).
pub fn to_file_json(f: &CaptureFile) -> Value {
    let p = &f.provenance;
    let r = &f.run;
    let mut mongo = Map::new();
    for (name, c) in &f.raw.mongo {
        mongo.insert(
            name.clone(),
            json!({
                "type": c.kind,
                "options": enc_doc(&c.options),
                "indexes": c.indexes.iter().map(enc_doc).collect::<Vec<_>>(),
                "documents": c.docs.iter().map(enc_doc).collect::<Vec<_>>(),
            }),
        );
    }
    let dragonfly: Vec<Value> = f
        .raw
        .dragonfly
        .iter()
        .map(|e| {
            json!({
                "key": enc_bytes(&e.key),
                "type": e.kind,
                "pttl": e.pttl,
                "pttl_at": e.pttl_at,
                "value": enc_value(&e.value),
            })
        })
        .collect();
    let mut files = Map::new();
    for (name, h) in &f.hashes.files {
        files.insert(name.clone(), Value::String(h.clone()));
    }
    json!({
        "rig_capture": CAPTURE_VERSION,
        "target": p.target,
        "scenario": p.scenario,
        "provenance": {
            "side": p.side,
            "label": p.label,
            "recorded_at": crate::timefmt::format_iso_ms(p.recorded_at),
            "rig_version": p.rig_version,
        },
        "hashes": { "scenario": f.hashes.scenario, "files": files },
        "run": {
            "seeded_at": r.seeded_at,
            "start": r.start,
            "end": r.end,
            "process_start": r.process_start,
            "ports": r.ports,
            "mongo_db": r.mongo_db,
            "mongo_uri": r.mongo_uri,
            "dragonfly_db": r.dragonfly_db,
            "dragonfly_url": r.dragonfly_url,
        },
        "steps": f.raw.steps.iter().map(enc_step).collect::<Vec<_>>(),
        "mongo": mongo,
        "dragonfly": dragonfly,
    })
}

fn field<'a>(o: &'a Map<String, Value>, k: &str, ctx: &str) -> Result<&'a Value, String> {
    o.get(k).ok_or_else(|| format!("{ctx}: missing `{k}`"))
}

fn obj<'a>(v: &'a Value, ctx: &str) -> Result<&'a Map<String, Value>, String> {
    v.as_object()
        .ok_or_else(|| format!("{ctx}: expected an object"))
}

fn arr<'a>(v: &'a Value, ctx: &str) -> Result<&'a Vec<Value>, String> {
    v.as_array()
        .ok_or_else(|| format!("{ctx}: expected an array"))
}

fn string(v: &Value, ctx: &str) -> Result<String, String> {
    v.as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("{ctx}: expected a string"))
}

fn int(v: &Value, ctx: &str) -> Result<i64, String> {
    v.as_i64()
        .ok_or_else(|| format!("{ctx}: expected an integer"))
}

/// Read a capture file back.
pub fn from_file_json(v: &Value) -> Result<CaptureFile, String> {
    let o = obj(v, "capture")?;
    let version = field(o, "rig_capture", "capture")?.as_u64().unwrap_or(0);
    if version != CAPTURE_VERSION {
        return Err(format!(
            "capture format version {version}, this rig reads version {CAPTURE_VERSION}: re-record it with `dima-rig record`"
        ));
    }
    let prov = obj(field(o, "provenance", "capture")?, "provenance")?;
    let recorded = string(field(prov, "recorded_at", "provenance")?, "recorded_at")?;
    let provenance = Provenance {
        target: string(field(o, "target", "capture")?, "target")?,
        scenario: string(field(o, "scenario", "capture")?, "scenario")?,
        side: string(field(prov, "side", "provenance")?, "side")?,
        label: field(prov, "label", "provenance")?
            .as_str()
            .map(str::to_string),
        recorded_at: crate::timefmt::parse_iso(&recorded)
            .ok_or_else(|| format!("provenance.recorded_at: bad time `{recorded}`"))?,
        rig_version: string(field(prov, "rig_version", "provenance")?, "rig_version")?,
    };
    let h = obj(field(o, "hashes", "capture")?, "hashes")?;
    let hashes = Hashes {
        scenario: string(field(h, "scenario", "hashes")?, "hashes.scenario")?,
        files: obj(field(h, "files", "hashes")?, "hashes.files")?
            .iter()
            .map(|(k, v)| Ok((k.clone(), string(v, "hashes.files")?)))
            .collect::<Result<_, String>>()?,
    };
    let r = obj(field(o, "run", "capture")?, "run")?;
    let run = RunMeta {
        seeded_at: int(field(r, "seeded_at", "run")?, "run.seeded_at")?,
        start: int(field(r, "start", "run")?, "run.start")?,
        end: int(field(r, "end", "run")?, "run.end")?,
        process_start: int(field(r, "process_start", "run")?, "run.process_start")?,
        ports: obj(field(r, "ports", "run")?, "run.ports")?
            .iter()
            .map(|(k, v)| {
                v.as_u64()
                    .and_then(|p| u16::try_from(p).ok())
                    .map(|p| (k.clone(), p))
                    .ok_or_else(|| format!("run.ports.{k}: bad port"))
            })
            .collect::<Result<_, String>>()?,
        mongo_db: string(field(r, "mongo_db", "run")?, "run.mongo_db")?,
        mongo_uri: string(field(r, "mongo_uri", "run")?, "run.mongo_uri")?,
        dragonfly_db: field(r, "dragonfly_db", "run")?
            .as_u64()
            .and_then(|d| u8::try_from(d).ok())
            .ok_or("run.dragonfly_db: bad index")?,
        dragonfly_url: string(field(r, "dragonfly_url", "run")?, "run.dragonfly_url")?,
    };
    let steps = arr(field(o, "steps", "capture")?, "steps")?
        .iter()
        .enumerate()
        .map(|(i, s)| dec_step(s, i))
        .collect::<Result<Vec<_>, _>>()?;
    let mut mongo = BTreeMap::new();
    for (name, c) in obj(field(o, "mongo", "capture")?, "mongo")? {
        let ctx = format!("mongo.{name}");
        let co = obj(c, &ctx)?;
        let docs = |k: &str| -> Result<Vec<Document>, String> {
            arr(field(co, k, &ctx)?, &ctx)?
                .iter()
                .enumerate()
                .map(|(i, d)| dec_doc(d, &format!("{ctx}.{k}[{i}]")))
                .collect()
        };
        mongo.insert(
            name.clone(),
            RawColl {
                kind: string(field(co, "type", &ctx)?, &ctx)?,
                options: dec_doc(field(co, "options", &ctx)?, &ctx)?,
                indexes: docs("indexes")?,
                docs: docs("documents")?,
            },
        );
    }
    let mut dragonfly = Vec::new();
    for (i, e) in arr(field(o, "dragonfly", "capture")?, "dragonfly")?
        .iter()
        .enumerate()
    {
        let ctx = format!("dragonfly[{i}]");
        let eo = obj(e, &ctx)?;
        let kind = string(field(eo, "type", &ctx)?, &ctx)?;
        dragonfly.push(RawEntry {
            key: dec_bytes(field(eo, "key", &ctx)?, &ctx)?,
            value: dec_value(&kind, field(eo, "value", &ctx)?, &ctx)?,
            kind,
            pttl: int(field(eo, "pttl", &ctx)?, &ctx)?,
            pttl_at: int(field(eo, "pttl_at", &ctx)?, &ctx)?,
        });
    }
    Ok(CaptureFile {
        provenance,
        hashes,
        run,
        raw: RawCapture {
            steps,
            mongo,
            dragonfly,
        },
    })
}

/// Pretty JSON with a trailing newline, as stored on disk.
pub fn to_file_string(f: &CaptureFile) -> String {
    let mut s = serde_json::to_string_pretty(&to_file_json(f)).unwrap_or_default();
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;
    use bson::doc;

    fn sample() -> CaptureFile {
        let mut raw = RawCapture {
            steps: vec![
                RawStep::Http(RawHttp {
                    at: 1_794_400_000_100,
                    status: 201,
                    headers: vec![
                        ("content-type".into(), b"application/json".to_vec()),
                        ("x-odd".into(), vec![0xff, 0x41]),
                        ("set-cookie".into(), b"a=1".to_vec()),
                        ("set-cookie".into(), b"b=2".to_vec()),
                    ],
                    body: br#"{"b":1,"a":5.0}"#.to_vec(),
                }),
                RawStep::Reply(RawReplyStep {
                    at: 1_794_400_000_200,
                    command: vec!["HGETALL".into(), "h".into()],
                    reply: RawReply::Array(vec![
                        RawReply::Bulk(vec![0x80]),
                        RawReply::Nil,
                        RawReply::Int(-3),
                        RawReply::Double(1.5),
                        RawReply::Map(vec![(RawReply::Status("OK".into()), RawReply::Bool(true))]),
                        RawReply::Error("ERR no".into()),
                    ]),
                }),
                RawStep::Done("pause_ms".into()),
            ],
            mongo: [(
                "items".to_string(),
                RawColl {
                    kind: "collection".into(),
                    options: doc! {},
                    indexes: vec![
                        doc! {"v": 2, "key": {"_id": 1}, "name": "_id_"},
                        doc! {"v": 2, "key": {"b": 1, "a": -1}, "name": "b_1_a_-1", "unique": true},
                    ],
                    docs: vec![
                        doc! {"_id": 2, "n": 1_i64, "f": 5.0, "nan": f64::NAN, "d": bson::DateTime::from_millis(5)},
                        doc! {"_id": 1, "$rigBson": "not raw"},
                    ],
                },
            )]
            .into(),
            dragonfly: vec![
                RawEntry {
                    key: vec![b'k', 0xfe],
                    kind: "hash".into(),
                    value: RawValue::Hash(vec![
                        (b"z".to_vec(), b"1".to_vec()),
                        (vec![0xc3], vec![0xff]),
                    ]),
                    pttl: -1,
                    pttl_at: 1_794_400_000_300,
                },
                RawEntry {
                    key: b"stream".to_vec(),
                    kind: "stream".into(),
                    value: RawValue::Stream(vec![(
                        "1-0".into(),
                        vec![
                            (b"f".to_vec(), b"1".to_vec()),
                            (b"f".to_vec(), b"2".to_vec()),
                        ],
                    )]),
                    pttl: 5000,
                    pttl_at: 1_794_400_000_301,
                },
                RawEntry {
                    key: b"z".to_vec(),
                    kind: "zset".into(),
                    value: RawValue::ZSet(vec![(b"m".to_vec(), "1.5".into())]),
                    pttl: -1,
                    pttl_at: 1_794_400_000_302,
                },
                RawEntry {
                    key: b"s".to_vec(),
                    kind: "set".into(),
                    value: RawValue::Set(vec![b"b".to_vec(), b"a".to_vec()]),
                    pttl: -1,
                    pttl_at: 1_794_400_000_303,
                },
            ],
        };
        raw.sort();
        CaptureFile {
            provenance: Provenance {
                target: "t".into(),
                scenario: "a/b".into(),
                side: "reference".into(),
                label: Some("3c162c9f".into()),
                recorded_at: 1_794_400_001_000,
                rig_version: "0.1.0".into(),
            },
            hashes: Hashes {
                scenario: "fnv1a64:0".into(),
                files: vec![("a/b.json".into(), "fnv1a64:1".into())],
            },
            run: RunMeta {
                seeded_at: 1_794_399_999_000,
                start: 1_794_400_000_000,
                end: 1_794_400_000_900,
                process_start: 1_794_400_000_050,
                ports: [("http".to_string(), 41234)].into(),
                mongo_db: "rig_1_0_ref".into(),
                mongo_uri: "mongodb://127.0.0.1:27017/rig_1_0_ref".into(),
                dragonfly_db: 3,
                dragonfly_url: "redis://127.0.0.1:6379/3".into(),
            },
            raw,
        }
    }

    #[test]
    fn files_round_trip_exactly_and_stably() {
        let f = sample();
        let text = to_file_string(&f);
        let back = from_file_json(&serde_json::from_str(&text).unwrap()).unwrap();
        // NaN != NaN: compare through the text, which holds the BSON bytes for that document.
        assert_eq!(to_file_string(&back), text);
        assert_eq!(back.provenance, f.provenance);
        assert_eq!(back.run, f.run);
        assert_eq!(back.raw.steps, f.raw.steps);
        assert_eq!(back.raw.dragonfly, f.raw.dragonfly);
        // Stored order: documents by _id, keys by bytes, hash fields and set members sorted.
        assert!(text.find("\"_id\": {\n").is_some() || text.contains("$rigBson"));
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["dragonfly"][0]["key"], json!({"$rigBytes": "a/4="}));
        assert_eq!(v["dragonfly"][1]["key"], "s");
        assert_eq!(v["dragonfly"][1]["value"], json!(["a", "b"]));
        assert_eq!(
            v["dragonfly"][2]["value"][0]["fields"],
            json!([["f", "1"], ["f", "2"]]),
            "repeated stream fields survive, in order"
        );
        // A document that Extended JSON cannot carry is kept as BSON bytes.
        let docs = &v["mongo"]["items"]["documents"];
        assert!(docs[0].get("$rigBson").is_some() && docs[1].get("$rigBson").is_some());
        let mut wrong = v.clone();
        wrong["rig_capture"] = json!(1);
        assert!(from_file_json(&wrong).unwrap_err().contains("re-record"));
    }

    #[test]
    fn bytes_and_text_never_collide() {
        assert_eq!(enc_bytes(b"plain"), json!("plain"));
        assert_eq!(enc_bytes(&[0xff]), json!({"$rigBytes": "/w=="}));
        // A text that looks like the byte form is still a text.
        let tricky = enc_bytes(br#"{"$rigBytes":"/w=="}"#);
        assert!(tricky.is_string());
        assert_eq!(
            dec_bytes(&tricky, "x").unwrap(),
            br#"{"$rigBytes":"/w=="}"#.to_vec()
        );
    }

    #[test]
    fn uris_lose_their_credentials() {
        assert_eq!(
            redact_uri("mongodb://u:p%40ss@127.0.0.1:27017/rig_1?authSource=admin"),
            "mongodb://127.0.0.1:27017/rig_1?authSource=admin"
        );
        assert_eq!(redact_uri("mongodb://h/x"), "mongodb://h/x");
    }
}

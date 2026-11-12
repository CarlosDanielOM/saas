//! The normalised value model and its encoding in capture files.
//!
//! Normalised values are never stored (captures are raw); this encoding is how reports and
//! debugging output show them: canonical Extended JSON (MongoDB) or plain JSON (HTTP bodies),
//! with run-time values replaced by markers:
//!
//! | Value | Encoding |
//! |---|---|
//! | generated ObjectId / UUID / allowance-generated token | `{"$oid": "<oid:1>"}`, `{"$uuid": "<uuid:2>"}`, inside text `<gen:3>` |
//! | BSON date relative to the run start | `{"$date": "<t+153ms>"}`; outside the run window also the absolute time (for reading, not compared): `<t+60153ms@2026-11-11T10:01:00.153Z>`; a seeded `$rigNow` value: `<seed+60000ms>` |
//! | epoch-millisecond number in the time horizon | `{"$numberLong": "<t+...>"}`, `{"$numberDouble": "<t+...>"}`, JSON: `{"$rigNumber": "<t+...>"}` |
//! | string containing any of the above | `{"$rigText": "item:<oid:1>:lock"}` (`<<` is a literal `<`); times keep their shape: `<t+5ms|dddd-dd-ddTdd:dd:dd.dddZ>`, days: `<day+0>`, run-time names: `<run:port.http>` |
//! | object key containing any of the above | the key `"$rigText:item:<oid:1>"`; a literal key starting with `$` is written `"$rigLiteral:$key"` |
//! | Dragonfly string holding JSON | `{"$rigJson": ...}`; bytes that are not UTF-8: `{"$rigBytes": "<base64>"}` |

use base64::Engine as _;
use serde_json::{Map, Number, Value};

use crate::timefmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum IdKind {
    Oid,
    Uuid,
    Gen,
}

impl IdKind {
    pub fn tag(self) -> &'static str {
        match self {
            IdKind::Oid => "oid",
            IdKind::Uuid => "uuid",
            IdKind::Gen => "gen",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Id {
    /// Seen in the scenario's inputs or not generated during this run: compared exactly.
    Lit(String),
    /// Generated during the run, before numbering (only between detection and canonicalisation).
    Raw(IdKind, String),
    /// Generated during the run: the n-th distinct value of this kind in the capture.
    Gen(IdKind, u32),
}

/// A time. `Abs` compares exactly; `Rel` is relative to the run start (the first step) and
/// compares with a tolerance (`abs` is kept for reports when the time lies outside the run);
/// `Seed` is a `$rigNow` value the seed wrote, compared exactly by its seed offset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Moment {
    Abs(i64),
    Rel {
        off: i64,
        abs: Option<i64>,
    },
    /// `seed` is the `$rigNow` offset; `off` where it lies relative to the run start.
    Seed {
        seed: i64,
        off: i64,
    },
}

impl Moment {
    /// Milliseconds relative to the run start, for relations between times of one side.
    pub fn run_offset(&self) -> Option<i64> {
        match self {
            Moment::Abs(_) => None,
            Moment::Rel { off, .. } | Moment::Seed { off, .. } => Some(*off),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Seg {
    Lit(String),
    Id(Id),
    /// A time written inside a string; `shape` is the original text with digits replaced by `d`
    /// (`ms` for a 13-digit epoch-millisecond run).
    Time {
        at: Moment,
        shape: String,
    },
    /// A `YYYY-MM-DD` day relative to the run start's UTC day.
    Day {
        off: i64,
        abs: Option<String>,
    },
    /// A run-time name such as the side's port or database name.
    Name(String),
    /// Bytes that are not UTF-8 (in a Dragonfly key, hash field or header): never equal to any
    /// text.
    Bytes(Vec<u8>),
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Text(pub Vec<Seg>);

impl Text {
    pub fn lit(s: &str) -> Text {
        if s.is_empty() {
            Text(Vec::new())
        } else {
            Text(vec![Seg::Lit(s.to_string())])
        }
    }

    /// Merge neighbouring literals and drop empty ones.
    pub fn from_segs(segs: Vec<Seg>) -> Text {
        let mut out: Vec<Seg> = Vec::with_capacity(segs.len());
        for s in segs {
            match s {
                Seg::Lit(l) if l.is_empty() => {}
                Seg::Lit(l) => match out.last_mut() {
                    Some(Seg::Lit(prev)) => prev.push_str(&l),
                    _ => out.push(Seg::Lit(l)),
                },
                other => out.push(other),
            }
        }
        Text(out)
    }

    /// The text when it holds no markers.
    pub fn as_plain(&self) -> Option<&str> {
        match self.0.as_slice() {
            [] => Some(""),
            [Seg::Lit(s)] => Some(s),
            _ => None,
        }
    }

    pub fn has_atoms(&self) -> bool {
        self.as_plain().is_none()
    }

    /// The text as written in a capture: literal `<` doubled, markers in angle brackets.
    pub fn encode(&self) -> String {
        let mut out = String::new();
        for s in &self.0 {
            match s {
                Seg::Lit(l) => out.push_str(&l.replace('<', "<<")),
                Seg::Id(id) => out.push_str(&encode_id(id)),
                Seg::Time { at, shape } => {
                    out.push('<');
                    out.push_str(&encode_moment(at));
                    out.push('|');
                    out.push_str(shape);
                    out.push('>');
                }
                Seg::Day { off, abs } => {
                    out.push_str("<day");
                    out.push_str(&signed(*off));
                    if let Some(a) = abs {
                        out.push('@');
                        out.push_str(a);
                    }
                    out.push('>');
                }
                Seg::Name(n) => {
                    out.push_str("<run:");
                    out.push_str(n);
                    out.push('>');
                }
                Seg::Bytes(b) => {
                    out.push_str("<bytes:");
                    out.push_str(&hex(b));
                    out.push('>');
                }
            }
        }
        out
    }

    /// Readable form for reports: the plain text, or the encoded form when it has markers.
    pub fn display(&self) -> String {
        match self.as_plain() {
            Some(s) => s.to_string(),
            None => self.encode(),
        }
    }
}

/// Lower-case hex.
pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn signed(n: i64) -> String {
    if n < 0 {
        n.to_string()
    } else {
        format!("+{n}")
    }
}

fn encode_id(id: &Id) -> String {
    match id {
        Id::Lit(v) => v.replace('<', "<<"),
        Id::Raw(k, v) => format!("<{}={}>", k.tag(), v),
        Id::Gen(k, n) => format!("<{}:{}>", k.tag(), n),
    }
}

/// `t+153ms`, `t+60153ms@2026-...Z`, `t@2026-...Z` (without the angle brackets).
pub fn encode_moment(m: &Moment) -> String {
    let iso = |ms: i64| timefmt::format_iso_ms(ms).unwrap_or_else(|| ms.to_string());
    match m {
        Moment::Abs(ms) => format!("t@{}", iso(*ms)),
        Moment::Rel { off, abs: None } => format!("t{}", timefmt::format_offset(*off)),
        Moment::Rel { off, abs: Some(a) } => {
            format!("t{}@{}", timefmt::format_offset(*off), iso(*a))
        }
        Moment::Seed { seed, .. } => format!("seed{}", timefmt::format_offset(*seed)),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NumRepr {
    /// BSON date.
    Date,
    /// BSON int64 holding epoch milliseconds.
    Int64,
    /// BSON double holding epoch milliseconds.
    Double,
    /// JSON number holding epoch milliseconds.
    Json,
    /// Epoch seconds (declared with a `time` allowance, `"unit": "s"`), as int32, int64,
    /// double or a JSON number.
    Int32Secs,
    Int64Secs,
    DoubleSecs,
    JsonSecs,
    /// A JSON number holding a remaining duration (`ttl` allowance), in seconds or ms.
    JsonTtlSecs,
    JsonTtlMs,
}

impl NumRepr {
    pub fn describe(self) -> &'static str {
        match self {
            NumRepr::Date => "BSON date",
            NumRepr::Int64 => "int64 epoch-ms",
            NumRepr::Double => "double epoch-ms",
            NumRepr::Json => "JSON number epoch-ms",
            NumRepr::Int32Secs => "int32 epoch-s",
            NumRepr::Int64Secs => "int64 epoch-s",
            NumRepr::DoubleSecs => "double epoch-s",
            NumRepr::JsonSecs => "JSON number epoch-s",
            NumRepr::JsonTtlSecs => "JSON number TTL-s",
            NumRepr::JsonTtlMs => "JSON number TTL-ms",
        }
    }

    /// Millisecond precision (epoch seconds have one-second precision).
    pub fn fine(self) -> bool {
        matches!(
            self,
            NumRepr::Date | NumRepr::Int64 | NumRepr::Double | NumRepr::Json | NumRepr::JsonTtlMs
        )
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Val {
    Null,
    Bool(bool),
    /// A JSON number (HTTP bodies, Dragonfly JSON, replies): compared by value.
    Num(Number),
    Int32(i32),
    Int64(i64),
    Double(f64),
    Dec(String),
    Time(NumRepr, Moment),
    Oid(Id),
    Uuid(Id),
    Str(Text),
    Bytes(Vec<u8>),
    /// A Dragonfly string that holds JSON (stored in its compact form).
    Json(Box<Val>),
    Arr(Vec<Val>),
    Obj(Vec<(Text, Val)>),
    /// Any other BSON type, in canonical Extended JSON, compared exactly.
    Ext(Value),
    /// A Dragonfly type the rig does not read yet.
    Unsupported(String),
}

impl Val {
    pub fn str(s: &str) -> Val {
        Val::Str(Text::lit(s))
    }

    /// A short type name for reports.
    pub fn type_name(&self) -> String {
        match self {
            Val::Null => "null".into(),
            Val::Bool(_) => "boolean".into(),
            Val::Num(_) => "number".into(),
            Val::Int32(_) => "int32".into(),
            Val::Int64(_) => "int64".into(),
            Val::Double(_) => "double".into(),
            Val::Dec(_) => "decimal128".into(),
            Val::Time(r, _) => r.describe().into(),
            Val::Oid(_) => "ObjectId".into(),
            Val::Uuid(_) => "UUID".into(),
            Val::Str(_) => "string".into(),
            Val::Bytes(_) => "bytes".into(),
            Val::Json(_) => "JSON text".into(),
            Val::Arr(_) => "array".into(),
            Val::Obj(_) => "object".into(),
            Val::Ext(v) => match v.as_object().and_then(|o| o.keys().next()) {
                Some(k) => format!("BSON {}", k.trim_start_matches('$')),
                None => "BSON value".into(),
            },
            Val::Unsupported(t) => format!("unsupported {t}"),
        }
    }

    /// Compact capture encoding, cut to `max` characters for reports.
    pub fn short(&self, max: usize) -> String {
        let s = match self {
            Val::Str(t) => serde_json::to_string(&t.display()).unwrap_or_default(),
            other => serde_json::to_string(&encode(other)).unwrap_or_default(),
        };
        cut(&s, max)
    }
}

/// Cut text to `max` characters, marking the cut.
pub fn cut(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

fn fmt_double(f: f64) -> String {
    if f.is_nan() {
        "NaN".into()
    } else if f.is_infinite() {
        if f > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        }
    } else {
        format!("{f:?}")
    }
}

fn single(key: &str, v: Value) -> Value {
    let mut m = Map::new();
    m.insert(key.to_string(), v);
    Value::Object(m)
}

fn marker(m: &Moment) -> String {
    format!("<{}>", encode_moment(m))
}

pub fn encode_key(k: &Text) -> String {
    match k.as_plain() {
        Some(p) if p.starts_with('$') => format!("$rigLiteral:{p}"),
        Some(p) => p.to_string(),
        None => format!("$rigText:{}", k.encode()),
    }
}

pub fn encode_text_value(t: &Text) -> Value {
    match t.as_plain() {
        Some(p) => Value::String(p.to_string()),
        None => single("$rigText", Value::String(t.encode())),
    }
}

fn encode_id_value(id: &Id) -> Value {
    match id {
        Id::Lit(v) => Value::String(v.clone()),
        other => Value::String(encode_id(other)),
    }
}

/// Encode a value for a capture file.
pub fn encode(v: &Val) -> Value {
    match v {
        Val::Null => Value::Null,
        Val::Bool(b) => Value::Bool(*b),
        Val::Num(n) => Value::Number(n.clone()),
        Val::Int32(i) => single("$numberInt", Value::String(i.to_string())),
        Val::Int64(i) => single("$numberLong", Value::String(i.to_string())),
        Val::Double(f) => single("$numberDouble", Value::String(fmt_double(*f))),
        Val::Dec(s) => single("$numberDecimal", Value::String(s.clone())),
        Val::Time(NumRepr::Date, Moment::Abs(ms)) => match timefmt::format_iso_ms(*ms) {
            Some(iso) => single("$date", Value::String(iso)),
            None => single(
                "$date",
                single("$numberLong", Value::String(ms.to_string())),
            ),
        },
        Val::Time(NumRepr::Date, m) => single("$date", Value::String(marker(m))),
        Val::Time(NumRepr::Int64 | NumRepr::Int64Secs, m) => {
            single("$numberLong", Value::String(marker(m)))
        }
        Val::Time(NumRepr::Int32Secs, m) => single("$numberInt", Value::String(marker(m))),
        Val::Time(NumRepr::Double | NumRepr::DoubleSecs, m) => {
            single("$numberDouble", Value::String(marker(m)))
        }
        Val::Time(
            NumRepr::Json | NumRepr::JsonSecs | NumRepr::JsonTtlSecs | NumRepr::JsonTtlMs,
            m,
        ) => single("$rigNumber", Value::String(marker(m))),
        Val::Oid(id) => single("$oid", encode_id_value(id)),
        Val::Uuid(id) => single("$uuid", encode_id_value(id)),
        Val::Str(t) => encode_text_value(t),
        Val::Bytes(b) => single(
            "$rigBytes",
            Value::String(base64::engine::general_purpose::STANDARD.encode(b)),
        ),
        Val::Json(inner) => single("$rigJson", encode(inner)),
        Val::Arr(items) => Value::Array(items.iter().map(encode).collect()),
        Val::Obj(kv) => {
            let mut m = Map::new();
            for (k, v) in kv {
                m.insert(encode_key(k), encode(v));
            }
            Value::Object(m)
        }
        Val::Ext(e) => e.clone(),
        Val::Unsupported(t) => single("$rigUnsupported", Value::String(t.clone())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn readable_encodings() {
        assert_eq!(
            encode(&Val::Oid(Id::Gen(IdKind::Oid, 1))),
            json!({"$oid": "<oid:1>"})
        );
        assert_eq!(
            encode(&Val::Time(
                NumRepr::Date,
                Moment::Rel {
                    off: 60_000,
                    abs: Some(0)
                }
            )),
            json!({"$date": "<t+60000ms@1970-01-01T00:00:00.000Z>"})
        );
        assert_eq!(encode(&Val::Double(5.0)), json!({"$numberDouble": "5.0"}));
        assert_eq!(encode(&Val::str("a<b")), json!("a<b"));
        let t = Text::from_segs(vec![
            Seg::Lit("a<b ".into()),
            Seg::Id(Id::Gen(IdKind::Gen, 3)),
        ]);
        assert_eq!(encode(&Val::Str(t)), json!({"$rigText": "a<<b <gen:3>"}));
    }

    #[test]
    fn bytes_never_read_as_text() {
        let b = Text(vec![Seg::Bytes(vec![0xff, 0x41])]);
        assert_eq!(b.encode(), "<bytes:ff41>");
        assert!(b.as_plain().is_none());
        // The same characters written literally are escaped, so they cannot collide.
        assert_eq!(Text::lit("<bytes:ff41>").encode(), "<<bytes:ff41>");
    }
}

//! Plain JavaScript data, with UTF16 strings and explicit coercion boundaries.
//! `from_json` cannot recover object insertion order lost by serde_json's map.
//! Use `json_parse` on original text when that ordering is observable.
use super::EvalError;
use std::{cell::RefCell, rc::Rc};

pub use crate::utils::ast_syntax::JsString;

#[derive(Clone, Debug, Default)]
pub enum JsValue {
    #[default]
    Undefined,
    Null,
    Boolean(bool),
    Number(f64),
    String(JsString),
    Array(Rc<RefCell<Vec<JsValue>>>),
    Object(Rc<RefCell<Vec<(JsString, JsValue)>>>),
}
impl JsValue {
    pub fn string(s: impl Into<JsString>) -> Self {
        Self::String(s.into())
    }
    pub fn array(v: Vec<Self>) -> Self {
        Self::Array(Rc::new(RefCell::new(v)))
    }
    pub fn object(v: Vec<(JsString, Self)>) -> Self {
        Self::Object(Rc::new(RefCell::new(v)))
    }
    pub fn from_json(v: &serde_json::Value) -> Self {
        use serde_json::Value as J;
        if let Some(s) = v.get("$value").and_then(J::as_str) {
            match s {
                "undefined" => return Self::Undefined,
                "NaN" => return Self::Number(f64::NAN),
                "Infinity" => return Self::Number(f64::INFINITY),
                "-Infinity" => return Self::Number(f64::NEG_INFINITY),
                "-0" => return Self::Number(-0.0),
                _ => {}
            }
        }
        match v {
            J::Null => Self::Null,
            J::Bool(b) => Self::Boolean(*b),
            J::Number(n) => Self::Number(n.as_f64().unwrap_or(f64::NAN)),
            J::String(s) => Self::string(s),
            J::Array(a) => Self::array(a.iter().map(Self::from_json).collect()),
            J::Object(o) => Self::object(
                o.iter()
                    .map(|(k, v)| (k.into(), Self::from_json(v)))
                    .collect(),
            ),
        }
    }
    pub fn to_typed_json(&self) -> serde_json::Value {
        use serde_json::json;
        match self {
            Self::Undefined => json!({"type":"undefined"}),
            Self::Null => json!({"type":"null"}),
            Self::Boolean(v) => json!({"type":"boolean", "value":v}),
            Self::Number(n) => {
                let v = if n.is_nan() {
                    json!("NaN")
                } else if *n == f64::INFINITY {
                    json!("Infinity")
                } else if *n == f64::NEG_INFINITY {
                    json!("-Infinity")
                } else if *n == 0.0 && n.is_sign_negative() {
                    json!("-0")
                } else if n.fract() == 0.0 && *n >= i64::MIN as f64 && *n < 9223372036854775808.0 {
                    json!(*n as i64)
                } else if n.fract() == 0.0 && *n >= 0.0 && *n < 18446744073709551616.0 {
                    json!(*n as u64)
                } else {
                    json!(n)
                };
                json!({"type":"number", "value":v})
            }
            Self::String(s) => match s.to_utf8() {
                Ok(s) => json!({"type":"string", "value":s}),
                Err(_) => json!({"type":"string", "utf16":s.units()}),
            },
            Self::Array(a) => {
                json!({"type":"array", "value":a.borrow().iter().map(Self::to_typed_json).collect::<Vec<_>>()})
            }
            Self::Object(o) => {
                let o = o.borrow();
                let entries = property_order(&o)
                    .into_iter()
                    .map(|i| {
                        let (k, v) = &o[i];
                        let key = k
                            .to_utf8()
                            .map(serde_json::Value::String)
                            .unwrap_or_else(|_| json!({"utf16":k.units()}));
                        json!([key, v.to_typed_json()])
                    })
                    .collect::<Vec<_>>();
                json!({"type":"object", "value":entries})
            }
        }
    }
    pub fn get(&self, key: &str) -> Self {
        match self {
            Self::Object(o) => o
                .borrow()
                .iter()
                .find(|(k, _)| k.units().iter().copied().eq(key.encode_utf16()))
                .map(|(_, v)| v.clone())
                .unwrap_or_default(),
            _ => Self::Undefined,
        }
    }
    pub fn set(&self, key: impl Into<JsString>, value: Self) {
        if let Self::Object(o) = self {
            let key = key.into();
            let mut o = o.borrow_mut();
            if let Some((_, v)) = o.iter_mut().find(|(k, _)| k == &key) {
                *v = value;
            } else {
                o.push((key, value));
            }
        }
    }
    pub fn is_nullish(&self) -> bool {
        matches!(self, Self::Undefined | Self::Null)
    }
    pub fn is_empty_string(&self) -> bool {
        matches!(self, Self::String(s) if s.is_empty())
    }
}

pub use crate::utils::json_number::number_string;

pub fn js_string(v: &JsValue) -> JsString {
    enum Part {
        Value(JsValue),
        Comma,
        End(usize),
    }
    let mut tasks = vec![Part::Value(v.clone())];
    let mut active = std::collections::HashSet::new();
    let mut out = JsString::default();
    while let Some(task) = tasks.pop() {
        match task {
            Part::Comma => out.push(&",".into()),
            Part::End(id) => {
                active.remove(&id);
            }
            Part::Value(v) => match v {
                JsValue::Undefined => out.push(&"undefined".into()),
                JsValue::Null => out.push(&"null".into()),
                JsValue::Boolean(b) => out.push(&if b { "true" } else { "false" }.into()),
                JsValue::Number(n) => out.push(&number_string(n).into()),
                JsValue::String(s) => out.push(&s),
                JsValue::Object(_) => out.push(&"[object Object]".into()),
                JsValue::Array(a) => {
                    let id = Rc::as_ptr(&a) as usize;
                    if !active.insert(id) {
                        continue;
                    }
                    tasks.push(Part::End(id));
                    for (i, v) in a.borrow().iter().enumerate().rev() {
                        if !v.is_nullish() {
                            tasks.push(Part::Value(v.clone()));
                        }
                        if i > 0 {
                            tasks.push(Part::Comma);
                        }
                    }
                }
            },
        }
    }
    out
}
pub fn nullish_string(v: &JsValue) -> JsString {
    if v.is_nullish() {
        JsString::default()
    } else {
        js_string(v)
    }
}
pub fn js_truthy(v: &JsValue) -> bool {
    match v {
        JsValue::Undefined | JsValue::Null => false,
        JsValue::Boolean(b) => *b,
        JsValue::Number(n) => *n != 0.0 && !n.is_nan(),
        JsValue::String(s) => !s.is_empty(),
        _ => true,
    }
}
pub fn is_truthy(v: &JsValue) -> bool {
    if v.is_nullish() {
        return false;
    }
    if matches!(v, JsValue::Boolean(false) | JsValue::Number(0.0)) {
        return false;
    }
    let s = js_string(v).lower().trim();
    !["false", "0", ""].iter().any(|x| s == JsString::from(*x))
}
pub fn parse_float(s: &JsString) -> f64 {
    let s = s.trim();
    let u = s.units();
    let mut i = 0;
    if matches!(u.first(), Some(43 | 45)) {
        i += 1;
    }
    let prefix: Vec<u16> = "Infinity".encode_utf16().collect();
    if u.get(i..).is_some_and(|s| s.starts_with(&prefix)) {
        return if u.first() == Some(&45) {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let start = i;
    while u.get(i).is_some_and(|c| (48..=57).contains(c)) {
        i += 1;
    }
    let mut digits = i - start;
    if u.get(i) == Some(&46) {
        i += 1;
        let start = i;
        while u.get(i).is_some_and(|c| (48..=57).contains(c)) {
            i += 1;
        }
        digits += i - start;
    }
    if digits == 0 {
        return f64::NAN;
    }
    if matches!(u.get(i), Some(69 | 101)) {
        let old = i;
        i += 1;
        if matches!(u.get(i), Some(43 | 45)) {
            i += 1;
        }
        let start = i;
        while u.get(i).is_some_and(|c| (48..=57).contains(c)) {
            i += 1;
        }
        if i == start {
            i = old;
        }
    }
    String::from_utf16(&u[..i])
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(f64::NAN)
}
pub fn parse_int(s: &JsString) -> f64 {
    let s = s.trim();
    let u = s.units();
    let mut i = 0;
    if matches!(u.first(), Some(43 | 45)) {
        i += 1;
    }
    let start = i;
    while u.get(i).is_some_and(|c| (48..=57).contains(c)) {
        i += 1;
    }
    if i == start {
        return f64::NAN;
    }
    String::from_utf16(&u[..i])
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(f64::NAN)
}
pub fn to_number(v: &JsValue) -> f64 {
    match v {
        JsValue::Undefined => return f64::NAN,
        JsValue::Null => return 0.0,
        JsValue::Boolean(b) => return if *b { 1.0 } else { 0.0 },
        JsValue::Number(n) => return *n,
        _ => {}
    }
    let s = js_string(v).trim();
    if s.is_empty() {
        return 0.0;
    }
    let Ok(s) = s.to_utf8() else {
        return f64::NAN;
    };
    if s == "Infinity" || s == "+Infinity" {
        return f64::INFINITY;
    }
    if s == "-Infinity" {
        return f64::NEG_INFINITY;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ] {
        if let Some(d) = s.strip_prefix(prefix) {
            if d.is_empty() {
                return f64::NAN;
            }
            let width = match radix {
                2 => 1,
                8 => 3,
                _ => 4,
            };
            let mut bits = Vec::new();
            for c in d.chars() {
                let Some(n) = c.to_digit(radix) else {
                    return f64::NAN;
                };
                for shift in (0..width).rev() {
                    if !bits.is_empty() || (n >> shift) & 1 != 0 {
                        bits.push((n >> shift) & 1);
                    }
                }
            }
            if bits.is_empty() {
                return 0.0;
            }
            if bits.len() <= 53 {
                return bits.into_iter().fold(0.0, |n, b| n * 2.0 + f64::from(b));
            }
            let mut significand = bits[..53].iter().fold(0u64, |n, b| n * 2 + u64::from(*b));
            if bits[53] != 0 && (bits[54..].iter().any(|b| *b != 0) || significand & 1 != 0) {
                significand += 1;
            }
            let exponent = bits.len() - 53;
            if exponent > 1023 {
                return f64::INFINITY;
            }
            return significand as f64 * 2.0f64.powi(exponent as i32);
        }
    }
    // Rust accepts inf; JavaScript Number does not.
    if s.chars()
        .any(|c| !c.is_ascii_digit() && !matches!(c, '+' | '-' | '.' | 'e' | 'E'))
    {
        return f64::NAN;
    }
    s.parse().unwrap_or(f64::NAN)
}
pub fn to_number_safe(v: &JsValue) -> f64 {
    if let JsValue::Number(n) = v
        && n.is_finite()
    {
        return *n;
    }
    let n = parse_float(&nullish_string(v));
    if n.is_finite() { n } else { 0.0 }
}
pub fn resolve_array_index(v: &JsValue, length: usize) -> Option<usize> {
    let n = match v {
        JsValue::Number(n) => n.trunc(),
        _ => parse_int(&js_string(v)),
    };
    if !n.is_finite() {
        return None;
    }
    let n = if n < 0.0 { length as f64 + n } else { n };
    if n >= 0.0 && n < (length as f64) {
        Some(n as usize)
    } else {
        None
    }
}
fn numeric_comparison_string(s: &JsString) -> bool {
    let u = s.units();
    let mut i = usize::from(u.first() == Some(&45));
    let start = i;
    while u.get(i).is_some_and(|c| (48..=57).contains(c)) {
        i += 1;
    }
    if i == start {
        return false;
    }
    if u.get(i) == Some(&46) {
        i += 1;
        let start = i;
        while u.get(i).is_some_and(|c| (48..=57).contains(c)) {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    i == u.len()
}
pub fn safe_compare(left: &JsValue, op: &str, right: &JsValue) -> bool {
    let l = js_string(left).trim();
    let r = js_string(right).trim();
    let numeric = numeric_comparison_string(&l) && numeric_comparison_string(&r);
    let ln = to_number(&JsValue::String(l.clone()));
    let rn = to_number(&JsValue::String(r.clone()));
    match op {
        "=" | "==" => {
            if numeric {
                ln == rn
            } else {
                l.lower() == r.lower()
            }
        }
        "!=" | "<>" => {
            if numeric {
                ln != rn
            } else {
                l.lower() != r.lower()
            }
        }
        ">" => {
            if numeric {
                ln > rn
            } else {
                l > r
            }
        }
        "<" => {
            if numeric {
                ln < rn
            } else {
                l < r
            }
        }
        ">=" => {
            if numeric {
                ln >= rn
            } else {
                l >= r
            }
        }
        "<=" => {
            if numeric {
                ln <= rn
            } else {
                l <= r
            }
        }
        "~=" => {
            let l = l.lower();
            let r = r.lower();
            r.is_empty() || l.units().windows(r.len()).any(|s| s == r.units())
        }
        _ => false,
    }
}
pub fn math_round(n: f64) -> f64 {
    if !n.is_finite() || n == 0.0 {
        return n;
    }
    if (-0.5..0.0).contains(&n) {
        return -0.0;
    }
    let floor = n.floor();
    if n - floor < 0.5 { floor } else { floor + 1.0 }
}

fn array_index_key(k: &JsString) -> Option<u32> {
    let s = k.to_utf8().ok()?;
    let n = s.parse::<u32>().ok()?;
    if n == u32::MAX || n.to_string() != s {
        None
    } else {
        Some(n)
    }
}
pub fn property_order(o: &[(JsString, JsValue)]) -> Vec<usize> {
    let mut numeric = Vec::new();
    let mut other = Vec::new();
    for (i, (k, _)) in o.iter().enumerate() {
        if let Some(n) = array_index_key(k) {
            numeric.push((n, i));
        } else {
            other.push(i);
        }
    }
    numeric.sort_by_key(|x| x.0);
    numeric.into_iter().map(|x| x.1).chain(other).collect()
}

/// Parses original UTF16 JSON with an iterative container stack. Insertion
/// order, duplicate-key position and lone surrogates are retained; no new
/// variable-value depth or workload cap is imposed.
pub fn json_parse(s: &JsString) -> Result<JsValue, EvalError> {
    let mut p = JsonParser { u: s.units(), i: 0 };
    let mut frames = Vec::new();
    let mut completed = None;
    let mut need_value = true;
    loop {
        if need_value {
            match p.start()? {
                Start::Value(v) => completed = Some(v),
                Start::Array => frames.push(JsonFrame::Array(Vec::new(), 0)),
                Start::Object => frames.push(JsonFrame::Object(Vec::new(), None, 0)),
            }
            need_value = false;
        }
        if let Some(value) = completed.take() {
            match frames.last_mut() {
                Some(JsonFrame::Array(values, state)) => {
                    values.push(value);
                    *state = 1;
                }
                Some(JsonFrame::Object(values, key, state)) => {
                    let key = key.take().ok_or_else(json_error)?;
                    if let Some((_, v)) = values.iter_mut().find(|(k, _)| k == &key) {
                        *v = value;
                    } else {
                        values.push((key, value));
                    }
                    *state = 1;
                }
                None => {
                    p.ws();
                    return if p.i == p.u.len() {
                        Ok(value)
                    } else {
                        Err(json_error())
                    };
                }
            }
        }
        let Some(frame) = frames.last_mut() else {
            return Err(json_error());
        };
        match frame {
            JsonFrame::Array(_, state) => {
                if *state == 1 {
                    if p.take(44) {
                        *state = 2;
                    } else if p.take(93) {
                        if let Some(JsonFrame::Array(values, _)) = frames.pop() {
                            completed = Some(JsValue::array(values));
                        }
                    } else {
                        return Err(json_error());
                    }
                } else if *state == 0 && p.take(93) {
                    frames.pop();
                    completed = Some(JsValue::array(Vec::new()));
                } else {
                    need_value = true;
                }
            }
            JsonFrame::Object(_, key, state) => {
                if *state == 1 {
                    if p.take(44) {
                        *state = 2;
                    } else if p.take(125) {
                        if let Some(JsonFrame::Object(values, _, _)) = frames.pop() {
                            completed = Some(JsValue::object(values));
                        }
                    } else {
                        return Err(json_error());
                    }
                } else if *state == 0 && p.take(125) {
                    frames.pop();
                    completed = Some(JsValue::object(Vec::new()));
                } else {
                    *key = Some(p.string()?);
                    if !p.take(58) {
                        return Err(json_error());
                    }
                    need_value = true;
                }
            }
        }
    }
}
fn json_error() -> EvalError {
    EvalError {
        name: "SyntaxError".into(),
        message: "Invalid JSON".into(),
    }
}
enum JsonFrame {
    Array(Vec<JsValue>, u8),
    Object(Vec<(JsString, JsValue)>, Option<JsString>, u8),
}
enum Start {
    Value(JsValue),
    Array,
    Object,
}
struct JsonParser<'a> {
    u: &'a [u16],
    i: usize,
}
impl JsonParser<'_> {
    fn ws(&mut self) {
        while matches!(self.u.get(self.i), Some(9 | 10 | 13 | 32)) {
            self.i += 1;
        }
    }
    fn take(&mut self, c: u16) -> bool {
        self.ws();
        if self.u.get(self.i) == Some(&c) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn string(&mut self) -> Result<JsString, EvalError> {
        if !self.take(34) {
            return Err(json_error());
        }
        let mut out = Vec::new();
        loop {
            let Some(&c) = self.u.get(self.i) else {
                return Err(json_error());
            };
            self.i += 1;
            match c {
                34 => return Ok(JsString(out)),
                0..=31 => return Err(json_error()),
                92 => {
                    let Some(&e) = self.u.get(self.i) else {
                        return Err(json_error());
                    };
                    self.i += 1;
                    out.push(match e {
                        34 | 47 | 92 => e,
                        98 => 8,
                        102 => 12,
                        110 => 10,
                        114 => 13,
                        116 => 9,
                        117 => {
                            let mut n = 0;
                            for _ in 0..4 {
                                let Some(&d) = self.u.get(self.i) else {
                                    return Err(json_error());
                                };
                                self.i += 1;
                                let digit = match d {
                                    48..=57 => d - 48,
                                    65..=70 => d - 55,
                                    97..=102 => d - 87,
                                    _ => return Err(json_error()),
                                };
                                n = n * 16 + digit;
                            }
                            n
                        }
                        _ => return Err(json_error()),
                    });
                }
                _ => out.push(c),
            }
        }
    }
    fn start(&mut self) -> Result<Start, EvalError> {
        self.ws();
        Ok(match self.u.get(self.i).copied() {
            Some(34) => Start::Value(JsValue::String(self.string()?)),
            Some(91) => {
                self.i += 1;
                Start::Array
            }
            Some(123) => {
                self.i += 1;
                Start::Object
            }
            Some(116) => Start::Value(self.keyword("true", JsValue::Boolean(true))?),
            Some(102) => Start::Value(self.keyword("false", JsValue::Boolean(false))?),
            Some(110) => Start::Value(self.keyword("null", JsValue::Null)?),
            Some(45 | 48..=57) => {
                let start = self.i;
                if self.u.get(self.i) == Some(&45) {
                    self.i += 1;
                }
                match self.u.get(self.i) {
                    Some(48) => self.i += 1,
                    Some(49..=57) => {
                        self.i += 1;
                        while self.u.get(self.i).is_some_and(|c| (48..=57).contains(c)) {
                            self.i += 1;
                        }
                    }
                    _ => return Err(json_error()),
                }
                if self.u.get(self.i) == Some(&46) {
                    self.i += 1;
                    let begin = self.i;
                    while self.u.get(self.i).is_some_and(|c| (48..=57).contains(c)) {
                        self.i += 1;
                    }
                    if begin == self.i {
                        return Err(json_error());
                    }
                }
                if matches!(self.u.get(self.i), Some(69 | 101)) {
                    self.i += 1;
                    if matches!(self.u.get(self.i), Some(43 | 45)) {
                        self.i += 1;
                    }
                    let begin = self.i;
                    while self.u.get(self.i).is_some_and(|c| (48..=57).contains(c)) {
                        self.i += 1;
                    }
                    if begin == self.i {
                        return Err(json_error());
                    }
                }
                let n = String::from_utf16(&self.u[start..self.i])
                    .map_err(|_| json_error())?
                    .parse::<f64>()
                    .map_err(|_| json_error())?;
                Start::Value(JsValue::Number(n))
            }
            _ => return Err(json_error()),
        })
    }
    fn keyword(&mut self, s: &str, v: JsValue) -> Result<JsValue, EvalError> {
        let units: Vec<_> = s.encode_utf16().collect();
        if self.u[self.i..].starts_with(&units) {
            self.i += units.len();
            Ok(v)
        } else {
            Err(json_error())
        }
    }
}

/// `None` is JSON.stringify(undefined). Cycles throw TypeError. Container
/// traversal is iterative and has no depth limit separate from the source.
pub fn json_stringify(v: &JsValue) -> Result<Option<JsString>, EvalError> {
    if matches!(v, JsValue::Undefined) {
        return Ok(None);
    }
    enum Emit {
        Value(JsValue),
        Text(JsString),
        End(usize, u16),
    }
    let mut tasks = vec![Emit::Value(v.clone())];
    let mut active = std::collections::HashSet::new();
    let mut out = JsString::default();
    while let Some(task) = tasks.pop() {
        match task {
            Emit::Text(s) => out.push(&s),
            Emit::End(id, c) => {
                out.0.push(c);
                active.remove(&id);
            }
            Emit::Value(v) => match v {
                JsValue::Undefined | JsValue::Null => out.push(&"null".into()),
                JsValue::Boolean(b) => out.push(&if b { "true" } else { "false" }.into()),
                JsValue::Number(n) => out.push(
                    &if n.is_finite() {
                        number_string(n)
                    } else {
                        "null".into()
                    }
                    .into(),
                ),
                JsValue::String(s) => quoted(&s, &mut out),
                JsValue::Array(a) => {
                    let id = Rc::as_ptr(&a) as usize;
                    if !active.insert(id) {
                        return Err(EvalError {
                            name: "TypeError".into(),
                            message: "Converting circular structure to JSON".into(),
                        });
                    }
                    out.0.push(91);
                    tasks.push(Emit::End(id, 93));
                    let a = a.borrow();
                    for (i, v) in a.iter().enumerate().rev() {
                        tasks.push(Emit::Value(v.clone()));
                        if i > 0 {
                            tasks.push(Emit::Text(",".into()));
                        }
                    }
                }
                JsValue::Object(o) => {
                    let id = Rc::as_ptr(&o) as usize;
                    if !active.insert(id) {
                        return Err(EvalError {
                            name: "TypeError".into(),
                            message: "Converting circular structure to JSON".into(),
                        });
                    }
                    out.0.push(123);
                    tasks.push(Emit::End(id, 125));
                    let o = o.borrow();
                    let entries = property_order(&o)
                        .into_iter()
                        .filter(|i| !matches!(o[*i].1, JsValue::Undefined))
                        .collect::<Vec<_>>();
                    for (position, i) in entries.into_iter().enumerate().rev() {
                        let (k, v) = &o[i];
                        tasks.push(Emit::Value(v.clone()));
                        tasks.push(Emit::Text(":".into()));
                        let mut key = JsString::default();
                        quoted(k, &mut key);
                        tasks.push(Emit::Text(key));
                        if position > 0 {
                            tasks.push(Emit::Text(",".into()));
                        }
                    }
                }
            },
        }
    }
    Ok(Some(out))
}
fn quoted(s: &JsString, out: &mut JsString) {
    out.0.push(34);
    let u = s.units();
    let mut i = 0;
    while i < u.len() {
        let c = u[i];
        match c {
            34 => out.push(&"\\\"".into()),
            92 => out.push(&"\\\\".into()),
            8 => out.push(&"\\b".into()),
            12 => out.push(&"\\f".into()),
            10 => out.push(&"\\n".into()),
            13 => out.push(&"\\r".into()),
            9 => out.push(&"\\t".into()),
            0..=31 => out.push(&format!("\\u{c:04x}").into()),
            0xd800..=0xdbff if u.get(i + 1).is_some_and(|c| (0xdc00..=0xdfff).contains(c)) => {
                out.0.push(c);
                i += 1;
                out.0.push(u[i]);
            }
            0xd800..=0xdfff => out.push(&format!("\\u{c:04x}").into()),
            _ => out.0.push(c),
        }
        i += 1;
    }
    out.0.push(34);
}

//! `qs` 6.15.3 `parse`, as Express uses it for `req.query` and body-parser for urlencoded bodies.
//!
//! The parser works on a small model of the JavaScript values qs builds (strings, sparse arrays,
//! objects whose array-index keys sort first, and objects flagged as array-limit overflow), so
//! nesting, duplicate keys, sparse indices, the array limit and key order come out exactly as in
//! Node. The result is a `serde_json::Value` (objects in JavaScript key order).

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::uri::decode_uri_component;

/// Options that differ between the two places Express calls qs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct QsOptions {
    /// `arrayLimit`: indices at or above it build an object instead of an array.
    pub array_limit: usize,
    /// `depth`: bracket groups split into nested keys.
    pub depth: usize,
    /// `strictDepth`: deeper keys fail instead of keeping the rest as one key.
    pub strict_depth: bool,
    /// `parameterLimit`: pairs after this many are ignored.
    pub parameter_limit: usize,
}

impl QsOptions {
    /// Express's query parser: `qs.parse(str, { allowPrototypes: true, arrayLimit: 1000 })`.
    pub const QUERY: Self = Self {
        array_limit: 1000,
        depth: 5,
        strict_depth: false,
        parameter_limit: 1000,
    };

    /// body-parser `urlencoded({ extended: true })` for a body with `parameter_count` pairs.
    pub fn urlencoded(parameter_count: usize, depth: usize, parameter_limit: usize) -> Self {
        Self {
            array_limit: parameter_count.max(100),
            depth,
            strict_depth: true,
            parameter_limit,
        }
    }
}

/// A key nested deeper than `depth` while `strict_depth` is set (qs throws a `RangeError`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Input depth exceeded depth option and strictDepth is true")]
pub struct DepthExceeded;

/// `req.query` for a raw query string (the text after `?`, without it).
pub fn parse_query(query: &str) -> Value {
    parse(query, &QsOptions::QUERY).unwrap_or_else(|_| Value::Object(Map::new()))
}

/// `qs.parse(input, options)`.
pub fn parse(input: &str, options: &QsOptions) -> Result<Value, DepthExceeded> {
    if input.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    let limit = options.array_limit as f64;
    let temp = parse_values(input, options);
    let mut result = V::Obj(Obj::default());
    for (key, value) in temp.into_entries() {
        let parsed = parse_keys(&key, value, options)?;
        result = merge(result, parsed, limit);
    }
    Ok(result.into_value())
}

/// A JavaScript value as qs builds it.
#[derive(Debug, Clone)]
enum V {
    Str(String),
    /// A JavaScript array; `None` is a hole.
    Arr(Vec<Option<V>>),
    Obj(Obj),
}

/// A plain JavaScript object: array-index keys enumerate first in ascending order, other keys in
/// insertion order. `overflow` is qs's side-channel mark (with the highest index) for objects
/// built when an array passed `arrayLimit`.
#[derive(Debug, Clone, Default)]
struct Obj {
    indexed: BTreeMap<u32, V>,
    named: Vec<(String, V)>,
    overflow: Option<f64>,
}

impl Obj {
    fn contains(&self, key: &str) -> bool {
        match array_index(key) {
            Some(index) => self.indexed.contains_key(&index),
            None => self.named.iter().any(|(k, _)| k == key),
        }
    }

    fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        match array_index(key) {
            Some(index) => self.indexed.get_mut(&index),
            None => self
                .named
                .iter_mut()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v),
        }
    }

    fn set(&mut self, key: String, value: V) {
        match array_index(&key) {
            Some(index) => {
                self.indexed.insert(index, value);
            }
            None => match self.named.iter_mut().find(|(k, _)| *k == key) {
                Some(slot) => slot.1 = value,
                None => self.named.push((key, value)),
            },
        }
    }

    /// `Object.keys` order.
    fn into_entries(self) -> impl Iterator<Item = (String, V)> {
        self.indexed
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .chain(self.named)
    }
}

impl V {
    fn is_object(&self) -> bool {
        matches!(self, V::Arr(_) | V::Obj(_))
    }

    fn is_overflow(&self) -> bool {
        matches!(self, V::Obj(obj) if obj.overflow.is_some())
    }

    /// Converts to JSON, dropping array holes (qs `utils.compact`).
    fn into_value(self) -> Value {
        match self {
            V::Str(s) => Value::String(s),
            V::Arr(items) => Value::Array(items.into_iter().flatten().map(V::into_value).collect()),
            V::Obj(obj) => Value::Object(
                obj.into_entries()
                    .map(|(k, v)| (k, v.into_value()))
                    .collect(),
            ),
        }
    }
}

/// A canonical array index (`"0"`, `"17"`, at most 4294967294): JavaScript enumerates these first.
fn array_index(key: &str) -> Option<u32> {
    let value = canonical_integer(key)?;
    (value <= 4_294_967_294.0).then_some(value as u32)
}

/// `n` when `String(parseInt(key, 10)) === key` and `n >= 0`: canonical decimal digits whose
/// double value prints back unchanged.
fn canonical_integer(key: &str) -> Option<f64> {
    if key.is_empty() || key.len() > 21 || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if key.len() > 1 && key.starts_with('0') {
        return None;
    }
    let exact: u128 = key.parse().ok()?;
    let double: f64 = key.parse().ok()?;
    (double < 1e21 && double as u128 == exact).then_some(double)
}

/// `String(n)` for a non-negative integral double below 1e21.
fn number_key(n: f64) -> String {
    if n.fract() == 0.0 && (0.0..1e21).contains(&n) {
        (n as u128).to_string()
    } else {
        format!("{n}")
    }
}

/// JavaScript `parseInt(key, 10)` as qs uses it when shifting overflow keys.
fn js_parse_int_key(key: &str) -> Option<f64> {
    let s = key.trim_start_matches(crate::mediatype::is_js_whitespace);
    let (negative, digits) = match s.as_bytes().first() {
        Some(b'-') => (true, s.get(1..).unwrap_or("")),
        Some(b'+') => (false, s.get(1..).unwrap_or("")),
        _ => (false, s),
    };
    let end = digits.bytes().take_while(u8::is_ascii_digit).count();
    let number: f64 = digits.get(..end).filter(|d| !d.is_empty())?.parse().ok()?;
    Some(if negative { -number } else { number })
}

fn array_to_object(items: Vec<Option<V>>) -> Obj {
    let mut obj = Obj::default();
    for (i, item) in items.into_iter().enumerate() {
        if let Some(item) = item {
            obj.set(i.to_string(), item);
        }
    }
    obj
}

fn overflow_object(items: Vec<Option<V>>, max_index: usize) -> V {
    let mut obj = array_to_object(items);
    obj.overflow = Some(max_index as f64);
    V::Obj(obj)
}

/// `[].concat(value)`: arrays spread (holes kept), anything else is one element.
fn concat_into(out: &mut Vec<Option<V>>, value: V) {
    match value {
        V::Arr(items) => out.extend(items),
        other => out.push(Some(other)),
    }
}

/// qs `utils.combine(a, b, arrayLimit)`.
fn combine(a: V, b: V, limit: f64) -> V {
    if let V::Obj(mut obj) = a {
        if let Some(max) = obj.overflow {
            let next = max + 1.0;
            obj.set(number_key(next), b);
            obj.overflow = Some(next);
            return V::Obj(obj);
        }
        return combine_plain(V::Obj(obj), b, limit);
    }
    combine_plain(a, b, limit)
}

fn combine_plain(a: V, b: V, limit: f64) -> V {
    let mut result = Vec::new();
    concat_into(&mut result, a);
    concat_into(&mut result, b);
    if result.len() as f64 > limit {
        let max = result.len() - 1;
        return overflow_object(result, max);
    }
    V::Arr(result)
}

/// qs `utils.merge(target, source)`; `None` is `undefined`.
fn merge(target: V, source: Option<V>, limit: f64) -> V {
    let source = match source {
        None => return target,
        Some(V::Str(s)) if s.is_empty() => return target,
        Some(source) => source,
    };
    match (target, source) {
        (V::Arr(mut items), V::Str(s)) => {
            let next = items.len();
            items.push(Some(V::Str(s)));
            if next as f64 >= limit {
                overflow_object(items, next)
            } else {
                V::Arr(items)
            }
        }
        (V::Obj(mut obj), V::Str(s)) => match obj.overflow {
            Some(max) => {
                let next = max + 1.0;
                obj.set(number_key(next), V::Str(s));
                obj.overflow = Some(next);
                V::Obj(obj)
            }
            // strictMerge: `[target, source]`.
            None => V::Arr(vec![Some(V::Obj(obj)), Some(V::Str(s))]),
        },
        (V::Str(t), V::Str(s)) => V::Arr(vec![Some(V::Str(t)), Some(V::Str(s))]),
        (V::Str(t), source) => merge_into_primitive(t, source, limit),
        (V::Arr(mut items), V::Arr(source)) => {
            for (i, item) in source.into_iter().enumerate() {
                let Some(item) = item else { continue };
                let existing = items.get_mut(i).and_then(Option::take);
                match existing {
                    Some(existing) if existing.is_object() && item.is_object() => {
                        if let Some(slot) = items.get_mut(i) {
                            *slot = Some(merge(existing, Some(item), limit));
                        }
                    }
                    Some(existing) => {
                        if let Some(slot) = items.get_mut(i) {
                            *slot = Some(existing);
                        }
                        items.push(Some(item));
                    }
                    None => {
                        if items.len() <= i {
                            items.resize_with(i + 1, || None);
                        }
                        if let Some(slot) = items.get_mut(i) {
                            *slot = Some(item);
                        }
                    }
                }
            }
            if items.len() as f64 > limit {
                let max = items.len() - 1;
                overflow_object(items, max)
            } else {
                V::Arr(items)
            }
        }
        (target, source) => {
            let mut acc = match target {
                V::Arr(items) => array_to_object(items),
                V::Obj(obj) => obj,
                V::Str(_) => Obj::default(),
            };
            let (entries, source_overflow): (Vec<(String, V)>, Option<f64>) = match source {
                V::Obj(obj) => {
                    let overflow = obj.overflow;
                    (obj.into_entries().collect(), overflow)
                }
                V::Arr(items) => (
                    items
                        .into_iter()
                        .enumerate()
                        .filter_map(|(i, v)| v.map(|v| (i.to_string(), v)))
                        .collect(),
                    None,
                ),
                V::Str(_) => (Vec::new(), None),
            };
            for (key, value) in entries {
                if acc.contains(&key) {
                    let merged = match acc.get_mut(&key) {
                        Some(slot) => merge(
                            std::mem::replace(slot, V::Str(String::new())),
                            Some(value),
                            limit,
                        ),
                        None => value,
                    };
                    acc.set(key.clone(), merged);
                } else {
                    acc.set(key.clone(), value);
                }
                if source_overflow.is_some() && acc.overflow.is_none() {
                    acc.overflow = source_overflow;
                }
                if let Some(max) = acc.overflow
                    && let Some(n) = canonical_integer(&key)
                    && n > max
                {
                    acc.overflow = Some(n);
                }
            }
            V::Obj(acc)
        }
    }
}

/// `merge` when the target is a (truthy or empty) string and the source an object or array.
fn merge_into_primitive(target: String, source: V, limit: f64) -> V {
    if let V::Obj(source) = &source
        && let Some(max) = source.overflow
    {
        let mut result = Obj::default();
        result.set("0".to_owned(), V::Str(target));
        {
            for (key, value) in source.clone().into_entries() {
                let shifted = match js_parse_int_key(&key) {
                    Some(n) => number_key(n + 1.0),
                    None => "NaN".to_owned(),
                };
                result.set(shifted, value);
            }
        }
        result.overflow = Some(max + 1.0);
        return V::Obj(result);
    }
    let mut combined = vec![Some(V::Str(target))];
    concat_into(&mut combined, source);
    if combined.len() as f64 > limit {
        let max = combined.len() - 1;
        return overflow_object(combined, max);
    }
    V::Arr(combined)
}

/// qs `utils.decode`: `+` is a space; a malformed escape leaves the text undecoded.
fn decode(text: &str) -> String {
    let spaced = text.replace('+', " ");
    decode_uri_component(&spaced).unwrap_or(spaced)
}

/// Replaces `%5B`/`%5D` (any case) with brackets, as qs does before splitting.
fn unescape_brackets(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(at) = rest.find('%') {
        out.push_str(rest.get(..at).unwrap_or(""));
        let tail = rest.get(at..).unwrap_or("");
        let code = tail.get(1..3).map(str::to_ascii_uppercase);
        match code.as_deref() {
            Some("5B") => {
                out.push('[');
                rest = tail.get(3..).unwrap_or("");
            }
            Some("5D") => {
                out.push(']');
                rest = tail.get(3..).unwrap_or("");
            }
            _ => {
                out.push('%');
                rest = tail.get(1..).unwrap_or("");
            }
        }
    }
    out.push_str(rest);
    out
}

/// qs `parseValues`: flat `key → value` pairs, duplicates combined.
fn parse_values(input: &str, options: &QsOptions) -> Obj {
    let limit = options.array_limit as f64;
    let clean = unescape_brackets(input);
    let mut obj = Obj::default();
    for part in clean.split('&').take(options.parameter_limit) {
        let position = match part.find("]=") {
            Some(at) => Some(at + 1),
            None => part.find('='),
        };
        let (key, value) = match position {
            None => (decode(part), String::new()),
            Some(at) => (
                decode(part.get(..at).unwrap_or("")),
                decode(part.get(at + 1..).unwrap_or("")),
            ),
        };
        if obj.contains(&key) {
            let merged = match obj.get_mut(&key) {
                Some(slot) => combine(
                    std::mem::replace(slot, V::Str(String::new())),
                    V::Str(value),
                    limit,
                ),
                None => V::Str(value),
            };
            obj.set(key, merged);
        } else {
            obj.set(key, V::Str(value));
        }
    }
    obj
}

/// qs `splitKeyIntoSegments` (with `allowPrototypes: true`, `allowDots: false`).
fn split_key(key: &str, options: &QsOptions) -> Result<Vec<String>, DepthExceeded> {
    if options.depth == 0 {
        return Ok(vec![key.to_owned()]);
    }
    let bytes = key.as_bytes();
    let mut segments = Vec::new();
    let first = key.find('[');
    let parent = match first {
        Some(at) => key.get(..at).unwrap_or(""),
        None => key,
    };
    if !parent.is_empty() {
        segments.push(parent.to_owned());
    }
    let mut open = first;
    let mut collected = 0;
    while let Some(start) = open {
        if collected >= options.depth {
            break;
        }
        let mut level = 1;
        let mut close = None;
        let mut i = start + 1;
        while i < bytes.len() && close.is_none() {
            match bytes.get(i) {
                Some(b'[') => level += 1,
                Some(b']') => {
                    level -= 1;
                    if level == 0 {
                        close = Some(i);
                    }
                }
                _ => {}
            }
            i += 1;
        }
        let Some(end) = close else {
            segments.push(format!("[{}]", key.get(start..).unwrap_or("")));
            return Ok(segments);
        };
        segments.push(key.get(start..=end).unwrap_or("").to_owned());
        collected += 1;
        open = key
            .get(end + 1..)
            .and_then(|rest| rest.find('['))
            .map(|at| at + end + 1);
    }
    if let Some(start) = open {
        if options.strict_depth {
            return Err(DepthExceeded);
        }
        segments.push(format!("[{}]", key.get(start..).unwrap_or("")));
    }
    Ok(segments)
}

/// qs `parseKeys`: `None` for an empty key.
fn parse_keys(key: &str, value: V, options: &QsOptions) -> Result<Option<V>, DepthExceeded> {
    if key.is_empty() {
        return Ok(None);
    }
    let segments = split_key(key, options)?;
    Ok(Some(parse_object(
        &segments,
        value,
        options.array_limit as f64,
    )))
}

/// qs `parseObject`: builds the nested value for one key's segments.
fn parse_object(chain: &[String], value: V, limit: f64) -> V {
    let mut leaf = value;
    for root in chain.iter().rev() {
        leaf = if root == "[]" {
            if leaf.is_overflow() {
                leaf
            } else {
                combine(V::Arr(Vec::new()), leaf, limit)
            }
        } else {
            let clean = if root.len() >= 2 && root.starts_with('[') && root.ends_with(']') {
                root.get(1..root.len() - 1).unwrap_or("")
            } else {
                root.as_str()
            };
            let index = if clean != root {
                canonical_integer(clean)
            } else {
                None
            };
            let mut obj = Obj::default();
            match index {
                Some(index) if index < limit => {
                    let at = index as usize;
                    let mut items: Vec<Option<V>> = Vec::new();
                    items.resize_with(at + 1, || None);
                    if let Some(slot) = items.get_mut(at) {
                        *slot = Some(leaf);
                    }
                    V::Arr(items)
                }
                Some(index) => {
                    obj.set(clean.to_owned(), leaf);
                    obj.overflow = Some(index);
                    V::Obj(obj)
                }
                None if clean != "__proto__" => {
                    obj.set(clean.to_owned(), leaf);
                    V::Obj(obj)
                }
                None => V::Obj(obj),
            }
        };
    }
    leaf
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn q(input: &str) -> Value {
        parse_query(input)
    }

    #[test]
    fn flat_and_nested() {
        assert_eq!(q("a=1&b=2"), json!({"a": "1", "b": "2"}));
        assert_eq!(
            q("a[b][c]=1&a[d]=2"),
            json!({"a": {"b": {"c": "1"}, "d": "2"}})
        );
        assert_eq!(q("a%5Bb%5D=1"), json!({"a": {"b": "1"}}));
        assert_eq!(
            q("plus=a+b&enc=a%20b"),
            json!({"plus": "a b", "enc": "a b"})
        );
        assert_eq!(q("noval&x="), json!({"noval": "", "x": ""}));
        assert_eq!(q("=x&&"), json!({}));
    }

    #[test]
    fn arrays_and_duplicates() {
        assert_eq!(q("a[]=1&a[]=2"), json!({"a": ["1", "2"]}));
        assert_eq!(q("a=1&a=2&a=3"), json!({"a": ["1", "2", "3"]}));
        assert_eq!(q("a[1]=x&a[0]=y"), json!({"a": ["y", "x"]}));
        assert_eq!(q("a[2]=x"), json!({"a": ["x"]}));
        assert_eq!(q("a[1001]=x"), json!({"a": {"1001": "x"}}));
        assert_eq!(q("a[b]=1&a=2"), json!({"a": [{"b": "1"}, "2"]}));
        assert_eq!(q("a=&a[b]=1"), json!({"a": ["", {"b": "1"}]}));
        assert_eq!(q("a[b]=1&a="), json!({"a": {"b": "1"}}));
        assert_eq!(q("a[b]=1&a[0]=2"), json!({"a": {"0": "2", "b": "1"}}));
        assert_eq!(q("[]=a"), json!({"0": "a"}));
    }

    #[test]
    fn javascript_key_order() {
        let parsed = q("b=1&2=x&a=3&1=y");
        let keys: Vec<&String> = parsed
            .as_object()
            .map(|m| m.keys().collect())
            .unwrap_or_default();
        assert_eq!(keys, ["1", "2", "b", "a"]);
    }

    #[test]
    fn depth_and_prototype_keys() {
        assert_eq!(
            q("d[a][b][c][d][e][f][g]=1"),
            json!({"d": {"a": {"b": {"c": {"d": {"e": {"[f][g]": "1"}}}}}}})
        );
        assert_eq!(
            q("__proto__=x&n[__proto__]=y&hasOwnProperty=z"),
            json!({"n": {}, "hasOwnProperty": "z"})
        );
        let strict = QsOptions::urlencoded(1, 2, 1000);
        assert_eq!(parse("a[b][c][d]=1", &strict), Err(DepthExceeded));
        assert_eq!(
            parse("a[b][c]=1", &strict),
            Ok(json!({"a": {"b": {"c": "1"}}}))
        );
    }

    #[test]
    fn array_limit_overflow() {
        // Only the first 1000 pairs are read, so 1002 values still make a 1000-element array.
        let many: Vec<String> = (0..1002).map(|i| format!("a[]={i}")).collect();
        let parsed = q(&many.join("&"));
        assert_eq!(
            parsed.get("a").and_then(Value::as_array).map(Vec::len),
            Some(1000)
        );
        let body = QsOptions::urlencoded(3, 32, 1000);
        assert_eq!(parse("a[150]=x", &body), Ok(json!({"a": {"150": "x"}})));
        assert_eq!(parse("a[50]=x", &body), Ok(json!({"a": ["x"]})));
        // Expectations recorded from qs 6.15.3 with `arrayLimit: 3`.
        let tight = QsOptions {
            array_limit: 3,
            ..QsOptions::QUERY
        };
        let cases = [
            (
                "a[]=1&a[]=2&a[]=3&a[]=4&a[]=5",
                json!({"a": {"0": "1", "1": "2", "2": "3", "3": "4", "4": "5"}}),
            ),
            (
                "a=1&a=2&a=3&a=4&a[]=5",
                json!({"a": {"0": ["1", "5"], "1": "2", "2": "3", "3": "4"}}),
            ),
            ("a[5]=x&a[]=y", json!({"a": {"0": "y", "5": "x"}})),
            ("a[5]=x&a=y", json!({"a": {"5": "x", "6": "y"}})),
            ("a=y&a[5]=x", json!({"a": {"0": "y", "6": "x"}})),
            (
                "a[5]=x&a[b]=z&a[]=q",
                json!({"a": {"0": "q", "5": "x", "b": "z"}}),
            ),
            (
                "a[0]=1&a[1]=2&a[2]=3&a[3]=4",
                json!({"a": {"0": "1", "1": "2", "2": "3", "3": "4"}}),
            ),
            (
                "a[0][b]=1&a[0][c]=2&a[1]=x",
                json!({"a": [{"b": "1", "c": "2"}, "x"]}),
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(parse(input, &tight), Ok(expected), "{input}");
        }
    }

    #[test]
    fn non_ascii_and_malformed_escapes() {
        assert_eq!(
            q("emoji=%F0%9F%98%80&name=caf%C3%A9"),
            json!({"emoji": "😀", "name": "café"})
        );
        assert_eq!(
            q("bad=%E0%A4%A&ok=1"),
            json!({"bad": "%E0%A4%A", "ok": "1"})
        );
        assert_eq!(q("rtl=%D7%A9%D7%9C%D7%95%D7%9D"), json!({"rtl": "שלום"}));
        assert_eq!(
            q("comb=e%CC%81&rtl%D7%90=1"),
            json!({"comb": "e\u{301}", "rtlא": "1"})
        );
        assert_eq!(q("k%C3%A9y[%F0%9F%98%80]=v"), json!({"kéy": {"😀": "v"}}));
        // A body is already text; non-ASCII passes through.
        let body = QsOptions::urlencoded(1, 32, 1000);
        assert_eq!(parse("e=😀+é", &body), Ok(json!({"e": "😀 é"})));
    }

    #[test]
    fn parameter_limit_truncates() {
        let options = QsOptions {
            parameter_limit: 2,
            ..QsOptions::QUERY
        };
        assert_eq!(
            parse("a=1&b=2&c=3", &options),
            Ok(json!({"a": "1", "b": "2"}))
        );
    }
}

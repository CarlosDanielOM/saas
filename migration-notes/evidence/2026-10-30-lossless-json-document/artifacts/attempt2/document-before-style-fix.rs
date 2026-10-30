//! Flat, whole-input-validated JSON views and stack-safe canonical serialization.
//! No recursive value tree is constructed; memory scales with input tokens.
use super::{
    js_string::JsString,
    lossless_json::{JsonValue, array_index_str, parse_json},
};
use std::{borrow::Cow, collections::HashMap};

#[derive(Debug)]
struct Span {
    start: usize,
    end: usize,
    // Index immediately after this entire subtree, including object key tokens.
    next: usize,
}

/// Retains the caller's JSON bytes; dropping even a deeply nested document
/// drops one flat vector, never a recursively owned JSON value.
#[derive(Debug)]
pub struct JsonDocument<'a> {
    raw: Cow<'a, str>,
    spans: Vec<Span>,
}

impl<'a> JsonDocument<'a> {
    pub fn parse(raw: &'a str) -> Result<Self, String> {
        // from_str also calls Deserializer::end: BOM and trailing data fail.
        // Do not replace with a prefix-only streaming parse.
        let validated: &serde_json::value::RawValue =
            serde_json::from_str(raw).map_err(|error| format!("Invalid JSON: {error}"))?;
        let raw = validated.get();
        let bytes = raw.as_bytes();
        let mut spans: Vec<Span> = Vec::new();
        let mut containers = Vec::new();
        let mut pos = 0;
        // This is an indexer over validated bytes, not a second JSON grammar.
        // Token delimiters inside strings are skipped with their escapes.
        while pos < bytes.len() {
            match bytes[pos] {
                b' ' | b'\t' | b'\n' | b'\r' | b',' | b':' => pos += 1,
                b'[' | b'{' => {
                    containers.push(spans.len());
                    spans.push(Span {
                        start: pos,
                        end: 0,
                        next: 0,
                    });
                    pos += 1;
                }
                b']' | b'}' => {
                    let index = containers.pop().expect("validated closing delimiter");
                    spans[index].end = pos + 1;
                    spans[index].next = spans.len();
                    pos += 1;
                }
                _ => {
                    let start = pos;
                    if bytes[pos] == b'"' {
                        pos += 1;
                        while bytes[pos] != b'"' {
                            if bytes[pos] == b'\\' {
                                pos += 1; // skip escaped quote/backslash (or escape tag)
                            }
                            pos += 1;
                        }
                        pos += 1;
                    } else {
                        while pos < bytes.len()
                            && !matches!(
                                bytes[pos],
                                b' ' | b'\t' | b'\n' | b'\r' | b',' | b':' | b']' | b'}'
                            )
                        {
                            pos += 1;
                        }
                    }
                    let next = spans.len() + 1;
                    spans.push(Span {
                        start,
                        end: pos,
                        next,
                    });
                }
            }
        }
        Ok(Self {
            raw: Cow::Borrowed(raw),
            spans,
        })
    }

    /// Borrow the validated root bytes, excluding surrounding JSON whitespace.
    pub fn raw(&self) -> &str {
        self.raw.as_ref()
    }

    /// Move the flat index into an independent document without self-references.
    pub fn into_owned(self) -> JsonDocument<'static> {
        JsonDocument {
            raw: Cow::Owned(self.raw.into_owned()),
            spans: self.spans,
        }
    }

    pub fn root(&self) -> JsonView<'_> {
        JsonView {
            raw: self.raw.as_ref(),
            spans: &self.spans,
            index: 0,
        }
    }
}

/// Copyable handle whose bytes and span index are borrowed from a document.
#[derive(Clone, Copy, Debug)]
pub struct JsonView<'a> {
    raw: &'a str,
    spans: &'a [Span],
    index: usize,
}

impl<'a> JsonView<'a> {
    pub fn raw(self) -> &'a str {
        let span = &self.spans[self.index];
        &self.raw[span.start..span.end]
    }

    pub(crate) fn tag(self) -> u8 {
        self.raw.as_bytes()[self.spans[self.index].start]
    }

    /// Decode only a leaf with the existing binary64/UTF-16 policy. Validated
    /// unescaped strings can copy their UTF-8 directly; escaped strings retain
    /// the existing decoder. Containers have no owned-tree conversion here.
    pub fn scalar(self) -> Option<JsonValue> {
        if matches!(self.tag(), b'[' | b'{') {
            None
        } else if self.tag() == b'"'
            && let Some(value) = self.unescaped_string()
        {
            Some(JsonValue::String(JsString::from(value)))
        } else {
            Some(parse_json(self.raw()).expect("validated scalar token"))
        }
    }

    pub fn as_string(self) -> Option<JsString> {
        if self.tag() != b'"' {
            return None;
        }
        match self.scalar() {
            Some(JsonValue::String(value)) => Some(value),
            _ => unreachable!("validated string token"),
        }
    }

    pub fn as_bool(self) -> Option<bool> {
        match self.tag() {
            b't' => Some(true),
            b'f' => Some(false),
            _ => None,
        }
    }

    pub fn is_null(self) -> bool {
        self.tag() == b'n'
    }

    /// Own, last-key-wins lookup with exact UTF-16 name equality. Unescaped
    /// names compare borrowed UTF-8; escaped names use the existing decoder.
    /// JSON's __proto__ is an ordinary own field, never a prototype mutation.
    /// Non-objects yield missing for this plain-own-property API.
    pub fn get(self, key: &str) -> Option<Self> {
        self.find_key(|name| match name.unescaped_string() {
            Some(name) => name == key,
            None => name.as_string().expect("validated object key").as_str() == Some(key),
        })
    }

    pub fn get_key(self, key: &JsString) -> Option<Self> {
        if let Some(key) = key.as_str() {
            return self.get(key);
        }
        self.find_key(|name| {
            // Unescaped input is valid UTF-8 and cannot contain an unpaired
            // UTF-16 unit. Escaped input still uses the established decoder.
            name.unescaped_string().is_none()
                && name.as_string().expect("validated object key") == *key
        })
    }

    /// Called only for validated string tokens, including object keys. Without
    /// escapes, removing the ASCII quotes leaves the exact UTF-8 text at valid
    /// byte boundaries. Escaped UTF-16 text stays on the existing decoder path.
    fn unescaped_string(self) -> Option<&'a str> {
        debug_assert_eq!(self.tag(), b'"');
        let raw = self.raw();
        let body = &raw[1..raw.len() - 1];
        (!body.as_bytes().contains(&b'\\')).then_some(body)
    }

    fn find_key(self, mut matches: impl FnMut(Self) -> bool) -> Option<Self> {
        if self.tag() != b'{' {
            return None;
        }
        let mut index = self.index + 1;
        let end = self.spans[self.index].next;
        let mut found = None;
        while index < end {
            let name = Self { index, ..self };
            let value = Self {
                index: index + 1,
                ..self
            };
            if matches(name) {
                found = Some(value);
            }
            index = self.spans[value.index].next;
        }
        found
    }

    pub fn array(self) -> Option<ArrayIter<'a>> {
        (self.tag() == b'[').then(|| ArrayIter {
            view: self,
            next: self.index + 1,
            end: self.spans[self.index].next,
        })
    }

    pub fn truthy(self) -> bool {
        if self.tag() == b'"' {
            // Only the validated token "" is empty. Every valid escape emits
            // at least one UTF-16 unit, including NUL and lone surrogates.
            return self.raw().len() != 2;
        }
        self.scalar()
            .map_or(true, |value| super::lossless_json::truthy(&value))
    }
}

pub struct ArrayIter<'a> {
    view: JsonView<'a>,
    next: usize,
    end: usize,
}

impl<'a> Iterator for ArrayIter<'a> {
    type Item = JsonView<'a>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.next >= self.end {
            return None;
        }
        let value = JsonView {
            index: self.next,
            ..self.view
        };
        self.next = value.spans[value.index].next;
        Some(value)
    }
}

impl JsonView<'_> {
    /// Copy just this subtree into an independent, flat document.
    pub fn into_owned(self) -> JsonDocument<'static> {
        JsonDocument::parse(self.raw())
            .expect("view contains validated JSON")
            .into_owned()
    }

    /// ECMAScript JSON.parse followed by compact JSON.stringify for JSON data.
    /// Traversal, including deeply nested containers, uses a heap stack.
    pub fn to_json_string(self) -> String {
        let mut out = String::new();
        self.write_json_string(&mut out);
        out
    }

    pub fn write_json_string(self, out: &mut String) {
        enum Action {
            Value(usize),
            Key(JsString),
            Byte(char),
        }
        let mut pending = vec![Action::Value(self.index)];
        while let Some(action) = pending.pop() {
            match action {
                Action::Byte(ch) => out.push(ch),
                Action::Key(key) => key.write_json_string(out),
                Action::Value(index) => {
                    let view = JsonView { index, ..self };
                    match view.tag() {
                        b'[' => {
                            out.push('[');
                            let values: Vec<_> =
                                view.array().expect("array").map(|v| v.index).collect();
                            pending.push(Action::Byte(']'));
                            for (position, index) in values.into_iter().enumerate().rev() {
                                pending.push(Action::Value(index));
                                if position > 0 {
                                    pending.push(Action::Byte(','));
                                }
                            }
                        }
                        b'{' => {
                            out.push('{');
                            let mut entries: Vec<(JsString, usize)> = Vec::new();
                            let mut positions: HashMap<JsString, usize> = HashMap::new();
                            let mut child = index + 1;
                            while child < view.spans[index].next {
                                let key = JsonView {
                                    index: child,
                                    ..view
                                }
                                .as_string()
                                .expect("validated object key");
                                let value = child + 1;
                                if let Some(&position) = positions.get(&key) {
                                    entries[position].1 = value;
                                } else {
                                    positions.insert(key.clone(), entries.len());
                                    entries.push((key, value));
                                }
                                child = view.spans[value].next;
                            }
                            entries.sort_by_key(|(key, _)| {
                                key.as_str()
                                    .and_then(array_index_str)
                                    .map_or((1, 0), |i| (0, i))
                            });
                            pending.push(Action::Byte('}'));
                            for (position, (key, value)) in entries.into_iter().enumerate().rev() {
                                pending.push(Action::Value(value));
                                pending.push(Action::Byte(':'));
                                pending.push(Action::Key(key));
                                if position > 0 {
                                    pending.push(Action::Byte(','));
                                }
                            }
                        }
                        _ => view.scalar().expect("scalar").write_json_string(out),
                    }
                }
            }
        }
    }
}

//! `append-field` 1.0.0: how multer puts text fields into `req.body` (`a[b]`, `a[]`, `a[0]`,
//! repeated names becoming arrays). Array holes are JSON `null`, as `JSON.stringify` writes them.

use serde_json::{Map, Value};

/// The largest array index a field name may use. append-field accepts any, and
/// `list[99999999]` would build a hundred-million-slot array; a larger index makes the whole
/// name a plain key, as append-field does for names it cannot parse.
pub(crate) const MAX_INDEX: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Key {
    Name(String),
    Index(usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Object,
    Array,
}

#[derive(Debug, Clone)]
struct Step {
    key: Key,
    append: bool,
    next: Kind,
    last: bool,
}

/// `parsePath(key)`.
fn parse_path(key: &str) -> Vec<Step> {
    let failure = || {
        vec![Step {
            key: Key::Name(key.to_owned()),
            append: false,
            next: Kind::Object,
            last: true,
        }]
    };
    let first_end = key.find('[').unwrap_or(key.len());
    let first = key.get(..first_end).unwrap_or("");
    if first.is_empty() {
        return failure();
    }
    let mut steps = vec![Step {
        key: Key::Name(first.to_owned()),
        append: false,
        next: Kind::Object,
        last: false,
    }];
    let mut rest = key.get(first_end..).unwrap_or("");
    while !rest.is_empty() {
        if rest.starts_with("[]") {
            if rest.len() != 2 {
                return failure();
            }
            if let Some(tail) = steps.last_mut() {
                tail.append = true;
            }
            rest = "";
            continue;
        }
        let Some(inner) = rest.strip_prefix('[') else {
            return failure();
        };
        let Some(close) = inner.find(']') else {
            return failure();
        };
        let segment = inner.get(..close).unwrap_or("");
        if segment.is_empty() {
            return failure();
        }
        let digits = segment.bytes().all(|b| b.is_ascii_digit());
        let step = if digits {
            match segment.parse::<usize>() {
                Ok(index) if index <= MAX_INDEX => Step {
                    key: Key::Index(index),
                    append: false,
                    next: Kind::Object,
                    last: false,
                },
                _ => return failure(),
            }
        } else {
            Step {
                key: Key::Name(segment.to_owned()),
                append: false,
                next: Kind::Object,
                last: false,
            }
        };
        if let Some(tail) = steps.last_mut() {
            tail.next = if digits { Kind::Array } else { Kind::Object };
        }
        steps.push(step);
        rest = inner.get(close + 1..).unwrap_or("");
    }
    if let Some(tail) = steps.last_mut() {
        tail.last = true;
    }
    steps
}

/// `context[key]` (a missing entry or a hole is `None`).
fn get<'a>(context: &'a mut Value, key: &Key) -> Option<&'a mut Value> {
    match (context, key) {
        (Value::Object(map), Key::Name(name)) => map.get_mut(name),
        (Value::Object(map), Key::Index(index)) => map.get_mut(&index.to_string()),
        (Value::Array(items), Key::Index(index)) => items.get_mut(*index).filter(|v| !v.is_null()),
        (Value::Array(_), Key::Name(_)) | (_, _) => None,
    }
}

/// `context[key] = value`; arrays grow with holes.
fn set(context: &mut Value, key: &Key, value: Value) {
    match (context, key) {
        (Value::Object(map), Key::Name(name)) => {
            map.insert(name.clone(), value);
        }
        (Value::Object(map), Key::Index(index)) => {
            map.insert(index.to_string(), value);
        }
        (Value::Array(items), Key::Index(index)) => {
            if items.len() <= *index {
                items.resize(*index + 1, Value::Null);
            }
            if let Some(slot) = items.get_mut(*index) {
                *slot = value;
            }
        }
        _ => {}
    }
}

/// `setLastValue`.
fn set_last(context: &mut Value, step: &Step, entry: String) {
    match get(context, &step.key) {
        None => {
            let value = if step.append {
                Value::Array(vec![Value::String(entry)])
            } else {
                Value::String(entry)
            };
            set(context, &step.key, value);
        }
        Some(Value::Array(items)) => items.push(Value::String(entry)),
        Some(object @ Value::Object(_)) => {
            let inner = Step {
                key: Key::Name(String::new()),
                append: false,
                next: Kind::Object,
                last: true,
            };
            set_last(object, &inner, entry);
        }
        Some(scalar) => {
            let previous = std::mem::take(scalar);
            *scalar = Value::Array(vec![previous, Value::String(entry)]);
        }
    }
}

/// `setValue` for a step that is not the last: the container the next step works in.
fn descend<'a>(context: &'a mut Value, step: &Step) -> Option<&'a mut Value> {
    let replacement = match get(context, &step.key) {
        None => Some(match step.next {
            Kind::Array => Value::Array(Vec::new()),
            Kind::Object => Value::Object(Map::new()),
        }),
        Some(Value::Object(_)) => None,
        Some(Value::Array(_)) if step.next == Kind::Array => None,
        Some(Value::Array(items)) => {
            let object: Map<String, Value> = items
                .iter()
                .enumerate()
                .filter(|(_, v)| !v.is_null())
                .map(|(i, v)| (i.to_string(), v.clone()))
                .collect();
            Some(Value::Object(object))
        }
        Some(scalar) => {
            let mut object = Map::new();
            object.insert(String::new(), std::mem::take(scalar));
            Some(Value::Object(object))
        }
    };
    if let Some(value) = replacement {
        set(context, &step.key, value);
    }
    get(context, &step.key)
}

/// `appendField(store, key, value)`.
pub(crate) fn append_field(store: &mut Value, key: &str, value: String) {
    let steps = parse_path(key);
    let mut context = store;
    for step in &steps {
        if step.last {
            set_last(context, step, value);
            return;
        }
        match descend(context, step) {
            Some(next) => context = next,
            None => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn build(fields: &[(&str, &str)]) -> Value {
        let mut store = Value::Object(Map::new());
        for (key, value) in fields {
            append_field(&mut store, key, (*value).to_owned());
        }
        dima_text::js_key_order(&mut store);
        store
    }

    #[test]
    fn appends_like_append_field() {
        // Expectations from append-field 1.0.0 under Node 26 (JSON.stringify of the result).
        assert_eq!(build(&[("a", "1")]), json!({"a": "1"}));
        assert_eq!(
            build(&[("a", "1"), ("a", "2"), ("a", "3")]),
            json!({"a": ["1", "2", "3"]})
        );
        assert_eq!(
            build(&[("a[b]", "1"), ("a[c]", "2")]),
            json!({"a": {"b": "1", "c": "2"}})
        );
        assert_eq!(
            build(&[("l[]", "x"), ("l[]", "y")]),
            json!({"l": ["x", "y"]})
        );
        assert_eq!(build(&[("arr[1]", "z")]), json!({"arr": [null, "z"]}));
        assert_eq!(
            build(&[("a[0]", "x"), ("a[b]", "y")]),
            json!({"a": {"0": "x", "b": "y"}})
        );
        assert_eq!(
            build(&[("a", "s"), ("a[b]", "y")]),
            json!({"a": {"": "s", "b": "y"}})
        );
        assert_eq!(
            build(&[("a[b]", "1"), ("a", "2")]),
            json!({"a": {"b": "1", "": "2"}})
        );
        assert_eq!(
            build(&[("[x]", "1"), ("a[", "2"), ("b[]x", "3")]),
            json!({"[x]": "1", "a[": "2", "b[]x": "3"})
        );
        assert_eq!(
            build(&[("a[0][b]", "1"), ("a[0][c]", "2")]),
            json!({"a": [{"b": "1", "c": "2"}]})
        );
        assert_eq!(
            build(&[("big[99999999]", "x")]),
            json!({"big[99999999]": "x"})
        );
        assert_eq!(build(&[("__proto__", "x")]), json!({"__proto__": "x"}));
    }
}

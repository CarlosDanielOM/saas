//! `append-field` 1.0.0: how multer puts text fields into `req.body` (`a[b]`, `a[]`, `a[0]`,
//! repeated names becoming arrays). Array holes are JSON `null`, as `JSON.stringify` writes them.
//!
//! The fields are built on a small model of the JavaScript values append-field creates: arrays
//! store only the indices that hold a value (`a[9999]=x` is one entry while it is built, as in
//! V8's sparse arrays), and every slot the final JSON will hold, holes included, is charged
//! against a budget before it is created. A name nested deeper than [`MAX_DEPTH`] or a form
//! whose names would need more than [`MAX_SLOTS`] slots fails instead (append-field has neither
//! bound and allocates its way through).

use std::collections::{BTreeMap, HashMap};

use serde_json::{Map, Value};

/// The largest array index a field name may use. append-field accepts any, and
/// `list[99999999]` would build a hundred-million-slot array; a larger index makes the whole
/// name a plain key, as append-field does for names it cannot parse.
pub(crate) const MAX_INDEX: usize = 10_000;

/// Bracket groups one field name may nest (body-parser's urlencoded `depth` default).
pub const MAX_DEPTH: usize = 32;

/// JSON values (array slots, holes included, and object entries) the text fields of one form may
/// build together.
pub const MAX_SLOTS: usize = 100_000;

/// A field name the budget refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NameError {
    /// More than [`MAX_DEPTH`] bracket groups.
    TooDeep,
    /// The form's names would build more than [`MAX_SLOTS`] values.
    TooManySlots,
}

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

/// `parsePath(key)`; refuses names deeper than [`MAX_DEPTH`] before building them.
fn parse_path(key: &str) -> Result<Vec<Step>, NameError> {
    let failure = || {
        Ok(vec![Step {
            key: Key::Name(key.to_owned()),
            append: false,
            next: Kind::Object,
            last: true,
        }])
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
        if steps.len() > MAX_DEPTH {
            return Err(NameError::TooDeep);
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
    Ok(steps)
}

/// A JavaScript value as append-field builds it.
#[derive(Debug)]
enum Node {
    Str(String),
    Arr(Arr),
    Obj(Obj),
}

/// A JavaScript array: `len` is `array.length`; indices without an entry are holes.
#[derive(Debug, Default)]
struct Arr {
    len: usize,
    items: BTreeMap<usize, Node>,
}

/// A plain object in insertion order (JavaScript key order is applied to the result).
#[derive(Debug, Default)]
struct Obj {
    entries: Vec<(String, Node)>,
    positions: HashMap<String, usize>,
}

impl Obj {
    fn get_mut(&mut self, key: &str) -> Option<&mut Node> {
        let at = *self.positions.get(key)?;
        self.entries.get_mut(at).map(|(_, node)| node)
    }

    fn contains(&self, key: &str) -> bool {
        self.positions.contains_key(key)
    }

    fn insert(&mut self, key: String, node: Node) {
        match self.positions.get(&key) {
            Some(&at) => {
                if let Some(slot) = self.entries.get_mut(at) {
                    slot.1 = node;
                }
            }
            None => {
                self.positions.insert(key.clone(), self.entries.len());
                self.entries.push((key, node));
            }
        }
    }
}

impl Node {
    fn into_value(self) -> Value {
        match self {
            Node::Str(text) => Value::String(text),
            Node::Arr(array) => {
                let mut items = Vec::with_capacity(array.len);
                let mut next = 0;
                for (index, node) in array.items {
                    items.extend(std::iter::repeat_n(Value::Null, index - next));
                    items.push(node.into_value());
                    next = index + 1;
                }
                items.extend(std::iter::repeat_n(
                    Value::Null,
                    array.len.saturating_sub(next),
                ));
                Value::Array(items)
            }
            Node::Obj(obj) => Value::Object(
                obj.entries
                    .into_iter()
                    .map(|(key, node)| (key, node.into_value()))
                    .collect::<Map<String, Value>>(),
            ),
        }
    }
}

/// The slots a form's fields hold, charged before they are created.
#[derive(Debug, Default)]
struct Slots(usize);

impl Slots {
    fn charge(&mut self, slots: usize) -> Result<(), NameError> {
        let total = self.0.saturating_add(slots);
        if total > MAX_SLOTS {
            return Err(NameError::TooManySlots);
        }
        self.0 = total;
        Ok(())
    }
}

/// `context[key]` (a missing entry or a hole is `None`).
fn get<'a>(context: &'a mut Node, key: &Key) -> Option<&'a mut Node> {
    match (context, key) {
        (Node::Obj(obj), Key::Name(name)) => obj.get_mut(name),
        (Node::Obj(obj), Key::Index(index)) => obj.get_mut(&index.to_string()),
        (Node::Arr(array), Key::Index(index)) => array.items.get_mut(index),
        _ => None,
    }
}

/// `context[key] = value`; arrays grow with holes. `inner` is what `value` itself holds.
fn set(
    context: &mut Node,
    key: &Key,
    value: Node,
    inner: usize,
    slots: &mut Slots,
) -> Result<(), NameError> {
    match (context, key) {
        (Node::Obj(obj), Key::Name(name)) => {
            slots.charge(usize::from(!obj.contains(name)) + inner)?;
            obj.insert(name.clone(), value);
        }
        (Node::Obj(obj), Key::Index(index)) => {
            let name = index.to_string();
            slots.charge(usize::from(!obj.contains(&name)) + inner)?;
            obj.insert(name, value);
        }
        (Node::Arr(array), Key::Index(index)) => {
            let grown = (index + 1).saturating_sub(array.len);
            slots.charge(grown + inner)?;
            array.len = array.len.max(index + 1);
            array.items.insert(*index, value);
        }
        // `array.name = value` and assignments to a string are lost from the JSON.
        _ => {}
    }
    Ok(())
}

/// `setLastValue`.
fn set_last(
    context: &mut Node,
    step: &Step,
    entry: String,
    slots: &mut Slots,
) -> Result<(), NameError> {
    match get(context, &step.key) {
        None if step.append => {
            let array = Arr {
                len: 1,
                items: BTreeMap::from([(0, Node::Str(entry))]),
            };
            set(context, &step.key, Node::Arr(array), 1, slots)
        }
        None => set(context, &step.key, Node::Str(entry), 0, slots),
        Some(Node::Arr(array)) => {
            slots.charge(1)?;
            array.items.insert(array.len, Node::Str(entry));
            array.len += 1;
            Ok(())
        }
        Some(object @ Node::Obj(_)) => {
            let inner = Step {
                key: Key::Name(String::new()),
                append: false,
                next: Kind::Object,
                last: true,
            };
            set_last(object, &inner, entry, slots)
        }
        Some(scalar @ Node::Str(_)) => {
            slots.charge(2)?;
            let previous = std::mem::replace(scalar, Node::Str(String::new()));
            *scalar = Node::Arr(Arr {
                len: 2,
                items: BTreeMap::from([(0, previous), (1, Node::Str(entry))]),
            });
            Ok(())
        }
    }
}

/// `setValue` for a step that is not the last: the container the next step works in.
fn descend<'a>(
    context: &'a mut Node,
    step: &Step,
    slots: &mut Slots,
) -> Result<Option<&'a mut Node>, NameError> {
    let replacement = match get(context, &step.key) {
        None => Some((
            match step.next {
                Kind::Array => Node::Arr(Arr::default()),
                Kind::Object => Node::Obj(Obj::default()),
            },
            0,
        )),
        Some(Node::Obj(_)) => None,
        Some(Node::Arr(_)) if step.next == Kind::Array => None,
        Some(existing @ Node::Arr(_)) => {
            // The array becomes an object of its entries (holes are not keys): no more slots.
            let Node::Arr(array) = std::mem::replace(existing, Node::Obj(Obj::default())) else {
                return Ok(None);
            };
            let mut object = Obj::default();
            for (index, node) in array.items {
                object.insert(index.to_string(), node);
            }
            *existing = Node::Obj(object);
            None
        }
        Some(scalar @ Node::Str(_)) => {
            slots.charge(1)?;
            let previous = std::mem::replace(scalar, Node::Str(String::new()));
            let mut object = Obj::default();
            object.insert(String::new(), previous);
            *scalar = Node::Obj(object);
            None
        }
    };
    if let Some((value, inner)) = replacement {
        set(context, &step.key, value, inner, slots)?;
    }
    Ok(get(context, &step.key))
}

/// The text fields of one form (`req.body`), built with append-field's rules.
#[derive(Debug)]
pub(crate) struct Fields {
    root: Node,
    slots: Slots,
}

impl Default for Fields {
    fn default() -> Self {
        Self {
            root: Node::Obj(Obj::default()),
            slots: Slots::default(),
        }
    }
}

impl Fields {
    /// `appendField(store, key, value)`. A refused name changes nothing it has not already
    /// built (intermediate containers may remain).
    pub(crate) fn append(&mut self, key: &str, value: String) -> Result<(), NameError> {
        let steps = parse_path(key)?;
        let mut context = &mut self.root;
        for step in &steps {
            if step.last {
                return set_last(context, step, value, &mut self.slots);
            }
            match descend(context, step, &mut self.slots)? {
                Some(next) => context = next,
                None => return Ok(()),
            }
        }
        Ok(())
    }

    /// The JSON value, in JavaScript key order.
    pub(crate) fn into_value(self) -> Value {
        let mut value = self.root.into_value();
        dima_text::js_key_order(&mut value);
        value
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn build(fields: &[(&str, &str)]) -> Value {
        let mut store = Fields::default();
        for (key, value) in fields {
            store
                .append(key, (*value).to_owned())
                .expect("within budget");
        }
        store.into_value()
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

    /// Review finding: every hole of an indexed name was materialised while the fields were
    /// built, with no nesting or total bound. `a` + `[10000]` x 2000 is 14 001 bytes, fits the
    /// part-header limit and asked for about 20 million slots.
    #[test]
    fn hostile_names_are_refused_before_they_allocate() {
        let deep = format!("a{}", "[10000]".repeat(2000));
        assert_eq!(deep.len(), 14_001);
        let mut store = Fields::default();
        assert_eq!(store.append(&deep, "x".to_owned()), Err(NameError::TooDeep));
        // Within the depth, the slot budget stops nested holes before they exist.
        let wide = format!("a{}", "[10000]".repeat(MAX_DEPTH));
        let started = std::time::Instant::now();
        assert_eq!(
            store.append(&wide, "x".to_owned()),
            Err(NameError::TooManySlots)
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        // The budget is per form: many names that each fit still add up.
        let mut store = Fields::default();
        for i in 0..9 {
            store
                .append(&format!("k{i}[10000]"), "x".to_owned())
                .expect("fits");
        }
        assert_eq!(
            store.append("k9[10000]", "x".to_owned()),
            Err(NameError::TooManySlots)
        );
        // Exactly at the depth is fine, and builds one entry per level.
        let mut store = Fields::default();
        let nested = format!("a{}", "[b]".repeat(MAX_DEPTH));
        store.append(&nested, "x".to_owned()).expect("at the depth");
        let mut leaf = &store.into_value()["a"];
        for _ in 0..MAX_DEPTH {
            leaf = &leaf["b"];
        }
        assert_eq!(leaf, "x");
    }

    #[test]
    fn sparse_arrays_keep_their_holes_in_the_json() {
        assert_eq!(
            build(&[("a[3]", "x"), ("a[1]", "y")]),
            json!({"a": [null, "y", null, "x"]})
        );
        assert_eq!(
            build(&[("a[2]", "x"), ("a", "y")]),
            json!({"a": [null, null, "x", "y"]})
        );
        assert_eq!(
            build(&[("a[2]", "x"), ("a[b]", "y")]),
            json!({"a": {"2": "x", "b": "y"}})
        );
    }
}

//! A log call's data serialised into JSON under fixed limits, enforced while the value is walked.
//!
//! `serde_json::to_value` builds the whole input before anything can be cut: a huge collection, a
//! deeply nested value or a `Serialize` implementation that panics would cost the caller memory,
//! time or its thread. This serialiser builds the [`Value`] itself and stops as soon as a limit is
//! reached:
//!
//! - a string is cut at [`MAX_STRING_CHARS`] characters (on a character boundary, `…` appended);
//! - an array keeps [`MAX_ARRAY_ITEMS`] items and an object [`MAX_OBJECT_FIELDS`] fields: the
//!   next item ends the walk of that container (its `Serialize` stops being polled);
//! - a container nested deeper than [`MAX_DEPTH`] becomes the string `[depth]` without being
//!   entered;
//! - the whole record holds at most [`MAX_RECORD_VALUES`] values and about [`MAX_RECORD_BYTES`]
//!   bytes of JSON: past that the walk ends, and the innermost open container gets a
//!   `"[truncated]"` marker when it has room.
//!
//! A `Serialize` implementation that returns an error has its value replaced by
//! `[unserializable]`; one that panics is contained: the whole record becomes
//! `[unserializable]`. Both are reported in [`Bounded::failed`] so the caller can count them.

use crate::redact::{MAX_ARRAY_ITEMS, MAX_DEPTH, MAX_OBJECT_FIELDS, MAX_STRING_CHARS};
use serde::Serialize;
use serde::ser;
use serde_json::{Map, Number, Value};
use std::fmt;

/// Most JSON bytes one log record holds (approximately: the same estimate as the byte budget).
pub const MAX_RECORD_BYTES: usize = 64 * 1024;
/// Most values (strings, numbers, containers...) one log record holds.
pub const MAX_RECORD_VALUES: usize = 4096;
/// Most nested newtype and `Some` wrappers followed (they add no JSON level).
const MAX_WRAPPERS: usize = 32;

/// The marker of a value that could not be serialised.
pub const UNSERIALIZABLE: &str = "[unserializable]";
/// The marker of a container nested too deeply.
pub const DEPTH: &str = "[depth]";
/// The marker of a record cut at its size limit.
pub const TRUNCATED: &str = "[truncated]";

/// The bounded value.
#[derive(Debug)]
pub(crate) struct Bounded {
    pub(crate) value: Value,
    /// A `Serialize` implementation failed or panicked.
    pub(crate) failed: bool,
}

/// Serialises `data` within the limits. Never panics, whatever `data`'s `Serialize` does.
pub(crate) fn to_value<T: Serialize + ?Sized>(data: &T) -> Bounded {
    let mut builder = Builder::default();
    let walked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| builder.root(data)));
    match walked {
        Ok(value) => Bounded {
            value,
            failed: builder.failed,
        },
        Err(_) => Bounded {
            value: Value::String(UNSERIALIZABLE.to_owned()),
            failed: true,
        },
    }
}

/// Why the walk of a value stopped.
#[derive(Debug)]
pub(crate) enum Stop {
    /// The current container is full: the rest of it is skipped.
    Container,
    /// A container would be nested too deeply: it is replaced by [`DEPTH`].
    Depth,
    /// The record is full: the whole walk ends.
    Record,
    /// The caller's `Serialize` reported an error: the value is replaced by [`UNSERIALIZABLE`].
    Failed,
}

impl fmt::Display for Stop {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Container => "container limit",
            Self::Depth => "depth limit",
            Self::Record => "record limit",
            Self::Failed => "serialize failed",
        })
    }
}

impl std::error::Error for Stop {}

impl ser::Error for Stop {
    fn custom<T: fmt::Display>(_message: T) -> Self {
        Self::Failed
    }
}

enum Frame {
    Array {
        items: Vec<Value>,
        variant: Option<&'static str>,
    },
    Object {
        map: Map<String, Value>,
        key: Option<String>,
        variant: Option<&'static str>,
    },
}

#[derive(Default)]
pub(crate) struct Builder {
    stack: Vec<Frame>,
    root: Option<Value>,
    values: usize,
    bytes: usize,
    wrappers: usize,
    /// The record limit was hit: every later call stops at once.
    full: bool,
    failed: bool,
}

fn cut(text: &str) -> String {
    match text.char_indices().nth(MAX_STRING_CHARS) {
        Some((end, _)) => {
            let mut out = text.get(..end).unwrap_or_default().to_owned();
            out.push('…');
            out
        }
        None => text.to_owned(),
    }
}

impl Builder {
    fn root<T: Serialize + ?Sized>(&mut self, data: &T) -> Value {
        // A record-level stop is not an error here: what was built is kept.
        let _ = self.child(data);
        self.root.take().unwrap_or(Value::Null)
    }

    /// Charges one value of about `bytes` JSON bytes to the record.
    fn charge(&mut self, bytes: usize) -> Result<(), Stop> {
        if self.full {
            return Err(Stop::Record);
        }
        self.values += 1;
        self.bytes = self.bytes.saturating_add(bytes);
        if self.values > MAX_RECORD_VALUES || self.bytes > MAX_RECORD_BYTES {
            self.full = true;
            return Err(Stop::Record);
        }
        Ok(())
    }

    /// Puts a finished value into the open container, or makes it the root.
    fn place(&mut self, value: Value) {
        match self.stack.last_mut() {
            None => self.root = Some(value),
            Some(Frame::Array { items, .. }) => items.push(value),
            Some(Frame::Object { map, key, .. }) => {
                if let Some(key) = key.take() {
                    map.insert(key, value);
                }
            }
        }
    }

    fn leaf(&mut self, bytes: usize, value: Value) -> Result<(), Stop> {
        self.charge(bytes)?;
        self.place(value);
        Ok(())
    }

    fn open(&mut self, frame: Frame) -> Result<(), Stop> {
        if self.full {
            return Err(Stop::Record);
        }
        if self.stack.len() >= MAX_DEPTH {
            return Err(Stop::Depth);
        }
        self.charge(2)?;
        self.stack.push(frame);
        Ok(())
    }

    fn array(&mut self, len: Option<usize>, variant: Option<&'static str>) -> Result<(), Stop> {
        let capacity = len.unwrap_or(0).min(MAX_ARRAY_ITEMS);
        self.open(Frame::Array {
            items: Vec::with_capacity(capacity),
            variant,
        })
    }

    fn object(&mut self, variant: Option<&'static str>) -> Result<(), Stop> {
        self.open(Frame::Object {
            map: Map::new(),
            key: None,
            variant,
        })
    }

    /// Closes the innermost container and places it in its parent.
    fn close(&mut self) {
        let Some(frame) = self.stack.pop() else {
            return;
        };
        let (value, variant) = match frame {
            Frame::Array { items, variant } => (Value::Array(items), variant),
            Frame::Object { map, variant, .. } => (Value::Object(map), variant),
        };
        let value = match variant {
            Some(name) => {
                let mut outer = Map::new();
                outer.insert(name.to_owned(), value);
                Value::Object(outer)
            }
            None => value,
        };
        self.place(value);
    }

    /// Closes every container above `base`, marking the innermost one when the record is full.
    fn unwind(&mut self, base: usize) {
        if self.full
            && self.stack.len() > base
            && let Some(frame) = self.stack.last_mut()
        {
            match frame {
                Frame::Array { items, .. } if items.len() < MAX_ARRAY_ITEMS => {
                    items.push(Value::String(TRUNCATED.to_owned()));
                }
                Frame::Object { map, key, .. } if map.len() < MAX_OBJECT_FIELDS => {
                    *key = None;
                    map.insert(TRUNCATED.to_owned(), Value::Bool(true));
                }
                _ => {}
            }
        }
        while self.stack.len() > base {
            self.close();
        }
    }

    /// Serialises one value (an item, a field, the root) and handles how it stopped: the limits
    /// of a child end at this boundary, only a full record ends the walk.
    fn child<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Stop> {
        if self.full {
            return Err(Stop::Record);
        }
        let base = self.stack.len();
        let result = value.serialize(&mut *self);
        let Err(stop) = result else {
            return Ok(());
        };
        self.unwind(base);
        match stop {
            Stop::Container => Ok(()),
            Stop::Depth => {
                self.place(Value::String(DEPTH.to_owned()));
                Ok(())
            }
            Stop::Failed => {
                self.failed = true;
                self.place(Value::String(UNSERIALIZABLE.to_owned()));
                Ok(())
            }
            Stop::Record => Err(Stop::Record),
        }
    }

    fn element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Stop> {
        if let Some(Frame::Array { items, .. }) = self.stack.last()
            && items.len() >= MAX_ARRAY_ITEMS
        {
            return Err(Stop::Container);
        }
        self.child(value)
    }

    fn key(&mut self, key: String) -> Result<(), Stop> {
        let bytes = key.len() + 3;
        match self.stack.last() {
            Some(Frame::Object { map, .. }) if map.len() >= MAX_OBJECT_FIELDS => {
                return Err(Stop::Container);
            }
            Some(Frame::Object { .. }) => {}
            _ => return Err(Stop::Failed),
        }
        self.charge(bytes)?;
        if let Some(Frame::Object { key: slot, .. }) = self.stack.last_mut() {
            *slot = Some(key);
        }
        Ok(())
    }

    fn wrapped<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Stop> {
        if self.wrappers >= MAX_WRAPPERS {
            return Err(Stop::Depth);
        }
        self.wrappers += 1;
        let result = value.serialize(&mut *self);
        self.wrappers -= 1;
        result
    }
}

impl ser::Serializer for &mut Builder {
    type Ok = ();
    type Error = Stop;
    type SerializeSeq = Self;
    type SerializeTuple = Self;
    type SerializeTupleStruct = Self;
    type SerializeTupleVariant = Self;
    type SerializeMap = Self;
    type SerializeStruct = Self;
    type SerializeStructVariant = Self;

    fn serialize_bool(self, v: bool) -> Result<(), Stop> {
        self.leaf(5, Value::Bool(v))
    }

    fn serialize_i8(self, v: i8) -> Result<(), Stop> {
        self.serialize_i64(i64::from(v))
    }

    fn serialize_i16(self, v: i16) -> Result<(), Stop> {
        self.serialize_i64(i64::from(v))
    }

    fn serialize_i32(self, v: i32) -> Result<(), Stop> {
        self.serialize_i64(i64::from(v))
    }

    fn serialize_i64(self, v: i64) -> Result<(), Stop> {
        self.leaf(12, Value::Number(v.into()))
    }

    fn serialize_i128(self, v: i128) -> Result<(), Stop> {
        match i64::try_from(v) {
            Ok(v) => self.serialize_i64(v),
            Err(_) => self.leaf(42, Value::String(v.to_string())),
        }
    }

    fn serialize_u8(self, v: u8) -> Result<(), Stop> {
        self.serialize_u64(u64::from(v))
    }

    fn serialize_u16(self, v: u16) -> Result<(), Stop> {
        self.serialize_u64(u64::from(v))
    }

    fn serialize_u32(self, v: u32) -> Result<(), Stop> {
        self.serialize_u64(u64::from(v))
    }

    fn serialize_u64(self, v: u64) -> Result<(), Stop> {
        self.leaf(12, Value::Number(v.into()))
    }

    fn serialize_u128(self, v: u128) -> Result<(), Stop> {
        match u64::try_from(v) {
            Ok(v) => self.serialize_u64(v),
            Err(_) => self.leaf(42, Value::String(v.to_string())),
        }
    }

    fn serialize_f32(self, v: f32) -> Result<(), Stop> {
        self.serialize_f64(f64::from(v))
    }

    fn serialize_f64(self, v: f64) -> Result<(), Stop> {
        // `serde_json::to_value` writes a non-finite number as null.
        self.leaf(12, Number::from_f64(v).map_or(Value::Null, Value::Number))
    }

    fn serialize_char(self, v: char) -> Result<(), Stop> {
        self.leaf(6, Value::String(v.to_string()))
    }

    fn serialize_str(self, v: &str) -> Result<(), Stop> {
        let text = cut(v);
        self.leaf(text.len() + 2, Value::String(text))
    }

    fn serialize_bytes(self, v: &[u8]) -> Result<(), Stop> {
        use ser::SerializeSeq;
        let mut seq = self.serialize_seq(Some(v.len()))?;
        for byte in v {
            seq.serialize_element(byte)?;
        }
        SerializeSeq::end(seq)
    }

    fn serialize_none(self) -> Result<(), Stop> {
        self.serialize_unit()
    }

    fn serialize_some<T: Serialize + ?Sized>(self, value: &T) -> Result<(), Stop> {
        self.wrapped(value)
    }

    fn serialize_unit(self) -> Result<(), Stop> {
        self.leaf(5, Value::Null)
    }

    fn serialize_unit_struct(self, _name: &'static str) -> Result<(), Stop> {
        self.serialize_unit()
    }

    fn serialize_unit_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
    ) -> Result<(), Stop> {
        self.serialize_str(variant)
    }

    fn serialize_newtype_struct<T: Serialize + ?Sized>(
        self,
        _name: &'static str,
        value: &T,
    ) -> Result<(), Stop> {
        self.wrapped(value)
    }

    fn serialize_newtype_variant<T: Serialize + ?Sized>(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        value: &T,
    ) -> Result<(), Stop> {
        self.object(None)?;
        self.key(variant.to_owned())?;
        self.child(value)?;
        self.close();
        Ok(())
    }

    fn serialize_seq(self, len: Option<usize>) -> Result<Self, Stop> {
        self.array(len, None)?;
        Ok(self)
    }

    fn serialize_tuple(self, len: usize) -> Result<Self, Stop> {
        self.array(Some(len), None)?;
        Ok(self)
    }

    fn serialize_tuple_struct(self, _name: &'static str, len: usize) -> Result<Self, Stop> {
        self.array(Some(len), None)?;
        Ok(self)
    }

    fn serialize_tuple_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        len: usize,
    ) -> Result<Self, Stop> {
        self.array(Some(len), Some(variant))?;
        Ok(self)
    }

    fn serialize_map(self, _len: Option<usize>) -> Result<Self, Stop> {
        self.object(None)?;
        Ok(self)
    }

    fn serialize_struct(self, _name: &'static str, _len: usize) -> Result<Self, Stop> {
        self.object(None)?;
        Ok(self)
    }

    fn serialize_struct_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        _len: usize,
    ) -> Result<Self, Stop> {
        self.object(Some(variant))?;
        Ok(self)
    }
}

impl ser::SerializeSeq for &mut Builder {
    type Ok = ();
    type Error = Stop;

    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Stop> {
        self.element(value)
    }

    fn end(self) -> Result<(), Stop> {
        self.close();
        Ok(())
    }
}

impl ser::SerializeTuple for &mut Builder {
    type Ok = ();
    type Error = Stop;

    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Stop> {
        self.element(value)
    }

    fn end(self) -> Result<(), Stop> {
        self.close();
        Ok(())
    }
}

impl ser::SerializeTupleStruct for &mut Builder {
    type Ok = ();
    type Error = Stop;

    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Stop> {
        self.element(value)
    }

    fn end(self) -> Result<(), Stop> {
        self.close();
        Ok(())
    }
}

impl ser::SerializeTupleVariant for &mut Builder {
    type Ok = ();
    type Error = Stop;

    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Stop> {
        self.element(value)
    }

    fn end(self) -> Result<(), Stop> {
        self.close();
        Ok(())
    }
}

impl ser::SerializeMap for &mut Builder {
    type Ok = ();
    type Error = Stop;

    fn serialize_key<T: Serialize + ?Sized>(&mut self, key: &T) -> Result<(), Stop> {
        let key = key.serialize(KeySerializer)?;
        self.key(key)
    }

    fn serialize_value<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Stop> {
        self.child(value)
    }

    fn end(self) -> Result<(), Stop> {
        self.close();
        Ok(())
    }
}

impl ser::SerializeStruct for &mut Builder {
    type Ok = ();
    type Error = Stop;

    fn serialize_field<T: Serialize + ?Sized>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), Stop> {
        self.key(key.to_owned())?;
        self.child(value)
    }

    fn end(self) -> Result<(), Stop> {
        self.close();
        Ok(())
    }
}

impl ser::SerializeStructVariant for &mut Builder {
    type Ok = ();
    type Error = Stop;

    fn serialize_field<T: Serialize + ?Sized>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), Stop> {
        self.key(key.to_owned())?;
        self.child(value)
    }

    fn end(self) -> Result<(), Stop> {
        self.close();
        Ok(())
    }
}

/// Map keys, as `serde_json` accepts them: text, and numbers, booleans and unit variants as text.
struct KeySerializer;

impl ser::Serializer for KeySerializer {
    type Ok = String;
    type Error = Stop;
    type SerializeSeq = ser::Impossible<String, Stop>;
    type SerializeTuple = ser::Impossible<String, Stop>;
    type SerializeTupleStruct = ser::Impossible<String, Stop>;
    type SerializeTupleVariant = ser::Impossible<String, Stop>;
    type SerializeMap = ser::Impossible<String, Stop>;
    type SerializeStruct = ser::Impossible<String, Stop>;
    type SerializeStructVariant = ser::Impossible<String, Stop>;

    fn serialize_bool(self, v: bool) -> Result<String, Stop> {
        Ok(v.to_string())
    }
    fn serialize_i8(self, v: i8) -> Result<String, Stop> {
        Ok(v.to_string())
    }
    fn serialize_i16(self, v: i16) -> Result<String, Stop> {
        Ok(v.to_string())
    }
    fn serialize_i32(self, v: i32) -> Result<String, Stop> {
        Ok(v.to_string())
    }
    fn serialize_i64(self, v: i64) -> Result<String, Stop> {
        Ok(v.to_string())
    }
    fn serialize_i128(self, v: i128) -> Result<String, Stop> {
        Ok(v.to_string())
    }
    fn serialize_u8(self, v: u8) -> Result<String, Stop> {
        Ok(v.to_string())
    }
    fn serialize_u16(self, v: u16) -> Result<String, Stop> {
        Ok(v.to_string())
    }
    fn serialize_u32(self, v: u32) -> Result<String, Stop> {
        Ok(v.to_string())
    }
    fn serialize_u64(self, v: u64) -> Result<String, Stop> {
        Ok(v.to_string())
    }
    fn serialize_u128(self, v: u128) -> Result<String, Stop> {
        Ok(v.to_string())
    }
    fn serialize_f32(self, v: f32) -> Result<String, Stop> {
        Ok(v.to_string())
    }
    fn serialize_f64(self, v: f64) -> Result<String, Stop> {
        Ok(v.to_string())
    }
    fn serialize_char(self, v: char) -> Result<String, Stop> {
        Ok(v.to_string())
    }
    fn serialize_str(self, v: &str) -> Result<String, Stop> {
        Ok(cut(v))
    }
    fn serialize_bytes(self, _v: &[u8]) -> Result<String, Stop> {
        Err(Stop::Failed)
    }
    fn serialize_none(self) -> Result<String, Stop> {
        Err(Stop::Failed)
    }
    fn serialize_some<T: Serialize + ?Sized>(self, _value: &T) -> Result<String, Stop> {
        Err(Stop::Failed)
    }
    fn serialize_unit(self) -> Result<String, Stop> {
        Err(Stop::Failed)
    }
    fn serialize_unit_struct(self, _name: &'static str) -> Result<String, Stop> {
        Err(Stop::Failed)
    }
    fn serialize_unit_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
    ) -> Result<String, Stop> {
        Ok(variant.to_owned())
    }
    fn serialize_newtype_struct<T: Serialize + ?Sized>(
        self,
        _name: &'static str,
        value: &T,
    ) -> Result<String, Stop> {
        value.serialize(self)
    }
    fn serialize_newtype_variant<T: Serialize + ?Sized>(
        self,
        _name: &'static str,
        _index: u32,
        _variant: &'static str,
        _value: &T,
    ) -> Result<String, Stop> {
        Err(Stop::Failed)
    }
    fn serialize_seq(self, _len: Option<usize>) -> Result<Self::SerializeSeq, Stop> {
        Err(Stop::Failed)
    }
    fn serialize_tuple(self, _len: usize) -> Result<Self::SerializeTuple, Stop> {
        Err(Stop::Failed)
    }
    fn serialize_tuple_struct(
        self,
        _name: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeTupleStruct, Stop> {
        Err(Stop::Failed)
    }
    fn serialize_tuple_variant(
        self,
        _name: &'static str,
        _index: u32,
        _variant: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeTupleVariant, Stop> {
        Err(Stop::Failed)
    }
    fn serialize_map(self, _len: Option<usize>) -> Result<Self::SerializeMap, Stop> {
        Err(Stop::Failed)
    }
    fn serialize_struct(
        self,
        _name: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeStruct, Stop> {
        Err(Stop::Failed)
    }
    fn serialize_struct_variant(
        self,
        _name: &'static str,
        _index: u32,
        _variant: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeStructVariant, Stop> {
        Err(Stop::Failed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::ser::{SerializeMap, SerializeSeq, Serializer};
    use serde_json::json;
    use std::cell::Cell;

    #[test]
    fn ordinary_values_match_serde_json() {
        #[derive(Serialize)]
        enum Kind {
            Unit,
            New(u8),
            Tuple(u8, u8),
            Struct { a: u8 },
        }
        #[derive(Serialize)]
        struct Data<'a> {
            text: &'a str,
            n: i64,
            f: f64,
            nan: f64,
            none: Option<u8>,
            some: Option<u8>,
            list: Vec<u8>,
            kinds: [Kind; 4],
            map: std::collections::BTreeMap<u32, bool>,
        }
        let data = Data {
            text: "hola 😀 e\u{301} שלום",
            n: -3,
            f: 0.5,
            nan: f64::NAN,
            none: None,
            some: Some(4),
            list: vec![1, 2],
            kinds: [
                Kind::Unit,
                Kind::New(1),
                Kind::Tuple(1, 2),
                Kind::Struct { a: 3 },
            ],
            map: [(1, true)].into_iter().collect(),
        };
        let bounded = to_value(&data);
        assert!(!bounded.failed);
        assert_eq!(bounded.value, serde_json::to_value(&data).unwrap());
    }

    /// A sequence that counts how many of its items were pulled.
    struct Endless<'a>(&'a Cell<u64>);

    impl Serialize for Endless<'_> {
        fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            let mut seq = serializer.serialize_seq(None)?;
            for index in 0..1_000_000_u64 {
                self.0.set(self.0.get() + 1);
                seq.serialize_element(&index)?;
            }
            seq.end()
        }
    }

    #[test]
    fn a_huge_collection_is_not_walked_past_its_limit() {
        let pulled = Cell::new(0);
        let bounded = to_value(&Endless(&pulled));
        assert!(
            pulled.get() <= MAX_ARRAY_ITEMS as u64 + 1,
            "{}",
            pulled.get()
        );
        assert_eq!(
            bounded.value.as_array().map(Vec::len),
            Some(MAX_ARRAY_ITEMS)
        );
        assert!(!bounded.failed);
    }

    /// Nested `depth` levels, recording the deepest level entered.
    struct Deep<'a> {
        depth: u32,
        deepest: &'a Cell<u32>,
    }

    impl Serialize for Deep<'_> {
        fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            self.deepest.set(self.deepest.get().max(self.depth));
            let mut seq = serializer.serialize_seq(Some(1))?;
            if self.depth < 100_000 {
                seq.serialize_element(&Deep {
                    depth: self.depth + 1,
                    deepest: self.deepest,
                })?;
            }
            seq.end()
        }
    }

    #[test]
    fn a_deep_value_is_not_entered_past_its_limit() {
        let deepest = Cell::new(0);
        let bounded = to_value(&Deep {
            depth: 0,
            deepest: &deepest,
        });
        assert!(deepest.get() as usize <= MAX_DEPTH, "{}", deepest.get());
        let text = bounded.value.to_string();
        assert!(text.contains(DEPTH), "{text}");
        assert_eq!(text.matches('[').count(), MAX_DEPTH + 1);
    }

    /// Wide at every level: without a record limit this would be 100^12 values.
    struct Wide(u32);

    impl Serialize for Wide {
        fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            let mut map = serializer.serialize_map(None)?;
            for index in 0..100 {
                if self.0 < 11 {
                    map.serialize_entry(&index, &Wide(self.0 + 1))?;
                } else {
                    map.serialize_entry(&index, &"x".repeat(100))?;
                }
            }
            map.end()
        }
    }

    #[test]
    fn the_record_has_a_total_limit() {
        let started = std::time::Instant::now();
        let bounded = to_value(&Wide(0));
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        let text = bounded.value.to_string();
        assert!(text.len() <= MAX_RECORD_BYTES + 1024, "{}", text.len());
        assert!(text.contains(TRUNCATED), "{text}");
    }

    struct Panics;

    impl Serialize for Panics {
        fn serialize<S: Serializer>(&self, _serializer: S) -> Result<S::Ok, S::Error> {
            panic!("a caller's Serialize panicked")
        }
    }

    struct Fails;

    impl Serialize for Fails {
        fn serialize<S: Serializer>(&self, _serializer: S) -> Result<S::Ok, S::Error> {
            Err(serde::ser::Error::custom("no"))
        }
    }

    #[test]
    fn a_failing_or_panicking_serialize_is_contained() {
        let bounded = to_value(&Panics);
        assert!(bounded.failed);
        assert_eq!(bounded.value, json!(UNSERIALIZABLE));
        let bounded = to_value(&(1, Fails, 3));
        assert!(bounded.failed);
        assert_eq!(bounded.value, json!([1, UNSERIALIZABLE, 3]));
    }

    #[test]
    fn strings_are_cut_on_a_character_boundary() {
        let bounded = to_value(&"😀".repeat(MAX_STRING_CHARS + 5));
        assert_eq!(
            bounded.value.as_str().map(|text| text.chars().count()),
            Some(MAX_STRING_CHARS + 1)
        );
        let mut keys = serde_json::Map::new();
        for index in 0..150 {
            keys.insert(format!("k{index}"), json!(index));
        }
        let bounded = to_value(&keys);
        assert_eq!(
            bounded.value.as_object().map(serde_json::Map::len),
            Some(MAX_OBJECT_FIELDS)
        );
    }
}

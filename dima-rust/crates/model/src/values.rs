//! Value types several collections share.

use bson::{Bson, Document};
use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

/// An input field with three states, for the few create paths of the reference that pass an
/// explicit `null` through (`new Model({ description: raw.description })` with a stored `null`):
/// left out, so the schema default applies ([`Nullable::Unset`]); stored as `null`
/// ([`Nullable::Null`]); or a value. Declare the field with
/// `#[serde(default, skip_serializing_if = "Nullable::is_unset")]`.
///
/// Use it only where a create path really passes `null`; every other optional input field is an
/// `Option` left out when `None`. A `Mixed` field needs neither: its `Bson` holds `null` itself.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Nullable<T> {
    /// Left out: the schema default applies.
    #[default]
    Unset,
    /// Stored as `null`.
    Null,
    /// Stored as the value.
    Value(T),
}

impl<T> Nullable<T> {
    /// `true` when left out (for `skip_serializing_if`).
    pub fn is_unset(&self) -> bool {
        matches!(self, Self::Unset)
    }

    /// JavaScript's `value ?? null`: `None` is stored as `null`.
    pub fn or_null(value: Option<T>) -> Self {
        value.map_or(Self::Null, Self::Value)
    }
}

impl<T> From<T> for Nullable<T> {
    fn from(value: T) -> Self {
        Self::Value(value)
    }
}

impl<T: Serialize> Serialize for Nullable<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            // Only reached when the field lacks `skip_serializing_if`: still never a value.
            Self::Unset | Self::Null => serializer.serialize_none(),
            Self::Value(value) => value.serialize(serializer),
        }
    }
}

/// A `Map` of strings (`{ type: Map, of: String }`), entries in stored order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StringMap(pub Vec<(String, String)>);

impl StringMap {
    /// The value of `key`.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// The entries as a BSON document (for a `$set` of the whole map).
    pub fn to_document(&self) -> Document {
        self.0
            .iter()
            .map(|(k, v)| (k.clone(), Bson::String(v.clone())))
            .collect()
    }
}

impl<'de> Deserialize<'de> for StringMap {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Entries;
        impl<'de> Visitor<'de> for Entries {
            type Value = StringMap;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a document of strings")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<StringMap, A::Error> {
                let mut entries = Vec::with_capacity(map.size_hint().unwrap_or(0));
                while let Some((key, value)) = map.next_entry::<String, String>()? {
                    entries.push((key, value));
                }
                Ok(StringMap(entries))
            }

            fn visit_unit<E: de::Error>(self) -> Result<StringMap, E> {
                Ok(StringMap::default())
            }
        }
        deserializer.deserialize_any(Entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::doc;

    #[derive(Deserialize)]
    struct Row {
        vars: StringMap,
    }

    #[derive(Serialize)]
    struct Input {
        #[serde(skip_serializing_if = "Nullable::is_unset")]
        a: Nullable<String>,
        #[serde(skip_serializing_if = "Nullable::is_unset")]
        b: Nullable<String>,
        #[serde(skip_serializing_if = "Nullable::is_unset")]
        c: Nullable<String>,
    }

    #[test]
    fn nullable_has_three_states() -> Result<(), bson::error::Error> {
        let input = Input {
            a: Nullable::Unset,
            b: Nullable::Null,
            c: "x 👋".to_owned().into(),
        };
        assert_eq!(
            bson::serialize_to_document(&input)?,
            doc! { "b": Bson::Null, "c": "x 👋" }
        );
        assert_eq!(Nullable::<u8>::or_null(None), Nullable::Null);
        Ok(())
    }

    #[test]
    fn keeps_order_and_reads_null_as_empty() -> Result<(), bson::error::Error> {
        let row: Row =
            bson::deserialize_from_document(doc! { "vars": { "b": "1", "clé 👋": "שלום" } })?;
        assert_eq!(row.vars.0[0], ("b".to_owned(), "1".to_owned()));
        assert_eq!(row.vars.get("clé 👋"), Some("שלום"));
        assert_eq!(row.vars.to_document(), doc! { "b": "1", "clé 👋": "שלום" });
        let row: Row = bson::deserialize_from_document(doc! { "vars": Bson::Null })?;
        assert!(row.vars.0.is_empty());
        Ok(())
    }
}

//! Value types several collections share.

use bson::{Bson, Document};
use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use std::fmt;

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

//! Document ids: ObjectId casting as Mongoose does it (ledger rule 3) and ids that are a string
//! in some collections and an ObjectId in others (rule 2).

use bson::oid::ObjectId;
use bson::{Bson, Document, doc};
use serde::{Deserialize, Serialize};
use std::fmt;

/// A value Mongoose could not cast to an ObjectId (its `CastError`). The HTTP layer of the
/// reference usually turns this into a 400 or 500; callers decide.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("Cast to ObjectId failed for value \"{value}\"")]
pub struct CastError {
    /// The text that was not a valid ObjectId.
    pub value: String,
}

/// Casts `text` to an ObjectId exactly as Mongoose casts a string in a filter or `findById`:
/// accepted only when it is exactly 24 hexadecimal digits (either case; the id is the same).
/// Everything else fails, including 12-character strings, surrounding spaces and an empty
/// string (pinned by the golden table `objectIdCasts`).
pub fn parse_object_id(text: &str) -> Result<ObjectId, CastError> {
    if text.len() == 24 && text.bytes().all(|b| b.is_ascii_hexdigit()) {
        ObjectId::parse_str(text).map_err(|_| cast_error(text))
    } else {
        Err(cast_error(text))
    }
}

fn cast_error(text: &str) -> CastError {
    CastError {
        value: text.to_owned(),
    }
}

/// `{"$in": [ObjectId, ...]}` from string ids, as Mongoose casts `{_id: {$in: [strings]}}` on an
/// ObjectId collection. One invalid id fails the whole filter, as in the reference.
pub fn object_id_in<I, S>(ids: I) -> Result<Document, CastError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let ids = ids
        .into_iter()
        .map(|id| parse_object_id(id.as_ref()).map(Bson::ObjectId))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(doc! { "$in": ids })
}

/// `{"$in": [string, ...]}` for a collection whose `_id` is a string.
pub fn string_in<I, S>(ids: I) -> Document
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let ids: Vec<Bson> = ids.into_iter().map(|id| Bson::String(id.into())).collect();
    doc! { "$in": ids }
}

/// The type of a collection's `_id` (41 collections use strings, the rest ObjectIds).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum IdType {
    /// `_id` is an ObjectId: string ids are cast with [`parse_object_id`].
    ObjectId,
    /// `_id` is a string: string ids are used as they are.
    String,
}

impl IdType {
    /// The filter value for `findById(text)` on a collection with this id type.
    pub fn cast(self, text: &str) -> Result<Bson, CastError> {
        match self {
            Self::ObjectId => parse_object_id(text).map(Bson::ObjectId),
            Self::String => Ok(Bson::String(text.to_owned())),
        }
    }

    /// `{"$in": [...]}` for many string ids on a collection with this id type.
    pub fn cast_in<I, S>(self, ids: I) -> Result<Document, CastError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        match self {
            Self::ObjectId => object_id_in(ids),
            Self::String => Ok(string_in(ids.into_iter().map(|id| id.as_ref().to_owned()))),
        }
    }
}

/// An `_id` read from a collection that may hold strings or ObjectIds.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(untagged)]
pub enum DocId {
    /// An ObjectId.
    ObjectId(ObjectId),
    /// A string id.
    String(String),
}

impl DocId {
    /// Reads an id value; `None` for any other BSON type.
    pub fn from_bson(value: &Bson) -> Option<Self> {
        match value {
            Bson::ObjectId(id) => Some(Self::ObjectId(*id)),
            Bson::String(id) => Some(Self::String(id.clone())),
            _ => None,
        }
    }

    /// The stored form.
    pub fn to_bson(&self) -> Bson {
        match self {
            Self::ObjectId(id) => Bson::ObjectId(*id),
            Self::String(id) => Bson::String(id.clone()),
        }
    }

    /// The ObjectId, when it is one.
    pub fn as_object_id(&self) -> Option<ObjectId> {
        match self {
            Self::ObjectId(id) => Some(*id),
            Self::String(_) => None,
        }
    }

    /// The text JavaScript produces with `String(id)` or in JSON: 24 lowercase hex digits for an
    /// ObjectId, the string itself otherwise.
    pub fn to_text(&self) -> String {
        match self {
            Self::ObjectId(id) => id.to_hex(),
            Self::String(id) => id.clone(),
        }
    }
}

impl<'de> Deserialize<'de> for DocId {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Bson::deserialize(deserializer)?;
        Self::from_bson(&value).ok_or_else(|| {
            serde::de::Error::custom(format!(
                "expected a string or ObjectId id, found {:?}",
                value.element_type()
            ))
        })
    }
}

impl fmt::Display for DocId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ObjectId(id) => formatter.write_str(&id.to_hex()),
            Self::String(id) => formatter.write_str(id),
        }
    }
}

impl From<ObjectId> for DocId {
    fn from(value: ObjectId) -> Self {
        Self::ObjectId(value)
    }
}

impl From<String> for DocId {
    fn from(value: String) -> Self {
        Self::String(value)
    }
}

impl From<DocId> for Bson {
    fn from(value: DocId) -> Self {
        value.to_bson()
    }
}

/// The `_id` of a document, string or ObjectId.
pub fn read_id(document: &Document) -> Option<DocId> {
    document.get("_id").and_then(DocId::from_bson)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn casts_only_24_hex_digits() {
        let ok = parse_object_id("0123456789ABCDEF01234567").map(|id| id.to_hex());
        assert_eq!(ok.as_deref(), Ok("0123456789abcdef01234567"));
        for bad in [
            "",
            "0123456789abcdef0123456",
            "0123456789abcdef012345678",
            " 0123456789abcdef01234567",
            "zzzzzzzzzzzzzzzzzzzzzzzz",
            "aaaaaaaaaaaa",
            "👋👋👋👋👋👋",
            "ééééééééééé",
            "0123456789abcdef0123456é",
        ] {
            assert_eq!(
                parse_object_id(bad),
                Err(CastError {
                    value: bad.to_owned()
                }),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn in_filters() -> Result<(), CastError> {
        let filter = object_id_in(["000000000000000000000001", "000000000000000000000002"])?;
        let Some(Bson::Array(ids)) = filter.get("$in") else {
            panic!("missing $in");
        };
        assert!(ids.iter().all(|id| matches!(id, Bson::ObjectId(_))));
        assert!(object_id_in(["000000000000000000000001", "nope"]).is_err());
        assert_eq!(string_in(["a", "שלום"]), doc! { "$in": ["a", "שלום"] });
        assert_eq!(IdType::String.cast("p1"), Ok(Bson::String("p1".into())));
        assert!(IdType::ObjectId.cast("p1").is_err());
        Ok(())
    }

    #[test]
    fn doc_id_reads_both_types() -> Result<(), Box<dyn std::error::Error>> {
        let oid = parse_object_id("0123456789abcdef01234567")?;
        assert_eq!(read_id(&doc! { "_id": oid }), Some(DocId::ObjectId(oid)));
        assert_eq!(
            read_id(&doc! { "_id": "c1:2026" }),
            Some(DocId::String("c1:2026".into()))
        );
        assert_eq!(read_id(&doc! { "_id": 1 }), None);
        assert_eq!(read_id(&doc! {}), None);
        assert_eq!(DocId::ObjectId(oid).to_string(), "0123456789abcdef01234567");
        let typed: DocId = bson::deserialize_from_bson(Bson::String("x".into()))?;
        assert_eq!(typed, DocId::String("x".into()));
        let typed: DocId = bson::deserialize_from_bson(Bson::ObjectId(oid))?;
        assert_eq!(typed, DocId::ObjectId(oid));
        Ok(())
    }
}

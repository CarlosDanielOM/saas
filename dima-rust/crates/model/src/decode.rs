//! Decoding stored documents into the read types.
//!
//! The fast path deserializes straight from the BSON bytes the driver returned
//! (`Collection<RawDocumentBuf>` or a `RawDocument` borrowed from a cursor), with no intermediate
//! `Document`. Only when that fails is the document decoded a second time with path tracking, so
//! the error names the field that broke (`accounts[0].type`).

use bson::{Document, RawDocument, RawDocumentBuf};
use serde::de::DeserializeOwned;
use std::fmt;

/// A document decoded with some collection's read type, as the registry hands it out: it can only
/// be shown through `Debug`, which keeps [`crate::Private`] values private.
pub type Decoded = Box<dyn fmt::Debug + Send + Sync>;

/// [`decode`] for the registry ([`crate::CollectionInfo::decode`]).
pub fn decode_boxed<T>(raw: &RawDocument) -> Result<Decoded, DecodeError>
where
    T: DeserializeOwned + fmt::Debug + Send + Sync + 'static,
{
    decode::<T>(raw).map(|value| Box::new(value) as Decoded)
}

/// A stored document that does not fit its read type.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{path}: {message}")]
pub struct DecodeError {
    /// The field, as serde names it (`accounts[0].type`; `.` for the document itself).
    pub path: String,
    /// What was wrong.
    pub message: String,
}

/// Decodes `raw` into `T`.
pub fn decode<T: DeserializeOwned>(raw: &RawDocument) -> Result<T, DecodeError> {
    match bson::deserialize_from_slice(raw.as_bytes()) {
        Ok(value) => Ok(value),
        Err(error) => Err(locate::<T>(raw, &error)),
    }
}

/// Decodes a `Document` (for example one returned by `findOneAndUpdate`) into `T`.
pub fn decode_document<T: DeserializeOwned>(document: &Document) -> Result<T, DecodeError> {
    let raw = RawDocumentBuf::try_from(document).map_err(|error| DecodeError {
        path: ".".to_owned(),
        message: error.to_string(),
    })?;
    decode(&raw)
}

/// Decodes `raw` again, tracking the path, to say where the first attempt failed.
fn locate<T: DeserializeOwned>(raw: &RawDocument, first: &bson::error::Error) -> DecodeError {
    let fallback = || DecodeError {
        path: ".".to_owned(),
        message: first.to_string(),
    };
    let Ok(deserializer) = bson::RawDeserializer::new(raw.as_bytes()) else {
        return fallback();
    };
    match serde_path_to_error::deserialize::<_, T>(deserializer) {
        Ok(_) => fallback(),
        Err(error) => DecodeError {
            path: error.path().to_string(),
            message: error.inner().to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::doc;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    struct Inner {
        #[allow(dead_code)]
        kind: String,
    }

    #[derive(Debug, Deserialize)]
    struct Outer {
        #[allow(dead_code)]
        items: Vec<Inner>,
    }

    #[test]
    fn errors_name_the_path() -> Result<(), bson::error::Error> {
        let good = RawDocumentBuf::try_from(&doc! { "items": [{ "kind": "a" }], "other": 1 })?;
        assert!(decode::<Outer>(&good).is_ok());
        let bad = RawDocumentBuf::try_from(&doc! { "items": [{ "kind": "a" }, { "kind": 5 }] })?;
        let error = decode::<Outer>(&bad).err();
        assert_eq!(error.map(|e| e.path), Some("items[1].kind".to_owned()));
        let missing = decode_document::<Outer>(&doc! {}).err();
        assert_eq!(missing.map(|e| e.path), Some(".".to_owned()));
        Ok(())
    }
}

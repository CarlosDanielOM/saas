//! Enumerated string fields (`enum: [...]` in a Mongoose schema).
//!
//! Each enumeration is a closed Rust enum declared with `str_enum!`, listing the schema's values
//! in the schema's order. Input types use the closed enum, so a new document can only hold a
//! value the schema accepts. Read types use [`Open`], which also keeps a value the schema no longer
//! lists (Mongoose validates only on `create`/`save`, so updates and older releases may have
//! stored anything).

use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::marker::PhantomData;

/// A string enumeration of a schema.
pub trait StrEnum: Copy + Eq + fmt::Debug + Send + Sync + 'static {
    /// Every value, in the schema's order.
    const ALL: &'static [Self];
    /// The stored strings in the schema's order: the list Mongoose validates against.
    const STRINGS: &'static [&'static str];

    /// The stored string.
    fn as_str(self) -> &'static str;

    /// The value stored as `text`, if the schema lists it.
    fn parse(text: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|value| value.as_str() == text)
    }
}

/// Declares a closed string enumeration: the enum, [`StrEnum`], serde (a string; an unlisted
/// value is a decode error), `Display` and the conversion to BSON.
macro_rules! str_enum {
    (
        $(#[$meta:meta])*
        $vis:vis enum $name:ident {
            $( $(#[$vmeta:meta])* $variant:ident = $text:literal ),+ $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        $vis enum $name {
            $( $(#[$vmeta])* $variant ),+
        }

        impl $crate::enums::StrEnum for $name {
            const ALL: &'static [Self] = &[$(Self::$variant),+];
            const STRINGS: &'static [&'static str] = &[$($text),+];

            fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }
        }

        impl ::serde::Serialize for $name {
            fn serialize<S: ::serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str($crate::enums::StrEnum::as_str(*self))
            }
        }

        impl<'de> ::serde::Deserialize<'de> for $name {
            fn deserialize<D: ::serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                $crate::enums::deserialize_closed(deserializer)
            }
        }

        impl ::std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
                formatter.write_str($crate::enums::StrEnum::as_str(*self))
            }
        }

        impl From<$name> for ::bson::Bson {
            fn from(value: $name) -> Self {
                ::bson::Bson::String($crate::enums::StrEnum::as_str(value).to_owned())
            }
        }
    };
}
pub(crate) use str_enum;

/// A stored enumerated value: one the schema lists, or any other string found in the data.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Open<E> {
    /// A value the schema lists.
    Known(E),
    /// A string the schema does not list (an older release, or an unvalidated update).
    Unknown(String),
}

impl<E: StrEnum> Open<E> {
    /// The listed value, if it is one.
    pub fn known(&self) -> Option<E> {
        match self {
            Self::Known(value) => Some(*value),
            Self::Unknown(_) => None,
        }
    }

    /// The stored string.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Known(value) => value.as_str(),
            Self::Unknown(text) => text,
        }
    }

    /// `true` when the stored value is `value`.
    pub fn is(&self, value: E) -> bool {
        self.known() == Some(value)
    }
}

impl<E: StrEnum> From<E> for Open<E> {
    fn from(value: E) -> Self {
        Self::Known(value)
    }
}

impl<E: StrEnum> PartialEq<E> for Open<E> {
    fn eq(&self, other: &E) -> bool {
        self.is(*other)
    }
}

impl<E: StrEnum> fmt::Display for Open<E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl<E: StrEnum> Serialize for Open<E> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de, E: StrEnum> Deserialize<'de> for Open<E> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_str(OpenVisitor(PhantomData))
    }
}

struct OpenVisitor<E>(PhantomData<E>);

impl<E: StrEnum> Visitor<'_> for OpenVisitor<E> {
    type Value = Open<E>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a string")
    }

    fn visit_str<Er: de::Error>(self, text: &str) -> Result<Open<E>, Er> {
        Ok(E::parse(text).map_or_else(|| Open::Unknown(text.to_owned()), Open::Known))
    }

    fn visit_string<Er: de::Error>(self, text: String) -> Result<Open<E>, Er> {
        Ok(E::parse(&text).map_or(Open::Unknown(text), Open::Known))
    }
}

/// Deserializes a closed enumeration: a listed string, or an error naming the allowed values.
pub(crate) fn deserialize_closed<'de, D: Deserializer<'de>, E: StrEnum>(
    deserializer: D,
) -> Result<E, D::Error> {
    struct Closed<E>(PhantomData<E>);
    impl<E: StrEnum> Visitor<'_> for Closed<E> {
        type Value = E;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(formatter, "one of {:?}", E::STRINGS)
        }

        fn visit_str<Er: de::Error>(self, text: &str) -> Result<E, Er> {
            E::parse(text).ok_or_else(|| Er::unknown_variant(text, E::STRINGS))
        }
    }
    deserializer.deserialize_str(Closed(PhantomData))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::{Bson, doc};

    str_enum! {
        /// A test enumeration.
        pub enum Tier {
            /// Free.
            Free = "free",
            /// Pro.
            Pro = "pro",
        }
    }

    #[derive(Debug, Deserialize, Serialize, PartialEq)]
    struct Row {
        open: Open<Tier>,
        closed: Tier,
    }

    #[test]
    fn open_keeps_unlisted_values() -> Result<(), bson::error::Error> {
        let row: Row =
            bson::deserialize_from_document(doc! { "open": "legacy 👋", "closed": "pro" })?;
        assert_eq!(row.open, Open::Unknown("legacy 👋".into()));
        assert_eq!(row.closed, Tier::Pro);
        assert_eq!(row.open.as_str(), "legacy 👋");
        let row: Row = bson::deserialize_from_document(doc! { "open": "free", "closed": "free" })?;
        assert!(row.open == Tier::Free && row.open.is(Tier::Free));
        assert_eq!(
            bson::serialize_to_document(&row)?,
            doc! { "open": "free", "closed": "free" }
        );
        assert!(
            bson::deserialize_from_document::<Row>(doc! { "open": "x", "closed": "x" }).is_err()
        );
        assert_eq!(Tier::STRINGS, ["free", "pro"]);
        assert_eq!(Bson::from(Tier::Pro), Bson::String("pro".into()));
        Ok(())
    }
}

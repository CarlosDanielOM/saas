//! Dates between `bson::DateTime` and epoch milliseconds (ledger `mongo.md`, rules 21 and 22).
//!
//! `Date` paths are BSON dates in the data; TTL indexes only expire BSON dates, so every date a
//! Rust writer stores goes through [`date`]. Fields the reference declares as `Number` and fills
//! with `Date.now()` (`dueAt`, `leaseUntil`, `actionDueAt` in the duel, roulette and widget
//! collections) stay numbers: use [`crate::mongo::number::JsInt`] for them.

use bson::{Bson, DateTime};
use serde::de;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// The BSON date for `ms` milliseconds since the Unix epoch.
pub fn date(ms: i64) -> DateTime {
    DateTime::from_millis(ms)
}

/// Milliseconds since the Unix epoch of a BSON date.
pub fn millis(value: DateTime) -> i64 {
    value.timestamp_millis()
}

/// Reads a time stored as a BSON date or as epoch milliseconds in a number, the way a hydrated
/// Mongoose `Date` path casts it: a date as it is; int32, int64 and double as milliseconds
/// (a fraction is cut toward zero, like JavaScript's TimeClip); a string through `Date.parse`
/// (ISO 8601 and HTTP dates, see `dima_text::parse_date`). `None` for anything else, for
/// non-finite numbers and for values outside the JavaScript `Date` range.
pub fn read_time(value: &Bson) -> Option<i64> {
    let ms = match value {
        Bson::DateTime(d) => d.timestamp_millis(),
        Bson::Int32(v) => i64::from(*v),
        Bson::Int64(v) => *v,
        Bson::Double(v) if v.is_finite() && v.abs() <= MAX_TIME_MS_F64 => v.trunc() as i64,
        Bson::String(text) => dima_text::parse_date(text)?,
        _ => return None,
    };
    (ms.abs() <= dima_text::MAX_TIME_MS).then_some(ms)
}

const MAX_TIME_MS_F64: f64 = 8.64e15;

/// A Mongoose `Date` field read tolerantly ([`read_time`]) and always written as a BSON date.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct JsDate(pub i64);

impl JsDate {
    /// The stored form: a BSON date.
    pub fn to_bson(self) -> Bson {
        Bson::DateTime(date(self.0))
    }

    /// Reads a stored value ([`read_time`]).
    pub fn from_bson(value: &Bson) -> Option<Self> {
        read_time(value).map(Self)
    }

    /// `toISOString()` text (`2026-11-11T10:00:00.000Z`).
    pub fn to_iso_string(self) -> Option<String> {
        dima_text::to_iso_string(self.0)
    }
}

impl From<DateTime> for JsDate {
    fn from(value: DateTime) -> Self {
        Self(value.timestamp_millis())
    }
}

impl From<JsDate> for Bson {
    fn from(value: JsDate) -> Self {
        value.to_bson()
    }
}

impl Serialize for JsDate {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        date(self.0).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for JsDate {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Bson::deserialize(deserializer)?;
        read_time(&value).map(Self).ok_or_else(|| {
            de::Error::custom(format!("expected a date, found {:?}", value.element_type()))
        })
    }
}

/// Serde helper for a `Date` field held as epoch milliseconds (`i64`) in Rust:
/// `#[serde(with = "dima_store::mongo::date::as_date")]`. Writes a BSON date, reads like
/// [`read_time`].
pub mod as_date {
    use super::*;

    /// Writes `ms` as a BSON date.
    pub fn serialize<S: Serializer>(ms: &i64, serializer: S) -> Result<S::Ok, S::Error> {
        date(*ms).serialize(serializer)
    }

    /// Reads a date, number or date text as epoch milliseconds.
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
        JsDate::deserialize(deserializer).map(|d| d.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::doc;

    #[test]
    fn conversions_round_trip() {
        assert_eq!(millis(date(1_794_391_200_123)), 1_794_391_200_123);
        assert_eq!(millis(date(-1)), -1);
    }

    #[test]
    fn tolerant_reads() {
        assert_eq!(read_time(&Bson::DateTime(date(5))), Some(5));
        assert_eq!(read_time(&Bson::Int32(7)), Some(7));
        assert_eq!(
            read_time(&Bson::Int64(1_700_000_000_000)),
            Some(1_700_000_000_000)
        );
        assert_eq!(read_time(&Bson::Double(1.9)), Some(1));
        assert_eq!(read_time(&Bson::Double(-1.9)), Some(-1));
        assert_eq!(read_time(&Bson::Double(f64::NAN)), None);
        assert_eq!(read_time(&Bson::Int64(8_640_000_000_000_001)), None);
        assert_eq!(
            read_time(&Bson::String("2026-11-11T10:00:00.123Z".into())),
            Some(1_794_391_200_123)
        );
        assert_eq!(read_time(&Bson::String("not a date".into())), None);
        assert_eq!(read_time(&Bson::Null), None);
        assert_eq!(read_time(&Bson::Boolean(true)), None);
    }

    #[test]
    fn serde_writes_dates() -> Result<(), Box<dyn std::error::Error>> {
        #[derive(Serialize, Deserialize, Debug, PartialEq)]
        struct Row {
            at: JsDate,
            #[serde(with = "as_date")]
            ms: i64,
        }
        let row: Row =
            bson::deserialize_from_document(doc! { "at": 5_i64, "ms": Bson::DateTime(date(9)) })?;
        assert_eq!(
            row,
            Row {
                at: JsDate(5),
                ms: 9
            }
        );
        let written = bson::serialize_to_document(&row)?;
        assert_eq!(written, doc! { "at": date(5), "ms": date(9) });
        assert_eq!(
            JsDate(0).to_iso_string().as_deref(),
            Some("1970-01-01T00:00:00.000Z")
        );
        Ok(())
    }
}

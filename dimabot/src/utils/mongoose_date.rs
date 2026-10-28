//! Mongoose 8.24.2 date casting for ordinary application values.
//!
//! BSON Int32, Int64 and Double represent JavaScript Numbers (Int64 is first
//! rounded to binary64); DateTime represents a JS Date, not a BSON Long
//! object. Arrays and documents represent ordinary JS arrays/plain objects,
//! with no executable coercion hooks. Other BSON-specific prototypes, Dates
//! inside arrays, and objects overriding coercion methods are outside this
//! contract. A caller handling values read as unpromoted BSON Long objects
//! must adapt them separately. Local date parsing inherits `js_date`'s host
//! timezone-data and fixed-process-timezone limitations.
use mongodb::bson::{Bson, DateTime};
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DateCastError {
    InvalidDate,
    UnsupportedInput,
}

impl fmt::Display for DateCastError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}",
            match self {
                Self::InvalidDate => "invalid date",
                Self::UnsupportedInput => "unsupported BSON date input",
            }
        )
    }
}
impl std::error::Error for DateCastError {}

const MAX_TIME: f64 = 8_640_000_000_000_000.0;

fn clip(value: f64) -> Result<i64, DateCastError> {
    if value.is_finite() && value.abs() <= MAX_TIME {
        Ok(value.trunc() as i64)
    } else {
        Err(DateCastError::InvalidDate)
    }
}

fn array_string(values: &[Bson]) -> Result<String, DateCastError> {
    let mut parts = Vec::with_capacity(values.len());
    for value in values {
        parts.push(match value {
            Bson::Null => String::new(),
            Bson::String(s) => s.clone(),
            Bson::Boolean(v) => v.to_string(),
            Bson::Int32(v) => super::json_number::number_string(f64::from(*v)),
            Bson::Int64(v) => super::json_number::number_string(*v as f64),
            Bson::Double(v) => super::json_number::number_string(*v),
            Bson::Array(v) => array_string(v)?,
            Bson::Document(v) if !v.contains_key("toString") && !v.contains_key("valueOf") => {
                "[object Object]".into()
            }
            _ => return Err(DateCastError::UnsupportedInput),
        });
    }
    Ok(parts.join(","))
}

/// Cast an ordinary value to BSON DateTime or Null. Schema callers translate
/// failures to their own path-specific CastError. Empty strings become null;
/// empty arrays instead go through `new Date('')` and are invalid.
pub fn cast(value: &Bson) -> Result<Bson, DateCastError> {
    let millis = match value {
        Bson::Null => return Ok(Bson::Null),
        Bson::String(s) if s.is_empty() => return Ok(Bson::Null),
        Bson::String(s) => {
            let number = super::json_number::string_number(s);
            if !number.is_nan() && (number >= 275_761.0 || number < -271_820.0) {
                clip(number)?
            } else {
                super::js_date::parse_date(s).ok_or(DateCastError::InvalidDate)?
            }
        }
        Bson::DateTime(v) => clip(v.timestamp_millis() as f64)?,
        Bson::Int32(v) => clip(f64::from(*v))?,
        Bson::Int64(v) => clip(*v as f64)?,
        Bson::Double(v) => clip(*v)?,
        Bson::Boolean(_) => return Err(DateCastError::InvalidDate),
        Bson::Array(v) => {
            super::js_date::parse_date(&array_string(v)?).ok_or(DateCastError::InvalidDate)?
        }
        Bson::Document(v) if !v.contains_key("toString") && !v.contains_key("valueOf") => {
            return Err(DateCastError::InvalidDate);
        }
        _ => return Err(DateCastError::UnsupportedInput),
    };
    Ok(Bson::DateTime(DateTime::from_millis(millis)))
}

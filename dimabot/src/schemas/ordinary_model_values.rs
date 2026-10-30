//! Shared strict DTO readers for the ordinary application schemas.
//!
//! The concrete repository stores the BSON document, including null, Mixed
//! extras, and values a strict interface rejects. These helpers decode only
//! the declared shape and do not reapply schema defaults.
//!
//! BSON strings are UTF-8. [`JsString::to_utf8_lossy`] replaces each unpaired
//! UTF-16 unit with U+FFFD. Rust BSON cannot hold a lone surrogate.
use crate::utils::{bson_compat::js_number, js_string::JsString};
use mongodb::bson::{Bson, DateTime, Document, oid::ObjectId};

/// A strict view rejected a stored value. `path` is owned because nested
/// paths are not all `'static`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StrictDecodeError {
    pub path: String,
    pub kind: &'static str,
}

/// `day` / `month` / `year` as JavaScript numbers.
#[derive(Clone, Debug, PartialEq)]
pub struct CalendarDate {
    pub day: f64,
    pub month: f64,
    pub year: f64,
}

/// Borrowed document reader. Unknown keys, including `__v`, are ignored.
pub struct Reader<'a> {
    document: &'a Document,
    prefix: String,
}

impl<'a> Reader<'a> {
    pub fn new(document: &'a Document) -> Self {
        Self {
            document,
            prefix: String::new(),
        }
    }

    pub fn with_prefix(document: &'a Document, prefix: &str) -> Self {
        Self {
            document,
            prefix: prefix.to_owned(),
        }
    }

    pub fn document(&self) -> &'a Document {
        self.document
    }

    pub fn location(&self) -> &str {
        &self.prefix
    }

    fn path(&self, key: &str) -> String {
        if self.prefix.is_empty() {
            key.to_owned()
        } else {
            format!("{}.{key}", self.prefix)
        }
    }

    fn error(&self, key: &str, kind: &'static str) -> StrictDecodeError {
        StrictDecodeError {
            path: self.path(key),
            kind,
        }
    }

    fn value(&self, key: &str) -> Result<Option<&'a Bson>, StrictDecodeError> {
        match self.document.get(key) {
            None => Ok(None),
            Some(Bson::Null) => Err(self.error(key, "null")),
            Some(value) => Ok(Some(value)),
        }
    }

    pub fn require_string(&self, key: &str) -> Result<JsString, StrictDecodeError> {
        match self.value(key)? {
            Some(Bson::String(text)) => Ok(JsString::from(text.as_str())),
            Some(_) => Err(self.error(key, "type")),
            None => Err(self.error(key, "required")),
        }
    }

    pub fn optional_string(&self, key: &str) -> Result<Option<JsString>, StrictDecodeError> {
        match self.value(key)? {
            Some(Bson::String(text)) => Ok(Some(JsString::from(text.as_str()))),
            Some(_) => Err(self.error(key, "type")),
            None => Ok(None),
        }
    }

    pub fn require_f64(&self, key: &str) -> Result<f64, StrictDecodeError> {
        match self.value(key)? {
            Some(value) => js_f64(value).map_err(|_| self.error(key, "type")),
            None => Err(self.error(key, "required")),
        }
    }

    pub fn optional_f64(&self, key: &str) -> Result<Option<f64>, StrictDecodeError> {
        match self.value(key)? {
            Some(value) => js_f64(value).map(Some).map_err(|_| self.error(key, "type")),
            None => Ok(None),
        }
    }

    pub fn require_bool(&self, key: &str) -> Result<bool, StrictDecodeError> {
        match self.value(key)? {
            Some(Bson::Boolean(value)) => Ok(*value),
            Some(_) => Err(self.error(key, "type")),
            None => Err(self.error(key, "required")),
        }
    }

    pub fn optional_bool(&self, key: &str) -> Result<Option<bool>, StrictDecodeError> {
        match self.value(key)? {
            Some(Bson::Boolean(value)) => Ok(Some(*value)),
            Some(_) => Err(self.error(key, "type")),
            None => Ok(None),
        }
    }

    pub fn require_datetime(&self, key: &str) -> Result<DateTime, StrictDecodeError> {
        match self.value(key)? {
            Some(Bson::DateTime(value)) => Ok(*value),
            Some(_) => Err(self.error(key, "type")),
            None => Err(self.error(key, "required")),
        }
    }

    pub fn optional_datetime(&self, key: &str) -> Result<Option<DateTime>, StrictDecodeError> {
        match self.value(key)? {
            Some(Bson::DateTime(value)) => Ok(Some(*value)),
            Some(_) => Err(self.error(key, "type")),
            None => Ok(None),
        }
    }

    /// Missing is `None`. JSON/BSON null is `Some(None)`. A date is `Some(Some)`.
    pub fn nullable_datetime(
        &self,
        key: &str,
    ) -> Result<Option<Option<DateTime>>, StrictDecodeError> {
        match self.document.get(key) {
            None => Ok(None),
            Some(Bson::Null) => Ok(Some(None)),
            Some(Bson::DateTime(value)) => Ok(Some(Some(*value))),
            Some(_) => Err(self.error(key, "type")),
        }
    }

    pub fn require_object_id(&self, key: &str) -> Result<ObjectId, StrictDecodeError> {
        match self.value(key)? {
            Some(Bson::ObjectId(value)) => Ok(*value),
            Some(_) => Err(self.error(key, "type")),
            None => Err(self.error(key, "required")),
        }
    }

    pub fn optional_object_id(&self, key: &str) -> Result<Option<ObjectId>, StrictDecodeError> {
        match self.value(key)? {
            Some(Bson::ObjectId(value)) => Ok(Some(*value)),
            Some(_) => Err(self.error(key, "type")),
            None => Ok(None),
        }
    }

    pub fn require_document(&self, key: &str) -> Result<Reader<'a>, StrictDecodeError> {
        match self.value(key)? {
            Some(Bson::Document(document)) => Ok(Reader {
                document,
                prefix: self.path(key),
            }),
            Some(_) => Err(self.error(key, "type")),
            None => Err(self.error(key, "required")),
        }
    }

    pub fn optional_document(&self, key: &str) -> Result<Option<Reader<'a>>, StrictDecodeError> {
        match self.value(key)? {
            Some(Bson::Document(document)) => Ok(Some(Reader {
                document,
                prefix: self.path(key),
            })),
            Some(_) => Err(self.error(key, "type")),
            None => Ok(None),
        }
    }

    pub fn require_array(&self, key: &str) -> Result<&'a Vec<Bson>, StrictDecodeError> {
        match self.value(key)? {
            Some(Bson::Array(values)) => Ok(values),
            Some(_) => Err(self.error(key, "type")),
            None => Err(self.error(key, "required")),
        }
    }
}

/// `Int64` outside the binary64 integer range is lossy. The repository
/// document keeps the original BSON; this view matches a JavaScript number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidNumber;

pub fn js_f64(value: &Bson) -> Result<f64, InvalidNumber> {
    let number = match value {
        Bson::Int32(number) => f64::from(*number),
        Bson::Int64(number) => *number as f64,
        Bson::Double(number) => *number,
        _ => return Err(InvalidNumber),
    };
    if number.is_finite() {
        Ok(number)
    } else {
        Err(InvalidNumber)
    }
}

pub fn bson_string(value: &JsString) -> Bson {
    Bson::String(value.to_utf8_lossy())
}

pub fn insert_string(document: &mut Document, key: &str, value: &JsString) {
    document.insert(key, value.to_utf8_lossy());
}

pub fn insert_optional_string(document: &mut Document, key: &str, value: &Option<JsString>) {
    if let Some(value) = value {
        insert_string(document, key, value);
    }
}

pub fn insert_f64(document: &mut Document, key: &str, value: f64) {
    document.insert(key, js_number(value));
}

pub fn insert_optional_f64(document: &mut Document, key: &str, value: Option<f64>) {
    if let Some(value) = value {
        insert_f64(document, key, value);
    }
}

pub fn insert_datetime(document: &mut Document, key: &str, value: DateTime) {
    document.insert(key, value);
}

pub fn insert_optional_datetime(document: &mut Document, key: &str, value: Option<DateTime>) {
    if let Some(value) = value {
        document.insert(key, value);
    }
}

pub fn insert_nullable_datetime(
    document: &mut Document,
    key: &str,
    value: Option<Option<DateTime>>,
) {
    match value {
        None => {}
        Some(None) => {
            document.insert(key, Bson::Null);
        }
        Some(Some(value)) => {
            document.insert(key, value);
        }
    }
}

impl CalendarDate {
    pub fn from_reader(reader: &Reader<'_>) -> Result<Self, StrictDecodeError> {
        Ok(Self {
            day: reader.require_f64("day")?,
            month: reader.require_f64("month")?,
            year: reader.require_f64("year")?,
        })
    }

    pub fn to_document(&self) -> Document {
        let mut document = Document::new();
        insert_f64(&mut document, "day", self.day);
        insert_f64(&mut document, "month", self.month);
        insert_f64(&mut document, "year", self.year);
        document
    }
}

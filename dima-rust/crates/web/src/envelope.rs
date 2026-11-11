//! The house JSON envelope `{ error, message, status, data }`.
//!
//! Most API handlers answer with it, but not all, and not always consistently: some put the
//! fields in another order, some omit `status` or `data`, and some send an HTTP status that
//! differs from the body's `status` on purpose. This helper produces the common shape only;
//! anything else is written with `serde_json::json!` and [`crate::Response::json`].

use std::borrow::Cow;

use serde::Serialize;
use serde_json::Value;

use crate::response::Response;

/// `{ "error": …, "message": …, "status": …, "data": … }` in that key order; `data` is left out
/// when unset (JavaScript `undefined`), and written as `null` when set to `Value::Null`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Envelope<T = Value> {
    /// `error`.
    pub error: bool,
    /// `message`.
    pub message: Cow<'static, str>,
    /// `status` in the body (not necessarily the HTTP status).
    pub status: u16,
    /// `data`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
}

impl Envelope<Value> {
    /// `{ error, message, status }`.
    pub fn new(error: bool, message: impl Into<Cow<'static, str>>, status: u16) -> Self {
        Self {
            error,
            message: message.into(),
            status,
            data: None,
        }
    }

    /// `{ error: false, message, status: 200 }`.
    pub fn ok(message: impl Into<Cow<'static, str>>) -> Self {
        Self::new(false, message, 200)
    }

    /// `{ error: true, message, status }`.
    pub fn fail(status: u16, message: impl Into<Cow<'static, str>>) -> Self {
        Self::new(true, message, status)
    }
}

impl<T: Serialize> Envelope<T> {
    /// Sets `data`.
    #[must_use]
    pub fn data<U: Serialize>(self, data: U) -> Envelope<U> {
        Envelope {
            error: self.error,
            message: self.message,
            status: self.status,
            data: Some(data),
        }
    }

    /// A JSON response whose HTTP status equals the body's `status`.
    pub fn reply(self) -> Response {
        let status = self.status;
        self.reply_with(status)
    }

    /// A JSON response with an HTTP status that differs from the body's `status`.
    pub fn reply_with(self, http_status: u16) -> Response {
        Response::status(http_status).json(&self)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn serializes_in_house_order() {
        let text = serde_json::to_string(&Envelope::fail(404, "Not found")).expect("serializes");
        assert_eq!(text, r#"{"error":true,"message":"Not found","status":404}"#);
        let text =
            serde_json::to_string(&Envelope::ok("OK").data(json!({"a": 1}))).expect("serializes");
        assert_eq!(
            text,
            r#"{"error":false,"message":"OK","status":200,"data":{"a":1}}"#
        );
        let text =
            serde_json::to_string(&Envelope::ok("OK").data(Value::Null)).expect("serializes");
        assert_eq!(
            text,
            r#"{"error":false,"message":"OK","status":200,"data":null}"#
        );
    }
}

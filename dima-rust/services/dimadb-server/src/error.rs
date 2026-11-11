//! The failure every route answers with: `{error: true, status, message}` (`fail()` in
//! `http-util.mjs`). The reference throws `Object.assign(new Error(message), {status})`; a thrown
//! error without a status is a 500 carrying the driver's or runtime's message.

/// An API failure: the HTTP status and the message sent in the envelope.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{status} {message}")]
pub struct ApiError {
    /// HTTP status (and the envelope's `status`).
    pub status: u16,
    /// The envelope's `message`.
    pub message: String,
}

impl ApiError {
    /// A failure with an explicit status (`Object.assign(new Error(message), { status })`).
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    /// A thrown error without a status: 500 with its message, logged by the route wrapper.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(500, message)
    }

    /// `400 <message>`.
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, message)
    }

    /// `404 <message>`.
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, message)
    }

    /// `409 <message>`.
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(409, message)
    }

    /// The reference's `error.message || 'Request failed'`.
    pub fn message_or_default(&self) -> &str {
        if self.message.is_empty() {
            "Request failed"
        } else {
            &self.message
        }
    }
}

/// Route results.
pub type ApiResult<T> = Result<T, ApiError>;

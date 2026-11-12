//! The delivery's headers, read strictly before any other work.
//!
//! The reference reads each as `String(req.headers[name] || '')`: Node lower-cases names, joins
//! repeated values with `", "` and decodes bytes as latin1. Twitch sends each header once, in
//! ASCII. Here a value is accepted only when it occurs once, is printable ASCII (`0x20..=0x7E`)
//! and fits its length bound; anything else is refused with the answer for a request that is not
//! from Twitch (403), without hashing the body. Names are matched case-insensitively (HTTP
//! names are; hyper lower-cases them), so `TWITCH-EVENTSUB-MESSAGE-ID` is the same header.
//!
//! What each refusal would have done in the reference: a repeated signature becomes `"a, b"`
//! (no match: 403); a non-ASCII signature of the right length threw inside `timingSafeEqual`
//! and exited the process (`packages.md`; here 403); a non-ASCII or over-long id or timestamp
//! can only match a signature made with the secret, which Twitch never sends.

use http::HeaderMap;

/// `Twitch-Eventsub-Message-Id`.
pub const MESSAGE_ID: &str = "twitch-eventsub-message-id";
/// `Twitch-Eventsub-Message-Timestamp`.
pub const MESSAGE_TIMESTAMP: &str = "twitch-eventsub-message-timestamp";
/// `Twitch-Eventsub-Message-Signature`.
pub const MESSAGE_SIGNATURE: &str = "twitch-eventsub-message-signature";
/// `Twitch-Eventsub-Message-Retry`.
pub const MESSAGE_RETRY: &str = "twitch-eventsub-message-retry";
/// `Twitch-Eventsub-Message-Type`.
pub const MESSAGE_TYPE: &str = "twitch-eventsub-message-type";

/// `HMAC_PREFIX` plus 64 lower-case hex digits: the only signature length that can match.
pub const SIGNATURE_BYTES: usize = "sha256=".len() + 64;

/// Why a request was refused before its body was read. Every reason answers 403 except the
/// content encoding (415); the reason only feeds a counter with a fixed name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeaderRefusal {
    /// A Twitch header occurs more than once.
    Repeated,
    /// A Twitch header holds a byte outside printable ASCII.
    NotAscii,
    /// A Twitch header is longer than its bound.
    TooLong,
    /// No signature, or not the length of one.
    NoSignature,
    /// No timestamp: the reference refuses it after hashing (an empty date is not a date).
    NoTimestamp,
    /// The content type is not `application/json` (the reference crashed: `packages.md`).
    ContentType,
    /// The body is compressed (`Content-Encoding` other than `identity`): 415.
    ContentEncoding,
}

impl HeaderRefusal {
    /// The counter name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Repeated => "header_repeated",
            Self::NotAscii => "header_not_ascii",
            Self::TooLong => "header_too_long",
            Self::NoSignature => "no_signature",
            Self::NoTimestamp => "no_timestamp",
            Self::ContentType => "content_type",
            Self::ContentEncoding => "content_encoding",
        }
    }
}

/// The Twitch headers of one delivery, each `""` when absent (`String(x || '')`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DeliveryHeaders {
    /// `Twitch-Eventsub-Message-Id`.
    pub message_id: String,
    /// `Twitch-Eventsub-Message-Timestamp`.
    pub timestamp: String,
    /// `Twitch-Eventsub-Message-Signature`.
    pub signature: String,
    /// `Twitch-Eventsub-Message-Retry`.
    pub retry: String,
    /// `Twitch-Eventsub-Message-Type`.
    pub message_type: String,
}

/// The bounds [`read`] applies.
#[derive(Clone, Copy, Debug)]
pub struct HeaderLimits {
    /// The longest message id.
    pub message_id: usize,
    /// The longest timestamp.
    pub timestamp: usize,
    /// The longest retry count and message type.
    pub short: usize,
}

fn one(headers: &HeaderMap, name: &str, limit: usize) -> Result<String, HeaderRefusal> {
    let mut values = headers.get_all(name).iter();
    let Some(value) = values.next() else {
        return Ok(String::new());
    };
    if values.next().is_some() {
        return Err(HeaderRefusal::Repeated);
    }
    let bytes = value.as_bytes();
    if bytes.len() > limit {
        return Err(HeaderRefusal::TooLong);
    }
    if !bytes.iter().all(|b| (0x20..=0x7e).contains(b)) {
        return Err(HeaderRefusal::NotAscii);
    }
    Ok(String::from_utf8_lossy(bytes).into_owned())
}

/// Reads and checks the Twitch headers and the body's framing headers.
pub fn read(headers: &HeaderMap, limits: HeaderLimits) -> Result<DeliveryHeaders, HeaderRefusal> {
    let signature = one(headers, MESSAGE_SIGNATURE, SIGNATURE_BYTES)?;
    if signature.len() != SIGNATURE_BYTES {
        return Err(HeaderRefusal::NoSignature);
    }
    let message_id = one(headers, MESSAGE_ID, limits.message_id)?;
    let timestamp = one(headers, MESSAGE_TIMESTAMP, limits.timestamp)?;
    if timestamp.is_empty() {
        return Err(HeaderRefusal::NoTimestamp);
    }
    let retry = one(headers, MESSAGE_RETRY, limits.short)?;
    let message_type = one(headers, MESSAGE_TYPE, limits.short)?;
    if !is_json(headers) {
        return Err(HeaderRefusal::ContentType);
    }
    let mut encodings = headers.get_all(http::header::CONTENT_ENCODING).iter();
    if let Some(encoding) = encodings.next()
        && (encodings.next().is_some() || !encoding.as_bytes().eq_ignore_ascii_case(b"identity"))
    {
        return Err(HeaderRefusal::ContentEncoding);
    }
    Ok(DeliveryHeaders {
        message_id,
        timestamp,
        signature,
        retry,
        message_type,
    })
}

/// `express.raw({ type: 'application/json' })` only reads `application/json` bodies (any
/// parameters, any case). Exactly one `Content-Type` is accepted.
fn is_json(headers: &HeaderMap) -> bool {
    let mut values = headers.get_all(http::header::CONTENT_TYPE).iter();
    let (Some(value), None) = (values.next(), values.next()) else {
        return false;
    };
    let essence = value
        .as_bytes()
        .split(|b| *b == b';')
        .next()
        .unwrap_or_default();
    essence
        .trim_ascii()
        .eq_ignore_ascii_case(b"application/json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    const LIMITS: HeaderLimits = HeaderLimits {
        message_id: 128,
        timestamp: 64,
        short: 64,
    };

    fn headers(pairs: &[(&str, &[u8])]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            if let (Ok(name), Ok(value)) = (
                http::HeaderName::from_bytes(name.as_bytes()),
                HeaderValue::from_bytes(value),
            ) {
                map.append(name, value);
            }
        }
        map
    }

    fn signature() -> Vec<u8> {
        format!("sha256={}", "a".repeat(64)).into_bytes()
    }

    fn valid() -> Vec<(&'static str, Vec<u8>)> {
        vec![
            ("Content-Type", b"application/json".to_vec()),
            (
                "Twitch-Eventsub-Message-Id",
                b"befa7b53-d79d-478f-86b9-120f112b044e".to_vec(),
            ),
            (
                "Twitch-Eventsub-Message-Timestamp",
                b"2026-11-12T09:29:58.123456789Z".to_vec(),
            ),
            ("Twitch-Eventsub-Message-Signature", signature()),
            ("Twitch-Eventsub-Message-Retry", b"0".to_vec()),
            ("Twitch-Eventsub-Message-Type", b"notification".to_vec()),
        ]
    }

    fn check(pairs: Vec<(&'static str, Vec<u8>)>) -> Result<DeliveryHeaders, HeaderRefusal> {
        let borrowed: Vec<(&str, &[u8])> = pairs.iter().map(|(n, v)| (*n, v.as_slice())).collect();
        read(&headers(&borrowed), LIMITS)
    }

    fn with(name: &'static str, value: &[u8]) -> Vec<(&'static str, Vec<u8>)> {
        let mut pairs: Vec<_> = valid().into_iter().filter(|(n, _)| *n != name).collect();
        pairs.push((name, value.to_vec()));
        pairs
    }

    #[test]
    fn a_delivery_from_twitch_reads() {
        let read = check(valid());
        assert!(matches!(read, Ok(ref h) if h.message_type == "notification" && h.retry == "0"));
        // Names in any case, a content type with parameters.
        let mut pairs: Vec<_> = valid()
            .into_iter()
            .filter(|(n, _)| *n != "Content-Type")
            .collect();
        pairs.push(("CONTENT-TYPE", b"Application/JSON ; charset=utf-8".to_vec()));
        assert!(check(pairs).is_ok());
    }

    #[test]
    fn refusals() {
        let mut repeated = valid();
        repeated.push(("Twitch-Eventsub-Message-Signature", signature()));
        assert_eq!(check(repeated), Err(HeaderRefusal::Repeated));
        let mut non_ascii = signature();
        non_ascii[7] = 0xe9;
        assert_eq!(
            check(with("Twitch-Eventsub-Message-Signature", &non_ascii)),
            Err(HeaderRefusal::NotAscii)
        );
        assert_eq!(
            check(with("Twitch-Eventsub-Message-Signature", b"sha256=abc")),
            Err(HeaderRefusal::NoSignature)
        );
        let long = format!("{}a", String::from_utf8_lossy(&signature()));
        assert_eq!(
            check(with("Twitch-Eventsub-Message-Signature", long.as_bytes())),
            Err(HeaderRefusal::TooLong)
        );
        assert_eq!(
            check(with("Twitch-Eventsub-Message-Id", &[b'x'; 129])),
            Err(HeaderRefusal::TooLong)
        );
        assert_eq!(
            check(with("Twitch-Eventsub-Message-Id", "ñ".as_bytes())),
            Err(HeaderRefusal::NotAscii)
        );
        assert_eq!(
            check(with("Twitch-Eventsub-Message-Timestamp", b"")),
            Err(HeaderRefusal::NoTimestamp)
        );
        assert_eq!(
            check(with("Content-Type", b"text/plain")),
            Err(HeaderRefusal::ContentType)
        );
        assert_eq!(
            check(with("Content-Type", b"application/json-patch+json")),
            Err(HeaderRefusal::ContentType)
        );
        let no_type: Vec<_> = valid()
            .into_iter()
            .filter(|(n, _)| *n != "Content-Type")
            .collect();
        assert_eq!(check(no_type), Err(HeaderRefusal::ContentType));
        let mut gzip = valid();
        gzip.push(("Content-Encoding", b"gzip".to_vec()));
        assert_eq!(check(gzip), Err(HeaderRefusal::ContentEncoding));
        let mut identity = valid();
        identity.push(("Content-Encoding", b"Identity".to_vec()));
        assert!(check(identity).is_ok());
    }

    #[test]
    fn missing_optional_headers_are_empty() {
        let pairs: Vec<_> = valid()
            .into_iter()
            .filter(|(n, _)| {
                !matches!(
                    *n,
                    "Twitch-Eventsub-Message-Id"
                        | "Twitch-Eventsub-Message-Retry"
                        | "Twitch-Eventsub-Message-Type"
                )
            })
            .collect();
        assert_eq!(
            check(pairs).map(|h| (h.message_id, h.retry, h.message_type)),
            Ok((String::new(), String::new(), String::new()))
        );
    }
}

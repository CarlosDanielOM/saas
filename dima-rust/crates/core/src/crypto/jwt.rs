//! HMAC JSON Web Tokens, compatible with the `jsonwebtoken` npm package (9.0.3, with `jws` 4.0.1
//! and `ms` 2.1.3) as the reference uses it, and the DimaFX extension's hand-written verifier.
//!
//! Reference sites (`ledger/runtime.md` section 4.4):
//!
//! - activation email: `jwt.sign({sub, login}, secret, {expiresIn: '1h'})`, verified with
//!   `jwt.verify(token, secret)`, whose default for a secret key is the HMAC family
//!   ([`HMAC_ALGORITHMS`]); the secret is `EMAIL_AUTH_JWT_SECRET` or, when that is unset, the
//!   literal `dev-insecure-do-not-use-in-prod` (the production reality; the caller decides);
//! - asset-library preview ticket: `jwt.sign({owner}, SECRET_KEY, {algorithm: 'HS256', audience:
//!   'asset-preview', subject, expiresIn: '12h' | '15m'})`, verified with `algorithms: ['HS256'],
//!   audience: 'asset-preview'`;
//! - DimaFX Twitch extension token: [`verify_twitch_extension_jwt`] with the candidate keys of
//!   [`twitch_extension_keys`].
//!
//! Signing writes the same bytes as Node: header `{"alg":…,"typ":"JWT"}`, then the payload's own
//! keys in order, then `iat`, `nbf`, `exp`, `aud`, `iss`, `sub`, `jti` as the package appends them,
//! serialised as `JSON.stringify` would. Verification follows `jwt.verify` step by step, including
//! its lenient base64 reading and the order of its checks; [`JwtError`]'s messages are the
//! package's. Only HMAC algorithms exist here: `none` and asymmetric algorithms cannot be named,
//! and a token whose header names an algorithm outside the caller's list is rejected.

use super::digest::{constant_time_eq, hmac_sha256};
use super::encoding::{decode_base64_lenient, encode_base64url, latin1_to_string};
use crate::secret::SecretBytes;
use hmac::{Hmac, Mac};
use serde_json::{Map, Value};
use sha2::{Sha384, Sha512};

/// The HMAC algorithms `jsonwebtoken` supports.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Algorithm {
    /// HMAC-SHA256.
    Hs256,
    /// HMAC-SHA384.
    Hs384,
    /// HMAC-SHA512.
    Hs512,
}

impl Algorithm {
    /// The header name (`HS256`, …).
    pub fn name(self) -> &'static str {
        match self {
            Self::Hs256 => "HS256",
            Self::Hs384 => "HS384",
            Self::Hs512 => "HS512",
        }
    }

    fn sign(self, key: &SecretBytes, input: &[u8]) -> Vec<u8> {
        fn mac<M: Mac + hmac::digest::KeyInit>(key: &[u8], input: &[u8]) -> Vec<u8> {
            match <M as hmac::digest::KeyInit>::new_from_slice(key) {
                Ok(mut mac) => {
                    mac.update(input);
                    mac.finalize().into_bytes().to_vec()
                }
                Err(_) => Vec::new(),
            }
        }
        match self {
            Self::Hs256 => hmac_sha256(key, input).0.to_vec(),
            Self::Hs384 => mac::<Hmac<Sha384>>(key.expose(), input),
            Self::Hs512 => mac::<Hmac<Sha512>>(key.expose(), input),
        }
    }
}

/// `jwt.verify`'s default algorithms for a secret key.
pub const HMAC_ALGORITHMS: &[Algorithm] = &[Algorithm::Hs256, Algorithm::Hs384, Algorithm::Hs512];

/// A duration as `jsonwebtoken` accepts it for `expiresIn`, `notBefore` and `maxAge`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Timespan<'a> {
    /// A whole number of seconds (`expiresIn: 3600`).
    Seconds(i64),
    /// Text read by the `ms` package (`'1h'`, `'15m'`, `'2.5 days'`).
    Text(&'a str),
}

/// What [`sign`] adds to the payload.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SignOptions<'a> {
    /// `algorithm` (default HS256).
    pub algorithm: Algorithm,
    /// `expiresIn`.
    pub expires_in: Option<Timespan<'a>>,
    /// `notBefore`.
    pub not_before: Option<Timespan<'a>>,
    /// `audience` (a single string, as the reference uses it).
    pub audience: Option<&'a str>,
    /// `issuer`.
    pub issuer: Option<&'a str>,
    /// `subject`.
    pub subject: Option<&'a str>,
    /// `jwtid`.
    pub jwtid: Option<&'a str>,
    /// `keyid` (the header's `kid`).
    pub keyid: Option<&'a str>,
    /// `noTimestamp`: leave out `iat`.
    pub no_timestamp: bool,
}

impl Default for SignOptions<'_> {
    fn default() -> Self {
        Self {
            algorithm: Algorithm::Hs256,
            expires_in: None,
            not_before: None,
            audience: None,
            issuer: None,
            subject: None,
            jwtid: None,
            keyid: None,
            no_timestamp: false,
        }
    }
}

/// What [`verify`] checks besides the signature.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VerifyOptions<'a> {
    /// `algorithms`: the header's `alg` must be one of these.
    pub algorithms: &'a [Algorithm],
    /// `audience`: one of these must equal `aud` (or an element of an `aud` array). Empty: no check.
    pub audience: &'a [&'a str],
    /// `issuer`: `iss` must equal one of these. Empty: no check.
    pub issuer: &'a [&'a str],
    /// `subject`: `sub` must equal it.
    pub subject: Option<&'a str>,
    /// `jwtid`: `jti` must equal it.
    pub jwtid: Option<&'a str>,
    /// `nonce`: `nonce` must equal it; it must not be blank.
    pub nonce: Option<&'a str>,
    /// `maxAge`: `iat` plus this must still be in the future.
    pub max_age: Option<Timespan<'a>>,
    /// `clockTolerance` in seconds, applied to `nbf`, `exp` and `maxAge`. A value that is not a
    /// finite number counts as zero: NaN as in the package (`clockTolerance || 0`), and, unlike
    /// the package, an infinite value too, so no tolerance can switch those checks off.
    pub clock_tolerance_secs: f64,
    /// `ignoreExpiration`.
    pub ignore_expiration: bool,
    /// `ignoreNotBefore`.
    pub ignore_not_before: bool,
}

impl<'a> VerifyOptions<'a> {
    /// Options that only pin the algorithms; every other check is off, as in the package.
    pub const fn new(algorithms: &'a [Algorithm]) -> Self {
        Self {
            algorithms,
            audience: &[],
            issuer: &[],
            subject: None,
            jwtid: None,
            nonce: None,
            max_age: None,
            clock_tolerance_secs: 0.0,
            ignore_expiration: false,
            ignore_not_before: false,
        }
    }
}

/// Why a token could not be signed or verified. Messages are `jsonwebtoken`'s.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum JwtError {
    /// Empty token.
    #[error("jwt must be provided")]
    MustBeProvided,
    /// Not three dot-separated parts.
    #[error("jwt malformed")]
    Malformed,
    /// Parts that are not base64url, or a header that is not JSON.
    #[error("invalid token")]
    InvalidToken,
    /// A `typ: "JWT"` token whose payload is not JSON (Node throws a `SyntaxError`).
    #[error("invalid token payload")]
    PayloadSyntax,
    /// A correctly signed token whose payload is JSON `null` (the package throws a `TypeError`
    /// reading `payload.nbf`).
    #[error("Cannot read properties of null (reading 'nbf')")]
    NullPayload,
    /// An unsigned token presented with a key.
    #[error("jwt signature is required")]
    SignatureRequired,
    /// A signed token presented without a key.
    #[error("secret or public key must be provided")]
    SecretRequired,
    /// Signing without a key.
    #[error("secretOrPrivateKey must have a value")]
    MissingSecret,
    /// The header's `alg` is not one of the allowed algorithms.
    #[error("invalid algorithm")]
    InvalidAlgorithm,
    /// The signature does not match.
    #[error("invalid signature")]
    InvalidSignature,
    /// `nbf` is not a number.
    #[error("invalid nbf value")]
    InvalidNbf,
    /// `nbf` is in the future.
    #[error("jwt not active")]
    NotActive {
        /// The token's `nbf` (seconds).
        nbf: f64,
    },
    /// `exp` is not a number.
    #[error("invalid exp value")]
    InvalidExp,
    /// `exp` has passed (`now >= exp`).
    #[error("jwt expired")]
    Expired {
        /// The token's `exp` (seconds).
        exp: f64,
    },
    /// `aud` does not match.
    #[error("jwt audience invalid. expected: {0}")]
    AudienceInvalid(String),
    /// `iss` does not match.
    #[error("jwt issuer invalid. expected: {0}")]
    IssuerInvalid(String),
    /// `sub` does not match.
    #[error("jwt subject invalid. expected: {0}")]
    SubjectInvalid(String),
    /// `jti` does not match.
    #[error("jwt jwtid invalid. expected: {0}")]
    JwtIdInvalid(String),
    /// `nonce` does not match.
    #[error("jwt nonce invalid. expected: {0}")]
    NonceInvalid(String),
    /// The `nonce` option is blank.
    #[error("nonce must be a non-empty string")]
    NonceOption,
    /// `maxAge` given but `iat` is not a number.
    #[error("iat required when maxAge is specified")]
    MaxAgeIatRequired,
    /// `maxAge` text the `ms` package cannot read.
    #[error(
        "\"maxAge\" should be a number of seconds or string representing a timespan eg: \"1d\", \"20h\", 60"
    )]
    MaxAgeInvalid,
    /// `iat + maxAge` has passed.
    #[error("maxAge exceeded")]
    MaxAgeExceeded,
    /// A registered claim in the payload to sign is not a number (`"iat" should be a number of seconds`).
    #[error("\"{0}\" should be a number of seconds")]
    ClaimNotNumber(&'static str),
    /// An option would overwrite a claim already in the payload.
    #[error("{0}")]
    ClaimConflict(&'static str),
    /// `expiresIn` or `notBefore` the `ms` package cannot read.
    #[error(
        "\"{0}\" should be a number of seconds or string representing a timespan eg: \"1d\", \"20h\", 60"
    )]
    InvalidTimespan(&'static str),
    /// `expiresIn` or `notBefore` given as empty text.
    #[error("\"{0}\" should be a number of seconds or string representing a timespan")]
    EmptyTimespan(&'static str),
}

/// The `ms` package's `parse` (version 2.1.3): milliseconds, or `None` for text it does not read.
pub fn ms(text: &str) -> Option<f64> {
    const S: f64 = 1000.0;
    const M: f64 = S * 60.0;
    const H: f64 = M * 60.0;
    const D: f64 = H * 24.0;
    const W: f64 = D * 7.0;
    const Y: f64 = D * 365.25;
    if text.is_empty() || dima_text::utf16_len(text) > 100 {
        return None;
    }
    let bytes = text.as_bytes();
    let mut end = usize::from(bytes.first() == Some(&b'-'));
    let int_start = end;
    while bytes.get(end).is_some_and(u8::is_ascii_digit) {
        end += 1;
    }
    let int_digits = end - int_start;
    if bytes.get(end) == Some(&b'.') {
        let fraction_start = end + 1;
        let mut fraction_end = fraction_start;
        while bytes.get(fraction_end).is_some_and(u8::is_ascii_digit) {
            fraction_end += 1;
        }
        if fraction_end == fraction_start {
            return None;
        }
        end = fraction_end;
    } else if int_digits == 0 {
        return None;
    }
    let number = dima_text::parse_float(text.get(..end)?);
    let unit = text.get(end..)?.trim_start_matches(' ');
    let factor = match unit.to_ascii_lowercase().as_str() {
        "years" | "year" | "yrs" | "yr" | "y" => Y,
        "weeks" | "week" | "w" => W,
        "days" | "day" | "d" => D,
        "hours" | "hour" | "hrs" | "hr" | "h" => H,
        "minutes" | "minute" | "mins" | "min" | "m" => M,
        "seconds" | "second" | "secs" | "sec" | "s" => S,
        "milliseconds" | "millisecond" | "msecs" | "msec" | "ms" | "" => 1.0,
        _ => return None,
    };
    // Non-ASCII units never match: the package's case-insensitive regex is ASCII-only here.
    if !unit.is_ascii() {
        return None;
    }
    Some(number * factor)
}

/// `timespan(time, iat)`: the absolute time in seconds, or `None` for unreadable text.
fn timespan(time: Timespan<'_>, timestamp: f64) -> Option<f64> {
    match time {
        Timespan::Text(text) => ms(text).map(|ms| (timestamp + ms / 1000.0).floor()),
        #[allow(clippy::cast_precision_loss)]
        Timespan::Seconds(seconds) => Some(timestamp + seconds as f64),
    }
}

/// A JavaScript number as a JSON value: integers stay integers, NaN and infinities are `null`.
fn js_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 {
        #[allow(clippy::cast_possible_truncation)]
        return Value::from(n as i64);
    }
    serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// JavaScript `ToNumber` of a JSON value.
fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => dima_text::parse_number(text),
        Value::Array(_) => dima_text::parse_number(&dima_text::string_of(value)),
        Value::Object(_) => f64::NAN,
    }
}

/// `JSON.parse(text)`, with lone surrogate escapes repaired (text rule 3).
fn json_parse(text: &str) -> Option<Value> {
    let bytes = dima_text::sanitize_lone_surrogates(text.as_bytes());
    serde_json::from_slice(&bytes).ok()
}

/// `jwt.sign(payload, key, options)` at `now_ms` (`Date.now()`).
pub fn sign(
    payload: &Map<String, Value>,
    key: &SecretBytes,
    options: &SignOptions<'_>,
    now_ms: i64,
) -> Result<String, JwtError> {
    if key.is_empty() {
        return Err(JwtError::MissingSecret);
    }
    for claim in ["iat", "exp", "nbf"] {
        if payload.get(claim).is_some_and(|value| !value.is_number()) {
            return Err(JwtError::ClaimNotNumber(match claim {
                "iat" => "iat",
                "exp" => "exp",
                _ => "nbf",
            }));
        }
    }
    if payload.contains_key("exp") && options.expires_in.is_some() {
        return Err(JwtError::ClaimConflict(
            "Bad \"options.expiresIn\" option the payload already has an \"exp\" property.",
        ));
    }
    if payload.contains_key("nbf") && options.not_before.is_some() {
        return Err(JwtError::ClaimConflict(
            "Bad \"options.notBefore\" option the payload already has an \"nbf\" property.",
        ));
    }
    if matches!(options.expires_in, Some(Timespan::Text(""))) {
        return Err(JwtError::EmptyTimespan("expiresIn"));
    }
    if matches!(options.not_before, Some(Timespan::Text(""))) {
        return Err(JwtError::EmptyTimespan("notBefore"));
    }

    let mut payload = payload.clone();
    #[allow(clippy::cast_precision_loss)]
    let now_secs = now_ms.div_euclid(1000) as f64;
    let timestamp = payload
        .get("iat")
        .filter(|iat| truthy(iat))
        .and_then(Value::as_f64)
        .unwrap_or(now_secs);
    if options.no_timestamp {
        payload.shift_remove("iat");
    } else {
        payload.insert("iat".to_owned(), js_number(timestamp));
    }
    if let Some(not_before) = options.not_before {
        let nbf = timespan(not_before, timestamp).ok_or(JwtError::InvalidTimespan("notBefore"))?;
        payload.insert("nbf".to_owned(), js_number(nbf));
    }
    if let Some(expires_in) = options.expires_in {
        let exp = timespan(expires_in, timestamp).ok_or(JwtError::InvalidTimespan("expiresIn"))?;
        payload.insert("exp".to_owned(), js_number(exp));
    }
    let claims = [
        (
            options.audience,
            "aud",
            "Bad \"options.audience\" option. The payload already has an \"aud\" property.",
        ),
        (
            options.issuer,
            "iss",
            "Bad \"options.issuer\" option. The payload already has an \"iss\" property.",
        ),
        (
            options.subject,
            "sub",
            "Bad \"options.subject\" option. The payload already has an \"sub\" property.",
        ),
        (
            options.jwtid,
            "jti",
            "Bad \"options.jwtid\" option. The payload already has an \"jti\" property.",
        ),
    ];
    for (value, claim, conflict) in claims {
        if let Some(value) = value {
            if payload.contains_key(claim) {
                return Err(JwtError::ClaimConflict(conflict));
            }
            payload.insert(claim.to_owned(), Value::from(value));
        }
    }

    let mut header = Map::new();
    header.insert("alg".to_owned(), Value::from(options.algorithm.name()));
    header.insert("typ".to_owned(), Value::from("JWT"));
    if let Some(kid) = options.keyid {
        header.insert("kid".to_owned(), Value::from(kid));
    }
    let mut payload = Value::Object(payload);
    dima_text::js_key_order(&mut payload);
    let input = format!(
        "{}.{}",
        encode_base64url(dima_text::to_js_json(&Value::Object(header)).as_bytes()),
        encode_base64url(dima_text::to_js_json(&payload).as_bytes())
    );
    let signature = encode_base64url(&options.algorithm.sign(key, input.as_bytes()));
    Ok(format!("{input}.{signature}"))
}

fn is_base64url_part(part: &str) -> bool {
    part.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// The decoded header and payload, as `jws.decode` plus `jsonwebtoken`'s `decode` produce them.
struct Decoded {
    header: Value,
    payload: Value,
}

fn decode(header: &str, payload: &str, signature: &str) -> Result<Decoded, JwtError> {
    // JWS_REGEX: two non-empty base64url parts and an optional third.
    if header.is_empty()
        || payload.is_empty()
        || !is_base64url_part(header)
        || !is_base64url_part(payload)
        || !is_base64url_part(signature)
    {
        return Err(JwtError::InvalidToken);
    }
    // The header is read as latin1 ('binary'), the payload as UTF-8.
    let header = json_parse(&latin1_to_string(&decode_base64_lenient(header)))
        .filter(truthy)
        .ok_or(JwtError::InvalidToken)?;
    let text = String::from_utf8_lossy(&decode_base64_lenient(payload)).into_owned();
    let mut payload = if header.get("typ").and_then(Value::as_str) == Some("JWT") {
        json_parse(&text).ok_or(JwtError::PayloadSyntax)?
    } else {
        Value::String(text)
    };
    if let Value::String(text) = &payload
        && let Some(parsed) = json_parse(text).filter(|value| value.is_object() || value.is_array())
    {
        payload = parsed;
    }
    Ok(Decoded { header, payload })
}

/// A claim as JavaScript reads `payload.<name>`: absent unless the payload is an object.
fn claim<'v>(payload: &'v Value, name: &str) -> Option<&'v Value> {
    payload.as_object().and_then(|object| object.get(name))
}

/// `jwt.verify(token, key, options)` at `now_ms`: the payload, or the package's error.
pub fn verify(
    token: &str,
    key: &SecretBytes,
    options: &VerifyOptions<'_>,
    now_ms: i64,
) -> Result<Value, JwtError> {
    if options
        .nonce
        .is_some_and(|nonce| dima_text::trim(nonce).is_empty())
    {
        return Err(JwtError::NonceOption);
    }
    #[allow(clippy::cast_precision_loss)]
    let clock = now_ms.div_euclid(1000) as f64;
    if token.is_empty() {
        return Err(JwtError::MustBeProvided);
    }
    let parts: Vec<&str> = token.split('.').collect();
    let [header_part, payload_part, signature_part] = parts.as_slice() else {
        return Err(JwtError::Malformed);
    };
    let decoded = decode(header_part, payload_part, signature_part)?;

    let has_signature = !signature_part.is_empty();
    if !has_signature && !key.is_empty() {
        return Err(JwtError::SignatureRequired);
    }
    if has_signature && key.is_empty() {
        return Err(JwtError::SecretRequired);
    }
    let algorithm = decoded
        .header
        .get("alg")
        .and_then(Value::as_str)
        .and_then(|name| {
            options
                .algorithms
                .iter()
                .find(|allowed| allowed.name() == name)
        })
        .ok_or(JwtError::InvalidAlgorithm)?;
    let input = format!("{header_part}.{payload_part}");
    let expected = encode_base64url(&algorithm.sign(key, input.as_bytes()));
    if !constant_time_eq(signature_part.as_bytes(), expected.as_bytes()) {
        return Err(JwtError::InvalidSignature);
    }

    let payload = decoded.payload;
    // The package reads `payload.nbf` next, which throws for a `null` payload.
    if payload.is_null() {
        return Err(JwtError::NullPayload);
    }
    let tolerance = Some(options.clock_tolerance_secs)
        .filter(|tolerance| tolerance.is_finite())
        .unwrap_or(0.0);
    if !options.ignore_not_before
        && let Some(nbf) = claim(&payload, "nbf")
    {
        let nbf = nbf.as_f64().ok_or(JwtError::InvalidNbf)?;
        if nbf > clock + tolerance {
            return Err(JwtError::NotActive { nbf });
        }
    }
    if !options.ignore_expiration
        && let Some(exp) = claim(&payload, "exp")
    {
        let exp = exp.as_f64().ok_or(JwtError::InvalidExp)?;
        if clock >= exp + tolerance {
            return Err(JwtError::Expired { exp });
        }
    }
    if !options.audience.is_empty() {
        let matches = |value: &Value| {
            value
                .as_str()
                .is_some_and(|aud| options.audience.contains(&aud))
        };
        let ok = match claim(&payload, "aud") {
            Some(Value::Array(items)) => items.iter().any(matches),
            Some(value) => matches(value),
            None => false,
        };
        if !ok {
            return Err(JwtError::AudienceInvalid(options.audience.join(" or ")));
        }
    }
    if !options.issuer.is_empty() {
        let ok = claim(&payload, "iss")
            .and_then(Value::as_str)
            .is_some_and(|iss| options.issuer.contains(&iss));
        if !ok {
            return Err(JwtError::IssuerInvalid(options.issuer.join(",")));
        }
    }
    let exact = |name: &str, expected: Option<&str>| {
        expected
            .filter(|expected| !expected.is_empty())
            .is_some_and(|expected| claim(&payload, name).and_then(Value::as_str) != Some(expected))
    };
    if exact("sub", options.subject) {
        return Err(JwtError::SubjectInvalid(
            options.subject.unwrap_or_default().to_owned(),
        ));
    }
    if exact("jti", options.jwtid) {
        return Err(JwtError::JwtIdInvalid(
            options.jwtid.unwrap_or_default().to_owned(),
        ));
    }
    if exact("nonce", options.nonce) {
        return Err(JwtError::NonceInvalid(
            options.nonce.unwrap_or_default().to_owned(),
        ));
    }
    if let Some(max_age) = options
        .max_age
        .filter(|max_age| *max_age != Timespan::Text("") && *max_age != Timespan::Seconds(0))
    {
        let iat = claim(&payload, "iat")
            .and_then(Value::as_f64)
            .ok_or(JwtError::MaxAgeIatRequired)?;
        // timespan() replaces a zero `iat` with the current time, as the package does.
        let base = if iat == 0.0 { clock } else { iat };
        let limit = timespan(max_age, base).ok_or(JwtError::MaxAgeInvalid)?;
        if clock >= limit + tolerance {
            return Err(JwtError::MaxAgeExceeded);
        }
    }
    Ok(payload)
}

/// The DimaFX server's candidate keys for `TWITCH_EXTENSION_SECRET`: the secret decoded as base64,
/// as base64url, and its raw UTF-8 bytes, without empty or repeated keys. Node's base64 and
/// base64url decoders are the same, so at most two keys result. An empty secret gives none.
pub fn twitch_extension_keys(secret: &str) -> Vec<SecretBytes> {
    if secret.is_empty() {
        return Vec::new();
    }
    let candidates = [
        decode_base64_lenient(secret),
        decode_base64_lenient(secret),
        secret.as_bytes().to_vec(),
    ];
    let mut keys: Vec<SecretBytes> = Vec::new();
    for candidate in candidates {
        let candidate = SecretBytes::new(candidate);
        if !candidate.is_empty() && !keys.contains(&candidate) {
            keys.push(candidate);
        }
    }
    keys
}

/// `verifyTwitchJwt(token, secrets)` in `dimafx/server/src/middleware/twitch-extension-auth.ts`:
/// the payload when the token is HS256-signed by one of `keys`, has a truthy JSON payload, and its
/// `exp`, if truthy, is not in the past (`exp * 1000 < now` rejects; `exp` is checked only when
/// present). Every failure, including the cases where the reference throws, is `None`, which the
/// reference's middleware also turns into 401. The caller then requires a truthy `channel_id`.
pub fn verify_twitch_extension_jwt(
    token: &str,
    keys: &[SecretBytes],
    now_ms: i64,
) -> Option<Value> {
    let parts: Vec<&str> = token.split('.').collect();
    let [header, payload, signature] = parts.as_slice() else {
        return None;
    };
    if header.is_empty() || payload.is_empty() || signature.is_empty() {
        return None;
    }
    let header = json_parse(&String::from_utf8_lossy(&decode_base64_lenient(header)))?;
    if header.get("alg").and_then(Value::as_str) != Some("HS256") {
        return None;
    }
    let actual = decode_base64_lenient(signature);
    let input = format!("{}.{}", parts.first()?, parts.get(1)?);
    let signed = keys
        .iter()
        .any(|key| constant_time_eq(&hmac_sha256(key, input.as_bytes()).0, &actual));
    if !signed {
        return None;
    }
    let payload =
        json_parse(&String::from_utf8_lossy(&decode_base64_lenient(payload))).filter(truthy)?;
    if let Some(exp) = claim(&payload, "exp").filter(|exp| truthy(exp)) {
        #[allow(clippy::cast_precision_loss)]
        if to_number(exp) * 1000.0 < now_ms as f64 {
            return None;
        }
    }
    Some(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn signs_the_same_bytes_as_node() {
        // jwt.sign({ sub: "user-1", login: "streamer", iat: 1700000000 }, "test-secret", { expiresIn: "1h" })
        let token = sign(
            &object(json!({"sub": "user-1", "login": "streamer", "iat": 1_700_000_000})),
            &SecretBytes::from_text("test-secret"),
            &SignOptions {
                expires_in: Some(Timespan::Text("1h")),
                ..SignOptions::default()
            },
            0,
        )
        .unwrap();
        assert_eq!(
            token,
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEiLCJsb2dpbiI6InN0cmVhbWVyIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwMDM2MDB9.fUOxbcCN8QeShAs38_PyXgJpcRgIOS6m8RkFhmI0jJY"
        );
    }

    #[test]
    fn ms_reads_what_the_package_reads() {
        assert_eq!(ms("1h"), Some(3_600_000.0));
        assert_eq!(ms("15m"), Some(900_000.0));
        assert_eq!(ms("2.5 HRS"), Some(9_000_000.0));
        assert_eq!(ms("-.5d"), Some(-43_200_000.0));
        assert_eq!(ms("100"), Some(100.0));
        assert_eq!(ms("1y"), Some(31_557_600_000.0));
        assert_eq!(ms("1."), None);
        assert_eq!(ms("h"), None);
        assert_eq!(ms("1 hour "), None);
        assert_eq!(ms(""), None);
    }

    #[test]
    fn a_tolerance_that_is_not_a_finite_number_is_zero() {
        let key = SecretBytes::from_text("k");
        let now = 1_700_000_000_000;
        let expired = sign(
            &object(json!({"exp": 1_699_999_990})),
            &key,
            &SignOptions::default(),
            now,
        )
        .unwrap();
        let early = sign(
            &object(json!({"nbf": 1_700_000_010})),
            &key,
            &SignOptions::default(),
            now,
        )
        .unwrap();
        for tolerance in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let options = VerifyOptions {
                clock_tolerance_secs: tolerance,
                ..VerifyOptions::new(HMAC_ALGORITHMS)
            };
            assert_eq!(
                verify(&expired, &key, &options, now),
                Err(JwtError::Expired {
                    exp: 1_699_999_990.0
                }),
                "{tolerance}"
            );
            assert_eq!(
                verify(&early, &key, &options, now),
                Err(JwtError::NotActive {
                    nbf: 1_700_000_010.0
                }),
                "{tolerance}"
            );
        }
        // A finite tolerance still applies, as in the package.
        let options = VerifyOptions {
            clock_tolerance_secs: 20.0,
            ..VerifyOptions::new(HMAC_ALGORITHMS)
        };
        assert!(verify(&expired, &key, &options, now).is_ok());
        assert!(verify(&early, &key, &options, now).is_ok());
    }

    #[test]
    fn a_signed_null_payload_is_rejected() {
        // Signed by Node with key "k"; `jwt.verify` throws reading `payload.nbf` of null, even
        // with ignoreNotBefore and ignoreExpiration.
        let token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.bnVsbA.efAgOWZZ8H6y_ZFOuV31OpDCj6CMDTV6niY0hHU1GjE";
        let key = SecretBytes::from_text("k");
        for ignore in [false, true] {
            let options = VerifyOptions {
                ignore_expiration: ignore,
                ignore_not_before: ignore,
                ..VerifyOptions::new(HMAC_ALGORITHMS)
            };
            assert_eq!(verify(token, &key, &options, 0), Err(JwtError::NullPayload));
        }
        assert_eq!(
            JwtError::NullPayload.to_string(),
            "Cannot read properties of null (reading 'nbf')"
        );
    }

    #[test]
    fn verification_rejects_none_and_other_algorithms() {
        let key = SecretBytes::from_text("k");
        let now = 1_700_000_000_000;
        let token = sign(&Map::new(), &key, &SignOptions::default(), now).unwrap();
        let options = VerifyOptions::new(&[Algorithm::Hs256]);
        assert_eq!(
            verify(&token, &key, &options, now).unwrap(),
            json!({"iat": 1_700_000_000})
        );
        let claims = token.split('.').nth(1).unwrap();
        let none = format!(
            "{}.{claims}.",
            encode_base64url(br#"{"alg":"none","typ":"JWT"}"#)
        );
        assert_eq!(
            verify(&none, &key, &options, now),
            Err(JwtError::SignatureRequired)
        );
        let hs384 = sign(
            &Map::new(),
            &key,
            &SignOptions {
                algorithm: Algorithm::Hs384,
                ..SignOptions::default()
            },
            now,
        )
        .unwrap();
        assert_eq!(
            verify(&hs384, &key, &options, now),
            Err(JwtError::InvalidAlgorithm)
        );
        assert!(verify(&hs384, &key, &VerifyOptions::new(HMAC_ALGORITHMS), now).is_ok());
    }
}

//! Email activation tokens, mirroring
//! `dimabot/src/utils/email/email-activation-token.ts`.
//!
//! Tokens are HS256 JWTs with `{ sub, login, iat, exp }` in that order and a
//! one-hour lifetime, so a token signed here with the same `iat` is
//! byte-identical to one from `jsonwebtoken` in Node. Verification matches
//! Node's `jwt.verify(token, secret)` defaults: any HMAC algorithm, no clock
//! tolerance, expired from the `exp` second onward, `nbf` honored, and `aud`
//! ignored. One stricter rule: `exp` is required (every TypeScript token has
//! it). `iat` is not required or validated during verification, matching Node
//! when no maxAge option is supplied. Fractional NumericDate values are honored.
//!
//! Unlike TypeScript, there is no built-in fallback secret. TypeScript signs
//! with a hard-coded development secret when `EMAIL_AUTH_JWT_SECRET` is unset;
//! [`email_auth_secret`] returns an error instead.

use std::{
    env, fmt,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Validation, crypto, decode};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `{"alg":"HS256","typ":"JWT"}` in Node's key order. jsonwebtoken's own
/// `Header` serializes `typ` first, which is valid but not byte-identical.
const NODE_HS256_HEADER: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";

/// Lifetime of an activation token (`expiresIn: "1h"`).
pub const ACTIVATION_TOKEN_TTL_SECS: u64 = 3_600;

/// Claims carried by an activation token, in the TypeScript key order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivationClaims {
    /// Mongo user `_id`.
    pub sub: String,
    /// Twitch login, used as OAuth state.
    pub login: String,
    pub iat: u64,
    pub exp: u64,
}

// Verification requires the accepted expiration claim, but does not inherit
// the signing-only iat requirement. Flatten keeps absent nbf distinct from an
// explicit null (Node rejects null, strings and other nonnumeric nbf values).
#[derive(Deserialize)]
struct VerificationClaims {
    sub: String,
    login: String,
    exp: Value,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// Explicitly initialized activation-token service. Configuration is read once
/// and retained, equivalent to the source module's environment snapshot, with
/// the accepted removal of its insecure development-secret fallback.
#[derive(Clone)]
pub struct ActivationTokenService {
    secret: Vec<u8>,
}
impl fmt::Debug for ActivationTokenService {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ActivationTokenService(<redacted>)")
    }
}
impl ActivationTokenService {
    pub fn from_env() -> Result<Self, MissingSecretError> {
        Ok(Self {
            secret: email_auth_secret()?.into_bytes(),
        })
    }
    pub fn new(secret: &[u8]) -> Result<Self, MissingSecretError> {
        if secret.is_empty() {
            return Err(MissingSecretError);
        }
        Ok(Self {
            secret: secret.to_vec(),
        })
    }
    pub fn sign(&self, user_id: &str, login: &str) -> jsonwebtoken::errors::Result<String> {
        sign_activation_token(&self.secret, user_id, login)
    }
    pub fn verify(&self, token: &str) -> Option<VerifiedActivation> {
        verify_activation_token(&self.secret, token)
    }
}

/// A successfully verified token, matching the TypeScript return value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedActivation {
    pub user_id: String,
    pub login: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingSecretError;

impl fmt::Display for MissingSecretError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(
            "EMAIL_AUTH_JWT_SECRET is not set; refusing to sign or verify activation tokens",
        )
    }
}

impl std::error::Error for MissingSecretError {}

/// Reads `EMAIL_AUTH_JWT_SECRET`; missing/empty values are an error.
/// Whitespace is a valid secret, matching the source truthiness check.
pub fn email_auth_secret() -> Result<String, MissingSecretError> {
    env::var("EMAIL_AUTH_JWT_SECRET")
        .ok()
        .filter(|secret| !secret.is_empty())
        .ok_or(MissingSecretError)
}

/// Signs an activation token issued now.
pub fn sign_activation_token(
    secret: &[u8],
    user_id: &str,
    login: &str,
) -> jsonwebtoken::errors::Result<String> {
    sign_activation_token_at(secret, user_id, login, unix_now())
}

/// Signs an activation token with an explicit issue time (seconds).
pub fn sign_activation_token_at(
    secret: &[u8],
    user_id: &str,
    login: &str,
    issued_at: u64,
) -> jsonwebtoken::errors::Result<String> {
    let claims = ActivationClaims {
        sub: user_id.to_owned(),
        login: login.to_owned(),
        iat: issued_at,
        exp: issued_at + ACTIVATION_TOKEN_TTL_SECS,
    };
    let claims = serde_json::to_vec(&claims).map_err(jsonwebtoken::errors::Error::from)?;
    let message = format!("{NODE_HS256_HEADER}.{}", URL_SAFE_NO_PAD.encode(claims));
    let signature = crypto::sign(
        message.as_bytes(),
        &EncodingKey::from_secret(secret),
        Algorithm::HS256,
    )?;
    Ok(format!("{message}.{signature}"))
}

/// Verifies a token; returns `None` on any failure, like TypeScript.
pub fn verify_activation_token(secret: &[u8], token: &str) -> Option<VerifiedActivation> {
    verify_activation_token_at(secret, token, unix_now())
}

/// Deterministic verification clock, in seconds, for isolated parity checks.
/// `exp` is required by the accepted native contract; `iat` remains optional.
pub fn verify_activation_token_at(
    secret: &[u8],
    token: &str,
    now: u64,
) -> Option<VerifiedActivation> {
    if token.is_empty() {
        return None;
    }
    let claims =
        decode::<VerificationClaims>(token, &DecodingKey::from_secret(secret), &validation())
            .ok()?
            .claims;
    let expires = claims.exp.as_f64()?;
    if !expires.is_finite() || now as f64 >= expires {
        return None;
    }
    if let Some(not_before) = claims.extra.get("nbf") {
        let not_before = not_before.as_f64()?;
        if !not_before.is_finite() || not_before > now as f64 {
            return None;
        }
    }
    Some(VerifiedActivation {
        user_id: claims.sub,
        login: claims.login,
    })
}

fn validation() -> Validation {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.algorithms = vec![Algorithm::HS256, Algorithm::HS384, Algorithm::HS512];
    validation.leeway = 0;
    // The library accepts integer seconds while Node accepts fractional
    // NumericDate. Signature/algorithm validation stays native; exact exp/nbf
    // type and clock checks are performed once above, with Node boundaries.
    validation.required_spec_claims.clear();
    validation.validate_exp = false;
    validation.validate_nbf = false;
    validation.validate_aud = false;
    validation
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"test-secret";

    #[test]
    fn signs_the_same_bytes_as_node_jsonwebtoken() {
        // jwt.sign({ sub: "user-1", login: "streamer", iat: 1700000000 },
        //          "test-secret", { expiresIn: "1h" }) in dimabot's node_modules.
        let expected = concat!(
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.",
            "eyJzdWIiOiJ1c2VyLTEiLCJsb2dpbiI6InN0cmVhbWVyIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwMDM2MDB9.",
            "fUOxbcCN8QeShAs38_PyXgJpcRgIOS6m8RkFhmI0jJY"
        );
        let token = sign_activation_token_at(SECRET, "user-1", "streamer", 1_700_000_000).unwrap();
        assert_eq!(token, expected);
    }

    #[test]
    fn verifies_a_node_signed_hs384_token() {
        // jwt.sign({ sub: "user-2", login: "other", iat: 4102444800 },
        //          "test-secret", { expiresIn: "1h", algorithm: "HS384" })
        let token = concat!(
            "eyJhbGciOiJIUzM4NCIsInR5cCI6IkpXVCJ9.",
            "eyJzdWIiOiJ1c2VyLTIiLCJsb2dpbiI6Im90aGVyIiwiaWF0Ijo0MTAyNDQ0ODAwLCJleHAiOjQxMDI0NDg0MDB9.",
            "DlOKqTSdnn_CyKSdar7Dzh-O7f3a9ilsjX6WykI94ygppmqlNEXmhwqe7rEK9fz6"
        );
        assert_eq!(
            verify_activation_token(SECRET, token),
            Some(VerifiedActivation {
                user_id: "user-2".to_owned(),
                login: "other".to_owned()
            })
        );
    }

    #[test]
    fn round_trips_a_fresh_token() {
        let token = sign_activation_token(SECRET, "user-1", "streamer").unwrap();
        assert_eq!(
            verify_activation_token(SECRET, &token),
            Some(VerifiedActivation {
                user_id: "user-1".to_owned(),
                login: "streamer".to_owned()
            })
        );
    }

    #[test]
    fn rejects_wrong_secret_tampering_and_empty_tokens() {
        let token = sign_activation_token(SECRET, "user-1", "streamer").unwrap();
        assert_eq!(verify_activation_token(b"other", &token), None);
        let mut tampered = token.clone();
        tampered.replace_range(tampered.len() - 2.., "xx");
        assert_eq!(verify_activation_token(SECRET, &tampered), None);
        assert_eq!(verify_activation_token(SECRET, ""), None);
        assert_eq!(verify_activation_token(SECRET, "not-a-jwt"), None);
    }

    #[test]
    fn expires_at_the_exp_second_without_leeway() {
        let now = unix_now();
        let just_expired =
            sign_activation_token_at(SECRET, "u", "l", now - ACTIVATION_TOKEN_TTL_SECS).unwrap();
        assert_eq!(verify_activation_token(SECRET, &just_expired), None);
        let still_valid =
            sign_activation_token_at(SECRET, "u", "l", now + 5 - ACTIVATION_TOKEN_TTL_SECS)
                .unwrap();
        assert!(verify_activation_token(SECRET, &still_valid).is_some());
    }

    #[test]
    fn rejects_unsigned_and_non_hmac_tokens() {
        // {"alg":"none","typ":"JWT"} with valid-looking claims and no signature.
        let header = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0";
        let token = sign_activation_token(SECRET, "u", "l").unwrap();
        let claims = token.split('.').nth(1).unwrap();
        assert_eq!(
            verify_activation_token(SECRET, &format!("{header}.{claims}.")),
            None
        );
    }
}

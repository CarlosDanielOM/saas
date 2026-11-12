//! Permits: a moderator lets one viewer, or everyone, through moderation for a while
//! (reference `utils/moderation/permit.ts`; the `$(permit)` function of the command language
//! parses and grants, the moderation handler checks).
//!
//! # State
//!
//! - `moderation:{channel}:permit:user:{login, lowercased}` and
//!   `moderation:{channel}:permit:channel` (string: the expiry as epoch milliseconds; nothing
//!   reads the value). The lifetime is the permit: 1 to 600 s. A grant overwrites (`SET EX`),
//!   which is atomic, so two moderators granting at once leave one permit with the later
//!   lifetime. A check is one `EXISTS` of both keys.
//!
//! Bounds: one key per permitted login per channel plus one for the channel, at most 600 s each;
//! values are a number. Only moderators can grant.
//!
//! Cutover: rebuilt, so a permit granted in the last 600 s before the cutover is gone: that
//! viewer is moderated again (stricter for at most ten minutes, only for permitted viewers).

use super::store::{RulesStore, StoreError};
use dima_store::dragonfly::{SetOptions, SetOutcome};

/// `PERMIT_MIN_SECONDS`.
pub const PERMIT_MIN_SECONDS: u32 = 1;
/// `PERMIT_MAX_SECONDS`.
pub const PERMIT_MAX_SECONDS: u32 = 600;
/// `PERMIT_DEFAULT_SECONDS`.
pub const PERMIT_DEFAULT_SECONDS: u32 = 60;

/// `PERMIT_USAGE`.
pub const PERMIT_USAGE: &str = "Usage: $(permit [user] [seconds]). No arguments permits everyone for 60s; a number permits everyone for that many seconds (1-600); a username permits only that user.";

const DURATION_ERROR: &str = "Duration must be between 1 and 600 seconds.";
const DURATION_NUMBER_ERROR: &str = "Duration must be a number between 1 and 600 seconds.";

/// `PermitTarget`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermitTarget {
    /// The login, or `None` for everyone in the channel.
    pub login: Option<String>,
    /// How long.
    pub seconds: u32,
}

/// `parseSeconds`: `None` when not all ASCII digits, `Some(None)` when out of range.
fn parse_seconds(raw: &str) -> Option<Option<u32>> {
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let digits = raw.trim_start_matches('0');
    let value = if digits.len() > 6 {
        None
    } else {
        digits.parse::<u32>().ok().or(Some(0))
    };
    Some(value.filter(|value| (PERMIT_MIN_SECONDS..=PERMIT_MAX_SECONDS).contains(value)))
}

/// `normalizePermitLogin`: trimmed, leading `@`s removed, lowercase.
pub fn normalize_permit_login(raw: &str) -> String {
    dima_text::to_lower(dima_text::trim(raw).trim_start_matches('@'))
}

/// `/^[a-z0-9_]{1,25}$/i`.
fn valid_login(login: &str) -> bool {
    (1..=25).contains(&login.len())
        && login
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// `parsePermitArgs`: none → everyone 60 s; a number → everyone that long; a login → that
/// viewer 60 s; a login and a number → that viewer that long. The error is the text the
/// function replies with.
pub fn parse_permit_args<S: AsRef<str>>(raw_args: &[S]) -> Result<PermitTarget, &'static str> {
    let args: Vec<&str> = raw_args
        .iter()
        .map(|arg| dima_text::trim(arg.as_ref()))
        .filter(|arg| !arg.is_empty())
        .collect();
    let (first, second) = match args.as_slice() {
        [] => {
            return Ok(PermitTarget {
                login: None,
                seconds: PERMIT_DEFAULT_SECONDS,
            });
        }
        [first] => (*first, None),
        [first, second] => (*first, Some(*second)),
        _ => return Err(PERMIT_USAGE),
    };
    let first_seconds = parse_seconds(first);
    let Some(second) = second else {
        return match first_seconds {
            Some(Some(seconds)) => Ok(PermitTarget {
                login: None,
                seconds,
            }),
            Some(None) => Err(DURATION_ERROR),
            None => {
                let login = normalize_permit_login(first);
                if valid_login(&login) {
                    Ok(PermitTarget {
                        login: Some(login),
                        seconds: PERMIT_DEFAULT_SECONDS,
                    })
                } else {
                    Err(PERMIT_USAGE)
                }
            }
        };
    };
    let login = normalize_permit_login(first);
    if first_seconds.is_some() || !valid_login(&login) {
        return Err(PERMIT_USAGE);
    }
    match parse_seconds(second) {
        Some(Some(seconds)) => Ok(PermitTarget {
            login: Some(login),
            seconds,
        }),
        _ => Err(DURATION_NUMBER_ERROR),
    }
}

/// `permitUserKey`.
pub fn permit_user_key(channel_id: &str, login: &str) -> String {
    format!(
        "moderation:{channel_id}:permit:user:{}",
        dima_text::to_lower(login)
    )
}

/// `permitChannelKey`.
pub fn permit_channel_key(channel_id: &str) -> String {
    format!("moderation:{channel_id}:permit:channel")
}

impl RulesStore {
    /// `grantPermit`: for `login`, or the whole channel without one (an empty login is the
    /// channel, as the reference's truthiness test makes it).
    pub async fn grant_permit(
        &self,
        channel_id: &str,
        seconds: u32,
        login: Option<&str>,
    ) -> Result<(), StoreError> {
        let key = match login.filter(|login| !login.is_empty()) {
            Some(login) => permit_user_key(channel_id, login),
            None => permit_channel_key(channel_id),
        };
        let expires = self.clock.now_ms() + i64::from(seconds) * 1000;
        let outcome = self
            .dragonfly
            .set(
                &self.key(&key),
                expires.to_string().as_bytes(),
                SetOptions::ex(u64::from(seconds)),
            )
            .await?;
        match outcome {
            SetOutcome::Written | SetOutcome::Previous(_) => Ok(()),
            _ => Err(StoreError::Reply("grantPermit")),
        }
    }

    /// `hasActivePermit`: the viewer's own permit or the channel's.
    pub async fn has_active_permit(
        &self,
        channel_id: &str,
        login: &str,
    ) -> Result<bool, StoreError> {
        let user = self.key(&permit_user_key(channel_id, login));
        let channel = self.key(&permit_channel_key(channel_id));
        Ok(self.dragonfly.exists(&[&user, &channel]).await? > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<PermitTarget, &'static str> {
        parse_permit_args(args)
    }

    fn target(login: Option<&str>, seconds: u32) -> Result<PermitTarget, &'static str> {
        Ok(PermitTarget {
            login: login.map(str::to_owned),
            seconds,
        })
    }

    #[test]
    fn parses_like_the_reference() {
        assert_eq!(parse(&[]), target(None, 60));
        assert_eq!(parse(&["", "  "]), target(None, 60));
        assert_eq!(parse(&["120"]), target(None, 120));
        assert_eq!(parse(&["0120"]), target(None, 120));
        assert_eq!(parse(&["0"]), Err(DURATION_ERROR));
        assert_eq!(parse(&["601"]), Err(DURATION_ERROR));
        assert_eq!(parse(&["99999999999999999999999"]), Err(DURATION_ERROR));
        assert_eq!(parse(&["@@Viewer_1"]), target(Some("viewer_1"), 60));
        assert_eq!(parse(&["viewer", "30"]), target(Some("viewer"), 30));
        assert_eq!(parse(&["viewer", "x"]), Err(DURATION_NUMBER_ERROR));
        assert_eq!(parse(&["30", "viewer"]), Err(PERMIT_USAGE));
        assert_eq!(parse(&["a", "b", "c"]), Err(PERMIT_USAGE));
        assert_eq!(parse(&["bad-name"]), Err(PERMIT_USAGE));
        assert_eq!(parse(&["${}".repeat(9).as_str()]), Err(PERMIT_USAGE));
        assert_eq!(parse(&["a".repeat(26).as_str()]), Err(PERMIT_USAGE));
        // The Kelvin sign lowercases to an ASCII `k`, as in JavaScript.
        assert_eq!(parse(&["\u{212a}ay"]), target(Some("kay"), 60));
        assert_eq!(parse(&["٣٠"]), Err(PERMIT_USAGE));
        assert_eq!(parse(&["ñandú"]), Err(PERMIT_USAGE));
    }

    #[test]
    fn keys() {
        assert_eq!(
            permit_user_key("1", "ViEwEr"),
            "moderation:1:permit:user:viewer"
        );
        assert_eq!(permit_channel_key("1"), "moderation:1:permit:channel");
    }
}

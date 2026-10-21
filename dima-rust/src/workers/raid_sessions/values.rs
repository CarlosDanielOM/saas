use super::{HOUR_MS, Result};
use garde::Validate;
use mongodb::bson::{Bson, DateTime, Document, doc, oid::ObjectId};
use serde::Deserialize;
use sha2::{Digest, Sha256};

pub(super) fn date(ms: i64) -> DateTime {
    DateTime::from_millis(ms)
}

/// Exactly JSON.stringify(stringParts), including literal Unicode and escaping.
pub(super) fn identity(parts: &[&str]) -> String {
    let bytes = serde_json::to_vec(parts).expect("String arrays always serialize");
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Debug, Deserialize, Validate)]
#[serde(rename_all = "camelCase")]
pub(super) struct Session {
    #[serde(rename = "_id")]
    #[garde(length(min = 1))]
    pub id: String,
    #[serde(rename = "channelID")]
    #[garde(length(min = 1))]
    pub channel: String,
    #[garde(skip)]
    pub started_at: DateTime,
    #[garde(skip)]
    pub capture_until: DateTime,
    #[garde(skip)]
    pub expires_at: DateTime,
    #[garde(skip)]
    pub backfill_until: DateTime,
    #[serde(default)]
    #[garde(skip)]
    pub ended_at: Option<DateTime>,
    #[serde(default)]
    #[garde(skip)]
    pub backfill_cursor: String,
}

#[derive(Debug, Deserialize, Validate)]
#[serde(rename_all = "camelCase")]
pub(super) struct Follower {
    #[serde(rename = "_id")]
    #[garde(length(min = 1))]
    pub id: String,
    #[serde(rename = "channelID")]
    #[garde(length(min = 1))]
    pub channel: String,
    #[serde(rename = "sessionID")]
    #[garde(length(min = 1))]
    pub session: String,
    #[serde(rename = "eventID")]
    #[garde(length(min = 1))]
    pub event: String,
    #[serde(rename = "userID")]
    #[garde(length(min = 1))]
    pub user: String,
    #[garde(skip)]
    pub followed_at: DateTime,
}

#[derive(Debug, Deserialize, Validate)]
#[serde(rename_all = "camelCase")]
pub(super) struct Request {
    #[serde(rename = "_id")]
    #[garde(length(min = 1))]
    pub id: String,
    #[serde(rename = "channelID")]
    #[garde(length(min = 1))]
    pub channel: String,
    #[serde(rename = "sessionID")]
    #[garde(length(min = 1))]
    pub session: String,
    #[serde(rename = "userID", default)]
    #[garde(skip)]
    pub user: String,
    #[serde(default)]
    #[garde(skip)]
    pub include_future: bool,
    #[garde(skip)]
    pub requested_at: DateTime,
    #[garde(skip)]
    pub expires_at: DateTime,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Settings {
    pub enabled: Option<bool>,
    pub attack_mode_enabled: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Control {
    pub cancelled_through: DateTime,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Event {
    #[serde(rename = "_id")]
    pub id: ObjectId,
    pub event_key: String,
    pub occurred_at: DateTime,
    pub payload: Bson,
}

pub(super) struct Follow {
    pub channel: String,
    pub event: String,
    pub user: String,
    pub login: String,
    pub name: String,
    pub at: DateTime,
}

impl Event {
    pub fn follow(&self, channel: &str) -> Result<Option<Follow>> {
        // Journal payloads are JSON envelopes. The TS reference specifically
        // reads payload.event.user_id; a missing/falsy user skips the row.
        let raw = match &self.payload {
            Bson::Document(payload) => payload.get_document("event").ok(),
            _ => None,
        };
        let Some(raw) = raw else {
            return Ok(None);
        };
        let Some(user) = raw.get("user_id").filter(|value| truthy(value)) else {
            return Ok(None);
        };
        if self.event_key.is_empty() || channel.is_empty() {
            return Err("Invalid raid follow event");
        }
        Ok(Some(Follow {
            channel: channel.into(),
            event: self.event_key.clone(),
            user: js_string(user),
            login: raw
                .get("user_login")
                .filter(|value| truthy(value))
                .map_or_else(String::new, js_string),
            name: raw
                .get("user_name")
                .filter(|value| truthy(value))
                .map_or_else(String::new, js_string),
            at: self.occurred_at,
        }))
    }
}

fn truthy(value: &Bson) -> bool {
    match value {
        Bson::Null | Bson::Undefined => false,
        Bson::Boolean(value) => *value,
        Bson::String(value) => !value.is_empty(),
        Bson::Int32(value) => *value != 0,
        Bson::Int64(value) => *value != 0,
        Bson::Double(value) => *value != 0.0 && !value.is_nan(),
        _ => true,
    }
}

// Match String(JSON values), rather than JSON-encoding string identities. Arrays
// use JavaScript's comma join, and objects have its ordinary object tag.
fn js_string(value: &Bson) -> String {
    match value {
        Bson::String(value) => value.clone(),
        Bson::Null => "null".into(),
        Bson::Undefined => "undefined".into(),
        Bson::Boolean(value) => value.to_string(),
        Bson::Int32(value) => value.to_string(),
        Bson::Int64(value) => js_number(*value as f64),
        Bson::Double(value) => js_number(*value),
        Bson::Array(value) => value
            .iter()
            .map(|item| match item {
                Bson::Null | Bson::Undefined => String::new(),
                _ => js_string(item),
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => "[object Object]".into(),
    }
}

fn js_number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value == f64::INFINITY {
        return "Infinity".into();
    }
    if value == f64::NEG_INFINITY {
        return "-Infinity".into();
    }
    if value == 0.0 {
        return "0".into();
    }
    let raw = value.to_string();
    if (1e-6..1e21).contains(&value.abs()) {
        return raw;
    }
    // Rust's shortest float display uses ordinary decimal notation; JS uses an
    // exponent at these boundaries. Normalize the same shortest decimal digits.
    let (sign, absolute) = if let Some(v) = raw.strip_prefix('-') {
        ("-", v)
    } else {
        ("", raw.as_str())
    };
    let dot = absolute.find('.').unwrap_or(absolute.len());
    let digits = absolute.replace('.', "");
    let first = digits.find(|c: char| c != '0').unwrap_or(0);
    let significant = digits[first..].trim_end_matches('0');
    let exponent = dot as i64 - first as i64 - 1;
    let fraction = if significant.len() > 1 {
        format!(".{}", &significant[1..])
    } else {
        String::new()
    };
    format!(
        "{sign}{}{fraction}e{}{exponent}",
        &significant[..1],
        if exponent >= 0 { "+" } else { "" }
    )
}

/// Tolerant JSON decoding mirrors the shared cache helper: invalid JSON is
/// absent state. Ordinary Redis errors remain fatal to the tick.
pub(super) struct State {
    value: serde_json::Value,
}
pub(super) fn parse_state(raw: Option<&str>) -> Option<State> {
    raw.and_then(|raw| serde_json::from_str(raw).ok())
        .map(|value| State { value })
}
impl State {
    fn active(&self, request: &str, now: i64) -> bool {
        self.value.get("mode").and_then(|value| value.as_str()) == Some("attack")
            && self
                .value
                .get("raidRequestID")
                .and_then(|value| value.as_str())
                == Some(request)
            && json_number(self.value.get("expiresAt")).is_some_and(|expiry| expiry > now as f64)
    }
    pub fn activated(&self, request: &str, now: i64) -> bool {
        self.active(request, now)
    }
    pub fn eligible_request(&self, session: &str, now: i64) -> Option<String> {
        let request = self.value.get("raidRequestID")?.as_str()?;
        (!request.is_empty()
            && self.value.get("raidSessionID")?.as_str()? == session
            && self.active(request, now))
        .then(|| request.to_owned())
    }
}
fn json_number(value: Option<&serde_json::Value>) -> Option<f64> {
    match value? {
        serde_json::Value::Number(value) => value.as_f64(),
        serde_json::Value::String(value) => {
            let value = value.trim();
            if value.is_empty() {
                Some(0.0)
            } else {
                value.parse().ok()
            }
        }
        serde_json::Value::Bool(value) => Some(if *value { 1.0 } else { 0.0 }),
        serde_json::Value::Null => Some(0.0),
        _ => None,
    }
}

pub(super) fn follower_document(
    id: &str,
    session: &Session,
    follow: &Follow,
    now: DateTime,
) -> Document {
    doc! {"_id":id,"channelID":&follow.channel,"sessionID":&session.id,"eventID":&follow.event,
    "userID":&follow.user,"login":&follow.login,"name":&follow.name,"followedAt":follow.at,
    "recordedAt":now,"queuedRequestIDs":[],"eligibleRequestIDs":[],
    "purgeAt":date(session.started_at.timestamp_millis()+73*HOUR_MS)}
}

pub(super) fn control_defaults() -> Document {
    doc! {"cancelledThrough":date(0),"nextAllowedAt":date(0),"lastServedAt":date(0),
    "ratePerSecond":5,"successStreak":0,"lockedUntil":date(0),"leaseToken":""}
}

pub(super) fn action_document(follower: &Follower, request: &Request, now: DateTime) -> Document {
    doc! {"_id":identity(&[&follower.channel,&format!("{}:{}",request.id,follower.user),"ban"]),
    "channelID":&follower.channel,"eventID":&follower.event,"kind":"ban","mode":"attack",
    "authorization":"manual","followerID":&follower.user,"raidSessionID":&follower.session,
    "raidFollowerID":&follower.id,"raidRequestID":&request.id,
    "reason":"DimaBot confirmed raid session moderation","message":"",
    "followedAt":follower.followed_at,"authorizedAt":request.requested_at,
    "status":"pending","nextAttemptAt":now,"lockedUntil":date(0),"leaseToken":"",
    "attempts":0,"failures":0,"lastStatus":0,"lastMessage":"","completedAt":Bson::Null,
    "expiresAt":request.expires_at,"purgeAt":date(now.timestamp_millis()+7*86_400_000),
    "auditPending":false,"createdAt":now}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identities_are_json_arrays_with_literal_unicode_and_escapes() {
        assert_eq!(
            identity(&["a", "b"]),
            "0473ef2dc0d324ab659d3580c1134e9d812035905c4781fdd6d529b0c6860e13"
        );
        assert_ne!(identity(&["a:b", "c"]), identity(&["a", "b:c"]));
        let expected = format!("{:x}", Sha256::digest("[\"ñ\\n\",\"\\\"\\\\\"]".as_bytes()));
        assert_eq!(identity(&["ñ\n", "\"\\"]), expected);
    }
    #[test]
    fn json_payload_users_match_js_truthiness_and_string_coercion() {
        for value in [
            Bson::Null,
            Bson::Boolean(false),
            Bson::Int32(0),
            Bson::Double(f64::NAN),
            Bson::String(String::new()),
        ] {
            assert!(!truthy(&value));
        }
        for (value, expected) in [
            (Bson::Int32(42), "42"),
            (Bson::Boolean(true), "true"),
            (Bson::Document(doc! {}), "[object Object]"),
            (Bson::Array(vec![Bson::Null, Bson::Int32(7)]), ",7"),
            (Bson::String("user".into()), "user"),
        ] {
            assert!(truthy(&value));
            assert_eq!(js_string(&value), expected);
        }
        for (value, expected) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1e21, "1e+21"),
            (1.25e-7, "1.25e-7"),
            (1e-6, "0.000001"),
        ] {
            assert_eq!(js_number(value), expected);
        }
    }
    #[test]
    fn cache_invalid_json_is_absent_and_active_state_is_fenced_to_request_and_time() {
        for raw in [None, Some(""), Some("{bad")] {
            assert!(parse_state(raw).is_none());
        }
        let state = parse_state(Some(
            r#"{"mode":"attack","expiresAt":1001,"raidSessionID":"s","raidRequestID":"r"}"#,
        ))
        .unwrap();
        assert!(state.activated("r", 1000));
        assert!(!state.activated("r", 1001));
        assert!(!state.activated("x", 1000));
        assert_eq!(state.eligible_request("s", 1000).as_deref(), Some("r"));
        assert!(state.eligible_request("other", 1000).is_none());
        assert!(!parse_state(Some("null")).unwrap().activated("r", 0));
    }
    #[test]
    fn emitted_documents_include_mongoose_defaults_and_bson_types() {
        let follower = Follower {
            id: "f".into(),
            channel: "c".into(),
            session: "s".into(),
            event: "e".into(),
            user: "u".into(),
            followed_at: date(10),
        };
        let request = Request {
            id: "r".into(),
            channel: "c".into(),
            session: "s".into(),
            user: String::new(),
            include_future: false,
            requested_at: date(20),
            expires_at: date(1000),
        };
        let action = action_document(&follower, &request, date(30));
        for key in ["attempts", "failures", "lastStatus"] {
            assert_eq!(action.get(key), Some(&Bson::Int32(0)));
        }
        for key in ["createdAt", "nextAttemptAt"] {
            assert_eq!(action.get_datetime(key).unwrap(), &date(30));
        }
        assert_eq!(action.get_datetime("authorizedAt").unwrap(), &date(20));
        assert_eq!(action.get_datetime("expiresAt").unwrap(), &date(1000));
        assert_eq!(action.get("completedAt"), Some(&Bson::Null));
        assert_eq!(action.get_str("message").unwrap(), "");
        assert!(!action.get_bool("auditPending").unwrap());
        assert_eq!(control_defaults().get_i32("ratePerSecond").unwrap(), 5);
        assert!(!control_defaults().contains_key("pendingUntil"));
    }
}

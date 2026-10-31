//! Ports the JSON interfaces in `thread_store.ts` (the TS `thread_types.ts`
//! is empty). Preserves Redis field names; does not read or write Redis.
use serde::{Deserialize, Serialize};
use crate::utils::js_string::JsString;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadRole { User, Assistant }
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadStatus { Active, Archived, Deleted }
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadTurn {
    pub role: ThreadRole,
    #[serde(rename = "userID", skip_serializing_if = "Option::is_none", default)] pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)] pub username: Option<String>,
    pub message: String, pub timestamp: i64,
    #[serde(rename = "sourceMessageId", skip_serializing_if = "Option::is_none", default)] pub source_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)] pub delivered: Option<bool>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMeta {
    #[serde(rename = "threadID")] pub thread_id: String,
    #[serde(rename = "channelID")] pub channel_id: String,
    #[serde(rename = "ownerUserID")] pub owner_user_id: String,
    pub owner_username: String, pub created_at: String, pub updated_at: String,
    pub last_activity_ts: i64, pub status: ThreadStatus,
    #[serde(with = "js_json_string")] pub topic_seed: JsString,
    pub topic_keywords: Vec<String>, pub message_count: i64,
    #[serde(skip_serializing_if = "Option::is_none", default)] pub last_user_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)] pub last_assistant_message: Option<String>,
}

// RawValue preserves JSON string escape sequences, including lone surrogates.
mod js_json_string {
    use crate::utils::js_string::JsString;
    use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error};
    use serde_json::value::RawValue;
    pub fn serialize<S:Serializer>(value:&JsString, serializer:S)->Result<S::Ok,S::Error> {
        let raw=RawValue::from_string(value.to_json_string()).map_err(serde::ser::Error::custom)?;
        raw.serialize(serializer)
    }
    pub fn deserialize<'de,D:Deserializer<'de>>(deserializer:D)->Result<JsString,D::Error> {
        let raw=Box::<RawValue>::deserialize(deserializer)?;
        let text=raw.get();
        if !text.starts_with('"') || !text.ends_with('"') {return Err(D::Error::custom("expected JSON string"));}
        let mut chars=text[1..text.len()-1].chars(); let mut units=Vec::new();
        while let Some(ch)=chars.next() {
            if ch!='\\' {let mut buf=[0u16;2];units.extend_from_slice(ch.encode_utf16(&mut buf));continue;}
            let escape=chars.next().ok_or_else(||D::Error::custom("incomplete escape"))?;
            let unit=match escape {
                '"'=>34, '\\'=>92, '/'=>47, 'b'=>8, 'f'=>12, 'n'=>10, 'r'=>13, 't'=>9,
                'u'=>{let mut n=0u16; for _ in 0..4 {let digit=chars.next().and_then(|c|c.to_digit(16)).ok_or_else(||D::Error::custom("invalid unicode escape"))?;n=(n<<4)|(digit as u16);} n},
                _=>return Err(D::Error::custom("invalid escape")),
            }; units.push(unit);
        }
        Ok(JsString::from_units(units))
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptContextTurn {
    pub role: ThreadRole,
    #[serde(skip_serializing_if = "Option::is_none", default)] pub source_message_id: Option<String>,
    pub timestamp: i64, pub username: String, pub message: String,
    #[serde(skip_serializing_if = "Option::is_none", default)] pub badges: Option<String>,
}
